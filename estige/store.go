// store.go — the v5 role stores, the whole config surface (d236).
//
// WHY the helpers are read only here: one parser owns the store grammar, so
// boot and validation cannot disagree about what a trusted entry means, and
// the credential has exactly one home (VPN-R32). Nothing secret is left in the
// environment: the store carries the identity, the pairing and the policy, and
// env keeps only non-secret runtime knobs (d132/d236).
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
	"slices"
	"strings"
)

// storeRoot resolves the store directory a role reads. The error is returned
// rather than folded into an empty path: an unresolvable root ($HOME and
// XDG_DATA_HOME both unset) is the cause of a failed boot, and a bare
// "store : stat :" hides the step that owns it (d045's cause-chain rule).
func storeRoot() (string, error) {
	return resolveStoreDir("")
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

type relayPeerEntry struct {
	storeKeyEntry
	// Egress narrows this principal's target set (d078). Absent means the
	// relay.json-level table applies, which is what a store without per-relay
	// policy has always meant.
	Egress *egressConfig `json:"egress,omitempty"`
}

type relayStore struct {
	Root      string
	Principal string
	Private   ed25519.PrivateKey
	SelfDER   []byte
	// Endpoint is the one place a relay learns where to dial (d132): the
	// pairing line is endpoint ↔ principal ↔ pinned certificate, so the URL
	// cannot desync from the key it was provisioned with.
	Endpoint *url.URL
	Exits    []storeKeyEntry
}

type exitStore struct {
	Root      string
	Principal string
	Private   ed25519.PrivateKey
	SelfDER   []byte
	Relays    []relayPeerEntry
	// Egress is the process policy (VPN-R38). Zero means the requirement's
	// defaults — a store that says nothing about egress configures nothing.
	Egress egressConfig
}

// loadRelayStore reads the relay role: one host identity, the endpoint to
// dial, and the exit certificate(s) it expects. Two rows may share a name —
// the staged-rotation overlap (d133) — and any of them verifies.
func loadRelayStore(root string) (*relayStore, error) {
	principal, priv, selfDER, err := loadStoreIdentity(root)
	if err != nil {
		return nil, err
	}
	var file struct {
		Endpoint string          `json:"endpoint"`
		Exit     []storeKeyEntry `json:"exit"`
	}
	if err := readStoreJSON(root, "relay.json", &file); err != nil {
		return nil, err
	}
	endpoint, err := parseStoreEndpoint(file.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("relay.json: %w", err)
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
		cert, _, err := parseEPubHeader([]string{entry.Public})
		if err != nil {
			return nil, fmt.Errorf("relay.json exit[%d]: %w", i, err)
		}
		entry.Cert = cert
	}
	if err := checkStagedNames(len(file.Exit), func(i int) string { return file.Exit[i].Name }); err != nil {
		return nil, fmt.Errorf("relay.json: %w", err)
	}
	return &relayStore{
		Root: root, Principal: principal, Private: priv, SelfDER: selfDER,
		Endpoint: endpoint, Exits: file.Exit,
	}, nil
}

// loadExitStore reads the exit role: one host identity, the admitted relays
// and the egress policy beside them.
func loadExitStore(root string) (*exitStore, error) {
	principal, priv, selfDER, err := loadStoreIdentity(root)
	if err != nil {
		return nil, err
	}
	var file struct {
		Relays []struct {
			storeKeyEntry
			Egress json.RawMessage `json:"egress"`
		} `json:"relays"`
		Egress json.RawMessage `json:"egress"`
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
	relays := make([]relayPeerEntry, 0, len(file.Relays))
	for i := range file.Relays {
		raw := &file.Relays[i]
		if err := validPrincipal(raw.Name); err != nil {
			return nil, fmt.Errorf("exit.json relays[%d]: %w", i, err)
		}
		cert, _, err := parseEPubHeader([]string{raw.Public})
		if err != nil {
			return nil, fmt.Errorf("exit.json relays[%d]: %w", i, err)
		}
		var entry relayPeerEntry
		entry.Name = raw.Name
		entry.Public = raw.Public
		entry.Cert = cert
		if len(raw.Egress) > 0 {
			cfg, err := parseEgressConfig(string(raw.Egress), fmt.Sprintf("exit.json relays[%d].egress", i))
			if err != nil {
				return nil, err
			}
			entry.Egress = &cfg
		}
		relays = append(relays, entry)
	}
	if err := checkStagedNames(len(relays), func(i int) string { return relays[i].Name }); err != nil {
		return nil, fmt.Errorf("exit.json: %w", err)
	}
	if err := checkStagedEgress(relays); err != nil {
		return nil, fmt.Errorf("exit.json: %w", err)
	}
	var policy egressConfig
	if len(file.Egress) > 0 {
		policy, err = parseEgressConfig(string(file.Egress), "exit.json egress")
		if err != nil {
			return nil, err
		}
	}
	return &exitStore{
		Root: root, Principal: principal, Private: priv, SelfDER: selfDER,
		Relays: relays, Egress: policy,
	}, nil
}

// selectExit resolves the exit a relay pins: the row name (the peer's
// security principal), every certificate stored under that name — a staged
// rotation overlaps two rows and either may be presented (d133) — and nothing
// else. An empty name means the store's first row, which is the only place
// row order is special (d236).
func (s *relayStore) selectExit(name string) (string, []*x509.Certificate, error) {
	if name == "" {
		name = s.Exits[0].Name
	}
	var certs []*x509.Certificate
	for _, row := range s.Exits {
		if row.Name == name {
			certs = append(certs, row.Cert)
		}
	}
	if len(certs) == 0 {
		return "", nil, fmt.Errorf("relay.json pins no exit named %q", name)
	}
	return name, certs, nil
}

// parseStoreEndpoint normalizes the store's dial URL the way the env spelling
// was normalized once: the URL's honest wire form is accepted (http/https/ws/
// wss) and becomes the canonical ws/wss every carrier branches on. A cleartext
// URL is a degraded posture the operator must state at boot (-insecure-exit),
// and userinfo is refused because a credential has no second home (VPN-R32).
func parseStoreEndpoint(raw string) (*url.URL, error) {
	if raw == "" {
		return nil, errors.New("endpoint is empty")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("endpoint: %w", err)
	}
	switch u.Scheme {
	case schemeHTTP, schemeWS:
		u.Scheme = schemeWS
	case schemeHTTPS, schemeWSS:
		u.Scheme = schemeWSS
	default:
		return nil, fmt.Errorf("endpoint must be http://, https://, ws:// or wss://, got %q", u.Scheme)
	}
	if u.Host == "" || u.Path == "" {
		return nil, errors.New("endpoint must include host and path (d073 §7)")
	}
	if u.User != nil {
		return nil, errors.New("endpoint must not carry credentials; the store holds the identity (VPN-R32)")
	}
	return u, nil
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

// checkStagedEgress refuses a staged pair whose egress tables disagree.
// Admission trusts every row under one name, but a principal has ONE policy
// (a session is admitted by either certificate and then runs under one table),
// so two spellings of that table would make row order decide policy. Rows that
// say the same thing are accepted; rows that differ are a config error, not a
// merge (d132's preference: disruptive, never insecure).
func checkStagedEgress(relays []relayPeerEntry) error {
	byName := make(map[string]*egressConfig, len(relays))
	for i := range relays {
		first, staged := byName[relays[i].Name]
		if !staged {
			byName[relays[i].Name] = relays[i].Egress
			continue
		}
		if !sameEgress(first, relays[i].Egress) {
			return fmt.Errorf("%s has staged rows with different egress: one principal runs under one policy", relays[i].Name)
		}
	}
	return nil
}

// sameEgress compares two optional tables by meaning, not spelling: the CIDR
// and port lists are sets, so their order is not a difference.
func sameEgress(a, b *egressConfig) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if a.AllowIPLiterals != b.AllowIPLiterals {
		return false
	}
	cidrsA, cidrsB := slices.Clone(a.AllowCidrs), slices.Clone(b.AllowCidrs)
	portsA, portsB := slices.Clone(a.Ports), slices.Clone(b.Ports)
	slices.Sort(cidrsA)
	slices.Sort(cidrsB)
	slices.Sort(portsA)
	slices.Sort(portsB)
	return slices.Equal(cidrsA, cidrsB) && slices.Equal(portsA, portsB)
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
