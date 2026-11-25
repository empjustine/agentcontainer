// h2windowed.go — the h2-post-windowed carrier (docs/d222): the
// h2-post-unbounded carrier's single POST split into size-bounded windows so
// one CONNECT survives an edge that caps a single request body (Cloudflare's
// Maximum Upload Size).
//
// WHY a carrier of its own instead of a cap inside h2-post-unbounded: that
// carrier's identity IS the single request — one POST, full duplex, no
// session state beyond it. Window rotation needs the other half of the
// h1.1-post-windowed carrier (a session keyed by an id and a window
// sequence) while keeping full duplex *inside* a window, so this carrier
// borrows that registry and handoff and adds nothing to the unbounded one.
//
// WHY the edge's posture is discovered, not configured: an edge that caps a
// body cannot refuse at dial time (it only rejects once bytes have moved), so
// the exit refuses the unbounded carrier at request initiation on its capped
// port and the relay learns the posture from that refusal (docs/d222).
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// windowHeader declares one window's body budget. Its presence is also
	// the carrier discriminator: a POST with it is h2-post-windowed, without
	// it is h2-post-unbounded (or h1.1-post-windowed, when Traceparent
	// alone is present).
	windowHeader = "X-Estige-Window-Bytes"
	// h2WindowedBytes is the relay's window on this carrier. It is a fixed
	// fraction of the smallest edge cap the fleet meets (Cloudflare's 100 MB)
	// with generous headroom for headers and counting drift, and large enough
	// that interactive traffic never reaches a boundary.
	h2WindowedBytes = 8 << 20
	// maxWindowBytes is the exit's admission ceiling for a declared window;
	// it bounds one session's queued uplink regardless of what a peer asks
	// for.
	maxWindowBytes = 32 << 20
)

// parseWindowBound validates one window's declared budget. It is a request
// field, not a secret: the bound only says how much this window will carry.
func parseWindowBound(raw string) (int64, error) {
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("window bound must be a positive byte count, got %q", raw)
	}
	if n > maxWindowBytes {
		return 0, fmt.Errorf("window bound %d exceeds the %d-byte ceiling", n, maxWindowBytes)
	}
	return n, nil
}

// drainBound reads one window's frames off the request body. Unlike the
// h1.1-post-windowed carrier's drain it runs concurrently with the response,
// which is the whole point of this carrier: the relay's reads of the target
// are not held behind a full request body.
func (s *exchangeStream) drainBound(readFrame func() ([]byte, error), bound int64) error {
	var window int64
	for {
		msg, err := readFrame()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		window += int64(len(msg))
		if window > bound {
			return fmt.Errorf("%w: window body %d exceeds its declared bound %d", ErrProtocol, window, bound)
		}
		// Backpressure, not a queue cap: a window may legitimately exceed the
		// h1.1 carrier's 128 KiB queue bound, so the channel's blocking send is
		// what stops a fast relay behind a slow target. The declared bound is
		// the only byte cap this carrier needs.
		select {
		case s.inbound <- msg:
		case <-s.closed:
			return io.ErrClosedPipe
		}
	}
}

// writeWindowFrame writes one frame into a window's response body with the
// same write bound every carrier takes.
func writeWindowFrame(w http.ResponseWriter, msg []byte) error {
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(tunnelKeepaliveInterval))
	_, err := w.Write(msg)
	if err == nil {
		err = rc.Flush()
	}
	_ = rc.SetWriteDeadline(time.Time{})
	return err
}

// serveH2Window runs one h2-post-windowed window: open the response
// immediately, then pump both directions until the relay ends the window's
// body. The session outlives the handler in the registry, so the next window
// continues it.
func (t *tunnelServer) serveH2Window(w http.ResponseWriter, r *http.Request, key *operatorKey, result *admissionResult, response http.Header) {
	lw := &loggingResponseWriter{ResponseWriter: w, start: time.Now()}
	traceID, span, err := parseTraceparent(r.Header.Get("Traceparent"))
	if err != nil {
		writeFunnel404(lw, r)
		return
	}
	bound, err := parseWindowBound(r.Header.Get(windowHeader))
	if err != nil {
		writeFunnel404(lw, r)
		return
	}
	s, compromised := t.accept(context.WithoutCancel(r.Context()), traceID, span, key)
	if compromised != nil {
		_ = compromised.Close()
		writeFunnel404(lw, r)
		return
	}
	if s == nil || !s.beginWindow(span) {
		writeFunnel404(lw, r)
		return
	}
	defer s.endWindow()

	// Full duplex is what makes the window's response independent of its
	// request body (the same requirement the unbounded carrier states):
	// without it net/http's h1.1 server drains the still-open body before the
	// headers go out, and this exchange deadlocks against a relay that waits
	// for the 200 before writing the handshake.
	if err := http.NewResponseController(lw).EnableFullDuplex(); err != nil {
		logLine(sevError, "[estige] tunnel h2-post-windowed: full duplex unavailable: %v", err)
		lw.WriteHeader(http.StatusInternalServerError)
		logAccess(r, http.StatusInternalServerError, lw.size, lw.start)
		return
	}
	maps.Copy(lw.Header(), response)
	lw.WriteHeader(http.StatusOK)
	if err := http.NewResponseController(lw).Flush(); err != nil {
		logAccess(r, http.StatusInternalServerError, lw.size, lw.start)
		return
	}

	local := tls.Certificate{Certificate: [][]byte{t.selfDER}, PrivateKey: t.private}
	carrier := &windowCarrier{
		readFrame:  func() ([]byte, error) { return readFrameFromStream(r.Body) },
		writeFrame: func(msg []byte) error { return writeWindowFrame(lw, msg) },
		fail:       func() { _ = s.Close() },
		carrier:    carrierH2Windowed,
		session:    traceID,
	}
	channel, err := windowChannel(context.WithoutCancel(r.Context()), carrier, local, result.Cert, true)
	if err != nil {
		logLine(sevWarn, "[estige] tunnel h2-post-windowed: inner handshake failed: %v", err)
		_ = s.Close()
		logAccess(r, http.StatusOK, lw.size, lw.start)
		return
	}
	carrier.fail = func() {}
	defer func() { _ = channel.Close() }()

	drained := make(chan error, 1)
	go func() { drained <- s.drainBound(channel.readTunnelMsg, bound) }()
	// No r.Body.Close here: net/http's body Close takes the same mutex the
	// blocked drain read holds, and the session-close path (client went away)
	// is the one that ends that read. The handler returning is enough — the
	// response is what the relay is waiting for.

	if err := s.flushH2Window(drained, channel.writeTunnelMsg); err != nil {
		_ = s.Close()
		// A body that ends on a frame boundary closes the session normally;
		// the relay's Close can truncate the very last frame, which is an
		// expected teardown, not a carrier failure. Anything else is real.
		if !errors.Is(err, io.ErrUnexpectedEOF) {
			logLine(sevWarn, "[estige] tunnel h2-post-windowed: %v", err)
		}
	}
	logAccess(r, http.StatusOK, lw.size, lw.start)
}

// flushH2Window writes downlink frames while the window's body is read, then
// ends the response when that body ends so the relay can open the next
// window. Ending the response is the window handoff: holding it open would
// make the relay's next POST inadmissible under the one-window contract.
func (s *exchangeStream) flushH2Window(drained <-chan error, write func([]byte) error) error {
	for {
		select {
		case msg := <-s.outbound:
			if err := write(msg); err != nil {
				return err
			}
		case err := <-drained:
			if err != nil {
				return err
			}
			for {
				select {
				case msg := <-s.outbound:
					if werr := write(msg); werr != nil {
						return werr
					}
				default:
					return nil
				}
			}
		case <-s.closed:
			return nil
		}
	}
}

// ---------------------------------------------------------------------------
// Relay side — the window manager
// ---------------------------------------------------------------------------

// h2WindowedStream is the h2-post-windowed carrier on the relay node: one
// session id, one window at a time, full duplex inside a window. A window's
// body closes when the next frame would cross h2WindowedBytes; the read loop
// then opens the next window as soon as the previous response ends.
type h2WindowedStream struct {
	timerMu sync.Mutex
	url     string
	cfg     *relayConfig
	id      string
	bound   int64

	client *http.Client
	tr     *http.Transport
	// local and peer pin this window's inner session. Every window gets a
	// fresh handshake; no TLS state survives the response body's end.
	local tls.Certificate
	peer  *x509.Certificate
	conn  *tls.Conn // current window's inner session; nil while it rotates
	// ctx is the SESSION lifetime, not a request value: every window derives
	// its request from it and Close cancels it, which is the one way an
	// in-flight window ends when the relay abandons the CONNECT.
	//nolint:containedctx // session lifetime, deliberately outliving a call
	ctx    context.Context
	cancel context.CancelFunc

	mu   sync.Mutex
	cond *sync.Cond
	seq  uint64
	body *io.PipeWriter // nil while no window is open
	resp io.ReadCloser
	sent int64 // bytes already in the current window's body
	err  error

	closed    chan struct{}
	closeOnce sync.Once
	readTimer *time.Timer
	timedOut  atomic.Bool
}

// openH2Windowed starts an h2-post-windowed session and opens its first
// window.
func (c *relayNode) openH2Windowed(ctx context.Context, id string, skipVerify bool) (tunnelStream, error) {
	u := *c.cfg.tunnelURL
	if u.Scheme != schemeWSS {
		return nil, fmt.Errorf("h2-post-windowed needs a wss:// tunnel URL, got %q", u.Scheme)
	}
	u.Scheme = schemeHTTPS
	tr := c.h2Transport(&u, skipVerify)
	sctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	w := &h2WindowedStream{
		url:    u.String(),
		local:  tls.Certificate{Certificate: [][]byte{c.cfg.selfDER}, PrivateKey: c.cfg.store.Private},
		peer:   c.cfg.store.Exits[0].Cert,
		cfg:    &c.cfg,
		id:     id,
		bound:  h2WindowedBytes,
		tr:     tr,
		ctx:    sctx,
		cancel: cancel,
		closed: make(chan struct{}),
	}
	w.cond = sync.NewCond(&w.mu)
	w.client = &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	if err := w.openWindow(); err != nil {
		cancel()
		tr.CloseIdleConnections()
		return nil, err
	}
	return w, nil
}

// openWindow issues the next POST and parks its response for the read loop.
// It runs on the read loop's goroutine (or the constructor for window 1), so
// there is never more than one request being started.
func (w *h2WindowedStream) openWindow() error {
	w.mu.Lock()
	if w.err != nil {
		err := w.err
		w.mu.Unlock()
		return err
	}
	w.seq++
	seq := w.seq
	w.mu.Unlock()

	pr, pw := io.Pipe()
	req, err := http.NewRequestWithContext(w.ctx, http.MethodPost, w.url, pr)
	if err != nil {
		_ = pw.Close()
		return err
	}
	hdr, nonce, err := w.cfg.channelHeaders()
	if err != nil {
		_ = pw.CloseWithError(err)
		return err
	}
	maps.Copy(req.Header, hdr)
	req.Header.Set(sessionIDHeader, w.id)
	req.Header.Set("Traceparent", buildTraceparent(w.id, seq))
	req.Header.Set(windowHeader, strconv.FormatInt(w.bound, 10))
	resp, err := w.client.Do(req) //nolint:bodyclose // the response is published on w.resp and closed by the stream
	if err != nil {
		_ = pw.CloseWithError(err)
		return err
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		_ = pw.Close()
		return fmt.Errorf("h2-post-windowed: status %d", resp.StatusCode)
	}
	if err := w.cfg.verifyExitResponse(resp.Header, nonce); err != nil {
		_ = resp.Body.Close()
		_ = pw.Close()
		return err
	}

	w.mu.Lock()
	if w.err != nil {
		err := w.err
		w.mu.Unlock()
		_ = resp.Body.Close()
		_ = pw.Close()
		return err
	}
	w.body = pw
	w.resp = resp.Body
	w.sent = 0
	w.cond.Broadcast()
	w.mu.Unlock()

	// The handshake runs on the window itself: its ClientHello and the
	// exit's ServerHello are framed bytes in this one exchange. A peer that
	// cannot complete it takes the session down here, before any frame.
	carrier := &windowCarrier{
		readFrame: func() ([]byte, error) { return readFrameFromStream(resp.Body) },
		writeFrame: func(msg []byte) error {
			w.mu.Lock()
			w.sent += int64(len(msg))
			w.mu.Unlock()
			_, err := pw.Write(msg)
			return err
		},
		fail:    func() { _ = w.Close() },
		carrier: carrierH2Windowed,
		session: w.id,
	}
	conn, err := clientChannelHandshake(w.ctx, carrier, w.local, w.peer)
	if err != nil {
		_ = pw.CloseWithError(err)
		_ = resp.Body.Close()
		w.mu.Lock()
		w.body, w.resp, w.conn = nil, nil, nil
		w.err = err
		w.cond.Broadcast()
		w.mu.Unlock()
		return err
	}
	// Past the handshake a window ending is routine. Closing the TLS conn
	// must not reach back through the carrier and kill the whole session.
	carrier.fail = func() {}
	w.mu.Lock()
	w.conn = conn
	w.cond.Broadcast()
	w.mu.Unlock()
	return nil
}

func (w *h2WindowedStream) writeTunnelMsg(msg []byte) error {
	// A peer that stops draining must surface as an error, not a parked
	// write (VPN-R39) — the same bound every carrier takes.
	timer := time.AfterFunc(tunnelKeepaliveInterval, func() { _ = w.Close() })
	defer timer.Stop()

	w.mu.Lock()
	for {
		if w.err != nil {
			err := w.err
			w.mu.Unlock()
			return err
		}
		if w.conn == nil {
			w.cond.Wait()
			continue
		}
		// Rotate BEFORE writing: a TLS record cannot be split across two
		// windows, and a session never spans them (d236).
		if w.sent > 0 && w.sent+int64(tlsWireSize(len(msg))) > w.bound {
			old := w.conn
			_ = w.body.Close()
			w.body, w.conn = nil, nil
			w.mu.Unlock()
			_ = old.Close()
			w.mu.Lock()
			continue
		}
		conn := w.conn
		w.mu.Unlock()
		_, err := conn.Write(msg)
		return err
	}
}

func (w *h2WindowedStream) readTunnelMsg() ([]byte, error) {
	for {
		w.mu.Lock()
		if w.err != nil {
			err := w.err
			w.mu.Unlock()
			return nil, err
		}
		conn := w.conn
		body := w.resp
		w.mu.Unlock()
		if conn == nil {
			w.mu.Lock()
			w.cond.Wait()
			w.mu.Unlock()
			continue
		}
		msg, err := readFrameFromStream(conn)
		if err == nil {
			return msg, nil
		}
		w.mu.Lock()
		if w.conn == conn {
			w.conn = nil
		}
		if w.resp == body {
			w.resp = nil
		}
		if w.body != nil {
			_ = w.body.Close()
			w.body = nil
		}
		w.mu.Unlock()
		_ = conn.Close()
		if body != nil {
			_ = body.Close()
		}
		if !errors.Is(err, io.EOF) {
			return nil, w.readErr(err)
		}
		if err := w.openWindow(); err != nil {
			return nil, err
		}
	}
}

func (w *h2WindowedStream) setReadDeadline(t time.Time) error {
	w.timerMu.Lock()
	defer w.timerMu.Unlock()
	if w.readTimer != nil {
		w.readTimer.Stop()
		w.readTimer = nil
	}
	if t.IsZero() {
		return nil
	}
	w.timedOut.Store(false)
	w.readTimer = time.AfterFunc(time.Until(t), func() {
		w.timedOut.Store(true)
		_ = w.Close()
	})
	return nil
}

func (w *h2WindowedStream) readErr(cause error) error {
	if w.timedOut.Load() {
		return os.ErrDeadlineExceeded
	}
	if cause != nil {
		return cause
	}
	return errWSClosed
}

func (w *h2WindowedStream) protocolViolation() { _ = w.Close() }

func (w *h2WindowedStream) transport() string { return carrierH2Windowed }

func (w *h2WindowedStream) sessionID() string { return w.id }

func (w *h2WindowedStream) Close() error {
	w.closeOnce.Do(func() {
		w.mu.Lock()
		w.err = errWSClosed
		close(w.closed)
		body := w.body
		w.body = nil
		resp := w.resp
		w.resp = nil
		conn := w.conn
		w.conn = nil
		w.cond.Broadcast()
		w.mu.Unlock()
		if body != nil {
			_ = body.Close()
		}
		if resp != nil {
			_ = resp.Close()
		}
		if conn != nil {
			_ = conn.Close()
		}
		w.timerMu.Lock()
		if w.readTimer != nil {
			w.readTimer.Stop()
			w.readTimer = nil
		}
		w.timerMu.Unlock()
		w.cancel()
		w.tr.CloseIdleConnections()
	})
	return nil
}
