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
	// The origin an allowlisted upstream points at.
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Upstream", "yes")
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
