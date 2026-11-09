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
	cfg, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t), false)
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
	if _, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t), false); err == nil || !strings.Contains(err.Error(), "must be http://, https://, ws:// or wss://") {
		t.Fatalf("non-wire scheme: err=%v, want the four-scheme contract", err)
	}
}

// The relay interpolates its bearer into mode D's hand-rolled handshake
// request with fmt.Fprintf, so a token carrying CR/LF would let the operator's
// own credential inject headers into our outbound request. validate() refuses
// it before any bind (VPN-R26 fail-closed); the exit node applies the same rule
// to its key set, so a token accepted on one side is accepted on both.
func TestRelayConfigRefusesTokenThatCouldInjectHeaders(t *testing.T) {
	for _, tc := range []struct{ name, token string }{
		{"CRLF", "token-0123456789\r\nX-Injected: 1"},
		{"bare CR", "token-0123456789\rX-Injected: 1"},
		{"bare LF", "token-0123456789\nX-Injected: 1"},
		// NUL cannot cross os.Setenv, so the exit-side JSON case is where that
		// byte is covered (tunnelserver_test.go).
		{"DEL", "token-0123456789\x7f"},
		{"below the length floor", "short"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(envTunnelURL, "https://relay.example.test/vpn")
			t.Setenv(envOperatorToken, tc.token)

			// The production pair, without relaysConfigFrom's fixture token:
			// relayConfigFromEnv parses, validate() gates the bind (runRelayNode
			// treats either error as fatal).
			cfg, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t), false)
			if err == nil {
				err = cfg.validate()
			}
			if err == nil {
				t.Fatalf("token %q was accepted; it can carry header framing", tc.token)
			}
			if !strings.Contains(err.Error(), "control characters") && !strings.Contains(err.Error(), "at least 16 bytes") {
				t.Fatalf("token %q refused for the wrong reason: %v", tc.token, err)
			}
		})
	}
}

// A well-formed token still passes, so the refusal above is about framing and
// not about rejecting the bearer generally.
func TestRelayConfigAcceptsWellFormedToken(t *testing.T) {
	t.Setenv(envTunnelURL, "https://relay.example.test/vpn")
	t.Setenv(envOperatorToken, "a-well-formed-operator-token-0123456789")
	cfg, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t), false)
	if err == nil {
		err = cfg.validate()
	}
	if err != nil {
		t.Fatalf("well-formed token refused: %v", err)
	}
}
