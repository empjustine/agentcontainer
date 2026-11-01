// estige — the SSL-VPN tunnel transports (docs/d073/d077, modes C–E).
//
// One binary, two network positions (docs/d088): the EXIT node terminates
// tunnels at the edge and opens egress under the policy the operator reviews;
// the RELAY node dials in and serves localhost CONNECT/SOCKS5 proxies to
// unmodified clients. Credentials arrive only through the env chain
// (docs/d078/d084/d085/d090) and never through the config file, which carries
// policy alone.
//
// The v2 host-allowlist reverse proxy (docs/d047, legacy "mode A") is gone
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
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
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

// config is the tunnel POLICY file — the only thing a file may say. The
// allowlist half (docs/d047) is deleted with the reverse proxy (docs/d108),
// and the bind half is a flag (docs/d110): a config field that duplicates a
// CLI/env fact is a second spelling of one fact (docs/d090).
type config struct {
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

// writeFunnel404 answers every 404 this node can produce the way the
// tailscale funnel in front of it does: a bare, plain-text Go "404 page not
// found". Every path outside the tunnel namespace lands here — garbage, a
// stale reverse-proxy route from an older deployment, AND mode C's
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
	fmt.Fprintln(w, "404 page not found")
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
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Dispatch is by exact path — one namespace, no prefix table (docs/d073
	// VPN-R42). Anything else is the funnel's 404, which is what a client
	// from the deleted allowlist deployment gets: the route it still carries
	// is dead, and it learns nothing about why (docs/d108).
	if s.vpn != nil && s.vpn.isTunnelPath(r.URL.Path) {
		s.vpn.serveTunnel(w, r)
		return
	}
	writeFunnel404(w, r)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

func main() {
	// No subcommands: `generate` went with the allowlist it emitted (docs/d108)
	// and `smoke-test` went with the reverse-proxy behaviour it checked
	// (docs/d108) — each was a verb for a mode that no longer exists. Role
	// selection is `-mode`, and the launchers own every other verb.
	configPath := flag.String("config", "", "path to the tunnel policy file (optional; absent = the defaults, docs/d108)")
	listen := flag.String("listen", "", "listen address (default :8080)")
	// Role values are the node names, not protocol roles (docs/d088): the
	// process is always a mix of client, server, and both proxy shapes, so
	// only network position discriminates.
	mode := flag.String("mode", "exit", "process role: \"exit\" (the exit node: funnel front + tunnel server) or \"relay\" (the relay node: loopback CONNECT/SOCKS5 proxy feeding the tunnel, modes C–E; docs/d073 §7, docs/d088)")
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
		log.Fatalf("[estige] unknown -mode %q (want exit or relay)", *mode)
	}

	// The policy file is OPTIONAL and carries policy only: no allowlist (that
	// mode is gone), no credentials (env chain only, docs/d084), no bind (the
	// flag is the bind, docs/d110). Setting no file is a complete instruction;
	// NAMING one that cannot be read is a typo, and fails loudly rather than
	// silently serving the defaults the operator did not ask for.
	cfg := &config{}
	if *configPath == "" {
		log.Printf("[estige] no -config — tunnel policy defaults (docs/d108)")
	} else {
		loaded, err := loadConfig(*configPath)
		if err != nil {
			log.Fatalf("[estige] %v", err)
		}
		cfg = loaded
	}
	bind := ":8080"
	if *listen != "" {
		bind = *listen
	}

	s := &server{}
	armed := shouldArmTunnel(cfg.Tunnel, operatorCredentialInEnv())
	if armed {
		tn := cfg.Tunnel
		if tn == nil {
			tn = &tunnelConfig{}
		}
		if err := s.enableTunnel(tn); err != nil {
			log.Fatalf("[estige] tunnel: %v", err)
		}
	}
	// An exit node that is not armed would bind a port and answer 404 to
	// everything — indistinguishable from a healthy deployment behind a broken
	// front, and there is no other face left to serve. Fail loudly instead
	// (docs/d084's kill-switch law, now the only boot condition, docs/d108).
	if !armed {
		log.Fatalf("[estige] nothing to serve: no operator credential in the env (docs/d084)")
	}

	srv := &http.Server{
		Addr: bind,
		// Only guard against slowloris-style clients. Everything else is left
		// unlimited: LLM streams can legitimately run for many minutes.
		ReadHeaderTimeout: 30e9,
		Handler:           s,
	}

	log.Printf("[estige] listening on %s; tunnel at %s", bind, tunnelPath)
	log.Fatal(srv.ListenAndServe())
}
