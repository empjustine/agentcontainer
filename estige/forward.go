// forward.go — the cleartext forward-proxy branch of the relay's loopback
// surface (docs/d103): absolute-form http:// and ws:// requests are parsed,
// rewritten to origin-form, and answered from ONE tunneled exchange.
//
// WHY this exists at all: the chain step (d095) exports the conventional
// HTTP_PROXY spelling, and a client honoring it for a cleartext URL sends
// absolute-form — before d103 that died on a 405, so plain http:// never
// reached the vpn-exit despite the env spelling promising a route.
//
// WHY parsing costs no visibility (the accounting that let the blind-pump
// requirement drop): the bytes were already in this process's address
// space, and an http:// origin sees plaintext by construction. The property
// that binds instead is party-visibility — loopback-only listeners
// (VPN-R23), the tunnel's TLS on the relay↔exit leg (framing untouched),
// and the exit's egress table as the only egress policy. d080's
// never-consults-a-host-set half keeps its teeth here: this branch consults
// no host table, only the address the client itself addressed.
//
// WHAT STAYS FORBIDDEN HERE (VPN-R25): https:// and wss:// absolute-form
// requests are NOT forwarded — the relay terminates no TLS for any target,
// so those keep riding CONNECT as opaque bytes (ServeHTTP's 405 says so).
package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

// handleForward is d103's branch: tunnel first, then one ordinary HTTP
// exchange over it — never a direct dial (VPN-R26), never a local name
// lookup (the exit resolves and pins, VPN-R22), never a second exchange on
// the same pinned tunnel (the client connection closes with the response).
func (c *relayNode) handleForward(w http.ResponseWriter, r *http.Request) {
	target := forwardTarget(r.URL)
	tun, err := c.openTunnel(r.Context(), target)
	if err != nil {
		status, code, title := httpStatusForTunnelErr(err)
		writeProblem(w, r, status, code, title, err)
		return
	}
	// One request, one stream: ReverseProxy returns only after the
	// response (or the upgrade pump) finishes, so closing here cannot cut a
	// live exchange — and it is what stops this tunnel from outliving the
	// request that pinned it.
	conn := &tunnelByteConn{stream: tun, target: target}
	defer func() { _ = conn.Close() }()

	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			// Scheme "http" serves both branches — a ws:// origin is an
			// http:// origin until the upgrade, and the transport only
			// speaks plaintext (the relay still never speaks TLS,
			// VPN-R25). The target carries no path, so the request keeps
			// its own origin-form path and query; SetURL strips Proxy-*
			// and hop-by-hop headers and the client's forwarding headers
			// by construction — d103's "one rewrite, done by a real HTTP
			// message writer".
			pr.SetURL(&url.URL{Scheme: schemeHTTP, Host: r.URL.Host})
			// The addressed host reaches the origin as the client
			// addressed it: Go's server ignores the Host line of an
			// absolute-form request (r.Host = URL host), so this pins
			// that value through our hands instead of leaving it to the
			// transport's derivation (d103: Host preserved).
			pr.Out.Host = pr.In.Host
			// Connection: close on the wire too: the origin must not keep
			// this exchange around either (d103's pinning).
			pr.Out.Close = true
		},
		ModifyResponse: func(resp *http.Response) error {
			// Force the same close on the client side — except a 101,
			// whose handshake has to keep Connection: Upgrade; the
			// hijacked pump then lives exactly as long as that upgrade,
			// closing with it.
			if resp.StatusCode != http.StatusSwitchingProtocols {
				resp.Header.Set("Connection", "close")
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// A failure after the tunnel opened still answers locally in
			// the tunnel's vocabulary — there is no fallback dial
			// (VPN-R26) and no vocabulary of its own to invent.
			status, code, title := httpStatusForTunnelErr(err)
			writeProblem(w, r, status, code, title, err)
		},
		Transport: &http.Transport{
			// Zero-value Transport on purpose: Proxy is nil, so the
			// ambient proxy env of a dev host can never redirect a
			// tunneled exchange (the dial IS the tunnel), and keep-alives
			// stay off because the stream underneath is single-use.
			DisableKeepAlives: true,
			DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
				// addr is deliberately dropped: the stream is already
				// CONNECTed to forwardTarget's address, and dialing or
				// resolving anything here would take resolution away from
				// the exit (VPN-R22) or create the direct path VPN-R26
				// forbids.
				return conn, nil
			},
		},
	}
	rp.ServeHTTP(w, r)
}

// forwardTarget is the tunnel's CONNECT address for an absolute-form
// cleartext request: the URL's host:port, assuming the cleartext default
// port when the URL carries none (http and ws share it).
func forwardTarget(u *url.URL) string {
	if u.Port() != "" {
		return u.Host
	}
	return net.JoinHostPort(u.Hostname(), "80")
}

// tunnelByteConn is the byte-stream view of one established tunnel stream
// for an ordinary http.Transport: DATA frames become Read/Write bytes,
// PING/PONG answer each other exactly as relay() does so the exit's idle
// timer sees this exchange as activity (VPN-R14), and the read deadline
// rides the carrier's own — the only deadline a stream has. The frame
// framing here is what keeps this a client of the tunnel protocol instead
// of a second implementation of it.
type tunnelByteConn struct {
	stream  tunnelStream
	target  string // CONNECT address — the RemoteAddr diagnostics show
	pending []byte // unread tail of an oversized DATA frame
}

func (c *tunnelByteConn) Read(p []byte) (int, error) {
	for len(c.pending) == 0 {
		_ = c.stream.setReadDeadline(time.Now().Add(tunnelIdleTimeout))
		msg, err := c.stream.readTunnelMsg()
		if err != nil {
			return 0, err
		}
		typ, _, payload, err := decodeFrame(msg)
		if err != nil {
			c.stream.protocolViolation()
			return 0, err
		}
		switch typ {
		case frameData:
			c.pending = payload
		case frameClose:
			return 0, io.EOF
		case framePing:
			if err := sendFrame(c.stream, framePong, payload); err != nil {
				return 0, err
			}
		case framePong:
			// Activity evidence only; the deadline above consumed it.
		default:
			c.stream.protocolViolation()
			return 0, errors.New("session control frame during cleartext exchange")
		}
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

// Write frames at most one frame per chunk, the same bound relay() uses —
// an unbounded net.Conn write must not exceed maxFramePayload.
func (c *tunnelByteConn) Write(p []byte) (int, error) {
	total := 0
	for len(p) > 0 {
		n := min(len(p), maxFramePayload)
		if err := sendFrame(c.stream, frameData, p[:n]); err != nil {
			return total, err
		}
		total += n
		p = p[n:]
	}
	return total, nil
}

func (c *tunnelByteConn) Close() error { return c.stream.Close() }

func (c *tunnelByteConn) LocalAddr() net.Addr               { return tunnelAddr("tunnel") }
func (c *tunnelByteConn) RemoteAddr() net.Addr              { return tunnelAddr(c.target) }
func (c *tunnelByteConn) SetDeadline(t time.Time) error     { return c.stream.setReadDeadline(t) }
func (c *tunnelByteConn) SetReadDeadline(t time.Time) error { return c.stream.setReadDeadline(t) }
func (c *tunnelByteConn) SetWriteDeadline(time.Time) error  { return nil }

// tunnelAddr is a diagnostic net.Addr for the stream side of the
// exchange — a tunnel endpoint has no socket address to report.
type tunnelAddr string

func (a tunnelAddr) Network() string { return "tunnel" }
func (a tunnelAddr) String() string  { return string(a) }
