// relayconfig_test.go — docs/d090/d093's config law, unit level: VPN_TUNNEL_URL
// is accepted in the URL's honest wire form (http/https/ws/wss) and normalized
// once; there is no transport-offer knob left to get wrong — the ladder rides
// whole and ranks at dial time (docs/d093). The construction pair mirrors
// production exactly: relayConfigFromEnv's parse, then validate() (runRelayNode
// treats either error as fatal, VPN-R26).
package main

import (
	"strings"
	"testing"
)

// relaysConfigFrom is the production construction pair, env included.
func relaysConfigFrom(t *testing.T, url string) (relayConfig, error) {
	t.Helper()
	armTestTunnelEnv(t)
	t.Setenv(envTunnelURL, url)
	cfg, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t))
	if err != nil {
		return cfg, err
	}
	return cfg, cfg.validate()
}

func TestRelayConfigFromEnvNormalizesWireSchemes(t *testing.T) {
	for _, tc := range []struct{ url, wantScheme string }{
		// Cleartext — accepted (d090 §3): the C rung is unreachable on it
		// (alpnNegotiate skips non-wss), D and E carry.
		{"http://127.0.0.1:8443/vpn", "ws"},
		{"ws://127.0.0.1:8443/vpn", "ws"},
		// TLS — C available; the probe decides h2 or h1.
		{"https://example.invalid:8443/vpn", "wss"},
		{"wss://example.invalid:8443/vpn", "wss"},
	} {
		cfg, err := relaysConfigFrom(t, tc.url)
		if err != nil {
			t.Fatalf("%s: %v", tc.url, err)
		}
		if cfg.tunnelURL.Scheme != tc.wantScheme {
			t.Errorf("%s: scheme=%q, want canonical %q", tc.url, cfg.tunnelURL.Scheme, tc.wantScheme)
		}
	}

	armTestTunnelEnv(t)
	t.Setenv(envTunnelURL, "ftp://example.invalid/vpn")
	if _, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t)); err == nil || !strings.Contains(err.Error(), "must be http://, https://, ws:// or wss://") {
		t.Fatalf("non-wire scheme: err=%v, want the four-scheme contract", err)
	}
}
