// store.go — the strict v5 role stores (d236).
//
// WHY the helpers are read only here: one parser owns the store grammar, so
// boot and validation cannot disagree about what a trusted entry means.
package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func storeRoot() string {
	root, err := resolveStoreDir("")
	if err != nil {
		return ""
	}
	return root
}

const (
	storeDirPerm   os.FileMode = 0o700
	storePrivPerm  os.FileMode = 0o600
	maxStorePeers              = 32
	maxStagedNames             = 2
)

type storeKeyEntry struct {
	Name   string            `json:"name"`
	Public string            `json:"public"`
	Cert   *x509.Certificate `json:"-"`
}

type relayExitEntry struct {
	Endpoint string `json:"endpoint"`
	storeKeyEntry
}

type relayStore struct {
	Root      string
	Principal string
	Private   ed25519.PrivateKey
	SelfDER   []byte
	Exits     []relayExitEntry
}

type exitStore struct {
	Root      string
	Principal string
	Private   ed25519.PrivateKey
	SelfDER   []byte
	Relays    []storeKeyEntry
}

func loadRelayStore(root string) (*relayStore, error) {
	principal, priv, selfDER, err := loadStoreIdentity(root)
	if err != nil {
		return nil, err
	}
	var file struct {
		Exit []relayExitEntry `json:"exit"`
	}
	if err := readStoreJSON(root, "relay.json", &file); err != nil {
		return nil, err
	}
	if len(file.Exit) == 0 {
		return nil, errors.New("relay.json names no exit")
	}
	if len(file.Exit) > maxStorePeers {
		return nil, fmt.Errorf("relay.json has %d exits, cap %d", len(file.Exit), maxStorePeers)
	}
	for i := range file.Exit {
		entry := &file.Exit[i]
		if err := validPrincipal(entry.Name); err != nil {
			return nil, fmt.Errorf("relay.json exit[%d]: %w", i, err)
		}
		if entry.Endpoint == "" {
			return nil, fmt.Errorf("relay.json exit[%d]: endpoint is empty", i)
		}
		u, err := url.Parse(entry.Endpoint)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return nil, fmt.Errorf("relay.json exit[%d]: endpoint is not a URL", i)
		}
		cert, _, err := parseEPubHeader([]string{entry.Public})
		if err != nil {
			return nil, fmt.Errorf("relay.json exit[%d]: %w", i, err)
		}
		entry.Cert = cert
	}
	if err := checkStagedNames(len(file.Exit), func(i int) string { return file.Exit[i].Name }); err != nil {
		return nil, fmt.Errorf("relay.json: %w", err)
	}
	return &relayStore{Root: root, Principal: principal, Private: priv, SelfDER: selfDER, Exits: file.Exit}, nil
}

func loadExitStore(root string) (*exitStore, error) {
	principal, priv, selfDER, err := loadStoreIdentity(root)
	if err != nil {
		return nil, err
	}
	var file struct {
		Relays []storeKeyEntry `json:"relays"`
	}
	if err := readStoreJSON(root, "exit.json", &file); err != nil {
		return nil, err
	}
	if len(file.Relays) == 0 {
		return nil, errors.New("exit.json admits no relay")
	}
	if len(file.Relays) > maxStorePeers {
		return nil, fmt.Errorf("exit.json has %d relays, cap %d", len(file.Relays), maxStorePeers)
	}
	for i := range file.Relays {
		entry := &file.Relays[i]
		if err := validPrincipal(entry.Name); err != nil {
			return nil, fmt.Errorf("exit.json relays[%d]: %w", i, err)
		}
		cert, _, err := parseEPubHeader([]string{entry.Public})
		if err != nil {
			return nil, fmt.Errorf("exit.json relays[%d]: %w", i, err)
		}
		entry.Cert = cert
	}
	if err := checkStagedNames(len(file.Relays), func(i int) string { return file.Relays[i].Name }); err != nil {
		return nil, fmt.Errorf("exit.json: %w", err)
	}
	return &exitStore{Root: root, Principal: principal, Private: priv, SelfDER: selfDER, Relays: file.Relays}, nil
}

func checkStagedNames(n int, name func(int) string) error {
	counts := make(map[string]int, n)
	for i := range n {
		counts[name(i)]++
		if counts[name(i)] > maxStagedNames {
			return fmt.Errorf("%s has more than %d entries", name(i), maxStagedNames)
		}
	}
	return nil
}

func readStoreJSON(root, name string, out any) error {
	path := filepath.Join(root, name)
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%s has trailing content", path)
	}
	return nil
}

func loadStoreIdentity(root string) (string, ed25519.PrivateKey, []byte, error) {
	info, err := os.Stat(root)
	if err != nil {
		return "", nil, nil, fmt.Errorf("store %s: %w", root, err)
	}
	if !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return "", nil, nil, fmt.Errorf("store %s must be a directory with mode 0700", root)
	}
	prvDir := filepath.Join(root, "prv")
	entries, err := os.ReadDir(prvDir)
	if err != nil {
		return "", nil, nil, fmt.Errorf("%s: %w", prvDir, err)
	}
	var keyPath string
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".der" {
			continue
		}
		if keyPath != "" {
			return "", nil, nil, fmt.Errorf("%s holds more than one host key", prvDir)
		}
		keyPath = filepath.Join(prvDir, entry.Name())
	}
	if keyPath == "" {
		return "", nil, nil, fmt.Errorf("%s holds no host key", prvDir)
	}
	info, err = os.Stat(keyPath)
	if err != nil {
		return "", nil, nil, err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return "", nil, nil, fmt.Errorf("%s is group- or world-readable", keyPath)
	}
	der, err := os.ReadFile(keyPath)
	if err != nil {
		return "", nil, nil, err
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return "", nil, nil, fmt.Errorf("%s: %w", keyPath, err)
	}
	priv, ok := parsed.(ed25519.PrivateKey)
	if !ok || len(priv) != ed25519.PrivateKeySize {
		return "", nil, nil, fmt.Errorf("%s does not hold a PKCS#8 Ed25519 key", keyPath)
	}
	principal := strings.TrimSuffix(filepath.Base(keyPath), ".der")
	if err := validPrincipal(principal); err != nil {
		return "", nil, nil, fmt.Errorf("%s: %w", keyPath, err)
	}
	certPath := filepath.Join(prvDir, principal+keygenCertSuffix)
	certDER, err := os.ReadFile(certPath)
	if err != nil {
		return "", nil, nil, fmt.Errorf("%s: %w", certPath, err)
	}
	cert, err := parsePrincipalCertificate(certDER)
	if err != nil {
		return "", nil, nil, fmt.Errorf("%s: %w", certPath, err)
	}
	certPub, ok := cert.PublicKey.(ed25519.PublicKey)
	wantPub, pubOK := priv.Public().(ed25519.PublicKey)
	if !ok || !pubOK || !certPub.Equal(wantPub) {
		return "", nil, nil, fmt.Errorf("%s does not carry this host key", certPath)
	}
	return principal, priv, certDER, nil
}
