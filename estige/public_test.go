package main

// public_test.go — estige public derives the same entry keygen prints, and
// refuses a private key whose file name is not a principal (docs/d132).

import (
	"os"
	"path/filepath"
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
