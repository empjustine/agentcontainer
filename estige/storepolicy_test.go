package main

// storepolicy_test.go — docs/d078's per-principal egress, now carried by the
// store (d236): a relay row's own table narrows that principal, and an exit
// without one applies the file-level table (or the requirement's defaults).

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"testing"
	"time"
)

// writeRelayRowEgress pins the suite relay with its own egress row, leaving the
// file-level table absent (the requirement's defaults).
func writeRelayRowEgress(t *testing.T, egress *egressConfig) {
	t.Helper()
	raw, err := json.Marshal(egress)
	if err != nil {
		t.Fatal(err)
	}
	entry := fmt.Sprintf(`"name":%q,"public":%q,"egress":%s`, testV5Principal, encodeEPub(testV5CertDER), raw)
	writeTestRoleFile(t, "exit.json", fmt.Sprintf(`{"relays":[{%s}]}`, entry))
}

func TestPerRelayEgressIsEnforced(t *testing.T) {
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

	// The process default denies loopback: only the relay row can open it.
	writeRelayRowEgress(t, &egressConfig{AllowCidrs: []string{"127.0.0.0/8"}, Ports: []uint16{port}})
	s := &server{}
	if err := s.enableTunnel(); err != nil {
		t.Fatal(err)
	}
	u := mustTunnelURL(t, newHTTPServer(t, s))
	addr := net.JoinHostPort(testTargetAlias, strconv.FormatUint(uint64(port), 10))
	if typ, reason := connectReply(t, u, addr); typ != frameConnected {
		t.Fatalf("relay row did not admit its range: typ=%d reason=%q", typ, reason)
	}
}

// d242: with no reservation the loopback-resolving alias reaches the dial
// path — the default is "route IP traffic", and a reserved range is the
// operator's opt-in. The per-row test shows the reservation half.
func TestEgressDefaultAdmitsWithoutARowTable(t *testing.T) {
	writeTestExitJSON(t, nil)
	s := &server{}
	if err := s.enableTunnel(); err != nil {
		t.Fatal(err)
	}
	u := mustTunnelURL(t, newHTTPServer(t, s))
	// 443 is in the default port set, so a dial is attempted: the refusal
	// that proves admission is the dial's, not the address table's.
	if typ, reason := connectReply(t, u, net.JoinHostPort(testTargetAlias, "443")); typ != frameConnectErr || reason != errReasonDial {
		t.Fatalf("default posture did not admit the target: typ=%d reason=%q", typ, reason)
	}
}

// connectReply opens one authenticated tunnel and issues CONNECT, returning
// the reply frame type and its reason payload.
func connectReply(t *testing.T, u *url.URL, target string) (byte, string) {
	t.Helper()
	ws, err := dialTunnelForTest(t, u)
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
