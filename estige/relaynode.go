// relaynode.go — the relay node (docs/d088; installed as
// estige-relay.service or the Termux runit service since the packaging change
// retired the POSIX launchers): the loopback-only local proxy
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
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	// store is the v5 identity and its paired exit. The token field stays
	// only for the old boot-time shape check; it never reaches the wire.
	store     *relayStore
	peerName  string
	selfDER   []byte
	proxyAddr string      // HTTP CONNECT listener (must be loopback, VPN-R23)
	socksAddr string      // SOCKS5 listener (must be loopback, VPN-R23)
	chain     *chainProxy // optional upstream chain for the tunnel leg (docs/d094)
	// legacyIPRelay is the relay half of the IP-exit switch (d163): off,
	// every address target dies at the local doors before a tunnel exists;
	// on, the address is handed over and the exit's verdict answers.
	legacyIPRelay bool
	// insecureExit is docs/d171's one switch for both degraded relay->exit
	// postures: skip certificate verification and accept a cleartext
	// tunnel URL. Off means https/wss verifies and ws:// is refused at
	// config time, before any listener binds.
	insecureExit bool
	// forwards is the -L listener set (docs/d144), parsed from argv by
	// main before this config is built. Empty means no forwarding.
	forwards []forwardSpec
}

// channelHeaders mints one fresh blind token and pins the paired exit's
// certificate for one HTTP exchange.
func (c *relayConfig) channelHeaders() (http.Header, error) {
	if c.store == nil {
		return nil, errors.New("v5 store is not loaded")
	}
	return channelRequestHeaders(c.store.Private, c.store.Principal, c.peerName, c.selfDER)
}

// h2Posture values: the zero value is "not yet discovered".
const (
	h2PostureUnknown int32 = iota
	h2PostureUnbounded
	h2PostureWindowed
)

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
func relayConfigFromEnv(proxyAddr, socksAddr string, legacyIPRelay, insecureExit bool) (relayConfig, error) {
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
	// WHY: net/http turns URL userinfo into an Authorization header of its
	// own, so a URL with credentials would make the exit see two — one the
	// operator typed and one we minted. The credential has one spelling
	// (VPN_OPERATOR_TOKEN) and the URL carries none.
	if u.User != nil {
		return cfg, fmt.Errorf("%s must not carry credentials; the token has its own variable (%s)", envTunnelURL, envOperatorToken)
	}
	store, err := loadRelayStore(storeRoot())
	if err != nil {
		return cfg, fmt.Errorf("v5 store: %w", err)
	}
	cfg.store = store
	cfg.peerName = store.Exits[0].Name
	cfg.selfDER = store.SelfDER
	cfg.tunnelURL = u
	cfg.token = os.Getenv(envOperatorToken)
	cfg.label = os.Getenv(envClientLabel)
	cfg.proxyAddr = proxyAddr
	cfg.socksAddr = socksAddr
	cfg.legacyIPRelay = legacyIPRelay
	cfg.insecureExit = insecureExit
	// docs/d171: a cleartext tunnel leg is a degraded posture, legal only
	// under the switch. Refusing here — before any bind — is VPN-R26's
	// fail-closed shape, and it closes the loophole where ws:// was
	// accepted with no warning unless a chain proxy happened to be set.
	if cfg.tunnelURL.Scheme == schemeWS && !insecureExit {
		return relayConfig{}, fmt.Errorf("%s names a cleartext ws:// tunnel; start the relay with -insecure-exit to accept it (docs/d171)", envTunnelURL)
	}
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
func (c *relayConfig) validate() error {
	if c.token == "" {
		return fmt.Errorf("no operator token configured; refusing to start (%s)", envOperatorToken)
	}
	// The relay is the side that WRITES this token into a header — websocket's
	// hand-rolled handshake interpolates it with fmt.Fprintf (websocket.go
	// wsDial), so a CR/LF here would inject headers into our own request.
	// The length floor and the control-character refusal are the same rule the
	// exit applies to its key set (validOperatorToken, VPN-R26 fail-closed).
	if !validOperatorToken(c.token) {
		return fmt.Errorf("operator token must be at least 16 bytes and free of control characters — a credential may not carry header framing (%s; VPN-R26 fail-closed)", envOperatorToken)
	}
	if c.tunnelURL == nil {
		return fmt.Errorf("no tunnel URL configured (%s)", envTunnelURL)
	}
	for what, addr := range map[string]string{"http proxy": c.proxyAddr, schemeSOCKS5: c.socksAddr} {
		if err := requireLoopback(addr); err != nil {
			return fmt.Errorf("%s listener: %w", what, err)
		}
	}
	if c.label == "" {
		host, err := os.Hostname()
		if err != nil || host == "" {
			host = "relay"
		}
		c.label = host
	}
	// The label rides the HELLO and lands in this node's and the exit's log
	// records, so its shape is checked where every other wire string is
	// (tunnelproto.go) rather than only for length here.
	if !validTunnelLabel(c.label) {
		return fmt.Errorf("client label must be 0..%d printable ASCII characters (%s)", tunnelLabelMax, envClientLabel)
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
	cfg     relayConfig
	live    liveRegistry // in-flight tunnels (docs/d106: state, not a lifetime total)
	lastErr atomic.Value // string: last tunnel failure, for /healthz
	// h2Posture is what the exit's edge port has taught this process about
	// h2-post-unbounded (docs/d222): unknown until the first dial, then
	// unbounded or windowed. It is the relay's whole per-edge configuration —
	// the exit's port role is the fact, and one refusal is the discovery.
	h2Posture atomic.Int32
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
	c := &relayNode{cfg: cfg, live: newLiveRegistry()}
	// The log shows WHICH tunnel endpoint (host only): the path embeds the
	// capability prefix, which must not land in any log (VPN-R44).
	// The log shows WHICH carriers are on offer (d077 §4): the ladder is
	// constant (docs/d093), so this line states a fact, not a config. The
	// exit's edge port decides the h2 half at the first dial (docs/d222).
	logLine(sevInfo, "[vpn-relay] listeners http=%s socks5=%s tunnel=%s://%s carriers=%s",
		proxyLn.Addr(), socksLn.Addr(), cfg.tunnelURL.Scheme, cfg.tunnelURL.Host, carrierOffer)
	if cfg.chain != nil {
		// Host only — userinfo in a proxy URL is a credential (VPN-R44's
		// law applied to the chain, docs/d094).
		logLine(sevInfo, "[vpn-relay] chain proxy kind=%s host=%s (docs/d094)", cfg.chain.kind, cfg.chain.host())
	}
	if cfg.insecureExit {
		// docs/d171: one warning naming the posture and pointing at the
		// exposure table; the per-generation cost is d171's, not restated.
		logLine(sevWarn, "[vpn-relay] DEGRADED: -insecure-exit is set — certificate verification is skipped and a cleartext ws:// tunnel is accepted; the bearer is exposed to whoever terminates the leg (docs/d171)")
	}

	forwardLns, err := c.bindForwards(ctx, cfg.forwards)
	if err != nil {
		_ = proxyLn.Close()
		_ = socksLn.Close()
		return err
	}
	httpSrv := &http.Server{
		Handler:           c,
		ReadHeaderTimeout: 30 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- httpSrv.Serve(proxyLn) }()
	go c.serveSOCKS(ctx, socksLn)
	for i, spec := range cfg.forwards {
		go c.serveForward(ctx, forwardLns[i], spec)
	}

	select {
	case <-ctx.Done():
		// Drain rather than kill (docs/d171's rotation primitive): a
		// restart is how a v3 bearer rotates, and truncating every live
		// response to rotate a token is a choice, not a requirement.
		logLine(sevInfo, "[vpn-relay] signal received; draining %d live tunnel(s) (grace %s)", c.live.count(), drainGrace)
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), drainGrace)
		defer cancel()
		_ = socksLn.Close()
		for _, ln := range forwardLns {
			_ = ln.Close()
		}
		go func() { _ = httpSrv.Shutdown(shutdownCtx) }()
		// Hijacked CONNECT sessions are not net/http handlers; the registry
		// is the real wait (docs/d106).
		drainLive(&c.live, drainGrace)
		<-time.After(200 * time.Millisecond)
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

// tunnelErrReason is the refusal token the records carry: the exit's
// CONNECT_ERR vocabulary when the peer refused, and the local dial class
// otherwise, so the log line and the app's problem body agree (docs/d106).
func tunnelErrReason(err error) string {
	if rej, ok := errors.AsType[*connectRejectedError](err); ok {
		return rej.reason
	}
	return errReasonDial
}

// refusedRecord is one admission failure at the relay, in d106's vocabulary.
func (c *relayNode) refusedRecord(target, via, url, reason string) {
	sessionRecord{
		Role: roleRelay, Event: eventRefused, Label: c.cfg.label,
		Via: via, Target: target, URL: url, Reason: reason,
	}.emit()
}

// beginRelaySession registers an admitted tunnel for the open/close records
// and the status surface. The finish func emits the close from the live
// counters, so both the pump and the cleartext exchange report the same way.
func (c *relayNode) beginRelaySession(s tunnelStream, target, via, url string) (*liveSession, func(string)) {
	start := time.Now()
	live := &liveSession{
		id: s.sessionID(), label: c.cfg.label, via: via, target: target,
		transport: s.transport(), start: start, stream: s,
	}
	c.live.register(live)
	identity := sessionRecord{
		Role: roleRelay, ID: live.id, Label: live.label, Via: via,
		Transport: live.transport, Target: target, URL: url,
	}
	open := identity
	open.Event = eventOpen
	open.emit()
	return live, func(outcome string) {
		c.live.unregister(live)
		closeRec := identity
		closeRec.Event = eventClose
		closeRec.Outcome = outcome
		closeRec.Up = live.up.Load()
		closeRec.Down = live.down.Load()
		closeRec.Duration = time.Since(start).Milliseconds()
		closeRec.emit()
	}
}

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
// carrierOffer is the full ladder in rank order (docs/d077 §4), spelled
// with carrier names (d105) rather than letters. It is deliberately a
// constant: selection is the relay node's per-dial ranking of what the
// endpoint actually offers, and an operator override could only ever degrade
// the ladder — the -modes/MODES knob retired with docs/d093.
const carrierOffer = "h2-post-unbounded, websocket, h2-post-windowed, h1.1-post-windowed"

// dialTransport chooses the session's carrier from what the endpoint
// actually supports (docs/d077 §4, "negotiation, not path"): the ladder is
// constant (docs/d093) — ALPN decides h2 versus http/1.1, the upgrade probe
// separates the WebSocket from the h1.1 windows, and a carrier that fails
// routes around to the next built one as if it were censorship. The fallback
// never retries in a way that would reveal intent, and with nothing left it
// fails closed (VPN-R26).
//
// The h2 half is learned, not configured (docs/d222): the relay offers
// h2-post-unbounded first, and an exit port serving a capped edge refuses it
// at request initiation. One refusal switches this process to the order
// websocket → h2-post-windowed → h1.1-post-windowed, and the posture is
// remembered so later CONNECTs pay nothing. An uncapped edge never refuses,
// so it keeps the lowest-overhead carrier first.
func (c *relayNode) dialTransport(ctx context.Context, id string) (tunnelStream, error) {
	var attempts []string
	record := func(carrier string, err error) {
		attempts = append(attempts, fmt.Sprintf("%s: %v", carrier, err))
	}
	posture := c.h2Posture.Load()
	if posture != h2PostureWindowed {
		s, err := c.openH2Carrier(ctx, id, false)
		if err == nil {
			c.h2Posture.Store(h2PostureUnbounded)
			logLine(sevInfo, "[vpn-relay] tunnel carrier=%s", s.transport())
			return s, nil
		}
		record(carrierH2Unbounded, err)
		if errors.Is(err, errUnboundedRefused) {
			c.h2Posture.Store(h2PostureWindowed)
			logLine(sevInfo, "[vpn-relay] the exit refused h2-post-unbounded at request initiation; this edge port uses the windowed carriers")
		} else {
			logLine(sevWarn, "[vpn-relay] h2-post-unbounded failed (%v); trying websocket", err)
		}
	}
	ws, err := c.openWebSocket(ctx, id)
	if err == nil {
		logLine(sevInfo, "[vpn-relay] tunnel carrier=%s", ws.transport())
		return ws, nil
	}
	record(carrierWebSocket, err)
	logLine(sevWarn, "[vpn-relay] websocket failed (%v); trying h2-post-windowed", err)

	s, err := c.openH2Carrier(ctx, id, true)
	if err == nil {
		logLine(sevInfo, "[vpn-relay] tunnel carrier=%s", s.transport())
		return s, nil
	}
	record(carrierH2Windowed, err)
	logLine(sevWarn, "[vpn-relay] h2-post-windowed failed (%v); trying h1.1-post-windowed", err)

	s, err = c.openH1Windowed(ctx, id, c.cfg.insecureExit)
	if err == nil {
		logLine(sevInfo, "[vpn-relay] tunnel carrier=%s", s.transport())
		return s, nil
	}
	record(carrierH1Windowed, err)
	if len(attempts) == 1 {
		return nil, errors.New(attempts[0])
	}
	return nil, fmt.Errorf("no offered carrier survived (fail-closed VPN-R26): %s",
		strings.Join(attempts, "; "))
}

// openH2Carrier probes ALPN and opens one of the h2 POST carriers. The probe
// is one TLS handshake the session does not reuse — the carriers dial fresh,
// as d077 §4 requires for carrier selection.
func (c *relayNode) openH2Carrier(ctx context.Context, id string, windowed bool) (tunnelStream, error) {
	proto, err := alpnNegotiate(ctx, c.cfg.tunnelURL, []string{"h2", protoHTTP11}, c.tunnelDial(), c.cfg.insecureExit)
	if err != nil {
		return nil, fmt.Errorf("ALPN probe: %w", err)
	}
	if proto != "h2" {
		return nil, fmt.Errorf("h2 not offered (ALPN %q)", proto)
	}
	if windowed {
		return c.openH2Windowed(ctx, id, c.cfg.insecureExit)
	}
	return c.openH2Unbounded(ctx, id, c.cfg.insecureExit)
}

// openWebSocket is the WebSocket rung, extracted so every ladder shares one
// handshake spelling.
func (c *relayNode) openWebSocket(ctx context.Context, id string) (tunnelStream, error) {
	hdr, err := c.cfg.channelHeaders()
	if err != nil {
		return nil, err
	}
	hdr.Set(sessionIDHeader, id)
	return wsDial(ctx, c.cfg.tunnelURL, hdr, c.tunnelDial(), c.cfg.insecureExit)
}

func (c *relayNode) openTunnel(ctx context.Context, target string) (tunnelStream, error) {
	// One id per app connection: the demotion ladder's attempts and the
	// carrier that finally wins share it (docs/d106).
	id, err := newSessionID()
	if err != nil {
		return nil, err
	}
	s, err := c.dialTransport(ctx, id)
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

	if s.transport() == carrierH2Unbounded || s.transport() == carrierWebSocket {
		local := tls.Certificate{Certificate: [][]byte{c.cfg.selfDER}, PrivateKey: c.cfg.store.Private}
		conn, err := clientChannelHandshake(ctx, s, local, c.cfg.store.Exits[0].Cert)
		if err != nil {
			logLine(sevWarn, "[vpn-relay] inner handshake failed on %s: %v", s.transport(), err)
			c.noteError(err)
			return nil, err
		}
		s = newTLSTunnelStream(conn, s)
	}

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
		"status":    "ok",
		"tunnel":    c.cfg.tunnelURL.Scheme + "://" + c.cfg.tunnelURL.Host,
		"sessions":  c.live.count(),
		"in_flight": c.live.snapshot(),
		"degraded":  c.cfg.insecureExit,
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
		logLine(sevWarn, "[vpn-relay] health response encode: %v", encErr)
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
		c.refusedRecord(target, viaConnect, "", errReasonInvalid)
		writeProblem(w, r, http.StatusBadRequest, "bad-connect-target",
			"CONNECT target must be host:port", err)
		return
	}
	// The relay's own gate (d163) runs before a tunnel exists: a target
	// this relay must not relay dies here, in the local problem vocabulary,
	// and no session opens on the exit for it.
	if detail, _ := c.localTargetRefusal(host); detail != "" {
		c.refusedRecord(target, viaConnect, "connect://"+target, errReasonBogon)
		writeProblem(w, r, http.StatusForbidden, "target-refused",
			"This relay refuses that target", errors.New(detail))
		return
	}
	ws, err := c.openTunnel(r.Context(), target)
	if err != nil {
		status, code, title := httpStatusForTunnelErr(err)
		c.refusedRecord(target, viaConnect, "connect://"+target, tunnelErrReason(err))
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
	// docs/d171's guard wraps the blind door while the switch is on: the
	// first client bytes are classified, and an HTTP request line closes the
	// tunnel instead of forwarding a cleartext HTTP service.
	var guard *degradedGuard
	if c.cfg.insecureExit {
		guard = newDegradedGuard(conn, c, target, viaConnect)
		conn = guard
	}
	// An application that pipelined bytes onto the same segment as its
	// CONNECT request already has them in the hijack buffer; they are part
	// of the tunnel stream and must not be dropped before the relay starts
	// reading the raw socket.
	if n := brw.Reader.Buffered(); n > 0 {
		early, _ := brw.Peek(n)
		if guard != nil && guard.checkEarly(early) {
			_ = ws.Close()
			return
		}
		if err := sendFrame(ws, frameData, early); err != nil {
			_ = conn.Close()
			_ = ws.Close()
			return
		}
	}
	live, finish := c.beginRelaySession(ws, target, viaConnect, "connect://"+target)
	stats, _ := relay(ws, conn, live)
	finish(stats.outcome)
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
		c.refusedRecord(host, viaSOCKS, "", errReasonBogon)
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
		c.refusedRecord(target, viaSOCKS, "", tunnelErrReason(err))
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
	// docs/d171's guard on the second blind door: same first-bytes
	// classification as CONNECT, and the same narrowness.
	appConn := conn
	if c.cfg.insecureExit {
		appConn = newDegradedGuard(conn, c, target, viaSOCKS)
	}
	live, finish := c.beginRelaySession(ws, target, viaSOCKS, "")
	stats, _ := relay(ws, appConn, live)
	finish(stats.outcome)
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
