// relayconfig_test.go — the relay's one config path, unit level: relay.json's
// endpoint is accepted in the URL's honest wire form (http/https/ws/wss) and
// normalized once, the store is the only credential surface (d236), and there
// is no transport-offer knob left to get wrong — the ladder rides whole and
// ranks at dial time (docs/d093). The construction pair mirrors production
// exactly: relayConfigFromEnv's parse, then validate() (runRelayNode treats
// either error as fatal, VPN-R26).
package main

import (
	"strings"
	"testing"
)

// relaysConfigFrom is the production construction pair, store included.
func relaysConfigFrom(t *testing.T, endpoint string) (relayConfig, error) {
	t.Helper()
	writeTestRelayJSON(t, endpoint)
	cfg, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t), relaySelection{}, false, true)
	if err != nil {
		return cfg, err
	}
	return cfg, cfg.validate()
}

// A store endpoint carrying userinfo would make net/http mint its own
// Authorization header — a second credential spelling the store forbids.
func TestRelayEndpointRefusesUserinfo(t *testing.T) {
	if _, err := relaysConfigFrom(t, "https://user:secret@example.invalid:8443/vpn"); err == nil {
		t.Fatal("expected the userinfo refusal")
	} else if !strings.Contains(err.Error(), "must not carry credentials") {
		t.Fatalf("err=%v, want the userinfo refusal", err)
	}
}

// A missing store refuses before any bind: no credential, no listener
// (VPN-R26 fail-closed).
func TestRelayConfigRequiresTheStore(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	if _, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t), relaySelection{}, false, true); err == nil {
		t.Fatal("a relay with no store bound anyway")
	}
}

// The label reaches both nodes' log records, so only printable ASCII rides
// the HELLO.
func TestRelayConfigRefusesUnprintableLabel(t *testing.T) {
	for _, label := range []string{"relay\nEVENT=forged", "relay\tfield", "relais\x7f", "réseau", strings.Repeat("x", tunnelLabelMax+1)} {
		t.Run(label, func(t *testing.T) {
			writeTestRelayJSON(t, "https://example.invalid:8443/vpn")
			t.Setenv(envClientLabel, label)
			cfg, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t), relaySelection{}, false, true)
			if err != nil {
				t.Fatal(err)
			}
			if err := cfg.validate(); err == nil {
				t.Fatalf("label %q accepted", label)
			}
		})
	}
}

func TestRelayConfigNormalizesStoreEndpoint(t *testing.T) {
	for _, tc := range []struct{ endpoint, wantScheme string }{
		// Cleartext — accepted under -insecure-exit (d090 §3, d171): the C
		// rung is unreachable on it (alpnNegotiate skips non-wss), the
		// websocket and windowed carriers serve.
		{"http://127.0.0.1:8443/vpn", "ws"},
		{"ws://127.0.0.1:8443/vpn", "ws"},
		// TLS — every carrier available; the probe decides h2 or h1.
		{"https://example.invalid:8443/vpn", "wss"},
		{"wss://example.invalid:8443/vpn", "wss"},
	} {
		cfg, err := relaysConfigFrom(t, tc.endpoint)
		if err != nil {
			t.Fatalf("%s: %v", tc.endpoint, err)
		}
		if cfg.tunnelURL.Scheme != tc.wantScheme {
			t.Errorf("%s: scheme=%q, want canonical %q", tc.endpoint, cfg.tunnelURL.Scheme, tc.wantScheme)
		}
	}

	writeTestRelayJSON(t, "ftp://example.invalid/vpn")
	if _, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t), relaySelection{}, false, true); err == nil || !strings.Contains(err.Error(), "must be http://, https://, ws:// or wss://") {
		t.Fatalf("non-wire scheme: err=%v, want the four-scheme contract", err)
	}
}

// The endpoint is the pairing line (d132): one URL, host + path, nothing that
// could arrive half-configured.
func TestRelayEndpointGrammar(t *testing.T) {
	for _, endpoint := range []string{"https://example.invalid", "wss:///vpn", "", "https:///vpn"} {
		t.Run(endpoint, func(t *testing.T) {
			writeTestRelayJSON(t, endpoint)
			if _, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t), relaySelection{}, false, true); err == nil {
				t.Fatalf("endpoint %q was accepted", endpoint)
			}
		})
	}
}
