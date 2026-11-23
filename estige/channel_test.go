package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

func testChannelMaterial(t *testing.T, priv ed25519.PrivateKey) (tls.Certificate, *x509.Certificate) {
	t.Helper()
	der, err := mintPrincipalCertificate(priv, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	cert, err := parsePrincipalCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv}, cert
}

func channelHandshake(t *testing.T, clientCfg, serverCfg *tls.Config) error {
	t.Helper()
	clientSide, serverSide := net.Pipe()
	defer clientSide.Close()
	defer serverSide.Close()
	deadline := time.Now().Add(3 * time.Second)
	_ = clientSide.SetDeadline(deadline)
	_ = serverSide.SetDeadline(deadline)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client := tls.Client(clientSide, clientCfg)
	server := tls.Server(serverSide, serverCfg)
	errs := make(chan error, 2)
	go func() { errs <- client.HandshakeContext(ctx) }()
	go func() { errs <- server.HandshakeContext(ctx) }()
	for range 2 {
		select {
		case err := <-errs:
			if err != nil {
				return err
			}
		case <-time.After(5 * time.Second):
			return errors.New("handshake timed out")
		}
	}
	return nil
}

func TestChannelTLSConfigs(t *testing.T) {
	relayLocal, relayCert := testChannelMaterial(t, testHostKey(t))
	exitLocal, exitCert := testChannelMaterial(t, testHostKey(t))
	otherLocal, otherCert := testChannelMaterial(t, testHostKey(t))

	clientCfg, err := clientChannelTLSConfig(relayLocal, exitCert)
	if err != nil {
		t.Fatal(err)
	}
	serverCfg, err := serverChannelTLSConfig(exitLocal, []*x509.Certificate{otherCert, relayCert})
	if err != nil {
		t.Fatal(err)
	}
	for _, cfg := range []*tls.Config{clientCfg, serverCfg} {
		if cfg.MinVersion != tls.VersionTLS13 || !cfg.SessionTicketsDisabled {
			t.Fatal("TLS floor or ticket policy drifted")
		}
		if cfg.InsecureSkipVerify || cfg.VerifyPeerCertificate != nil || cfg.VerifyConnection != nil {
			t.Fatal("verification was handed to a callback or skipped")
		}
	}
	if clientCfg.ServerName != channelName || clientCfg.RootCAs == nil {
		t.Fatal("client did not pin a name and certificate pool")
	}
	if serverCfg.ClientAuth != tls.RequireAndVerifyClientCert || serverCfg.ClientCAs == nil {
		t.Fatal("server did not require and pin a certificate pool")
	}
	if err := channelHandshake(t, clientCfg, serverCfg); err != nil {
		t.Fatalf("pinned handshake: %v", err)
	}

	wrongCfg, err := clientChannelTLSConfig(relayLocal, otherCert)
	if err != nil {
		t.Fatal(err)
	}
	if err := channelHandshake(t, wrongCfg, serverCfg); err == nil {
		t.Fatal("unpinned client certificate was accepted")
	}
	if _, err := clientChannelTLSConfig(relayLocal, nil); err == nil {
		t.Fatal("missing peer certificate accepted")
	}
	if _, err := serverChannelTLSConfig(exitLocal, nil); err == nil {
		t.Fatal("empty admitted set accepted")
	}
	_ = otherLocal
}

type channelTestStream struct {
	mu         sync.Mutex
	in         chan []byte
	out        [][]byte
	closed     chan struct{}
	once       sync.Once
	violations int
	deadline   time.Time
}

func newChannelTestStream() *channelTestStream {
	return &channelTestStream{in: make(chan []byte, 4), closed: make(chan struct{})}
}

func (s *channelTestStream) readTunnelMsg() ([]byte, error) {
	select {
	case msg := <-s.in:
		return msg, nil
	case <-s.closed:
		return nil, os.ErrClosed
	}
}

func (s *channelTestStream) writeTunnelMsg(msg []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.out = append(s.out, bytes.Clone(msg))
	return nil
}

func (s *channelTestStream) setReadDeadline(t time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deadline = t
	return nil
}

func (s *channelTestStream) protocolViolation() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.violations++
}

func (s *channelTestStream) transport() string { return carrierH2Unbounded }
func (s *channelTestStream) sessionID() string { return "test-session" }

func (s *channelTestStream) Close() error {
	s.once.Do(func() { close(s.closed) })
	return nil
}

func TestChannelConnByteStream(t *testing.T) {
	stream := newChannelTestStream()
	stream.in <- []byte("hello")
	stream.in <- []byte("world")
	conn := newChannelConn(stream)
	buf := make([]byte, 3)
	if n, err := conn.Read(buf); err != nil || string(buf[:n]) != "hel" {
		t.Fatalf("first read = %q, %v", buf[:n], err)
	}
	buf = make([]byte, 5)
	if n, err := conn.Read(buf); err != nil || string(buf[:n]) != "lo" {
		t.Fatalf("second read = %q, %v", buf[:n], err)
	}
	buf = make([]byte, 8)
	if n, err := conn.Read(buf); err != nil || string(buf[:n]) != "world" {
		t.Fatalf("final read = %q, %v", buf[:n], err)
	}
	if n, err := conn.Write([]byte("ping")); err != nil || n != 4 {
		t.Fatalf("write = %d, %v", n, err)
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if len(stream.out) != 1 || string(stream.out[0]) != "ping" {
		t.Fatalf("stream writes = %q", stream.out)
	}
}

func TestChannelConnLifecycle(t *testing.T) {
	stream := newChannelTestStream()
	conn := newChannelConn(stream)
	if conn.LocalAddr().String() != "0.0.0.0:0" || conn.RemoteAddr().String() != "0.0.0.0:0" {
		t.Fatal("adapter exposed a non-placeholder address")
	}
	if err := conn.SetWriteDeadline(time.Now()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	if err := conn.SetReadDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	stream.mu.Lock()
	got := stream.deadline
	stream.mu.Unlock()
	if !got.Equal(deadline) {
		t.Fatal("read deadline did not reach the carrier")
	}
	_ = stream.Close()
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("read after close succeeded")
	}
	stream.mu.Lock()
	violations := stream.violations
	stream.mu.Unlock()
	if violations != 1 {
		t.Fatalf("protocol violations = %d", violations)
	}
}

type recordingConn struct {
	net.Conn
	buf bytes.Buffer
}

func (r *recordingConn) Write(p []byte) (int, error) { return r.buf.Write(p) }

type pairedStream struct {
	in     chan []byte
	other  *pairedStream
	closed chan struct{}
	once   sync.Once
}

func newPairedStreams(buffer int) (*pairedStream, *pairedStream) {
	a := &pairedStream{in: make(chan []byte, buffer), closed: make(chan struct{})}
	b := &pairedStream{in: make(chan []byte, buffer), closed: make(chan struct{})}
	a.other, b.other = b, a
	return a, b
}

func (s *pairedStream) readTunnelMsg() ([]byte, error) {
	select {
	case msg := <-s.in:
		return msg, nil
	case <-s.closed:
		return nil, os.ErrClosed
	}
}

func (s *pairedStream) writeTunnelMsg(msg []byte) error {
	select {
	case s.other.in <- bytes.Clone(msg):
		return nil
	case <-s.closed:
		return os.ErrClosed
	}
}

func (s *pairedStream) setReadDeadline(time.Time) error { return nil }
func (s *pairedStream) protocolViolation()              {}
func (s *pairedStream) transport() string               { return carrierH2Unbounded }
func (s *pairedStream) sessionID() string               { return "paired" }
func (s *pairedStream) Close() error {
	s.once.Do(func() { close(s.closed) })
	return nil
}

func TestInnerHandshakeOverCarrier(t *testing.T) {
	relayLocal, relayCert := testChannelMaterial(t, testHostKey(t))
	exitLocal, exitCert := testChannelMaterial(t, testHostKey(t))
	clientStream, serverStream := newPairedStreams(64)
	defer clientStream.Close()
	defer serverStream.Close()

	type outcome struct {
		conn *tls.Conn
		err  error
	}
	results := make(chan outcome, 2)
	go func() {
		conn, err := clientChannelHandshake(clientStream, relayLocal, exitCert)
		results <- outcome{conn, err}
	}()
	go func() {
		conn, err := serverChannelHandshake(serverStream, exitLocal, []*x509.Certificate{relayCert})
		results <- outcome{conn, err}
	}()
	connected := make([]*tls.Conn, 0, 2)
	for range 2 {
		select {
		case got := <-results:
			if got.err != nil {
				t.Fatalf("handshake: %v", got.err)
			}
			connected = append(connected, got.conn)
		case <-time.After(5 * time.Second):
			t.Fatal("handshake timed out")
		}
	}
	clientConn, serverConn := connected[0], connected[1]
	defer clientConn.Close()
	defer serverConn.Close()
	if _, err := clientConn.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := serverConn.Read(buf); err != nil || string(buf) != "hello" {
		t.Fatalf("application data = %q, %v", buf, err)
	}
}

func TestWriteChannelPing(t *testing.T) {
	conn := &recordingConn{}
	if err := writeChannelPing(conn); err != nil {
		t.Fatal(err)
	}
	typ, version, payload, err := decodeFrame(conn.buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if typ != framePing || version != tunnelStreamV1 || len(payload) != 0 {
		t.Fatalf("ping frame = %d/%d/%q", typ, version, payload)
	}
}
