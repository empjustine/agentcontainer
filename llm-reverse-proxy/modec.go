// modec.go — mode C (docs/d077 §3): the long-lived streaming POST over h2.
//
// The server never terminates TLS (VPN-R25), so the h2 leg exists only
// between this client and the edge; what lands on the server is an ordinary
// h1.1 POST whose bodies carry the session (d077 §5, evidence E2). That is
// why there is no h2-specific session code here beyond the ALPN offer and
// stdlib's transport: the frame layer is carrier-agnostic (tunnelStream,
// d077 §5's "one implementation per mode feeding the same relay pump").
package main

import (
	"context"
	"crypto/tls"
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
// ALPN picks the mode; no upgrade is ever attempted on an h2 connection).
// A ws:// URL has no TLS leg and therefore no ALPN: "" means mode D's plane.
func alpnNegotiate(ctx context.Context, u *url.URL, offer []string) (string, error) {
	if u.Scheme != "wss" {
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
	td := &tls.Dialer{Config: &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: u.Hostname(),
		NextProtos: offer,
	}}
	conn, err := td.DialContext(ctx, "tcp", addr)
	if err != nil {
		return "", err
	}
	proto := conn.(*tls.Conn).ConnectionState().NegotiatedProtocol
	_ = conn.Close()
	return proto, nil
}

// openPOST starts a mode C session: one POST whose request body carries our
// frames and whose response body carries the server's. A 200 on h2 is this
// mode's session-open (the 101's counterpart); a 404 is the camouflage
// refusal (VPN-R34) and confirms nothing about whether the path exists.
func (c *vpnClient) openPOST(ctx context.Context) (tunnelStream, error) {
	u := *c.cfg.tunnelURL
	if u.Scheme != "wss" {
		return nil, fmt.Errorf("mode C needs a wss:// tunnel URL, got %q", u.Scheme)
	}
	u.Scheme = "https"

	tr := &http.Transport{
		ForceAttemptHTTP2: true,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: u.Hostname(),
			// The offer set of d077 §4: h2 first, http/1.1 kept so the
			// transport can still parse a response if the edge downgrades.
			// System roots only — this module has no override knob
			// (VPN-R28/R55).
			NextProtos: []string{"h2", "http/1.1"},
		},
		DialContext:           (&net.Dialer{Timeout: tunnelHandshakeTimeout}).DialContext,
		TLSHandshakeTimeout:   tunnelHandshakeTimeout,
		ResponseHeaderTimeout: tunnelHandshakeTimeout,
		// Proxy is nil on purpose: an ambient proxy would terminate its own
		// TLS in front of us and see the bearer credential it forwards.
	}

	pr, pw := io.Pipe()
	// The request must outlive ctx: the session's life is the CONNECT's,
	// not the dial's. WithoutCancel keeps ctx's values, drops its cancel.
	req, err := http.NewRequestWithContext(context.WithoutCancel(ctx), http.MethodPost, u.String(), pr)
	if err != nil {
		_ = pw.Close()
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.token)

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
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		_ = pw.Close()
		tr.CloseIdleConnections()
		return nil, fmt.Errorf("tunnel POST: status %d", resp.StatusCode)
	}
	if resp.ProtoMajor != 2 {
		// Defensive demotion: the probe said h2, the session didn't get it.
		// Route around — dialTransport falls through to mode D (d077 §4).
		_ = resp.Body.Close()
		_ = pw.Close()
		tr.CloseIdleConnections()
		return nil, fmt.Errorf("mode C negotiated %s, not h2", resp.Proto)
	}
	return &postClientStream{body: resp.Body, pipe: pw, tr: tr}, nil
}

// postClientStream is mode C's carrier from the client side (d077 §5):
// writes go into the request-body pipe, reads come off the response body.
// Deadline semantics mirror the wsConn's conn deadlines so the relay needs
// no mode knowledge: a read past its window tears the session down and
// reports the idle timeout it was (not a protocol error), and a write that
// stops moving is bounded too — closing the stream unblocks the pipe.
type postClientStream struct {
	body      io.ReadCloser
	pipe      *io.PipeWriter
	tr        *http.Transport
	wmu       sync.Mutex
	closeOnce sync.Once
	readTimer *time.Timer
	timedOut  atomic.Bool
}

func (p *postClientStream) readTunnelMsg() ([]byte, error) {
	msg, err := readFrameFromStream(p.body)
	if err != nil && p.timedOut.Load() {
		return nil, os.ErrDeadlineExceeded
	}
	return msg, err
}

func (p *postClientStream) writeTunnelMsg(msg []byte) error {
	p.wmu.Lock()
	defer p.wmu.Unlock()
	timer := time.AfterFunc(tunnelKeepaliveInterval, func() { _ = p.Close() })
	defer timer.Stop()
	_, err := p.pipe.Write(msg)
	return err
}

func (p *postClientStream) setReadDeadline(t time.Time) error {
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
func (p *postClientStream) protocolViolation() { _ = p.Close() }

// transport is h2 — the client can see the ALPN evidence the server can't
// (a proxy stripped it), which is exactly d077 §4's h2|wss|post split.
func (p *postClientStream) transport() string { return "h2" }

func (p *postClientStream) Close() error {
	p.closeOnce.Do(func() {
		if p.readTimer != nil {
			p.readTimer.Stop()
		}
		_ = p.body.Close()                     // unblocks a pending read
		_ = p.pipe.CloseWithError(errWSClosed) // unblocks a pending write
		p.tr.CloseIdleConnections()
	})
	return nil
}
