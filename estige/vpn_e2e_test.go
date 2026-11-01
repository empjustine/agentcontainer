package main

// vpn_e2e_test.go — the tunnel path in one process: real exit node, real
// relay node, real tunnel, a local upstream, and both local listener types.
// Everything below uses the production construction paths (enableTunnel,
// relayConfigFromEnv, runRelayNode) so a test cannot pass while main() wires
// the pieces differently (d072's drift lesson).

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
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
		resp, err := http.Get(healthURL)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("health endpoint %s never came up", healthURL)
}

// healthSessions reads the relay's tunnel-session counter — d103's
// "answered from the tunnel" is proven by this number moving, not by the
// response alone (a direct dial would answer just as well).
func healthSessions(t *testing.T, healthURL string) int64 {
	t.Helper()
	resp, err := http.Get(healthURL)
	if err != nil {
		t.Fatalf("healthz: %v", err)
	}
	defer resp.Body.Close()
	var status struct {
		Sessions int64 `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		t.Fatalf("healthz body: %v", err)
	}
	return status.Sessions
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
		_, _ = io.WriteString(w, "hello-upstream")
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())

	// Server: provider allowlist + the tunnel through the production path.
	armTestTunnelEnv(t)
	localProvider, err := newProvider("local.test", upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{providers: map[string]*provider{"local.test": localProvider}}
	if err := s.enableTunnel(&tunnelConfig{Egress: egressConfig{
		AllowCidrs: []string{"127.0.0.0/8"},
		Ports:      []uint16{upPort},
	}}); err != nil {
		t.Fatal(err)
	}
	proxy := newHTTPServer(t, s)

	// Relay node: env chain + runRelayNode, exactly as -mode relay wires it.
	t.Setenv(envTunnelURL, "ws://"+proxy.Listener.Addr().String()+tunnelPath)
	t.Setenv(envClientLabel, "e2e-label")
	httpAddr := freeLoopbackAddr(t)
	socksAddr := freeLoopbackAddr(t)
	cfg, err := relayConfigFromEnv(httpAddr, socksAddr)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	relayDone := make(chan error, 1)
	go func() { relayDone <- runRelayNode(ctx, cfg) }()

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
		mustWrite(t, conn, "CONNECT localhost:"+strconv.Itoa(int(upPort))+" HTTP/1.1\r\nHost: localhost\r\n\r\n"+
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

		req := []byte{socksVersion, 1, 0, 3, byte(len("localhost"))}
		req = append(req, "localhost"...)
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

	t.Run("cleartext absolute-form http is answered from the tunnel (d103)", func(t *testing.T) {
		healthURL := "http://" + httpAddr + healthPath
		before := healthSessions(t, healthURL)
		conn := rawDial(t, httpAddr)
		defer conn.Close()
		target := "localhost:" + strconv.Itoa(int(upPort))
		// No CONNECT anywhere: the request itself must open a tunnel
		// session (before/after on /healthz) — a 405 means d103 is not
		// implemented, an answer without a new session means a direct
		// dial, which VPN-R26 forbids.
		mustWrite(t, conn, "GET http://"+target+"/fwd HTTP/1.1\r\n"+
			"Host: "+target+"\r\n"+
			"Proxy-Connection: keep-alive\r\n"+
			"Proxy-Authorization: Basic bogus\r\n"+
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
		if resp.Header.Get("Proxy-Connection") != "" {
			t.Fatalf("hop-by-hop Proxy-Connection echoed back: %v", resp.Header)
		}
		if !resp.Close {
			t.Fatal("response must force Connection: close — one tunneled exchange per client connection (d103)")
		}
		if after := healthSessions(t, healthURL); after <= before {
			t.Fatalf("request never opened a tunnel: sessions before=%d after=%d", before, after)
		}
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
		mustWrite(t, conn, "GET http://localhost:1/fwd HTTP/1.1\r\nHost: localhost:1\r\nConnection: close\r\n\r\n")
		resp := readHTTPResponse(t, bufio.NewReader(conn))
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusForbidden || !strings.Contains(string(body), "tunnel-denied") {
			t.Fatalf("policy refusal must come from the tunnel: status=%d body=%q", resp.StatusCode, body)
		}
	})

	t.Run("IP-literal absolute-form target is refused by the exit's verdict (VPN-R22, d103)", func(t *testing.T) {
		conn := rawDial(t, httpAddr)
		defer conn.Close()
		addr := "127.0.0.1:" + strconv.Itoa(int(upPort))
		mustWrite(t, conn, "GET http://"+addr+"/fwd HTTP/1.1\r\nHost: "+addr+"\r\nConnection: close\r\n\r\n")
		resp := readHTTPResponse(t, bufio.NewReader(conn))
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusForbidden || !strings.Contains(string(body), "tunnel-denied") {
			t.Fatalf("IP literals must be the exit's policy verdict, not a dial: status=%d body=%q", resp.StatusCode, body)
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
		target := "localhost:" + strconv.Itoa(int(upPort))
		mustWrite(t, conn, "GET ws://"+target+"/echo HTTP/1.1\r\n"+
			"Host: "+target+"\r\n"+
			"Connection: Upgrade\r\nUpgrade: websocket\r\n"+
			"Sec-WebSocket-Key: dGVzdGtleTEyMzQ1Ng==\r\nSec-WebSocket-Version: 13\r\n\r\n")
		br := bufio.NewReader(conn)
		resp := readHTTPResponse(t, br)
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
		resp, err := http.Get("http://" + httpAddr + healthPath)
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
		waitForLog(t, logBuf, "[vpn] who=operator")
		dumped := logBuf.String()
		if strings.Contains(dumped, testTunnelToken) {
			t.Fatalf("token leaked into the log:\n%s", dumped)
		}
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
	t.Setenv(envTunnelURL, "ws://"+dead+tunnelPath)
	t.Setenv(envOperatorToken, testTunnelToken)
	t.Setenv(envClientLabel, "dead-tunnel-fwd")
	httpAddr := freeLoopbackAddr(t)
	socksAddr := freeLoopbackAddr(t)
	cfg, err := relayConfigFromEnv(httpAddr, socksAddr)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	relayDone := make(chan error, 1)
	go func() { relayDone <- runRelayNode(ctx, cfg) }()
	waitForHealth(t, "http://"+httpAddr+healthPath)

	conn := rawDial(t, httpAddr)
	defer conn.Close()
	mustWrite(t, conn, "GET http://localhost:9/fwd HTTP/1.1\r\nHost: localhost:9\r\nConnection: close\r\n\r\n")
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
