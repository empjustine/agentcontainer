// keyset.go — docs/d078's principal set and docs/d078's per-key egress
// extension.
//
// WHY the value grammar is closed and strict: the keyset is a credential
// surface. A typo'd "allowCidr" or an unknown field would otherwise fall
// back to the default deny table while the operator believes a relay is
// admitted to a range — the same fail-loudly rule egressFromEnv already
// follows. A plain string keeps its v3 meaning (the token, inheriting the
// process egress), so an existing env file needs no edit.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// keyEntry is one parsed keyset value.
type keyEntry struct {
	token  string
	egress *egressConfig // nil: the process default (VPN_TUNNEL_EGRESS)
}

// parseKeyset decodes VPN_OPERATOR_KEYS into id → entry. Shape:
//
//	{"<id>": "<token>", "<id>": {"token": "<token>", "egress": {...}}}
//
// Duplicate ids are refused, never last-wins (docs/d078).
func parseKeyset(raw string) (map[string]keyEntry, error) {
	if raw == "" {
		return map[string]keyEntry{}, nil
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	open, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("%s is not a JSON object: %w", envOperatorKeys, err)
	}
	if delim, ok := open.(json.Delim); !ok || delim != '{' {
		return nil, fmt.Errorf("%s must be a JSON object {\"<id>\": \"<token>\"} (docs/d078/d078)", envOperatorKeys)
	}
	out := make(map[string]keyEntry)
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("%s: %w", envOperatorKeys, err)
		}
		id, ok := keyTok.(string)
		if !ok || !validOperatorID(id) {
			return nil, fmt.Errorf("%s id %v must be 1..64 chars of [A-Za-z0-9_-] — ids are log-safe labels (docs/d078)", envOperatorKeys, keyTok)
		}
		if _, dup := out[id]; dup {
			return nil, fmt.Errorf("%s repeats id %q: rejected, not last-wins (docs/d078)", envOperatorKeys, id)
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, fmt.Errorf("%s value for %q: %w", envOperatorKeys, id, err)
		}
		entry, err := parseKeyEntry(value)
		if err != nil {
			return nil, fmt.Errorf("%s key %q: %w", envOperatorKeys, id, err)
		}
		out[id] = entry
	}
	closeTok, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("%s is not a complete JSON object: %w", envOperatorKeys, err)
	}
	if closeTok != json.Delim('}') {
		return nil, fmt.Errorf("%s must be one JSON object, nothing else", envOperatorKeys)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%s has trailing content after the JSON object", envOperatorKeys)
	}
	return out, nil
}

func parseKeyEntry(raw json.RawMessage) (keyEntry, error) {
	if len(raw) > 0 && raw[0] == '"' {
		var token string
		if err := json.Unmarshal(raw, &token); err != nil {
			return keyEntry{}, err
		}
		return keyEntry{token: token}, nil
	}
	var spec struct {
		Token  string          `json:"token"`
		Egress json.RawMessage `json:"egress"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&spec); err != nil {
		return keyEntry{}, fmt.Errorf("must be a token string or {\"token\", \"egress\"}: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return keyEntry{}, errors.New("has content after the object")
	}
	if spec.Token == "" {
		return keyEntry{}, errors.New("object form requires a non-empty \"token\"")
	}
	entry := keyEntry{token: spec.Token}
	if len(spec.Egress) > 0 {
		cfg, err := parseEgressConfig(string(spec.Egress), "egress")
		if err != nil {
			return keyEntry{}, err
		}
		entry.egress = &cfg
	}
	return entry, nil
}

// parseEgressConfig is the one strict reader for an egress object, shared by
// VPN_TUNNEL_EGRESS and a per-key table (docs/d078): a second parser would
// be a second truth about what "empty" means.
func parseEgressConfig(raw, what string) (egressConfig, error) {
	var cfg egressConfig
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return egressConfig{}, fmt.Errorf("%s must be a JSON object {\"allowCidrs\": [\"10.0.0.0/8\"], \"ports\": [443]}: %w", what, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return egressConfig{}, fmt.Errorf("%s has content after the JSON object", what)
	}
	if len(cfg.AllowCidrs) == 0 && len(cfg.Ports) == 0 && !cfg.AllowIPLiterals {
		return egressConfig{}, fmt.Errorf("%s names neither a CIDR, a port nor the IP-exit switch", what)
	}
	return cfg, nil
}

// operatorKeysFromEnv builds the exit node's principal set — the only home
// credentials have (VPN-R32). Every failure refuses the tunnel rather than
// weakening it (NFR-2, VPN-R26).
func operatorKeysFromEnv() ([]operatorKey, error) {
	byID, err := parseKeyset(os.Getenv(envOperatorKeys))
	if err != nil {
		return nil, err
	}
	if len(byID) == 0 {
		if os.Getenv(envOperatorToken) != "" {
			return nil, fmt.Errorf("%s is the relay node's bearer; the exit node reads %s — the migration is zero-wire: set %s={\"default\": \"<the same token>\"} (docs/d090)", envOperatorToken, envOperatorKeys, envOperatorKeys)
		}
		return nil, fmt.Errorf("no operator credential: set %s (VPN-R26/R31 fail-closed)", envOperatorKeys)
	}
	if len(byID) > maxOperatorKeys {
		return nil, fmt.Errorf("%d operator keys exceed cap %d (docs/d078: a bounded set, not a user directory)", len(byID), maxOperatorKeys)
	}
	keys := make([]operatorKey, 0, len(byID))
	for id, entry := range byID {
		if len(entry.token) < 16 {
			return nil, fmt.Errorf("operator key %q shorter than 16 bytes (VPN-R26/R31 fail-closed)", id)
		}
		if !validOperatorToken(entry.token) {
			return nil, fmt.Errorf("operator key %q contains a control character: a bearer token may not carry header framing (RFC 9110 field-value; VPN-R26 fail-closed)", id)
		}
		key := operatorKey{id: id, token: entry.token}
		if entry.egress != nil {
			policy, err := newEgressPolicy(*entry.egress)
			if err != nil {
				return nil, fmt.Errorf("operator key %q egress: %w", id, err)
			}
			key.policy = policy
		}
		keys = append(keys, key)
	}
	return keys, nil
}
