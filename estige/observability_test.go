package main

// observability_test.go — docs/d106's record shape, docs/d155's journal
// transport, and the status surface that reads the same state.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// stubStream is the minimum tunnelStream the registry tests need: a closed
// channel is the whole behaviour (Close is the drain's only verb).
type stubStream struct {
	id     string
	closed chan struct{}
	once   sync.Once
}

func newStubStream(id string) *stubStream {
	return &stubStream{id: id, closed: make(chan struct{})}
}

func (s *stubStream) readTunnelMsg() ([]byte, error)  { return nil, os.ErrClosed }
func (s *stubStream) writeTunnelMsg([]byte) error     { return os.ErrClosed }
func (s *stubStream) setReadDeadline(time.Time) error { return nil }
func (s *stubStream) protocolViolation()              {}
func (s *stubStream) transport() string               { return carrierH2Unbounded }
func (s *stubStream) sessionID() string               { return s.id }
func (s *stubStream) Close() error {
	s.once.Do(func() { close(s.closed) })
	return nil
}

func TestSessionIDGrammar(t *testing.T) {
	good, err := newSessionID()
	if err != nil {
		t.Fatal(err)
	}
	if !validSessionID(good) {
		t.Fatalf("minted id %q does not satisfy its own grammar", good)
	}
	for _, bad := range []string{"", "abc", strings.Repeat("A", 32), strings.Repeat("g", 32), good + "0"} {
		if validSessionID(bad) {
			t.Errorf("validSessionID(%q) = true, want false", bad)
		}
	}
}

func TestSessionRecordPairsIDAndOmitsSecrets(t *testing.T) {
	var buf strings.Builder
	restore := captureTo(&buf)
	defer restore()

	id := strings.Repeat("ab", 16)
	sessionRecord{
		Role: roleExit, Event: eventOpen, ID: id, Key: "default",
		Label: "deck", Via: viaConnect, Transport: carrierH2Unbounded, Target: "api.example:443",
	}.emit()
	sessionRecord{
		Role: roleExit, Event: eventClose, ID: id, Key: "default",
		Label: "deck", Via: viaConnect, Transport: carrierH2Unbounded, Target: "api.example:443",
		Up: 10, Down: 20, Duration: 5, Outcome: outcomeClosed,
	}.emit()

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("want open+close, got %d lines:\n%s", len(lines), buf.String())
	}
	for _, want := range []string{"role=exit", "id=" + id, "key=default"} {
		for _, line := range lines {
			if !strings.Contains(line, want) {
				t.Errorf("record missing %q: %s", want, line)
			}
		}
	}
	if !strings.Contains(lines[1], "bytes_up=10") || !strings.Contains(lines[1], "bytes_down=20") ||
		!strings.Contains(lines[1], "outcome=closed") {
		t.Errorf("close record lacks its totals: %s", lines[1])
	}
	if strings.Contains(buf.String(), "Bearer") || strings.Contains(buf.String(), "token") {
		t.Fatalf("credential-shaped text reached a record:\n%s", buf.String())
	}
}

// captureTo installs a sink that appends to buf. The stream sink would need
// log.SetOutput, but this is also the hook the journal tests use.
func captureTo(buf *strings.Builder) func() {
	prev := activeSink
	activeSink = sinkFunc(func(_ severity, text string, _ []journalField) {
		buf.WriteString(text)
		buf.WriteString("\n")
	})
	return func() { activeSink = prev }
}

type sinkFunc func(severity, string, []journalField)

func (f sinkFunc) emit(s severity, text string, fields []journalField) { f(s, text, fields) }

func TestJournalDatagramCarriesBothSeverities(t *testing.T) {
	dgram := journalDatagram(sevWarn, "hello", []journalField{{"EVENT", eventRefused}})
	for _, want := range []string{"PRIORITY=4\n", "SEVERITY_NUMBER=13\n", "MESSAGE=hello\n", "EVENT=refused\n"} {
		if !strings.Contains(string(dgram), want) {
			t.Errorf("datagram missing %q:\n%q", want, dgram)
		}
	}
	if !strings.HasPrefix(string(dgram), "PRIORITY=") {
		t.Errorf("PRIORITY must lead the entry, got %q", dgram)
	}
}

func TestJournalValueWithNewlineUsesBinaryForm(t *testing.T) {
	dgram := journalDatagram(sevInfo, "x", []journalField{{"TARGET", "a\nb"}})
	if strings.Contains(string(dgram), "TARGET=a\nb") {
		t.Fatalf("a newline value must not ride the text form:\n%q", dgram)
	}
	idx := strings.Index(string(dgram), "TARGET\n")
	if idx < 0 {
		t.Fatalf("binary field header missing:\n%q", dgram)
	}
	sizeOff := idx + len("TARGET\n")
	size := binary.LittleEndian.Uint64(dgram[sizeOff : sizeOff+8])
	if int(size) != len("a\nb") {
		t.Fatalf("declared size %d, want %d", size, len("a\nb"))
	}
}

func TestJournalSinkSendsToSocket(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "socket")
	addr, err := net.ResolveUnixAddr("unixgram", sock)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.ListenUnixgram("unixgram", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	j := &journalSink{conn: dialUnixgram(t, sock)}
	prev := activeSink
	activeSink = j
	defer func() { activeSink = prev }()
	sessionRecord{Role: roleExit, Event: eventRefused, Key: "default", Reason: "port-denied"}.emit()

	buf := make([]byte, 4096)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _, err := conn.ReadFromUnix(buf)
	if err != nil {
		t.Fatalf("no journal entry arrived: %v", err)
	}
	entry := string(buf[:n])
	for _, want := range []string{"PRIORITY=4", "SEVERITY_NUMBER=13", "EVENT=refused", "REASON=port-denied", "KEY=default"} {
		if !strings.Contains(entry, want) {
			t.Errorf("entry missing %q:\n%s", want, entry)
		}
	}
	// ts belongs to MESSAGE (the stream text is byte-identical) but never to
	// the fields: journald stamps __REALTIME_TIMESTAMP itself (d155).
	if strings.Contains(entry, "\nTS=") {
		t.Errorf("journald stamps its own clock; TS must not be a field:\n%s", entry)
	}
}

func dialUnixgram(t *testing.T, path string) net.Conn {
	t.Helper()
	conn, err := new(net.Dialer).DialContext(context.Background(), "unixgram", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func TestStatusSurfaceReportsInFlightAndDropsOnClose(t *testing.T) {
	s := &server{vpn: &tunnelServer{live: newLiveRegistry()}}
	stream := newStubStream(strings.Repeat("cd", 16))
	live := &liveSession{id: stream.id, keyID: "default", label: "deck", via: viaConnect, target: "example:443", transport: carrierH2Unbounded, start: time.Now(), stream: stream}
	s.vpn.live.register(live)

	req := httptest.NewRequestWithContext(context.Background(), "GET", "/status", nil)
	w := httptest.NewRecorder()
	s.handleStatus(w, req)
	var body struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("status body: %v", err)
	}
	if len(body.Sessions) != 1 || body.Sessions[0]["id"] != stream.id || body.Sessions[0]["target"] != "example:443" {
		t.Fatalf("status snapshot = %+v", body.Sessions)
	}

	s.closeAllTunnelSessions()
	select {
	case <-stream.closed:
	case <-time.After(time.Second):
		t.Fatal("closeAllTunnelSessions did not close the live stream")
	}
	s.vpn.live.unregister(live)
	if got := s.tunnelLiveCount(); got != 0 {
		t.Fatalf("live count after removal = %d", got)
	}
}

func TestAccessURIStripsAForwardQuery(t *testing.T) {
	r := httptest.NewRequestWithContext(context.Background(), "GET", "http://origin.test/path?X-Amz-Signature=secret&a=b", nil)
	if got := accessURI(r); strings.Contains(got, "secret") || strings.Contains(got, "?") {
		t.Fatalf("forward query survived: %q", got)
	}
	rel := httptest.NewRequestWithContext(context.Background(), "GET", "/vpn?x=1", nil)
	if got := accessURI(rel); !strings.Contains(got, "x=1") {
		t.Fatalf("non-forward origin-form URI must be logged as asked: %q", got)
	}
}

// TestAdmissionLeakGuardCatchesEachNeedle: the guard itself must fail on a
// leak, so every spelling an admitted exchange uses is exercised against it.
// The earlier guard grepped "e-auth", which the shipped headers
// (`E-Relay-Auth`/`E-Exit-Auth`) do not contain, and passed vacuously.
func TestAdmissionLeakGuardCatchesEachNeedle(t *testing.T) {
	proof := authToken + "." + testV5Principal + ".AAAA.BBBB"
	for _, leaked := range []string{
		"calling with " + eRelayAuthHeader + ": " + proof,
		"response " + strings.ToLower(eExitAuthHeader) + ": " + proof,
		"certificate " + strings.ToLower(ePubHeader) + ": " + encodeEPub(testV5CertDER),
		"envelope " + proof,
		"store row public=" + encodeEPub(testV5CertDER),
	} {
		if admissionMaterialIn(leaked) == "" {
			t.Fatalf("the leak guard did not recognise %q", leaked)
		}
	}
	clean := `ts=1 role=exit event=close id=00 key=default outcome=closed`
	if found := admissionMaterialIn(clean); found != "" {
		t.Fatalf("the leak guard flagged a clean record with %q", found)
	}
}
