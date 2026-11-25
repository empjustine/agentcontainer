// keygen.go — estige keygen: the host identity's key material (d132/d236).
//
// WHY the certificate is derived at mint time: d236 pins the certificate, not
// the bare key, so the {name, public} entry an operator pastes into a peer's
// store is the certificate's DER. The private key is the durable fact and the
// only file that never leaves the host (VPN-R32); a re-mint is a pin change.
//
// WHY the private file is named for the principal (d132's identity rule): the
// basename is the security principal a peer's store names, so there is one
// spelling per identity and no config field can desync it. The wire name is a
// fixed neutral constant so the SNI discloses nothing (d236).
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"
)

const (
	keygenPrvDirName = "prv"
	keygenPrivSuffix = ".der"
	keygenCertSuffix = ".crt"
	keygenDirPerm    = 0o700
	keygenPrivPerm   = 0o600
	// principalMaxLen is d132's name grammar upper bound for disk and wire
	// principals; the certificate's SAN is the fixed d236 wire name.
	principalMaxLen = 64
)

// principalEntry is d132's key entry — the one fact cluster both helpers hold,
// {"name", "public"} — so the JSON printed here pastes into a relay.json exit
// array or an exit.json relays array without translation.
type principalEntry struct {
	Name   string `json:"name"`
	Public string `json:"public"`
}

// runKeygen is the estige keygen verb: resolve the two host facts (the store
// root and the principal), mint one identity, and print its config entry as
// JSON on stdout. Human notes go to stderr, so a pipeline can consume stdout
// unchanged.
func runKeygen(args []string) {
	log.SetFlags(0)
	fs := flag.NewFlagSet("keygen", flag.ExitOnError)
	dir := fs.String("dir", "", "store root (default $XDG_DATA_HOME/estige or ~/.local/share/estige)")
	principal := fs.String("principal", "", "this host's security principal (default the OS hostname)")
	force := fs.Bool("force", false, "overwrite the existing private key")
	_ = fs.Parse(args)

	resolvedDir, err := resolveStoreDir(*dir)
	if err != nil {
		log.Fatalf("[estige] keygen: %v", err)
	}
	resolvedPrincipal, err := resolvePrincipal(*principal)
	if err != nil {
		log.Fatalf("[estige] keygen: %v", err)
	}

	privPath, entry, fingerprint, err := keygen(resolvedDir, resolvedPrincipal, *force)
	if err != nil {
		log.Fatalf("[estige] keygen: %v", err)
	}
	log.Printf("[estige] keygen: wrote %s (fingerprint %s)", privPath, fingerprint)
	writePrincipalEntry(entry)
}

// keygen mints one Ed25519 identity and returns the private path plus the
// config entry the caller prints.
func keygen(dir, principal string, force bool) (privPath string, entry principalEntry, fingerprint string, err error) {
	if err := validPrincipal(principal); err != nil {
		return "", principalEntry{}, "", err
	}
	prvDir := filepath.Join(dir, keygenPrvDirName)
	if err := os.MkdirAll(prvDir, keygenDirPerm); err != nil {
		return "", principalEntry{}, "", err
	}
	// WHY chmod over the umask: MkdirAll's mode only ever loses bits to the
	// umask, so a pre-existing group- or world-accessible prv/ would keep its
	// wider mode and hold the key, which docs/d132 forbids. The chmod
	// re-asserts the 0700 the store contract needs.
	if err := os.Chmod(prvDir, keygenDirPerm); err != nil {
		return "", principalEntry{}, "", err
	}

	privPath = filepath.Join(prvDir, principal+keygenPrivSuffix)

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", principalEntry{}, "", err
	}
	certDER, err := mintPrincipalCertificate(priv, time.Now())
	if err != nil {
		return "", principalEntry{}, "", err
	}
	// Build the entry before touching the disk: a failure after the key lands
	// would leave an identity the operator has no printed record of.
	entry = principalEntryForCert(principal, certDER)
	privDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", principalEntry{}, "", err
	}
	if err := writePrivateKey(privPath, privDER, force); err != nil {
		return "", principalEntry{}, "", err
	}
	certPath := filepath.Join(prvDir, principal+keygenCertSuffix)
	if err := os.WriteFile(certPath, certDER, keygenPrivPerm); err != nil {
		return "", principalEntry{}, "", err
	}
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return "", principalEntry{}, "", errors.New("host key does not yield an Ed25519 public key")
	}
	return privPath, entry, principalFingerprint(pub), nil
}

// principalEntryForCert builds the {name, public} row. d236 pins the host
// certificate, so public is its DER in one line of unpadded base64url — no
// PEM armor and no wrapping, which would hide a scalar line break in JSON.
func principalEntryForCert(name string, certDER []byte) principalEntry {
	return principalEntry{Name: name, Public: encodeEPub(certDER)}
}

// writePrincipalEntry prints the entry as indented JSON, which is what the
// operator pastes into a helper.
func writePrincipalEntry(entry principalEntry) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(entry); err != nil {
		log.Fatalf("[estige] encoding the key entry: %v", err)
	}
}

// principalFingerprint is d132's out-of-band check: SHA256: plus base64url of
// SHA-256 over the raw 32-byte public key, encoding-independent so the same
// key has one fingerprint however it was imported.
func principalFingerprint(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return "SHA256:" + base64.RawURLEncoding.EncodeToString(sum[:])
}

// writePrivateKey creates the private key with O_EXCL so an existing identity
// is never silently replaced — rotate, don't move (docs/d132) — unless the
// operator asked with -force.
func writePrivateKey(path string, der []byte, force bool) error {
	flags := os.O_WRONLY | os.O_CREATE | os.O_EXCL
	if force {
		flags = os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, keygenPrivPerm)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("%s exists; pass -force to replace it (rotate, don't move)", path)
		}
		return err
	}
	// WHY before the write: -force reuses an existing file, and O_TRUNC leaves
	// its mode alone. Narrowing first means the new key is never briefly
	// readable at the old file's permissions.
	if err := f.Chmod(keygenPrivPerm); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return err
	}
	if _, err := f.Write(der); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	// Belt and braces: the chmod above already narrowed the open file, and a
	// final one leaves no dependence on that ordering.
	return os.Chmod(path, keygenPrivPerm)
}

// resolveStoreDir applies d132's XDG rule so keygen never invents a second
// store location: XDG_DATA_HOME/estige when set, else ~/.local/share/estige.
func resolveStoreDir(dir string) (string, error) {
	if dir != "" {
		return dir, nil
	}
	if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
		return filepath.Join(xdg, "estige"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot resolve $HOME: %w", err)
	}
	return filepath.Join(home, ".local", "share", "estige"), nil
}

// resolvePrincipal defaults to the OS hostname but refuses a name the wire
// grammar would reject rather than silently rewriting it (docs/d132): a
// hostname carrying dots or an exotic character is passed through unchanged,
// and the operator is sent to -principal to choose one deliberately.
func resolvePrincipal(principal string) (string, error) {
	if principal == "" {
		h, err := os.Hostname()
		if err != nil || h == "" {
			return "", errors.New("cannot resolve the hostname; pass -principal")
		}
		principal = h
	}
	if err := validPrincipal(principal); err != nil {
		return "", err
	}
	return principal, nil
}

// validPrincipal is d132's name grammar, shared by every spelling of a
// principal: [A-Za-z0-9_-]{1,64}. The certificate SAN and ServerName reuse it
// (docs/d169), so disk, wire and certificate agree by construction.
func validPrincipal(name string) error {
	if len(name) == 0 || len(name) > principalMaxLen {
		return fmt.Errorf("principal %q must be 1..%d characters", name, principalMaxLen)
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return fmt.Errorf("principal %q has a character outside [A-Za-z0-9_-]", name)
		}
	}
	return nil
}
