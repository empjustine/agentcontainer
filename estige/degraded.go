// degraded.go — docs/d171's two degraded-posture gates.
//
// The switch buys two postures (skipped verification, a cleartext tunnel
// URL) and pays for them with two local rules, both here because both exist
// only while the switch is on:
//
//   - the parsed cleartext-forward door refuses before a tunnel opens: at
//     that door the relay KNOWS the exchange is cleartext by construction,
//     so it is the one place the "never proxy cleartext HTTP" line is fully
//     enforceable;
//   - the blind doors (CONNECT, SOCKS5) keep their shape but classify the
//     first client bytes: an HTTP/1.x request line closes the tunnel and
//     logs it. This is an accident guard, not a boundary — the loopback
//     client is the operator's own (VPN-R23), and a masqueraded payload
//     passes by design. It is deliberately narrow so STARTTLS survives:
//     SMTP's EHLO, POP's +OK and IMAP's *OK are not request lines.
package main

import (
	"errors"
	"net"
	"sync/atomic"
)

// errDegradedCleartext is the local error a guarded read returns after the
// guard closed the connection; nothing was forwarded, so the peer sees a
// close at worst.
var errDegradedCleartext = errors.New("cleartext HTTP refused on a degraded tunnel (docs/d171)")

// looksLikeHTTPRequest recognizes an HTTP/1.x request line: an uppercase
// method token, a space, then a target, and " HTTP/1." on the same line.
// It reads at most the first line the first read carried; a request split
// below that is not classified — the guard exists for accidents, and a tool
// honoring ALL_PROXY with an http:// URL writes its request in one segment.
func looksLikeHTTPRequest(p []byte) bool {
	line := p
	for i, b := range p {
		if b == 0x0A {
			line = p[:i]
			break
		}
	}
	line = trimCR(line)
	sp := 0
	for sp < len(line) && line[sp] != ' ' {
		c := line[sp]
		if c < 'A' || c > 'Z' {
			return false
		}
		sp++
	}
	if sp == 0 || sp >= len(line)-1 {
		return false
	}
	for i := sp; i+8 <= len(line); i++ {
		if string(line[i:i+8]) == " HTTP/1." {
			return true
		}
	}
	return false
}

func trimCR(b []byte) []byte {
	if len(b) > 0 && b[len(b)-1] == 0x0D {
		return b[:len(b)-1]
	}
	return b
}

// degradedGuard classifies the first bytes a client writes into a blind
// tunnel. One check per session: after the first read the payload class is
// whatever the client chose, and d171's guard is about the accident at the
// start, not a per-frame filter.
type degradedGuard struct {
	net.Conn
	node   *relayNode
	target string
	via    string
	seen   atomic.Bool
}

func newDegradedGuard(conn net.Conn, node *relayNode, target, via string) *degradedGuard {
	return &degradedGuard{Conn: conn, node: node, target: target, via: via}
}

func (g *degradedGuard) Read(p []byte) (int, error) {
	n, err := g.Conn.Read(p)
	if n > 0 && !g.seen.Swap(true) && looksLikeHTTPRequest(p[:n]) {
		g.refuse()
		return 0, errDegradedCleartext
	}
	return n, err
}

// checkEarly applies the same verdict to bytes that were already buffered
// behind a CONNECT request: they are the session's first bytes even though
// the pump never reads them off the socket.
func (g *degradedGuard) checkEarly(b []byte) bool {
	if len(b) == 0 || g.seen.Swap(true) {
		return false
	}
	if looksLikeHTTPRequest(b) {
		g.refuse()
		return true
	}
	return false
}

// CloseWrite keeps VPN-R18's half-close reachable through the wrapper: the
// embedded net.Conn promotes Read/Write/deadlines but not this, because the
// net.Conn interface has no CloseWrite.
func (g *degradedGuard) CloseWrite() error {
	if cw, ok := g.Conn.(closeWriter); ok {
		return cw.CloseWrite()
	}
	return nil
}

func (g *degradedGuard) refuse() {
	_ = g.Close()
	g.node.refusedRecord(g.target, g.via, "", "degraded-cleartext")
	logLine(sevWarn, "[vpn-relay] DEGRADED: closed a cleartext HTTP exchange at the %s door (docs/d171)", g.via)
}
