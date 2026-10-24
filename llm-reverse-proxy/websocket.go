// websocket.go — a minimal RFC 6455 client and server, stdlib only.
//
// WHY this exists instead of a library: the repo ships zero Go dependencies
// (d031 F1) and d073 VPN-R15 requires the tunnel be implementable with no
// third-party dependency. Only what the tunnel needs is here: the opening
// handshake (no extensions are ever negotiated — permessage-deflate would
// put a compressor between the blind relay and the payload, VPN-R19), binary
// messages with fragmentation reassembly, close/ping/pong control frames.
// Text frames, subprotocols, and extensions are rejected: the tunnel
// protocol is binary-only (VPN-R15).
//
// TLS policy on the client dial (d073 §7): wss verifies the Funnel
// `*.ts.net` certificate against the system roots (VPN-R28 — public CA, no
// custom trust store) and there is no opt-out knob; InsecureSkipVerify is
// forbidden outright in this module (VPN-R55).
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"sync"
	"time"
)

// wsGUID is the RFC 6455 §1.3 handshake constant; the Sec-WebSocket-Accept
// value is base64(sha1(key + GUID)).
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// WebSocket opcodes actually used. RFC 6455 §5.2.
const (
	wsOpContinuation byte = 0x0
	wsOpText         byte = 0x1 // accepted only to reject it with 1003
	wsOpBinary       byte = 0x2
	wsOpClose        byte = 0x8
	wsOpPing         byte = 0x9
	wsOpPong         byte = 0xa
)

// Close codes the tunnel emits (§10.1 registry).
const (
	wsCloseNormal              = 1000
	wsCloseProtocolError       = 1002
	wsCloseUnsupported         = 1003
	wsCloseInternalErr         = 1011
	wsCloseGoingAway           = 1001
	wsMaxControlPayload        = 125 // RFC 6455 §5.5 control frames
	wsMaxMessage         int64 = 1 << 20
)

// errWSClosed reports an orderly or peer-initiated close; io.EOF is used for
// a transport that just died (the relay maps both to lifecycle outcomes).
var errWSClosed = errors.New("websocket closed")

// wsConn is one established WebSocket. Reads happen on one goroutine;
// writes are serialized by writeMu (the relay writes DATA/CLOSE and PONG
// from different goroutines — VPN-R18's backpressure model means at most one
// frame is ever in flight per direction, but two directions do write).
type wsConn struct {
	conn    net.Conn
	br      *bufio.Reader
	bw      *bufio.Writer
	client  bool // client frames are masked (RFC 6455 §5.3)
	writeMu sync.Mutex
}

// ---------------------------------------------------------------------------
// Handshake (server side)
// ---------------------------------------------------------------------------

// wsAccept validates a client's upgrade request and returns the raw
// 101 response to write on the hijacked connection. It is separated from the
// hijack/write so auth can run BEFORE any upgrade work (VPN-R12/R39: an
// unauthenticated upgrade never reaches a 101).
func wsAccept(r *http.Request) (response []byte, err error) {
	if !headerHasToken(r.Header, "Upgrade", "websocket") || !headerHasToken(r.Header, "Connection", "Upgrade") {
		return nil, fmt.Errorf("%w: missing Upgrade/Connection headers", ErrProtocol)
	}
	if v := r.Header.Get("Sec-WebSocket-Version"); v != "13" {
		return nil, fmt.Errorf("%w: unsupported websocket version %q", ErrProtocol, v)
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if decoded, err := base64.StdEncoding.DecodeString(key); err != nil || len(decoded) != 16 {
		return nil, fmt.Errorf("%w: malformed Sec-WebSocket-Key", ErrProtocol)
	}
	// No Sec-WebSocket-Extensions ever reaches the response: nothing is
	// negotiated, so nothing sits between the relay and the bytes (VPN-R19).
	var b strings.Builder
	b.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	b.WriteString("Upgrade: websocket\r\n")
	b.WriteString("Connection: Upgrade\r\n")
	b.WriteString("Sec-WebSocket-Accept: ")
	b.WriteString(wsAcceptKey(key))
	b.WriteString("\r\n\r\n")
	return []byte(b.String()), nil
}

// wsAcceptKey is the RFC 6455 §1.3 computation (exposed for tests: the
// sample key there is the one interoperability fact worth pinning).
func wsAcceptKey(key string) string {
	sum := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// headerHasToken reports whether a header carries a comma-separated token
// case-insensitively (RFC 9110 §5.1 — Connection may list several tokens).
func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Handshake (client side)
// ---------------------------------------------------------------------------

// wsDial connects to a ws:// or wss:// tunnel URL and completes the client
// handshake. extraHeaders carries Authorization (VPN-R12 — the credential
// rides this handshake, protected by the tunnel leg's TLS).
func wsDial(ctx context.Context, tunnelURL *url.URL, extraHeaders http.Header) (*wsConn, error) {
	var raw net.Conn
	var err error
	dialer := &net.Dialer{}
	switch tunnelURL.Scheme {
	case "ws", "wss":
		scheme := tunnelURL.Scheme
		addr := tunnelURL.Host
		if !hasPort(addr) {
			if scheme == "wss" {
				addr = net.JoinHostPort(addr, "443")
			} else {
				addr = net.JoinHostPort(addr, "80")
			}
		}
		if scheme == "wss" {
			// System roots, ServerName from the URL host, no override knobs:
			// the Funnel `*.ts.net` certificate must verify as-is (VPN-R28),
			// and nothing in this module may weaken verification (VPN-R55).
			td := &tls.Dialer{Config: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: tunnelURL.Hostname()}}
			raw, err = td.DialContext(ctx, "tcp", addr)
		} else {
			raw, err = dialer.DialContext(ctx, "tcp", addr)
		}
	default:
		return nil, fmt.Errorf("tunnel URL scheme must be ws or wss, got %q", tunnelURL.Scheme)
	}
	if err != nil {
		return nil, err
	}

	// The handshake never outlives a bounded window even when ctx carries
	// no deadline of its own (VPN-R39): a black-holed endpoint ends in an
	// error, not a goroutine parked on a read. The context may only make
	// the window shorter, never extend it.
	handshakeDeadline := time.Now().Add(tunnelHandshakeTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(handshakeDeadline) {
		handshakeDeadline = d
	}
	_ = raw.SetDeadline(handshakeDeadline)

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		raw.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	path := tunnelURL.RequestURI()
	var req strings.Builder
	fmt.Fprintf(&req, "GET %s HTTP/1.1\r\n", path)
	fmt.Fprintf(&req, "Host: %s\r\n", tunnelURL.Host)
	req.WriteString("Upgrade: websocket\r\n")
	req.WriteString("Connection: Upgrade\r\n")
	fmt.Fprintf(&req, "Sec-WebSocket-Key: %s\r\n", key)
	req.WriteString("Sec-WebSocket-Version: 13\r\n")
	for name, values := range extraHeaders {
		for _, v := range values {
			fmt.Fprintf(&req, "%s: %s\r\n", name, v)
		}
	}
	req.WriteString("\r\n")

	if _, err := io.WriteString(raw, req.String()); err != nil {
		raw.Close()
		return nil, err
	}

	br := bufio.NewReader(raw)
	statusLine, err := readLine(br)
	if err != nil {
		raw.Close()
		return nil, err
	}
	fields := strings.Fields(statusLine)
	if len(fields) < 2 || fields[1] != "101" {
		raw.Close()
		return nil, fmt.Errorf("tunnel handshake: expected 101, got %q", statusLine)
	}
	respHeader, err := textproto.NewReader(br).ReadMIMEHeader()
	if err != nil {
		raw.Close()
		return nil, fmt.Errorf("tunnel handshake: reading response headers: %w", err)
	}
	if got := respHeader.Get("Sec-WebSocket-Accept"); got != wsAcceptKey(key) {
		raw.Close()
		return nil, fmt.Errorf("tunnel handshake: bad Sec-WebSocket-Accept %q", got)
	}
	// The handshake's deadline must not become the session's: after 101 the
	// keepalive/idle policy owns the connection's timing (VPN-R14).
	_ = raw.SetDeadline(time.Time{})
	return &wsConn{conn: raw, br: br, bw: bufio.NewWriter(raw), client: true}, nil
}

// readLine reads one CRLF-terminated line without the terminator (the
// response status line of the client handshake).
func readLine(br *bufio.Reader) (string, error) {
	line, err := br.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func hasPort(host string) bool {
	_, _, err := net.SplitHostPort(host)
	return err == nil
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

// readFrame reads exactly one WebSocket frame off the wire.
func (w *wsConn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	var head [2]byte
	if _, err = io.ReadFull(w.br, head[:]); err != nil {
		return false, 0, nil, err
	}
	fin = head[0]&0x80 != 0
	if head[0]&0x70 != 0 {
		return false, 0, nil, fmt.Errorf("%w: RSV bits set without a negotiated extension", ErrProtocol)
	}
	opcode = head[0] & 0x0f
	masked := head[1]&0x80 != 0
	// RFC 6455 §5.3 polarity: client→server frames are masked,
	// server→client frames are bare. Enforced by role — a proxy in the
	// middle (the Funnel edge) is byte-transparent, so a violated polarity
	// means the PEER got the role wrong, not the network.
	if masked == w.client {
		return false, 0, nil, fmt.Errorf("%w: frame masking violates role polarity", ErrProtocol)
	}
	n := int64(head[1] & 0x7f)
	switch n {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(w.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		n = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(w.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		n = int64(binary.BigEndian.Uint64(ext[:]))
		if n < 0 {
			return false, 0, nil, fmt.Errorf("%w: negative frame length", ErrProtocol)
		}
	}
	if opcode >= wsOpClose && (!fin || n > wsMaxControlPayload) {
		return false, 0, nil, fmt.Errorf("%w: malformed control frame", ErrProtocol)
	}
	if n > wsMaxMessage {
		return false, 0, nil, fmt.Errorf("%w: frame of %d bytes exceeds the cap", ErrProtocol, n)
	}
	var maskKey [4]byte
	if masked {
		if _, err = io.ReadFull(w.br, maskKey[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(w.br, payload); err != nil {
		return false, 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return fin, opcode, payload, nil
}

// readMessage reads one complete data message, transparently answering
// pings and consuming pong/close control frames. Fragmented messages are
// reassembled (an intermediary may never fragment — we do not — but a
// conforming peer may, and rejecting it would be a protocol bug).
func (w *wsConn) readMessage() (opcode byte, payload []byte, err error) {
	var assembled []byte
	var msgOp byte // RFC 6455 5.4: the first frame's opcode is the message's
	inFragment := false
	for {
		var fin bool
		var frame []byte
		fin, opcode, frame, err = w.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch opcode {
		case wsOpPing:
			if err := w.writeFrame(wsOpPong, frame); err != nil {
				return 0, nil, err
			}
			continue
		case wsOpPong:
			continue
		case wsOpClose:
			// Echo the close (RFC 6455 §5.5.1) and surface it as an
			// orderly end; the peer's code/reason is intentionally not
			// parsed — the relay's lifecycle log records our own outcome.
			_ = w.writeFrame(wsOpClose, frame)
			return 0, nil, errWSClosed
		case wsOpText:
			_ = w.writeClose(wsCloseUnsupported)
			return 0, nil, fmt.Errorf("%w: text frames are not part of the tunnel protocol", ErrProtocol)
		case wsOpBinary:
			if inFragment {
				return 0, nil, fmt.Errorf("%w: new data frame inside a fragmented message", ErrProtocol)
			}
			msgOp, assembled, inFragment = wsOpBinary, frame, !fin
		case wsOpContinuation:
			if !inFragment {
				return 0, nil, fmt.Errorf("%w: continuation without a start frame", ErrProtocol)
			}
			assembled = append(assembled, frame...)
			inFragment = !fin
		default:
			return 0, nil, fmt.Errorf("%w: unknown opcode %d", ErrProtocol, opcode)
		}
		if !inFragment {
			if int64(len(assembled)) > wsMaxMessage {
				return 0, nil, fmt.Errorf("%w: assembled message exceeds the cap", ErrProtocol)
			}
			return msgOp, assembled, nil
		}
	}
}

// writeMessage sends one complete data message as a single unfragmented
// frame (payloads are frame-capped below any fragmentation threshold).
func (w *wsConn) writeMessage(opcode byte, payload []byte) error {
	return w.writeFrame(opcode, payload)
}

// writeFrame serializes one frame: client frames masked with fresh random
// keys (RFC 6455 §5.3), server frames bare. One mutex covers control and
// data writes so interleaved frames never corrupt each other on the wire.
func (w *wsConn) writeFrame(opcode byte, payload []byte) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()

	// Every write is bounded (VPN-R39): a peer that stops draining the
	// socket must surface as an error, not a goroutine parked in Flush
	// forever. Serialized under writeMu so the deferred clear cannot erase
	// a concurrent frame's window; the interval is generous — a healthy
	// relay drains frames in milliseconds.
	_ = w.conn.SetWriteDeadline(time.Now().Add(tunnelKeepaliveInterval))
	defer w.conn.SetWriteDeadline(time.Time{})

	var head [14]byte
	head[0] = 0x80 | opcode // FIN set: the tunnel never fragments
	n := len(payload)
	var hn int
	switch {
	case n < 126:
		head[1] = byte(n)
		hn = 2
	case n <= 0xffff:
		head[1] = 126
		binary.BigEndian.PutUint16(head[2:4], uint16(n))
		hn = 4
	default:
		head[1] = 127
		binary.BigEndian.PutUint64(head[2:10], uint64(n))
		hn = 10
	}
	if w.client {
		head[1] |= 0x80
		var key [4]byte
		if _, err := rand.Read(key[:]); err != nil {
			return err
		}
		if _, err := w.bw.Write(head[:hn]); err != nil {
			return err
		}
		if _, err := w.bw.Write(key[:]); err != nil {
			return err
		}
		masked := make([]byte, n)
		for i, b := range payload {
			masked[i] = b ^ key[i%4]
		}
		if _, err := w.bw.Write(masked); err != nil {
			return err
		}
	} else {
		if _, err := w.bw.Write(head[:hn]); err != nil {
			return err
		}
		if _, err := w.bw.Write(payload); err != nil {
			return err
		}
	}
	return w.bw.Flush()
}

// writeClose sends an orderly close frame (best-effort: the peer may be
// gone, and the caller is already tearing down).
func (w *wsConn) writeClose(code uint16) error {
	var payload [2]byte
	binary.BigEndian.PutUint16(payload[:], code)
	return w.writeFrame(wsOpClose, payload[:])
}

// Close tears the connection down without a close frame — the abnormal path
// (protocol error, idle timeout, local failure). Idempotent.
func (w *wsConn) Close() error {
	return w.conn.Close()
}
