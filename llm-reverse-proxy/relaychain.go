// relaychain.go — the relay node's chain leg (docs/d094): the one egress
// this deployment has — the tunnel dial — optionally riding ONE upstream
// proxy, declared only through the conventional proxy environment
// variables (SOCKS_SERVER/SOCKS_VERSION, http(s)_proxy, all_proxy).
//
// WHY the chain is hand-rolled here instead of http.Transport.Proxy: the
// chain is a ROUTE, not a policy object. Transport.Proxy is ambient,
// per-transport, and for a cleartext URL it becomes a forwarding proxy
// that reads the bearer (the old "Proxy is nil on purpose" fear, modec.go
// / modee.go). chainProxy.dial is the opposite shape — one parse at
// startup, one blind TCP tunnel (CONNECT or SOCKS5) every carrier's dial
// rides, TLS still end-to-end over it (VPN-R28/R55 untouched). See
// docs/d094 for the full decision.
//
// The env surface deliberately spells nothing repo-private: a restricted
// network already has every tool speaking these variables (curl, Go's
// httpproxy, libproxy), and d079's proxy-first harnesses ride the same
// spellings on the other side of the tunnel.
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/textproto"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// chainEnvVars is the whole chain env surface in ONE list (docs/d094 §1).
// The parser reads the variables individually by precedence; the list
// exists so anything that clears or enumerates the surface (the test
// suite's TestMain) cannot drift from what the parser actually reads.
var chainEnvVars = []string{
	"SOCKS_SERVER", "socks_server", "SOCKS_VERSION", "socks_version",
	"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
	"ALL_PROXY", "all_proxy",
}

// dialFunc is the shape every carrier's TCP leg dials through — direct in
// the ordinary deployment, chainProxy.dial when a chain is configured
// (docs/d094). Passing nil means direct.
type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// directDial is the unchained leg. The timeout bounds a dial the caller's
// context forgot to bound (VPN-R39's rule applied to the tunnel dial).
var directDial dialFunc = (&net.Dialer{Timeout: tunnelHandshakeTimeout}).DialContext

// chainProxy is the parsed, validated chain configuration. Zero value is
// not usable; build with relayChainFromEnv.
type chainProxy struct {
	kind string // "http" (RFC 9110 CONNECT) or "socks5"
	addr string // proxy host:port
	user string // optional proxy credentials (userinfo in the proxy URL)
	pass string
}

// host is the log/health spelling: host:port only — userinfo is a
// credential and never reaches a log line or /healthz (VPN-R44's law
// applied to the chain).
func (p *chainProxy) host() string { return p.addr }

// relayChainFromEnv resolves the chain declaration for one tunnel URL.
// Returns nil (no chain — direct dial) when no proxy variable applies.
// An error is fatal to startup: the relay node refuses to bind listeners
// it could not route (VPN-R26, docs/d094 phase 4).
//
// Precedence: SOCKS_SERVER > scheme-matched {http,https}_proxy >
// ALL_PROXY (docs/d094 §1). The scheme match is against the NORMALIZED
// tunnel URL: wss/https → https_proxy, ws/http → http_proxy.
func relayChainFromEnv(tunnelURL *url.URL) (*chainProxy, error) {
	if raw := envAny("SOCKS_SERVER", "socks_server"); raw != "" {
		ver := envAny("SOCKS_VERSION", "socks_version")
		if ver == "" {
			ver = "5"
		}
		if ver != "5" {
			return nil, fmt.Errorf("SOCKS_VERSION=%s unsupported — only 5 (docs/d094)", ver)
		}
		if !strings.Contains(raw, "://") {
			// SOCKS_SERVER's convention is a bare host:port (libproxy/
			// GNOME); a scheme-bearing value is accepted as-is below.
			raw = "socks5://" + raw
		}
		return parseChainProxy(raw)
	}
	key := "HTTP_PROXY"
	if tunnelURL.Scheme == "wss" || tunnelURL.Scheme == "https" {
		key = "HTTPS_PROXY"
	}
	raw := envAny(key, strings.ToLower(key))
	if raw == "" {
		raw = envAny("ALL_PROXY", "all_proxy")
	}
	if raw == "" {
		return nil, nil
	}
	if !strings.Contains(raw, "://") {
		// curl's convention: a scheme-less proxy value means http://.
		raw = "http://" + raw
	}
	return parseChainProxy(raw)
}

// envAny returns the first set spelling of a variable (uppercase first,
// then lowercase — Go httpproxy's order; both spellings are the de-facto
// convention, docs/d094 §1). Empty-string counts as unset.
func envAny(upper, lower string) string {
	if v := os.Getenv(upper); v != "" {
		return v
	}
	return os.Getenv(lower)
}

// parseChainProxy validates one proxy URL into a chainProxy. Only http://,
// socks5:// and socks5h:// are accepted: https://-to-the-proxy and socks4
// refuse loudly rather than half-support (docs/d094 — extension point).
func parseChainProxy(raw string) (*chainProxy, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("proxy %q: %w", raw, err)
	}
	var kind string
	switch u.Scheme {
	case "http":
		kind = "http"
	case "socks5", "socks5h":
		// socks5h is not a distinct behavior here: the chain NEVER
		// resolves locally — the domain crosses to the proxy verbatim —
		// which is exactly what the h suffix promises.
		kind = "socks5"
	default:
		return nil, fmt.Errorf("proxy %q: scheme must be http:// or socks5:// (docs/d094)", raw)
	}
	if u.Hostname() == "" {
		return nil, fmt.Errorf("proxy %q: no host", raw)
	}
	port := u.Port()
	if port == "" {
		if kind == "socks5" {
			port = "1080"
		} else {
			port = "80"
		}
	}
	if _, err := strconv.ParseUint(port, 10, 16); err != nil {
		return nil, fmt.Errorf("proxy %q: bad port %q", raw, port)
	}
	c := &chainProxy{kind: kind, addr: net.JoinHostPort(u.Hostname(), port)}
	if u.User != nil {
		c.user = u.User.Username()
		c.pass, _ = u.User.Password()
	}
	return c, nil
}

// dial establishes the chained TCP leg: dial the proxy, complete the
// chain handshake (CONNECT or SOCKS5) by hand, hand back the raw conn.
// The handshake is bounded even when the caller's context is not
// (VPN-R39: a black-holed proxy ends in an error, not a parked read).
func (p *chainProxy) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	raw, err := directDial(ctx, network, p.addr)
	if err != nil {
		return nil, fmt.Errorf("chain proxy %s: %w", p.addr, err)
	}
	deadline := time.Now().Add(tunnelHandshakeTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = raw.SetDeadline(deadline)
	var c net.Conn
	switch p.kind {
	case "http":
		c, err = p.httpConnect(raw, addr)
	case "socks5":
		c, err = p.socks5Connect(raw, addr)
	default:
		// Unreachable past parseChainProxy's switch; kept so a future
		// kind cannot silently return a half-open conn.
		err = fmt.Errorf("chain proxy %s: unknown kind %q", p.addr, p.kind)
	}
	if err != nil {
		raw.Close()
		return nil, err
	}
	// The session owns timing from here (VPN-R14's rule at the chain leg).
	_ = c.SetDeadline(time.Time{})
	return c, nil
}

// bufferedConn keeps bytes the chain handshake already consumed from the
// wire — losing them would corrupt the first TLS record after a 200.
type bufferedConn struct {
	net.Conn
	br *bufio.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) { return b.br.Read(p) }

// httpConnect performs RFC 9110 CONNECT through the proxy: a blind TCP
// tunnel to addr. The proxy sees the target host:port and (if the
// operator configured userinfo) a Basic credential — never the tunnel's
// own Authorization, which rides the TLS leg above this one.
func (p *chainProxy) httpConnect(raw net.Conn, addr string) (net.Conn, error) {
	var req strings.Builder
	fmt.Fprintf(&req, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", addr, addr)
	if p.user != "" || p.pass != "" {
		cred := base64.StdEncoding.EncodeToString([]byte(p.user + ":" + p.pass))
		fmt.Fprintf(&req, "Proxy-Authorization: Basic %s\r\n", cred)
	}
	req.WriteString("\r\n")
	if _, err := io.WriteString(raw, req.String()); err != nil {
		return nil, fmt.Errorf("chain proxy %s: CONNECT write: %w", p.addr, err)
	}
	br := bufio.NewReader(raw)
	statusLine, err := readLine(br)
	if err != nil {
		return nil, fmt.Errorf("chain proxy %s: CONNECT read: %w", p.addr, err)
	}
	fields := strings.Fields(statusLine)
	if len(fields) < 2 || fields[1] != "200" {
		return nil, fmt.Errorf("chain proxy %s: CONNECT %s: %q", p.addr, addr, strings.TrimSpace(statusLine))
	}
	if _, err := textproto.NewReader(br).ReadMIMEHeader(); err != nil {
		return nil, fmt.Errorf("chain proxy %s: CONNECT response headers: %w", p.addr, err)
	}
	return &bufferedConn{Conn: raw, br: br}, nil
}

// socks5Connect performs the RFC 1928 client half against the proxy:
// no-auth or username/password (RFC 1929) method selection, then CONNECT
// with the address's own shape (literals as literals, names verbatim —
// resolution stays proxy-side, which is the whole point of socks5h).
func (p *chainProxy) socks5Connect(raw net.Conn, addr string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("chain proxy %s: target %q is not host:port: %w", p.addr, addr, err)
	}
	port, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil {
		return nil, fmt.Errorf("chain proxy %s: target port %q: %w", p.addr, portStr, err)
	}
	haveAuth := p.user != "" || p.pass != ""
	greet := []byte{socksVersion, 1, socksNoAuth}
	if haveAuth {
		greet = []byte{socksVersion, 2, socksNoAuth, 2}
	}
	if _, err := raw.Write(greet); err != nil {
		return nil, fmt.Errorf("chain proxy %s: socks5 greeting: %w", p.addr, err)
	}
	var sel [2]byte
	if _, err := io.ReadFull(raw, sel[:]); err != nil {
		return nil, fmt.Errorf("chain proxy %s: socks5 method: %w", p.addr, err)
	}
	switch sel[1] {
	case socksNoAuth:
	case 2: // RFC 1929 username/password
		if !haveAuth {
			return nil, fmt.Errorf("chain proxy %s: socks5 requires username/password (none configured)", p.addr)
		}
		if len(p.user) > 255 || len(p.pass) > 255 {
			return nil, fmt.Errorf("chain proxy %s: socks5 credentials longer than 255 bytes", p.addr)
		}
		msg := []byte{1, byte(len(p.user))}
		msg = append(msg, p.user...)
		msg = append(msg, byte(len(p.pass)))
		msg = append(msg, p.pass...)
		if _, err := raw.Write(msg); err != nil {
			return nil, fmt.Errorf("chain proxy %s: socks5 auth write: %w", p.addr, err)
		}
		var arep [2]byte
		if _, err := io.ReadFull(raw, arep[:]); err != nil {
			return nil, fmt.Errorf("chain proxy %s: socks5 auth reply: %w", p.addr, err)
		}
		if arep[1] != 0 {
			return nil, fmt.Errorf("chain proxy %s: socks5 username/password rejected", p.addr)
		}
	default:
		return nil, fmt.Errorf("chain proxy %s: socks5 no acceptable auth method (0x%02x)", p.addr, sel[1])
	}

	req := []byte{socksVersion, 1, 0}
	if ip, err := netip.ParseAddr(host); err == nil {
		if v4 := ip.Unmap(); v4.Is4() {
			req = append(req, 1)
			req = append(req, v4.AsSlice()...)
		} else {
			req = append(req, 4)
			req = append(req, ip.AsSlice()...)
		}
	} else {
		if len(host) > 253 {
			return nil, fmt.Errorf("chain proxy %s: target name too long", p.addr)
		}
		req = append(req, 3, byte(len(host)))
		req = append(req, host...)
	}
	req = append(req, byte(port>>8), byte(port))
	if _, err := raw.Write(req); err != nil {
		return nil, fmt.Errorf("chain proxy %s: socks5 CONNECT write: %w", p.addr, err)
	}
	var head [4]byte
	if _, err := io.ReadFull(raw, head[:]); err != nil {
		return nil, fmt.Errorf("chain proxy %s: socks5 CONNECT reply: %w", p.addr, err)
	}
	if head[1] != 0 {
		return nil, fmt.Errorf("chain proxy %s: socks5 CONNECT refused (rep=0x%02x)", p.addr, head[1])
	}
	var skip [4]byte
	switch head[3] {
	case 1:
		_, err = io.ReadFull(raw, skip[:4])
	case 4:
		_, err = io.ReadFull(raw, make([]byte, 16))
	case 3:
		var l [1]byte
		if _, err = io.ReadFull(raw, l[:]); err == nil {
			_, err = io.ReadFull(raw, make([]byte, int(l[0])))
		}
	default:
		err = fmt.Errorf("bad ATYP 0x%02x", head[3])
	}
	if err != nil {
		return nil, fmt.Errorf("chain proxy %s: socks5 CONNECT reply address: %w", p.addr, err)
	}
	if _, err := io.ReadFull(raw, skip[:2]); err != nil {
		return nil, fmt.Errorf("chain proxy %s: socks5 CONNECT reply port: %w", p.addr, err)
	}
	return raw, nil
}

// dialTLS runs the TLS leg over any TCP dialer — the chain included — with
// system roots and ServerName from the tunnel URL's host (VPN-R28/R55: no
// override knob, nothing here may weaken verification). Over a chain the
// proxy sees SNI and ciphertext only; the certificate the relay node
// verifies is the exit node's own, exactly as if dialed direct.
func dialTLS(ctx context.Context, dial dialFunc, addr, serverName string, nextProtos []string) (net.Conn, error) {
	if dial == nil {
		dial = directDial
	}
	raw, err := dial(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	td := tls.Client(raw, &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: serverName,
		NextProtos: nextProtos,
	})
	if err := td.HandshakeContext(ctx); err != nil {
		raw.Close()
		return nil, err
	}
	return td, nil
}
