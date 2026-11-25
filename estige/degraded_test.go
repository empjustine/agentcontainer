package main

// degraded_test.go — docs/d171's switch, its config-time refusal and its two
// local gates (the parsed forward door and the blind doors' first-bytes
// guard).

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestLooksLikeHTTPRequest(t *testing.T) {
	cases := []struct {
		first string
		want  bool
	}{
		{"GET / HTTP/1.1\r\nHost: x\r\n\r\n", true},
		{"POST /v1 HTTP/1.0\r\n", true},
		{"GET /path HTTP/1.1", true},
		// Not request lines: TLS, a server greeting, and two STARTTLS
		// preambles d171 promises not to break.
		{"\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03", false},
		{"220 mail.example ESMTP\r\n", false},
		{"+OK POP3 ready\r\n", false},
		{"* OK IMAP4rev1\r\n", false},
		{"EHLO client.example\r\n", false},
		{"get / HTTP/1.1\r\n", false},
		{"GET", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := looksLikeHTTPRequest([]byte(tc.first)); got != tc.want {
			t.Errorf("looksLikeHTTPRequest(%q) = %v, want %v", tc.first, got, tc.want)
		}
	}
}

func TestDegradedGuardClosesARequestLineAndPassesAClientHello(t *testing.T) {
	var buf strings.Builder
	defer captureTo(&buf)()
	node := &relayNode{cfg: relayConfig{label: "guard-test", insecureExit: true}}

	t.Run("HTTP request line closes the tunnel", func(t *testing.T) {
		client, server := net.Pipe()
		defer client.Close()
		guard := newDegradedGuard(server, node, "origin.test:80", viaConnect)
		go func() { _, _ = client.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n")) }()
		got := make([]byte, 64)
		if _, err := guard.Read(got); err == nil {
			t.Fatal("guard delivered a cleartext HTTP request")
		}
		if !strings.Contains(buf.String(), "reason=degraded-cleartext") {
			t.Fatalf("refusal not recorded:\n%s", buf.String())
		}
	})

	t.Run("a ClientHello passes untouched", func(t *testing.T) {
		client, server := net.Pipe()
		defer client.Close()
		guard := newDegradedGuard(server, node, "origin.test:443", viaConnect)
		hello := []byte{0x16, 0x03, 0x01, 0x00, 0x2f}
		go func() { _, _ = client.Write(hello) }()
		got := make([]byte, len(hello))
		n, err := io.ReadFull(guard, got)
		if err != nil || n != len(hello) {
			t.Fatalf("guard broke a TLS handshake: n=%d err=%v", n, err)
		}
	})

	t.Run("checkEarly catches pipelined bytes", func(t *testing.T) {
		client, server := net.Pipe()
		defer client.Close()
		guard := newDegradedGuard(server, node, "origin.test:80", viaConnect)
		if !guard.checkEarly([]byte("GET /p HTTP/1.1\r\n")) {
			t.Fatal("pipelined HTTP request was not classified")
		}
	})
}

func TestCleartextTunnelURLRequiresTheSwitch(t *testing.T) {
	writeTestRelayJSON(t, "ws://exit.example.test/vpn")
	if _, err := relayConfigFromEnv("127.0.0.1:3128", "127.0.0.1:1080", relaySelection{}, false, false); err == nil ||
		!strings.Contains(err.Error(), "-insecure-exit") {
		t.Fatalf("cleartext ws:// without the switch: err=%v, want the d171 refusal", err)
	}
	cfg, err := relayConfigFromEnv("127.0.0.1:3128", "127.0.0.1:1080", relaySelection{}, false, true)
	if err != nil {
		t.Fatalf("-insecure-exit must accept ws://: %v", err)
	}
	if !cfg.insecureExit {
		t.Fatal("the posture did not reach the config")
	}
}

func TestDegradedForwardDoorRefusesBeforeAnyTunnel(t *testing.T) {
	var buf strings.Builder
	defer captureTo(&buf)()
	c := &relayNode{cfg: relayConfig{label: "fwd", insecureExit: true}}
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://origin.test/p?q=1", nil)
	w := httptest.NewRecorder()
	c.handleForward(w, r)
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "degraded-forward-refused") {
		t.Fatalf("forward door: status=%d body=%q", w.Code, w.Body.String())
	}
	if !strings.Contains(buf.String(), "reason=degraded-cleartext") {
		t.Fatalf("refusal not recorded:\n%s", buf.String())
	}
	if strings.Contains(buf.String(), "q=1") {
		t.Fatalf("the query survived into the record:\n%s", buf.String())
	}
}

func TestHealthReportsTheDegradedPosture(t *testing.T) {
	u, err := url.Parse("ws://exit.example.test/vpn")
	if err != nil {
		t.Fatal(err)
	}
	c := &relayNode{cfg: relayConfig{insecureExit: true, tunnelURL: u}, live: newLiveRegistry()}
	w := httptest.NewRecorder()
	c.handleHealth(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/healthz", nil))
	if !strings.Contains(w.Body.String(), "\"degraded\":true") {
		t.Fatalf("health must name the posture: %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "\"sessions\":0") {
		t.Fatalf("health sessions must be the live gauge: %s", w.Body.String())
	}
}
