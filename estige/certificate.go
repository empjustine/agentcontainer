// certificate.go — the v5 host certificate and its wire spelling (d236).
//
// WHY the certificate travels in its own header: d236 keeps the blind token's
// four-segment grammar fixed, and a truncated token blob would deny service to
// every peer behind a size-capped reverse proxy.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"slices"
	"time"
)

const (
	channelName       = "estige"
	channelBackdate   = 24 * time.Hour
	channelValidYears = 15
	ePubHeaderName    = "E-Pub"
)

var errEPubCardinality = errors.New(ePubHeaderName + " must appear exactly once")

// mintPrincipalCertificate derives a self-signed channel certificate from priv.
// The subject is empty, the only name is the fixed SAN, and the private key
// never leaves the caller.
func mintPrincipalCertificate(priv ed25519.PrivateKey, now time.Time) ([]byte, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("host key must be %d-byte Ed25519", ed25519.PrivateKeySize)
	}
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok || len(pub) != ed25519.PublicKeySize {
		return nil, errors.New("host key does not yield an Ed25519 public key")
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("certificate serial: %w", err)
	}
	if serial.Sign() == 0 {
		serial.SetInt64(1)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		NotBefore:             now.Add(-channelBackdate),
		NotAfter:              now.AddDate(channelValidYears, 0, 0),
		DNSNames:              []string{channelName},
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, priv)
	if err != nil {
		return nil, fmt.Errorf("create host certificate: %w", err)
	}
	return der, nil
}

// parsePrincipalCertificate accepts only the d236 certificate shape. A valid
// but untrusted certificate is a separate case: the caller logs it instead of
// refusing it here.
func parsePrincipalCertificate(der []byte) (*x509.Certificate, error) {
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, fmt.Errorf("parse certificate: %w", err)
	}
	if len(cert.Subject.ToRDNSequence()) != 0 || len(cert.Issuer.ToRDNSequence()) != 0 {
		return nil, errors.New("certificate name fields must be empty")
	}
	if len(cert.DNSNames) != 1 || cert.DNSNames[0] != channelName {
		return nil, errors.New("certificate must carry exactly one DNS SAN: " + channelName)
	}
	if len(cert.EmailAddresses) != 0 || len(cert.IPAddresses) != 0 || len(cert.URIs) != 0 {
		return nil, errors.New("certificate carries a SAN outside DNS")
	}
	pub, ok := cert.PublicKey.(ed25519.PublicKey)
	if !ok || len(pub) != ed25519.PublicKeySize {
		return nil, errors.New("certificate key is not Ed25519")
	}
	if cert.IsCA || cert.KeyUsage&x509.KeyUsageCertSign != 0 {
		return nil, errors.New("certificate is a CA")
	}
	if !hasEKU(cert, x509.ExtKeyUsageServerAuth) || !hasEKU(cert, x509.ExtKeyUsageClientAuth) {
		return nil, errors.New("certificate needs both server and client usage")
	}
	if cert.NotBefore.Year() <= 1 || cert.NotAfter.Year() <= 1 || !cert.NotAfter.After(cert.NotBefore) {
		return nil, errors.New("certificate validity is missing or inverted")
	}
	if err := cert.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature); err != nil {
		return nil, fmt.Errorf("certificate self-signature: %w", err)
	}
	return cert, nil
}

func hasEKU(cert *x509.Certificate, want x509.ExtKeyUsage) bool {
	return slices.Contains(cert.ExtKeyUsage, want)
}

// parseEPubHeader enforces one canonical header value per HTTP exchange.
func parseEPubHeader(values []string) (*x509.Certificate, string, error) {
	if len(values) != 1 {
		return nil, "", fmt.Errorf("%w: got %d", errEPubCardinality, len(values))
	}
	encoded := values[0]
	der, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, "", fmt.Errorf("decode "+ePubHeaderName+": %w", err)
	}
	if got := base64.RawURLEncoding.EncodeToString(der); got != encoded {
		return nil, "", errors.New(ePubHeaderName + " is not canonical base64url")
	}
	cert, err := parsePrincipalCertificate(der)
	if err != nil {
		return nil, "", fmt.Errorf("invalid "+ePubHeaderName+": %w", err)
	}
	return cert, encoded, nil
}

func encodeEPub(der []byte) string {
	return base64.RawURLEncoding.EncodeToString(der)
}
