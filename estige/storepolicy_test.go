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
	"os"
	"path/filepath"
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
	exitFile := fmt.Sprintf(`{"relays":[{%s}]}`, entry)
	if err := os.WriteFile(filepath.Join(testV5StoreRoot, "exit.json"), []byte(exitFile), 0o600); err != nil {
		t.Fatal(err)
	}
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

func TestEgressDefaultsDenyWithoutARowTable(t *testing.T) {
	writeTestExitJSON(t, nil)
	s := &server{}
	if err := s.enableTunnel(); err != nil {
		t.Fatal(err)
	}
	u := mustTunnelURL(t, newHTTPServer(t, s))
	// Loopback is in the default-deny table, so the exit refuses before any
	// dial (VPN-R35) — the same verdict the per-row test reverses.
	if typ, reason := connectReply(t, u, net.JoinHostPort(testTargetAlias, "443")); typ != frameConnectErr || reason != errReasonDenied {
		t.Fatalf("default table let a loopback target through: typ=%d reason=%q", typ, reason)
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
