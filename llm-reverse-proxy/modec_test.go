package main

// Mode C acceptance (docs/d077 §3/§8): the session rides one streaming
// POST over h2 to an edge that forwards h1.1 to the exit node — evidence E2's
// shape, reproduced locally with an HTTP/2 httptest front and a reverse
// proxy. The relay node's trust stays what production's is: system roots, no
// override knob (VPN-R28/R55); the test installs the front's self-signed
// cert as the process root via SSL_CERT_FILE, which the x509 package reads
// on its first root load — this test must therefore be the first TLS user
// in the binary, and nothing may load roots before it.

import (
	"bufio"
	"context"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// newHTTP2Front is E2 in miniature: TLS + HTTP/2 at the edge, HTTP/1.1 to
// the backend. FlushInterval is 1ms so the front cannot hide the unbuffered
// streaming mode C exists for (d077 §5) behind its own buffering.
func newHTTP2Front(t *testing.T, backend *httptest.Server) *httptest.Server {
	t.Helper()
	bu, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	rp := httputil.NewSingleHostReverseProxy(bu)
	rp.FlushInterval = time.Millisecond
	front := httptest.NewUnstartedServer(rp)
	front.EnableHTTP2 = true
	front.StartTLS()
	t.Cleanup(front.Close)
	return front
}

// trustTestCert points x509's system-root load at the test front's cert.
// Production has exactly no equivalent knob — this is test plumbing, not a
// relay-side TLS override (VPN-R28).
func trustTestCert(t *testing.T, srv *httptest.Server) {
	t.Helper()
	cert := srv.Certificate()
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})
	if pemBytes == nil {
		t.Fatal("encode front certificate")
	}
	path := filepath.Join(t.TempDir(), "front-cert.pem")
	if err := os.WriteFile(path, pemBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SSL_CERT_FILE", path)
}

// modeCFetch opens a local CONNECT and pulls one response through a tunnel
// session — the whole client→tunnel→upstream path for one connection.
func modeCFetch(t *testing.T, httpAddr, targetHost string, upPort uint16) {
	t.Helper()
	conn := rawDial(t, httpAddr)
	defer conn.Close()
	mustWrite(t, conn, "CONNECT "+targetHost+":"+strconv.Itoa(int(upPort))+" HTTP/1.1\r\nHost: "+targetHost+"\r\n\r\n"+
		"GET /mode-c HTTP/1.1\r\nHost: local.test\r\nConnection: close\r\n\r\n")
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
	if resp.StatusCode != http.StatusOK || string(body) != "hello-mode-c" || resp.Header.Get("X-Upstream") != "yes" {
		t.Fatalf("status=%d body=%q upstream-header=%q", resp.StatusCode, body, resp.Header.Get("X-Upstream"))
	}
}

func TestModeCEndToEndOverHTTP2Front(t *testing.T) {
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Upstream", "yes")
		_, _ = io.WriteString(w, "hello-mode-c")
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())

	t.Setenv(envOperatorToken, testTunnelToken)
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
	backend := newHTTPServer(t, s)

	front := newHTTP2Front(t, backend)
	trustTestCert(t, front)

	fu, err := url.Parse(front.URL)
	if err != nil {
		t.Fatal(err)
	}
	fu.Scheme = "wss"
	fu.Path = tunnelPath
	t.Setenv(envTunnelURL, fu.String())
	t.Setenv(envClientLabel, "mode-c-e2e")

	httpAddr := freeLoopbackAddr(t)
	socksAddr := freeLoopbackAddr(t)
	cfg, err := relayConfigFromEnv(httpAddr, socksAddr, "c,d")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	relayDone := make(chan error, 1)
	go func() { relayDone <- runRelayNode(ctx, cfg) }()

	logBuf := captureLog(t)
	waitForHealth(t, "http://"+httpAddr+healthPath)

	t.Run("one session carries a full CONNECT exchange over mode C", func(t *testing.T) {
		modeCFetch(t, httpAddr, "localhost", upPort)
	})

	t.Run("six concurrent sessions — the browser's parallel-connection count", func(t *testing.T) {
		// d077 L3 is a gateway-side measurement; this is the local half of
		// the same claim: nothing in the code serializes sessions, and six
		// POST carriers must run at once without stalls.
		var wg sync.WaitGroup
		fail := make(chan string, 6)
		for i := 0; i < 6; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				conn := rawDial(t, httpAddr)
				defer conn.Close()
				mustWrite(t, conn, "CONNECT localhost:"+strconv.Itoa(int(upPort))+" HTTP/1.1\r\nHost: localhost\r\n\r\n"+
					"GET /p HTTP/1.1\r\nHost: local.test\r\nConnection: close\r\n\r\n")
				br := bufio.NewReader(conn)
				status, err := br.ReadString('\n')
				if err != nil || !strings.Contains(status, " 200 ") {
					fail <- "CONNECT: " + strings.TrimSpace(status) + " err=" + fmt.Sprint(err)
					return
				}
				resp := readHTTPResponse(t, br)
				defer resp.Body.Close()
				body, _ := io.ReadAll(resp.Body)
				if string(body) != "hello-mode-c" {
					fail <- "body=" + string(body)
				}
			}()
		}
		wg.Wait()
		close(fail)
		for f := range fail {
			t.Errorf("concurrent session failed: %s", f)
		}
	})

	t.Run("both carriers are visible in the logs", func(t *testing.T) {
		// d077 §4: transport is operational debugging data. The server saw
		// a POST (the edge stripped the ALPN evidence); the relay node saw h2.
		waitForLog(t, logBuf, "transport=post")
		waitForLog(t, logBuf, "transport=h2")
		dumped := logBuf.String()
		if strings.Contains(dumped, testTunnelToken) {
			t.Fatalf("token leaked into the log:\n%s", dumped)
		}
	})

	cancel()
	if err := <-relayDone; err != nil {
		t.Fatalf("runRelayNode: %v", err)
	}
}

func TestModeCArrivalIsAuthenticatedAndCamouflaged(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{AllowCidrs: []string{"127.0.0.0/8"}})
	backend := newHTTPServer(t, s)
	target := backend.URL + tunnelPath
	logBuf := captureLog(t)

	t.Run("wrong credential on a POST is the camouflage 404", func(t *testing.T) {
		req, err := http.NewRequest(http.MethodPost, target, strings.NewReader("not-a-frame"))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 16))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("unauthenticated POST answered %d, want 404 (VPN-R34)", resp.StatusCode)
		}
		if strings.Contains(string(body), tunnelPath) {
			t.Fatalf("404 body echoes the tunnel path: %s", body)
		}
	})

	t.Run("no credential at all is the same 404", func(t *testing.T) {
		resp, err := http.Post(target, "application/octet-stream", strings.NewReader("x"))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("anonymous POST answered %d, want 404", resp.StatusCode)
		}
	})

	t.Run("a valid credential opens a POST session, attributed to its key", func(t *testing.T) {
		req, err := http.NewRequest(http.MethodPost, target, strings.NewReader("x"))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+testTunnelToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("authenticated POST answered %d, want 200", resp.StatusCode)
		}
		// The truncated "frame" ends the session; the carrier and the key
		// must both be on record (d077 §4 transport, d078 §5 attribution).
		waitForLog(t, logBuf, "tunnel session: authenticated key=default")
		waitForLog(t, logBuf, "transport=post")
	})
}

func TestParseClientModes(t *testing.T) {
	tests := []struct {
		in      string
		want    string
		wantErr string
	}{
		{in: "d", want: "d"},               // one built mode on offer
		{in: "c,d", want: "cd"},            // both c and d on offer
		{in: "c", want: "c"},               // operator's choice: C only, fail closed if it fails
		{in: "D,C", want: "cd"},            // case-insensitive, canonical order
		{in: "e", want: "e"},               // the floor alone — a deployment where nothing else works (d081's amendment: E built, L4 demoted)
		{in: "e,d", want: "de"},            // the E rung joins the ladder in canonical order
		{in: "cde", want: "cde"},           // the default offer (d084 as amended)
		{in: "x", wantErr: "unknown mode"}, // typo is loud, not routed around (NFR-2)
		{in: "", wantErr: "at least one"},
		{in: ",", wantErr: "at least one"},
	}
	for _, tc := range tests {
		got, err := parseRelayModes(tc.in)
		if tc.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("parseRelayModes(%q) err=%v, want containing %q", tc.in, err, tc.wantErr)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseRelayModes(%q) unexpected err: %v", tc.in, err)
		}
		if got != tc.want {
			t.Errorf("parseRelayModes(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
