// modee.go — mode E (docs/d077 §3): the h1.1 per-exchange windowing floor,
// built under d081's L4 amendment (mechanics settled by the hostile-link
// model, parameters provisional, no spike gate).
//
// WHY windowing: mode E exists for gateways that strip upgrades AND offer no
// h2 — environments where, by premise, connectivity is damaged. A long-lived
// request body (mode C's shape) would die with the connection and need
// cross-reconnect session state exactly where the link is least trustworthy;
// a windowed exchange stands alone — a dropped window retries, nothing to
// resurrect. That decision needs no measurement, which is the whole point of
// the amendment: L4 now characterizes the two provisional constants below
// after the fact, it never gates them.
//
// Shape (docs/d077 §3): sequential POSTs to the same reserved path; W3C
// traceparent is the dispatch discriminator and the demux — trace-id is the
// local-connection identity, span-id the window sequence position. The first
// authed window (span 1) mints per-trace-id server state; every later window
// carries the same trace-id with the next span; unknown trace-id or span
// answers the camouflage 404 (VPN-R34). Every request re-authenticates with
// the constant-time bearer (the C/E analogue of VPN-R12's handshake auth).
//
// Client side is a tunnelStream that batches the relay pump's frames into
// windows (the SAME pump, handshake, and lifecycle as C and D — d077 §5);
// server side is a tunnelStream whose reads/writes are served by successive
// exchange handlers. One window at a time per session (stop-and-wait, d081):
// the em lock on the client and the inFlight CAS on the server ARE that
// contract made structural.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// PROVISIONAL constants (d081's mode-E amendment — the S1 pattern: ship
// conservative defaults, characterize later with the demoted L4/L1; never
// gate a build on them).
const (
	// exchangeWindowBytes is the flush point: pending frames ride the next
	// POST once the batch reaches it. One max tunnel frame fits exactly
	// (maxFramePayload), so a lone big frame is a lone window and small
	// interactive frames coalesce instead of each paying a round trip.
	exchangeWindowBytes = 64 << 10
	// exchangePollBackoff is how long a reader waits before polling an idle
	// session again. Without it an empty exchange would immediately trigger
	// the next empty exchange — a tight request loop against a damaged
	// link. Server-push latency in an idle session is bounded by this plus
	// one round trip; the relay's own keepalive PING wakes the backoff
	// early, and any client write wakes it immediately.
	exchangePollBackoff = 250 * time.Millisecond
	// inboundWindowCap bounds one window's frame queue server-side: the
	// worst client batch is exchangeWindowBytes-1 pending plus one appended
	// max-size frame, both 64 KiB scales here — anything beyond is a peer
	// violating the window contract, which is a protocol error, not a
	// buffer to grow into (VPN-R39).
	inboundWindowCap = exchangeWindowBytes + maxFramePayload
	// maxExchangeSessions bounds the per-trace-id registry (d081: TTL'd
	// state, never leak). Sessions delete themselves on close — every phase
	// is deadline-bounded (handshake, relay idle, window ResponseHeader
	// timeout), so runSession always reaches its deferred Close; the cap
	// only bounds a burst of live sessions. Full registry refuses new mints
	// loudly (logged), never evicts a live session.
	maxExchangeSessions = 1024
	// firstWindowSpan is the span-id that mints state: W3C span ids are
	// nonzero, and the sequence starts at 1 so a continuation without state
	// (span > 1, empty registry) is distinguishable from a fresh session.
	firstWindowSpan = 1
)

// ---------------------------------------------------------------------------
// traceparent — the dispatch discriminator and demux (docs/d077 §4)
// ---------------------------------------------------------------------------

// parseTraceparent parses the W3C traceparent value
// version(2)-traceId(32)-spanId(16)-flags(2) into the trace-id key and the
// window's sequence position. Only version 00 is accepted — we emit it, and
// a version we do not understand is not a window this server can serve.
// The trace-id is lowercased so one connection can never register twice
// under case-distinct keys. Returns (trace-id, span, error).
func parseTraceparent(v string) (string, uint64, error) {
	bad := func(why string) (string, uint64, error) {
		return "", 0, fmt.Errorf("traceparent: %s", why)
	}
	parts := strings.Split(v, "-")
	if len(parts) != 4 {
		return bad("want 4 fields")
	}
	if parts[0] != "00" {
		return bad("unsupported version")
	}
	if len(parts[1]) != 32 {
		return bad("trace-id length")
	}
	if _, err := hex.DecodeString(parts[1]); err != nil {
		return bad("trace-id not hex")
	}
	if strings.Trim(parts[1], "0") == "" {
		return bad("all-zero trace-id")
	}
	if len(parts[2]) != 16 {
		return bad("span-id length")
	}
	if _, err := hex.DecodeString(parts[2]); err != nil {
		return bad("span-id not hex")
	}
	span, err := strconv.ParseUint(parts[2], 16, 64)
	if err != nil || span == 0 {
		return bad("all-zero span-id")
	}
	if len(parts[3]) != 2 {
		return bad("flags length")
	}
	if _, err := hex.DecodeString(parts[3]); err != nil {
		return bad("flags not hex")
	}
	return strings.ToLower(parts[1]), span, nil
}

// buildTraceparent renders the header one window carries: version 00, the
// session's trace-id, the window's sequence position (nonzero, W3C),
// sampled flag.
func buildTraceparent(traceID string, span uint64) string {
	return fmt.Sprintf("00-%s-%016x-01", traceID, span)
}

// newTraceID draws the per-session connection identity: 16 random bytes as
// 32 lowercase hex chars, all-zero redrawn (W3C forbids it; the redraw loop
// is form-over-probability — a zero draw is 2^-128).
func newTraceID() (string, error) {
	var b [16]byte
	for {
		if _, err := rand.Read(b[:]); err != nil {
			return "", err
		}
		id := hex.EncodeToString(b[:])
		if strings.Trim(id, "0") != "" {
			return id, nil
		}
	}
}

// ---------------------------------------------------------------------------
// Client carrier — the relay node's windowStream
// ---------------------------------------------------------------------------

// windowStream is mode E's tunnelStream on the relay-node side: frames
// accumulate in pending and ride the next window; the reader drives
// exchanges (a frame-read demand starts one, an idle reader polls on the
// backoff timer), the writer forces one when the batch reaches
// exchangeWindowBytes. Deadline semantics mirror postRelayStream's so the
// relay needs no mode knowledge: a read past its window tears the session
// down and reports the idle timeout it was.
type windowStream struct {
	url     string // http(s) form of the tunnel URL — one POST target, path included
	token   string
	traceID string
	// parent is the dial context with cancel dropped — see openExchange.
	parent context.Context
	client *http.Client
	tr     *http.Transport

	// em serializes EXCHANGES — the stop-and-wait contract (one request in
	// flight per session, d081) and the writer's flush path share it.
	em            sync.Mutex
	resp          *http.Response // current exchange's response; nil between windows
	exchangeDone  chan struct{}  // closed (under em) when resp clears; writers park on it
	seq           uint64         // window sequence (span-id), bumped under em
	curHadBody    bool           // current exchange carried request bytes (em)
	curGotFrame   bool           // current exchange delivered a frame (em)
	lastPollEmpty bool           // last finished exchange was a pure empty poll (em)

	// pm guards pending — writers may append while an exchange is in
	// flight; the frames batch for the next window.
	pm      sync.Mutex
	pending bytes.Buffer

	wake      chan struct{} // cap 1: nudges the reader out of its backoff
	closeOnce sync.Once
	closed    chan struct{}
	readTimer *time.Timer
	timedOut  atomic.Bool
}

// openExchange builds the carrier without touching the network: mode E has
// no probe — the first window IS the session-open (HELLO rides it), which
// is what makes E the floor a client can always demote into (d077 §4).
// The dial context is kept by value with cancel dropped (WithoutCancel,
// mode C's session-request reason): once the local connection is hijacked
// the request context dies, the session does not.
func (c *relayNode) openExchange(ctx context.Context) (tunnelStream, error) {
	u := *c.cfg.tunnelURL
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	default:
		return nil, fmt.Errorf("mode E needs a ws:// or wss:// tunnel URL, got %q", c.cfg.tunnelURL.Scheme)
	}
	traceID, err := newTraceID()
	if err != nil {
		return nil, err
	}
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: u.Hostname(),
			// http/1.1 ONLY: mode E is the h1 floor — offering h2 would
			// silently turn a floor session into mode C's plane. System
			// roots, no override knob (VPN-R28/R55).
			NextProtos: []string{"http/1.1"},
		},
		DialContext:         (&net.Dialer{Timeout: tunnelHandshakeTimeout}).DialContext,
		TLSHandshakeTimeout: tunnelHandshakeTimeout,
		// The FIRST window's headers can arrive after the exit node ran a
		// whole CONNECT dial (drain happens before its 200): budget the
		// handshake plus the dial, or a slow-but-legal 12 s dial would kill
		// an E session that modes C/D would have completed.
		ResponseHeaderTimeout: tunnelHandshakeTimeout + tunnelDialTimeout,
		// Proxy is nil on purpose (same as mode C): an ambient proxy would
		// terminate its own TLS in front of us and see the bearer it
		// forwards.
	}
	return &windowStream{
		url:          u.String(),
		token:        c.cfg.token,
		traceID:      traceID,
		parent:       context.WithoutCancel(ctx),
		client:       &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		tr:           tr,
		exchangeDone: make(chan struct{}),
		wake:         make(chan struct{}, 1),
		closed:       make(chan struct{}),
	}, nil
}

// writeTunnelMsg batches one frame into the next window. Below the flush
// point it returns immediately (the reader's next exchange carries the
// batch); at or above it, it forces an exchange and — stop-and-wait — waits
// out any in-flight one first. The wait is the backpressure: the pump's
// write blocks instead of a queue growing (VPN-R18).
func (w *windowStream) writeTunnelMsg(msg []byte) error {
	select {
	case <-w.closed:
		return errWSClosed
	default:
	}
	w.pm.Lock()
	w.pending.Write(msg)
	flush := w.pending.Len() >= exchangeWindowBytes
	w.pm.Unlock()
	// A parked reader must not miss the batch: the wake makes its backoff
	// wait return so the exchange starts now, not in up to one backoff tick.
	select {
	case w.wake <- struct{}{}:
	default:
	}
	if !flush {
		return nil
	}
	return w.forceExchange()
}

// forceExchange sends whatever is pending, waiting out an in-flight window
// first — the writer's half of stop-and-wait.
func (w *windowStream) forceExchange() error {
	for {
		w.em.Lock()
		if w.resp == nil {
			err := w.startExchangeLocked()
			w.em.Unlock()
			return err
		}
		// The reader owns em while it reads that exchange's frames; park on
		// the exchange-completion signal instead of holding em across a
		// round trip the reader needs to finish.
		done := w.exchangeDone
		w.em.Unlock()
		select {
		case <-done:
		case <-w.closed:
			return errWSClosed
		}
	}
}

// readTunnelMsg delivers exactly one frame, driving the window sequence:
// continue the current exchange's response, else start one (a non-empty
// batch rides immediately; an empty one is a poll — backoff-gated after the
// first pure empty poll so an idle session cannot spin).
func (w *windowStream) readTunnelMsg() ([]byte, error) {
	for {
		w.em.Lock()
		select {
		case <-w.closed:
			w.em.Unlock()
			return nil, w.readErr(nil)
		default:
		}
		if w.resp == nil && w.pendingLen() == 0 && w.lastPollEmpty {
			// Pure-poll backoff: wait ONE tick, then fall through to the
			// exchange below. Clearing the marker HERE is what makes the
			// backoff a GATE (poll → wait → poll) instead of a terminal
			// state — the first design re-parked on the still-set marker
			// forever, silently stalling every idle session; the marker is
			// recomputed when that next poll completes.
			w.em.Unlock()
			if err := w.awaitWake(); err != nil {
				return nil, err
			}
			w.em.Lock()
			w.lastPollEmpty = false
		}
		if w.resp == nil {
			if err := w.startExchangeLocked(); err != nil {
				w.em.Unlock()
				return nil, w.readErr(err)
			}
		}
		msg, err := readFrameFromStream(w.resp.Body)
		if err == nil {
			w.curGotFrame = true
			w.em.Unlock()
			return msg, nil
		}
		// The exchange's response ended (or broke): close it out and loop —
		// a clean EOF is not an error, the next window is how this carrier
		// asks for more.
		hadBody, gotFrame := w.curHadBody, w.curGotFrame
		_ = w.resp.Body.Close()
		w.resp = nil
		close(w.exchangeDone)
		w.exchangeDone = make(chan struct{})
		w.curHadBody, w.curGotFrame = false, false
		w.lastPollEmpty = !hadBody && !gotFrame
		w.em.Unlock()
		if err != io.EOF {
			return nil, w.readErr(err)
		}
	}
}

// pendingLen reads the batch size under pm (callers hold em, which is a
// different lock — never take pm while holding em below this line).
func (w *windowStream) pendingLen() int {
	w.pm.Lock()
	defer w.pm.Unlock()
	return w.pending.Len()
}

// startExchangeLocked POSTs the pending batch as one window and parks the
// response for the reader. Caller holds em.
func (w *windowStream) startExchangeLocked() error {
	select {
	case <-w.closed:
		return errWSClosed
	default:
	}
	w.pm.Lock()
	batch := make([]byte, w.pending.Len())
	copy(batch, w.pending.Bytes())
	w.pending.Reset()
	w.pm.Unlock()

	w.seq++
	req, err := http.NewRequestWithContext(w.parent, http.MethodPost, w.url, bytes.NewReader(batch))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+w.token)
	req.Header.Set("traceparent", buildTraceparent(w.traceID, w.seq))
	resp, err := w.client.Do(req)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		// Any non-200 is the exit node refusing this window (unknown
		// trace-id, out-of-order span, registry full): there is no
		// in-protocol recovery — the session dies and the local surface
		// sees the failure (VPN-R26 mid-session semantics; demotion is a
		// DIAL-time ladder, d077 §4).
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		return fmt.Errorf("tunnel window: status %d", resp.StatusCode)
	}
	w.resp = resp
	w.curHadBody = len(batch) > 0
	w.curGotFrame = false
	return nil
}

// awaitWake parks the idle reader for at most one backoff tick; a client
// write or the tick itself returns it (the loop re-checks everything).
func (w *windowStream) awaitWake() error {
	timer := time.NewTimer(exchangePollBackoff)
	defer timer.Stop()
	select {
	case <-w.wake:
		return nil
	case <-timer.C:
		return nil
	case <-w.closed:
		return w.readErr(nil)
	}
}

// readErr renders a stream-level error with the relay's expected vocabulary:
// a fired deadline wins (an idle reap reports as the timeout it was), the
// cause survives when there is one (a refused window keeps its status line
// for the dial-failure log), and a bare close is the carrier's closed error.
func (w *windowStream) readErr(cause error) error {
	if w.timedOut.Load() {
		return os.ErrDeadlineExceeded
	}
	if cause != nil {
		return cause
	}
	return errWSClosed
}

// setReadDeadline bounds the next read (VPN-R39/R14): fire closes the
// stream, which unblocks every park — reader, writer, and backoff alike.
func (w *windowStream) setReadDeadline(t time.Time) error {
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

// protocolViolation has no close frame to send over a body: ending
// exchanges is the entire vocabulary (the mode C carrier says the same).
func (w *windowStream) protocolViolation() { _ = w.Close() }

// transport names the carrier for the lifecycle log — "post" is the
// vocabulary's h1-POST value (docs/d077 §4: h2 | wss | post; the relay node
// CAN tell C from E by its own plane, but the log vocabulary stays stable).
func (w *windowStream) transport() string { return "post" }

// Close tears the carrier down once: the closed channel releases every
// parked reader/writer, the in-flight response body dies with it, and the
// transport's idle conns are dropped (a dead session leaves no keep-alive
// conn half-open behind it).
func (w *windowStream) Close() error {
	w.closeOnce.Do(func() {
		if w.readTimer != nil {
			w.readTimer.Stop()
		}
		close(w.closed)
		w.em.Lock()
		if w.resp != nil {
			_ = w.resp.Body.Close()
		}
		w.em.Unlock()
		w.tr.CloseIdleConnections()
	})
	return nil
}

// ---------------------------------------------------------------------------
// Server side — the exit node's exchangeStream and its registry
// ---------------------------------------------------------------------------

// exchangeSessions is the per-trace-id registry: one entry per live mode E
// session, minted by a span-1 window, removed by the session's own Close
// (runSession is deadline-bounded end to end, so every entry that can exist
// also always reaches its removal — the cap bounds the live set, nothing
// needs a janitor).
type exchangeSessions struct {
	mu      sync.Mutex
	byTrace map[string]*exchangeStream
}

// newExchangeSessions returns an empty per-trace-id registry.
func newExchangeSessions() *exchangeSessions {
	return &exchangeSessions{byTrace: make(map[string]*exchangeStream)}
}

// accept resolves a window's trace-id to its session: an existing entry
// continues (the span check lives in beginWindow, next to the sequence
// state), a fresh trace-id mints iff the span says it is the first window.
// A nil return means "not a serveable window" — the caller answers the
// camouflage 404.
func (t *tunnelServer) accept(traceID string, span uint64, keyID string) *exchangeStream {
	t.sessions.mu.Lock()
	defer t.sessions.mu.Unlock()
	if s := t.sessions.byTrace[traceID]; s != nil {
		return s
	}
	if span != firstWindowSpan {
		// A continuation without state: unknown trace-id is camouflage
		// 404 by decision (d077 §3, VPN-R34) — the answer must not tell a
		// prober that minting works.
		return nil
	}
	if len(t.sessions.byTrace) >= maxExchangeSessions {
		// Loud, not silent: a full registry means a session leak or an
		// operator burst, and refusing a NEW session is survivable while a
		// half-minted one would not be (NFR-2).
		log.Printf("[llm-reverse-proxy] tunnel mode E: session registry full (%d) — refusing new session", maxExchangeSessions)
		return nil
	}
	s := newExchangeStream(traceID, t.sessions)
	t.sessions.byTrace[traceID] = s
	// Attribution at mint — the same point the 101 and mode C paths take
	// it: after auth, before any session work (docs/d078 §5). The id is a
	// label, so saying it out loud is allowed; the credential never is.
	log.Printf("[llm-reverse-proxy] tunnel session: authenticated key=%s", keyID)
	go t.runSession(s)
	return s
}

// exchangeStream is mode E's tunnelStream on the exit-node side: reads pop
// the windows handlers drained into inbound; writes park in the one-frame
// outbound slot until the current (or next) window's handler flushes it.
// Slot capacity one IS VPN-R18 — the relay's next read cannot happen until
// this frame is on the wire of some window.
type exchangeStream struct {
	traceID  string
	sessions *exchangeSessions

	// mu guards the sequence state AND the one-window-at-a-time contract:
	// beginWindow is the only mutator, so response writers are serialized
	// structurally (no separate write mutex).
	mu       sync.Mutex
	nextSpan uint64
	inFlight bool

	inbound  chan []byte
	inBytes  atomic.Int64 // admitted-not-consumed bytes; cap = inboundWindowCap
	outbound chan []byte  // cap 1: one frame of backpressure (VPN-R18)

	closeOnce sync.Once
	closed    chan struct{}
	readTimer *time.Timer
	timedOut  atomic.Bool
}

// newExchangeStream builds an unstarted session carrier (runSession is
// spawned by accept once the registry holds it).
func newExchangeStream(traceID string, sessions *exchangeSessions) *exchangeStream {
	return &exchangeStream{
		traceID:  traceID,
		sessions: sessions,
		nextSpan: firstWindowSpan,
		// Small on purpose: a handler blocks on a full queue instead of the
		// queue growing, and the relay consumer is always running — during
		// the handshake phases each window carries 1–2 frames, far below.
		inbound:  make(chan []byte, 4096),
		outbound: make(chan []byte, 1),
		closed:   make(chan struct{}),
	}
}

// beginWindow admits a window iff the stop-and-wait sequence holds: no
// other window in flight, and the span is exactly the next position. A
// desynced or concurrent peer gets the camouflage 404 and, with its
// session's answer never coming, dies with the exchange — no in-protocol
// recovery (one stream, one life).
func (s *exchangeStream) beginWindow(span uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inFlight || span != s.nextSpan {
		return false
	}
	s.inFlight = true
	s.nextSpan++
	return true
}

// endWindow releases the sequence slot (deferred by the handler).
func (s *exchangeStream) endWindow() {
	s.mu.Lock()
	s.inFlight = false
	s.mu.Unlock()
}

// drain reads one window's frames off the request body into inbound until
// the client's body ends. The push blocks (backpressure) and trips the
// byte cap as a protocol error — never a queue that grows (VPN-R39).
// Returns nil when the window is fully admitted; any error means the
// session is dead.
func (s *exchangeStream) drain(r *http.Request) error {
	for {
		msg, err := readFrameFromStream(r.Body)
		if err != nil {
			if err == io.EOF {
				return nil // clean window end
			}
			return err
		}
		if s.inBytes.Add(int64(len(msg))) > inboundWindowCap {
			return fmt.Errorf("%w: window exceeds %d bytes", ErrProtocol, inboundWindowCap)
		}
		select {
		case s.inbound <- msg:
		case <-s.closed:
			s.inBytes.Add(-int64(len(msg)))
			return io.ErrClosedPipe
		}
	}
}

// flushWindow writes outbound frames into this exchange's response until
// the slot is empty — then the window ends (handler return closes the
// body). A frame arriving after the emptiness check waits for the next
// window; that wait is bounded by the client's poll backoff or its next
// write, never by this handler (stop-and-wait: holding the response open
// for more would block the client's next request). lw is the logging
// wrapper whose size the CLF line reads.
func (s *exchangeStream) flushWindow(lw *loggingResponseWriter) {
	rc := http.NewResponseController(lw)
	for {
		select {
		case msg := <-s.outbound:
			// Same bound the hijacked/postStream paths take: a peer that
			// stops draining must surface as an error, not a goroutine
			// parked in a write (VPN-R39).
			_ = rc.SetWriteDeadline(time.Now().Add(tunnelKeepaliveInterval))
			_, err := lw.Write(msg)
			if err == nil {
				_ = rc.Flush()
			}
			_ = rc.SetWriteDeadline(time.Time{})
			if err != nil {
				_ = s.Close()
				return
			}
		case <-s.closed:
			return
		default:
			return
		}
	}
}

// serveTunnelExchange runs one mode E window (docs/d077 §3/§4). Order
// mirrors the 101 path's discipline: authenticate happens in serveTunnel
// before this is ever called; here it is dispatch (traceparent), sequence
// admission, drain, then the response — and the CLF line is emitted for
// EVERY window, because unlike mode C each exchange really is its own
// request.
func (t *tunnelServer) serveTunnelExchange(w http.ResponseWriter, r *http.Request, keyID string) {
	lw := &loggingResponseWriter{ResponseWriter: w}
	traceID, span, err := parseTraceparent(r.Header.Get("traceparent"))
	if err != nil {
		writeFunnel404(lw, r)
		return
	}
	s := t.accept(traceID, span, keyID)
	if s == nil {
		writeFunnel404(lw, r)
		return
	}
	if !s.beginWindow(span) {
		writeFunnel404(lw, r)
		return
	}
	defer s.endWindow()

	if err := s.drain(r); err != nil {
		// A broken window means a broken session: no recovery exists past
		// it (one stream, one life) — kill the state rather than leave a
		// minted session waiting for windows that will never come.
		_ = s.Close()
		log.Printf("[llm-reverse-proxy] tunnel mode E: window drain failed: %v", err)
		logCombinedRequestURI(r, http.StatusInternalServerError, lw.size)
		return
	}
	// The response headers are this window's session-open signal. No
	// EnableFullDuplex needed (unlike mode C): the request body is already
	// fully read, which is exactly why windows exist.
	lw.WriteHeader(http.StatusOK)
	if err := http.NewResponseController(lw).Flush(); err != nil {
		logCombinedRequestURI(r, http.StatusInternalServerError, lw.size)
		return
	}
	s.flushWindow(lw)
	logCombinedRequestURI(r, http.StatusOK, lw.size)
}

// readTunnelMsg pops the next admitted frame — or waits for the next
// window to carry one. The read deadline fires through Close (the timer
// above), which is how the handshake bound and the relay's idle reap reach
// a carrier with no socket of its own.
func (s *exchangeStream) readTunnelMsg() ([]byte, error) {
	select {
	case msg := <-s.inbound:
		s.inBytes.Add(-int64(len(msg)))
		return msg, nil
	case <-s.closed:
		if s.timedOut.Load() {
			return nil, os.ErrDeadlineExceeded
		}
		return nil, io.EOF
	}
}

// writeTunnelMsg parks one frame in the outbound slot; the current
// window's flush or the next window's takes it. Blocking here IS the
// backpressure (VPN-R18): the relay's read of the target stalls until some
// window carries this frame, and Close releases the park.
func (s *exchangeStream) writeTunnelMsg(msg []byte) error {
	select {
	case s.outbound <- msg:
		return nil
	case <-s.closed:
		if s.timedOut.Load() {
			return os.ErrDeadlineExceeded
		}
		return io.ErrClosedPipe
	}
}

// setReadDeadline arms the timer that closes the session on expiry —
// the exchange carrier's equivalent of a conn read deadline (VPN-R39/R14).
func (s *exchangeStream) setReadDeadline(t time.Time) error {
	if s.readTimer != nil {
		s.readTimer.Stop()
		s.readTimer = nil
	}
	if t.IsZero() {
		return nil
	}
	s.timedOut.Store(false)
	s.readTimer = time.AfterFunc(time.Until(t), func() {
		s.timedOut.Store(true)
		_ = s.Close()
	})
	return nil
}

// protocolViolation has no in-band signal (same as the mode C body
// carrier): ending the session is the abort the peer observes.
func (s *exchangeStream) protocolViolation() { _ = s.Close() }

// transport names the carrier for the lifecycle log: the exit node saw a
// plain POST — the edge stripped the plane evidence, and the vocabulary is
// h2 | wss | post (docs/d077 §4).
func (s *exchangeStream) transport() string { return "post" }

// Close releases the session exactly once: parked readers/writers and any
// in-flight handler see closed, and the registry entry goes with it.
func (s *exchangeStream) Close() error {
	s.closeOnce.Do(func() {
		if s.readTimer != nil {
			s.readTimer.Stop()
		}
		close(s.closed)
		s.sessions.mu.Lock()
		if s.sessions.byTrace[s.traceID] == s {
			delete(s.sessions.byTrace, s.traceID)
		}
		s.sessions.mu.Unlock()
	})
	return nil
}
