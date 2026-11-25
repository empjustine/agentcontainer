// channel.go — the v5 inner TLS session and its stream adapter (d236).
//
// WHY verification stays in the library: d236 keeps the certificate window,
// usage and name checks standard, so no callback can be dropped and fail open.
// WHY the adapter owns write deadlines: every carrier already bounds its own
// writes, and a second timer would only give one write two clocks.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

// clientChannelTLSConfig pins one peer certificate for the relay side.
func clientChannelTLSConfig(local tls.Certificate, peer *x509.Certificate) (*tls.Config, error) {
	if err := validateLocalChannelCert(local); err != nil {
		return nil, err
	}
	pool, err := channelPool([]*x509.Certificate{peer})
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion:             tls.VersionTLS13,
		SessionTicketsDisabled: true,
		Certificates:           []tls.Certificate{local},
		RootCAs:                pool,
		ServerName:             channelName,
	}, nil
}

// serverChannelTLSConfig pins every admitted relay certificate for the exit.
func serverChannelTLSConfig(local tls.Certificate, peers []*x509.Certificate) (*tls.Config, error) {
	if err := validateLocalChannelCert(local); err != nil {
		return nil, err
	}
	pool, err := channelPool(peers)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion:             tls.VersionTLS13,
		SessionTicketsDisabled: true,
		Certificates:           []tls.Certificate{local},
		ClientCAs:              pool,
		ClientAuth:             tls.RequireAndVerifyClientCert,
	}, nil
}

func validateLocalChannelCert(local tls.Certificate) error {
	if len(local.Certificate) == 0 {
		return errors.New("local channel certificate is missing")
	}
	if _, err := parsePrincipalCertificate(local.Certificate[0]); err != nil {
		return fmt.Errorf("local channel certificate: %w", err)
	}
	return nil
}

func channelPool(certs []*x509.Certificate) (*x509.CertPool, error) {
	if len(certs) == 0 {
		return nil, errors.New("peer channel certificate is missing")
	}
	pool := x509.NewCertPool()
	for _, cert := range certs {
		if cert == nil {
			return nil, errors.New("peer channel certificate is nil")
		}
		if _, err := parsePrincipalCertificate(cert.Raw); err != nil {
			return nil, fmt.Errorf("peer channel certificate: %w", err)
		}
		pool.AddCert(cert)
	}
	return pool, nil
}

// channelAddr keeps the tunnel's address out of every outside reader's log.
type channelAddr struct{}

func (channelAddr) Network() string { return "tcp" }
func (channelAddr) String() string  { return "0.0.0.0:0" }

var channelPeerAddr = channelAddr{}

// channelConn adapts one message-oriented tunnelStream to the byte stream TLS
// needs. Message boundaries carry no meaning beyond byte order.
type channelConn struct {
	stream   tunnelStream
	framed   bool
	mu       sync.Mutex
	buf      []byte
	off      int
	deadline time.Time
}

func newChannelConn(s tunnelStream) *channelConn {
	return &channelConn{stream: s, framed: bodyCarrier(s.transport())}
}

func bodyCarrier(transport string) bool {
	return transport == carrierH2Unbounded || transport == carrierH2Windowed
}

func (c *channelConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	c.mu.Lock()
	deadline := c.deadline
	c.mu.Unlock()
	if err := c.stream.setReadDeadline(deadline); err != nil {
		return 0, c.fail(err)
	}
	for c.off >= len(c.buf) {
		msg, err := c.stream.readTunnelMsg()
		if err != nil {
			return 0, c.fail(err)
		}
		if c.framed {
			msg = msg[frameHeaderLen:]
		}
		c.buf, c.off = msg, 0
	}
	n := copy(p, c.buf[c.off:])
	c.off += n
	return n, nil
}

func (c *channelConn) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	written := len(p)
	if c.framed {
		frame, err := encodeFrame(frameData, tunnelStreamV1, p)
		if err != nil {
			return 0, c.fail(err)
		}
		p = frame
	}
	if err := c.stream.writeTunnelMsg(p); err != nil {
		return 0, c.fail(err)
	}
	return written, nil
}

func (c *channelConn) Close() error { return c.stream.Close() }

func (c *channelConn) LocalAddr() net.Addr  { return channelPeerAddr }
func (c *channelConn) RemoteAddr() net.Addr { return channelPeerAddr }

func (c *channelConn) SetDeadline(t time.Time) error {
	return c.SetReadDeadline(t)
}

func (c *channelConn) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	c.deadline = t
	c.mu.Unlock()
	return c.stream.setReadDeadline(t)
}

func (c *channelConn) SetWriteDeadline(time.Time) error { return nil }

func (c *channelConn) fail(err error) error {
	c.stream.protocolViolation()
	_ = c.stream.Close()
	return err
}

// clientChannelHandshake wraps an admitted carrier and completes the inner
// session. A failed handshake is a protocol violation, never a downgrade.
func clientChannelHandshake(ctx context.Context, s tunnelStream, local tls.Certificate, peer *x509.Certificate) (*tls.Conn, error) {
	cfg, err := clientChannelTLSConfig(local, peer)
	if err != nil {
		return nil, err
	}
	return runChannelHandshake(ctx, s, cfg, false)
}

// serverChannelHandshake is the exit side of the same session. The peer list
// is the principal's admitted certificates from the store.
func serverChannelHandshake(ctx context.Context, s tunnelStream, local tls.Certificate, peers []*x509.Certificate) (*tls.Conn, error) {
	cfg, err := serverChannelTLSConfig(local, peers)
	if err != nil {
		return nil, err
	}
	return runChannelHandshake(ctx, s, cfg, true)
}

func runChannelHandshake(ctx context.Context, s tunnelStream, cfg *tls.Config, server bool) (*tls.Conn, error) {
	streamConn := newChannelConn(s)
	var conn *tls.Conn
	if server {
		conn = tls.Server(streamConn, cfg)
	} else {
		conn = tls.Client(streamConn, cfg)
	}
	handshakeCtx, cancel := context.WithTimeout(ctx, tunnelHandshakeTimeout)
	defer cancel()
	if err := conn.HandshakeContext(handshakeCtx); err != nil {
		s.protocolViolation()
		_ = s.Close()
		return nil, fmt.Errorf("inner TLS handshake: %w", err)
	}
	return conn, nil
}

// tlsTunnelStream keeps the frame pump unchanged: the carrier's bytes are
// TLS records, and decoded frames are still one message at a time.
type tlsTunnelStream struct {
	conn  *tls.Conn
	inner tunnelStream
}

func newTLSTunnelStream(conn *tls.Conn, inner tunnelStream) tunnelStream {
	return &tlsTunnelStream{conn: conn, inner: inner}
}

func (s *tlsTunnelStream) readTunnelMsg() ([]byte, error) {
	msg, err := readFrameFromStream(s.conn)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
		s.alert()
	}
	return msg, err
}

func (s *tlsTunnelStream) writeTunnelMsg(msg []byte) error {
	_ = s.conn.SetWriteDeadline(time.Now().Add(tunnelKeepaliveInterval))
	defer func() { _ = s.conn.SetWriteDeadline(time.Time{}) }()
	_, err := s.conn.Write(msg)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
		s.alert()
	}
	return err
}

// alert promotes a TLS record failure into the carrier's protocol-violation
// vocabulary. A bad record is not a clean peer disconnect: it is evidence
// that the channel was tampered with, and the stream must die here.
func (s *tlsTunnelStream) alert() {
	s.inner.protocolViolation()
	_ = s.conn.Close()
}

func (s *tlsTunnelStream) setReadDeadline(t time.Time) error { return s.conn.SetReadDeadline(t) }
func (s *tlsTunnelStream) protocolViolation()                { s.inner.protocolViolation() }
func (s *tlsTunnelStream) transport() string                 { return s.inner.transport() }
func (s *tlsTunnelStream) sessionID() string                 { return s.inner.sessionID() }
func (s *tlsTunnelStream) Close() error                      { return s.conn.Close() }

// windowCarrier is one HTTP window's framed byte pipe. The handshake needs a
// stream; a window has a request body, a response body and no lifetime beyond
// its own proof, so the functions are bound to that exchange alone.
type windowCarrier struct {
	readFrame  func() ([]byte, error)
	writeFrame func([]byte) error
	fail       func()
	carrier    string
	session    string
}

func (w *windowCarrier) readTunnelMsg() ([]byte, error)  { return w.readFrame() }
func (w *windowCarrier) writeTunnelMsg(msg []byte) error { return w.writeFrame(msg) }
func (w *windowCarrier) setReadDeadline(time.Time) error { return nil }
func (w *windowCarrier) protocolViolation()              { w.fail() }
func (w *windowCarrier) Close() error                    { w.fail(); return nil }
func (w *windowCarrier) transport() string               { return w.carrier }
func (w *windowCarrier) sessionID() string               { return w.session }

// windowChannel completes one handshake over a framed window and returns the
// frame stream the session pump uses inside it. A new window always means a
// new handshake: a lost window must not strand the next one on a dead record
// layer (d236).
func windowChannel(ctx context.Context, s tunnelStream, local tls.Certificate, peer *x509.Certificate, server bool) (tunnelStream, error) {
	var (
		conn *tls.Conn
		err  error
	)
	if server {
		conn, err = serverChannelHandshake(ctx, s, local, []*x509.Certificate{peer})
	} else {
		conn, err = clientChannelHandshake(ctx, s, local, peer)
	}
	if err != nil {
		return nil, err
	}
	return newTLSTunnelStream(conn, s), nil
}

// tlsWireSize is a conservative bound on the carrier bytes one plaintext
// frame becomes: TLS 1.3 adds a record header and tag per 16 KiB chunk.
func tlsWireSize(n int) int {
	return n + 22*(1+(n-1)/(16<<10)) + 32
}
