// llm-reverse-proxy — a dumb, faithful reverse proxy for LLM APIs.
//
// Requests to  http://<host>:<port>/<provider>/<path>?<query>  are forwarded,
// byte for byte, to the upstream base URL configured for <provider>. No model
// routing, no credential handling (callers must already carry valid provider
// keys), no request or response rewriting. Streaming responses (SSE, NDJSON,
// raw chunked) are flushed to the client as they arrive from upstream.
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
	"strings"
	"syscall"
)

const problemTypeBase = "urn:llm-reverse-proxy:error:"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type config struct {
	Listen    string            `json:"listen"`
	Providers map[string]string `json:"providers"`
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

// stripPrefix returns a handler that removes "/<name>" from the request path
// before proxying, so /openrouter/v1/chat/completions hits the upstream at
// <base>/v1/chat/completions.
func (p *provider) handler() http.Handler {
	return http.StripPrefix("/"+p.name, p.proxy)
}

// ---------------------------------------------------------------------------
// Error classification → RFC 9457 problem details
// ---------------------------------------------------------------------------

type problem struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Status   int    `json:"status"`
	Detail   string `json:"detail,omitempty"`
	Code     string `json:"code,omitempty"`           // extension: machine-readable cause
	Raw      string `json:"upstream_error,omitempty"` // extension: verbatim Go error
	Instance string `json:"instance,omitempty"`
}

func writeProblem(w http.ResponseWriter, r *http.Request, status int, code, title, detail, raw string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(problem{
		Type:     problemTypeBase + code,
		Title:    title,
		Status:   status,
		Detail:   detail,
		Code:     code,
		Raw:      raw,
		Instance: r.URL.RequestURI(),
	})
}

// classify maps a proxy-side failure to (code, title). The raw error text is
// always attached verbatim, so nothing is lost even when classification is
// best-effort.
func classify(err error) (code, title string) {
	raw := err.Error()

	// DNS failures (wrap *net.OpError → *net.DNSError).
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		rcode := "UNKNOWN"
		switch {
		case dnsErr.IsNotFound:
			rcode = "NXDOMAIN"
		case dnsErr.IsTimeout:
			rcode = "TIMEOUT"
		case strings.Contains(raw, "server misbehaving"):
			rcode = "SERVFAIL"
		case strings.Contains(raw, "refused"):
			rcode = "REFUSED"
		}
		resolver := dnsErr.Server
		if resolver == "" {
			resolver = "system resolver"
		}
		return "dns-" + strings.ToLower(rcode),
			fmt.Sprintf("DNS lookup for upstream host %q failed", dnsErr.Name)
	}

	// TLS certificate verification failures.
	var verifyErr *tls.CertificateVerificationError
	if errors.As(err, &verifyErr) {
		code := "tls-verification-failed"
		switch {
		case strings.Contains(raw, "self-signed certificate"):
			code = "tls-self-signed-cert"
		case strings.Contains(raw, "certificate has expired"), strings.Contains(raw, "certificate is not yet valid"):
			code = "tls-cert-expired"
		case strings.Contains(raw, "certificate is valid for"):
			code = "tls-hostname-mismatch"
		case strings.Contains(raw, "signed by unknown authority"):
			code = "tls-unknown-authority"
		}
		return code, "TLS certificate verification of the upstream failed"
	}

	// TCP / OS-level connection errors.
	for _, m := range []struct {
		errno error
		code  string
		title string
	}{
		{syscall.ECONNREFUSED, "tcp-econnrefused", "Nothing is listening on the upstream address (ECONNREFUSED)"},
		{syscall.ECONNRESET, "tcp-econnreset", "The upstream reset the connection (ECONNRESET)"},
		{syscall.EPIPE, "tcp-broken-pipe", "The upstream connection broke (EPIPE)"},
		{syscall.ENETUNREACH, "tcp-netunreachable", "The upstream network is unreachable (ENETUNREACH)"},
		{syscall.EHOSTUNREACH, "tcp-hostunreachable", "The upstream host is unreachable (EHOSTUNREACH)"},
		{syscall.ETIMEDOUT, "tcp-etimedout", "The upstream connection timed out (ETIMEDOUT)"},
	} {
		if errors.Is(err, m.errno) {
			return m.code, m.title
		}
	}

	// Transport timeouts.
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "upstream-timeout", "The upstream timed out"
	}

	// Upstream hung up before the response completed.
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || strings.Contains(raw, "unexpected EOF") {
		return "upstream-disconnected", "The upstream closed the connection before completing the response"
	}

	return "upstream-error", "The upstream request failed"
}

// proxyError is called by ReverseProxy when the upstream exchange fails before
// any response bytes reach the client — the one place we may still send a 502.
func (p *provider) proxyError(w http.ResponseWriter, r *http.Request, err error) {
	// Client hung up first: nothing to report, and nobody to report to.
	if r.Context().Err() != nil || errors.Is(err, context.Canceled) {
		log.Printf("[llm-reverse-proxy] %s%s: client cancelled request: %v", p.name, r.URL.Path, err)
		return
	}

	code, title := classify(err)
	detail := fmt.Sprintf("while proxying %s%s to %s: %s", p.name, r.URL.RequestURI(), p.target.Host, err.Error())
	log.Printf("[llm-reverse-proxy] 502 %s %s%s → %s: %v", code, p.name, r.URL.RequestURI(), p.target.Host, err)
	writeProblem(w, r, http.StatusBadGateway, code, title, detail, err.Error())
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

type server struct {
	providers map[string]*provider
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name, _, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")

	// Every 404 this relay can produce answers the way the tailscale funnel
	// in front of it does: a bare, plain-text Go "404 page not found". This
	// includes unknown provider prefixes and garbage paths — a JSON error
	// body (even a URN-shaped RFC 9457 one) would act as a probe oracle,
	// confirming "custom software lives here" and inviting more probing. The
	// funnel's prefix filtering already stops most garbage; whatever gets
	// through must learn nothing: no routing table, no provider names, no
	// distinguishable fingerprint between a real route and a dead one.
	//
	// RFC 9457 problem details remain only for INTERNAL failures (bad-gateway
	// conditions: DNS, TCP, TLS, upstream disconnects) — those carry provider
	// context the operator already knows, and the request got as far as a
	// configured upstream, so no extra oracle is handed out. Operators debug
	// unknown-prefix mistakes from the proxy logs, not the response.
	funnel404 := func() {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintln(w, "404 page not found")
	}
	if name == "" {
		funnel404()
		return
	}

	p, ok := s.providers[name]
	if !ok {
		log.Printf("[llm-reverse-proxy] 404 %s %s (no provider %q) → funnel-style 404", r.Method, r.URL.RequestURI(), name)
		funnel404()
		return
	}
	p.handler().ServeHTTP(w, r)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

func main() {
	configPath := flag.String("config", "llm-reverse-proxy.json", "path to JSON config")
	listen := flag.String("listen", "", "override listen address (e.g. :8080)")
	flag.Parse()

	cfg, err := loadConfig(*configPath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Fatalf("[llm-reverse-proxy] %v", err)
		}
		// No config file: allow pure-flag usage (-listen + provider URLs on
		// the command line is not supported; require the file).
		log.Fatalf("[llm-reverse-proxy] config %s not found; create it, e.g. {\"listen\":\":8080\",\"providers\":{\"openrouter\":\"https://openrouter.ai/api\"}}", *configPath)
	}
	if *listen != "" {
		cfg.Listen = *listen
	}
	if cfg.Listen == "" {
		cfg.Listen = ":8080"
	}

	s := &server{providers: make(map[string]*provider, len(cfg.Providers))}
	for name, raw := range cfg.Providers {
		p, err := newProvider(name, raw)
		if err != nil {
			log.Fatalf("[llm-reverse-proxy] %v", err)
		}
		s.providers[name] = p
	}
	if len(s.providers) == 0 {
		log.Fatalf("[llm-reverse-proxy] no providers configured in %s", *configPath)
	}

	srv := &http.Server{
		Addr: cfg.Listen,
		// Only guard against slowloris-style clients. Everything else is left
		// unlimited: LLM streams can legitimately run for many minutes.
		ReadHeaderTimeout: 30e9,
		Handler:           s,
	}

	log.Printf("[llm-reverse-proxy] listening on %s; %d provider(s):", cfg.Listen, len(s.providers))
	for _, name := range s.providers {
		log.Printf("[llm-reverse-proxy]   /%s/ → %s", name.name, name.target)
	}
	log.Fatal(srv.ListenAndServe())
}
