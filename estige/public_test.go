package main

// public_test.go — estige public reprints the certificate row keygen wrote,
// and refuses a key whose name or certificate cannot be trusted (d236).

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublicDerivesEntryFromKeyFile(t *testing.T) {
	dir := t.TempDir()
	privPath, entry, _, err := keygen(dir, keygenTestPrincipal, false)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	derived, err := publicEntryFromKeyFile(privPath)
	if err != nil {
		t.Fatalf("publicEntryFromKeyFile: %v", err)
	}
	if derived != entry {
		t.Fatalf("derived entry = %+v, want %+v", derived, entry)
	}
	if _, _, err := parseEPubHeader([]string{derived.Public}); err != nil {
		t.Fatalf("derived public is not a pinned certificate: %v", err)
	}
}

func TestPublicRefusesMissingOrWrongCertificate(t *testing.T) {
	dir := t.TempDir()
	privPath, _, _, err := keygen(dir, keygenTestPrincipal, false)
	if err != nil {
		t.Fatal(err)
	}
	certPath := strings.TrimSuffix(privPath, keygenPrivSuffix) + keygenCertSuffix
	if err := os.Remove(certPath); err != nil {
		t.Fatal(err)
	}
	if _, err := publicEntryFromKeyFile(privPath); err == nil {
		t.Fatal("public accepted a key without its certificate")
	}
	otherPath, _, _, err := keygen(t.TempDir(), keygenTestPrincipal, false)
	if err != nil {
		t.Fatal(err)
	}
	otherDER, err := os.ReadFile(strings.TrimSuffix(otherPath, keygenPrivSuffix) + keygenCertSuffix)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(certPath, otherDER, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := publicEntryFromKeyFile(privPath); err == nil {
		t.Fatal("public accepted a certificate from another key")
	}
}

func TestPublicRejectsNonPrincipalFileName(t *testing.T) {
	dir := t.TempDir()
	privPath, _, _, err := keygen(dir, keygenTestPrincipal, false)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	der, err := os.ReadFile(privPath)
	if err != nil {
		t.Fatalf("read private: %v", err)
	}
	badPath := filepath.Join(filepath.Dir(privPath), "bad.name"+keygenPrivSuffix)
	if err := os.WriteFile(badPath, der, 0o600); err != nil {
		t.Fatalf("write bad-named key: %v", err)
	}
	if _, err := publicEntryFromKeyFile(badPath); err == nil {
		t.Fatalf("public accepted a file name outside the principal grammar")
	}
}

func TestPublicRejectsNonPrivateKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), keygenTestPrincipal+keygenPrivSuffix)
	if err := os.WriteFile(path, []byte("not a key"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if _, err := publicEntryFromKeyFile(path); err == nil {
		t.Fatalf("public accepted a non-PKCS#8 file")
	}
}
