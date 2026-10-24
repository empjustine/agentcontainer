package main

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	// These are what the ENV carries; enableModeC is driven through t.Setenv
	// so tests exercise the production construction path, not a shortcut.
	testTunnelPrefix = "cap-abcdefghijklmnopqrst"
	testTunnelToken  = "operator-token-abcdef1234567890"
)

// newModeCServer wires a full server with mode C on or off through the same
// code main() uses.
func newModeCServer(t *testing.T, enabled bool, egress egressConfig) *server {
	t.Helper()
	t.Setenv(envTunnelPrefix, testTunnelPrefix)
	t.Setenv(envOperatorToken, testTunnelToken)
	s := &server{providers: map[string]*provider{}}
	if enabled {
		if err := s.enableModeC(&modeCConfig{Enabled: true, Egress: egress}); err != nil {
			t.Fatalf("enableModeC: %v", err)
		}
	}
	return s
}

// ---------------------------------------------------------------------------
// Spike S3: ReverseProxy upgrade passthrough (d073 §13)
// ---------------------------------------------------------------------------

// TestUpgradeThroughReverseProxy answers the d073 S3 question empirically:
// does stdlib ReverseProxy in Rewrite mode, behind our logging wrapper,
// carry a WebSocket upgrade end to end? If handleUpgradeResponse's hijack
// failed to survive the Unwrap chain, this is where it breaks.
func TestUpgradeThroughReverseProxy(t *testing.T) {
	upstream := newUpgradeEchoUpstream(t)

	proxyProvider, err := newProvider("wstest.example", upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{providers: map[string]*provider{"wstest.example": proxyProvider}}
	proxy := newHTTPServer(t, s)
	logBuf := captureLog(t)

	conn := rawDial(t, proxy.Listener.Addr().String())
	defer conn.Close()
	key := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef"))
	mustWrite(t, conn, "GET /wstest.example/rt HTTP/1.1\r\n"+
		"Host: wstest.example\r\n"+
		"Upgrade: websocket\r\n"+
		"Connection: Upgrade\r\n"+
		"Sec-WebSocket-Key: "+key+"\r\n"+
		"Sec-WebSocket-Version: 13\r\n\r\n")

	br := bufio.NewReader(conn)
	status, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("reading status: %v", err)
	}
	if !strings.Contains(status, "101") {
		t.Fatalf("S3 verdict: upgrade did NOT pass through, status line %q", strings.TrimRight(status, "\r\n"))
	}
	hdr, err := readHeaders(br)
	if err != nil {
		t.Fatalf("reading upgrade headers: %v", err)
	}
	if got := hdr.Get("Sec-WebSocket-Accept"); got != wsAcceptKey(key) {
		t.Fatalf("accept header not preserved end to end: %q", got)
	}

	mustWrite(t, conn, "tunnel-bytes")
	echo := make([]byte, len("tunnel-bytes"))
	if _, err := io.ReadFull(br, echo); err != nil {
		t.Fatalf("reading echo: %v", err)
	}
	if string(echo) != "tunnel-bytes" {
		t.Fatalf("echo = %q", echo)
	}

	// The handler logs only when it returns, and it returns when the
	// hijacked conn closes — close first (VPN-R13: CLF says 101, not 0).
	_ = conn.Close()
	waitForLog(t, logBuf, " 101 ")
}

// ---------------------------------------------------------------------------
// Camouflage: the tunnel namespace answers exactly mode A's 404
// ---------------------------------------------------------------------------

// TestTunnelPathCamouflage is VPN-R34/R2/R44 as one assertion set: every
// unauthenticated or misrouted probe at the tunnel shape must be byte-for-
// byte the Funnel 404 — including when mode C is entirely absent, so
// enabling mode C changes nothing observable.
func TestTunnelPathCamouflage(t *testing.T) {
	type resp struct {
		status int
		ct     string
		xcto   string
		body   string
	}
	fetch := func(t *testing.T, s *server, raw string) resp {
		t.Helper()
		proxy := newHTTPServer(t, s)
		conn := rawDial(t, proxy.Listener.Addr().String())
		defer conn.Close()
		mustWrite(t, conn, raw)
		br := bufio.NewReader(conn)
		statusLine, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("status: %v", err)
		}
		hdr, err := readHeaders(br)
		if err != nil {
			t.Fatalf("headers: %v", err)
		}
		var code int
		if _, err := fmt.Sscanf(strings.TrimSpace(statusLine), "HTTP/1.1 %d", &code); err != nil {
			t.Fatalf("parse status %q: %v", strings.TrimSpace(statusLine), err)
		}
		cl, _ := strconv.Atoi(hdr.Get("Content-Length"))
		body := make([]byte, cl)
		if _, err := io.ReadFull(br, body); err != nil && err != io.EOF {
			t.Fatalf("body: %v", err)
		}
		return resp{status: code, ct: hdr.Get("Content-Type"), xcto: hdr.Get("X-Content-Type-Options"), body: string(body)}
	}

	on := newModeCServer(t, true, egressConfig{})
	off := newModeCServer(t, false, egressConfig{})

	get := func(path string) string {
		return "GET " + path + " HTTP/1.1\r\nHost: anywhere.example\r\nUser-Agent: probe/1\r\n\r\n"
	}
	wrongToken := func(path string) string {
		return "GET " + path + " HTTP/1.1\r\nHost: anywhere.example\r\nAuthorization: Bearer wrong-token\r\n" +
			"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: Z29vZG9kYXRhZ29vZA==\r\nSec-WebSocket-Version: 13\r\n\r\n"
	}

	cases := []struct {
		name   string
		server *server
		raw    string
	}{
		{"tunnel path, no auth, mode C on", on, get("/" + testTunnelPrefix + "/vpn")},
		{"tunnel path, wrong token + upgrade, mode C on", on, wrongToken("/" + testTunnelPrefix + "/vpn")},
		{"tunnel path, no auth, mode C off", off, get("/" + testTunnelPrefix + "/vpn")},
		{"non-exact prefix path, mode C on", on, get("/" + testTunnelPrefix + "/other")},
		{"garbage path, mode C on", on, get("/nonsense/xyz")},
		{"tunnel path shape with other prefix", on, get("/someotherprefix/vpn")},
	}

	var baseline *resp
	for _, tc := range cases {
		got := fetch(t, tc.server, tc.raw)
		if got.status != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", tc.name, got.status)
		}
		if got.body != "404 page not found\n" {
			t.Errorf("%s: body = %q", tc.name, got.body)
		}
		if baseline == nil {
			baseline = &got
			continue
		}
		if got.ct != baseline.ct || got.xcto != baseline.xcto || got.body != baseline.body {
			t.Errorf("%s: response diverges from baseline: got {ct=%q xcto=%q body=%q}, want {ct=%q xcto=%q body=%q}",
				tc.name, got.ct, got.xcto, got.body, baseline.ct, baseline.xcto, baseline.body)
		}
	}
}

// ---------------------------------------------------------------------------
// Authentication (VPN-R12/R31/R33) and server-side policy (R22/R37/R35)
// ---------------------------------------------------------------------------

// TestTunnelHandshakeAuth drives the REAL handshake through wsDial: the
// credential rides the upgrade header, and only a correct one ever reaches
// a 101.
func TestTunnelHandshakeAuth(t *testing.T) {
	s := newModeCServer(t, true, egressConfig{})
	proxy := newHTTPServer(t, s)
	tunnelURL := mustTunnelURL(t, proxy, testTunnelPrefix)

	t.Run("correct token completes the handshake", func(t *testing.T) {
		ws, err := dialTunnelForTest(t, tunnelURL, testTunnelToken)
		if err != nil {
			t.Fatalf("expected handshake success, got %v", err)
		}
		ws.Close()
	})
	t.Run("wrong token never reaches a 101", func(t *testing.T) {
		if _, err := dialTunnelForTest(t, tunnelURL, "wrong-token"); err == nil {
			t.Fatal("expected failure")
		} else if !strings.Contains(err.Error(), "404") {
			t.Fatalf("want camouflage status in error, got %v", err)
		}
	})
	t.Run("missing token never reaches a 101", func(t *testing.T) {
		if _, err := dialTunnelForTest(t, tunnelURL, ""); err == nil {
			t.Fatal("expected failure")
		}
	})
}

// openRawTunnel completes handshake + HELLO and leaves CONNECT as the next
// frame — the low-level driver for server-side protocol tests, bypassing
// the client's convenience layers on purpose.
func openRawTunnel(t *testing.T, tunnelURL *url.URL, token string) *wsConn {
	t.Helper()
	ws, err := dialTunnelForTest(t, tunnelURL, token)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { ws.Close() })
	hello, err := encodeHello("raw-test")
	if err != nil {
		t.Fatal(err)
	}
	if err := sendFrame(ws, frameHello, hello); err != nil {
		t.Fatalf("send HELLO: %v", err)
	}
	msg, err := readTunnelFrame(ws)
	if err != nil {
		t.Fatalf("read HELLO_OK: %v", err)
	}
	typ, _, payload, err := decodeFrame(msg)
	if err != nil || typ != frameHelloOK || len(payload) != 1 {
		t.Fatalf("HELLO_OK: typ=%d payload=%v err=%v", typ, payload, err)
	}
	return ws
}

func connectErrReason(t *testing.T, ws *wsConn, target string) string {
	t.Helper()
	_ = ws.conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	if err := sendFrame(ws, frameConnect, []byte(target)); err != nil {
		t.Fatalf("send CONNECT: %v", err)
	}
	msg, err := readTunnelFrame(ws)
	if err != nil {
		t.Fatalf("read CONNECT reply: %v", err)
	}
	typ, _, payload, err := decodeFrame(msg)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if typ == frameConnected {
		t.Fatalf("CONNECT %q unexpectedly succeeded", target)
	}
	if typ != frameConnectErr {
		t.Fatalf("expected CONNECT_ERR, got type %d", typ)
	}
	return string(payload)
}

// VPN-R22: the server refuses pre-resolved targets — the enforcement point
// must hold even against a peer that skips any client-side courtesy check.
func TestServerRefusesIPLiteralTargets(t *testing.T) {
	s := newModeCServer(t, true, egressConfig{})
	proxy := newHTTPServer(t, s)
	for _, target := range []string{"1.2.3.4:443", "[::1]:443"} {
		// One CONNECT per session: v1 is unmuxed (VPN-R17), so every
		// refusal opens a fresh tunnel — exactly as the client would.
		ws := openRawTunnel(t, mustTunnelURL(t, proxy, testTunnelPrefix), testTunnelToken)
		if reason := connectErrReason(t, ws, target); reason != errReasonTargetIP {
			t.Fatalf("%s: reason = %q, want %q", target, reason, errReasonTargetIP)
		}
	}
}

// VPN-R37: port policy applies before any dial — a refused port never even
// opens a socket toward the target.
func TestServerRefusesNonPermittedPorts(t *testing.T) {
	s := newModeCServer(t, true, egressConfig{}) // default ports: 80, 443
	proxy := newHTTPServer(t, s)
	for target, want := range map[string]string{
		"example.com:22": errReasonPortDenied,
		"example.com:":   errReasonInvalid,
	} {
		ws := openRawTunnel(t, mustTunnelURL(t, proxy, testTunnelPrefix), testTunnelToken)
		if reason := connectErrReason(t, ws, target); reason != want {
			t.Fatalf("%s: reason = %q, want %q", target, reason, want)
		}
	}
}

// VPN-R35: default-deny catches the resolution itself — a permitted port on
// a loopback-resolving name is still refused with the DENIED vocabulary.
func TestServerRefusesLoopbackResolvingTargetsByDefault(t *testing.T) {
	s := newModeCServer(t, true, egressConfig{Ports: []uint16{65000}})
	proxy := newHTTPServer(t, s)
	ws := openRawTunnel(t, mustTunnelURL(t, proxy, testTunnelPrefix), testTunnelToken)
	if reason := connectErrReason(t, ws, "localhost:65000"); reason != errReasonDenied {
		t.Fatalf("reason = %q, want %q", reason, errReasonDenied)
	}
}

// VPN-R16 ordering: CONNECT before HELLO is a protocol violation, not a
// request the server silently repairs.
func TestServerRequiresHelloFirst(t *testing.T) {
	s := newModeCServer(t, true, egressConfig{})
	proxy := newHTTPServer(t, s)
	ws, err := dialTunnelForTest(t, mustTunnelURL(t, proxy, testTunnelPrefix), testTunnelToken)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if err := sendFrame(ws, frameConnect, []byte("example.com:443")); err != nil {
		t.Fatalf("send CONNECT: %v", err)
	}
	_ = ws.conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	if _, err := readTunnelFrame(ws); err == nil {
		t.Fatal("expected the session to die on a wrong-phase CONNECT")
	}
}

// ---------------------------------------------------------------------------
// The connection log (VPN-R19/R44)
// ---------------------------------------------------------------------------

// TestLifecycleLogIsPayloadFreeAndRedacted: the one line per session carries
// who/where/how-much/outcome and the prefix's digest — never the credential,
// never the prefix itself.
func TestLifecycleLogIsPayloadFreeAndRedacted(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		for {
			conn, err := target.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}(conn)
		}
	}()
	targetPort := portOf(t, target.Addr().String())

	logBuf := captureLog(t)

	s := newModeCServer(t, true, egressConfig{
		AllowCidrs: []string{"127.0.0.0/8"},
		Ports:      []uint16{targetPort},
	})
	proxy := newHTTPServer(t, s)
	ws := openRawTunnel(t, mustTunnelURL(t, proxy, testTunnelPrefix), testTunnelToken)

	targetAddr := "localhost:" + strconv.Itoa(int(targetPort))
	if err := sendFrame(ws, frameConnect, []byte(targetAddr)); err != nil {
		t.Fatalf("CONNECT: %v", err)
	}
	_ = ws.conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	msg, err := readTunnelFrame(ws)
	if err != nil {
		t.Fatalf("CONNECT reply: %v", err)
	}
	if typ, _, _, err := decodeFrame(msg); err != nil || typ != frameConnected {
		t.Fatalf("expected CONNECTED, typ=%d err=%v", typ, err)
	}

	// The lifecycle line is written once, at session end (outcome + totals
	// are only knowable there) — so every assertion waits for the close.
	ws.Close()
	waitForLog(t, logBuf, "[vpn] who=operator")
	dumped := logBuf.String()
	if strings.Contains(dumped, testTunnelToken) {
		t.Fatalf("token leaked into the log:\n%s", dumped)
	}
	if strings.Contains(dumped, testTunnelPrefix) {
		t.Fatalf("capability prefix leaked into the log:\n%s", dumped)
	}
	if !strings.Contains(dumped, "tunnel="+prefixDigest(testTunnelPrefix)) {
		t.Fatalf("expected prefix digest in the lifecycle line:\n%s", dumped)
	}
	if !strings.Contains(dumped, `label="raw-test"`) {
		t.Fatalf("expected client label:\n%s", dumped)
	}
	if !strings.Contains(dumped, targetAddr) {
		t.Fatalf("expected target metadata:\n%s", dumped)
	}
	if !strings.Contains(dumped, "bytes_in=") || !strings.Contains(dumped, "outcome=") {
		t.Fatalf("expected byte counters and outcome:\n%s", dumped)
	}
}

// ---------------------------------------------------------------------------
// enableModeC input validation (NFR-2: fail loudly, never silently)
// ---------------------------------------------------------------------------

func TestEnableModeCValidatesInputs(t *testing.T) {
	t.Setenv(envTunnelPrefix, testTunnelPrefix)
	t.Setenv(envOperatorToken, testTunnelToken)

	t.Run("prefix shorter than capability floor", func(t *testing.T) {
		t.Setenv(envTunnelPrefix, "short")
		s := &server{providers: map[string]*provider{}}
		if err := s.enableModeC(&modeCConfig{Enabled: true}); err == nil {
			t.Fatal("expected failure")
		}
	})
	t.Run("prefix with path-hostile characters", func(t *testing.T) {
		t.Setenv(envTunnelPrefix, "cap-with/slash-aaaaaaaaaaaa")
		s := &server{providers: map[string]*provider{}}
		if err := s.enableModeC(&modeCConfig{Enabled: true}); err == nil {
			t.Fatal("expected failure")
		}
	})
	t.Run("missing token", func(t *testing.T) {
		t.Setenv(envOperatorToken, "")
		s := &server{providers: map[string]*provider{}}
		if err := s.enableModeC(&modeCConfig{Enabled: true}); err == nil {
			t.Fatal("expected failure")
		}
	})
	t.Run("prefix colliding with an allowlist host", func(t *testing.T) {
		p, err := newProvider(testTunnelPrefix, "https://example.com")
		if err != nil {
			t.Fatal(err)
		}
		s := &server{providers: map[string]*provider{testTunnelPrefix: p}}
		if err := s.enableModeC(&modeCConfig{Enabled: true}); err == nil {
			t.Fatal("expected collision failure")
		}
	})
	t.Run("bad egress config", func(t *testing.T) {
		s := &server{providers: map[string]*provider{}}
		if err := s.enableModeC(&modeCConfig{Enabled: true, Egress: egressConfig{AllowCidrs: []string{"nope"}}}); err == nil {
			t.Fatal("expected failure")
		}
	})
}
