// client.go — the tunnel client role (modes C–E): the loopback-only local proxy feeding
// one authenticated tunnel (docs/d073 §7: VPN-R23..R27, §5.1: VPN-R11).
//
// WHY the client never terminates TLS (VPN-R25): it is a byte pump between a
// loopback socket and the tunnel — the application's TLS handshake passes
// through untouched and lands on the target's own certificate, verified by
// the application itself (VPN-R29). That also means this file must never
// grow a "trust the proxy" or certificate-parsing feature: the proxy cannot
// see plaintext, so it cannot validate a certificate for it.
//
// Fail-closed is structural (VPN-R26): no credential or unparsable config
// means runClient returns BEFORE binding any listener, every CONNECT opens
// the tunnel first (there is no code path that dials the target directly),
// and a refused tunnel answers the application locally — the kill switch is
// the only behavior.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// The shared tunnel env names (envTunnelURL, envOperatorToken,
// envClientLabel) are declared with the rest of the process env surface in
// main.go; the client consumes them via clientConfigFromEnv.

const (
	healthPath   = "/healthz"
	socksVersion = 5
	socksNoAuth  = 0
	// SOCKS handshake phases are bounded before a tunnel exists (VPN-R39's
	// "bound everything" applied to the local surface).
	socksHandshakeTimeout = 10 * time.Second
)

// clientConfig is the client's full input surface; validate() is the one
// place that decides it is safe to bind.
type clientConfig struct {
	tunnelURL *url.URL
	token     string
	label     string
	proxyAddr string // HTTP CONNECT listener (must be loopback, VPN-R23)
	socksAddr string // SOCKS5 listener (must be loopback, VPN-R23)
}

// clientConfigFromEnv assembles the config from the flag values and the
// environment. Nothing else may configure the client (one path, no
// scattered defaults — d072's lesson applied).
func clientConfigFromEnv(proxyAddr, socksAddr string) (clientConfig, error) {
	var cfg clientConfig
	raw := os.Getenv(envTunnelURL)
	if raw == "" {
		return cfg, fmt.Errorf("%s is required", envTunnelURL)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return cfg, fmt.Errorf("%s: %w", envTunnelURL, err)
	}
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return cfg, fmt.Errorf("%s must be ws:// or wss://, got %q", envTunnelURL, u.Scheme)
	}
	if u.Host == "" || u.Path == "" {
		return cfg, fmt.Errorf("%s must include host and path (d073 §7)", envTunnelURL)
	}
	cfg.tunnelURL = u
	cfg.token = os.Getenv(envOperatorToken)
	cfg.label = os.Getenv(envClientLabel)
	cfg.proxyAddr = proxyAddr
	cfg.socksAddr = socksAddr
	return cfg, nil
}

// validate enforces the pre-bind invariants. Callers must treat an error as
// fatal: binding the listeners without a working credential would expose a
// proxy surface whose every request fails anyway (VPN-R26 fail-closed).
func (cfg *clientConfig) validate() error {
	if cfg.token == "" {
		return fmt.Errorf("no operator token configured; refusing to start (%s)", envOperatorToken)
	}
	if cfg.tunnelURL == nil {
		return fmt.Errorf("no tunnel URL configured (%s)", envTunnelURL)
	}
	for what, addr := range map[string]string{"http proxy": cfg.proxyAddr, "socks5": cfg.socksAddr} {
		if err := requireLoopback(addr); err != nil {
			return fmt.Errorf("%s listener: %w", what, err)
		}
	}
	if cfg.label == "" {
		host, err := os.Hostname()
		if err != nil || host == "" {
			host = "client"
		}
		cfg.label = host
	}
	if len(cfg.label) > tunnelLabelMax {
		return fmt.Errorf("client label longer than %d bytes", tunnelLabelMax)
	}
	return nil
}

// requireLoopback is VPN-R23 made structural: no flag or env value can put
// these listeners anywhere but loopback.
func requireLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("listen address %q must be host:port: %w", addr, err)
	}
	if host == "localhost" {
		return nil
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || !ip.IsLoopback() {
		return fmt.Errorf("listen address %q is not loopback (VPN-R23)", addr)
	}
	return nil
}

// vpnClient owns the listeners and the health surface (VPN-R27).
type vpnClient struct {
	cfg      clientConfig
	sessions atomic.Int64 // established tunnels (diagnostic, VPN-R27)
	lastErr  atomic.Value // string: last tunnel failure, for /healthz
}

func (c *vpnClient) noteError(err error) {
	msg := err.Error()
	if len(msg) > 200 {
		msg = msg[:200]
	}
	c.lastErr.Store(msg)
}

// runClient binds the loopback listeners and serves until ctx is done.
func runClient(ctx context.Context, cfg clientConfig) error {
	if err := cfg.validate(); err != nil {
		return err
	}
	proxyLn, err := net.Listen("tcp", cfg.proxyAddr)
	if err != nil {
		return fmt.Errorf("http proxy listen: %w", err)
	}
	socksLn, err := net.Listen("tcp", cfg.socksAddr)
	if err != nil {
		proxyLn.Close()
		return fmt.Errorf("socks5 listen: %w", err)
	}
	c := &vpnClient{cfg: cfg}
	// The log shows WHICH tunnel endpoint (host only): the path embeds the
	// capability prefix, which must not land in any log (VPN-R44).
	log.Printf("[vpn-client] listeners http=%s socks5=%s tunnel=%s://%s",
		proxyLn.Addr(), socksLn.Addr(), cfg.tunnelURL.Scheme, cfg.tunnelURL.Host)

	httpSrv := &http.Server{
		Handler:           c,
		ReadHeaderTimeout: 30e9,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- httpSrv.Serve(proxyLn) }()
	go c.serveSOCKS(socksLn)

	select {
	case <-ctx.Done():
		_ = httpSrv.Close()
		_ = socksLn.Close()
		return nil
	case err := <-serveErr:
		_ = socksLn.Close()
		if errors.Is(err, http.ErrServerClosed) || strings.Contains(err.Error(), "use of closed network connection") {
			return nil
		}
		return err
	}
}

// ---------------------------------------------------------------------------
// Tunnel establishment (VPN-R11/R12/R16)
// ---------------------------------------------------------------------------

// connectRejectedError carries the server's CONNECT_ERR reason so each
// local surface can map policy refusals to its own vocabulary.
type connectRejectedError struct{ reason string }

func (e *connectRejectedError) Error() string {
	return "tunnel refused CONNECT: " + e.reason
}

// deniedReason groups the policy verdicts: all of them mean "the operator's
// egress rules said no", which is 403 on HTTP and "not allowed by ruleset"
// on SOCKS — a transport failure is not that.
func deniedReason(reason string) bool {
	switch reason {
	case errReasonDenied, errReasonPortDenied, errReasonTargetIP:
		return true
	}
	return false
}

// openTunnel dials the tunnel leg, authenticates on the handshake
// (VPN-R12), completes HELLO/HELLO_OK, and issues CONNECT for target.
// Success returns a live, unmuxed tunnel (VPN-R17: one wss per CONNECT in
// v2 — no session reuse yet, so every local connection pays one handshake;
// the v3 mux is what removes that).
func (c *vpnClient) openTunnel(ctx context.Context, target string) (*wsConn, error) {
	hdr := make(http.Header)
	hdr.Set("Authorization", "Bearer "+c.cfg.token)
	ws, err := wsDial(ctx, c.cfg.tunnelURL, hdr)
	if err != nil {
		err = fmt.Errorf("tunnel dial: %w", err)
		c.noteError(err)
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			_ = ws.Close()
		}
	}()

	_ = ws.conn.SetReadDeadline(time.Now().Add(tunnelHandshakeTimeout))
	hello, err := encodeHello(c.cfg.label)
	if err != nil {
		c.noteError(err)
		return nil, err
	}
	if err := sendFrame(ws, frameHello, hello); err != nil {
		c.noteError(err)
		return nil, err
	}
	msg, err := readTunnelFrame(ws)
	if err != nil {
		c.noteError(err)
		return nil, fmt.Errorf("tunnel HELLO: %w", err)
	}
	typ, _, payload, err := decodeFrame(msg)
	if err != nil || typ != frameHelloOK || len(payload) != 1 || payload[0] != tunnelVersion {
		err = fmt.Errorf("%w: unexpected HELLO_OK", ErrProtocol)
		c.noteError(err)
		return nil, err
	}

	if err := sendFrame(ws, frameConnect, []byte(target)); err != nil {
		c.noteError(err)
		return nil, err
	}
	msg, err = readTunnelFrame(ws)
	if err != nil {
		c.noteError(err)
		return nil, fmt.Errorf("tunnel CONNECT: %w", err)
	}
	typ, _, payload, err = decodeFrame(msg)
	if err != nil {
		c.noteError(err)
		return nil, err
	}
	switch typ {
	case frameConnected:
	case frameConnectErr:
		rej := &connectRejectedError{reason: string(payload)}
		c.noteError(rej)
		return nil, rej
	default:
		err = fmt.Errorf("%w: unexpected frame %d after CONNECT", ErrProtocol, typ)
		c.noteError(err)
		return nil, err
	}

	// The relay owns the deadlines from here (VPN-R14).
	_ = ws.conn.SetReadDeadline(time.Time{})
	c.sessions.Add(1)
	ok = true
	return ws, nil
}

// ---------------------------------------------------------------------------
// HTTP CONNECT listener (VPN-R24)
// ---------------------------------------------------------------------------

// ServeHTTP multiplexes the two loopback surfaces. The 405 for everything
// else is the deliberate choice d073 VPN-R45 explicitly permits: forwarding
// absolute-form requests would need the v2 allowlist on this surface too,
// and there is no use case for it — a documented 405 to an application that
// already knows where it is talking (no camouflage contract on loopback).
func (c *vpnClient) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodConnect:
		c.handleConnect(w, r)
	case r.Method == http.MethodGet && r.URL.Path == healthPath:
		c.handleHealth(w, r)
	default:
		w.Header().Set("Allow", "CONNECT, GET /healthz")
		writeProblem(w, r, http.StatusMethodNotAllowed, "method-not-allowed",
			"This loopback port accepts only CONNECT tunnels and "+healthPath, "", errors.New("method not allowed"))
	}
}

// handleHealth is VPN-R27: a local, non-secret status surface — tunnel
// endpoint (host only), session count, last failure. Never the credential.
func (c *vpnClient) handleHealth(w http.ResponseWriter, r *http.Request) {
	last, _ := c.lastErr.Load().(string)
	status := map[string]any{
		"status":   "ok",
		"tunnel":   c.cfg.tunnelURL.Scheme + "://" + c.cfg.tunnelURL.Host,
		"sessions": c.sessions.Load(),
	}
	if last != "" {
		status["last_error"] = last
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(status)
}

func (c *vpnClient) handleConnect(w http.ResponseWriter, r *http.Request) {
	target := connectTarget(r)
	if _, _, err := splitConnectTarget(target); err != nil {
		// No port means no protocol target (VPN-R21's ports are explicit);
		// this is the application's mistake, not a tunnel failure.
		writeProblem(w, r, http.StatusBadRequest, "bad-connect-target",
			"CONNECT target must be host:port", "", err)
		return
	}
	ws, err := c.openTunnel(r.Context(), target)
	if err != nil {
		status, code, title := httpStatusForTunnelErr(err)
		writeProblem(w, r, status, code, title, "", err)
		return
	}

	conn, brw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		_ = ws.Close()
		writeProblem(w, r, http.StatusInternalServerError, "hijack-failed",
			"Could not switch protocols on the local connection", "", err)
		return
	}
	if _, err := brw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		conn.Close()
		_ = ws.Close()
		return
	}
	if err := brw.Flush(); err != nil {
		conn.Close()
		_ = ws.Close()
		return
	}
	// An application that pipelined bytes onto the same segment as its
	// CONNECT request already has them in the hijack buffer; they are part
	// of the tunnel stream and must not be dropped before the relay starts
	// reading the raw socket.
	if n := brw.Reader.Buffered(); n > 0 {
		early, _ := brw.Reader.Peek(n)
		if err := sendFrame(ws, frameData, early); err != nil {
			conn.Close()
			_ = ws.Close()
			return
		}
	}
	relay(ws, conn, tunnelKeepaliveInterval, tunnelIdleTimeout)
}

// connectTarget extracts the CONNECT authority (r.Host for HTTP/1.1
// server requests; the URL forms cover quirks of older clients).
func connectTarget(r *http.Request) string {
	if r.Host != "" {
		return r.Host
	}
	if r.URL.Host != "" {
		return r.URL.Host
	}
	return r.URL.Opaque
}

func httpStatusForTunnelErr(err error) (status int, code, title string) {
	var rej *connectRejectedError
	if errors.As(err, &rej) {
		switch {
		case deniedReason(rej.reason):
			return http.StatusForbidden, "tunnel-denied",
				"The tunnel's egress policy refused the target"
		case rej.reason == errReasonInvalid:
			return http.StatusBadRequest, "bad-connect-target",
				"The tunnel could not parse the CONNECT target"
		default:
			return http.StatusBadGateway, "tunnel-dial-failed",
				"The tunnel could not reach the target"
		}
	}
	return http.StatusBadGateway, "tunnel-unavailable",
		"The tunnel could not be established"
}

// ---------------------------------------------------------------------------
// SOCKS5 listener (VPN-R23)
// ---------------------------------------------------------------------------

func (c *vpnClient) serveSOCKS(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return // listener closed on shutdown
		}
		go c.handleSOCKS(conn)
	}
}

// handleSOCKS speaks just enough RFC 1928: no-auth greeting (the listener
// is loopback-only, VPN-R23 — a credential check here would be theater),
// CONNECT command, domain or IP address types. Domain names pass through
// unresolved; IP literals are refused because the server resolves
// (VPN-R22 — one resolution path, one place the pin happens).
func (c *vpnClient) handleSOCKS(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(socksHandshakeTimeout))

	var head [2]byte
	if _, err := io.ReadFull(conn, head[:]); err != nil {
		return
	}
	if head[0] != socksVersion {
		return
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return
	}
	if !containsByte(methods, socksNoAuth) {
		_, _ = conn.Write([]byte{socksVersion, 0xff})
		return
	}
	if _, err := conn.Write([]byte{socksVersion, socksNoAuth}); err != nil {
		return
	}

	var req [4]byte
	if _, err := io.ReadFull(conn, req[:]); err != nil {
		return
	}
	if req[0] != socksVersion {
		return
	}
	if req[1] != 1 { // only CONNECT
		socksReply(conn, 0x07)
		return
	}

	var host string
	switch req[3] {
	case 1: // IPv4 literal
		var b [4]byte
		if _, err := io.ReadFull(conn, b[:]); err != nil {
			return
		}
		socksReply(conn, 0x08) // server-side resolution only (VPN-R22)
		return
	case 4: // IPv6 literal
		var b [16]byte
		if _, err := io.ReadFull(conn, b[:]); err != nil {
			return
		}
		socksReply(conn, 0x08)
		return
	case 3: // domain name — the supported path
		var l [1]byte
		if _, err := io.ReadFull(conn, l[:]); err != nil {
			return
		}
		name := make([]byte, int(l[0]))
		if _, err := io.ReadFull(conn, name); err != nil {
			return
		}
		host = string(name)
		if _, literal := parseIPLiteral(host); literal {
			socksReply(conn, 0x08)
			return
		}
	default:
		socksReply(conn, 0x08)
		return
	}
	var portBytes [2]byte
	if _, err := io.ReadFull(conn, portBytes[:]); err != nil {
		return
	}
	target := net.JoinHostPort(host, fmt.Sprintf("%d", binary.BigEndian.Uint16(portBytes[:])))

	ws, err := c.openTunnel(context.Background(), target)
	if err != nil {
		socksReply(conn, socksRepForTunnelErr(err))
		return
	}
	// BND.ADDR/BND.PORT 0.0.0.0:0 — the bound address is meaningless when
	// the real one is behind the tunnel.
	if _, err := conn.Write([]byte{socksVersion, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0}); err != nil {
		_ = ws.Close()
		return
	}
	_ = conn.SetDeadline(time.Time{})
	relay(ws, conn, tunnelKeepaliveInterval, tunnelIdleTimeout)
}

func socksReply(conn net.Conn, rep byte) {
	_, _ = conn.Write([]byte{socksVersion, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
}

func socksRepForTunnelErr(err error) byte {
	var rej *connectRejectedError
	switch {
	case errors.As(err, &rej) && deniedReason(rej.reason):
		return 0x02 // connection not allowed by ruleset — policy said no
	case errors.As(err, &rej) && rej.reason == errReasonInvalid:
		return 0x08
	default:
		return 0x01 // tunnel down: refuse (kill switch, VPN-R26)
	}
}

func containsByte(b []byte, want byte) bool {
	for _, v := range b {
		if v == want {
			return true
		}
	}
	return false
}
