// relaynode.go — the relay node (docs/d088; served by vpn-relay.sh since
// docs/d095 retired the PROXY_MODE selector), modes C–E: the loopback-only
// local proxy feeding one authenticated tunnel
// (docs/d073 §7: VPN-R23..R27, §5.1: VPN-R11).
//
// WHY the relay node never terminates TLS (VPN-R25): it is a byte pump between a
// loopback socket and the tunnel — the application's TLS handshake passes
// through untouched and lands on the target's own certificate, verified by
// the application itself (VPN-R29). That also means this file must never
// grow a "trust the proxy" or certificate-parsing feature: the proxy cannot
// see plaintext, so it cannot validate a certificate for it.
//
// Fail-closed is structural (VPN-R26): no credential or unparsable config
// means runRelayNode returns BEFORE binding any listener, every CONNECT
// opens the tunnel first (there is no code path that dials the target
// directly), and a refused tunnel answers the application locally — the
// kill switch is the only behavior.
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
// main.go; the relay node consumes them via relayConfigFromEnv.
// envClientLabel keeps the tunnel protocol's own name for the HELLO label
// (the tunnel's client end), not the node name — docs/d088 renames
// deployments, not wire fields.

const (
	healthPath   = "/healthz"
	socksVersion = 5
	socksNoAuth  = 0
	// SOCKS handshake phases are bounded before a tunnel exists (VPN-R39's
	// "bound everything" applied to the local surface).
	socksHandshakeTimeout = 10 * time.Second
)

// relayConfig is the relay node's full input surface; validate() is the one
// place that decides it is safe to bind.
type relayConfig struct {
	tunnelURL *url.URL
	token     string
	label     string
	proxyAddr string      // HTTP CONNECT listener (must be loopback, VPN-R23)
	socksAddr string      // SOCKS5 listener (must be loopback, VPN-R23)
	chain     *chainProxy // optional upstream chain for the tunnel leg (docs/d094)
}

// relayConfigFromEnv assembles the config from the flag values and the
// environment. Nothing else may configure the relay node (one path, no
// scattered defaults — d072's lesson applied).
//
// VPN_TUNNEL_URL is accepted in the URL's honest wire form (http/https/
// ws/wss) and normalized here — the one place — to the canonical ws/wss
// every carrier and probe branches on; each carrier rewrites to its own
// wire scheme itself (docs/d090 §1).
func relayConfigFromEnv(proxyAddr, socksAddr string) (relayConfig, error) {
	var cfg relayConfig
	raw := os.Getenv(envTunnelURL)
	if raw == "" {
		return cfg, fmt.Errorf("%s is required", envTunnelURL)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return cfg, fmt.Errorf("%s: %w", envTunnelURL, err)
	}
	switch u.Scheme {
	case "http", "ws":
		u.Scheme = "ws"
	case "https", "wss":
		u.Scheme = "wss"
	default:
		return cfg, fmt.Errorf("%s must be http://, https://, ws:// or wss://, got %q", envTunnelURL, u.Scheme)
	}
	if u.Host == "" || u.Path == "" {
		return cfg, fmt.Errorf("%s must include host and path (d073 §7)", envTunnelURL)
	}
	cfg.tunnelURL = u
	cfg.token = os.Getenv(envOperatorToken)
	cfg.label = os.Getenv(envClientLabel)
	cfg.proxyAddr = proxyAddr
	cfg.socksAddr = socksAddr
	// The chain env is read HERE, with the rest of the one config path:
	// bad proxy config must refuse startup before any bind (VPN-R26).
	cfg.chain, err = relayChainFromEnv(u)
	if err != nil {
		return relayConfig{}, err
	}
	return cfg, nil
}

// validate enforces the pre-bind invariants. Callers must treat an error as
// fatal: binding the listeners without a working credential would expose a
// proxy surface whose every request fails anyway (VPN-R26 fail-closed).
func (cfg *relayConfig) validate() error {
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
			host = "relay"
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

// relayNode owns the listeners and the health surface (VPN-R27).
type relayNode struct {
	cfg      relayConfig
	sessions atomic.Int64 // established tunnels (diagnostic, VPN-R27)
	lastErr  atomic.Value // string: last tunnel failure, for /healthz
}

// tunnelDial is the one TCP leg every carrier's dial rides (docs/d094):
// direct in the ordinary deployment, through the chain proxy when one is
// configured — one route, one spelling, no per-transport discretion.
func (c *relayNode) tunnelDial() dialFunc {
	if c.cfg.chain != nil {
		return c.cfg.chain.dial
	}
	return directDial
}

func (c *relayNode) noteError(err error) {
	msg := err.Error()
	if len(msg) > 200 {
		msg = msg[:200]
	}
	c.lastErr.Store(msg)
}

// runRelayNode binds the loopback listeners and serves until ctx is done.
func runRelayNode(ctx context.Context, cfg relayConfig) error {
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
	c := &relayNode{cfg: cfg}
	// The log shows WHICH tunnel endpoint (host only): the path embeds the
	// capability prefix, which must not land in any log (VPN-R44).
	// The log shows WHICH carriers are on offer (d077 §4): the ladder is
	// constant (docs/d093), so this line states a fact, not a config.
	log.Printf("[vpn-relay] listeners http=%s socks5=%s tunnel=%s://%s modes=%s",
		proxyLn.Addr(), socksLn.Addr(), cfg.tunnelURL.Scheme, cfg.tunnelURL.Host, transportOffer)
	if cfg.chain != nil {
		// Host only — userinfo in a proxy URL is a credential (VPN-R44's
		// law applied to the chain, docs/d094).
		log.Printf("[vpn-relay] chain proxy kind=%s host=%s (docs/d094)", cfg.chain.kind, cfg.chain.host())
		if cfg.tunnelURL.Scheme != "wss" {
			// Accepted, loudly (docs/d094 §3): ws:// already puts the
			// bearer in front of every on-path observer, and the chain
			// proxy is exactly that — a blind tunnel, not a reader.
			log.Printf("[vpn-relay] WARNING: chained cleartext tunnel (%s) — the chain proxy can record the operator token (docs/d094)", cfg.tunnelURL.Scheme)
		}
	}

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

// connectRejectedError carries the exit node's CONNECT_ERR reason so each
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
// transportOffer is the full transport ladder, in rank order (docs/d077
// §4). It is deliberately a constant: mode selection is the relay node's
// per-dial ranking of what the endpoint actually offers, and an operator
// override could only ever degrade the ladder — the -modes/MODES knob
// retired with docs/d093.
const transportOffer = "cde"

// dialTransport chooses the session's carrier from what the endpoint
// actually supports (docs/d077 §4, "negotiation, not path"): the whole
// ladder is offered — the constant transportOffer (docs/d093) — ALPN
// decides h2 versus http/1.1, the upgrade probe separates D from E, and a
// mode that fails routes around to the next built mode as if it were
// censorship (d081's amendment: E is the floor, so a refused upgrade is no
// longer "no mode left" — it demotes). The fallback never retries in a way
// that would reveal intent, and with nothing left it fails closed
// (VPN-R26).
func (c *relayNode) dialTransport(ctx context.Context) (tunnelStream, error) {
	var attempts []string
	var cErr error
	record := func(mode string, err error) {
		attempts = append(attempts, fmt.Sprintf("%s: %v", mode, err))
	}
	dial := c.tunnelDial()
	proto, err := alpnNegotiate(ctx, c.cfg.tunnelURL, []string{"h2", "http/1.1"}, dial)
	if err == nil && proto == "h2" {
		s, err := c.openPOST(ctx)
		if err == nil {
			log.Printf("[vpn-relay] tunnel transport=%s", s.transport())
			return s, nil
		}
		record("mode C", err)
		cErr = err
	} else if err != nil {
		// The ALPN probe itself failed (TLS refused, host down): D and E
		// share the same endpoint, so recording it costs nothing and the
		// composite error below stays honest about what was tried.
		record("mode C ALPN", err)
	}
	// No h2 landed is the ordinary h1 case — or a cleartext plane, where
	// the C rung is unreachable — mode D below, logged by its own
	// transport= line. A failed POST is worth saying out loud: it means
	// the edge answered h2 but not the session (d077 §4 — route around
	// it as if it were censorship).
	if cErr != nil {
		log.Printf("[vpn-relay] mode C failed (%v), falling back to mode D", cErr)
	}
	hdr := make(http.Header)
	hdr.Set("Authorization", "Bearer "+c.cfg.token)
	ws, err := wsDial(ctx, c.cfg.tunnelURL, hdr, dial)
	if err == nil {
		log.Printf("[vpn-relay] tunnel transport=%s", ws.transport())
		return ws, nil
	}
	record("mode D", err)
	log.Printf("[vpn-relay] mode D failed (%v), falling back to mode E", err)
	s, err := c.openExchange(ctx)
	if err == nil {
		log.Printf("[vpn-relay] tunnel transport=%s", s.transport())
		return s, nil
	}
	record("mode E", err)
	if len(attempts) == 1 {
		return nil, errors.New(attempts[0])
	}
	return nil, fmt.Errorf("no offered mode survived (fail-closed VPN-R26): %s",
		strings.Join(attempts, "; "))
}

func (c *relayNode) openTunnel(ctx context.Context, target string) (tunnelStream, error) {
	s, err := c.dialTransport(ctx)
	if err != nil {
		err = fmt.Errorf("tunnel dial: %w", err)
		c.noteError(err)
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			_ = s.Close()
		}
	}()

	_ = s.setReadDeadline(time.Now().Add(tunnelHandshakeTimeout))
	hello, err := encodeHello(c.cfg.label)
	if err != nil {
		c.noteError(err)
		return nil, err
	}
	if err := sendFrame(s, frameHello, hello); err != nil {
		c.noteError(err)
		return nil, err
	}
	msg, err := readTunnelFrame(s)
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

	if err := sendFrame(s, frameConnect, []byte(target)); err != nil {
		c.noteError(err)
		return nil, err
	}
	msg, err = readTunnelFrame(s)
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
	_ = s.setReadDeadline(time.Time{})
	c.sessions.Add(1)
	ok = true
	return s, nil
}

// ---------------------------------------------------------------------------
// HTTP CONNECT listener (VPN-R24)
// ---------------------------------------------------------------------------

// ServeHTTP multiplexes the two loopback surfaces. The 405 for everything
// else is deliberate (no camouflage contract on loopback): this surface is
// a byte pump, so it never parses absolute-form requests — and the v2 host
// allowlist must NOT grow onto it; mode-A-only by decision (docs/d080).
func (c *relayNode) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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
func (c *relayNode) handleHealth(w http.ResponseWriter, r *http.Request) {
	last, _ := c.lastErr.Load().(string)
	status := map[string]any{
		"status":   "ok",
		"tunnel":   c.cfg.tunnelURL.Scheme + "://" + c.cfg.tunnelURL.Host,
		"sessions": c.sessions.Load(),
	}
	if c.cfg.chain != nil {
		status["chain"] = c.cfg.chain.kind + "://" + c.cfg.chain.host()
	}
	if last != "" {
		status["last_error"] = last
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(status)
}

func (c *relayNode) handleConnect(w http.ResponseWriter, r *http.Request) {
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
// server requests; the URL forms cover quirks of older HTTP clients).
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

func (c *relayNode) serveSOCKS(ln net.Listener) {
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
// unresolved; IP literals are refused because the exit node resolves
// (VPN-R22 — one resolution path, one place the pin happens).
func (c *relayNode) handleSOCKS(conn net.Conn) {
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
		socksReply(conn, 0x08) // exit-node-side resolution only (VPN-R22)
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
