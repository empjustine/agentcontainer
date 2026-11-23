package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"net"
	"testing"
	"time"
)

func testHostKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return priv
}

func testCertTemplate(now time.Time) *x509.Certificate {
	return &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		NotBefore:             now.Add(-channelBackdate),
		NotAfter:              now.AddDate(channelValidYears, 0, 0),
		DNSNames:              []string{channelName},
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
	}
}

func mintTestCert(t *testing.T, tmpl *x509.Certificate, priv ed25519.PrivateKey) []byte {
	t.Helper()
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		t.Fatal("test key is not Ed25519")
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, priv)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func TestMintPrincipalCertificateShape(t *testing.T) {
	priv := testHostKey(t)
	now := time.Date(2026, time.November, 21, 12, 0, 0, 0, time.UTC)
	der, err := mintPrincipalCertificate(priv, now)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := parsePrincipalCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	if len(cert.Subject.ToRDNSequence()) != 0 || len(cert.Issuer.ToRDNSequence()) != 0 {
		t.Fatalf("name fields are not empty: subject=%q issuer=%q", cert.Subject, cert.Issuer)
	}
	if len(cert.DNSNames) != 1 || cert.DNSNames[0] != channelName {
		t.Fatalf("SANs = %v", cert.DNSNames)
	}
	if !hasEKU(cert, x509.ExtKeyUsageServerAuth) || !hasEKU(cert, x509.ExtKeyUsageClientAuth) {
		t.Fatalf("EKUs = %v", cert.ExtKeyUsage)
	}
	if cert.IsCA || cert.KeyUsage&x509.KeyUsageCertSign != 0 {
		t.Fatal("certificate is marked as a CA")
	}
	if !cert.NotBefore.Equal(now.Add(-channelBackdate)) || !cert.NotAfter.Equal(now.AddDate(channelValidYears, 0, 0)) {
		t.Fatalf("validity = %s .. %s", cert.NotBefore, cert.NotAfter)
	}
	pub, ok := cert.PublicKey.(ed25519.PublicKey)
	wantPub, pubOK := priv.Public().(ed25519.PublicKey)
	if !ok || !pubOK || !bytes.Equal(pub, wantPub) {
		t.Fatal("certificate does not carry the host public key")
	}
}

func TestParsePrincipalCertificateRejects(t *testing.T) {
	priv := testHostKey(t)
	now := time.Date(2026, time.November, 21, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name   string
		mutate func(*x509.Certificate)
		tamper bool
	}{
		{"no san", func(c *x509.Certificate) { c.DNSNames = nil }, false},
		{"wrong san", func(c *x509.Certificate) { c.DNSNames = []string{"other"} }, false},
		{"extra san", func(c *x509.Certificate) { c.DNSNames = append(c.DNSNames, "other") }, false},
		{"ip san", func(c *x509.Certificate) { c.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")} }, false},
		{"subject", func(c *x509.Certificate) { c.Subject = pkix.Name{CommonName: channelName} }, false},
		{"ca", func(c *x509.Certificate) { c.IsCA = true; c.KeyUsage |= x509.KeyUsageCertSign }, false},
		{"one eku", func(c *x509.Certificate) { c.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth} }, false},
		{"no validity", func(c *x509.Certificate) { c.NotBefore, c.NotAfter = time.Time{}, time.Time{} }, false},
		{"bad signature", func(*x509.Certificate) {}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tmpl := testCertTemplate(now)
			tc.mutate(tmpl)
			der := mintTestCert(t, tmpl, priv)
			if tc.tamper {
				der[len(der)-1] ^= 0x40
			}
			if _, err := parsePrincipalCertificate(der); err == nil {
				t.Fatal("invalid certificate accepted")
			}
		})
	}
}

func TestEPubHeader(t *testing.T) {
	priv := testHostKey(t)
	der, err := mintPrincipalCertificate(priv, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	valid := encodeEPub(der)
	cert, encoded, err := parseEPubHeader([]string{valid})
	if err != nil {
		t.Fatal(err)
	}
	if encoded != valid || cert.DNSNames[0] != channelName {
		t.Fatal("valid header did not round-trip")
	}
	for _, values := range [][]string{nil, {}, {valid, valid}} {
		if _, _, err := parseEPubHeader(values); !errors.Is(err, errEPubCardinality) {
			t.Fatalf("values %v: got %v", values, err)
		}
	}
	if _, _, err := parseEPubHeader([]string{valid + "="}); err == nil {
		t.Fatal("padded base64url accepted")
	}
}

func TestSameKeyRemintDoesNotVerify(t *testing.T) {
	priv := testHostKey(t)
	now := time.Now()
	oldDER := mintTestCert(t, testCertTemplate(now), priv)
	oldCert, err := parsePrincipalCertificate(oldDER)
	if err != nil {
		t.Fatal(err)
	}
	freshTmpl := testCertTemplate(now)
	freshTmpl.SerialNumber = big.NewInt(2)
	freshTmpl.NotAfter = now.AddDate(channelValidYears, 0, 0)
	freshDER := mintTestCert(t, freshTmpl, priv)
	freshCert, err := parsePrincipalCertificate(freshDER)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(oldCert)
	if _, err := freshCert.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err == nil {
		t.Fatal("same-key re-mint verified against the old pin")
	}
}
