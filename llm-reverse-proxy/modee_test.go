package main

// modee_test.go — mode E acceptance (docs/d077 §3, d081's L4 amendment):
// the windowed floor over a plain h1.1 path, the demotion ladder through a
// hostile upgrade-refusing gateway, and the traceparent dispatch's
// camouflage surface. Unlike mode C, no TLS front is involved — mode E is
// the h1 plane by construction, so the fixtures stay plain and hermetic.

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// modeEFetch opens a local CONNECT and pulls one response through a tunnel
// session — the whole client→tunnel→upstream path for one connection, the
// mode C twin with its own body string.
func modeEFetch(t *testing.T, httpAddr, targetHost string, upPort uint16) {
	t.Helper()
	conn := rawDial(t, httpAddr)
	defer conn.Close()
	mustWrite(t, conn, "CONNECT "+targetHost+":"+strconv.Itoa(int(upPort))+" HTTP/1.1\r\nHost: "+targetHost+"\r\n\r\n"+
		"GET /mode-e HTTP/1.1\r\nHost: local.test\r\nConnection: close\r\n\r\n")
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
	if resp.StatusCode != http.StatusOK || string(body) != "hello-mode-e" || resp.Header.Get("X-Upstream") != "yes" {
		t.Fatalf("status=%d body=%q upstream-header=%q", resp.StatusCode, body, resp.Header.Get("X-Upstream"))
	}
}

// newHostileGateway is the posture mode E exists for (d077 §1): a gateway
// that refuses WebSocket upgrades with a plain 403 while passing ordinary
// POSTs. The tunnel URL is ws:// so the ALPN leg cannot exist — the ladder
// under test is D-refused → E, the rung this record's amendment added.
func newHostileGateway(t *testing.T, backend *httptest.Server) *httptest.Server {
	t.Helper()
	bu, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	rp := httputil.NewSingleHostReverseProxy(bu)
	rp.FlushInterval = time.Millisecond
	return newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if headerHasToken(r.Header, "Upgrade", "websocket") {
			http.Error(w, "upgrades are not supported", http.StatusForbidden)
			return
		}
		rp.ServeHTTP(w, r)
	}))
}

// wireRelayNode starts the relay role exactly as -mode relay wires it
// (production construction path — d072's drift lesson) and returns the
// loopback http address plus a shutdown func.
func wireRelayNode(t *testing.T, tunnelURL, modes string) (string, func()) {
	t.Helper()
	t.Setenv(envTunnelURL, tunnelURL)
	t.Setenv(envClientLabel, "mode-e-e2e")
	httpAddr := freeLoopbackAddr(t)
	socksAddr := freeLoopbackAddr(t)
	cfg, err := relayConfigFromEnv(httpAddr, socksAddr, modes)
	if err != nil {
		t.Fatalf("relayConfigFromEnv: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	relayDone := make(chan error, 1)
	go func() { relayDone <- runRelayNode(ctx, cfg) }()
	waitForHealth(t, "http://"+httpAddr+healthPath)
	return httpAddr, func() {
		cancel()
		select {
		case err := <-relayDone:
			if err != nil {
				t.Fatalf("runRelayNode: %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("relay node did not stop on context cancellation")
		}
	}
}

// modeETestServer wires the exit node through enableTunnel with an egress
// rule that reaches the loopback upstream, served plain (h1.1 — the plane
// mode E runs on).
func modeETestServer(t *testing.T, upstream *httptest.Server) (*server, *httptest.Server) {
	t.Helper()
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
	return s, newHTTPServer(t, s)
}

func TestModeEEndToEndOverPlainH1(t *testing.T) {
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Upstream", "yes")
		_, _ = io.WriteString(w, "hello-mode-e")
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())
	_, proxy := modeETestServer(t, upstream)

	httpAddr, stopRelay := wireRelayNode(t, "ws://"+proxy.Listener.Addr().String()+tunnelPath, "e")
	defer stopRelay()
	logBuf := captureLog(t)

	t.Run("one session carries a full CONNECT exchange over mode E", func(t *testing.T) {
		modeEFetch(t, httpAddr, "localhost", upPort)
	})

	t.Run("concurrent sessions — one trace-id and registry slot each", func(t *testing.T) {
		var wg sync.WaitGroup
		fail := make(chan string, 4)
		for i := 0; i < 4; i++ {
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
				if body, _ := io.ReadAll(resp.Body); string(body) != "hello-mode-e" {
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

	t.Run("both roles log the carrier and never the credential", func(t *testing.T) {
		// d077 §4: transport is operational debugging data; for mode E the
		// relay node's own plane is h1.1 POST, so both roles say "post".
		waitForLog(t, logBuf, "transport=post")
		waitForLog(t, logBuf, "tunnel session: authenticated key=default")
		if dumped := logBuf.String(); strings.Contains(dumped, testTunnelToken) {
			t.Fatalf("token leaked into the log:\n%s", dumped)
		}
	})
}

func TestModeEDemotionThroughHostileGateway(t *testing.T) {
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Upstream", "yes")
		_, _ = io.WriteString(w, "hello-mode-e")
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())
	_, backend := modeETestServer(t, upstream)
	gateway := newHostileGateway(t, backend)

	// The whole ladder on offer: C has no TLS leg to negotiate (ws:// plane),
	// D is refused by the gateway, E must carry the session — and the
	// refusal must be LOGGED as a demotion, never surfacing as failure
	// (d077 §4's invariant, the amendment's ladder).
	httpAddr, stopRelay := wireRelayNode(t, "ws://"+gateway.Listener.Addr().String()+tunnelPath, "cde")
	defer stopRelay()
	logBuf := captureLog(t)

	modeEFetch(t, httpAddr, "localhost", upPort)

	waitForLog(t, logBuf, "falling back to mode E")
	waitForLog(t, logBuf, "transport=post")
	if dumped := logBuf.String(); strings.Contains(dumped, testTunnelToken) {
		t.Fatalf("token leaked into the log:\n%s", dumped)
	}
}

func TestModeEWindowsAreAuthenticatedAndCamouflaged(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{AllowCidrs: []string{"127.0.0.0/8"}})
	backend := newHTTPServer(t, s)
	target := backend.URL + tunnelPath
	logBuf := captureLog(t)

	// trace, span, body as one POST.
	post := func(t *testing.T, traceparent, bearer string, body []byte) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, target, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		if traceparent != "" {
			req.Header.Set("traceparent", traceparent)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return resp
	}

	validTrace := "000000000000000000000000000000aa"
	firstWindow := buildTraceparent(validTrace, firstWindowSpan)
	hello, err := encodeFrame(frameHello, tunnelStreamV1, func() []byte {
		p, err := encodeHello("win-label")
		if err != nil {
			t.Fatal(err)
		}
		return p
	}())
	if err != nil {
		t.Fatal(err)
	}

	t.Run("wrong credential on a window is the camouflage 404", func(t *testing.T) {
		resp := post(t, firstWindow, strings.Repeat("x", 16), hello)
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("unauthenticated window answered %d, want 404 (VPN-R34)", resp.StatusCode)
		}
	})

	t.Run("malformed traceparent is the same 404", func(t *testing.T) {
		resp := post(t, "not-a-traceparent", testTunnelToken, hello)
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("malformed traceparent answered %d, want 404", resp.StatusCode)
		}
	})

	t.Run("a continuation without state is the same 404", func(t *testing.T) {
		// Span > 1 on an unknown trace-id: the registry never minted it,
		// and the answer must not reveal that minting works (d077 §3).
		resp := post(t, buildTraceparent("000000000000000000000000000000bb", 7), testTunnelToken, hello)
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("continuation-without-state answered %d, want 404", resp.StatusCode)
		}
	})

	t.Run("span 1 opens a session, attributed to its key", func(t *testing.T) {
		resp := post(t, firstWindow, testTunnelToken, hello)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("first window answered %d, want 200", resp.StatusCode)
		}
		waitForLog(t, logBuf, "tunnel session: authenticated key=default")
	})

	t.Run("an out-of-order window on a live session is the same 404", func(t *testing.T) {
		// The session above is live at span 2; span 7 is a desync a
		// stop-and-wait client can never produce — 404, session untouched.
		resp := post(t, buildTraceparent(validTrace, 7), testTunnelToken, hello)
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("out-of-order window answered %d, want 404", resp.StatusCode)
		}
		// The correct next span still works (the refusal above was a
		// window, not a session kill): span 2 gets its 200.
		resp = post(t, buildTraceparent(validTrace, 2), testTunnelToken, hello)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("next in-sequence window answered %d, want 200", resp.StatusCode)
		}
	})

	if dumped := logBuf.String(); strings.Contains(dumped, testTunnelToken) {
		t.Fatalf("token leaked into the log:\n%s", dumped)
	}
}

func TestParseTraceparent(t *testing.T) {
	trace := "0123456789abcdef0123456789abcdef"
	tests := []struct {
		in       string
		wantID   string
		wantSpan uint64
		wantErr  bool
	}{
		{in: "00-" + trace + "-000000000000002a-01", wantID: trace, wantSpan: 42},
		{in: "00-" + strings.ToUpper(trace) + "-000000000000002a-00", wantID: trace, wantSpan: 42},
		{in: "01-" + trace + "-000000000000002a-01", wantErr: true},                   // unknown version
		{in: "00-" + trace + "-000000000000002a", wantErr: true},                      // 3 fields
		{in: "00-0123456789abcdef-000000000000002a-01", wantErr: true},                // short trace-id
		{in: "00-" + strings.Repeat("z", 32) + "-000000000000002a-01", wantErr: true}, // not hex
		{in: "00-" + strings.Repeat("0", 32) + "-000000000000002a-01", wantErr: true}, // all-zero trace-id
		{in: "00-" + trace + "-0000000000000000-01", wantErr: true},                   // all-zero span-id
		{in: "00-" + trace + "-000000000000002a-0", wantErr: true},                    // short flags
		{in: "00-" + trace + "-000000000000002a-0g", wantErr: true},                   // flags not hex
	}
	for _, tc := range tests {
		gotID, gotSpan, err := parseTraceparent(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("parseTraceparent(%q) err=nil, want error", tc.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseTraceparent(%q) unexpected err: %v", tc.in, err)
			continue
		}
		if gotID != tc.wantID || gotSpan != tc.wantSpan {
			t.Errorf("parseTraceparent(%q) = (%q, %d), want (%q, %d)", tc.in, gotID, gotSpan, tc.wantID, tc.wantSpan)
		}
	}

	t.Run("build/parse round-trip", func(t *testing.T) {
		id, err := newTraceID()
		if err != nil {
			t.Fatal(err)
		}
		gotID, gotSpan, err := parseTraceparent(buildTraceparent(id, 99))
		if err != nil || gotID != id || gotSpan != 99 {
			t.Fatalf("round-trip = (%q, %d, %v)", gotID, gotSpan, err)
		}
	})
}
