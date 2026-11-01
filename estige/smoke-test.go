// smoke-test.go — `estige smoke-test`: the behavioural smoke test for the
// v2 host-allowlist mode only (docs/d047), ported from smoke-test.sh
// (docs/d102 — all-golang tooling).
//
// Why Go: the shell version needed bash + curl + node (the local echo/SSE
// upstream) + python3 (catalog-shape assertions) on the host under test.
// The port keeps the CHECK VOCABULARY byte-stable ("ok   name" / "FAIL
// name: expected *want* got: got" / "skip name: reason" / the final
// "passed=N failed=N skipped=N" line) so operators and scripts see no
// change, but the only requirements now are the binary itself and — for
// the TLS and catalog sections — outbound internet (skipped/present the
// same way as before). Being a subcommand of the proxy binary also kills
// the build-if-missing step: the binary IS the thing under test.
//
// Structure, in parity with the shell version:
//
//   - pre-flight: the fixed test ports (upstream 19091, proxy 18101) must
//     not answer before anything starts — a stale instance makes the run
//     race, so check, don't race;
//   - an in-process echo upstream (method/url/auth/body echo, an SSE
//     stream, a 429) on 127.0.0.1:19091;
//   - a child estige process (-config <tmp>/estige.json) on 127.0.0.1:18101
//     with an allowlist of the loopback upstream, dead hosts, and the
//     badssl.com TLS-failure hosts;
//   - 34 checks: passthrough fidelity, unbuffered streaming (first-chunk
//     latency RELATIVE to a direct baseline — an absolute threshold
//     misclassifies unbuffered proxies on slow hosts), upstream-error
//     passthrough, RFC 9457 502 classes (econnrefused, dnserror, TLS
//     verification), catalog passthroughs (models.dev, catwalk), and the
//     404-camouflage negatives (every denial is the exact plain-text 404,
//     no fingerprint leak).
//
// Exit: 0 iff every non-skipped check passed (fatal setup problems exit 1).
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	smokeUpstreamAddr = "127.0.0.1:19091"
	smokeProxyAddr    = "127.0.0.1:18101"
	smokeProxyBase    = "http://127.0.0.1:18101"
	smokeUpstreamBase = "http://127.0.0.1:19091"
	// The exact denial body any unknown host/path must answer — a
	// distinctive body would be a probe oracle for "custom software lives
	// here" (docs/d047's anti-oracle answer).
	smoke404Body = "404 page not found"
)

// smokeEnv carries the running tally and the fixed clients — one struct so
// the check helpers cannot drift from the counters they bump.
type smokeEnv struct {
	pass, fail, skip int
	// proxyClient dials the loopback proxy directly with NO env proxy and
	// NO timeouts by default (streams can legitimately run long); callers
	// that need a bound attach their own context.
	proxyClient *http.Client
	// badsslClient trusts nothing (the precheck must reach expired certs —
	// curl -sk was the shell equivalent).
	badsslClient *http.Client
}

func (e *smokeEnv) check(name, want, got string) {
	if strings.Contains(got, want) {
		e.pass++
		fmt.Printf("ok   %s\n", name)
		return
	}
	e.fail++
	fmt.Printf("FAIL %s: expected *%s* got: %s\n", name, want, got)
}

func (e *smokeEnv) checkf(name string, ok bool, detail string) {
	if ok {
		e.pass++
		fmt.Printf("ok   %s\n", name)
		return
	}
	e.fail++
	fmt.Printf("FAIL %s: %s\n", name, detail)
}

func (e *smokeEnv) skipOne(name, reason string) {
	e.skip++
	fmt.Printf("skip %s: %s\n", name, reason)
}

// runSmokeTest is the `smoke-test` subcommand. args is accepted and ignored
// (the shell script took none either) — future knobs would be flags.
func runSmokeTest(args []string) int {
	// Pre-flight: check, don't race (the shell version's own rule — a
	// stale instance answering the wait-loop's probe makes the run lie).
	for _, port := range []string{smokeUpstreamAddr, smokeProxyAddr} {
		if conn, err := net.DialTimeout("tcp", port, time.Second); err == nil {
			conn.Close()
			fatalf(1, "port %s already answering — a stale upstream/proxy is running; kill it first", port)
		}
	}

	tmp, err := os.MkdirTemp("", "estige-smoke-")
	if err != nil {
		fatalf(1, "temp dir: %v", err)
	}
	defer os.RemoveAll(tmp)

	env := &smokeEnv{
		proxyClient: &http.Client{Transport: &http.Transport{Proxy: nil}},
		badsslClient: &http.Client{
			Transport: &http.Transport{
				Proxy:           nil,
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // badssl.com IS broken TLS on purpose
			},
			Timeout: 5 * time.Second,
		},
	}

	// In-process upstream (was `node upstream.mjs`): echo + SSE stream +
	// a self-declared 429. The listener is synchronous — a bind failure is
	// a FATAL, same as the shell's EADDRINUSE guard.
	upstream := &http.Server{Handler: smokeUpstreamHandler()}
	ln, err := net.Listen("tcp", smokeUpstreamAddr)
	if err != nil {
		fatalf(1, "port %s already bound — a stale upstream is running; kill it first", smokeUpstreamAddr)
	}
	go upstream.Serve(ln)
	defer upstream.Close()

	if err := writeSmokeConfig(filepath.Join(tmp, "estige.json")); err != nil {
		fatalf(1, "config write: %v", err)
	}

	exe, err := os.Executable()
	if err != nil {
		fatalf(1, "cannot locate the running estige binary: %v", err)
	}
	var proxyLog bytes.Buffer
	proxy := exec.Command(exe, "-config", "estige.json")
	proxy.Dir = tmp
	// Strip the conventional proxy variables from the child. The proxy
	// dials upstreams through http.DefaultTransport (newProvider sets no
	// Transport — ProxyFromEnvironment is the stdlib default, so an
	// operator's chain env is honoured by the deployed process), but this
	// test asserts THE PROXY's dial behavior: with http_proxy pointing at
	// a live relay (the chain-step variables, docs/d094), a non-loopback
	// host route would answer with whatever that relay says instead of the
	// proxy's own 502/404 classes — an env-dependent flake the shell
	// version inherited silently. Everything else passes through.
	proxy.Env = withoutProxyEnv(os.Environ())
	proxy.Stdout = &proxyLog
	proxy.Stderr = &proxyLog
	if err := proxy.Start(); err != nil {
		fatalf(1, "proxy start: %v", err)
	}
	defer func() {
		proxy.Process.Kill()
		proxy.Wait()
	}()
	waitFor(env, smokeProxyBase+"/", 5*time.Second)
	// Same staleness guard as the shell version: otherwise every local
	// check hits whatever old instance holds the port.
	if strings.Contains(proxyLog.String(), "bind: address already in use") {
		fatalf(1, "port %s already bound — a stale estige is running; kill it first", smokeProxyAddr)
	}

	// --- passthrough: method, path join, query, auth header, body --------
	r := env.post(smokeProxyBase + "/127.0.0.1:19091/v1/chat/completions?beta=true")
	env.check("passthrough-method", `"method":"POST"`, r)
	env.check("passthrough-path", "/v1/chat/completions?beta=true", r)
	env.check("passthrough-auth", `"auth":"Bearer sk-t"`, r)
	env.check("passthrough-body", `{\"m\":1}`, r)

	// --- streaming: unbuffered (relative threshold, see the header) ------
	directBase, _ := env.firstChunkLatency(smokeUpstreamBase + "/v1/stream")
	proxyDt, proxyFirst := env.firstChunkLatency(smokeProxyBase + "/127.0.0.1:19091/v1/stream")
	env.check("streaming-chunk", "data: chunk 0", proxyFirst)
	if proxyDt <= directBase+150*time.Millisecond {
		env.pass++
		fmt.Printf("ok   streaming-unbuffered (first chunk after %dms; direct baseline %dms)\n", proxyDt.Milliseconds(), directBase.Milliseconds())
	} else {
		env.fail++
		fmt.Printf("FAIL streaming-unbuffered: first chunk after %dms vs direct baseline %dms (buffering?)\n", proxyDt.Milliseconds(), directBase.Milliseconds())
	}

	// --- upstream errors pass through untouched --------------------------
	env.check("upstream-4xx-passthrough", "rate limited by upstream itself", env.get(smokeProxyBase+"/127.0.0.1:19091/v1/error"))

	// --- RFC 9457 internal errors — transport / DNS ----------------------
	for _, spec := range []struct{ host, typ string }{
		{"127.0.0.1:1", "econnrefused"},
		{"no-such-host-estige-smoketest.invalid", "dnserror"},
	} {
		body := env.get(smokeProxyBase + "/" + spec.host + "/v1/models")
		env.check("502-"+spec.host, `"type":"`+spec.typ, body)
		env.check("502-"+spec.host+"-status", `"status":502`, body)
	}
	nx := env.get(smokeProxyBase + "/no-such-host-estige-smoketest.invalid/v1/models")
	env.check("502-nxdomain-details", `"details":{`, nx)
	env.check("502-nxdomain-details-isnotfound", `"isNotFound":true`, nx)
	env.check("502-nxdomain-no-urn", "0", fmt.Sprint(strings.Count(nx, "urn:")))

	// --- RFC 9457 internal errors — TLS verification (badssl.com) --------
	if _, err := env.badsslClient.Get("https://expired.badssl.com/"); err != nil {
		env.skipOne("tls-badssl", "badssl.com unreachable (no outbound internet)")
	} else {
		for _, host := range []string{
			"expired.badssl.com", "wrong.host.badssl.com",
			"self-signed.badssl.com", "untrusted-root.badssl.com",
		} {
			// Check names keep the shell version's full-host spelling.
			body := env.get(smokeProxyBase + "/" + host + "/v1/models")
			env.check("502-"+host, `"type":"tls-verification-failed"`, body)
		}
		for _, spec := range []struct{ label, host string }{
			{"expired", "expired.badssl.com"},
			{"wronghost", "wrong.host.badssl.com"},
			{"selfsigned", "self-signed.badssl.com"},
			{"untrustedroot", "untrusted-root.badssl.com"},
		} {
			env.check("502-"+spec.label+"-status", `"status":502`, env.get(smokeProxyBase+"/"+spec.host+"/v1/models"))
		}
		// no revocation / pinning enforcement: these must stream as 200
		env.check("passthrough-revoked-200", "200", fmt.Sprint(env.getStatusCode(smokeProxyBase+"/revoked.badssl.com/")))
		env.check("passthrough-pinning-200", "200", fmt.Sprint(env.getStatusCode(smokeProxyBase+"/pinning-test.badssl.com/")))
	}

	// --- catalog passthroughs (public JSON endpoints via the routes) -----
	{
		var doc map[string]json.RawMessage
		body := env.getWithTimeout(smokeProxyBase+"/models.dev/api.json", 15*time.Second)
		err := json.Unmarshal([]byte(body), &doc)
		env.checkf("passthrough-models-dev", err == nil && len(doc) >= 100, "relay did not return a valid catalog")
	}
	{
		var list []map[string]json.RawMessage
		body := env.getWithTimeout(smokeProxyBase+"/catwalk.charm.land/v2/providers", 15*time.Second)
		err := json.Unmarshal([]byte(body), &list)
		ok := err == nil && len(list) >= 20
		if ok {
			for _, p := range list {
				if _, has := p["models"]; !has {
					ok = false
					break
				}
			}
		}
		env.checkf("passthrough-catwalk", ok, "relay did not return a valid provider catalog")
	}

	// --- 404 camouflage: every denial is the exact plain-text answer -----
	// v2 negatives included (docs/d047): a v1 slug form (/openrouter/…)
	// and an unknown host are denied by absence exactly like garbage.
	var leakSrc bytes.Buffer
	for _, path := range []string{
		"/", "/nosuch/v1/models", "/openrouter/v1/models",
		"/unknown-host.example/v1/models", "/wp-login.php", "/.env", "/api/v1/models",
	} {
		resp, err := env.proxyClient.Get(smokeProxyBase + path)
		if err != nil {
			env.fail++
			fmt.Printf("FAIL 404-camouflage %s: %v\n", path, err)
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		// Command substitution in the shell version stripped trailing
		// newlines before the compare; match that (the body IS
		// "404 page not found\n").
		got := strings.TrimRight(string(body), "\r\n")
		ct := resp.Header.Get("Content-Type")
		ok := got == smoke404Body && resp.StatusCode == 404 && ct == "text/plain; charset=utf-8"
		if ok {
			env.pass++
			fmt.Printf("ok   404-camouflage %s\n", path)
		} else {
			env.fail++
			fmt.Printf("FAIL 404-camouflage %s: got [%s] code=%d\n", path, got, resp.StatusCode)
		}
		if path == "/" || path == "/nosuch/v1/models" || path == "/wp-login.php" {
			leakSrc.Write(body)
		}
	}
	leak := strings.Contains(leakSrc.String(), "openrouter") ||
		strings.Contains(leakSrc.String(), "nvidia") ||
		strings.Contains(leakSrc.String(), "estige") ||
		strings.Contains(leakSrc.String(), "urn:")
	env.checkf("404-no-fingerprint-leak", !leak, "denial bodies leaked a routing-table token")

	fmt.Printf("\npassed=%d failed=%d skipped=%d\n", env.pass, env.fail, env.skip)
	if env.fail > 0 {
		return 1
	}
	return 0
}

// --- helpers ---------------------------------------------------------------

func fatalf(code int, format string, a ...any) {
	fmt.Fprintf(os.Stderr, "FATAL: "+format+"\n", a...)
	os.Exit(code)
}

// withoutProxyEnv drops the conventional proxy variables (any case) so the
// child dials upstreams directly — see the child-env comment where it is
// applied. no_proxy goes too: with the others gone it could only confuse.
func withoutProxyEnv(environ []string) []string {
	isProxyVar := func(kv string) bool {
		name, _, _ := strings.Cut(kv, "=")
		switch strings.ToLower(name) {
		case "http_proxy", "https_proxy", "all_proxy", "no_proxy":
			return true
		}
		return false
	}
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		if !isProxyVar(kv) {
			out = append(out, kv)
		}
	}
	return out
}

// waitFor polls url until any HTTP answer (the shell's curl wait loop) — the
// proxy binds asynchronously under exec, so the first request can race it.
func waitFor(e *smokeEnv, url string, limit time.Duration) {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if resp, err := e.proxyClient.Get(url); err == nil {
			resp.Body.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	fatalf(1, "%s did not answer within %v", url, limit)
}

// get / post / helpers return the BODY (curl -s parity); timeouts are
// attached where the shell had --max-time.
func (e *smokeEnv) get(url string) string { return e.getWithTimeout(url, 0) }

func (e *smokeEnv) getWithTimeout(url string, timeout time.Duration) string {
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if timeout > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		req = req.WithContext(ctx)
	}
	resp, err := e.proxyClient.Do(req)
	if err != nil {
		return fmt.Sprintf("request failed: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return string(body)
}

func (e *smokeEnv) post(url string) string {
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(`{"m":1}`))
	req.Header.Set("Authorization", "Bearer sk-t")
	resp, err := e.proxyClient.Do(req)
	if err != nil {
		return fmt.Sprintf("request failed: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return string(body)
}

func (e *smokeEnv) getStatusCode(url string) int {
	resp, err := e.proxyClient.Get(url)
	if err != nil {
		return 0
	}
	resp.Body.Close()
	return resp.StatusCode
}

// firstChunkLatency measures how long the FIRST SSE line takes to arrive
// (curl -sN | head -1 parity) — the unbuffered-streaming signal.
func (e *smokeEnv) firstChunkLatency(url string) (time.Duration, string) {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := e.proxyClient.Do(req)
	if err != nil {
		return time.Since(start), ""
	}
	defer resp.Body.Close()
	line, _ := bufio.NewReader(resp.Body).ReadString('\n')
	return time.Since(start), strings.TrimRight(line, "\r\n")
}

// smokeUpstreamHandler is the local echo upstream: SSE stream, self-declared
// 429, and a method/url/auth/body/host echo — everything the passthrough
// checks assert against, nothing else.
func smokeUpstreamHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/stream"):
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			flusher, _ := w.(http.Flusher)
			for i := 0; i < 5; i++ {
				fmt.Fprintf(w, "data: chunk %d\n\n", i)
				if flusher != nil {
					flusher.Flush()
				}
				time.Sleep(100 * time.Millisecond)
			}
			fmt.Fprint(w, "data: [DONE]\n\n")
		case strings.HasPrefix(r.URL.Path, "/v1/error"):
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			fmt.Fprint(w, `{"error":{"message":"rate limited by upstream itself"}}`)
		default:
			body, _ := io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "application/json")
			var auth any = r.Header.Get("Authorization")
			if auth == "" {
				auth = nil
			}
			json.NewEncoder(w).Encode(map[string]any{
				"method": r.Method, "url": r.URL.RequestURI(),
				"auth": auth, "body": string(body), "host": r.Host,
			})
		}
	})
	return mux
}

// writeSmokeConfig is the v2 host-allowlist fixture (docs/d047): the
// loopback upstream keys on host:port, dead hosts carry the transport/DNS
// 502 classes, and the badssl hosts key on their DNS names.
func writeSmokeConfig(path string) error {
	// Anonymous on purpose: the fixture is the only writer of this shape since
	// the generator that owned it was deleted (docs/d108), and field order is
	// the contract json.MarshalIndent emits.
	doc := struct {
		Listen     string            `json:"listen"`
		AllowHosts map[string]string `json:"allowHosts"`
	}{
		Listen: smokeProxyAddr,
		AllowHosts: map[string]string{
			smokeUpstreamAddr:                       smokeUpstreamBase,
			"127.0.0.1:1":                           "http://127.0.0.1:1",
			"no-such-host-estige-smoketest.invalid": "http://no-such-host-estige-smoketest.invalid",
			"expired.badssl.com":                    "https://expired.badssl.com",
			"wrong.host.badssl.com":                 "https://wrong.host.badssl.com",
			"self-signed.badssl.com":                "https://self-signed.badssl.com",
			"untrusted-root.badssl.com":             "https://untrusted-root.badssl.com",
			"revoked.badssl.com":                    "https://revoked.badssl.com",
			"pinning-test.badssl.com":               "https://pinning-test.badssl.com",
			"models.dev":                            "https://models.dev",
			"catwalk.charm.land":                    "https://catwalk.charm.land",
		},
	}
	body, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(body, '\n'), 0o644)
}
