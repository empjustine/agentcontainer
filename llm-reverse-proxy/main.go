// llm-reverse-proxy — a dumb, faithful reverse proxy for LLM APIs.
//
// v2 host-allowlist routing (docs/d047): requests to
// http://<host>:<port>/<upstream-host>/<path>?<query> are forwarded, byte for
// byte, to the allowlisted upstream root configured for <upstream-host>. The
// FIRST PATH SEGMENT is the destination host (a DNS name; docs/d047 —
// llama-swap's logical alias left the generated table with docs/d070);
// everything after it rides the byte-for-byte
// passthrough, so a client addresses a provider as
// <route-base>/<host><full-upstream-base-path> (the host-form route,
// docs/d047) and the proxy single-joins the remainder onto scheme://<host>.
// Hosts NOT in
// the allowlist are denied BY ABSENCE: they answer the same plain-text 404
// as any garbage path — a catalog row can no longer mint a routable
// endpoint (the v1 slug table's inverted-allowlist problem, docs/d047).
//
// No model routing, no credential handling (callers must already carry valid
// provider keys), no request or response rewriting. Streaming responses
// (SSE, NDJSON, raw chunked) are flushed to the client as they arrive from
// upstream.
//
// Internal failures (bad gateway conditions: DNS failures, refused TCP
// connections, TLS verification problems, upstream disconnects before the
// response starts) are reported as RFC 9457 problem details with a 502 status.
// Upstream error responses (4xx/5xx from the provider) are passed through
// completely untouched.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// Tunnel environment surface (modes C–E; docs/d073 §6.3/§7): credentials
// arrive ONLY through this path — the lib/environment.sh env chain — never
// the JSON config, which would become a second, unkeyed copy of a credential.
// The roles are disjoint (docs/d090): VPN_OPERATOR_KEYS is the EXIT node's
// principal set, a JSON object {"<id>": "<token>"} (docs/d078 §2);
// VPN_OPERATOR_TOKEN is the RELAY node's bearer and is read nowhere else.
// VPN_TUNNEL_URL is the relay node's endpoint — http(s):// or ws(s)://, in
// the URL's honest wire form, normalized once in relayConfigFromEnv — and
// VPN_CLIENT_LABEL its optional identity; they identify, they do not
// authenticate. The capability PATH is none of this env's business
// (docs/d085): it is the Funnel mount's, and the edge strips it before a
// request can reach us.
const (
	envTunnelURL     = "VPN_TUNNEL_URL"
	envOperatorToken = "VPN_OPERATOR_TOKEN"
	envOperatorKeys  = "VPN_OPERATOR_KEYS"
	envClientLabel   = "VPN_CLIENT_LABEL"
)

// operatorCredentialInEnv reports whether the env chain carries an operator
// credential — the thing that arms the tunnel (docs/d084 as amended by d085:
// the credential IS the capability; config can veto or assert, never grant).
// Either variable marks the operator's INTENT to arm; which variable each
// node actually READS is enforced at enable time (docs/d090): the exit node
// refuses TOKEN-only with the migration hint, the relay node refuses in
// relayConfig.validate().
func operatorCredentialInEnv() bool {
	return os.Getenv(envOperatorToken) != "" || os.Getenv(envOperatorKeys) != ""
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type config struct {
	Listen string `json:"listen"`
	// The host allowlist (docs/d047): route key (an upstream DNS host, e.g.
	// "api.anthropic.com") → scheme://host root. The proxy never parses the
	// key as a host — it is an opaque path segment (docs/d070 retired the
	// last non-host key, llama-swap's logical alias, from the generated
	// table).
	AllowHosts map[string]string `json:"allowHosts"`

	// The tunnel namespace, modes C–E (docs/d073 §6, d077): armed by the
	// operator keyset env, not by this file (docs/d084/d085) — an unarmed
	// deployment behaves exactly as if d073 had never landed (VPN-R2). The
	// operator tokens are deliberately NOT fields here: they arrive only via
	// the environment chain (enableTunnel), because a config file on disk is
	// a second copy of a credential — and worse, an unkeyed one.
	Tunnel *tunnelConfig `json:"tunnel,omitempty"`
}

// tunnelConfig is the tunnel config data: the policy halves only. What the
// operator reviews and commits (egress) lives here; what authenticates (the
// operator keyset) never does.
//
// Enabled is tri-state on purpose (docs/d084): absent = the env decides,
// false = veto even when the env is armed, true = assert armed and let the
// boot fail loudly if the env is missing. The config can veto or assert —
// GRANTING the capability is the env chain's job (VPN-R31/R32).
type tunnelConfig struct {
	Enabled *bool        `json:"enabled,omitempty"`
	Egress  egressConfig `json:"egress,omitempty"`
}

// shouldArmTunnel resolves the boot-time arming verdict for the tunnel
// family (docs/d084). An assert with the env unarmed resolves to arm so
// enableTunnel's validation fails the boot loudly — never a silent
// degradation to mode A only.
func shouldArmTunnel(cfg *tunnelConfig, envArmed bool) bool {
	if cfg != nil && cfg.Enabled != nil {
		return *cfg.Enabled
	}
	return envArmed
}

func loadConfig(path string) (*config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return &cfg, nil
}

// ---------------------------------------------------------------------------
// Provider: parsed upstream + its ReverseProxy
// ---------------------------------------------------------------------------

// provider is one routable allowlist entry: `name` is the upstream HOST
// (the allowHosts key — a DNS name or host:port), the first path segment a
// request must carry and the map key the server resolves it by.
type provider struct {
	name   string
	target *url.URL
	proxy  *httputil.ReverseProxy
}

func newProvider(name, raw string) (*provider, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("provider %q: invalid URL %q: %w", name, raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("provider %q: URL scheme must be http or https, got %q", name, u.Scheme)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("provider %q: URL is missing a host", name)
	}

	p := &provider{name: name, target: u}
	p.proxy = &httputil.ReverseProxy{
		// Stream immediately: flush to the client after every read from the
		// upstream body. Zero buffering, so SSE / NDJSON / chunked responses
		// arrive with upstream-identical timing.
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			// Route to the upstream, joining base path + remaining request
			// path (SetURL single-joins slashes). Query string is preserved.
			pr.SetURL(u)
			// Talk to the upstream as itself (needed for SNI + virtual hosts).
			pr.Out.Host = u.Host
			// Pass headers as-is: do NOT add X-Forwarded-For or friends.
			// (ReverseProxy's Rewrite mode strips inbound Forwarded/*X-Forwarded-*
			// headers as an anti-spoofing measure; LLM providers ignore them.)
		},
		ErrorHandler: p.proxyError,
	}
	return p, nil
}

// stripPrefix returns a handler that removes "/<host>" from the request path
// before proxying, so /api.cline.bot/models hits https://api.cline.bot at
// /models (docs/d047).
func (p *provider) handler() http.Handler {
	return http.StripPrefix("/"+p.name, p.proxy)
}

// ---------------------------------------------------------------------------
// Error classification → RFC 9457 problem details
// ---------------------------------------------------------------------------

type problem struct {
	// Type IS the machine-readable cause (dnserror, econnrefused, …).
	// The old `type: "urn:…:error:<code>"` URN and the separate `code` member
	// said the same thing twice — one of them had to go, and the bare token
	// is the one clients and operators actually key on. RFC 9457's
	// relative-URI type resolution makes this a valid problem type.
	Type     string `json:"type"`
	Title    string `json:"title"`
	Status   int    `json:"status"`
	Detail   string `json:"detail,omitempty"`
	Raw      string `json:"raw,omitempty"`     // extension: verbatim Go error
	Details  any    `json:"details,omitempty"` // extension: canonical dump of the matched error family (errorDetails); never secrets — operator-known facts only
	Instance string `json:"instance,omitempty"`
}

func writeProblem(w http.ResponseWriter, r *http.Request, status int, code, title, detail string, err error) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(problem{
		Type:     code,
		Title:    title,
		Status:   status,
		Detail:   detail,
		Raw:      err.Error(),
		Details:  errorDetails(err),
		Instance: r.URL.RequestURI(),
	})
}

// dnsErrorDetails is the canonical dump of *net.DNSError — the six public
// fields the stdlib provides. (The DNS rcode itself is not exposed: Go
// collapses NXDOMAIN and empty answers into IsNotFound, and the cgo resolver
// reports through IsTemporary instead of Err strings — any finer split would
// be resolver-dependent guesswork.)
type dnsErrorDetails struct {
	Name        string `json:"name"`        // host that failed to resolve
	Server      string `json:"server"`      // resolver that answered ("system resolver" when unset)
	Err         string `json:"err"`         // the resolver's own failure description
	IsTimeout   bool   `json:"isTimeout"`   // "not all timeouts set this" — stdlib doc
	IsTemporary bool   `json:"isTemporary"` // cgo/EAI_AGAIN family
	IsNotFound  bool   `json:"isNotFound"`  // NXDOMAIN ∪ NODATA, collapsed
}

// errorDetails returns the canonical dump of the matched error family for the
// RFC 9457 "details" extension member. Classification stays a small, stable
// vocabulary (code); the dump rides along as diagnostics and never feeds back
// into the code.
func errorDetails(err error) any {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		server := dnsErr.Server
		if server == "" {
			server = "system resolver"
		}
		return dnsErrorDetails{
			Name:        dnsErr.Name,
			Server:      server,
			Err:         dnsErr.Err,
			IsTimeout:   dnsErr.IsTimeout,
			IsTemporary: dnsErr.IsTemporary,
			IsNotFound:  dnsErr.IsNotFound,
		}
	}
	return nil
}

// classify maps a proxy-side failure to (code, title). The raw error text is
// always attached verbatim, so nothing is lost even when classification is
// best-effort.
func classify(err error) (code, title string) {
	raw := err.Error()

	// DNS failures (wrap *net.OpError → *net.DNSError): one code. The
	// rcode-level split (nxdomain/servfail/…) was string-matching on the wrap
	// chain and misclassified resolver-transport failures; the actionable
	// facts ride along in "details" (see errorDetails) instead.
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dnserror", fmt.Sprintf("DNS lookup for upstream host %q failed", dnsErr.Name)
	}

	// TLS certificate verification failures: the family is the error type
	// (tls.CertificateVerificationError); the x509 sub-cause rides along in
	// Raw rather than widening the vocabulary.
	var verifyErr *tls.CertificateVerificationError
	if errors.As(err, &verifyErr) {
		return "tls-verification-failed", "TLS certificate verification of the upstream failed"
	}

	// TCP / OS-level connection errors: the errno name is the cause — no
	// tcp- prefix (the errno already says the family). The syscall name and
	// number ride along in Raw.
	for _, m := range []struct {
		errno error
		code  string
		title string
	}{
		{syscall.ECONNREFUSED, "econnrefused", "Nothing is listening on the upstream address (ECONNREFUSED)"},
		{syscall.ECONNRESET, "econnreset", "The upstream reset the connection (ECONNRESET)"},
		{syscall.EPIPE, "epipe", "The upstream connection broke (EPIPE)"},
		{syscall.ENETUNREACH, "enetunreach", "The upstream network is unreachable (ENETUNREACH)"},
		{syscall.EHOSTUNREACH, "ehostunreach", "The upstream host is unreachable (EHOSTUNREACH)"},
		{syscall.ETIMEDOUT, "etimedout", "The upstream connection timed out (ETIMEDOUT)"},
	} {
		if errors.Is(err, m.errno) {
			return m.code, m.title
		}
	}

	// Transport timeouts.
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout", "The upstream timed out"
	}

	// Upstream hung up before the response completed.
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || strings.Contains(raw, "unexpected EOF") {
		return "disconnected", "The upstream closed the connection before completing the response"
	}

	return "upstream-error", "The upstream request failed"
}

// ---------------------------------------------------------------------------
// Combined Log Format logging
// ---------------------------------------------------------------------------

// loggingResponseWriter wraps http.ResponseWriter to capture the status code
// and total bytes written — httputil.ReverseProxy writes directly to the
// ResponseWriter so we need an interceptor to log %>s %b (the standard
// Combined Log Format fields for status and response size).
type loggingResponseWriter struct {
	http.ResponseWriter
	status int
	size   int
}

func (lw *loggingResponseWriter) WriteHeader(status int) {
	lw.status = status
	lw.ResponseWriter.WriteHeader(status)
}

// Flush and Unwrap keep the underlying writer's streaming capability
// reachable through this wrapper. httputil.ReverseProxy resolves its flusher
// via http.NewResponseController, which walks Unwrap and otherwise needs a
// Flush method on the wrapper itself; embedding the http.ResponseWriter
// interface promotes neither, so without these the proxy silently falls back
// to buffered writes and FlushInterval:-1 becomes a no-op — SSE/NDJSON would
// arrive only when net/http's buffer fills or the body ends (see
// smoke-test.sh's streaming-unbuffered check).
func (lw *loggingResponseWriter) Flush() {
	if f, ok := lw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (lw *loggingResponseWriter) Unwrap() http.ResponseWriter {
	return lw.ResponseWriter
}

func (lw *loggingResponseWriter) Write(b []byte) (int, error) {
	n, err := lw.ResponseWriter.Write(b)
	lw.size += n
	return n, err
}

// recordSwitched notes a status written straight onto a hijacked
// connection: net/http never routes those through WriteHeader, so without
// this the CLF line would print a phantom status 0 (docs/d073 VPN-R13).
func (lw *loggingResponseWriter) recordSwitched(size int) {
	lw.status = http.StatusSwitchingProtocols
	lw.size = size
}

// logCombinedRequest writes one line per request in a format matching nginx /
// Apache Combined Log Format:
//
//	127.0.0.1 - - [10/Oct/2000:13:55:36 -0700] "GET /path HTTP/1.1" 200 1234 "-" "Mozilla/5.0"
//
// This makes the proxy's output greppable, parseable, and compatible with
// standard log analysis tools (GoAccess, ELK, etc.) without a custom parser.
// logCombinedRequestURI prints one Combined Log Format line per request; the
// URI is read off r unmodified — nothing request-shaped is credential-class
// any more (docs/d085), so there is nothing left to scrub.
func logCombinedRequestURI(r *http.Request, status int, size int) {
	remoteAddr := r.RemoteAddr
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		remoteAddr = host
	}
	ts := time.Now().Format("02/Jan/2006:15:04:05 -0700")
	requestLine := fmt.Sprintf("%s %s %s", r.Method, r.URL.RequestURI(), r.Proto)
	referrer := r.Referer()
	if referrer == "" {
		referrer = "-"
	}
	userAgent := r.Header.Get("User-Agent")
	if userAgent == "" {
		userAgent = "-"
	}
	log.Printf("%s - - [%s] %s %d %d %q %q",
		remoteAddr, ts, requestLine, status, size, referrer, userAgent)
}

// proxyError is called by ReverseProxy when the upstream exchange fails before
// any response bytes reach the HTTP client — the one place we may still send
// a 502. Request logging is handled by server.ServeHTTP after the proxy
// returns; this method only writes the 502 response body (or nothing, when
// the caller hung up first).
func (p *provider) proxyError(w http.ResponseWriter, r *http.Request, err error) {
	// The caller hung up first: nothing to report, and nobody to report to.
	if r.Context().Err() != nil || errors.Is(err, context.Canceled) {
		return
	}

	code, title := classify(err)
	detail := fmt.Sprintf("while proxying %s%s to %s: %s", p.name, r.URL.RequestURI(), p.target.Host, err.Error())
	writeProblem(w, r, http.StatusBadGateway, code, title, detail, err)
}

// writeFunnel404 answers every 404 this relay can produce the way the
// tailscale funnel in front of it does: a bare, plain-text Go "404 page not
// found". This includes unknown provider prefixes, garbage paths, AND mode
// C's unauthenticated tunnel probes — a JSON error body (even a
// URN-shaped RFC 9457 one) would act as a probe oracle, confirming
// "custom software lives here" and inviting more probing. The funnel's
// prefix filtering already stops most garbage; whatever gets through must
// learn nothing: no routing table, no provider names, no distinguishable
// fingerprint between a real route and a dead one, and none between mode A
// and the tunnel's namespace (docs/d073 VPN-R34/R2).
//
// RFC 9457 problem details remain only for INTERNAL failures (bad-gateway
// conditions: DNS, TCP, TLS, upstream disconnects) — those carry provider
// context the operator already knows, and the request got as far as a
// configured upstream, so no extra oracle is handed out. Operators debug
// unknown-prefix mistakes from the proxy logs, not the response.
func writeFunnel404(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusNotFound)
	fmt.Fprintln(w, "404 page not found")
	logCombinedRequestURI(r, http.StatusNotFound, len("404 page not found\n"))
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

type server struct {
	providers map[string]*provider
	// vpn is nil unless the tunnel is enabled; nil is not "denied", it is
	// "this process does not do that" — the tunnel path answers mode A's
	// 404 either way (docs/d073 VPN-R2/R34).
	vpn *tunnelServer
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Tunnel dispatch is by exact path and happens BEFORE provider parsing
	// (docs/d073 VPN-R42): the tunnel namespace cannot be confused with a
	// mode A route, and the reserved path is never an allowlist host (checked
	// in enableTunnel), so both dispatch orders would agree — this one keeps
	// the two modes from ever branching on each other's state.
	if s.vpn != nil && s.vpn.isTunnelPath(r.URL.Path) {
		s.vpn.serveTunnel(w, r)
		return
	}

	name, _, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")

	// writeFunnel404 carries the camouflage-404 contract (shared with mode
	// C's tunnel path — docs/d073 VPN-R34).
	funnel404 := func() {
		writeFunnel404(w, r)
	}
	if name == "" {
		funnel404()
		return
	}

	p, ok := s.providers[name]
	if !ok {
		funnel404()
		return
	}

	// Wrap the writer so we can capture the status code and byte count after
	// ReverseProxy writes (the stdlib proxy writes directly to the provided
	// ResponseWriter, so we need our own interceptor to log %>s %b).
	lw := &loggingResponseWriter{ResponseWriter: w}
	p.handler().ServeHTTP(lw, r)
	// Upgrade responses (the §4 websocket routes) are written raw on the
	// hijacked connection and never reach WriteHeader — record the switch so
	// the CLF line says 101 instead of a phantom status 0 (docs/d073
	// VPN-R13). Response size is unknowable from here (bytes flow
	// conn-to-conn after the hijack), so it logs as 0 deliberately.
	if lw.status == 0 && headerHasToken(r.Header, "Connection", "Upgrade") {
		lw.recordSwitched(0)
	}
	logCombinedRequestURI(r, lw.status, lw.size)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

func main() {
	configPath := flag.String("config", "llm-reverse-proxy.json", "path to JSON config")
	listen := flag.String("listen", "", "override listen address (e.g. :8080)")
	// Role values are the node names, not protocol roles (docs/d088): the
	// process is always a mix of client, server, and both proxy shapes, so
	// only network position discriminates.
	mode := flag.String("mode", "exit", "process role: \"exit\" (the exit node: funnel front, allowlist, tunnel server) or \"relay\" (the relay node: loopback CONNECT/SOCKS5 proxy feeding the tunnel, modes C–E; docs/d073 §7, docs/d088)")
	proxyListen := flag.String("proxy-listen", "127.0.0.1:3128", "relay role: loopback HTTP CONNECT listener")
	socksListen := flag.String("socks-listen", "127.0.0.1:1080", "relay role: loopback SOCKS5 listener")
	// No -modes flag: the transport offer is the whole ladder and selection
	// is the relay node's per-dial ranking of the endpoint (docs/d093) — a
	// knob here could only ever degrade it.
	flag.Parse()

	// Disable Go's default timestamp prefix — the Combined Log Format lines
	// already carry their own timestamp in brackets, so the log package's
	// automatic "2009/01/02 15:04:05" header would be redundant noise.
	log.SetFlags(0)

	// Relay node (docs/d073 §7, modes C–E, docs/d088): a separate role with its
	// own contract — no allowlist config, and failing BEFORE any bind on bad
	// or missing env IS the kill switch (VPN-R26): a listener that could
	// start without a credential would only exist to refuse everything anyway.
	if *mode == "relay" {
		relayCfg, err := relayConfigFromEnv(*proxyListen, *socksListen)
		if err != nil {
			log.Fatalf("[vpn-relay] %v", err)
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := runRelayNode(ctx, relayCfg); err != nil {
			log.Fatalf("[vpn-relay] %v", err)
		}
		return
	}
	if *mode != "exit" {
		log.Fatalf("[llm-reverse-proxy] unknown -mode %q (want exit or relay)", *mode)
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Fatalf("[llm-reverse-proxy] %v", err)
		}
		// No config file: allow pure-flag usage (-listen + provider URLs on
		// the command line is not supported; require the file).
		log.Fatalf("[llm-reverse-proxy] config %s not found; create it, e.g. {\"listen\":\":8080\",\"allowHosts\":{\"openrouter.ai\":\"https://openrouter.ai\"}}", *configPath)
	}
	if *listen != "" {
		cfg.Listen = *listen
	}
	if cfg.Listen == "" {
		cfg.Listen = ":8080"
	}

	s := &server{providers: make(map[string]*provider, len(cfg.AllowHosts))}
	for name, raw := range cfg.AllowHosts {
		p, err := newProvider(name, raw)
		if err != nil {
			log.Fatalf("[llm-reverse-proxy] %v", err)
		}
		s.providers[name] = p
	}
	if len(s.providers) == 0 {
		log.Fatalf("[llm-reverse-proxy] no allowHosts entries configured in %s", *configPath)
	}

	if shouldArmTunnel(cfg.Tunnel, operatorCredentialInEnv()) {
		tn := cfg.Tunnel
		if tn == nil {
			tn = &tunnelConfig{}
		}
		if err := s.enableTunnel(tn); err != nil {
			log.Fatalf("[llm-reverse-proxy] tunnel: %v", err)
		}
	}

	srv := &http.Server{
		Addr: cfg.Listen,
		// Only guard against slowloris-style clients. Everything else is left
		// unlimited: LLM streams can legitimately run for many minutes.
		ReadHeaderTimeout: 30e9,
		Handler:           s,
	}

	log.Printf("[llm-reverse-proxy] listening on %s; %d allowlisted host(s):", cfg.Listen, len(s.providers))
	for _, name := range s.providers {
		log.Printf("[llm-reverse-proxy]   /%s/ → %s", name.name, name.target)
	}
	log.Fatal(srv.ListenAndServe())
}
