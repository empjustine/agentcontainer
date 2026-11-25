package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The egress policy is store data now (VPN-R38, d236), so its grammar is
// pinned the way the wire formats are: an absent block means the
// requirement's defaults, a strict object is accepted, and every near-miss a
// typo produces is refused instead of silently enforcing default-deny under a
// name the operator thinks they configured (NFR-2).
func TestExitStoreEgressGrammar(t *testing.T) {
	t.Run("absent means the defaults", func(t *testing.T) {
		writeTestExitJSON(t, nil)
		store, err := loadExitStore(storeRoot())
		if err != nil {
			t.Fatal(err)
		}
		if len(store.Egress.AllowCidrs) != 0 || len(store.Egress.Ports) != 0 {
			t.Fatalf("want zero config, got %+v", store.Egress)
		}
	})
	t.Run("both halves", func(t *testing.T) {
		writeTestExitJSON(t, &egressConfig{AllowCidrs: []string{"127.0.0.0/8"}, Ports: []uint16{8443}})
		store, err := loadExitStore(storeRoot())
		if err != nil {
			t.Fatal(err)
		}
		if len(store.Egress.AllowCidrs) != 1 || store.Egress.AllowCidrs[0] != "127.0.0.0/8" ||
			len(store.Egress.Ports) != 1 || store.Egress.Ports[0] != 8443 {
			t.Fatalf("got %+v", store.Egress)
		}
	})
	// Each of these is a plausible typo whose silent reading would be
	// "configured, and the default deny still applies".
	for _, block := range []string{
		`{"allowCidr": ["127.0.0.0/8"]}`,
		`{"allowIPLiteral": true}`,
		`{"ports": ["443"]}`,
		`{"allowCidrs": []}`,
		`{}`,
		`not json`,
	} {
		t.Run("refused: "+block, func(t *testing.T) {
			entry := fmt.Sprintf(`"name":%q,"public":%q`, testV5Principal, encodeEPub(testV5CertDER))
			exitFile := fmt.Sprintf(`{"relays":[{%s}],"egress":%s}`, entry, block)
			if err := os.WriteFile(filepath.Join(testV5StoreRoot, "exit.json"), []byte(exitFile), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadExitStore(storeRoot()); err == nil {
				t.Fatalf("exit.json egress %s = nil error, want refusal", block)
			}
		})
	}
}

// newTunnelServer wires a full server with the tunnel on or off through the same
// code main() uses.
func newTunnelServer(t *testing.T, enabled bool, egress egressConfig) *server {
	t.Helper()
	s := &server{}
	if enabled {
		// The policy travels through the store because that is the only
		// config surface v5 has (d236): the test writes what an operator
		// writes, and enableTunnel reads it like boot does.
		writeTestExitJSON(t, &egress)
		if err := s.enableTunnel(); err != nil {
			t.Fatalf("enableTunnel: %v", err)
		}
	}
	return s
}

// ---------------------------------------------------------------------------
// Camouflage: the tunnel namespace answers exactly the funnel's 404
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
// blind proof rides the upgrade header, and only a fresh, pinned one ever
// reaches a 101 (d236/d131).
func TestTunnelHandshakeAuth(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{})
	proxy := newHTTPServer(t, s)
	tunnelURL := mustTunnelURL(t, proxy)

	t.Run("a pinned proof completes the handshake", func(t *testing.T) {
		ws, err := dialTunnelForTest(t, tunnelURL)
		if err != nil {
			t.Fatalf("expected handshake success, got %v", err)
		}
		ws.Close()
	})
	t.Run("unauthenticated probe never reaches a 101", func(t *testing.T) {
		probeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if _, err := wsDial(probeCtx, tunnelURL, nil, nil, false); err == nil {
			t.Fatal("expected failure")
		} else if !strings.Contains(err.Error(), "404") {
			t.Fatalf("want camouflage status in error, got %v", err)
		}
	})
	t.Run("a valid but unpinned certificate never reaches a 101", func(t *testing.T) {
		foreignPriv := testHostKey(t)
		foreignDER, err := mintPrincipalCertificate(foreignPriv, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		hdr, _, err := channelRequestHeaders(foreignPriv, testV5Principal, testV5Principal, foreignDER)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := dialTunnelWithHeaders(t, tunnelURL, hdr); err == nil ||
			!strings.Contains(err.Error(), "404") {
			t.Fatalf("unpinned certificate: err=%v, want the camouflage 404", err)
		}
	})
	t.Run("a replayed proof never reaches a second 101", func(t *testing.T) {
		hdr := testV5Headers(t)
		first, err := dialTunnelWithHeaders(t, tunnelURL, hdr)
		if err != nil {
			t.Fatalf("first exchange: %v", err)
		}
		first.Close()
		if _, err := dialTunnelWithHeaders(t, tunnelURL, hdr); err == nil {
			t.Fatal("a replayed relay proof was admitted")
		}
	})
}

// openRawTunnel completes handshake + HELLO and leaves CONNECT as the next
// frame — the low-level driver for server-side protocol tests, bypassing
// the relay node's convenience layers on purpose.
func openRawTunnel(t *testing.T, tunnelURL *url.URL) tunnelStream {
	t.Helper()
	ws, err := dialTunnelForTest(t, tunnelURL)
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

func connectErrReason(t *testing.T, ws tunnelStream, target string) string {
	t.Helper()
	_ = ws.setReadDeadline(time.Now().Add(10 * time.Second))
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
// A guaranteed-bogon address is refused earlier and separately (d163), so
// the loopback spellings live in TestServerGuaranteedRefusalsAnswerFirst.
func TestServerRefusesIPLiteralTargets(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{})
	proxy := newHTTPServer(t, s)
	for _, target := range []string{"1.2.3.4:443", "203.0.113.7:80", "[2001:db8::1]:443"} {
		// One CONNECT per session: v1 is unmuxed (VPN-R17), so every
		// refusal opens a fresh tunnel — exactly as the relay node would.
		ws := openRawTunnel(t, mustTunnelURL(t, proxy))
		if reason := connectErrReason(t, ws, target); reason != errReasonTargetIP {
			t.Fatalf("%s: reason = %q, want %q", target, reason, errReasonTargetIP)
		}
	}
}

// d163: guaranteed refusals answer FIRST — before the IP-exit switch, before
// the allow table, before the port set. The config below would permit every
// one of these targets if any later gate owned them, and the refusal order
// is exactly what stops that. The last case is the complementary half: an
// address the switch admits but no allow rule claims still dies at the
// table, not at a dial.
func TestServerGuaranteedRefusalsAnswerFirst(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{
		AllowIPLiterals: true,
		AllowCidrs:      []string{"127.0.0.0/8", "::1/128"},
		Ports:           []uint16{80, 443},
	})
	proxy := newHTTPServer(t, s)
	for _, target := range []string{
		"127.0.0.1:443",               // loopback literal, both families' door
		"[::1]:80",                    //
		"[::ffff:127.0.0.1]:443",      // loopback re-spelled IPv4-in-IPv6 — the v4-mapped spell must not dodge
		"localhost:443",               // the name, refused before any lookup
		"LOCALHOST.:80",               // case and trailing dot are the same name
		"app.localhost:443",           // the whole .localhost TLD
		"dev.localhost:80",            // the dev sub-tree included
		"localhost.localdomain:443",   // the /etc/hosts loopback family
		"LOCALHOST4.LOCALDOMAIN4.:80", // the family under case and trailing dot
	} {
		ws := openRawTunnel(t, mustTunnelURL(t, proxy))
		if reason := connectErrReason(t, ws, target); reason != errReasonBogon {
			t.Fatalf("%s: reason = %q, want %q", target, reason, errReasonBogon)
		}
	}
	ws := openRawTunnel(t, mustTunnelURL(t, proxy))
	if reason := connectErrReason(t, ws, "169.254.169.254:80"); reason != errReasonDenied {
		t.Fatalf("metadata address: reason = %q, want %q", reason, errReasonDenied)
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
		ws := openRawTunnel(t, mustTunnelURL(t, proxy))
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
	// A name that RESOLVES into the deny table — the door refuses
	// `localhost`/`.localhost` as names (d163), so this proof needs an
	// alias the suite's resolver maps to 127.0.0.1.
	ws := openRawTunnel(t, mustTunnelURL(t, proxy))
	if reason := connectErrReason(t, ws, "loopback.test:65000"); reason != errReasonDenied {
		t.Fatalf("reason = %q, want %q", reason, errReasonDenied)
	}
}

// VPN-R16 ordering: CONNECT before HELLO is a protocol violation, not a
// request the exit node silently repairs.
func TestServerRequiresHelloFirst(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{})
	proxy := newHTTPServer(t, s)
	ws, err := dialTunnelForTest(t, mustTunnelURL(t, proxy))
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if err := sendFrame(ws, frameConnect, []byte("example.com:443")); err != nil {
		t.Fatalf("send CONNECT: %v", err)
	}
	_ = ws.setReadDeadline(time.Now().Add(10 * time.Second))
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
	target, err := new(net.ListenConfig).Listen(context.Background(), "tcp", "127.0.0.1:0")
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
	ws := openRawTunnel(t, mustTunnelURL(t, proxy))

	targetAddr := testTargetAlias + ":" + strconv.Itoa(int(targetPort))
	if err := sendFrame(ws, frameConnect, []byte(targetAddr)); err != nil {
		t.Fatalf("CONNECT: %v", err)
	}
	_ = ws.setReadDeadline(time.Now().Add(10 * time.Second))
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
	waitForLog(t, logBuf, "event=close")
	dumped := logBuf.String()
	if strings.Contains(strings.ToLower(dumped), "e-auth") || strings.Contains(dumped, "e-pub") {
		t.Fatalf("admission material leaked into the log:\n%s", dumped)
	}
	if !strings.Contains(dumped, "transport=websocket") {
		t.Fatalf("expected transport column in the lifecycle line:\n%s", dumped)
	}
	if !strings.Contains(dumped, `label="raw-test"`) {
		t.Fatalf("expected client label:\n%s", dumped)
	}
	if !strings.Contains(dumped, targetAddr) {
		t.Fatalf("expected target metadata:\n%s", dumped)
	}
	if !strings.Contains(dumped, "bytes_up=") || !strings.Contains(dumped, "bytes_down=") || !strings.Contains(dumped, "outcome=") {
		t.Fatalf("expected byte counters and outcome:\n%s", dumped)
	}
}

// ---------------------------------------------------------------------------
// enableTunnel input validation (NFR-2: fail loudly, never silently)
// ---------------------------------------------------------------------------

// TestSessionResponsesCarryExitProofAndForbidCaching: every authenticated
// session response carries the exit's own proof plus the headers that keep an
// intermediary from reusing it — on the 101 and on a window's 200 alike
// (d236). Refusals keep the funnel 404 byte for byte (VPN-R34).
func TestSessionResponsesCarryExitProofAndForbidCaching(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{})
	backend := newHTTPServer(t, s)
	tunnelURL := mustTunnelURL(t, backend)
	store, err := loadRelayStore(storeRoot())
	if err != nil {
		t.Fatal(err)
	}

	assertUncacheable := func(t *testing.T, hdr http.Header) {
		t.Helper()
		if got := hdr.Get("Cache-Control"); got != "no-cache, private" {
			t.Fatalf("Cache-Control = %q, want %q", got, "no-cache, private")
		}
		if got := hdr.Get("Vary"); got != "*" {
			t.Fatalf("Vary = %q, want *", got)
		}
		if len(hdr.Values(eExitAuthHeader)) != 1 || len(hdr.Values(ePubHeader)) != 1 {
			t.Fatalf("exit proof cardinality: auth=%v pub=%v", hdr.Values(eExitAuthHeader), hdr.Values(ePubHeader))
		}
	}

	t.Run("the 101", func(t *testing.T) {
		hdr, nonce, err := channelRequestHeaders(store.Private, store.Principal, store.Exits[0].Name, store.SelfDER)
		if err != nil {
			t.Fatal(err)
		}
		ws, err := wsDial(t.Context(), tunnelURL, hdr, nil, false)
		if err != nil {
			t.Fatal(err)
		}
		defer ws.Close()
		assertUncacheable(t, ws.respHeader)
		if err := validateExitAdmission(
			ws.respHeader.Values(eExitAuthHeader), ws.respHeader.Values(ePubHeader),
			trustFromRelayStore(store), store.Exits[0].Name, store.Principal, nonce, newNonceRing(4),
		); err != nil {
			t.Fatalf("101 proof: %v", err)
		}
	})

	t.Run("a window's 200", func(t *testing.T) {
		hdr, _, err := channelRequestHeaders(store.Private, store.Principal, store.Exits[0].Name, store.SelfDER)
		if err != nil {
			t.Fatal(err)
		}
		hdr.Set(windowHeader, strconv.FormatInt(h2WindowedBytes, 10))
		hdr.Set("Traceparent", buildTraceparent("000000000000000000000000000000c1", 1))
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, backend.URL+tunnelPath, http.NoBody)
		if err != nil {
			t.Fatal(err)
		}
		req.Header = hdr
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("window answered %d", resp.StatusCode)
		}
		assertUncacheable(t, resp.Header)
	})
}
