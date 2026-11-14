// keygen.go — estige keygen: the host identity's key material (docs/d169).
//
// WHY a bare key pair and no certificate yet: d169 roots each host in a
// self-signed CA certificate over this key, and the certificate is *derived*
// material — the key is the durable fact, the certificate can be re-minted
// from it at boot. Keeping them apart keeps the one file that must never
// leave the host (VPN-R32) separate from the one that is public by
// definition.
//
// WHY the private file is named for the principal (docs/d132's identity
// rule): the basename IS the security principal — the name a peer sees as
// the certificate SAN and dials as ServerName (docs/d169) — so there is one
// spelling from disk to wire and no config field can desync it. The public
// half has no file: it is the {"name","public"} entry a relay.json exit
// array or an exit.json relays array holds, printed by keygen and by estige
// public.
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
)

const (
	keygenPrvDirName = "prv"
	keygenPrivSuffix = ".der"
	keygenDirPerm    = 0o700
	keygenPrivPerm   = 0o600
	// principalMaxLen is d132's name grammar upper bound; the certificate SAN
	// and ServerName reuse the same string (docs/d169).
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

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", principalEntry{}, "", err
	}
	// Build the entry before touching the disk: a failure after the private
	// key lands would leave an identity the operator has no printed record of.
	entry, err = encodePrincipalEntry(principal, pub)
	if err != nil {
		return "", principalEntry{}, "", err
	}
	privDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", principalEntry{}, "", err
	}
	if err := writePrivateKey(privPath, privDER, force); err != nil {
		return "", principalEntry{}, "", err
	}
	return privPath, entry, principalFingerprint(pub), nil
}

// encodePrincipalEntry builds the {name, public} fact cluster. The public
// value is the SPKI DER in ONE line of unpadded base64url — no PEM armor, no
// 72-column wrapping, nothing an SSH tool would claim — so it drops into JSON
// without escapes and without a scalar hiding line breaks (docs/d132). It is
// 44 bytes for Ed25519, 59 base64url characters.
func encodePrincipalEntry(name string, pub ed25519.PublicKey) (principalEntry, error) {
	spki, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return principalEntry{}, err
	}
	return principalEntry{Name: name, Public: base64.RawURLEncoding.EncodeToString(spki)}, nil
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
	if _, err := f.Write(der); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	// WHY chmod after write: -force reuses an existing file, and O_TRUNC does
	// not reset its mode — a key rotated over a file that had lost its 0600
	// must come back at 0600.
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
