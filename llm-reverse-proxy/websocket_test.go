package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// The one interoperability fact of the handshake is the RFC 6455 §1.3
// sample; if this ever moves, every peer we have breaks identically.
func TestWSAcceptKeyRFC6455Sample(t *testing.T) {
	got := wsAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")
	if want := "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="; got != want {
		t.Fatalf("accept key = %q, want %q", got, want)
	}
}

func TestWSAcceptValidatesUpgrade(t *testing.T) {
	valid := func() *http.Request {
		key := make([]byte, 16)
		_, _ = rand.Read(key)
		return &http.Request{
			Header: http.Header{
				"Upgrade":    {"websocket"},
				"Connection": {"Upgrade"},
				// Canonical MIME spelling: http.Header.Get canonicalizes its
				// lookup key, but a hand-built map literal does not canonicalize
				// its stored keys — "Sec-WebSocket-Version" would be invisible.
				"Sec-Websocket-Version": {"13"},
				"Sec-Websocket-Key":     {base64.StdEncoding.EncodeToString(key)},
			},
		}
	}
	if _, err := wsAccept(valid()); err != nil {
		t.Fatalf("valid upgrade rejected: %v", err)
	}

	mutations := map[string]func(*http.Request){
		"no upgrade header": func(r *http.Request) { r.Header.Del("Upgrade") },
		"no connection hdr": func(r *http.Request) { r.Header.Del("Connection") },
		"wrong version":     func(r *http.Request) { r.Header.Set("Sec-Websocket-Version", "8") },
		"short key":         func(r *http.Request) { r.Header.Set("Sec-Websocket-Key", "c2hvcnQ=") },
		"garbage key":       func(r *http.Request) { r.Header.Set("Sec-Websocket-Key", "!!!") },
	}
	for name, mutate := range mutations {
		r := valid()
		mutate(r)
		if _, err := wsAccept(r); !errors.Is(err, ErrProtocol) {
			t.Errorf("%s: expected ErrProtocol, got %v", name, err)
		}
	}
}

func wsPair(t *testing.T) (client, server *wsConn) {
	t.Helper()
	c1, c2 := net.Pipe()
	return &wsConn{conn: c1, br: bufio.NewReader(c1), bw: bufio.NewWriter(c1), client: true},
		&wsConn{conn: c2, br: bufio.NewReader(c2), bw: bufio.NewWriter(c2), client: false}
}

type seenFrame struct {
	op      byte
	payload []byte
}

// drainFrames runs a background reader for one end of a net.Pipe pair.
// net.Pipe is strictly synchronous — without a reader on the far side, even
// an auto-pong blocks forever — so any test where one side writes control
// frames while also reading must drain concurrently.
func drainFrames(w *wsConn) <-chan seenFrame {
	out := make(chan seenFrame, 16)
	go func() {
		defer close(out)
		for {
			fin, op, payload, err := w.readFrame()
			if err != nil {
				return
			}
			if !fin {
				return
			}
			out <- seenFrame{op: op, payload: payload}
		}
	}()
	return out
}

func TestWSBinaryRoundTripBothDirections(t *testing.T) {
	client, server := wsPair(t)
	defer client.Close()
	defer server.Close()

	big := make([]byte, 70*1024) // exercises the extended length path
	_, _ = rand.Read(big)

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		op, msg, err := server.readMessage()
		if err != nil || op != wsOpBinary || len(msg) != len(big) {
			t.Errorf("server read: op=%d len=%d err=%v", op, len(msg), err)
			return
		}
		if err := server.writeMessage(wsOpBinary, msg); err != nil {
			t.Errorf("server echo: %v", err)
		}
	}()
	if err := client.writeMessage(wsOpBinary, big); err != nil {
		t.Fatalf("client write: %v", err)
	}
	op, echo, err := client.readMessage()
	wg.Wait()
	if err != nil || op != wsOpBinary || string(echo) != string(big) {
		t.Fatalf("client echo: op=%d len=%d err=%v", op, len(echo), err)
	}
}

// A conforming peer MAY fragment; reassembly is readMessage's job and a
// partially assembled message must never surface to the relay.
func TestWSFragmentationReassembly(t *testing.T) {
	client, server := wsPair(t)
	defer client.Close()
	defer server.Close()

	go func() {
		fragments := []struct {
			op   byte
			fin  bool
			data string
		}{
			{wsOpBinary, false, "hel"},
			{wsOpContinuation, false, "lo"},
			{wsOpContinuation, true, "-world"},
		}
		for _, part := range fragments {
			if err := client.writeRawFrame(part.op, part.fin, []byte(part.data)); err != nil {
				t.Errorf("fragment %q: %v", part.data, err)
				return
			}
		}
	}()

	op, msg, err := server.readMessage()
	if err != nil || op != wsOpBinary || string(msg) != "hello-world" {
		t.Fatalf("got op=%d msg=%q err=%v", op, msg, err)
	}
}

// writeRawFrame is the test-only escape hatch for frames the production
// writer never emits (non-FIN, control opcodes with custom payloads). It
// mirrors writeFrame's masking exactly — the server's polarity check (and
// the tests that assert it) depend on a client-role frame being masked.
func (w *wsConn) writeRawFrame(opcode byte, fin bool, payload []byte) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	body := payload
	var maskKey [4]byte
	masked := w.client
	if masked {
		if _, err := rand.Read(maskKey[:]); err != nil {
			return err
		}
		body = make([]byte, len(payload))
		for i := range payload {
			body[i] = payload[i] ^ maskKey[i%4]
		}
	}
	// Header byte 1 = FIN|opcode; byte 2 = mask bit | payload length.
	head := byte(len(body))
	if masked {
		head |= 0x80
	}
	first := opcode
	if fin {
		first |= 0x80
	}
	if _, err := w.bw.Write([]byte{first, head}); err != nil {
		return err
	}
	if masked {
		if _, err := w.bw.Write(maskKey[:]); err != nil {
			return err
		}
	}
	if _, err := w.bw.Write(body); err != nil {
		return err
	}
	return w.bw.Flush()
}

// Control frames flow inside readMessage: pings are answered transparently,
// a close surfaces as errWSClosed (the orderly end, VPN-R16).
func TestWSControlFrames(t *testing.T) {
	t.Run("ping is answered with pong", func(t *testing.T) {
		client, server := wsPair(t)
		defer client.Close()
		defer server.Close()
		drain := drainFrames(client)

		go func() {
			if err := client.writeRawFrame(wsOpPing, true, []byte("ka")); err != nil {
				t.Errorf("write ping: %v", err)
				return
			}
			if err := client.writeMessage(wsOpBinary, []byte("x")); err != nil {
				t.Errorf("write data: %v", err)
			}
		}()
		if _, msg, err := server.readMessage(); err != nil || string(msg) != "x" {
			t.Fatalf("readMessage: %q, %v", msg, err)
		}
		select {
		case f, ok := <-drain:
			if !ok || f.op != wsOpPong || string(f.payload) != "ka" {
				t.Fatalf("expected pong(ka), got op=%d payload=%q", f.op, f.payload)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("no pong arrived")
		}
	})

	t.Run("close surfaces as orderly end", func(t *testing.T) {
		client, server := wsPair(t)
		defer client.Close()
		defer server.Close()
		drain := drainFrames(client) // receives the server's echoed close

		go func() { _ = client.writeClose(wsCloseNormal) }()
		if _, _, err := server.readMessage(); !errors.Is(err, errWSClosed) {
			t.Fatalf("expected errWSClosed, got %v", err)
		}
		select {
		case f, ok := <-drain:
			if !ok || f.op != wsOpClose {
				t.Fatalf("expected echoed close, got ok=%v op=%d", ok, f.op)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("no echoed close")
		}
	})

	t.Run("mask polarity is enforced", func(t *testing.T) {
		client, server := wsPair(t)
		defer client.Close()
		defer server.Close()

		// A bare (unmasked) frame arriving at the server end means the peer
		// has the wrong role — reject before interpreting a single byte.
		craft := &wsConn{conn: client.conn, br: client.br, bw: client.bw, client: false}
		go func() {
			_ = craft.writeMessage(wsOpBinary, []byte("sneaky"))
		}()
		if _, _, _, err := server.readFrame(); !errors.Is(err, ErrProtocol) {
			t.Fatalf("expected ErrProtocol for unmasked client frame, got %v", err)
		}
	})
}

// The client handshake end-to-end: real socket, real 101, auth header and
// path asserted server-side — VPN-R11/R12's transport half.
func TestWSDialHandshake(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	type seen struct {
		path string
		auth string
	}
	seenCh := make(chan seen, 1)
	srvErr := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			srvErr <- err
			return
		}
		defer conn.Close()
		br := bufio.NewReader(conn)
		reqLine, err := br.ReadString('\n')
		if err != nil {
			srvErr <- err
			return
		}
		mimeHdr, err := textproto.NewReader(br).ReadMIMEHeader()
		if err != nil {
			srvErr <- err
			return
		}
		headers := http.Header(mimeHdr)
		path := strings.Fields(reqLine)[1]
		seenCh <- seen{path: path, auth: headers.Get("Authorization")}

		key := headers.Get("Sec-WebSocket-Key")
		if !headerHasToken(headers, "Upgrade", "websocket") || key == "" {
			srvErr <- errors.New("missing upgrade headers")
			return
		}
		_, _ = conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + wsAcceptKey(key) + "\r\n\r\n"))
		srv := &wsConn{conn: conn, br: br, bw: bufio.NewWriter(conn), client: false}
		op, msg, err := srv.readMessage()
		if err != nil {
			srvErr <- err
			return
		}
		srvErr <- srv.writeMessage(op, msg)
	}()

	u, _ := url.Parse("ws://" + ln.Addr().String() + "/secretcap/vpn")
	hdr := http.Header{"Authorization": {"Bearer tok-1234"}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := wsDial(ctx, u, hdr)
	if err != nil {
		t.Fatalf("wsDial: %v", err)
	}
	defer client.Close()

	if err := client.writeMessage(wsOpBinary, []byte("tunnel-hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	op, echo, err := client.readMessage()
	if err != nil || op != wsOpBinary || string(echo) != "tunnel-hello" {
		t.Fatalf("echo: op=%d %q err=%v", op, echo, err)
	}

	got := <-seenCh
	if got.path != "/secretcap/vpn" || got.auth != "Bearer tok-1234" {
		t.Fatalf("server saw path=%q auth=%q", got.path, got.auth)
	}
	if err := <-srvErr; err != nil {
		t.Fatalf("server side: %v", err)
	}
}

// A non-101 answer (the camouflage 404) must NOT look like a tunnel: no
// partial handshake, no session — dial fails with the real status.
func TestWSDialRejectsNon101(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		br := bufio.NewReader(conn)
		_, _ = br.ReadString('\n')
		_, _ = textproto.NewReader(br).ReadMIMEHeader()
		_, _ = io.WriteString(conn, "HTTP/1.1 404 Not Found\r\nContent-Length: 19\r\n\r\n404 page not found\n")
	}()

	u, _ := url.Parse("ws://" + ln.Addr().String() + "/secretcap/vpn")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := wsDial(ctx, u, nil); err == nil {
		t.Fatal("expected dial failure against a 404")
	} else if !strings.Contains(err.Error(), "404") {
		t.Fatalf("error should carry the real status, got %v", err)
	}
}
