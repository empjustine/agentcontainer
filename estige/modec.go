// modec.go — the h2-post-unbounded carrier (docs/d077 §3): one long-lived
// streaming POST over h2.
//
// The exit node never terminates TLS (VPN-R25), so the h2 leg exists only
// between the relay node and the edge; what lands on the exit node is an
// ordinary h1.1 POST whose bodies carry the session (d077 §5, evidence E2).
// That is why there is no h2-specific session code here beyond the ALPN
// offer and stdlib's transport: the frame layer is carrier-agnostic
// (tunnelStream, d077 §5's "one implementation per carrier feeding the same
// relay pump").
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// alpnNegotiate reports which protocol the endpoint's TLS stack selects for
// the offer set, then disconnects: the probe is disposable — the real
// session dials fresh with the transport that protocol needs (d077 §4:
// ALPN picks the carrier; no upgrade is ever attempted on an h2 connection).
// A ws:// URL has no TLS leg and therefore no ALPN: "" means the WebSocket
// plane.
// dial is the relay node's TCP leg for this probe — direct, or through the
// chain proxy when one is configured (docs/d094); the TLS handshake is
// end-to-end either way.
func alpnNegotiate(ctx context.Context, u *url.URL, offer []string, dial dialFunc, skipVerify bool) (string, error) {
	if u.Scheme != schemeWSS {
		return "", nil
	}
	addr := u.Host
	if !hasPort(addr) {
		addr = net.JoinHostPort(addr, "443")
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, tunnelHandshakeTimeout)
		defer cancel()
	}
	conn, err := dialTLS(ctx, dial, addr, u.Hostname(), offer, skipVerify)
	if err != nil {
		return "", err
	}
	tlsConn, ok := conn.(*tls.Conn)
	if !ok {
		_ = conn.Close()
		return "", fmt.Errorf("ALPN probe: dialTLS returned %T, not *tls.Conn", conn)
	}
	proto := tlsConn.ConnectionState().NegotiatedProtocol
	_ = conn.Close()
	return proto, nil
}

// h2Transport is the one relay→edge h2 client shape, shared by h2-post-unbounded and
// its windowed sibling (docs/d222): the ALPN offer is d077 §4's (h2 first,
// http/1.1 kept so a downgraded edge still parses), TLS is tunnelTLSConfig,
// and the chain rides the dial (docs/d094) — Proxy stays nil on purpose,
// because an ambient proxy would become a forwarding proxy for a cleartext
// URL and read the bearer. Each session owns its transport, so Close drops
// the TLS connection with the session (no cross-session reuse yet).
func (c *relayNode) h2Transport(u *url.URL, skipVerify bool) *http.Transport {
	return &http.Transport{
		ForceAttemptHTTP2:     true,
		TLSClientConfig:       tunnelTLSConfig(u.Hostname(), []string{"h2", protoHTTP11}, skipVerify),
		DialContext:           c.tunnelDial(),
		TLSHandshakeTimeout:   tunnelHandshakeTimeout,
		ResponseHeaderTimeout: tunnelHandshakeTimeout,
	}
}

// errUnboundedRefused is the exit's request-initiation refusal of the
// h2-post-unbounded carrier on a port that requires windows (docs/d222). The
// relay uses it to learn the edge's posture without any per-edge config.
var errUnboundedRefused = errors.New("the edge refused h2-post-unbounded")

// openH2Unbounded starts an h2-post-unbounded session: one POST whose
// request body carries our frames and whose response body carries the exit
// node's. A 200 on h2 is this carrier's session-open (the 101's
// counterpart); a 404 is the camouflage refusal (VPN-R34) and confirms
// nothing about whether the path exists.
func (c *relayNode) openH2Unbounded(ctx context.Context, id string, skipVerify bool) (tunnelStream, error) {
	u := *c.cfg.tunnelURL
	if u.Scheme != schemeWSS {
		return nil, fmt.Errorf("h2-post-unbounded needs a wss:// tunnel URL, got %q", u.Scheme)
	}
	u.Scheme = schemeHTTPS

	tr := c.h2Transport(&u, skipVerify)

	pr, pw := io.Pipe()
	// The request must outlive ctx: the session's life is the CONNECT's,
	// not the dial's. WithoutCancel keeps ctx's values, drops its cancel.
	req, err := http.NewRequestWithContext(context.WithoutCancel(ctx), http.MethodPost, u.String(), pr)
	if err != nil {
		_ = pw.Close()
		return nil, err
	}
	hdr, err := c.cfg.channelHeaders()
	if err != nil {
		_ = pw.CloseWithError(err)
		return nil, err
	}
	hdr.Set(sessionIDHeader, id)
	req.Header = hdr

	// A redirect must never carry the credential somewhere silently: answer
	// with the 3xx and treat it like any other non-200.
	client := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	resp, err := client.Do(req)
	if err != nil {
		_ = pw.CloseWithError(err)
		tr.CloseIdleConnections()
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		_ = pw.Close()
		tr.CloseIdleConnections()
		// The refusal names itself in the problem body; anything else is an
		// ordinary carrier failure. Matching on the type keeps the relay from
		// reconfiguring itself on a generic 400.
		if resp.StatusCode == http.StatusBadRequest && bytes.Contains(detail, []byte("h2-post-unbounded-refused")) {
			return nil, errUnboundedRefused
		}
		return nil, fmt.Errorf("h2-post-unbounded: status %d", resp.StatusCode)
	}
	if resp.ProtoMajor != 2 {
		// Defensive demotion: the probe said h2, the session didn't get it.
		// Route around — dialTransport falls through to websocket (d077 §4).
		_ = resp.Body.Close()
		_ = pw.Close()
		tr.CloseIdleConnections()
		return nil, fmt.Errorf("h2-post-unbounded negotiated %s, not h2", resp.Proto)
	}
	return &h2UnboundedStream{body: resp.Body, pipe: pw, tr: tr, id: id}, nil
}

// h2UnboundedStream is h2-post-unbounded's carrier on the relay-node side (d077 §5):
// writes go into the request-body pipe, reads come off the response body.
// Deadline semantics mirror the wsConn's conn deadlines so the relay needs
// no mode knowledge: a read past its window tears the session down and
// reports the idle timeout it was (not a protocol error), and a write that
// stops moving is bounded too — closing the stream unblocks the pipe.
type h2UnboundedStream struct {
	timerMu   sync.Mutex
	body      io.ReadCloser
	pipe      *io.PipeWriter
	tr        *http.Transport
	id        string
	wmu       sync.Mutex
	closeOnce sync.Once
	readTimer *time.Timer
	timedOut  atomic.Bool
}

func (p *h2UnboundedStream) readTunnelMsg() ([]byte, error) {
	msg, err := readFrameFromStream(p.body)
	if err != nil && p.timedOut.Load() {
		return nil, os.ErrDeadlineExceeded
	}
	return msg, err
}

func (p *h2UnboundedStream) writeTunnelMsg(msg []byte) error {
	p.wmu.Lock()
	defer p.wmu.Unlock()
	timer := time.AfterFunc(tunnelKeepaliveInterval, func() { _ = p.Close() })
	defer timer.Stop()
	_, err := p.pipe.Write(msg)
	return err
}

func (p *h2UnboundedStream) setReadDeadline(t time.Time) error {
	p.timerMu.Lock()
	defer p.timerMu.Unlock()
	if p.readTimer != nil {
		p.readTimer.Stop()
		p.readTimer = nil
	}
	if t.IsZero() {
		return nil
	}
	p.timedOut.Store(false)
	p.readTimer = time.AfterFunc(time.Until(t), func() {
		p.timedOut.Store(true)
		_ = p.Close()
	})
	return nil
}

// protocolViolation has no close frame to send over a body: ending the
// exchange is the entire vocabulary (d077 §5) — the peer's read hits EOF,
// which the session's rules already interpret.
func (p *h2UnboundedStream) protocolViolation() { _ = p.Close() }

// transport names the carrier for the lifecycle log; the relay node can see
// the ALPN evidence the exit node cannot (a proxy stripped it), which is
// exactly d077 §4's h2/websocket/post split.
func (p *h2UnboundedStream) transport() string { return carrierH2Unbounded }

func (p *h2UnboundedStream) sessionID() string { return p.id }

func (p *h2UnboundedStream) Close() error {
	p.closeOnce.Do(func() {
		p.timerMu.Lock()
		if p.readTimer != nil {
			p.readTimer.Stop()
			p.readTimer = nil
		}
		p.timerMu.Unlock()
		_ = p.body.Close()                     // unblocks a pending read
		_ = p.pipe.CloseWithError(errWSClosed) // unblocks a pending write
		p.tr.CloseIdleConnections()
	})
	return nil
}
