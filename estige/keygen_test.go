package main

// keygen_test.go — pins the host identity contract: the principal-named DER
// private key and its mode, the single-line base64url certificate entry, and
// the refusal to replace a live key (d132's rotate-don't-move, d236's pin).

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"fmt"
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

	entryDER, err := base64.RawURLEncoding.DecodeString(entry.Public)
	if err != nil {
		t.Fatalf("entry public is not raw base64url: %v", err)
	}
	if strings.ContainsAny(entry.Public, "+/=") {
		t.Fatalf("entry public carries standard-base64 or padding characters: %q", entry.Public)
	}
	entryCert, err := parsePrincipalCertificate(entryDER)
	if err != nil {
		t.Fatalf("entry public is not a host certificate: %v", err)
	}
	entryPub, ok := entryCert.PublicKey.(ed25519.PublicKey)
	if !ok || !entryPub.Equal(pub) {
		t.Fatalf("entry certificate does not carry the host key")
	}

	if want := "SHA256:" + base64.RawURLEncoding.EncodeToString(sum256(pub)); fingerprint != want {
		t.Fatalf("fingerprint = %q, want %q", fingerprint, want)
	}
	certPath := filepath.Join(dir, keygenPrvDirName, keygenTestPrincipal+keygenCertSuffix)
	certDER, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatalf("read certificate: %v", err)
	}
	cert, err := parsePrincipalCertificate(certDER)
	if err != nil {
		t.Fatalf("certificate shape: %v", err)
	}
	certPub, ok := cert.PublicKey.(ed25519.PublicKey)
	if !ok || !certPub.Equal(pub) {
		t.Fatal("certificate does not carry the host key")
	}
	assertPerm(t, privPath, 0o600)
	assertPerm(t, certPath, 0o600)
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

func TestKeyCheckLoadsBothRoleStores(t *testing.T) {
	summary, err := checkStore(mustStoreRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	// The suite store carries both role files, so both must be reported.
	for _, want := range []string{"relay: 1 pinned exit(s)", "exit: 1 admitted relay(s)"} {
		if !strings.Contains(summary, want) {
			t.Fatalf("checkStore = %q, want it to contain %q", summary, want)
		}
	}
}

func TestKeyCheckRefusesEmptyStore(t *testing.T) {
	if _, err := checkStore(t.TempDir()); err == nil {
		t.Fatal("key check accepted a store with no role files")
	}
}

// TestKeyCheckRefusesAStoreBootRefuses: the gate must not answer "ok" for a
// store the exit then crash-loops on. Egress tables are compiled at boot, so
// key check compiles them too.
func TestKeyCheckRefusesAStoreBootRefuses(t *testing.T) {
	for _, block := range []string{
		`{"allowCidrs":["10.0.0.0/33"]}`, // prefix length out of range
		`{"ports":[0]}`,                  // no such port
		`{"allowCidrs":["not-a-cidr"]}`,
	} {
		t.Run(block, func(t *testing.T) {
			store := newTestStore(t)
			store.write(t, "relay.json", fmt.Sprintf(`{"endpoint":"wss://exit.example:8443/vpn","exit":[{"name":"exit-home","public":"%s"}]}`, store.public))
			store.write(t, "exit.json", fmt.Sprintf(`{"relays":[{"name":"relay_bazzite","public":"%s"}],"egress":%s}`, store.public, block))
			if _, err := checkStore(store.root); err == nil {
				t.Fatalf("key check accepted %s, which boot refuses", block)
			}
			// And the boot path refuses it too, so the two agree: the exit
			// compiles the table in enableTunnel, which is the step that
			// would otherwise crash-loop after this gate said ok.
			t.Setenv("XDG_DATA_HOME", filepath.Dir(store.root))
			if err := (&server{}).enableTunnel(); err == nil {
				t.Fatal("enableTunnel accepted an invalid egress table")
			}
		})
	}
}

// TestStoreRootNamesItsCause: an unresolvable root reports why, per role,
// instead of a bare "store : stat :".
func TestStoreRootNamesItsCause(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("XDG_DATA_HOME", "")
	if _, err := storeRoot(); err == nil {
		t.Fatal("storeRoot resolved without HOME or XDG_DATA_HOME")
	}
	_, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t), relaySelection{}, false, true)
	if err == nil || !strings.Contains(err.Error(), "$HOME") {
		t.Fatalf("relay boot error = %v, want it to name the unresolvable root", err)
	}
	s := &server{}
	err = s.enableTunnel()
	if err == nil || !strings.Contains(err.Error(), "$HOME") {
		t.Fatalf("exit boot error = %v, want it to name the unresolvable root", err)
	}
}
