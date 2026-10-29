package main

// relaychain_test.go — docs/d094 acceptance: the tunnel leg chains through
// the conventional proxy environment variables, the chain is a BLIND TCP
// tunnel (the proxy records a CONNECT/SOCKS hop to the tunnel host and
// never a credential), bad chain config refuses startup before any bind,
// and the ladder still rides whole through a chain (D here; the ALPN probe
// covers C's leg; E's transport shares the same dial).

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// clearChainEnv empties every chain variable through t.Setenv (restore on
// cleanup, no ambient leakage into or out of the case).
func clearChainEnv(t *testing.T) {
	t.Helper()
	for _, v := range chainEnvVars {
		t.Setenv(v, "")
	}
}

// chainFromEnv resolves the chain exactly as production does — the chain
// parser fed by env, for one tunnel-URL scheme.
func chainFromEnv(t *testing.T, tunnelScheme string, env map[string]string) (*chainProxy, error) {
	t.Helper()
	clearChainEnv(t)
	for k, v := range env {
		t.Setenv(k, v)
	}
	return relayChainFromEnv(&url.URL{Scheme: tunnelScheme})
}

func TestRelayChainFromEnvPrecedence(t *testing.T) {
	for _, tc := range []struct {
		name   string
		scheme string
		env    map[string]string
		kind   string
		addr   string
		errIs  string
	}{
		{name: "nothing set is direct", scheme: "wss", kind: ""},
		{name: "SOCKS_SERVER bare host:port", scheme: "wss",
			env:  map[string]string{"SOCKS_SERVER": "gate.corp:1081"},
			kind: "socks5", addr: "gate.corp:1081"},
		{name: "SOCKS_SERVER default port", scheme: "ws",
			env:  map[string]string{"SOCKS_SERVER": "gate.corp"},
			kind: "socks5", addr: "gate.corp:1080"},
		{name: "SOCKS_VERSION=5 explicit", scheme: "wss",
			env:  map[string]string{"SOCKS_SERVER": "gate:1080", "SOCKS_VERSION": "5"},
			kind: "socks5", addr: "gate:1080"},
		{name: "SOCKS_VERSION=4 refuses", scheme: "wss",
			env:   map[string]string{"SOCKS_SERVER": "gate:1080", "SOCKS_VERSION": "4"},
			errIs: "SOCKS_VERSION"},
		{name: "SOCKS_SERVER beats https_proxy", scheme: "wss",
			env:  map[string]string{"SOCKS_SERVER": "gate:1080", "https_proxy": "http://corp:3128"},
			kind: "socks5", addr: "gate:1080"},
		{name: "https_proxy matches a wss tunnel", scheme: "wss",
			env:  map[string]string{"https_proxy": "http://corp:3128"},
			kind: "http", addr: "corp:3128"},
		{name: "http_proxy matches a ws tunnel", scheme: "ws",
			env:  map[string]string{"http_proxy": "http://corp:3128", "https_proxy": "http://wrong:1"},
			kind: "http", addr: "corp:3128"},
		{name: "uppercase spelling works", scheme: "wss",
			env:  map[string]string{"HTTPS_PROXY": "http://corp:3128"},
			kind: "http", addr: "corp:3128"},
		{name: "ALL_PROXY fallback", scheme: "wss",
			env:  map[string]string{"ALL_PROXY": "socks5://gate:1080"},
			kind: "socks5", addr: "gate:1080"},
		{name: "scheme-less value means http", scheme: "ws",
			env:  map[string]string{"all_proxy": "corp:3128"},
			kind: "http", addr: "corp:3128"},
		{name: "socks5h is the socks5 kind", scheme: "wss",
			env:  map[string]string{"ALL_PROXY": "socks5h://gate:1080"},
			kind: "socks5", addr: "gate:1080"},
		{name: "userinfo is proxy credentials", scheme: "wss",
			env:  map[string]string{"ALL_PROXY": "http://user:secret@corp:3128"},
			kind: "http", addr: "corp:3128"},
		{name: "https-to-the-proxy refuses", scheme: "wss",
			env:   map[string]string{"ALL_PROXY": "https://corp:3128"},
			errIs: "scheme must be"},
		{name: "socks4 refuses", scheme: "wss",
			env:   map[string]string{"ALL_PROXY": "socks4://gate:1080"},
			errIs: "scheme must be"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := chainFromEnv(t, tc.scheme, tc.env)
			if tc.errIs != "" {
				if err == nil || !strings.Contains(err.Error(), tc.errIs) {
					t.Fatalf("err=%v, want containing %q", err, tc.errIs)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tc.kind == "" {
				if c != nil {
					t.Fatalf("want no chain, got %+v", c)
				}
				return
			}
			if c.kind != tc.kind || c.addr != tc.addr {
				t.Fatalf("chain=%+v, want kind=%s addr=%s", c, tc.kind, tc.addr)
			}
			if tc.env["ALL_PROXY"] == "http://user:secret@corp:3128" {
				if c.user != "user" || c.pass != "secret" {
					t.Fatalf("userinfo not parsed: %+v", c)
				}
			}
		})
	}
}

// TestRelayChainBadConfigRefusesStartup pins the VPN-R26 shape: the error
// surfaces through the ONE config path, before any bind.
func TestRelayChainBadConfigRefusesStartup(t *testing.T) {
	clearChainEnv(t)
	armTestTunnelEnv(t)
	t.Setenv(envTunnelURL, "wss://example.invalid:8443/vpn")
	t.Setenv("SOCKS_SERVER", "gate:1080")
	t.Setenv("SOCKS_VERSION", "4a")
	if _, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t)); err == nil || !strings.Contains(err.Error(), "SOCKS_VERSION") {
		t.Fatalf("err=%v, want the SOCKS_VERSION refusal from relayConfigFromEnv", err)
	}
}

// ---------------------------------------------------------------------------
// Chain proxy fixtures — the recorded view of a chained deployment
// ---------------------------------------------------------------------------

// chainHop is one recorded chain handshake: the authority the proxy was
// asked to open and every header it was given.
type chainHop struct {
	target string
	header http.Header
}

// newCONNECTChainProxy is an RFC 9110 CONNECT proxy that records each hop
// and tunnels bytes untouched — the corporate-proxy deployment shape
// docs/d094 exists for.
func newCONNECTChainProxy(t *testing.T) (string, func() []chainHop) {
	t.Helper()
	var mu sync.Mutex
	var hops []chainHop
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "want CONNECT", http.StatusMethodNotAllowed)
			return
		}
		mu.Lock()
		hops = append(hops, chainHop{target: r.Host, header: r.Header.Clone()})
		mu.Unlock()
		up, err := net.DialTimeout("tcp", r.Host, 5*time.Second)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		conn, brw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			up.Close()
			return
		}
		if _, err := brw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			up.Close()
			conn.Close()
			return
		}
		_ = brw.Flush()
		go func() { _, _ = io.Copy(up, conn); up.Close(); conn.Close() }()
		go func() { _, _ = io.Copy(conn, up); conn.Close(); up.Close() }()
	}))
	t.Cleanup(srv.Close)
	return srv.URL, func() []chainHop {
		mu.Lock()
		defer mu.Unlock()
		return append([]chainHop(nil), hops...)
	}
}

// newSOCKS5ChainProxy is an RFC 1928/1929 SOCKS5 proxy that records each
// CONNECT's authority. requireAuth forces the username/password method so
// the RFC 1929 client path gets exercised.
func newSOCKS5ChainProxy(t *testing.T, requireAuth bool) (string, func() []string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var mu sync.Mutex
	var targets []string
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
				up, ok := socks5FixtureHandshake(conn, requireAuth, func(target string) {
					mu.Lock()
					targets = append(targets, target)
					mu.Unlock()
				})
				if !ok {
					conn.Close()
					return
				}
				_ = conn.SetDeadline(time.Time{})
				go func() { _, _ = io.Copy(up, conn); up.Close(); conn.Close() }()
				go func() { _, _ = io.Copy(conn, up); conn.Close(); up.Close() }()
			}()
		}
	}()
	return ln.Addr().String(), func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), targets...)
	}
}

// chainFetch opens one local CONNECT and pulls one response through the
// relay — the modeEFetch shape with its own body string.
func chainFetch(t *testing.T, httpAddr, targetHost string, upPort uint16) {
	t.Helper()
	conn := rawDial(t, httpAddr)
	defer conn.Close()
	mustWrite(t, conn, "CONNECT "+targetHost+":"+strconv.Itoa(int(upPort))+" HTTP/1.1\r\nHost: "+targetHost+":"+strconv.Itoa(int(upPort))+"\r\n\r\n"+
		"GET /chain HTTP/1.1\r\nHost: local.test\r\nConnection: close\r\n\r\n")
	br := bufio.NewReader(conn)
	status, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("CONNECT status: %v", err)
	}
	if !strings.Contains(status, " 200 ") {
		t.Fatalf("CONNECT refused: %q", strings.TrimSpace(status))
	}
	resp := readHTTPResponse(t, br)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "hello-chain" || resp.Header.Get("X-Upstream") != "yes" {
		t.Fatalf("status=%d body=%q upstream-header=%q", resp.StatusCode, body, resp.Header.Get("X-Upstream"))
	}
}

func newChainUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	return newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Upstream", "yes")
		_, _ = io.WriteString(w, "hello-chain")
	}))
}

// TestRelayChainHTTPProxyCarriesTunnel: mode D rides a CONNECT chain. The
// proof the chain was actually used is the proxy's recorded hop — the
// relay node dials NOTHING around it.
func TestRelayChainHTTPProxyCarriesTunnel(t *testing.T) {
	upstream := newChainUpstream(t)
	upPort := portOf(t, upstream.Listener.Addr().String())
	_, backend := modeETestServer(t, upstream)

	proxyURL, hops := newCONNECTChainProxy(t)
	clearChainEnv(t)
	t.Setenv("http_proxy", proxyURL)

	httpAddr, stop := wireRelayNode(t, "http://"+backend.Listener.Addr().String()+tunnelPath)
	defer stop()

	chainFetch(t, httpAddr, "localhost", upPort)

	recorded := hops()
	tunnelAddr := backend.Listener.Addr().String()
	if len(recorded) != 1 {
		t.Fatalf("chain hops=%d, want exactly 1 (one session, ladder skips C on ws://); hops=%+v", len(recorded), recorded)
	}
	if recorded[0].target != tunnelAddr {
		t.Fatalf("chain hop target=%q, want the tunnel endpoint %q", recorded[0].target, tunnelAddr)
	}
	for _, h := range recorded {
		if h.header.Get("Authorization") != "" || h.header.Get("Proxy-Authorization") != "" {
			t.Fatalf("credential visible to the chain proxy: %v", h.header)
		}
	}

	// /healthz reports the chain beside the tunnel endpoint (host only).
	resp, err := http.Get("http://" + httpAddr + healthPath)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var status map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if got, _ := status["chain"].(string); !strings.HasPrefix(got, "http://") || !strings.Contains(got, proxyHostOf(t, proxyURL)) {
		t.Fatalf("health chain=%v, want the proxy host", status["chain"])
	}
}

// TestRelayChainSOCKS5ProxyCarriesTunnelModeE: the D-refused → E demotion
// rides a SOCKS5 chain (RFC 1928 path, name crossing unresolved), proving
// the chain is the ROUTE — the ladder ranks transports above it unchanged
// (docs/d093 over docs/d094).
func TestRelayChainSOCKS5ProxyCarriesTunnelModeE(t *testing.T) {
	upstream := newChainUpstream(t)
	upPort := portOf(t, upstream.Listener.Addr().String())
	_, backend := modeETestServer(t, upstream)
	gateway := newHostileGateway(t, backend)

	socksAddr, targets := newSOCKS5ChainProxy(t, false)
	clearChainEnv(t)
	t.Setenv("SOCKS_SERVER", socksAddr)

	httpAddr, stop := wireRelayNode(t, "http://"+gateway.Listener.Addr().String()+tunnelPath)
	defer stop()
	logBuf := captureLog(t)

	chainFetch(t, httpAddr, "localhost", upPort)

	waitForLog(t, logBuf, "transport=post")
	recorded := targets()
	tunnelAddr := gateway.Listener.Addr().String()
	found := false
	for _, target := range recorded {
		if target == tunnelAddr {
			found = true
		}
	}
	if !found {
		t.Fatalf("socks chain targets=%v, want the tunnel endpoint %q", recorded, tunnelAddr)
	}
}

// TestALPNProbeRidesHTTPChain: mode C's leg — the disposable ALPN probe —
// also dials through the chain, TLS end-to-end above it.
func TestALPNProbeRidesHTTPChain(t *testing.T) {
	backend := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	front := newTLSFront(t, backend, true)

	proxyURL, hops := newCONNECTChainProxy(t)
	chain, err := parseChainProxy(proxyURL)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(front.URL)
	if err != nil {
		t.Fatal(err)
	}
	u.Scheme = "wss"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	proto, err := alpnNegotiate(ctx, u, []string{"h2", "http/1.1"}, chain.dial)
	if err != nil {
		t.Fatalf("alpnNegotiate over chain: %v", err)
	}
	if proto != "h2" {
		t.Fatalf("proto=%q, want h2 through the chain", proto)
	}
	recorded := hops()
	if len(recorded) != 1 || recorded[0].target != front.Listener.Addr().String() {
		t.Fatalf("chain hops=%+v, want one hop to %s", recorded, front.Listener.Addr())
	}
}

// TestSOCKS5ChainCredentials pins the RFC 1929 client path against a
// requiring proxy, and the fail-closed refusal when none are configured.
func TestSOCKS5ChainCredentials(t *testing.T) {
	upstream := newChainUpstream(t)
	target := upstream.Listener.Addr().String()
	proxyAddr, _ := newSOCKS5ChainProxy(t, true)

	withCreds, err := parseChainProxy("socks5://u1:rusty@" + proxyAddr)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := withCreds.dial(ctx, "tcp", target)
	if err != nil {
		t.Fatalf("socks5 chain with credentials: %v", err)
	}
	defer conn.Close()
	mustWrite(t, conn, "GET /chain HTTP/1.1\r\nHost: local.test\r\nConnection: close\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "hello-chain" {
		t.Fatalf("body=%q, want hello-chain", body)
	}

	withoutCreds, err := parseChainProxy("socks5://" + proxyAddr)
	if err != nil {
		t.Fatal(err)
	}
	// The proxy refuses the no-auth offer outright (0xFF); the client must
	// fail closed rather than downgrade — the proxy's choice is its own.
	if _, err := withoutCreds.dial(ctx, "tcp", target); err == nil || !strings.Contains(err.Error(), "no acceptable auth method") {
		t.Fatalf("err=%v, want the auth-method refusal", err)
	}
}

// proxyHostOf extracts host:port from a proxy URL for log/health asserts.
func proxyHostOf(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Host
}

// socks5FixtureHandshake is the proxy half of RFC 1928/1929, split out of
// the accept loop so the conn's ownership stays unambiguous: false means
// the caller closes it, true hands the upstream conn to pipe goroutines
// that own BOTH conns' lifetime (a defer-close in the handshake goroutine
// would kill every tunnel the instant the handshake returned).
// The RFC 1929 frame is [VER ULEN UNAME PLEN PASSWD] — VER first.
func socks5FixtureHandshake(conn net.Conn, requireAuth bool, record func(string)) (net.Conn, bool) {
	var head [2]byte
	if _, err := io.ReadFull(conn, head[:]); err != nil || head[0] != socksVersion {
		return nil, false
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return nil, false
	}
	method := byte(socksNoAuth)
	if requireAuth {
		method = 2
	}
	if !containsByte(methods, method) {
		_, _ = conn.Write([]byte{socksVersion, 0xff})
		return nil, false
	}
	if _, err := conn.Write([]byte{socksVersion, method}); err != nil {
		return nil, false
	}
	if method == 2 {
		var ver [1]byte
		if _, err := io.ReadFull(conn, ver[:]); err != nil {
			return nil, false
		}
		var ul [1]byte
		if _, err := io.ReadFull(conn, ul[:]); err != nil {
			return nil, false
		}
		if _, err := io.ReadFull(conn, make([]byte, int(ul[0]))); err != nil {
			return nil, false
		}
		var pl [1]byte
		if _, err := io.ReadFull(conn, pl[:]); err != nil {
			return nil, false
		}
		if _, err := io.ReadFull(conn, make([]byte, int(pl[0]))); err != nil {
			return nil, false
		}
		if _, err := conn.Write([]byte{1, 0}); err != nil {
			return nil, false
		}
	}
	var req [4]byte
	if _, err := io.ReadFull(conn, req[:]); err != nil || req[1] != 1 {
		return nil, false
	}
	var host string
	switch req[3] {
	case 1:
		var b [4]byte
		if _, err := io.ReadFull(conn, b[:]); err != nil {
			return nil, false
		}
		host = net.IP(b[:]).String()
	case 4:
		var b [16]byte
		if _, err := io.ReadFull(conn, b[:]); err != nil {
			return nil, false
		}
		host = net.IP(b[:]).String()
	case 3:
		var l [1]byte
		if _, err := io.ReadFull(conn, l[:]); err != nil {
			return nil, false
		}
		name := make([]byte, int(l[0]))
		if _, err := io.ReadFull(conn, name); err != nil {
			return nil, false
		}
		host = string(name)
	default:
		return nil, false
	}
	var pb [2]byte
	if _, err := io.ReadFull(conn, pb[:]); err != nil {
		return nil, false
	}
	target := net.JoinHostPort(host, strconv.Itoa(int(pb[0])<<8|int(pb[1])))
	record(target)
	up, err := net.DialTimeout("tcp", target, 5*time.Second)
	if err != nil {
		_, _ = conn.Write([]byte{socksVersion, 0x05, 0, 1, 0, 0, 0, 0, 0, 0})
		return nil, false
	}
	if _, err := conn.Write([]byte{socksVersion, 0, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
		up.Close()
		return nil, false
	}
	return up, true
}
