package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testStore struct {
	root      string
	principal string
	private   ed25519.PrivateKey
	public    string
}

func newTestStore(t *testing.T) testStore {
	t.Helper()
	root := filepath.Join(t.TempDir(), "estige")
	if err := os.MkdirAll(filepath.Join(root, "prv"), storeDirPerm); err != nil {
		t.Fatal(err)
	}
	priv := testHostKey(t)
	der, err := mintPrincipalCertificate(priv, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "prv", "exit-home.der")
	if err := writePrivateKey(path, keyDER, false); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "prv", "exit-home.crt"), der, storePrivPerm); err != nil {
		t.Fatal(err)
	}
	return testStore{root: root, principal: "exit-home", private: priv, public: encodeEPub(der)}
}

func (s testStore) write(t *testing.T, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(s.root, name), []byte(body), storePrivPerm); err != nil {
		t.Fatal(err)
	}
}

func TestLoadRelayStore(t *testing.T) {
	store := newTestStore(t)
	store.write(t, "relay.json", fmt.Sprintf(`{"endpoint":"https://exit.example:8443/vpn","exit":[{"name":"exit-home","public":"%s"}]}`, store.public))
	loaded, err := loadRelayStore(store.root)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Principal != "exit-home" || len(loaded.Exits) != 1 {
		t.Fatalf("store = %+v", loaded)
	}
	if loaded.Endpoint == nil || loaded.Endpoint.Host != "exit.example:8443" || loaded.Endpoint.Path != "/vpn" {
		t.Fatalf("endpoint = %+v", loaded.Endpoint)
	}
	if loaded.Exits[0].Cert == nil {
		t.Fatalf("exit entry = %+v", loaded.Exits[0])
	}
	if string(loaded.Private) != string(store.private) {
		t.Fatal("private key did not survive the load")
	}
}

func TestLoadExitStoreStagedNames(t *testing.T) {
	store := newTestStore(t)
	store.write(t, "exit.json", fmt.Sprintf(`{"relays":[{"name":"relay_bazzite","public":"%s"},{"name":"relay_bazzite","public":"%s"},{"name":"relay_laptop","public":"%s"}]}`, store.public, store.public, store.public))
	loaded, err := loadExitStore(store.root)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Relays) != 3 || loaded.Relays[0].Name != "relay_bazzite" || loaded.Relays[2].Name != "relay_laptop" {
		t.Fatalf("relays = %+v", loaded.Relays)
	}
}

func TestStoreRefusals(t *testing.T) {
	base := newTestStore(t)
	goodRelay := fmt.Sprintf(`{"endpoint":"https://exit.example:8443/vpn","exit":[{"name":"exit-home","public":"%s"}]}`, base.public)
	cases := []struct {
		name  string
		file  string
		body  string
		setup func(*testing.T, string)
	}{
		{"unknown field", "relay.json", strings.Replace(goodRelay, "{", `{"extra":1,`, 1), nil},
		{"empty exit", "relay.json", `{"exit":[]}`, nil},
		{"bad public", "exit.json", `{"relays":[{"name":"relay_bazzite","public":"bad"}]}`, nil},
		{"missing endpoint", "relay.json", strings.Replace(goodRelay, `"endpoint":"https://exit.example:8443/vpn",`, ``, 1), nil},
		{"three staged", "exit.json", fmt.Sprintf(`{"relays":[{"name":"relay_bazzite","public":"%s"},{"name":"relay_bazzite","public":"%s"},{"name":"relay_bazzite","public":"%s"}]}`, base.public, base.public, base.public), nil},
		{"loose store", "relay.json", goodRelay, func(_ *testing.T, root string) { _ = os.Chmod(root, 0o755) }},
		{"loose key", "relay.json", goodRelay, func(_ *testing.T, root string) { _ = os.Chmod(filepath.Join(root, "prv", "exit-home.der"), 0o644) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newTestStore(t)
			if tc.setup != nil {
				tc.setup(t, store.root)
			}
			store.write(t, tc.file, tc.body)
			var err error
			if tc.file == "exit.json" {
				_, err = loadExitStore(store.root)
			} else {
				_, err = loadRelayStore(store.root)
			}
			if err == nil {
				t.Fatal("invalid store accepted")
			}
		})
	}
}

func TestStoreRequiresHelper(t *testing.T) {
	store := newTestStore(t)
	if _, err := loadRelayStore(store.root); err == nil {
		t.Fatal("missing relay.json accepted")
	}
}

// TestStagedExitRowsShareOnePolicy: two rows under one name are a key
// rotation, so they must agree on egress — admission trusts both certificates
// but a session runs under one table, and letting the rows differ would make
// row order decide policy. Different principals may differ freely.
func TestStagedExitRowsShareOnePolicy(t *testing.T) {
	two := func(first, second string) string {
		return fmt.Sprintf(`{"relays":[{"name":"relay_bazzite","public":"%s"%s},{"name":"relay_bazzite","public":"%s"%s}],"egress":{"ports":[443]}}`,
			testV5CertDERForTest(), first, testV5CertDERForTest(), second)
	}
	const (
		narrow    = `,"egress":{"ports":[443]}`
		none      = ""
		reordered = `,"egress":{"ports":[443],"allowCidrs":["10.0.0.0/8"]}`
		withCIDR  = `,"egress":{"allowCidrs":["10.0.0.0/8"],"ports":[443]}`
	)
	cases := []struct {
		name    string
		body    string
		wantErr bool
	}{
		{"both rows carry the same table", two(narrow, narrow), false},
		{"one row omits the table", two(narrow, none), true},
		{"the tables differ", two(narrow, `,"egress":{"ports":[80]}`), true},
		{"the same table spelled in another order", two(reordered, withCIDR), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newTestStore(t)
			store.write(t, "exit.json", tc.body)
			_, err := loadExitStore(store.root)
			if tc.wantErr && err == nil {
				t.Fatal("staged rows with different egress were accepted")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("valid staged rows refused: %v", err)
			}
		})
	}
}

// testV5CertDERForTest is the suite certificate in the store's wire spelling.
func testV5CertDERForTest() string { return encodeEPub(testV5CertDER) }
