package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func admissionMaterial(t *testing.T, priv ed25519.PrivateKey) []byte {
	t.Helper()
	der, err := mintPrincipalCertificate(priv, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func admissionPub(t *testing.T, priv ed25519.PrivateKey) ed25519.PublicKey {
	t.Helper()
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		t.Fatal("key is not Ed25519")
	}
	return pub
}

func TestValidateRelayAdmission(t *testing.T) {
	relayPriv := testHostKey(t)
	relayDER := admissionMaterial(t, relayPriv)
	exitPriv := testHostKey(t)
	exitDER := admissionMaterial(t, exitPriv)
	trust := admissionTrust{"relay_bazzite": relayCertFromDER(t, relayDER)}

	headers, _, err := channelRequestHeaders(relayPriv, "relay_bazzite", "exit-home", relayDER)
	if err != nil {
		t.Fatal(err)
	}
	result, err := validateRelayAdmission(headers.Values(eAuthHeaderName), headers.Values(ePubHeaderName), trust, "exit-home", newNonceRing(4))
	if err != nil {
		t.Fatal(err)
	}
	if result.Name != "relay_bazzite" || len(result.Nonce) != 16 || !result.Cert.Equal(trust["relay_bazzite"]) {
		t.Fatalf("result = %+v", result)
	}

	response, err := channelResponseHeaders(exitPriv, "exit-home", "relay_bazzite", result.Nonce, exitDER)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifyExitAuth(response.Get(eAuthHeaderName), admissionPub(t, exitPriv), "exit-home", "relay_bazzite", result.Nonce); err != nil {
		t.Fatalf("exit proof: %v", err)
	}
}

func relayCertFromDER(t *testing.T, der []byte) *x509.Certificate {
	t.Helper()
	cert, err := parsePrincipalCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert
}

func TestValidateRelayAdmissionFailures(t *testing.T) {
	relayPriv := testHostKey(t)
	relayDER := admissionMaterial(t, relayPriv)
	otherPriv := testHostKey(t)
	otherDER := admissionMaterial(t, otherPriv)

	headers, _, err := channelRequestHeaders(relayPriv, "relay_bazzite", "exit-home", relayDER)
	if err != nil {
		t.Fatal(err)
	}
	trust := admissionTrust{"relay_bazzite": relayCertFromDER(t, relayDER)}

	wrongCert := make(http.Header)
	wrongCert.Set(eAuthHeaderName, headers.Get(eAuthHeaderName))
	wrongCert.Set(ePubHeaderName, encodeEPub(otherDER))
	_, err = validateRelayAdmission(wrongCert.Values(eAuthHeaderName), wrongCert.Values(ePubHeaderName), trust, "exit-home", newNonceRing(4))
	var untrusted *untrustedPeerError
	if !errors.As(err, &untrusted) || untrusted.Name != "relay_bazzite" {
		t.Fatalf("wrong certificate: %v", err)
	}

	unknown, _, err := channelRequestHeaders(otherPriv, "relay_laptop", "exit-home", otherDER)
	if err != nil {
		t.Fatal(err)
	}
	_, err = validateRelayAdmission(unknown.Values(eAuthHeaderName), unknown.Values(ePubHeaderName), trust, "exit-home", newNonceRing(4))
	if !errors.As(err, &untrusted) || untrusted.Name != "relay_laptop" {
		t.Fatalf("unknown principal: %v", err)
	}

	tampered := strings.Replace(headers.Get(eAuthHeaderName), "v2.", "v3.", 1)
	_, err = validateRelayAdmission([]string{tampered}, headers.Values(ePubHeaderName), trust, "exit-home", newNonceRing(4))
	if err == nil || errors.As(err, &untrusted) {
		t.Fatalf("tampered token: %v", err)
	}
}

func TestTrustMapsFromStores(t *testing.T) {
	cert := relayCertFromDER(t, admissionMaterial(t, testHostKey(t)))
	relay := &relayStore{Exits: []relayExitEntry{{Name: "exit-home", Cert: cert}}}
	exit := &exitStore{Relays: []storeKeyEntry{{Name: "relay_bazzite", Cert: cert}}}
	if trustFromRelayStore(relay)["exit-home"] != cert {
		t.Fatal("relay trust map lost its pinned certificate")
	}
	if trustFromExitStore(exit)["relay_bazzite"] != cert {
		t.Fatal("exit trust map lost its pinned certificate")
	}
}

func TestMutualAdmissionAndSingleUseProofs(t *testing.T) {
	relayPriv, exitPriv := testHostKey(t), testHostKey(t)
	relayDER, exitDER := admissionMaterial(t, relayPriv), admissionMaterial(t, exitPriv)
	exitTrust := admissionTrust{"relay": relayCertFromDER(t, relayDER)}
	relayTrust := admissionTrust{"exit": relayCertFromDER(t, exitDER)}
	exitRing, relayRing := newNonceRing(4), newNonceRing(4)

	headers, nonce, err := channelRequestHeaders(relayPriv, "relay", "exit", relayDER)
	if err != nil {
		t.Fatal(err)
	}
	result, err := validateRelayAdmission(headers.Values(eAuthHeaderName), headers.Values(ePubHeaderName), exitTrust, "exit", exitRing)
	if err != nil {
		t.Fatal(err)
	}
	response, err := admissionResponse(exitPriv, "exit", exitDER, &result)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateExitAdmission(response.Values(eAuthHeaderName), response.Values(ePubHeaderName), relayTrust, "exit", "relay", nonce, relayRing); err != nil {
		t.Fatal(err)
	}

	// Both halves are single-use: the same bytes cannot answer a second
	// exchange, even though their signatures and pins are still valid.
	if _, err := validateRelayAdmission(headers.Values(eAuthHeaderName), headers.Values(ePubHeaderName), exitTrust, "exit", exitRing); err == nil {
		t.Fatal("replayed relay proof was accepted")
	}
	if err := validateExitAdmission(response.Values(eAuthHeaderName), response.Values(ePubHeaderName), relayTrust, "exit", "relay", nonce, relayRing); err == nil {
		t.Fatal("replayed exit proof was accepted")
	}

	// A captured exit proof does not bind a later relay nonce.
	fresh, freshNonce, err := channelRequestHeaders(relayPriv, "relay", "exit", relayDER)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := validateRelayAdmission(fresh.Values(eAuthHeaderName), fresh.Values(ePubHeaderName), exitTrust, "exit", exitRing); err != nil {
		t.Fatal(err)
	}
	if err := validateExitAdmission(response.Values(eAuthHeaderName), response.Values(ePubHeaderName), relayTrust, "exit", "relay", freshNonce, relayRing); err == nil {
		t.Fatal("exit proof from another exchange verified")
	}
}

func TestExitAdmissionRefusesWrongPin(t *testing.T) {
	exitPriv := testHostKey(t)
	exitDER := admissionMaterial(t, exitPriv)
	otherDER := admissionMaterial(t, testHostKey(t))
	relayPriv := testHostKey(t)
	relayDER := admissionMaterial(t, relayPriv)
	headers, nonce, err := channelRequestHeaders(relayPriv, "relay", "exit", relayDER)
	if err != nil {
		t.Fatal(err)
	}
	result, err := validateRelayAdmission(headers.Values(eAuthHeaderName), headers.Values(ePubHeaderName), admissionTrust{"relay": relayCertFromDER(t, relayDER)}, "exit", newNonceRing(4))
	if err != nil {
		t.Fatal(err)
	}
	response, err := admissionResponse(exitPriv, "exit", exitDER, &result)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateExitAdmission(response.Values(eAuthHeaderName), response.Values(ePubHeaderName), admissionTrust{"exit": relayCertFromDER(t, otherDER)}, "exit", "relay", nonce, newNonceRing(4)); err == nil {
		t.Fatal("exit proof verified against the wrong pin")
	}
}

func TestNonceRingEvictsAtCapacity(t *testing.T) {
	ring := newNonceRing(2)
	one, two, three := bytesOf(1), bytesOf(2), bytesOf(3)
	if !ring.consume(one) || !ring.consume(two) || ring.consume(one) {
		t.Fatal("ring did not track the first two nonces")
	}
	if !ring.consume(three) || ring.consume(two) {
		t.Fatal("ring did not evict the oldest nonce")
	}
}
