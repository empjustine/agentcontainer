package main

// testhelpers_test.go — shared scaffolding for the tunnel suite (carriers). Helpers
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
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"maps"
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
	errTestTLS      error
	testRootPEMPath string
)

func initSuiteTLSRoot() error {
	testTLSOnce.Do(func() {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			errTestTLS = err
			return
		}
		tmpl := &x509.Certificate{
			SerialNumber:          big.NewInt(1),
			Subject:               pkix.Name{CommonName: "estige test root"},
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
			errTestTLS = err
			return
		}
		testTLSCert = tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
		dir, err := os.MkdirTemp("", "estige-test-root")
		if err != nil {
			errTestTLS = err
			return
		}
		testRootPEMPath = filepath.Join(dir, "root.pem")
		pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
		errTestTLS = os.WriteFile(testRootPEMPath, pemBytes, 0o644)
	})
	return errTestTLS
}

// ---------------------------------------------------------------------------
// Hermetic DNS — the suite owns every name it resolves (d163)
// ---------------------------------------------------------------------------

// testTargetAlias is what positive-path tests dial instead of the upstream's
// numeric address: the relay answers at the door for `localhost`/`.localhost`
// (d163) and the default egress table denies loopback-resolving names
// (VPN-R35), so a loopback upstream is reached by an alias the suite's
// resolver maps to 127.0.0.1.
const testTargetAlias = "upstream.test"

// staticHostLookup is the suite's resolver: the alias table TestMain
// installs, plus the literal parsing net.Resolver does — a test that dials
// an address must exercise the same post-resolve table path production
// takes, not a shortcut. Unknown names fail as NXDOMAIN: no test outcome
// may depend on the host's resolver, and no lookup may leave the machine.
type staticHostLookup map[string]string

func (r staticHostLookup) LookupIPAddr(_ context.Context, host string) ([]net.IPAddr, error) {
	if addr, ok := parseIPLiteral(host); ok {
		return []net.IPAddr{{IP: net.IP(addr.Unmap().AsSlice())}}, nil
	}
	ip, ok := r[host]
	if !ok {
		return nil, &net.DNSError{Err: "no test record", Name: host, IsNotFound: true}
	}
	return []net.IPAddr{{IP: net.ParseIP(ip)}}, nil
}

const testV5Principal = "default"

var (
	testV5CertDER   []byte
	testV5StoreRoot string
)

// installTestV5Store gives both roles one pinned identity. The relay and exit
// share it in-process; production runs each role in its own home.
func installTestV5Store() error {
	base, err := os.MkdirTemp("", "estige-v5-store")
	if err != nil {
		return err
	}
	root := filepath.Join(base, "estige")
	testV5StoreRoot = root
	if _, _, _, err := keygen(root, testV5Principal, false); err != nil {
		return err
	}
	testV5CertDER, err = os.ReadFile(filepath.Join(root, "prv", testV5Principal+keygenCertSuffix))
	if err != nil {
		return err
	}
	if err := writeTestRoleFiles("wss://example.invalid/vpn", nil); err != nil {
		return err
	}
	return os.Setenv("XDG_DATA_HOME", base)
}

// writeTestRoleFiles rewrites the two role files for the suite identity: the
// endpoint a relay dials and the egress an exit enforces. Every construction
// path reads exactly what production reads (d236) — no test shortcut config.
func writeTestRoleFiles(endpoint string, egress *egressConfig) error {
	entry := fmt.Sprintf(`"name":%q,"public":%q`, testV5Principal, encodeEPub(testV5CertDER))
	relayFile := fmt.Sprintf(`{"endpoint":%q,"exit":[{%s}]}`, endpoint, entry)
	exitFile := fmt.Sprintf(`{"relays":[{%s}]%s}`, entry, egressBlock(egress))
	if err := os.WriteFile(filepath.Join(testV5StoreRoot, "relay.json"), []byte(relayFile), 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(testV5StoreRoot, "exit.json"), []byte(exitFile), 0o600)
}

// egressBlock renders the store's egress member, omitting it for a zero
// config — absent is what "no opt-ins, use the defaults" means in the grammar.
func egressBlock(egress *egressConfig) string {
	if egress == nil || (len(egress.AllowCidrs) == 0 && len(egress.Ports) == 0 && !egress.AllowIPLiterals) {
		return ""
	}
	raw, err := json.Marshal(egress)
	if err != nil {
		return ""
	}
	return fmt.Sprintf(`,"egress":%s`, raw)
}

// writeTestRoleFile writes one role file for one test and restores what the
// suite store held when that test first touched it. Without the restore the
// store is process-global state that outlives a test — unlike the t.Setenv
// this replaced — and `go test -shuffle=on` fails on whatever a previous test
// left behind.
func writeTestRoleFile(t *testing.T, name, body string) {
	t.Helper()
	path := filepath.Join(testV5StoreRoot, name)
	if previous, err := os.ReadFile(path); err == nil {
		t.Cleanup(func() { _ = os.WriteFile(path, previous, 0o600) })
	} else {
		t.Cleanup(func() { _ = os.Remove(path) })
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// writeTestRelayJSON sets the endpoint a relay dials for one test.
func writeTestRelayJSON(t *testing.T, endpoint string) {
	t.Helper()
	entry := fmt.Sprintf(`"name":%q,"public":%q`, testV5Principal, encodeEPub(testV5CertDER))
	writeTestRoleFile(t, "relay.json", fmt.Sprintf(`{"endpoint":%q,"exit":[{%s}]}`, endpoint, entry))
}

// writeTestExitJSON sets the exit's admitted relay row(s) and its egress for
// one test. A nil egress leaves exit.json without a policy, which means the
// requirement's defaults (VPN-R35..R38).
func writeTestExitJSON(t *testing.T, egress *egressConfig) {
	t.Helper()
	entry := fmt.Sprintf(`"name":%q,"public":%q`, testV5Principal, encodeEPub(testV5CertDER))
	writeTestRoleFile(t, "exit.json", fmt.Sprintf(`{"relays":[{%s}]%s}`, entry, egressBlock(egress)))
}

// TestMain installs the suite TLS root before any test runs — SSL_CERT_FILE
// must be set before x509's first root load, which any test could trigger.
func TestMain(m *testing.M) {
	if err := initSuiteTLSRoot(); err != nil {
		fmt.Fprintf(os.Stderr, "suite TLS root: %v\n", err)
		os.Exit(1)
	}
	if err := installTestV5Store(); err != nil {
		fmt.Fprintf(os.Stderr, "v5 test store: %v\n", err)
		os.Exit(1)
	}
	if err := os.Setenv("SSL_CERT_FILE", testRootPEMPath); err != nil {
		fmt.Fprintf(os.Stderr, "SSL_CERT_FILE: %v\n", err)
		os.Exit(1)
	}
	// The chain env (docs/d094) is read by relayConfigFromEnv: an ambient
	// proxy variable on the dev host would silently re-route every e2e
	// dial through a proxy no fixture owns. The suite owns its routing.
	for _, v := range chainEnvVars {
		_ = os.Unsetenv(v)
	}
	// Every policy built in this suite resolves through the alias table —
	// including `localhost`, which engine-level tests dial past the door —
	// so DNS never decides a test's outcome (d163).
	defaultHostLookup = staticHostLookup{
		"localhost":     "127.0.0.1",
		testTargetAlias: "127.0.0.1",
		"loopback.test": "127.0.0.1",
	}
	os.Exit(m.Run())
}

// newTLSFront is a TLS reverse proxy to backend on the suite root: h2 at the
// edge when enableHTTP2 (h2-post-unbounded's E2 shape), h1-only otherwise (the
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

// newHTTPSServer is the same fixture on the suite's one trust anchor
// (docs/d090): the relay verifies the exit's certificate with system roots,
// so a wss:// harness must chain to testTLSCert, not httptest's throwaway.
func newHTTPSServer(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(h)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{testTLSCert}, MinVersion: tls.VersionTLS12}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

// upgradeEchoHandler is the tunnel's cleartext-ws fixture (d103): a backend
// that accepts an upgrade and echoes raw bytes until EOF — everything the
// tunnel transport needs from a WebSocket-capable upstream, without a
// library.
func upgradeEchoHandler(w http.ResponseWriter, r *http.Request) {
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
	n, err := brw.Read(buf)
	if err == nil && n > 0 {
		_, _ = conn.Write(buf[:n])
	}
	conn.Close()
}

func mustTunnelURL(t *testing.T, proxy *httptest.Server) *url.URL {
	t.Helper()
	u, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	// The URL's honest wire form (docs/d090): a TLS fixture is wss.
	u.Scheme = schemeWS
	if strings.HasPrefix(proxy.URL, "https://") {
		u.Scheme = schemeWSS
	}
	u.Path = tunnelPath
	return u
}

func testV5Headers(t *testing.T) http.Header {
	t.Helper()
	store, err := loadRelayStore(mustStoreRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	hdr, _, err := channelRequestHeaders(store.Private, store.Principal, store.Exits[0].Name, store.SelfDER)
	if err != nil {
		t.Fatal(err)
	}
	return hdr
}

func applyTestV5Headers(t *testing.T, hdr http.Header) {
	t.Helper()
	maps.Copy(hdr, testV5Headers(t))
}

// mustStoreRoot is storeRoot for fixtures: a test that cannot resolve the
// suite store has no business continuing.
func mustStoreRoot(t *testing.T) string {
	t.Helper()
	root, err := storeRoot()
	if err != nil {
		t.Fatalf("store root: %v", err)
	}
	return root
}

// assertNoAdmissionMaterial fails when a log dump carries anything an
// admitted exchange proves with: a proof header name, the pinned certificate
// in its wire spelling, or a proof envelope. Assertions grep the SHIPPED
// names — an earlier guard matched "e-auth", which neither header contains,
// so it passed vacuously (d131/d236).
func assertNoAdmissionMaterial(t *testing.T, dumped string) {
	t.Helper()
	if found := admissionMaterialIn(dumped); found != "" {
		t.Fatalf("admission material %q leaked into the log:\n%s", found, dumped)
	}
}

// admissionMaterialIn returns the first admission spelling a log dump carries,
// or "" — a finder rather than an assertion so its own test can prove each
// needle is really searched for.
func admissionMaterialIn(dumped string) string {
	// Header names are case-insensitive; base64url is not, so the proof and
	// certificate needles are matched against the dump as it stands.
	lower := strings.ToLower(dumped)
	for _, needle := range []string{
		strings.ToLower(eRelayAuthHeader),
		strings.ToLower(eExitAuthHeader),
		strings.ToLower(ePubHeader),
	} {
		if strings.Contains(lower, needle) {
			return needle
		}
	}
	for _, needle := range []string{
		// A logged envelope would carry the token and minter name.
		authToken + "." + testV5Principal,
		// The certificate material itself, as the store spells it.
		encodeEPub(testV5CertDER),
	} {
		if strings.Contains(dumped, needle) {
			return needle
		}
	}
	return ""
}

func dialTunnelForTest(t *testing.T, u *url.URL) (tunnelStream, error) {
	t.Helper()
	hdr := make(http.Header)
	applyTestV5Headers(t, hdr)
	return dialTunnelWithHeaders(t, u, hdr)
}

// dialTunnelWithHeaders is the low-level driver: it dials the 101 with the
// caller's exact admission headers and completes the inner session, so a test
// can replay one proof or present a foreign certificate.
func dialTunnelWithHeaders(t *testing.T, u *url.URL, hdr http.Header) (tunnelStream, error) {
	t.Helper()
	dialCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, err := wsDial(dialCtx, u, hdr, nil, false)
	if err != nil {
		return nil, err
	}
	store, err := loadRelayStore(mustStoreRoot(t))
	if err != nil {
		_ = ws.Close()
		return nil, err
	}
	local := tls.Certificate{Certificate: [][]byte{store.SelfDER}, PrivateKey: store.Private}
	conn, err := clientChannelHandshake(dialCtx, ws, local, []*x509.Certificate{store.Exits[0].Cert})
	if err != nil {
		_ = ws.Close()
		return nil, err
	}
	return newTLSTunnelStream(conn, ws), nil
}

// tunnelTestBackend wires the exit node through enableTunnel with an egress
// rule that reaches the loopback upstream, and returns the handler itself for
// fixtures that need to be the only edge.
func tunnelTestBackend(t *testing.T, upstream *httptest.Server) *server {
	t.Helper()
	upPort := portOf(t, upstream.Listener.Addr().String())
	return newTunnelServer(t, true, egressConfig{
		AllowCidrs: []string{"127.0.0.0/8"},
		Ports:      []uint16{upPort},
	})
}

// tunnelTestServer is the same handler behind a plain h1.1 server: the shape
// a gateway in front of the exit delivers.
func tunnelTestServer(t *testing.T, upstream *httptest.Server) *httptest.Server {
	t.Helper()
	return newHTTPServer(t, tunnelTestBackend(t, upstream))
}

// wireRelayNode starts the relay role exactly as -mode relay wires it
// (production construction path — d072's drift lesson) and returns the
// loopback http address plus a shutdown func.
func wireRelayNode(t *testing.T, tunnelURL string) (string, func()) {
	t.Helper()
	writeTestRelayJSON(t, tunnelURL)
	t.Setenv(envClientLabel, "e2e")
	httpAddr := freeLoopbackAddr(t)
	socksAddr := freeLoopbackAddr(t)
	cfg, err := relayConfigFromEnv(httpAddr, socksAddr, relaySelection{}, false, false)
	if err != nil {
		t.Fatalf("relayConfigFromEnv: %v", err)
	}
	dialCtx, cancel := context.WithCancel(context.Background())
	relayDone := make(chan error, 1)
	go func() { relayDone <- runRelayNode(dialCtx, cfg) }()
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

// reserveLoopbackAddr picks a concrete port by binding :0 and releasing
// it. Test-only port pick for runRelayNode, which binds flag-supplied
// addresses directly; the release-then-bind window is a known test race,
// kept because production ports are fixed and collision-free.
func reserveLoopbackAddr() string {
	ln, err := new(net.ListenConfig).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		return ""
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

func rawDial(t *testing.T, addr string) net.Conn {
	t.Helper()
	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(context.Background(), "tcp", addr)
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
