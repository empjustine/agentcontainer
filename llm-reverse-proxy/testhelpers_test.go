package main

// testhelpers_test.go — shared scaffolding for the tunnel suite (modes C–E). Helpers
// live in one file so no single test file grows a private dialect of
// "start a server, poke it, read the log" (d072's drift lesson, applied to
// tests).

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Suite TLS root — one trust anchor for every TLS fixture (docs/d090)
// ---------------------------------------------------------------------------
//
// The relay trusts system roots with no override knob (VPN-R28/R55), and
// x509 loads the system roots ONCE per process — so a per-test SSL_CERT_FILE
// write only reaches fixtures that run before the first handshake. With the
// generalized https:// tunnel URL (docs/d090) there is more than one TLS
// fixture, so the whole suite presents certs chaining to ONE self-signed
// root, installed by TestMain before any test can trigger a load.

var (
	testTLSOnce     sync.Once
	testTLSCert     tls.Certificate
	testTLSErr      error
	testRootPEMPath string
)

func initSuiteTLSRoot() error {
	testTLSOnce.Do(func() {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			testTLSErr = err
			return
		}
		tmpl := &x509.Certificate{
			SerialNumber:          big.NewInt(1),
			Subject:               pkix.Name{CommonName: "llm-reverse-proxy test root"},
			NotBefore:             time.Now().Add(-time.Hour),
			NotAfter:              time.Now().Add(24 * time.Hour),
			KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
			ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			BasicConstraintsValid: true,
			IsCA:                  true,
			DNSNames:              []string{"localhost"},
			IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		}
		der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
		if err != nil {
			testTLSErr = err
			return
		}
		testTLSCert = tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
		dir, err := os.MkdirTemp("", "llm-reverse-proxy-test-root")
		if err != nil {
			testTLSErr = err
			return
		}
		testRootPEMPath = filepath.Join(dir, "root.pem")
		pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
		testTLSErr = os.WriteFile(testRootPEMPath, pemBytes, 0o644)
	})
	return testTLSErr
}

// TestMain installs the suite TLS root before any test runs — SSL_CERT_FILE
// must be set before x509's first root load, which any test could trigger.
func TestMain(m *testing.M) {
	if err := initSuiteTLSRoot(); err != nil {
		fmt.Fprintf(os.Stderr, "suite TLS root: %v\n", err)
		os.Exit(1)
	}
	if err := os.Setenv("SSL_CERT_FILE", testRootPEMPath); err != nil {
		fmt.Fprintf(os.Stderr, "SSL_CERT_FILE: %v\n", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

// newTLSFront is a TLS reverse proxy to backend on the suite root: h2 at the
// edge when enableHTTP2 (mode C's E2 shape), h1-only otherwise (the
// upgrade-stripping hostile gateway the demotion ladder needs).
func newTLSFront(t *testing.T, backend *httptest.Server, enableHTTP2 bool) *httptest.Server {
	t.Helper()
	bu, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	rp := httputil.NewSingleHostReverseProxy(bu)
	rp.FlushInterval = time.Millisecond
	front := httptest.NewUnstartedServer(rp)
	front.EnableHTTP2 = enableHTTP2
	front.StartTLS()
	// httptest.StartTLS serves its own localhost cert; the suite root
	// replaces it in the same *tls.Config the live listener wraps, so the
	// next handshake picks it up (docs/d090).
	front.TLS.Certificates = []tls.Certificate{testTLSCert}
	t.Cleanup(front.Close)
	return front
}

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
// it. Test-only port pick for runRelayNode, which binds flag-supplied
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
