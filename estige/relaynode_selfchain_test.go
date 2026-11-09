package main

import (
	"errors"
	"testing"
)

func TestRelayConfigRefusesSelfChain(t *testing.T) {
	t.Setenv(envTunnelURL, "https://relay.example.test/vpn")
	t.Setenv(envOperatorToken, "token")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:3128")

	_, err := relayConfigFromEnv("127.0.0.1:3128", "127.0.0.1:1080", false)
	if !errors.Is(err, errSelfChained) {
		t.Fatalf("relayConfigFromEnv err = %v, want errSelfChained", err)
	}
}

func TestRelayConfigAcceptsForeignChain(t *testing.T) {
	t.Setenv(envTunnelURL, "https://relay.example.test/vpn")
	t.Setenv(envOperatorToken, "token")
	t.Setenv("HTTPS_PROXY", "http://proxy.example.test:3128")

	cfg, err := relayConfigFromEnv("127.0.0.1:3128", "127.0.0.1:1080", false)
	if err != nil {
		t.Fatalf("relayConfigFromEnv: %v", err)
	}
	if cfg.chain == nil || cfg.chain.host() != "proxy.example.test:3128" {
		t.Fatalf("chain = %#v, want proxy.example.test:3128", cfg.chain)
	}
}

// The listener and the ambient proxy env name the same destination through
// different spellings. A substring test catches none of these, so each one
// used to start a self-chained relay: a proxy loop that dials the tunnel
// against the listener it is itself serving (docs/d095).
func TestRelayConfigRefusesSelfChainAcrossSpellings(t *testing.T) {
	cases := []struct {
		name   string
		envVar string
		value  string
		// The listener the relay is asked to bind, as the operator may spell
		// it — requireLoopback admits localhost and every loopback literal.
		proxyAddr string
	}{
		{"localhost names a 127.0.0.1 listener", "HTTP_PROXY", "http://localhost:3128", "127.0.0.1:3128"},
		{"127.0.0.1 names a localhost listener", "HTTP_PROXY", "http://127.0.0.1:3128", "localhost:3128"},
		{"scheme-less value (curl convention)", "HTTP_PROXY", "localhost:3128", "127.0.0.1:3128"},
		{"socks5 value names the socks listener", "SOCKS_SERVER", "socks5://localhost:1080", "127.0.0.1:1080"},
		{"bare socks value (libproxy convention)", "SOCKS_SERVER", "localhost:1080", "127.0.0.1:1080"},
		{"implicit http port", "HTTP_PROXY", "http://localhost", "127.0.0.1:80"},
		{"implicit socks5 port", "SOCKS_SERVER", "socks5://localhost", "127.0.0.1:1080"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(envTunnelURL, "https://relay.example.test/vpn")
			t.Setenv(envOperatorToken, "token")
			t.Setenv(tc.envVar, tc.value)

			// The socks listener stays clear of the value under test unless it
			// IS the subject; a distinct port keeps the case honest.
			socksAddr := "127.0.0.1:1080"
			if tc.proxyAddr == socksAddr {
				socksAddr = "127.0.0.1:1081"
			}
			_, err := relayConfigFromEnv(tc.proxyAddr, socksAddr, false)
			if !errors.Is(err, errSelfChained) {
				t.Fatalf("%s=%q against listener %q: err = %v, want errSelfChained",
					tc.envVar, tc.value, tc.proxyAddr, err)
			}
		})
	}
}

// A value with the same port but a genuinely different host must still be
// accepted: the check compares destinations, not ports.
//
// The tunnel URL is ws:// on purpose — an https:// URL reads HTTPS_PROXY, not
// HTTP_PROXY, so an HTTP_PROXY-only fixture would resolve to no chain at all.
func TestRelayConfigAcceptsSamePortDifferentHost(t *testing.T) {
	t.Setenv(envTunnelURL, "ws://relay.example.test/vpn")
	t.Setenv(envOperatorToken, "token")
	t.Setenv("HTTP_PROXY", "http://proxy.example.test:3128")

	cfg, err := relayConfigFromEnv("127.0.0.1:3128", "127.0.0.1:1080", false)
	if err != nil {
		t.Fatalf("relayConfigFromEnv: %v", err)
	}
	if cfg.chain == nil || cfg.chain.host() != "proxy.example.test:3128" {
		t.Fatalf("chain = %#v, want proxy.example.test:3128", cfg.chain)
	}
}

// IPv4 and IPv6 loopback are different sockets, so a chain pointing at one is
// not a self-chain for a listener bound to the other. Collapsing them would
// refuse a legitimate deployment (docs/d095's own loopback rule admits both).
func TestRelayConfigAcceptsOtherLoopbackFamily(t *testing.T) {
	cases := []struct{ envVar, value, proxyAddr string }{
		{"HTTPS_PROXY", "http://[::1]:3128", "127.0.0.1:3128"},
		{"HTTP_PROXY", "http://127.0.0.1:3128", "[::1]:3128"},
	}
	for _, tc := range cases {
		t.Run(tc.value+" vs "+tc.proxyAddr, func(t *testing.T) {
			t.Setenv(envTunnelURL, "ws://relay.example.test/vpn")
			t.Setenv(envOperatorToken, "token")
			t.Setenv(tc.envVar, tc.value)
			if _, err := relayConfigFromEnv(tc.proxyAddr, "127.0.0.1:1080", false); err != nil {
				t.Fatalf("%s=%q against listener %q: err = %v, want acceptance",
					tc.envVar, tc.value, tc.proxyAddr, err)
			}
		})
	}
}
