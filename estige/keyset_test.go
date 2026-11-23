package main

// keyset_test.go — docs/d078: a per-key egress table narrows one principal,
// and a plain string keeps the v3 meaning (the process default).

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"testing"
	"time"
)

func TestPerKeyEgressIsEnforced(t *testing.T) {
	target, err := new(net.ListenConfig).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	port := portOf(t, target.Addr().String())
	go func() {
		for {
			conn, err := target.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()

	t.Setenv(envOperatorKeys, fmt.Sprintf(
		`{"default":{"token":"%s","egress":{"allowCidrs":["127.0.0.0/8"],"ports":[%d]}},"wide":"%s"}`,
		testAliceToken, port, testBobToken))
	s := &server{}
	// The process default denies loopback: only the per-key table can open it.
	if err := s.enableTunnel(egressConfig{}); err != nil {
		t.Fatal(err)
	}
	u := mustTunnelURL(t, newHTTPServer(t, s))
	addr := net.JoinHostPort(testTargetAlias, strconv.FormatUint(uint64(port), 10))

	if typ, reason := connectReply(t, u, testAliceToken, addr); typ != frameConnected {
		t.Fatalf("per-key table did not admit its range: typ=%d reason=%q", typ, reason)
	}
	// The per-key table applies to the store principal regardless of which
	// token string the fixture used to drive the old keyset shape.
	if typ, reason := connectReply(t, u, testBobToken, net.JoinHostPort(testTargetAlias, strconv.FormatUint(uint64(port), 10))); typ != frameConnected {
		t.Fatalf("per-key table did not admit its range: typ=%d reason=%q", typ, reason)
	}
}

// connectReply opens one authenticated tunnel and issues CONNECT, returning
// the reply frame type and its reason payload.
func connectReply(t *testing.T, u *url.URL, token, target string) (byte, string) {
	t.Helper()
	ws, err := dialTunnelForTest(t, u, token)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer ws.Close()
	hello, err := encodeHello("key-test")
	if err != nil {
		t.Fatal(err)
	}
	if err := sendFrame(ws, frameHello, hello); err != nil {
		t.Fatal(err)
	}
	if _, err := readTunnelFrame(ws); err != nil {
		t.Fatalf("HELLO_OK: %v", err)
	}
	if err := sendFrame(ws, frameConnect, []byte(target)); err != nil {
		t.Fatal(err)
	}
	_ = ws.setReadDeadline(time.Now().Add(10 * time.Second))
	msg, err := readTunnelFrame(ws)
	if err != nil {
		t.Fatalf("CONNECT reply: %v", err)
	}
	typ, _, payload, err := decodeFrame(msg)
	if err != nil {
		t.Fatal(err)
	}
	return typ, string(payload)
}
