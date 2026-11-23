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

	headers, err := channelRequestHeaders(relayPriv, "relay_bazzite", "exit-home", relayDER)
	if err != nil {
		t.Fatal(err)
	}
	result, err := validateRelayAdmission(headers.Values(eAuthHeaderName), headers.Values(ePubHeaderName), trust, "exit-home")
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

	headers, err := channelRequestHeaders(relayPriv, "relay_bazzite", "exit-home", relayDER)
	if err != nil {
		t.Fatal(err)
	}
	trust := admissionTrust{"relay_bazzite": relayCertFromDER(t, relayDER)}

	wrongCert := make(http.Header)
	wrongCert.Set(eAuthHeaderName, headers.Get(eAuthHeaderName))
	wrongCert.Set(ePubHeaderName, encodeEPub(otherDER))
	_, err = validateRelayAdmission(wrongCert.Values(eAuthHeaderName), wrongCert.Values(ePubHeaderName), trust, "exit-home")
	var untrusted *untrustedPeerError
	if !errors.As(err, &untrusted) || untrusted.Name != "relay_bazzite" {
		t.Fatalf("wrong certificate: %v", err)
	}

	unknown, err := channelRequestHeaders(otherPriv, "relay_laptop", "exit-home", otherDER)
	if err != nil {
		t.Fatal(err)
	}
	_, err = validateRelayAdmission(unknown.Values(eAuthHeaderName), unknown.Values(ePubHeaderName), trust, "exit-home")
	if !errors.As(err, &untrusted) || untrusted.Name != "relay_laptop" {
		t.Fatalf("unknown principal: %v", err)
	}

	tampered := strings.Replace(headers.Get(eAuthHeaderName), "v2.", "v3.", 1)
	_, err = validateRelayAdmission([]string{tampered}, headers.Values(ePubHeaderName), trust, "exit-home")
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
