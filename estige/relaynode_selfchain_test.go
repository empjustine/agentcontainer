package main

import (
	"errors"
	"testing"
)

func TestRelayConfigRefusesSelfChain(t *testing.T) {
	t.Setenv(envTunnelURL, "https://relay.example.test/vpn")
	t.Setenv(envOperatorToken, "token")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:3128")

	_, err := relayConfigFromEnv("127.0.0.1:3128", "127.0.0.1:1080")
	if !errors.Is(err, errSelfChained) {
		t.Fatalf("relayConfigFromEnv err = %v, want errSelfChained", err)
	}
}

func TestRelayConfigAcceptsForeignChain(t *testing.T) {
	t.Setenv(envTunnelURL, "https://relay.example.test/vpn")
	t.Setenv(envOperatorToken, "token")
	t.Setenv("HTTPS_PROXY", "http://proxy.example.test:3128")

	cfg, err := relayConfigFromEnv("127.0.0.1:3128", "127.0.0.1:1080")
	if err != nil {
		t.Fatalf("relayConfigFromEnv: %v", err)
	}
	if cfg.chain == nil || cfg.chain.host() != "proxy.example.test:3128" {
		t.Fatalf("chain = %#v, want proxy.example.test:3128", cfg.chain)
	}
}
