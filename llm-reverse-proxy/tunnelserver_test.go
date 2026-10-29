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
	// This is what the ENV carries; enableTunnel is driven through t.Setenv
	// so tests exercise the production construction path, not a shortcut.
	testTunnelToken = "operator-token-abcdef1234567890"
)

// armTestTunnelEnv sets the credential pair exactly as the d090 migration
// leaves it: VPN_OPERATOR_KEYS carries the token under the id "default" (the
// exit node's credential) and the same bytes stay in VPN_OPERATOR_TOKEN (the
// relay node's bearer — each side reads its own variable; zero-wire,
// docs/d090).
func armTestTunnelEnv(t *testing.T) {
	t.Helper()
	t.Setenv(envOperatorKeys, fmt.Sprintf(`{"default":%q}`, testTunnelToken))
	t.Setenv(envOperatorToken, testTunnelToken)
}

// newTunnelServer wires a full server with the tunnel on or off through the same
// code main() uses.
func newTunnelServer(t *testing.T, enabled bool, egress egressConfig) *server {
	t.Helper()
	armTestTunnelEnv(t)
	s := &server{providers: map[string]*provider{}}
	if enabled {
		if err := s.enableTunnel(&tunnelConfig{Egress: egress}); err != nil {
			t.Fatalf("enableTunnel: %v", err)
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
// byte the Funnel 404 — including when the tunnel is entirely absent, so
// enabling it changes nothing observable.
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

	on := newTunnelServer(t, true, egressConfig{})
	off := newTunnelServer(t, false, egressConfig{})

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
		{"tunnel path, no auth, tunnel on", on, get(tunnelPath)},
		{"tunnel path, wrong token + upgrade, tunnel on", on, wrongToken(tunnelPath)},
		{"tunnel path, no auth, tunnel off", off, get(tunnelPath)},
		{"non-exact prefix path, tunnel on", on, get(tunnelPath + "/other")},
		{"garbage path, tunnel on", on, get("/nonsense/xyz")},
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
// Authentication (VPN-R12/R31/R33) and exit-node-side policy (R22/R37/R35)
// ---------------------------------------------------------------------------

// TestTunnelHandshakeAuth drives the REAL handshake through wsDial: the
// credential rides the upgrade header, and only a correct one ever reaches
// a 101.
func TestTunnelHandshakeAuth(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{})
	proxy := newHTTPServer(t, s)
	tunnelURL := mustTunnelURL(t, proxy)

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
// the relay node's convenience layers on purpose.
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

// VPN-R22: the exit node refuses pre-resolved targets — the enforcement point
// must hold even against a peer that skips any client-side courtesy check.
func TestServerRefusesIPLiteralTargets(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{})
	proxy := newHTTPServer(t, s)
	for _, target := range []string{"1.2.3.4:443", "[::1]:443"} {
		// One CONNECT per session: v1 is unmuxed (VPN-R17), so every
		// refusal opens a fresh tunnel — exactly as the relay node would.
		ws := openRawTunnel(t, mustTunnelURL(t, proxy), testTunnelToken)
		if reason := connectErrReason(t, ws, target); reason != errReasonTargetIP {
			t.Fatalf("%s: reason = %q, want %q", target, reason, errReasonTargetIP)
		}
	}
}

// VPN-R37: port policy applies before any dial — a refused port never even
// opens a socket toward the target.
func TestServerRefusesNonPermittedPorts(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{}) // default ports: 80, 443
	proxy := newHTTPServer(t, s)
	for target, want := range map[string]string{
		"example.com:22": errReasonPortDenied,
		"example.com:":   errReasonInvalid,
	} {
		ws := openRawTunnel(t, mustTunnelURL(t, proxy), testTunnelToken)
		if reason := connectErrReason(t, ws, target); reason != want {
			t.Fatalf("%s: reason = %q, want %q", target, reason, want)
		}
	}
}

// VPN-R35: default-deny catches the resolution itself — a permitted port on
// a loopback-resolving name is still refused with the DENIED vocabulary.
func TestServerRefusesLoopbackResolvingTargetsByDefault(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{Ports: []uint16{65000}})
	proxy := newHTTPServer(t, s)
	ws := openRawTunnel(t, mustTunnelURL(t, proxy), testTunnelToken)
	if reason := connectErrReason(t, ws, "localhost:65000"); reason != errReasonDenied {
		t.Fatalf("reason = %q, want %q", reason, errReasonDenied)
	}
}

// VPN-R16 ordering: CONNECT before HELLO is a protocol violation, not a
// request the exit node silently repairs.
func TestServerRequiresHelloFirst(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{})
	proxy := newHTTPServer(t, s)
	ws, err := dialTunnelForTest(t, mustTunnelURL(t, proxy), testTunnelToken)
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

	s := newTunnelServer(t, true, egressConfig{
		AllowCidrs: []string{"127.0.0.0/8"},
		Ports:      []uint16{targetPort},
	})
	proxy := newHTTPServer(t, s)
	ws := openRawTunnel(t, mustTunnelURL(t, proxy), testTunnelToken)

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
	if !strings.Contains(dumped, "transport=") {
		t.Fatalf("expected transport column in the lifecycle line:\n%s", dumped)
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
// enableTunnel input validation (NFR-2: fail loudly, never silently)
// ---------------------------------------------------------------------------

func TestEnableTunnelValidatesInputs(t *testing.T) {
	// The relay node's bearer stays set throughout: a shared host running
	// both roles has it in env, and the exit node must ignore it in favor
	// of the keyset (docs/d090).
	t.Setenv(envOperatorToken, testTunnelToken)

	t.Run("no credential at all", func(t *testing.T) {
		t.Setenv(envOperatorKeys, "")
		t.Setenv(envOperatorToken, "")
		s := &server{providers: map[string]*provider{}}
		if err := s.enableTunnel(&tunnelConfig{}); err == nil {
			t.Fatal("expected failure")
		}
	})
	t.Run("relay token alone refuses with the d090 migration hint", func(t *testing.T) {
		t.Setenv(envOperatorKeys, "")
		s := &server{providers: map[string]*provider{}}
		err := s.enableTunnel(&tunnelConfig{})
		if err == nil {
			t.Fatal("expected failure")
		}
		if !strings.Contains(err.Error(), envOperatorKeys) || !strings.Contains(err.Error(), "default") {
			t.Fatalf("err=%v, want the zero-wire migration naming %s", err, envOperatorKeys)
		}
	})
	t.Run("keyset alone arms", func(t *testing.T) {
		t.Setenv(envOperatorKeys, fmt.Sprintf(`{"default":%q}`, testTunnelToken))
		s := &server{providers: map[string]*provider{}}
		if err := s.enableTunnel(&tunnelConfig{}); err != nil {
			t.Fatalf("enableTunnel: %v", err)
		}
	})
	t.Run("reserved tunnel path colliding with an allowlist host", func(t *testing.T) {
		p, err := newProvider(tunnelPathHost, "https://example.com")
		if err != nil {
			t.Fatal(err)
		}
		s := &server{providers: map[string]*provider{tunnelPathHost: p}}
		if err := s.enableTunnel(&tunnelConfig{}); err == nil {
			t.Fatal("expected collision failure")
		}
	})
	t.Run("bad egress config", func(t *testing.T) {
		s := &server{providers: map[string]*provider{}}
		if err := s.enableTunnel(&tunnelConfig{Egress: egressConfig{AllowCidrs: []string{"nope"}}}); err == nil {
			t.Fatal("expected failure")
		}
	})
}

// ---------------------------------------------------------------------------
// d078 — bounded static principal set (VPN-R31/R33 as amended)
// ---------------------------------------------------------------------------

const (
	testAliceToken = "alice-token-0123456789"
	testBobToken   = "bob-token-0123456789"
)

// TestOperatorKeysFromEnv drives every refusal d078 §2 lists: the set comes
// from ONE JSON env object — the exit node's credential, disjoint from the
// relay node's bearer since docs/d090 (TOKEN alone refuses with the
// migration hint) — and any input that would weaken or shadow a principal
// refuses the tunnel instead of loading (NFR-2 fail-loudly).
func TestOperatorKeysFromEnv(t *testing.T) {
	var over strings.Builder
	over.WriteString("{")
	for i := 0; i <= maxOperatorKeys; i++ {
		if i > 0 {
			over.WriteString(",")
		}
		fmt.Fprintf(&over, `"key%02d":"token-0123456789abcdef"`, i)
	}
	over.WriteString("}")

	cases := []struct {
		name    string
		keys    string
		token   string
		wantErr bool
		wantIDs []string
	}{
		{"json set", `{"alice":"alice-token-0123456789","bob":"bob-token-0123456789"}`, "", false, []string{"alice", "bob"}},
		{"relay token alone refuses with the migration hint", "", testTunnelToken, true, nil},
		{"keyset wins; the relay token is ignored on an exit node", `{"alice":"alice-token-0123456789"}`, testTunnelToken, false, []string{"alice"}},
		{"no credential at all", "", "", true, nil},
		{"empty object is an empty set", `{}`, "", true, nil},
		{"malformed json", `{"alice":`, "", true, nil},
		{"not an object", `["alice-token-0123456789"]`, "", true, nil},
		{"trailing content", `{"alice":"alice-token-0123456789"} x`, "", true, nil},
		{"duplicate id rejected", `{"alice":"alice-token-0123456789","alice":"alice-token-9876543210"}`, "", true, nil},
		{"non-string value", `{"alice":123}`, "", true, nil},
		{"token below floor", `{"alice":"short"}`, "", true, nil},
		{"short relay token alone still refuses", "", "short", true, nil},
		{"id not label-shaped", `{"ali ce":"alice-token-0123456789"}`, "", true, nil},
		{"keyset's default id untouched by the relay token", `{"default":"default-token-0123456789"}`, testTunnelToken, false, []string{"default"}},
		{"over the cap", over.String(), "", true, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(envOperatorKeys, tc.keys)
			t.Setenv(envOperatorToken, tc.token)
			got, err := operatorKeysFromEnv()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected refusal, got %d key(s)", len(got))
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected refusal: %v", err)
			}
			seen := make(map[string]bool, len(got))
			for _, k := range got {
				seen[k.id] = true
			}
			if len(seen) != len(tc.wantIDs) {
				t.Fatalf("ids = %v, want %v", seen, tc.wantIDs)
			}
			for _, id := range tc.wantIDs {
				if !seen[id] {
					t.Fatalf("ids = %v, missing %q", seen, id)
				}
			}
		})
	}
}

// probeTunnel404 asks the tunnel path for a tunnel without one and renders
// the whole response as one comparable string — status, content type, the
// no-sniff header, and body — so two failures can be asserted BYTE-identical
// (VPN-R34), not merely both-404.
func probeTunnel404(t *testing.T, proxyAddr, token string) string {
	t.Helper()
	conn := rawDial(t, proxyAddr)
	defer conn.Close()
	auth := ""
	if token != "" {
		auth = "Authorization: Bearer " + token + "\r\n"
	}
	mustWrite(t, conn, "GET "+tunnelPath+" HTTP/1.1\r\nHost: anywhere.example\r\n"+auth+"\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("read probe response: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("probe body: %v", err)
	}
	return fmt.Sprintf("%d %s %s %q",
		resp.StatusCode, resp.Header.Get("Content-Type"),
		resp.Header.Get("X-Content-Type-Options"), body)
}

// TestPrincipalSetAcceptance walks d078 §8 end to end: both principals open
// a real handshake on their own key; the success log carries the id and
// never a token; revoking one principal rejects only that one; and a tampered
// token for a real id answers byte-identically to no credential at all
// (VPN-R34 — the response must not distinguish which check failed).
func TestPrincipalSetAcceptance(t *testing.T) {
	build := func(keys string) *server {
		t.Helper()
		t.Setenv(envOperatorKeys, keys)
		t.Setenv(envOperatorToken, "")
		s := &server{providers: map[string]*provider{}}
		if err := s.enableTunnel(&tunnelConfig{}); err != nil {
			t.Fatalf("enableTunnel: %v", err)
		}
		return s
	}

	full := build(`{"alice":"` + testAliceToken + `","bob":"` + testBobToken + `"}`)
	proxy := newHTTPServer(t, full)
	tunnelURL := mustTunnelURL(t, proxy)
	logBuf := captureLog(t)

	for _, k := range []struct{ id, tok string }{{"alice", testAliceToken}, {"bob", testBobToken}} {
		ws, err := dialTunnelForTest(t, tunnelURL, k.tok)
		if err != nil {
			t.Fatalf("%s handshake: %v", k.id, err)
		}
		_ = ws.Close()
	}
	for _, want := range []string{"key=alice", "key=bob"} {
		if !strings.Contains(logBuf.String(), want) {
			t.Errorf("attribution line missing %s:\n%s", want, logBuf.String())
		}
	}
	if strings.Contains(logBuf.String(), testAliceToken) || strings.Contains(logBuf.String(), testBobToken) {
		t.Fatalf("a credential reached the log:\n%s", logBuf.String())
	}

	// Revocation: drop bob's entry — only bob is rejected, and alice's key
	// keeps working without any change on her side (d078 §1).
	revoked := build(`{"alice":"` + testAliceToken + `"}`)
	revokedProxy := newHTTPServer(t, revoked)
	revokedAddr := revokedProxy.Listener.Addr().String()
	revokedURL := mustTunnelURL(t, revokedProxy)
	if ws, err := dialTunnelForTest(t, revokedURL, testBobToken); err == nil {
		_ = ws.Close()
		t.Fatal("revoked principal still opens the tunnel")
	}
	ws, err := dialTunnelForTest(t, revokedURL, testAliceToken)
	if err != nil {
		t.Fatalf("surviving principal: %v", err)
	}
	_ = ws.Close()

	baseline := probeTunnel404(t, revokedAddr, "")
	tampered := probeTunnel404(t, revokedAddr, testAliceToken+"-tampered")
	if baseline != tampered {
		t.Errorf("known-id wrong token diverged from no credential:\n baseline %q\n got      %q", baseline, tampered)
	}
}
