// public.go — estige public: print the config entry for an existing host key
// (docs/d132/d169).
//
// The mirror of ssh-keygen -y: point it at a private key and it derives the
// public half. It answers the operator's second step — "I have my key, what
// do I hand the peer?" — as the same JSON keygen prints, so the value pastes
// into a relay.json exit array or an exit.json relays array without
// translation.
package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

func runPublic(args []string) {
	log.SetFlags(0)
	fs := flag.NewFlagSet("public", flag.ExitOnError)
	keyFile := fs.String("f", "", "private key file (PKCS#8 Ed25519 DER)")
	_ = fs.Parse(args)
	if *keyFile == "" {
		log.Fatalf("[estige] public: pass -f <private-key-file>")
	}
	entry, err := publicEntryFromKeyFile(*keyFile)
	if err != nil {
		log.Fatalf("[estige] public: %v", err)
	}
	writePrincipalEntry(entry)
}

// publicEntryFromKeyFile reads one PKCS#8 Ed25519 private key and derives its
// {name, public} entry. The principal is the file's basename minus .der, the
// same rule keygen names by (docs/d132), so deriving never needs a second
// field to say whose key it is.
func publicEntryFromKeyFile(path string) (principalEntry, error) {
	der, err := os.ReadFile(path)
	if err != nil {
		return principalEntry{}, err
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return principalEntry{}, fmt.Errorf("%s is not a PKCS#8 private key: %w", path, err)
	}
	priv, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return principalEntry{}, fmt.Errorf("%s does not hold an Ed25519 private key", path)
	}
	name := strings.TrimSuffix(filepath.Base(path), keygenPrivSuffix)
	if err := validPrincipal(name); err != nil {
		return principalEntry{}, fmt.Errorf("%s: %w", path, err)
	}
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return principalEntry{}, fmt.Errorf("%s does not yield an Ed25519 public key", path)
	}
	return encodePrincipalEntry(name, pub)
}
