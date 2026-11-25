package main

// modee_test.go — h1.1-post-windowed acceptance (docs/d077 §3, d081's L4 amendment):
// the windowed floor over a plain h1.1 path, the demotion ladder through a
// hostile upgrade-refusing gateway, and the traceparent dispatch's
// camouflage surface. Unlike h2-post-unbounded, no TLS front is involved — h1.1-post-windowed is
// the h1 plane by construction, so the fixtures stay plain and hermetic.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// h1PostWindowedFetch opens a local CONNECT and pulls one response through a tunnel
// session — the whole client→tunnel→upstream path for one connection, the
// h2-post-unbounded twin with its own body string.
func h1PostWindowedFetch(t *testing.T, httpAddr, targetHost string, upPort uint16) {
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
	if resp.StatusCode != http.StatusOK || string(body) != "hello-post" || resp.Header.Get("X-Upstream") != "yes" {
		t.Fatalf("status=%d body=%q upstream-header=%q", resp.StatusCode, body, resp.Header.Get("X-Upstream"))
	}
}

// wireRelayNode starts the relay role exactly as -mode relay wires it
// (production construction path — d072's drift lesson) and returns the
// loopback http address plus a shutdown func.
func wireRelayNode(t *testing.T, tunnelURL string) (string, func()) {
	t.Helper()
	t.Setenv(envTunnelURL, tunnelURL)
	t.Setenv(envClientLabel, "mode-e-e2e")
	httpAddr := freeLoopbackAddr(t)
	socksAddr := freeLoopbackAddr(t)
	cfg, err := relayConfigFromEnv(httpAddr, socksAddr, false, false)
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

// h1PostWindowedTestServer wires the exit node through enableTunnel with an egress
// rule that reaches the loopback upstream, served plain (h1.1 — the plane
// h1.1-post-windowed runs on).
func h1PostWindowedTestServer(t *testing.T, upstream *httptest.Server) *httptest.Server {
	t.Helper()
	return newHTTPServer(t, h1PostWindowedTestBackend(t, upstream))
}

// h1PostWindowedTestBackend is the tunnel handler itself, for fixtures that
// need to be the TLS edge (no reverse proxy) to keep a window full duplex.
func h1PostWindowedTestBackend(t *testing.T, upstream *httptest.Server) *server {
	t.Helper()
	upPort := portOf(t, upstream.Listener.Addr().String())
	armTestTunnelEnv(t)
	s := &server{}
	if err := s.enableTunnel(egressConfig{
		AllowCidrs: []string{"127.0.0.0/8"},
		Ports:      []uint16{upPort},
	}); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestH1PostWindowedEndToEndOverPlainH1(t *testing.T) {
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Upstream", "yes")
		_, _ = io.WriteString(w, "hello-post")
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())
	backend := h1PostWindowedTestBackend(t, upstream)
	front := newUpgradeRefusingTLSFront(t, backend)

	// The cleartext end of docs/d090's accepted set (an honest http:// URL,
	// normalized to ws once) behind an upgrade-refusing TLS edge: with the
	// whole ladder riding (docs/d093), a plain tunnel server legitimately
	// carries D — E is what a refused upgrade demotes to, so the edge is
	// what pins the carrier under test.
	httpAddr, stopRelay := wireRelayNode(t, front.URL+tunnelPath)
	defer stopRelay()
	logBuf := captureLog(t)

	t.Run("one session carries a full CONNECT exchange over h1.1-post-windowed", func(t *testing.T) {
		h1PostWindowedFetch(t, httpAddr, testTargetAlias, upPort)
	})

	t.Run("concurrent sessions — one trace-id and registry slot each", func(t *testing.T) {
		var wg sync.WaitGroup
		fail := make(chan string, 4)
		for range 4 {
			wg.Go(func() {
				conn := rawDial(t, httpAddr)
				defer conn.Close()
				mustWrite(t, conn, "CONNECT "+testTargetAlias+":"+strconv.Itoa(int(upPort))+" HTTP/1.1\r\nHost: "+testTargetAlias+"\r\n\r\n"+
					"GET /p HTTP/1.1\r\nHost: local.test\r\nConnection: close\r\n\r\n")
				br := bufio.NewReader(conn)
				status, err := br.ReadString('\n')
				if err != nil || !strings.Contains(status, " 200 ") {
					fail <- "CONNECT: " + strings.TrimSpace(status) + " err=" + fmt.Sprint(err)
					return
				}
				resp := readHTTPResponse(t, br)
				defer resp.Body.Close()
				if body, _ := io.ReadAll(resp.Body); string(body) != "hello-post" {
					fail <- "body=" + string(body)
				}
			})
		}
		wg.Wait()
		close(fail)
		for f := range fail {
			t.Errorf("concurrent session failed: %s", f)
		}
	})

	t.Run("both roles log the carrier and never the credential", func(t *testing.T) {
		// d077 §4: transport is operational debugging data; for h1.1-post-windowed the
		// relay node's own plane is h1.1 POST, so both roles say "post".
		waitForLog(t, logBuf, "transport=h1.1-post-windowed")
		waitForLog(t, logBuf, "key=default")
		if dumped := logBuf.String(); strings.Contains(dumped, testTunnelToken) {
			t.Fatalf("token leaked into the log:\n%s", dumped)
		}
	})
}

func TestH1PostWindowedDemotionThroughHostileGateway(t *testing.T) {
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Upstream", "yes")
		_, _ = io.WriteString(w, "hello-post")
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())
	backend := h1PostWindowedTestBackend(t, upstream)
	front := newUpgradeRefusingTLSFront(t, backend)

	// The whole ladder rides (docs/d093): on the h1 plane C is
	// unreachable, D is refused by the edge, E must carry the session —
	// and the refusal must be LOGGED as a demotion, never surfacing as
	// failure (d077 §4's invariant, the amendment's ladder).
	httpAddr, stopRelay := wireRelayNode(t, front.URL+tunnelPath)
	defer stopRelay()
	logBuf := captureLog(t)

	h1PostWindowedFetch(t, httpAddr, testTargetAlias, upPort)

	waitForLog(t, logBuf, "trying h1.1-post-windowed")
	waitForLog(t, logBuf, "transport=h1.1-post-windowed")
	if dumped := logBuf.String(); strings.Contains(dumped, testTunnelToken) {
		t.Fatalf("token leaked into the log:\n%s", dumped)
	}
}

// TestGeneralizedTunnelURLDemotesOverTLS is docs/d090's generalized
// VPN_TUNNEL_URL end to end: an honest https:// URL against an h1-only TLS
// gateway that refuses upgrades. The C probe finds no h2 at ALPN (no C
// session is attempted), the D upgrade is refused and demoted, and E carries
// the session — the whole ladder on the URL's own wire form, with the
// normalization and every carrier untouched.
func TestGeneralizedTunnelURLDemotesOverTLS(t *testing.T) {
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Upstream", "yes")
		_, _ = io.WriteString(w, "hello-post")
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())
	backend := h1PostWindowedTestBackend(t, upstream)
	front := newUpgradeRefusingTLSFront(t, backend)

	httpAddr, stopRelay := wireRelayNode(t, front.URL+tunnelPath)
	defer stopRelay()
	logBuf := captureLog(t)

	h1PostWindowedFetch(t, httpAddr, testTargetAlias, upPort)

	waitForLog(t, logBuf, "trying h1.1-post-windowed")
	waitForLog(t, logBuf, "transport=h1.1-post-windowed")
	if dumped := logBuf.String(); strings.Contains(dumped, testTunnelToken) {
		t.Fatalf("token leaked into the log:\n%s", dumped)
	}
}

func TestH1PostWindowedWindowsAreAuthenticatedAndCamouflaged(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{AllowCidrs: []string{"127.0.0.0/8"}})
	backend := newHTTPServer(t, s)
	target := backend.URL + tunnelPath
	logBuf := captureLog(t)

	// trace, span, body as one POST.
	post := func(t *testing.T, traceparent, bearer string, body []byte) int {
		t.Helper()
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, target, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if bearer != "" {
			applyTestV5Headers(t, req.Header)

		}
		if traceparent != "" {
			req.Header.Set("Traceparent", traceparent)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		return resp.StatusCode
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
		status := post(t, firstWindow, "", hello)
		if status != http.StatusNotFound {
			t.Fatalf("unauthenticated window answered %d, want 404 (VPN-R34)", status)
		}
	})

	t.Run("malformed traceparent is the same 404", func(t *testing.T) {
		status := post(t, "not-a-traceparent", testTunnelToken, hello)
		if status != http.StatusNotFound {
			t.Fatalf("malformed traceparent answered %d, want 404", status)
		}
	})

	t.Run("a continuation without state is the same 404", func(t *testing.T) {
		// Span > 1 on an unknown trace-id: the registry never minted it,
		// and the answer must not reveal that minting works (d077 §3).
		status := post(t, buildTraceparent("000000000000000000000000000000bb", 7), testTunnelToken, hello)
		if status != http.StatusNotFound {
			t.Fatalf("continuation-without-state answered %d, want 404", status)
		}
	})

	t.Run("span 1 opens a session, attributed to its key", func(t *testing.T) {
		status, _ := postWindowWithChannel(t, target, firstWindow, hello)
		if status != http.StatusOK {
			t.Fatalf("first window answered %d, want 200", status)
		}
	})

	t.Run("an out-of-order window on a live session is the same 404", func(t *testing.T) {
		// The session above is live at span 2; span 7 is a desync a
		// stop-and-wait client can never produce — 404, session untouched.
		status := post(t, buildTraceparent(validTrace, 7), testTunnelToken, hello)
		if status != http.StatusNotFound {
			t.Fatalf("out-of-order window answered %d, want 404", status)
		}
		// The correct next span still works (the refusal above was a
		// window, not a session kill): span 2 gets its 200.
		status, _ = postWindowWithChannel(t, target, buildTraceparent(validTrace, 2), hello)
		if status != http.StatusOK {
			t.Fatalf("next in-sequence window answered %d, want 200", status)
		}
	})

	if dumped := logBuf.String(); strings.Contains(dumped, testTunnelToken) {
		t.Fatalf("token leaked into the log:\n%s", dumped)
	}
}

// A window the exit cannot drain must FAIL on the wire, not just in the log.
// The drain-failure path used to return without writing a status, so net/http
// emitted an empty 200 while the CLF line recorded 500 — the client saw a
// healthy session and the log disagreed with it (VPN-R26 mid-session
// semantics: a broken window means a dead session, and the peer must be able
// to tell).
func TestH1PostWindowedDrainFailureAnswersAnError(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{AllowCidrs: []string{"127.0.0.0/8"}})
	backend := newHTTPServer(t, s)
	target := backend.URL + tunnelPath

	// The registry admits a window until inboundWindowCap bytes are queued;
	// maxFramePayload-sized frames cross it on the third one
	// (inboundWindowCap is exchangeWindowBytes + maxFramePayload, i.e. two
	// frame payloads). The relay reads nothing here, so the queue fills.
	body := make([]byte, 0, 3*(frameHeaderLen+maxFramePayload))
	for range 3 {
		frame, err := encodeFrame(frameData, tunnelStreamV1, make([]byte, maxFramePayload))
		if err != nil {
			t.Fatal(err)
		}
		body = append(body, frame...)
	}

	status, detail := postWindowWithChannel(t, target, buildTraceparent("000000000000000000000000000000cc", firstWindowSpan), body)
	// The 200 is committed when the handshake opens the window, so the
	// failure is visible in the body, not in a second status line.
	if status != http.StatusOK || !strings.Contains(detail, "tunnel-window-failed") {
		t.Fatalf("drain failure answered status=%d body=%q", status, detail)
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
		id, err := newSessionID()
		if err != nil {
			t.Fatal(err)
		}
		gotID, gotSpan, err := parseTraceparent(buildTraceparent(id, 99))
		if err != nil || gotID != id || gotSpan != 99 {
			t.Fatalf("round-trip = (%q, %d, %v)", gotID, gotSpan, err)
		}
	})
}

// A h1.1-post-windowed session is bound to the key that minted it. Without the binding, a
// second — individually valid — operator key that learned a trace-id could
// attach to or destroy someone else's session. The refusal must be the same
// camouflage 404 as every other refusal (VPN-R34), and it must INTERRUPT the
// tunnel: every tunnel session exists only under authentication, so a failed
// authentication kills the carrier rather than merely declining a request.
func TestH1PostWindowedDesyncDoesNotKillTheSession(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{AllowCidrs: []string{"127.0.0.0/8"}})
	backend := newHTTPServer(t, s)
	target := backend.URL + tunnelPath

	post := func(t *testing.T, traceparent string) int {
		t.Helper()
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, target, strings.NewReader(""))
		if err != nil {
			t.Fatal(err)
		}
		applyTestV5Headers(t, req.Header)
		req.Header.Set("Traceparent", traceparent)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return resp.StatusCode
	}

	const trace = "000000000000000000000000000000ee"
	if got, _ := postWindowWithChannel(t, target, buildTraceparent(trace, firstWindowSpan), nil); got == http.StatusNotFound {
		t.Fatalf("first window refused (%d)", got)
	}
	// Out-of-sequence with the SAME key: refused, session untouched.
	if got := post(t, buildTraceparent(trace, 9)); got != http.StatusNotFound {
		t.Fatalf("desynced window answered %d, want 404", got)
	}
	// The in-sequence window still works, proving no session kill happened.
	if got, _ := postWindowWithChannel(t, target, buildTraceparent(trace, 2), nil); got == http.StatusNotFound {
		t.Fatal("a desynced window killed the session; it must not (only an auth failure does)")
	}
}

// postWindowWithChannel drives one h1.1-post-windowed exchange the way the
// relay does: proof headers, 200, inner TLS handshake, then the window's
// frames. Refusals that arrive before the handshake are still read as plain
// HTTP statuses, so the camouflage matrix stays testable at this layer.
func postWindowWithChannel(t *testing.T, target, traceparent string, frames []byte) (int, string) {
	t.Helper()
	store, err := loadRelayStore(storeRoot())
	if err != nil {
		t.Fatal(err)
	}
	hdr, nonce, err := channelRequestHeaders(store.Private, store.Principal, store.Exits[0].Name, store.SelfDER)
	if err != nil {
		t.Fatal(err)
	}
	pr, pw := io.Pipe()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, target, pr)
	if err != nil {
		t.Fatal(err)
	}
	maps.Copy(req.Header, hdr)
	req.Header.Set("Traceparent", traceparent)
	type dialResult struct {
		resp *http.Response
		err  error
	}
	dialed := make(chan dialResult, 1)
	go func() {
		resp, err := http.DefaultClient.Do(req) //nolint:bodyclose // the helper closes resp before returning
		dialed <- dialResult{resp: resp, err: err}
	}()
	result := <-dialed
	if result.err != nil {
		_ = pw.Close()
		t.Fatal(result.err)
	}
	resp := result.resp
	if resp.StatusCode != http.StatusOK {
		_ = pw.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return resp.StatusCode, string(body)
	}
	if err := verifyExitResponse(resp.Header, store, req.URL.Host, newNonceRing(4), nonce); err != nil {
		_ = pw.Close()
		t.Fatal(err)
	}
	local := tls.Certificate{Certificate: [][]byte{store.SelfDER}, PrivateKey: store.Private}
	carrier := &windowCarrier{
		readFrame: func() ([]byte, error) { return readFrameFromStream(resp.Body) },
		writeFrame: func(msg []byte) error {
			_, err := pw.Write(msg)
			return err
		},
		fail:    func() { _ = pw.Close() },
		carrier: carrierH1Windowed,
		session: traceparent,
	}
	conn, err := clientChannelHandshake(context.Background(), carrier, local, store.Exits[0].Cert)
	if err != nil {
		_ = pw.Close()
		t.Fatal(err)
	}
	carrier.fail = func() {}
	if _, err := conn.Write(frames); err != nil {
		t.Fatal(err)
	}
	if err := pw.Close(); err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	_ = conn.Close()
	return resp.StatusCode, string(body)
}
