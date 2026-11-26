package main

// vpn_e2e_test.go — the tunnel path in one process: real exit node, real
// relay node, real tunnel, a local upstream, and both local listener types.
// Everything below uses the production construction paths (enableTunnel,
// relayConfigFromEnv, runRelayNode) so a test cannot pass while main() wires
// the pieces differently (d072's drift lesson).

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

// freeLoopbackAddr picks a concrete loopback port by binding :0 and
// releasing it — test-only port pick; production binds fixed flag defaults.
func freeLoopbackAddr(t *testing.T) string {
	t.Helper()
	addr := reserveLoopbackAddr()
	if addr == "" {
		t.Fatal("could not reserve a loopback port")
	}
	return addr
}

func waitForHealth(t *testing.T, healthURL string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		req, reqErr := http.NewRequestWithContext(context.Background(), http.MethodGet, healthURL, nil)
		if reqErr != nil {
			t.Fatalf("healthz request: %v", reqErr)
		}
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("health endpoint %s never came up", healthURL)
}

func readHTTPResponse(t *testing.T, br *bufio.Reader) *http.Response {
	t.Helper()
	// The CONNECT acceptance conventionally ends with a blank line, and
	// ReadResponse wants to begin at a status line — skip terminators.
	for {
		b, err := br.Peek(2)
		if err != nil || (string(b) != "\r\n" && string(b) != "\n") {
			break
		}
		_, _ = br.Discard(2)
		if string(b) == "\n" {
			break
		}
	}
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	return resp
}

func TestTunnelClientServerEndToEnd(t *testing.T) {
	// The origin an allowlisted upstream points at. Upgrade dispatch feeds
	// d103's cleartext ws branch; the X-Seen-* headers echo exactly what
	// the origin received, so a forward subtest can assert the rewrite
	// contract (Host preserved, no proxy-layer headers) instead of
	// trusting the relay's own view of it.
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if headerHasToken(r.Header, "Upgrade", "websocket") {
			upgradeEchoHandler(w, r)
			return
		}
		w.Header().Set("X-Upstream", "yes")
		w.Header().Set("X-Seen-Host", r.Host)
		w.Header().Set("X-Seen-Proxy-Auth", r.Header.Get("Proxy-Authorization"))
		w.Header().Set("X-Seen-Forwarded", r.Header.Get("Forwarded"))
		w.Header().Set("X-Seen-Xff", r.Header.Get("X-Forwarded-For"))
		w.Header().Set("X-Seen-Xfh", r.Header.Get("X-Forwarded-Host"))
		w.Header().Set("X-Seen-Xfp", r.Header.Get("X-Forwarded-Proto"))
		w.Header().Set("X-Seen-Via", r.Header.Get("Via"))
		_, _ = io.WriteString(w, "hello-upstream")
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())

	// Server: the tunnel through the production path — no allowlist, no
	// second face (docs/d108).
	s := newTunnelServer(t, true, egressConfig{
		AllowCidrs: []string{"127.0.0.0/8"},
		Ports:      []uint16{upPort},
	})
	proxy := newHTTPSServer(t, s)

	// Relay node: store + runRelayNode, exactly as -mode relay wires it.
	writeTestRelayJSON(t, "wss://"+proxy.Listener.Addr().String()+tunnelPath)
	t.Setenv(envClientLabel, "e2e-label")
	httpAddr := freeLoopbackAddr(t)
	socksAddr := freeLoopbackAddr(t)
	cfg, err := relayConfigFromEnv(httpAddr, socksAddr, relaySelection{}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	relayDone := make(chan error, 1)
	go func() { relayDone <- runRelayNode(runCtx, cfg) }()

	// One process-wide log buffer covers both roles — the credential-free
	// invariant must hold across ALL lines, not a chosen file's.
	logBuf := captureLog(t)
	waitForHealth(t, "http://"+httpAddr+healthPath)

	t.Run("HTTP CONNECT reaches the upstream through the tunnel", func(t *testing.T) {
		conn := rawDial(t, httpAddr)
		defer conn.Close()
		// The GET is written immediately after CONNECT (pipelined): it must
		// ride the hijacked buffer, not a fresh connection (VPN-R11).
		// The CONNECT host is resolved by the SERVER (VPN-R22): it must be
		// a name the exit node can resolve. The HTTP Host inside the
		// tunnel is independent of that.
		mustWrite(t, conn, "CONNECT "+testTargetAlias+":"+strconv.Itoa(int(upPort))+" HTTP/1.1\r\nHost: "+testTargetAlias+"\r\n\r\n"+
			"GET /p?q=1 HTTP/1.1\r\nHost: local.test\r\nConnection: close\r\n\r\n")
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
		if resp.StatusCode != http.StatusOK || string(body) != "hello-upstream" || resp.Header.Get("X-Upstream") != "yes" {
			t.Fatalf("status=%d body=%q upstream-header=%q", resp.StatusCode, body, resp.Header.Get("X-Upstream"))
		}
	})

	t.Run("SOCKS5 reaches the upstream through the tunnel", func(t *testing.T) {
		conn := rawDial(t, socksAddr)
		defer conn.Close()

		mustWrite(t, conn, string([]byte{socksVersion, 1, socksNoAuth}))
		greet := make([]byte, 2)
		if _, err := io.ReadFull(conn, greet); err != nil || greet[1] != socksNoAuth {
			t.Fatalf("greeting reply %v err=%v", greet, err)
		}

		req := make([]byte, 0, 16)
		req = append(req, socksVersion, 1, 0, 3, byte(len(testTargetAlias)))
		req = append(req, testTargetAlias...)
		req = append(req, byte(upPort>>8), byte(upPort))
		mustWrite(t, conn, string(req))
		reply := make([]byte, 10) // ATYP=IPv4 reply shape from our SOCKS5
		if _, err := io.ReadFull(conn, reply); err != nil {
			t.Fatalf("socks reply: %v", err)
		}
		if reply[1] != 0 {
			t.Fatalf("socks connect refused, rep=%d", reply[1])
		}

		mustWrite(t, conn, "GET /socks HTTP/1.1\r\nHost: local.test\r\nConnection: close\r\n\r\n")
		resp := readHTTPResponse(t, bufio.NewReader(conn))
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if string(body) != "hello-upstream" {
			t.Fatalf("socks path body=%q", body)
		}
	})

	t.Run("SOCKS5 carries a literal-IP target to the exit's policy (d242, d130)", func(t *testing.T) {
		// d242 changed the door: an ATYP=IPv4/6 target is no longer refused
		// as a form, so a client that resolved the name itself works. The
		// exit's policy still answers it — here the port set, which refuses
		// before any dial.
		conn := rawDial(t, socksAddr)
		defer conn.Close()

		mustWrite(t, conn, string([]byte{socksVersion, 1, socksNoAuth}))
		greet := make([]byte, 2)
		if _, err := io.ReadFull(conn, greet); err != nil || greet[1] != socksNoAuth {
			t.Fatalf("greeting reply %v err=%v", greet, err)
		}

		// A non-guaranteed literal on a port the exit does not allow: the
		// guaranteed-bogon spellings answer 0x02 at the door (d163), and this
		// address answers 0x02 from the tunnel's ruleset refusal.
		req := []byte{socksVersion, 1, 0, 1, 1, 2, 3, 4, 0x00, 0x01}
		mustWrite(t, conn, string(req))
		reply := make([]byte, 10)
		if _, err := io.ReadFull(conn, reply); err != nil {
			t.Fatalf("socks reply: %v", err)
		}
		if reply[1] != 0x02 {
			t.Fatalf("literal target answered rep=%#x, want 0x02 (the exit's ruleset refusal)", reply[1])
		}
	})

	t.Run("cleartext absolute-form http is answered from the tunnel (d103)", func(t *testing.T) {
		conn := rawDial(t, httpAddr)
		defer conn.Close()
		target := testTargetAlias + ":" + strconv.Itoa(int(upPort))
		// No CONNECT anywhere: the request itself must open a tunnel
		// session (before/after on /healthz) — a 405 means d103 is not
		// implemented, an answer without a new session means a direct
		// dial, which VPN-R26 forbids.
		mustWrite(t, conn, "GET http://"+target+"/fwd HTTP/1.1\r\n"+
			"Host: "+target+"\r\n"+
			"Proxy-Connection: keep-alive\r\n"+
			"Proxy-Authorization: Basic bogus\r\n"+
			"Forwarded: for=9.9.9.9\r\n"+
			"X-Forwarded-For: 9.9.9.9\r\n"+
			"X-Forwarded-Host: evil.example\r\n"+
			"X-Forwarded-Proto: https\r\n"+
			"Via: 1.1 probe\r\n"+
			"Connection: close\r\n\r\n")
		br := bufio.NewReader(conn)
		resp := readHTTPResponse(t, br)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || string(body) != "hello-upstream" {
			t.Fatalf("status=%d body=%q", resp.StatusCode, body)
		}
		// The addressed host must reach the origin exactly — and NOT be
		// re-derived as the relay's own loopback listener. (An absolute-
		// form client cannot spell Host differently from the URL: Go's
		// server ignores the Host line for absolute-form, RFC 9112.)
		if got := resp.Header.Get("X-Seen-Host"); got != target {
			t.Fatalf("Host not preserved: the origin saw %q", got)
		}
		if got := resp.Header.Get("X-Seen-Proxy-Auth"); got != "" {
			t.Fatalf("Proxy-* headers reached the origin: %q", got)
		}
		// The four spoofable forwarding headers never reach the origin
		// (stdlib Rewrite-mode strip — the proxy also never synthesizes
		// any of them); Via passes through verbatim: neither generated
		// hop evidence nor deletion (d103's pass-through terms).
		for _, h := range []string{"X-Seen-Forwarded", "X-Seen-Xff", "X-Seen-Xfh", "X-Seen-Xfp"} {
			if got := resp.Header.Get(h); got != "" {
				t.Fatalf("%s reached the origin: %q", h, got)
			}
		}
		if got := resp.Header.Get("X-Seen-Via"); got != "1.1 probe" {
			t.Fatalf("Via pass-through: got %q", got)
		}
		if resp.Header.Get("Proxy-Connection") != "" {
			t.Fatalf("hop-by-hop Proxy-Connection echoed back: %v", resp.Header)
		}
		if !resp.Close {
			t.Fatal("response must force Connection: close — one tunneled exchange per client connection (d103)")
		}
		// The gauge is in-flight now (docs/d106), and this exchange has
		// already closed: the durable fact is the relay's open record.
		waitForLog(t, logBuf, "via=http")
		// The pinned tunnel is single-use: a second request on this
		// client connection must find it closed, not answer from host A's
		// tunnel on host B's behalf.
		mustWrite(t, conn, "GET http://"+target+"/second HTTP/1.1\r\nHost: "+target+"\r\nConnection: close\r\n\r\n")
		if _, err := br.ReadString('\n'); err == nil {
			t.Fatal("second request on the same connection was answered — a pinned tunnel must never be reused")
		}
	})

	t.Run("cleartext forward answers with the tunnel's policy verdict, never a direct dial (d103)", func(t *testing.T) {
		// Port 1 is outside the exit's egress port set: the refusal must
		// arrive as the tunnel's 403 verdict — a direct dial would have
		// produced a connection error, not a policy.
		conn := rawDial(t, httpAddr)
		defer conn.Close()
		mustWrite(t, conn, "GET http://"+testTargetAlias+":1/fwd HTTP/1.1\r\nHost: "+testTargetAlias+":1\r\nConnection: close\r\n\r\n")
		resp := readHTTPResponse(t, bufio.NewReader(conn))
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusForbidden || !strings.Contains(string(body), "tunnel-denied") {
			t.Fatalf("policy refusal must come from the tunnel: status=%d body=%q", resp.StatusCode, body)
		}
	})

	t.Run("an address target passes the door by default and the exit answers (d242)", func(t *testing.T) {
		// d242: the door no longer refuses the address form, so a literal
		// travels and the exit's policy answers. A reserved range here makes
		// the answer deterministic without a dial into private space.
		conn := rawDial(t, httpAddr)
		defer conn.Close()
		// Port 1 is outside this fixture's exit port set, so the exit refuses
		// without a dial and the answer is deterministic and hermetic.
		addr := "203.0.113.9:1"
		mustWrite(t, conn, "GET http://"+addr+"/fwd HTTP/1.1\r\nHost: "+addr+"\r\nConnection: close\r\n\r\n")
		resp := readHTTPResponse(t, bufio.NewReader(conn))
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		// The exit reached policy and refused on the port set (its target
		// port is not in the table): the local door's "target-refused"
		// vocabulary is gone, which is the whole change.
		if strings.Contains(string(body), "target-refused") || !strings.Contains(string(body), "tunnel-denied") {
			t.Fatalf("the exit must answer an address target: status=%d body=%q", resp.StatusCode, body)
		}
	})

	t.Run("absolute-form https:// still rides CONNECT (405, bytes unopened)", func(t *testing.T) {
		conn := rawDial(t, httpAddr)
		defer conn.Close()
		mustWrite(t, conn, "GET https://localhost:"+strconv.Itoa(int(upPort))+"/x HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
		resp := readHTTPResponse(t, bufio.NewReader(conn))
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusMethodNotAllowed || !strings.Contains(string(body), "only CONNECT tunnels") {
			t.Fatalf("https must keep riding CONNECT, unparsed: status=%d body=%q", resp.StatusCode, body)
		}
	})

	t.Run("ws:// upgrade answers 101 and pumps bytes (d103)", func(t *testing.T) {
		conn := rawDial(t, httpAddr)
		defer conn.Close()
		target := testTargetAlias + ":" + strconv.Itoa(int(upPort))
		mustWrite(t, conn, "GET ws://"+target+"/echo HTTP/1.1\r\n"+
			"Host: "+target+"\r\n"+
			"Connection: Upgrade\r\nUpgrade: websocket\r\n"+
			"Sec-WebSocket-Key: dGVzdGtleTEyMzQ1Ng==\r\nSec-WebSocket-Version: 13\r\n\r\n")
		br := bufio.NewReader(conn)
		resp := readHTTPResponse(t, br)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusSwitchingProtocols {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("upgrade refused: status=%d body=%q", resp.StatusCode, body)
		}
		// Past the 101 the client connection is a raw pump: the echo
		// fixture answers one read, then closes.
		mustWrite(t, conn, "hello-ws")
		echo := make([]byte, len("hello-ws"))
		if _, err := io.ReadFull(br, echo); err != nil {
			t.Fatalf("upgrade pump did not deliver: %v", err)
		}
		if string(echo) != "hello-ws" {
			t.Fatalf("echo=%q", echo)
		}
	})

	t.Run("healthz reports the tunnel endpoint", func(t *testing.T) {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://"+httpAddr+healthPath, nil)
		if err != nil {
			t.Fatalf("healthz request: %v", err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("healthz: %v", err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("healthz status %d", resp.StatusCode)
		}
		if !strings.Contains(string(body), proxy.Listener.Addr().String()) {
			t.Fatalf("healthz should name the tunnel host, got %s", body)
		}
	})

	t.Run("policy-denied target fails closed, never dialing directly", func(t *testing.T) {
		// Port 1 is not in the egress port set: the refusal must come from
		// the tunnel policy (a non-200 CONNECT reply), with no local dial.
		conn := rawDial(t, httpAddr)
		defer conn.Close()
		mustWrite(t, conn, "CONNECT local.test:1 HTTP/1.1\r\nHost: local.test\r\n\r\n")
		status, err := bufio.NewReader(conn).ReadString('\n')
		if err != nil {
			t.Fatalf("CONNECT status: %v", err)
		}
		if strings.Contains(status, " 200 ") {
			t.Fatalf("denied target got a 200: %q", strings.TrimSpace(status))
		}
	})

	t.Run("connection log carries metadata and never the credential", func(t *testing.T) {
		waitForLog(t, logBuf, "event=close")
		dumped := logBuf.String()
		assertNoAdmissionMaterial(t, dumped)
		if !strings.Contains(dumped, `label="e2e-label"`) {
			t.Fatalf("client label missing from the session line:\n%s", dumped)
		}
	})

	cancel()
	select {
	case err := <-relayDone:
		if err != nil {
			t.Fatalf("relay node shutdown: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("relay node did not stop on context cancellation")
	}
}

// TestCleartextForwardFailsClosedWithoutTunnel pins d103's second
// verification point with the tunnel dead: the absolute-form request gets a
// LOCAL problem detail in the tunnel's vocabulary — not a 405, and not an
// answer that could only come from a direct dial.
func TestCleartextForwardFailsClosedWithoutTunnel(t *testing.T) {
	dead := reserveLoopbackAddr() // released: connecting to it must be refused
	writeTestRelayJSON(t, "wss://"+dead+tunnelPath)
	t.Setenv(envClientLabel, "dead-tunnel-fwd")
	httpAddr := freeLoopbackAddr(t)
	socksAddr := freeLoopbackAddr(t)
	cfg, err := relayConfigFromEnv(httpAddr, socksAddr, relaySelection{}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	relayDone := make(chan error, 1)
	go func() { relayDone <- runRelayNode(runCtx, cfg) }()
	waitForHealth(t, "http://"+httpAddr+healthPath)

	conn := rawDial(t, httpAddr)
	defer conn.Close()
	mustWrite(t, conn, "GET http://"+testTargetAlias+":9/fwd HTTP/1.1\r\nHost: "+testTargetAlias+":9\r\nConnection: close\r\n\r\n")
	resp := readHTTPResponse(t, bufio.NewReader(conn))
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusBadGateway || !strings.Contains(string(body), "tunnel-unavailable") {
		t.Fatalf("dead tunnel must answer locally in the tunnel's vocabulary: status=%d body=%q", resp.StatusCode, body)
	}

	cancel()
	select {
	case err := <-relayDone:
		if err != nil {
			t.Fatalf("relay node shutdown: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("relay node did not stop on context cancellation")
	}
}

// TestRelayRefuseIPTargetsSwitch: an address target passes the relay's door
// by default (d242) and the exit's policy answers it; -refuse-ip-targets is
// the opt-in strict door, and neither state changes the guaranteed refusals.
func TestRelayRefuseIPTargetsSwitch(t *testing.T) {
	// The exit reserves the documentation range, so a target that passes the
	// relay dies at the exit's reservation with a deterministic token.
	s := newTunnelServer(t, true, egressConfig{DenyCidrs: []string{"203.0.113.0/24"}, Ports: []uint16{443}})
	proxy := newHTTPSServer(t, s)
	writeTestRelayJSON(t, "wss://"+proxy.Listener.Addr().String()+tunnelPath)
	t.Setenv(envClientLabel, "refuse-ip")

	startRelay := func(t *testing.T, refuseIPTargets bool) (string, string, func()) {
		t.Helper()
		httpAddr := freeLoopbackAddr(t)
		socksAddr := freeLoopbackAddr(t)
		cfg, err := relayConfigFromEnv(httpAddr, socksAddr, relaySelection{}, refuseIPTargets, false)
		if err != nil {
			t.Fatal(err)
		}
		runCtx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- runRelayNode(runCtx, cfg) }()
		waitForHealth(t, "http://"+httpAddr+healthPath)
		return httpAddr, socksAddr, func() {
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("runRelayNode: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("relay node did not stop on context cancellation")
			}
		}
	}

	// connect reads the refusal as one response: a refused CONNECT's
	// problem detail is its own status line + headers + body, so the
	// status line must stay for ReadResponse (the helper that skips it
	// exists for the 200-then-tunneled-exchange shape).
	connect := func(t *testing.T, httpAddr, target string) (int, string) {
		t.Helper()
		conn := rawDial(t, httpAddr)
		defer conn.Close()
		mustWrite(t, conn, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\n\r\n")
		resp, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodConnect})
		if err != nil {
			t.Fatalf("read CONNECT response: %v", err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}

	// socksReply drives one ATYP=IPv4 connect to target:443 and returns the
	// reply byte — the vocabulary split d163 keeps byte-identical. The
	// address is the fixture's reserved one, so a passing door answers at the
	// exit's policy instead of dialing the documentation range.
	socksReply := func(t *testing.T, socksAddr, addr string) byte {
		ip := net.ParseIP(addr).To4()
		if ip == nil {
			t.Fatalf("%q is not an IPv4 literal", addr)
		}
		t.Helper()
		conn := rawDial(t, socksAddr)
		defer conn.Close()
		mustWrite(t, conn, string([]byte{socksVersion, 1, socksNoAuth}))
		greet := make([]byte, 2)
		if _, err := io.ReadFull(conn, greet); err != nil || greet[1] != socksNoAuth {
			t.Fatalf("greeting reply %v err=%v", greet, err)
		}
		req := append([]byte{socksVersion, 1, 0, 1}, ip...)
		mustWrite(t, conn, string(append(req, 0x01, 0xbb)))
		reply := make([]byte, 10)
		if _, err := io.ReadFull(conn, reply); err != nil {
			t.Fatalf("socks reply: %v", err)
		}
		return reply[1]
	}

	t.Run("default: the target passes the door and the exit's policy answers", func(t *testing.T) {
		httpAddr, socksAddr, stop := startRelay(t, false)
		defer stop()
		code, body := connect(t, httpAddr, "203.0.113.9:443")
		if code != http.StatusForbidden || !strings.Contains(body, "tunnel-denied") {
			t.Fatalf("the exit's policy must answer: status=%d body=%q", code, body)
		}
		// The same verdict in SOCKS vocabulary: 0x02, the tunnel's ruleset
		// refusal — not 0x08, which is the door's own byte.
		if rep := socksReply(t, socksAddr, "203.0.113.9"); rep != 0x02 {
			t.Fatalf("socks address target rep=%#x, want the exit's 0x02", rep)
		}
	})

	t.Run("-refuse-ip-targets: the relay answers address targets itself", func(t *testing.T) {
		httpAddr, socksAddr, stop := startRelay(t, true)
		defer stop()
		code, body := connect(t, httpAddr, "203.0.113.9:443")
		if code != http.StatusForbidden || !strings.Contains(body, "target-refused") || !strings.Contains(body, "-refuse-ip-targets") {
			t.Fatalf("status=%d body=%q", code, body)
		}
		if rep := socksReply(t, socksAddr, "203.0.113.9"); rep != 0x08 {
			t.Fatalf("socks address target rep=%#x, want the strict door's 0x08", rep)
		}
	})

	t.Run("neither state opens the guaranteed refusals", func(t *testing.T) {
		// The guarantee answers first at this door, so the refusal of a bogon
		// address reads guaranteed-bogon under either posture.
		for _, refuseIPTargets := range []bool{false, true} {
			httpAddr, _, stop := startRelay(t, refuseIPTargets)
			for _, target := range []string{"127.0.0.1:443", "localhost:443", "localhost4.localdomain4:443"} {
				code, body := connect(t, httpAddr, target)
				if code != http.StatusForbidden || !strings.Contains(body, "target-refused") || !strings.Contains(body, "guaranteed-") {
					t.Fatalf("refuse-ip-targets=%v %s: status=%d body=%q", refuseIPTargets, target, code, body)
				}
			}
			stop()
		}
	})
}
