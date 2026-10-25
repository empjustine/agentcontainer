package main

// testhelpers_test.go — shared scaffolding for the tunnel suite (modes C–E). Helpers
// live in one file so no single test file grows a private dialect of
// "start a server, poke it, read the log" (d072's drift lesson, applied to
// tests).

import (
	"bufio"
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBuffer is a log sink tests can read while the server writes: a plain
// strings.Builder would be a data race the moment log.Printf runs on the
// server's goroutine.
type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// captureLog redirects the standard logger for one test and restores the
// default on cleanup. Tests using it must NOT run in parallel.
func captureLog(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	log.SetOutput(buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return buf
}

func waitForLog(t *testing.T, buf *syncBuffer, substr string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(buf.String(), substr) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("log never contained %q; saw:\n%s", substr, buf.String())
}

func newHTTPServer(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

// newUpgradeEchoUpstream is the mode A-side S3 fixture: a backend that
// accepts an upgrade and echoes raw bytes until EOF — everything the tunnel
// transport needs from a WebSocket-capable upstream, without a library.
func newUpgradeEchoUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !headerHasToken(r.Header, "Upgrade", "websocket") {
			http.Error(w, "expected upgrade", http.StatusBadRequest)
			return
		}
		conn, brw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		if _, err := brw.WriteString("HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + wsAcceptKey(r.Header.Get("Sec-WebSocket-Key")) + "\r\n\r\n"); err != nil {
			conn.Close()
			return
		}
		if err := brw.Flush(); err != nil {
			conn.Close()
			return
		}
		// One-shot echo, then return: net/http closes the conn, the
		// requesting relay observes a clean upstream EOF, and its handler
		// (with the VPN-R13 CLF line) can complete. A fixture that kept
		// echoing would hold that relay open forever.
		buf := make([]byte, 4096)
		n, err := brw.Reader.Read(buf)
		if err == nil && n > 0 {
			_, _ = conn.Write(buf[:n])
		}
		conn.Close()
	}))
}

func mustTunnelURL(t *testing.T, proxy *httptest.Server) *url.URL {
	t.Helper()
	u, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	u.Scheme = "ws"
	u.Path = tunnelPath
	return u
}

func dialTunnelForTest(t *testing.T, u *url.URL, token string) (*wsConn, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	hdr := make(http.Header)
	if token != "" {
		hdr.Set("Authorization", "Bearer "+token)
	}
	return wsDial(ctx, u, hdr)
}

// reserveLoopbackAddr picks a concrete port by binding :0 and releasing
// it. Test-only port pick for runClient, which binds flag-supplied
// addresses directly; the release-then-bind window is a known test race,
// kept because production ports are fixed and collision-free.
func reserveLoopbackAddr() string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return ""
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

func rawDial(t *testing.T, addr string) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	return conn
}

func mustWrite(t *testing.T, w io.Writer, s string) {
	t.Helper()
	if _, err := io.WriteString(w, s); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func readHeaders(br *bufio.Reader) (http.Header, error) {
	h, err := textproto.NewReader(br).ReadMIMEHeader()
	return http.Header(h), err
}

// portOf extracts the port from a "host:port" address string.
func portOf(t *testing.T, addr string) uint16 {
	t.Helper()
	_, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("split %q: %v", addr, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		t.Fatalf("bad port in %q: %v", addr, err)
	}
	return uint16(port)
}
