// relaynode.go — the relay node (docs/d088; installed as
// estige-relay.service or the Termux runit service since the packaging change
// retired the POSIX launchers), modes C–E: the loopback-only local proxy
// feeding one authenticated tunnel
// (docs/d073 §7: VPN-R23..R27, §5.1: VPN-R11).
//
// WHY the relay node never terminates TLS (VPN-R25): TLS payloads are
// byte pumped between a loopback socket and the tunnel — the application's
// TLS handshake passes through untouched and lands on the target's own
// certificate, verified by the application itself (VPN-R29). The one
// payload class the relay does parse is cleartext http/ws at the loopback
// surface (forward.go, docs/d103): there is no TLS in it to pass through.
// Nothing here may grow a "trust the proxy" or certificate-parsing feature
// for the classes that DO carry TLS — the relay holds no certificate for
// any target and validates none (VPN-R25's fence, d103's terms).
//
// Fail-closed is structural (VPN-R26): no credential or unparsable config
// means runRelayNode returns BEFORE binding any listener, every tunnel use
// — CONNECT, the SOCKS command, the cleartext forward — opens the tunnel
// first (no surface has a code path that dials the target directly), and a
// refused tunnel answers the application locally — the kill switch is the
// only behavior.
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
	"slices"
	"strconv"
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
	// legacyIPRelay is the relay half of the IP-exit switch (d163): off,
	// every address target dies at the local doors before a tunnel exists;
	// on, the address is handed over and the exit's verdict answers.
	legacyIPRelay bool
}

// relayConfigFromEnv assembles the config from the flag values and the
// environment. Nothing else may configure the relay node (one path, no
// scattered defaults — d072's lesson applied).
//
// VPN_TUNNEL_URL is accepted in the URL's honest wire form (http/https/
// ws/wss) and normalized here — the one place — to the canonical ws/wss
// every carrier and probe branches on; each carrier rewrites to its own
// wire scheme itself (docs/d090 §1).
//
// legacyIPRelay rides as a parameter rather than the environment because it
// is argv — the same side of the ledger as d145's relay-side flags, and a
// switch this load-bearing must be visible in the process's own command
// line (d163).
func relayConfigFromEnv(proxyAddr, socksAddr string, legacyIPRelay bool) (relayConfig, error) {
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
	case schemeHTTP, schemeWS:
		u.Scheme = schemeWS
	case schemeHTTPS, schemeWSS:
		u.Scheme = schemeWSS
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
	cfg.legacyIPRelay = legacyIPRelay
	// The chain env is read HERE, with the rest of the one config path:
	// bad proxy config must refuse startup before any bind (VPN-R26).
	cfg.chain, err = relayChainFromEnv(u)
	if err != nil {
		return relayConfig{}, err
	}
	// The chain and the listeners share one env surface: an ambient spelling
	// already naming the listener we are about to bind would dial a loop.
	// Refuse before any bind, with the old launcher's exit status (docs/d095).
	if err := refuseSelfChain(cfg.proxyAddr, cfg.socksAddr); err != nil {
		return relayConfig{}, err
	}
	return cfg, nil
}

// exitSelfChain is the launcher's documented status for a self-chained relay
// (docs/d095); the binary keeps it so callers/scripts do not need a new code.
const exitSelfChain = 94

// errSelfChained is the sentinel main maps to exitSelfChain. The relay's own
// upstream chain is read from the ambient env, so a value naming this
// process's listener is always a loop, never a legitimate upstream.
var errSelfChained = errors.New("the ambient proxy env already points at the relay's own listener — refusing to start a self-chained relay")

func refuseSelfChain(proxyAddr, socksAddr string) error {
	listeners := []string{proxyAddr, socksAddr}
	for _, name := range chainEnvVars {
		value := os.Getenv(name)
		if value == "" {
			continue
		}
		// Compare as ADDRESSES, not as text: `http://localhost:3128`,
		// `http://127.0.0.1:3128`, `http://[::1]:3128` and the scheme-less
		// spellings all name a listener we are about to bind, while a
		// substring test sees none of them collide with `127.0.0.1:3128`.
		// A missed collision is a self-chained relay: a proxy loop that spins
		// the tunnel dial against itself (docs/d095).
		for _, listener := range listeners {
			if proxyValueNamesListener(name, value, listener) {
				// Never echo value: a proxy URL may carry credentials.
				return fmt.Errorf("%w (%s names this listener; http=%q, socks=%q)", errSelfChained, name, proxyAddr, socksAddr)
			}
		}
	}
	return nil
}

// proxyValueNamesListener reports whether one chain env value addresses the
// given listener. The value goes through parseChainProxy — the same parser the
// dialer uses — so the check cannot disagree with what would actually be
// dialed, including the scheme-less spellings each variable family defaults.
func proxyValueNamesListener(envName, value, listener string) bool {
	chain, err := parseChainProxy(normalizeProxyValue(envName, value))
	if err != nil {
		// An unparseable value is not a chain at all; the dialer refuses it
		// later with a message that names the real problem.
		return false
	}
	wantHost, wantPort, err := net.SplitHostPort(listener)
	if err != nil {
		return false
	}
	gotHost, gotPort, err := net.SplitHostPort(chain.addr)
	if err != nil {
		return false
	}
	// Ports and destinations must both match. IPv4 and IPv6 loopback are
	// deliberately NOT collapsed into one another: a listener bound to
	// 127.0.0.1:3128 and a chain to [::1]:3128 are different sockets, so
	// treating them as a self-chain would refuse a legitimate configuration.
	// Only the `localhost` alias is collapsed, because the resolver is what
	// makes it ambiguous — see loopbackAddr.
	return gotPort == wantPort && sameDestination(gotHost, wantHost)
}

// normalizeProxyValue applies the defaults relayChainFromEnv applies, so the
// self-chain check sees the value the dialer would see: SOCKS_* values are a
// bare host:port (libproxy/GNOME convention) and everything else follows
// curl's scheme-less-means-http rule.
func normalizeProxyValue(envName, value string) string {
	if strings.Contains(value, "://") {
		return value
	}
	// The variable's own convention picks the scheme, exactly as
	// relayChainFromEnv does: SOCKS_SERVER is a bare host:port (libproxy/
	// GNOME), everything else follows curl's scheme-less-means-http rule.
	// Without this the socks port default (1080) would never be applied and a
	// bare `localhost:1080` would read as an http:// chain on port 1080.
	if strings.HasPrefix(strings.ToUpper(envName), "SOCKS_SERVER") {
		return "socks5://" + value
	}
	return "http://" + value
}

// sameDestination compares two host spellings a listener could be reached
// under. Only the `localhost` alias is collapsed onto an address; two literal
// loopback addresses are compared as themselves.
func sameDestination(a, b string) bool {
	if a == b {
		return true
	}
	aAddr, aErr := loopbackHost(a)
	bAddr, bErr := loopbackHost(b)
	if aErr == nil && bErr == nil {
		return aAddr == bAddr
	}
	// DNS names are case-insensitive.
	return strings.EqualFold(a, b)
}

// loopbackHost resolves the one host spelling that is an alias rather than an
// address. `localhost` maps to IPv4 loopback explicitly instead of consulting
// the resolver: estige must not let a hosts-file or resolver rewrite decide
// whether its own listener is self-chained, and 127.0.0.1 is what a
// `localhost` listener binds in the configuration this guards.
func loopbackHost(host string) (netip.Addr, error) {
	if strings.EqualFold(host, "localhost") {
		return netip.MustParseAddr("127.0.0.1"), nil
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, err
	}
	return addr.Unmap(), nil
}

// validate enforces the pre-bind invariants. Callers must treat an error as
// fatal: binding the listeners without a working credential would expose a
// proxy surface whose every request fails anyway (VPN-R26 fail-closed).
func (cfg *relayConfig) validate() error {
	if cfg.token == "" {
		return fmt.Errorf("no operator token configured; refusing to start (%s)", envOperatorToken)
	}
	// The relay is the side that WRITES this token into a header — mode D's
	// hand-rolled handshake interpolates it with fmt.Fprintf (websocket.go
	// wsDial), so a CR/LF here would inject headers into our own request.
	// The length floor and the control-character refusal are the same rule the
	// exit applies to its key set (validOperatorToken, VPN-R26 fail-closed).
	if !validOperatorToken(cfg.token) {
		return fmt.Errorf("operator token must be at least 16 bytes and free of control characters — a credential may not carry header framing (%s; VPN-R26 fail-closed)", envOperatorToken)
	}
	if cfg.tunnelURL == nil {
		return fmt.Errorf("no tunnel URL configured (%s)", envTunnelURL)
	}
	for what, addr := range map[string]string{"http proxy": cfg.proxyAddr, schemeSOCKS5: cfg.socksAddr} {
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
	if host == localhostName {
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
	var lc net.ListenConfig
	proxyLn, err := lc.Listen(ctx, "tcp", cfg.proxyAddr)
	if err != nil {
		return fmt.Errorf("http proxy listen: %w", err)
	}
	socksLn, err := lc.Listen(ctx, "tcp", cfg.socksAddr)
	if err != nil {
		_ = proxyLn.Close()
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
		if cfg.tunnelURL.Scheme != schemeWSS {
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
	go c.serveSOCKS(ctx, socksLn)

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
	case errReasonDenied, errReasonPortDenied, errReasonTargetIP, errReasonBogon:
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
	proto, err := alpnNegotiate(ctx, c.cfg.tunnelURL, []string{"h2", protoHTTP11}, dial)
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

// ServeHTTP multiplexes the loopback surface: CONNECT tunnels (the byte
// pump), d103's cleartext forward branch, and health — the 405 for
// everything else stays deliberate (no camouflage contract on loopback).
// https/wss absolute-form requests fall through to it on purpose: those
// still ride CONNECT as opaque bytes (VPN-R25), and no branch consults a
// host set — mode-A-only by decision (docs/d080 as narrowed by d103).
func (c *relayNode) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodConnect:
		c.handleConnect(w, r)
	case r.URL.IsAbs() && (r.URL.Scheme == schemeHTTP || r.URL.Scheme == schemeWS):
		c.handleForward(w, r)
	// Health is this surface's own origin-form endpoint; an absolute-form
	// request is an address, not a question about the relay (d103).
	case r.Method == http.MethodGet && !r.URL.IsAbs() && r.URL.Path == healthPath:
		c.handleHealth(w, r)
	default:
		w.Header().Set("Allow", "CONNECT, GET /healthz")
		writeProblem(w, r, http.StatusMethodNotAllowed, "method-not-allowed",
			"This loopback port accepts only CONNECT tunnels and "+healthPath, errors.New("method not allowed"))
	}
}

// handleHealth is VPN-R27: a local, non-secret status surface — tunnel
// endpoint (host only), session count, last failure. Never the credential.
func (c *relayNode) handleHealth(w http.ResponseWriter, _ *http.Request) {
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
	if encErr := json.NewEncoder(w).Encode(status); encErr != nil {
		log.Printf("[vpn-relay] health response encode: %v", encErr)
	}
}

// localTargetRefusal is the relay's own target gate (d163): what it refuses
// itself, before a tunnel exists, and the SOCKS reply byte that refusal is
// worth. ("", 0) means the target may be handed to the tunnel, where the
// exit's verdict answers the rest. The codes keep their meanings: 0x02 is a
// refusal no switch re-enables — the guarantee answers first here exactly as
// it does at the exit — and 0x08 is VPN-R22's byte-identical refusal of the
// address form that -legacy-ip-relay could admit.
func (c *relayNode) localTargetRefusal(host string) (detail string, socksRep byte) {
	if isBogonName(host) {
		return "target " + host + " is a guaranteed-refused name (localhost and .localhost, d163)", 0x02
	}
	if addr, ok := parseIPLiteral(host); ok {
		if isGuaranteedBogon(addr) {
			return "target " + addr.String() + " is a guaranteed-bogon address (d163)", 0x02
		}
		if !c.cfg.legacyIPRelay {
			return "this relay does not relay address targets (start it with -legacy-ip-relay, d163)", 0x08
		}
	}
	return "", 0
}

func (c *relayNode) handleConnect(w http.ResponseWriter, r *http.Request) {
	target := connectTarget(r)
	host, _, err := splitConnectTarget(target)
	if err != nil {
		// No port means no protocol target (VPN-R21's ports are explicit);
		// this is the application's mistake, not a tunnel failure.
		writeProblem(w, r, http.StatusBadRequest, "bad-connect-target",
			"CONNECT target must be host:port", err)
		return
	}
	// The relay's own gate (d163) runs before a tunnel exists: a target
	// this relay must not relay dies here, in the local problem vocabulary,
	// and no session opens on the exit for it.
	if detail, _ := c.localTargetRefusal(host); detail != "" {
		writeProblem(w, r, http.StatusForbidden, "target-refused",
			"This relay refuses that target", errors.New(detail))
		return
	}
	ws, err := c.openTunnel(r.Context(), target)
	if err != nil {
		status, code, title := httpStatusForTunnelErr(err)
		writeProblem(w, r, status, code, title, err)
		return
	}

	conn, brw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		_ = ws.Close()
		writeProblem(w, r, http.StatusInternalServerError, "hijack-failed",
			"Could not switch protocols on the local connection", err)
		return
	}
	if _, err := brw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		_ = conn.Close()
		_ = ws.Close()
		return
	}
	if err := brw.Flush(); err != nil {
		_ = conn.Close()
		_ = ws.Close()
		return
	}
	// An application that pipelined bytes onto the same segment as its
	// CONNECT request already has them in the hijack buffer; they are part
	// of the tunnel stream and must not be dropped before the relay starts
	// reading the raw socket.
	if n := brw.Reader.Buffered(); n > 0 {
		early, _ := brw.Peek(n)
		if err := sendFrame(ws, frameData, early); err != nil {
			_ = conn.Close()
			_ = ws.Close()
			return
		}
	}
	_, _ = relay(ws, conn, tunnelKeepaliveInterval, tunnelIdleTimeout)
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
	if rej, ok := errors.AsType[*connectRejectedError](err); ok {
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

func (c *relayNode) serveSOCKS(ctx context.Context, ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return // listener closed on shutdown
		}
		go c.handleSOCKS(ctx, conn)
	}
}

// handleSOCKS speaks just enough RFC 1928: no-auth greeting (the listener
// is loopback-only, VPN-R23 — a credential check here would be theater),
// CONNECT command, domain or IP address types. Domain names pass through
// unresolved; every other target answers at localTargetRefusal (d163) —
// address targets keep VPN-R22's byte-identical 0x08 default until
// -legacy-ip-relay says otherwise, and guaranteed refusals answer first.
func (c *relayNode) handleSOCKS(ctx context.Context, conn net.Conn) {
	defer func() { _ = conn.Close() }()
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
		host = netip.AddrFrom4(b).String()
	case 4: // IPv6 literal
		var b [16]byte
		if _, err := io.ReadFull(conn, b[:]); err != nil {
			return
		}
		// As spelled, without an unmap: a v4-in-v6 address stays in the
		// mapped block where the guaranteed refusal catches it (d146).
		host = netip.AddrFrom16(b).String()
	case 3: // domain name
		var l [1]byte
		if _, err := io.ReadFull(conn, l[:]); err != nil {
			return
		}
		name := make([]byte, int(l[0]))
		if _, err := io.ReadFull(conn, name); err != nil {
			return
		}
		host = string(name)
	default:
		socksReply(conn, 0x08)
		return
	}
	// One gate for every address form, before the port bytes are read and
	// before a tunnel exists (d163).
	if detail, rep := c.localTargetRefusal(host); detail != "" {
		socksReply(conn, rep)
		return
	}
	var portBytes [2]byte
	if _, err := io.ReadFull(conn, portBytes[:]); err != nil {
		return
	}
	target := net.JoinHostPort(host, strconv.FormatUint(uint64(binary.BigEndian.Uint16(portBytes[:])), 10))

	ws, err := c.openTunnel(ctx, target)
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
	_, _ = relay(ws, conn, tunnelKeepaliveInterval, tunnelIdleTimeout)
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
	return slices.Contains(b, want)
}
