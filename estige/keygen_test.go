package main

// keygen_test.go — pins the host identity contract: the principal-named DER
// private key and its mode, the single-line base64url SPKI entry, and the
// refusal to replace a live key (docs/d132's rotate-don't-move).

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const keygenTestPrincipal = "tlalocayotl"

func TestKeygenWritesHostIdentity(t *testing.T) {
	dir := t.TempDir()
	privPath, entry, fingerprint, err := keygen(dir, keygenTestPrincipal, false)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	if want := filepath.Join(dir, keygenPrvDirName, keygenTestPrincipal+keygenPrivSuffix); privPath != want {
		t.Fatalf("private path = %q, want %q", privPath, want)
	}
	if entry.Name != keygenTestPrincipal {
		t.Fatalf("entry name = %q, want %q", entry.Name, keygenTestPrincipal)
	}

	privDER, err := os.ReadFile(privPath)
	if err != nil {
		t.Fatalf("read private: %v", err)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(privDER)
	if err != nil {
		t.Fatalf("private is not PKCS#8: %v", err)
	}
	priv, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		t.Fatalf("private key is %T, want ed25519.PrivateKey", parsed)
	}
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		t.Fatalf("public half is %T, want ed25519.PublicKey", priv.Public())
	}

	spki, err := base64.RawURLEncoding.DecodeString(entry.Public)
	if err != nil {
		t.Fatalf("entry public is not raw base64url: %v", err)
	}
	if len(spki) != 44 {
		t.Fatalf("SPKI length = %d, want 44", len(spki))
	}
	if strings.ContainsAny(entry.Public, "+/=") {
		t.Fatalf("entry public carries standard-base64 or padding characters: %q", entry.Public)
	}
	parsedPub, err := x509.ParsePKIXPublicKey(spki)
	if err != nil {
		t.Fatalf("entry public is not a SPKI: %v", err)
	}
	entryPub, ok := parsedPub.(ed25519.PublicKey)
	if !ok {
		t.Fatalf("entry SPKI holds %T, want ed25519.PublicKey", parsedPub)
	}
	if !entryPub.Equal(pub) {
		t.Fatalf("entry public does not match the private key")
	}

	if want := "SHA256:" + base64.RawURLEncoding.EncodeToString(sum256(pub)); fingerprint != want {
		t.Fatalf("fingerprint = %q, want %q", fingerprint, want)
	}
	assertPerm(t, privPath, 0o600)
	assertPerm(t, filepath.Dir(privPath), 0o700)
}

func TestKeygenRefusesExistingPrivateKey(t *testing.T) {
	dir := t.TempDir()
	privPath, _, _, err := keygen(dir, keygenTestPrincipal, false)
	if err != nil {
		t.Fatalf("first keygen: %v", err)
	}
	before, err := os.ReadFile(privPath)
	if err != nil {
		t.Fatalf("read private: %v", err)
	}

	if _, _, _, err := keygen(dir, keygenTestPrincipal, false); err == nil {
		t.Fatalf("second keygen without -force succeeded, want refusal")
	} else if !strings.Contains(err.Error(), "exists") {
		t.Fatalf("refusal %q does not name the existing file", err)
	}

	after, err := os.ReadFile(privPath)
	if err != nil {
		t.Fatalf("re-read private: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("refused keygen still rewrote the private key")
	}
}

func TestKeygenForceReplacesPrivateKey(t *testing.T) {
	dir := t.TempDir()
	privPath, _, _, err := keygen(dir, keygenTestPrincipal, false)
	if err != nil {
		t.Fatalf("first keygen: %v", err)
	}
	before, err := os.ReadFile(privPath)
	if err != nil {
		t.Fatalf("read private: %v", err)
	}
	if _, _, _, err := keygen(dir, keygenTestPrincipal, true); err != nil {
		t.Fatalf("forced keygen: %v", err)
	}
	after, err := os.ReadFile(privPath)
	if err != nil {
		t.Fatalf("re-read private: %v", err)
	}
	if bytes.Equal(before, after) {
		t.Fatalf("forced keygen did not replace the private key")
	}
	assertPerm(t, privPath, 0o600)
}

func TestKeygenRejectsUnsafePrincipal(t *testing.T) {
	for _, principal := range []string{"", "a/b", "..", "a.b", "bad name", "café", strings.Repeat("a", principalMaxLen+1)} {
		if _, _, _, err := keygen(t.TempDir(), principal, false); err == nil {
			t.Fatalf("keygen accepted principal %q", principal)
		}
	}
}

func assertPerm(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if got := fi.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %#o, want %#o", path, got, want)
	}
}

func sum256(pub ed25519.PublicKey) []byte {
	sum := sha256.Sum256(pub)
	return sum[:]
}
