// v5admission.go — the v5 admission pair: blind proofs and pinned certificates (d236).
//
// WHY the untrusted case carries its own error type: the handler writes one
// camouflage 404 either way, but only a valid certificate that lacks trust
// earns a seen_hosts line. Folding both cases into one error would either
// pollute the log or lose the operator's hint.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
)

type admissionTrust map[string]*x509.Certificate

func trustFromRelayStore(store *relayStore) admissionTrust {
	trust := make(admissionTrust, len(store.Exits))
	for _, entry := range store.Exits {
		trust[entry.Name] = entry.Cert
	}
	return trust
}

func trustFromExitStore(store *exitStore) admissionTrust {
	trust := make(admissionTrust, len(store.Relays))
	for _, entry := range store.Relays {
		trust[entry.Name] = entry.Cert
	}
	return trust
}

type untrustedPeerError struct {
	Name   string
	Public string
}

func (u *untrustedPeerError) Error() string {
	return "untrusted peer certificate for " + u.Name
}

type admissionResult struct {
	Name  string
	Cert  *x509.Certificate
	Nonce []byte
}

var errAdmission = errors.New("channel admission failed")

// validateRelayAdmission checks one request: a valid proof from a principal
// whose certificate is pinned for this exit. The peer name is the local
// principal the proof must bind.
func validateRelayAdmission(eAuth, ePub []string, trust admissionTrust, peerName string, replay *nonceRing) (admissionResult, error) {
	cert, encoded, err := parseEPubHeader(ePub)
	if err != nil {
		return admissionResult{}, fmt.Errorf("%w: E-Pub: %w", errAdmission, err)
	}
	env, err := parseEAuthHeader(eAuth)
	if err != nil {
		return admissionResult{}, fmt.Errorf("%w: E-Auth: %w", errAdmission, err)
	}
	pinned, ok := trust[env.Name]
	if !ok || !cert.Equal(pinned) {
		return admissionResult{}, fmt.Errorf("%w: %w", errAdmission, &untrustedPeerError{Name: env.Name, Public: encoded})
	}
	pub, ok := pinned.PublicKey.(ed25519.PublicKey)
	if !ok {
		return admissionResult{}, fmt.Errorf("%w: pinned key is not Ed25519", errAdmission)
	}
	if _, err := verifyRelayAuth(eAuth[0], pub, env.Name, peerName); err != nil {
		return admissionResult{}, fmt.Errorf("%w: %w", errAdmission, err)
	}
	if !replay.consume(env.Nonce) {
		return admissionResult{}, fmt.Errorf("%w: replayed relay proof", errAdmission)
	}
	return admissionResult{Name: env.Name, Cert: cert, Nonce: env.Nonce}, nil
}

// validateExitAdmission verifies the exit's proof of the same exchange. The
// relay's nonce is the binding: a captured exit proof cannot answer a later
// request even if its signature and pinned certificate are genuine.
func validateExitAdmission(eAuth, ePub []string, trust admissionTrust, exitName, relayName string, relayNonce []byte, replay *nonceRing) error {
	cert, encoded, err := parseEPubHeader(ePub)
	if err != nil {
		return fmt.Errorf("%w: E-Pub: %w", errAdmission, err)
	}
	env, err := parseEAuthHeader(eAuth)
	if err != nil {
		return fmt.Errorf("%w: E-Auth: %w", errAdmission, err)
	}
	pinned, ok := trust[exitName]
	if !ok || !cert.Equal(pinned) || env.Name != exitName {
		return fmt.Errorf("%w: %w", errAdmission, &untrustedPeerError{Name: exitName, Public: encoded})
	}
	pub, ok := pinned.PublicKey.(ed25519.PublicKey)
	if !ok {
		return fmt.Errorf("%w: pinned key is not Ed25519", errAdmission)
	}
	nonce, err := verifyExitAuth(eAuth[0], pub, exitName, relayName, relayNonce)
	if err != nil {
		return fmt.Errorf("%w: %w", errAdmission, err)
	}
	if !replay.consume(nonce) {
		return fmt.Errorf("%w: replayed exit proof", errAdmission)
	}
	return nil
}

// admissionResponse is the exit half of the blind exchange, carried on every
// authenticated response: one proof bound to this request's relay nonce.
func admissionResponse(priv ed25519.PrivateKey, principal string, selfDER []byte, result *admissionResult) (http.Header, error) {
	return channelResponseHeaders(priv, principal, result.Name, result.Nonce, selfDER)
}

// verifyExitResponse is the relay half. A valid certificate that is not the
// pinned exit still earns the operator hint; a malformed proof does not.
func verifyExitResponse(hdr http.Header, store *relayStore, endpoint string, replay *nonceRing, relayNonce []byte) error {
	err := validateExitAdmission(
		hdr.Values(eAuthHeaderName), hdr.Values(ePubHeaderName),
		trustFromRelayStore(store), store.Exits[0].Name, store.Principal, relayNonce, replay,
	)
	if err != nil {
		if untrusted, ok := errors.AsType[*untrustedPeerError](err); ok {
			_ = logSeenHost(roleRelay, endpoint, untrusted.Name, untrusted.Public)
		}
		return err
	}
	return nil
}

// channelRequestHeaders builds the relay's admission headers. A fresh nonce
// must be drawn for every exchange; reusing one is a replay, not a retry.
func channelRequestHeaders(priv ed25519.PrivateKey, principal, peerName string, certDER []byte) (http.Header, []byte, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, nil, fmt.Errorf("draw relay nonce: %w", err)
	}
	token, err := mintRelayAuth(priv, principal, peerName, nonce[:])
	if err != nil {
		return nil, nil, err
	}
	headers := make(http.Header)
	headers.Set(eAuthHeaderName, token)
	headers.Set(ePubHeaderName, encodeEPub(certDER))
	return headers, nonce[:], nil
}

// channelResponseHeaders builds the exit's proof and its public certificate.
func channelResponseHeaders(priv ed25519.PrivateKey, principal, peerName string, relayNonce []byte, certDER []byte) (http.Header, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, fmt.Errorf("draw exit nonce: %w", err)
	}
	token, err := mintExitAuth(priv, principal, peerName, nonce[:], relayNonce)
	if err != nil {
		return nil, err
	}
	headers := make(http.Header)
	headers.Set(eAuthHeaderName, token)
	headers.Set(ePubHeaderName, encodeEPub(certDER))
	return headers, nil
}
