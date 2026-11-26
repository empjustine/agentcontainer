package main

// h2windowed_test.go — the h2-post-windowed carrier (docs/d222): window
// rotation on the size bound, the capped-edge port's request-initiation
// refusal of h2-post-unbounded, and the window grammar.

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
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

// newUpgradeStrippingH2Front is the capped-edge shape in one proxy layer: h2
// at the edge (so h2-post-windowed is reachable) and a 403 for every
// WebSocket upgrade (so the ladder must skip the WebSocket). The suite's
// shared hostile gateway is a second proxy layer, and two chained httputil
// proxies deadlock on an open response body in the Go 1.27 stack — one layer
// is the faithful shape for this carrier.
func newUpgradeStrippingH2Front(t *testing.T, backend *httptest.Server) *httptest.Server {
	t.Helper()
	bu, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	rp := httputil.NewSingleHostReverseProxy(bu)
	rp.FlushInterval = time.Millisecond
	front := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if headerHasToken(r.Header, "Upgrade", "websocket") {
			http.Error(w, "upgrades are not supported", http.StatusForbidden)
			return
		}
		rp.ServeHTTP(w, r)
	}))
	front.EnableHTTP2 = true
	front.StartTLS()
	front.TLS.Certificates = []tls.Certificate{testTLSCert}
	t.Cleanup(front.Close)
	return front
}

// cappedPort marks a running exit as the capped-edge port, which is what the
// exit's local-address check reads (docs/d222).
func cappedPort(t *testing.T, s *server, backend *httptest.Server) {
	t.Helper()
	s.cloudflarePort = strconv.Itoa(int(portOf(t, backend.Listener.Addr().String())))
}

func TestH2WindowedWindowBound(t *testing.T) {
	tests := []struct {
		raw     string
		want    int64
		wantErr bool
	}{
		{strconv.FormatInt(h2WindowedBytes, 10), h2WindowedBytes, false},
		{strconv.FormatInt(maxWindowBytes, 10), maxWindowBytes, false},
		{"0", 0, true},
		{"-1", 0, true},
		{strconv.FormatInt(maxWindowBytes+1, 10), 0, true},
		{"not-a-number", 0, true},
	}
	for _, tc := range tests {
		got, err := parseWindowBound(tc.raw)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%q: accepted", tc.raw)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: %v", tc.raw, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%q: got %d, want %d", tc.raw, got, tc.want)
		}
	}
}

// TestH2WindowedEndToEnd drives one CONNECT whose uplink crosses several
// windows on a capped-edge port. The WebSocket rung is stripped by the edge,
// h2-post-unbounded is refused at initiation, so h2-post-windowed must carry.
func TestH2WindowedEndToEnd(t *testing.T) {
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("X-Upstream-Bytes", strconv.Itoa(len(body)))
		_, _ = io.WriteString(w, "windowed-ok")
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())

	s := newTunnelServer(t, true, egressConfig{
		AllowCidrs: []string{"127.0.0.0/8"},
		Ports:      []uint16{upPort},
	})
	backend := newHTTPServer(t, s)
	cappedPort(t, s, backend)
	front := newUpgradeStrippingH2Front(t, backend)
	logBuf := captureLog(t)
	httpAddr, stop := wireRelayNode(t, front.URL+tunnelPath)
	defer stop()

	conn := rawDial(t, httpAddr)
	defer conn.Close()
	mustWrite(t, conn, fmt.Sprintf("CONNECT %s:%d HTTP/1.1\r\nHost: %s\r\n\r\n", testTargetAlias, upPort, testTargetAlias))
	br := bufio.NewReader(conn)
	status, err := br.ReadString('\n')
	if err != nil || !strings.Contains(status, " 200 ") {
		t.Fatalf("CONNECT: %q err=%v", status, err)
	}

	// 17 MiB at an 8 MiB window: at least three windows on the wire.
	payload := bytes.Repeat([]byte("x"), 17<<20)
	mustWrite(t, conn, fmt.Sprintf("POST /upload HTTP/1.1\r\nHost: local.test\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", len(payload)))
	mustWrite(t, conn, string(payload))

	resp := readHTTPResponse(t, br)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "windowed-ok" {
		t.Fatalf("status=%d body=%q", resp.StatusCode, body)
	}
	if got := resp.Header.Get("X-Upstream-Bytes"); got != strconv.Itoa(len(payload)) {
		t.Fatalf("upstream saw %s bytes, want %d", got, len(payload))
	}

	waitForLog(t, logBuf, "refused h2-post-unbounded at request initiation")
	waitForLog(t, logBuf, "transport=h2-post-windowed")
	waitForLog(t, logBuf, "carriers=h2-post-unbounded")
	if n := strings.Count(logBuf.String(), "POST /vpn HTTP/1.1"); n < 3 {
		t.Fatalf("exit logged %d windows, want at least 3; log:\n%s", n, logBuf.String())
	}
}

// TestH2WindowedSlowTargetBackpressures holds the target's reads still while
// a window far larger than the h1.1 carrier's queue bound is in flight. The
// carrier must block (backpressure) and resume, never treat the queue as a
// protocol error.
func TestH2WindowedSlowTargetBackpressures(t *testing.T) {
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("X-Upstream-Bytes", strconv.Itoa(len(body)))
		_, _ = io.WriteString(w, "slow-ok")
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())

	s := newTunnelServer(t, true, egressConfig{
		AllowCidrs: []string{"127.0.0.0/8"},
		Ports:      []uint16{upPort},
	})
	backend := newHTTPServer(t, s)
	cappedPort(t, s, backend)
	front := newUpgradeStrippingH2Front(t, backend)
	httpAddr, stop := wireRelayNode(t, front.URL+tunnelPath)
	defer stop()

	conn := rawDial(t, httpAddr)
	defer conn.Close()
	mustWrite(t, conn, fmt.Sprintf("CONNECT %s:%d HTTP/1.1\r\nHost: %s\r\n\r\n", testTargetAlias, upPort, testTargetAlias))
	br := bufio.NewReader(conn)
	status, err := br.ReadString('\n')
	if err != nil || !strings.Contains(status, " 200 ") {
		t.Fatalf("CONNECT: %q err=%v", status, err)
	}

	// 9 MiB in an 8 MiB window: the target is asleep long enough for the
	// exit to hold far more than the h1.1 carrier's 128 KiB queue bound.
	payload := bytes.Repeat([]byte("y"), 9<<20)
	mustWrite(t, conn, fmt.Sprintf("POST /slow HTTP/1.1\r\nHost: local.test\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", len(payload)))
	mustWrite(t, conn, string(payload))
	resp := readHTTPResponse(t, br)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "slow-ok" {
		t.Fatalf("status=%d body=%q", resp.StatusCode, body)
	}
	if got := resp.Header.Get("X-Upstream-Bytes"); got != strconv.Itoa(len(payload)) {
		t.Fatalf("upstream saw %s bytes, want %d", got, len(payload))
	}
}

// TestH2UnboundedRefusedOnCappedPort is the port's half of the fact: on the
// capped-edge listener the exit refuses h2-post-unbounded before reading the
// body, and a declared window above the ceiling is the camouflage 404.
func TestH2UnboundedRefusedOnCappedPort(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{AllowCidrs: []string{"127.0.0.0/8"}})
	backend := newHTTPServer(t, s)
	cappedPort(t, s, backend)
	target := backend.URL + tunnelPath

	t.Run("h2-post-unbounded is a problem detail, not a session", func(t *testing.T) {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, target, strings.NewReader("HELLO? no"))
		if err != nil {
			t.Fatal(err)
		}
		applyTestV5Headers(t, req.Header)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s", resp.StatusCode, body)
		}
		if !strings.Contains(string(body), "h2-post-unbounded-refused") {
			t.Fatalf("body=%s", body)
		}
	})

	t.Run("a declared window above the ceiling is the camouflage 404", func(t *testing.T) {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, target, strings.NewReader("x"))
		if err != nil {
			t.Fatal(err)
		}
		applyTestV5Headers(t, req.Header)
		req.Header.Set("Traceparent", buildTraceparent(strings.Repeat("a", 32), firstWindowSpan))
		req.Header.Set(windowHeader, strconv.Itoa(maxWindowBytes+1))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("status=%d, want the camouflage 404", resp.StatusCode)
		}
	})
}

// Every window re-authenticates: a request whose certificate is well-formed
// but not the pinned relay dies at the camouflage 404 before any TLS flight.
func TestH2WindowedRefusesUntrustedCertificate(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{})
	backend := newHTTPServer(t, s)
	otherPriv := testHostKey(t)
	otherDER, err := mintPrincipalCertificate(otherPriv, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	hdr, _, err := channelRequestHeaders(otherPriv, testV5Principal, testV5Principal, otherDER)
	if err != nil {
		t.Fatal(err)
	}
	hello, err := encodeHello("untrusted-window")
	if err != nil {
		t.Fatal(err)
	}
	body, err := encodeFrame(frameHello, tunnelStreamV1, hello)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
		backend.URL+tunnelPath, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	maps.Copy(req.Header, hdr)
	req.Header.Set(windowHeader, strconv.FormatInt(h2WindowedBytes, 10))
	req.Header.Set("Traceparent", buildTraceparent("000000000000000000000000000000f1", 1))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("untrusted window answered %d, want camouflage 404", resp.StatusCode)
	}
}

// TestH2WindowedRotationDoesNotNeedABusyReader drives the carrier directly and
// keeps the reader IDLE while the writer crosses the window bound. A rotation
// used to clear the current window and park on a condition only the reader
// could signal, so with the reader between reads (not blocked, merely not
// reading yet) both goroutines slept: the writer never opened the next window
// and a live CONNECT died on its read bound. The rotation must end the current
// window and let the next reader pick the handoff up.
func TestH2WindowedRotationDoesNotNeedABusyReader(t *testing.T) {
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("X-Upstream-Bytes", strconv.Itoa(len(body)))
		_, _ = io.WriteString(w, "idle-reader-ok")
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())

	s := newTunnelServer(t, true, egressConfig{
		AllowCidrs: []string{"127.0.0.0/8"},
		Ports:      []uint16{upPort},
	})
	backend := newHTTPServer(t, s)
	cappedPort(t, s, backend)
	front := newUpgradeStrippingH2Front(t, backend)
	writeTestRelayJSON(t, front.URL+tunnelPath)
	cfg, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t), relaySelection{}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	// The constructor lives on the node (it owns the dial), so the fixture
	// builds the minimum node around the config exactly as runRelayNode does.
	node := &relayNode{cfg: cfg, live: newLiveRegistry()}
	stream, err := node.openH2Windowed(t.Context(), "000000000000000000000000000000d1", false)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	_ = stream.setReadDeadline(time.Now().Add(30 * time.Second))

	hello, err := encodeHello("idle-reader")
	if err != nil {
		t.Fatal(err)
	}
	if err := sendFrame(stream, frameHello, hello); err != nil {
		t.Fatal(err)
	}
	if typ := mustFrameType(t, stream); typ != frameHelloOK {
		t.Fatalf("HELLO_OK: typ=%d", typ)
	}
	if err := sendFrame(stream, frameConnect, []byte(fmt.Sprintf("%s:%d", testTargetAlias, upPort))); err != nil {
		t.Fatal(err)
	}
	if typ := mustFrameType(t, stream); typ != frameConnected {
		t.Fatalf("CONNECTED: typ=%d", typ)
	}
	if err := sendFrame(stream, frameData, []byte(fmt.Sprintf(
		"POST /turn HTTP/1.1\r\nHost: local.test\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", 12<<20))); err != nil {
		t.Fatal(err)
	}

	// More than one 8 MiB window, written from a goroutine while NO read is in
	// flight: the writer crosses the bound and blocks on the window handoff.
	// The reader then arrives — a reader that was between reads, not blocked —
	// and must be enough to complete the handoff.
	writeErr := make(chan error, 1)
	go func() {
		chunk := bytes.Repeat([]byte("z"), maxFramePayload)
		for range (12 << 20) / maxFramePayload {
			if err := sendFrame(stream, frameData, chunk); err != nil {
				writeErr <- err
				return
			}
		}
		writeErr <- nil
	}()
	// Give the writer time to rotate and park, so the reader below is the one
	// that unblocks it rather than racing it.
	time.Sleep(500 * time.Millisecond)

	// Now read: the session must still be alive and carry the upstream's
	// answer, which rides whatever window the handoff opened.
	_ = stream.setReadDeadline(time.Now().Add(10 * time.Second))
	var seen bytes.Buffer
	for {
		msg, err := readTunnelFrame(stream)
		if err != nil {
			t.Fatalf("reading the rotated session: %v", err)
		}
		typ, _, payload, err := decodeFrame(msg)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		if typ != frameData {
			continue
		}
		seen.Write(payload)
		if strings.Contains(seen.String(), "idle-reader-ok") {
			if err := <-writeErr; err != nil {
				t.Fatalf("uplink: %v", err)
			}
			return
		}
	}
}

// mustFrameType reads one frame and returns its type, failing on any error.
func mustFrameType(t *testing.T, s tunnelStream) byte {
	t.Helper()
	msg, err := readTunnelFrame(s)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	typ, _, _, err := decodeFrame(msg)
	if err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	return typ
}
