package main

import (
	"crypto/ed25519"
	"errors"
	"strings"
	"testing"
)

func eAuthTestKey(t *testing.T) (ed25519.PrivateKey, ed25519.PublicKey) {
	t.Helper()
	priv := testHostKey(t)
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		t.Fatal("test key is not Ed25519")
	}
	return priv, pub
}

func TestEAuthRoundTrip(t *testing.T) {
	relayPriv, relayPub := eAuthTestKey(t)
	exitPriv, exitPub := eAuthTestKey(t)
	relayNonce := bytesOf(1)
	exitNonce := bytesOf(2)

	relayToken, err := mintRelayAuth(relayPriv, "relay_bazzite", "exit-home", relayNonce)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := verifyRelayAuth(relayToken, relayPub, "relay_bazzite", "exit-home"); err != nil || string(got) != string(relayNonce) {
		t.Fatalf("relay verify = %v, %v", got, err)
	}
	exitToken, err := mintExitAuth(exitPriv, "exit-home", "relay_bazzite", exitNonce, relayNonce)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := verifyExitAuth(exitToken, exitPub, "exit-home", "relay_bazzite", relayNonce); err != nil || string(got) != string(exitNonce) {
		t.Fatalf("exit verify = %v, %v", got, err)
	}
	if len(strings.Split(relayToken, ".")) != 4 {
		t.Fatalf("envelope is not four segments: %q", relayToken)
	}
}

func bytesOf(seed byte) []byte {
	out := make([]byte, 16)
	for i := range out {
		out[i] = seed + byte(i)
	}
	return out
}

func TestEAuthRejects(t *testing.T) {
	relayPriv, relayPub := eAuthTestKey(t)
	exitPriv, exitPub := eAuthTestKey(t)
	relayNonce := bytesOf(3)
	exitNonce := bytesOf(4)
	relayToken, err := mintRelayAuth(relayPriv, "relay_bazzite", "exit-home", relayNonce)
	if err != nil {
		t.Fatal(err)
	}
	exitToken, err := mintExitAuth(exitPriv, "exit-home", "relay_bazzite", exitNonce, relayNonce)
	if err != nil {
		t.Fatal(err)
	}

	parts := strings.Split(relayToken, ".")
	tamperedSig := append([]string(nil), parts...)
	tamperedSig[3] = strings.Repeat("A", len(tamperedSig[3]))
	extraSegment := relayToken + ".extra"
	wrongToken := append([]string(nil), parts...)
	wrongToken[0] = "v3"
	paddedNonce := append([]string(nil), parts...)
	paddedNonce[2] += "="

	cases := []struct {
		name string
		run  func() error
	}{
		{"wrong direction", func() error {
			_, err := verifyExitAuth(relayToken, relayPub, "exit-home", "relay_bazzite", relayNonce)
			return err
		}},
		{"wrong sender name", func() error { _, err := verifyRelayAuth(relayToken, relayPub, "relay_laptop", "exit-home"); return err }},
		{"wrong peer name", func() error {
			_, err := verifyRelayAuth(relayToken, relayPub, "relay_bazzite", "exit-other")
			return err
		}},
		{"wrong bound nonce", func() error {
			_, err := verifyExitAuth(exitToken, exitPub, "exit-home", "relay_bazzite", bytesOf(9))
			return err
		}},
		{"tampered signature", func() error {
			_, err := verifyRelayAuth(strings.Join(tamperedSig, "."), relayPub, "relay_bazzite", "exit-home")
			return err
		}},
		{"extra segment", func() error {
			_, err := verifyRelayAuth(extraSegment, relayPub, "relay_bazzite", "exit-home")
			return err
		}},
		{"wrong token", func() error {
			_, err := verifyRelayAuth(strings.Join(wrongToken, "."), relayPub, "relay_bazzite", "exit-home")
			return err
		}},
		{"padded nonce", func() error {
			_, err := verifyRelayAuth(strings.Join(paddedNonce, "."), relayPub, "relay_bazzite", "exit-home")
			return err
		}},
		{"two headers", func() error { _, err := parseEAuthHeader([]string{relayToken, relayToken}); return err }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.run(); err == nil {
				t.Fatal("invalid token accepted")
			}
		})
	}
	if _, err := parseEAuthHeader(nil); !errors.Is(err, errAuthCardinality) {
		t.Fatalf("missing header: %v", err)
	}
}
