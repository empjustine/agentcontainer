// estige — the SSL-VPN tunnel transports (docs/d073/d077, carriers).
//
// One binary, two network positions (docs/d088): the EXIT node terminates
// tunnels at the edge and opens egress under the policy the operator reviews;
// the RELAY node dials in and serves localhost CONNECT/SOCKS5 proxies to
// unmodified clients.
//
// A deployment IS a store (d236): `$XDG_DATA_HOME/estige` holds the host key
// and its certificate, the pairing rows and the egress policy, and it is the
// only place any of that can live. The environment carries nothing but
// non-secret runtime knobs (the bind, the relay's label) and argv carries the
// postures an operator must be able to see in the process's own command line.
// A node with no store — or one that does not parse — refuses to boot rather
// than binding a port that answers 404 to everything (docs/d084's kill switch).
// The operator's own verbs are `keygen`, `public` and `key check` for that
// store, plus `proxy-env` for the shell chain step (docs/d095).
//
// The v2 host-allowlist reverse proxy (docs/d047, legacy allowlist relay) is gone
// (docs/d108): a TLS-terminating edge sees plaintext provider keys, and no
// credential scheme fixes that (d073's trust table). What survives of it is
// the plumbing the tunnel shares — the collector 404 (VPN-R34) and the
// Combined Log Format line — plus RFC 9457 problem details for tunnel-side
// internal failures.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

// Tunnel environment surface (carriers; docs/d073 §6.3/§7): NOTHING SECRET
// arrives this way any more. The store under $XDG_DATA_HOME/estige holds the
// host identity, the pairing and the egress policy (d236/d132), so a file
// holding a credential is not a second copy of one and the env chain carries
// only non-secret runtime knobs. What is left: the bind (PORT/PORT_CLOUDFLARE,
// docs/d110/d222) and the relay's optional log label. The capability PATH is
// none of this env's business (docs/d085): it is the Funnel mount's, and the
// edge strips it before a request can reach us.
const (
	// envClientLabel is the relay node's optional identity in the HELLO and
	// its own log records. It identifies, it does not authenticate.
	envClientLabel = "VPN_CLIENT_LABEL"
	// envCloudflarePort is the exit node's second bind: the port whose
	// connector (cloudflared) fronts an edge that caps one request body
	// (docs/d222). Requests arriving on it have h2-post-unbounded refused at
	// request initiation, and only the windowed carriers are served. Unset
	// means the exit serves one edge only.
	envCloudflarePort = "PORT_CLOUDFLARE"
)

// exitRoleRefusal reports the first relay-only argv line an exit-node start
// carries. Every one of these switches is about DIALING a peer, and the exit
// node dials none of its own: accepting the flag silently would hide a relay
// argv line copied onto the exit host, so each is refused by name (docs/d171's
// ledger applied to d236's selectors).
func exitRoleRefusal(insecureExit bool, forwards int, exitName, endpoint string) error {
	switch {
	case insecureExit:
		return errors.New("-insecure-exit belongs to the relay role; the exit node dials no tunnel")
	case forwards > 0:
		return errors.New("-L belongs to the relay role; the exit node opens no local listeners")
	case exitName != "":
		return errors.New("-exit belongs to the relay role; the exit node is the peer, it dials none")
	case endpoint != "":
		return errors.New("-endpoint belongs to the relay role; the exit node binds, it dials no endpoint")
	}
	return nil
}

// portFromEnv resolves the exit node's single-port bind (docs/d110): env
// PORT, unset → 8080 on all interfaces. The convention's whole value is that
// process managers already speak it, so a VPN_-prefixed shadow would re-create
// the second spelling d090 forbids — here the standard name IS the spelling.
// No flag and no config field: a tool that binds one port is steered by one
// knob, and a host half is not part of the fact.
//
// A value that is not a bare port number is refused by name: "0.0.0.0:8080"
// or "8080/tcp" would otherwise reach ListenAndServe as a garbled address
// whose error names the socket, not the variable the operator set.
func portFromEnv() string { return bindPort("PORT", "8080") }

// bindPort validates a bare port number and returns the listen address. A
// value that is not a bare port is refused by name: "0.0.0.0:8080" or
// "8080/tcp" would otherwise reach ListenAndServe as a garbled address whose
// error names the socket, not the variable the operator set.
func bindPort(name, fallback string) string {
	port := os.Getenv(name)
	if port == "" {
		port = fallback
	}
	for _, r := range port {
		if r < '0' || r > '9' {
			fatalLine("[estige] %s=%q is not a port number (docs/d110)", name, port)
		}
	}
	return ":" + port
}

// cloudflarePortFromEnv resolves the exit node's second bind, whose connector
// fronts an edge that caps one request body (docs/d222). Empty means the exit
// serves one edge.
func cloudflarePortFromEnv() string {
	port := os.Getenv(envCloudflarePort)
	if port == "" {
		return ""
	}
	for _, r := range port {
		if r < '0' || r > '9' {
			fatalLine("[estige] %s=%q is not a port number", envCloudflarePort, port)
		}
	}
	return port
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

func writeProblem(w http.ResponseWriter, r *http.Request, status int, code, title string, err error) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	// The encode error is logged, not returned: the status line is already on
	// the wire, so the log is the only honest signal left (NFR-2). The any-typed
	// Details member is why errchkjson refuses a blank assignment here.
	if encErr := json.NewEncoder(w).Encode(problem{
		Type:    code,
		Title:   title,
		Status:  status,
		Raw:     rawErrorText(err),
		Details: errorDetails(err),
		// The instance is a diagnostic for the operator reading a LOOPBACK
		// surface, where the whole request is their own. On the exit node the
		// URI arrives from the network, and echoing it back turns a fixed-path
		// tunnel into a reflector for whatever the caller put on the wire —
		// post-auth today, but worth nothing to the client, which already knows
		// what it asked for.
		Instance: instanceOf(r),
	}); encErr != nil {
		logLine(sevWarn, "[estige] problem response encode: %v", encErr)
	}
}

// nodeRole is the process's network position (docs/d088). One process serves
// one role, so a package-level copy is the role, not a parameter threaded
// through every handler for one diagnostic field.
var nodeRole = roleExit

const (
	roleExit  = "exit"
	roleRelay = "relay"
)

// rawErrorText bounds the verbatim Go error a problem body carries. The
// texts here are already operator-facing and never secrets, but an unbounded
// echo is still attacker-shaped input on the one surface that reflects it.
const maxRawError = 512

func rawErrorText(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if len(text) <= maxRawError {
		return text
	}
	return text[:maxRawError] + "… (truncated)"
}

// instanceOf returns the request URI only on the relay node (a loopback
// surface serving its own operator); the exit node omits it.
func instanceOf(r *http.Request) string {
	if nodeRole != roleExit {
		return r.URL.RequestURI()
	}
	return ""
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
	if dnsErr, ok := errors.AsType[*net.DNSError](err); ok {
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

// ---------------------------------------------------------------------------
// Combined Log Format logging
// ---------------------------------------------------------------------------

// loggingResponseWriter wraps http.ResponseWriter to capture the status code
// and total bytes written — tunnel handlers write straight to the
// ResponseWriter (and hijack it for upgrades), so an interceptor is the only
// way to log %>s %b, the standard Combined Log Format fields.
type loggingResponseWriter struct {
	http.ResponseWriter
	status int
	size   int
	start  time.Time // access-line duration; zero when the caller did not set it
}

func (lw *loggingResponseWriter) WriteHeader(status int) {
	lw.status = status
	lw.ResponseWriter.WriteHeader(status)
}

// Flush and Unwrap keep the underlying writer's streaming capability
// reachable through this wrapper. Handlers resolve their flusher via
// http.NewResponseController, which walks Unwrap and otherwise needs a Flush
// method on the wrapper itself; embedding the http.ResponseWriter interface
// promotes neither, so without these a streaming tunnel response would arrive
// only when net/http's buffer fills or the body ends — the buffering a tunnel
// exists to avoid.
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

// logCombinedRequestURI writes one line per request in nginx / Apache
// Combined Log Format:
//
//	127.0.0.1 - - [10/Oct/2000:13:55:36 -0700] "GET /path HTTP/1.1" 200 1234 "-" "Mozilla/5.0"
//
// The format is load-bearing, not cosmetic: standard log analysis (GoAccess,
// ELK, …) reads the edge without a custom parser. The URI is logged off r
// unmodified — nothing request-shaped is credential-class any more
// (docs/d085), so there is nothing left to scrub.
func logCombinedRequestURI(r *http.Request, status int, size int) {
	logAccess(r, status, size, time.Time{})
}

// logAccess writes the stock Combined Log Format line and hands the same
// facts to the sink as fields (docs/d155: STATUS, BYTES and DURATION_MS ride
// beside MESSAGE, because journald parses nothing out of a stream line).
func logAccess(r *http.Request, status int, size int, start time.Time) {
	remoteAddr := r.RemoteAddr
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		remoteAddr = host
	}
	ts := time.Now().Format("02/Jan/2006:15:04:05 -0700")
	requestLine := fmt.Sprintf("%s %s %s", r.Method, accessURI(r), r.Proto)
	referrer := r.Referer()
	if referrer == "" {
		referrer = "-"
	}
	userAgent := r.Header.Get("User-Agent")
	if userAgent == "" {
		userAgent = "-"
	}
	fields := []journalField{
		{"STATUS", strconv.Itoa(status)},
		{"BYTES", strconv.Itoa(size)},
	}
	if !start.IsZero() {
		fields = append(fields, journalField{"DURATION_MS", strconv.FormatInt(time.Since(start).Milliseconds(), 10)})
	}
	activeSink.emit(sevInfo, fmt.Sprintf("%s - - [%s] %s %d %d %q %q",
		remoteAddr, ts, requestLine, status, size, referrer, userAgent), fields)
}

// accessURI is what the access line logs. The tunnel and health paths carry
// no query; the cleartext forward branch does — and there a presigned URL or
// a session token can live in it (docs/d106's query-string finding). d085's
// "nothing request-shaped is credential-class" was scoped to the allowlist
// relay, so the generic branch strips the query rather than log it.
func accessURI(r *http.Request) string {
	if !r.URL.IsAbs() {
		return r.URL.RequestURI()
	}
	if r.URL.Scheme != schemeHTTP && r.URL.Scheme != schemeWS {
		return r.URL.RequestURI()
	}
	stripped := *r.URL
	stripped.RawQuery = ""
	stripped.ForceQuery = false
	stripped.Fragment = ""
	return stripped.String()
}

// writeFunnel404 answers every 404 this node can produce the way the
// tailscale funnel in front of it does: a bare, plain-text Go "404 page not
// found". Every path outside the tunnel namespace lands here — garbage, a
// stale reverse-proxy route from an older deployment, AND h2-post-unbounded's
// unauthenticated tunnel probes. A JSON error body (even an RFC 9457 one)
// would act as a probe oracle, confirming "custom software lives here";
// whatever gets through the funnel must learn nothing (docs/d073
// VPN-R34/R2).
//
// RFC 9457 problem details remain only for INTERNAL failures inside the
// tunnel (bad-gateway conditions) — those are answered to a caller that
// already authenticated, so no extra oracle is handed out. Operators debug
// unknown-path mistakes from the proxy logs, not the response.
func writeFunnel404(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusNotFound)
	_, _ = fmt.Fprintln(w, "404 page not found")
	logCombinedRequestURI(r, http.StatusNotFound, len("404 page not found\n"))
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

type server struct {
	// vpn is nil unless the tunnel is enabled; nil is not "denied", it is
	// "this process does not do that" — every path then answers the funnel's
	// 404 (docs/d073 VPN-R2/R34).
	vpn *tunnelServer
	// cloudflarePort identifies the second, capped-edge listener by its bare
	// port number (docs/d222). Detection reads the request's own local
	// address, so no header or per-request config participates.
	cloudflarePort string
}

// windowedOnly reports whether this request arrived on the capped edge's
// port. The request's local address is the listener's, which is the fact the
// exit serves, so a connector cannot lie about its edge by sending a header.
func (s *server) windowedOnly(r *http.Request) bool {
	if s.cloudflarePort == "" {
		return false
	}
	la, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
	if !ok {
		return false
	}
	_, port, err := net.SplitHostPort(la.String())
	return err == nil && port == s.cloudflarePort
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Dispatch is by exact path — one namespace, no prefix table (docs/d073
	// VPN-R42). Anything else is the funnel's 404, which is what a client
	// from the deleted allowlist deployment gets: the route it still carries
	// is dead, and it learns nothing about why (docs/d108).
	if s.vpn != nil && s.vpn.isTunnelPath(r.URL.Path) {
		s.vpn.serveTunnel(w, r, s.windowedOnly(r))
		return
	}
	writeFunnel404(w, r)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

// version is injected by lib/go-build.mjs's commonBuildFlags through
// `-ldflags=-X main.version=...`; the committed source reads "dev".
var version = "dev"

func main() {
	// Four subcommands remain, each print-and-exit: `proxy-env` prints the
	// loopback proxy spelling for the operator's shell (docs/d095); `keygen`
	// mints the host identity key material, `public` derives a peer-ready
	// config entry and `key check` validates the role stores (d104/d132/d236).
	// `generate`
	// went with the allowlist it emitted (docs/d108) and `smoke-test` went
	// with the reverse-proxy behaviour it checked; the installed service units
	// own everything else. Role selection stays `-mode`.
	if len(os.Args) > 1 && os.Args[1] == "proxy-env" {
		runProxyEnv(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "keygen" {
		runKeygen(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "public" {
		runPublic(os.Args[2:])
		return
	}
	if len(os.Args) > 2 && os.Args[1] == "key" && os.Args[2] == "check" {
		runKeyCheck(os.Args[3:])
		return
	}

	// Role values are the node names, not protocol roles (docs/d088): the
	// process is always a mix of client, server, and both proxy shapes, so
	// only network position discriminates.
	showVersion := flag.Bool("version", false, "print the version and exit")
	mode := flag.String("mode", "exit", "process role: \"exit\" (the exit node: funnel front + tunnel server) or \"relay\" (the relay node: loopback CONNECT/SOCKS5 proxy feeding the tunnel, carriers; docs/d073 §7, docs/d088)")
	proxyListen := flag.String("proxy-listen", "127.0.0.1:3128", "relay role: loopback HTTP CONNECT listener")
	socksListen := flag.String("socks-listen", "127.0.0.1:1080", "relay role: loopback SOCKS5 listener")
	// Address targets stay refused at the relay's own doors until asked
	// for (d163): the exit answers them with a refusal of its own unless
	// its egress config opts in, and this switch is the relay's half of the
	// same statement. It never re-enables a guaranteed-bogon target.
	legacyIPRelay := flag.Bool("legacy-ip-relay", false, "relay role: relay address (IP-literal) targets instead of refusing them at the local doors (d163)")
	// One switch for both degraded relay->exit postures (docs/d171): a
	// skipped certificate check on an https/wss leg, and a cleartext
	// ws:// URL. It is argv, not env, because a posture this load-bearing
	// must be visible in the process's own command line (d163's ledger).
	insecureExit := flag.Bool("insecure-exit", false, "relay role: allow the two degraded tunnel postures — skip TLS verification and accept a cleartext ws:// URL (docs/d171)")
	// Which peer this relay dials (d236). The store's first exit row is the
	// implicit default — row order is special nowhere else — and argv can name
	// the exit (its security principal) or re-route the endpoint. Neither
	// grants trust: the pinned certificate of the selected exit decides.
	exitName := flag.String("exit", "", "relay role: which relay.json exit row to dial (default: the first row; d236)")
	endpointOverride := flag.String("endpoint", "", "relay role: dial this endpoint instead of relay.json's (the pinned certificate still decides trust; d236)")
	// ssh-style local forwarding (docs/d144): each -L is its own loopback
	// listener and its own tunnel per accepted connection.
	var forwardArgs forwardList
	flag.Var(&forwardArgs, "L", "relay role: local forward, [<bind>:]<port>:<host>:<port> (repeatable; docs/d144)")
	// The exit node's local status surface (docs/d106). Off by default and
	// loopback-only when on: the funnel face must stay the camouflage 404,
	// so a state read cannot ride the public port.
	statusListen := flag.String("status-listen", "", "exit role: loopback address for the JSON status surface, e.g. 127.0.0.1:8081 (off by default)")
	// No -modes flag: the transport offer is the whole ladder and selection
	// is the relay node's per-dial ranking of the endpoint (docs/d093) — a
	// knob here could only ever degrade it.
	flag.Parse()

	if *showVersion {
		fmt.Printf("estige %s\n", version)
		return
	}
	nodeRole = *mode

	// One detection, before the first line (docs/d155, R1): a service whose
	// output systemd attached to the journal gets fields; everything else
	// keeps the stream line byte for byte.
	installLogSink()

	// Relay node (docs/d073 §7, carriers, docs/d088): a separate role with its
	// own contract — no allowlist config, and failing BEFORE any bind on bad
	// or missing env IS the kill switch (VPN-R26): a listener that could
	// start without a credential would only exist to refuse everything anyway.
	if *mode == "relay" {
		if *statusListen != "" {
			fatalLine("[vpn-relay] -status-listen belongs to the exit role; the relay's surface is its loopback /healthz (VPN-R27)")
		}
		relayCfg, err := relayConfigFromEnv(*proxyListen, *socksListen,
			relaySelection{Exit: *exitName, Endpoint: *endpointOverride}, *legacyIPRelay, *insecureExit)
		if err != nil {
			if errors.Is(err, errSelfChained) {
				logLine(sevError, "[vpn-relay] %v", err)
				os.Exit(exitSelfChain)
			}
			fatalLine("[vpn-relay] %v", err)
		}
		relayCfg.forwards, err = parseForwards(forwardArgs)
		if err != nil {
			fatalLine("[vpn-relay] %v", err)
		}
		runCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		runErr := runRelayNode(runCtx, relayCfg)
		// stop() runs explicitly, not from a defer: fatalLine below exits
		// without unwinding defers (gocritic's exitAfterDefer), and a pending
		// defer is exactly what that rule forbids.
		stop()
		if runErr != nil {
			fatalLine("[vpn-relay] %v", runErr)
		}
		return
	}
	if *mode != "exit" {
		fatalLine("[estige] unknown -mode %q (want exit or relay)", *mode)
	}
	if err := exitRoleRefusal(*insecureExit, len(forwardArgs), *exitName, *endpointOverride); err != nil {
		fatalLine("[estige] %v", err)
	}

	// The exit node is configured from its store, not the environment
	// (d236): $XDG_DATA_HOME/estige holds the host key and certificate, the
	// admitted relays and the egress policy, and a missing or unparseable
	// store is the arming fact's absence — it refuses at boot (docs/d084's
	// kill-switch law). The env contributes only the bind (PORT, docs/d110)
	// and the exit's optional argv postures.
	bind := portFromEnv()
	cfPort := cloudflarePortFromEnv()
	if cfPort != "" && bind == ":"+cfPort {
		fatalLine("[estige] %s must not repeat PORT: one port cannot serve both edge roles", envCloudflarePort)
	}
	if *statusListen != "" {
		if err := requireLoopback(*statusListen); err != nil {
			fatalLine("[estige] status listener: %v", err)
		}
	}

	s := &server{cloudflarePort: cfPort}
	// The store is the arming fact: a missing or broken store refuses at
	// boot rather than binding a port that answers 404 to everything.
	if err := s.enableTunnel(); err != nil {
		fatalLine("[estige] tunnel: %v", err)
	}

	newServer := func(addr string) *http.Server {
		return &http.Server{
			Addr: addr,
			// Only guard against slowloris-style clients. Everything else is
			// left unlimited: LLM streams can legitimately run for minutes.
			ReadHeaderTimeout: 30 * time.Second,
			// The tunnel's own headers are a handful of short fields. Go's
			// 1 MiB default is an unnecessary public-face allocation budget.
			MaxHeaderBytes: 1 << 14,
			// IdleTimeout is the one terminator that is safe to enable: it
			// bounds how long a connection may sit with NO request in flight,
			// so it never touches a live session (which is always either
			// reading a window or flushing one) and it reaps the half-open
			// sockets ReadHeaderTimeout alone leaves parked between requests.
			IdleTimeout: 5 * time.Minute,
			Handler:     s,
		}
	}
	srv := newServer(bind)
	var cfSrv *http.Server
	if cfPort != "" {
		cfSrv = newServer(":" + cfPort)
	}
	// One port per edge (docs/d222): the first is the Funnel face, where the
	// lowest-overhead h2 carrier is allowed; the second is the port a capped
	// edge's connector points at, where it is refused at initiation.
	logLine(sevInfo, "[estige] listening on %s (tailscale edge: h2-post-unbounded allowed); tunnel at %s", bind, tunnelPath)
	if cfSrv != nil {
		logLine(sevInfo, "[estige] listening on :%s (cloudflare edge: h2-post-unbounded refused; windowed carriers only)", cfPort)
	}

	runCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *statusListen != "" {
		// The status surface is loopback-only and never part of the funnel
		// face (docs/d106): it answers the operator's "what is happening"
		// without adding a byte to the public 404.
		go serveStatus(*statusListen, s)
	}

	serveErr := make(chan error, 2)
	go func() { serveErr <- srv.ListenAndServe() }()
	if cfSrv != nil {
		go func() { serveErr <- cfSrv.ListenAndServe() }()
	}
	select {
	case err := <-serveErr:
		fatalLine("[estige] %v", err)
	case <-runCtx.Done():
		// One signal drains rather than kills (docs/d171's rotation
		// primitive): stop accepting, let live sessions finish, then close
		// what is left at the deadline. Without this a restart — which is
		// how a v3 credential rotates — drops every streaming request.
		stop()
		live := s.tunnelLiveCount()
		logLine(sevInfo, "[estige] signal received; draining %d live session(s) (grace %s)", live, drainGrace)
		deadline, cancel := context.WithTimeout(context.Background(), drainGrace)
		defer cancel()
		// Shutdown closes the listeners immediately (no new session) and
		// waits for the handlers net/http knows about. Hijacked sessions are
		// invisible to it, so the live registry is the real wait: every
		// carrier must reach zero, or the deadline.
		go func() { _ = srv.Shutdown(deadline) }()
		if cfSrv != nil {
			go func() { _ = cfSrv.Shutdown(deadline) }()
		}
		s.drainTunnelSessions(drainGrace)
		<-time.After(300 * time.Millisecond)
		logLine(sevInfo, "[estige] drained")
	}
}
