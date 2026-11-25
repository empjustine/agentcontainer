// admission.go — the blind proof pair and the untrusted certificate hint
// (d236/d131).
//
// WHY each direction has its own header: a single `E-Auth` made the reader
// decode a direction from the payload, and an auditor could not tell which
// half an exchange carried from the header set alone. `e-relay-auth` rides a
// request, `e-exit-auth` a response, and the signed label still binds the
// direction, so a proof cannot be reflected.
//
// WHY the envelope keeps four segments: d131 pinned the grammar and the signed
// bytes; only the header names changed.
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
)

const (
	// eRelayAuthHeader rides the relay's request, eExitAuthHeader the exit's
	// response, and ePubHeader carries either sender's certificate. The
	// values are canonical MIME case because Go's http.Header stores that
	// form; the wire spelling is case-insensitive (HTTP/2 lowercases it), and
	// prose names them e-relay-auth / e-exit-auth / e-pub.
	eRelayAuthHeader = "E-Relay-Auth"
	eExitAuthHeader  = "E-Exit-Auth"
	authToken        = "v2"
	// replayRingSize is d131's 64 Ki-entry single-use ring. It is consumed
	// only by proofs that already verified, so only a peer holding a
	// principal key can fill it; eviction after 64 Ki genuine exchanges is
	// an accounting bound, not a clock (d104's no-clock auth law).
	replayRingSize = 64 << 10
)

const (
	dirRelayToExit = "estige/v2/relay-to-exit"
	dirExitToRelay = "estige/v2/exit-to-relay"
)

var errAuthCardinality = errors.New("the auth header must appear exactly once")

type authEnvelope struct {
	Name  string
	Nonce []byte
	Sig   []byte
}

func parseEAuthHeader(values []string) (authEnvelope, error) {
	if len(values) != 1 {
		return authEnvelope{}, fmt.Errorf("%w: got %d", errAuthCardinality, len(values))
	}
	parts := strings.Split(values[0], ".")
	if len(parts) != 4 || parts[0] != authToken {
		return authEnvelope{}, errors.New("malformed auth envelope")
	}
	if err := validPrincipal(parts[1]); err != nil {
		return authEnvelope{}, fmt.Errorf("auth envelope name: %w", err)
	}
	nonce, err := decodeAuthField(parts[2], 16, "nonce")
	if err != nil {
		return authEnvelope{}, err
	}
	sig, err := decodeAuthField(parts[3], ed25519.SignatureSize, "signature")
	if err != nil {
		return authEnvelope{}, err
	}
	return authEnvelope{Name: parts[1], Nonce: nonce, Sig: sig}, nil
}

func decodeAuthField(value string, want int, what string) ([]byte, error) {
	if len(value) != base64.RawURLEncoding.EncodedLen(want) {
		return nil, fmt.Errorf("auth %s has the wrong length", what)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("decode auth %s: %w", what, err)
	}
	if len(decoded) != want {
		return nil, fmt.Errorf("auth %s has the wrong byte count", what)
	}
	if got := base64.RawURLEncoding.EncodeToString(decoded); got != value {
		return nil, fmt.Errorf("auth %s is not canonical base64url", what)
	}
	return decoded, nil
}

func encodeEAuth(name string, nonce, sig []byte) string {
	return strings.Join([]string{
		authToken,
		name,
		base64.RawURLEncoding.EncodeToString(nonce),
		base64.RawURLEncoding.EncodeToString(sig),
	}, ".")
}

func authMessage(label string, fields ...[]byte) []byte {
	msg := make([]byte, 0, len(label)+64)
	msg = append(msg, label...)
	for _, field := range fields {
		msg = append(msg, field...)
	}
	return msg
}

func mintRelayAuth(priv ed25519.PrivateKey, relayName, exitName string, nonce []byte) (string, error) {
	if len(nonce) != 16 {
		return "", errors.New("relay nonce must be 16 bytes")
	}
	msg := authMessage(dirRelayToExit, nonce, []byte(relayName), []byte(exitName))
	return encodeEAuth(relayName, nonce, ed25519.Sign(priv, msg)), nil
}

func verifyRelayAuth(value string, pub ed25519.PublicKey, relayName, exitName string) ([]byte, error) {
	env, err := parseEAuthHeader([]string{value})
	if err != nil {
		return nil, err
	}
	if env.Name != relayName {
		return nil, errors.New("relay proof names another principal")
	}
	msg := authMessage(dirRelayToExit, env.Nonce, []byte(relayName), []byte(exitName))
	if !ed25519.Verify(pub, msg, env.Sig) {
		return nil, errors.New("relay proof signature failed")
	}
	return env.Nonce, nil
}

func mintExitAuth(priv ed25519.PrivateKey, exitName, relayName string, nonce, relayNonce []byte) (string, error) {
	if len(nonce) != 16 || len(relayNonce) != 16 {
		return "", errors.New("exit and relay nonces must be 16 bytes")
	}
	msg := authMessage(dirExitToRelay, nonce, relayNonce, []byte(exitName), []byte(relayName))
	return encodeEAuth(exitName, nonce, ed25519.Sign(priv, msg)), nil
}

func verifyExitAuth(value string, pub ed25519.PublicKey, exitName, relayName string, relayNonce []byte) ([]byte, error) {
	if len(relayNonce) != 16 {
		return nil, errors.New("relay nonce must be 16 bytes")
	}
	env, err := parseEAuthHeader([]string{value})
	if err != nil {
		return nil, err
	}
	if env.Name != exitName {
		return nil, errors.New("exit proof names another principal")
	}
	msg := authMessage(dirExitToRelay, env.Nonce, relayNonce, []byte(exitName), []byte(relayName))
	if !ed25519.Verify(pub, msg, env.Sig) {
		return nil, errors.New("exit proof signature failed")
	}
	return env.Nonce, nil
}

// nonceRing is one end's single-use proof cache. A nonce enters it only
// after its signature verifies, so a forged proof cannot grow the ring.
type nonceRing struct {
	mu    sync.Mutex
	seen  map[string]struct{}
	order []string
	head  int
}

func newNonceRing(size int) *nonceRing {
	if size < 1 {
		// A zero-capacity ring would panic on its first eviction; the only
		// honest reading of "no horizon" is one entry, never none.
		size = 1
	}
	return &nonceRing{seen: make(map[string]struct{}, size), order: make([]string, 0, size)}
}

// consume reports whether nonce is unused and marks it consumed. The ring
// evicts the oldest entry at capacity; no wall clock takes part.
func (r *nonceRing) consume(nonce []byte) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := string(nonce)
	if _, ok := r.seen[key]; ok {
		return false
	}
	if len(r.order) == cap(r.order) {
		delete(r.seen, r.order[r.head])
		r.order[r.head] = key
		r.head = (r.head + 1) % cap(r.order)
	} else {
		r.order = append(r.order, key)
	}
	r.seen[key] = struct{}{}
	return true
}
