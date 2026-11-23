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
	store.write(t, "relay.json", fmt.Sprintf(`{"exit":[{"endpoint":"https://exit.example:8443/vpn","name":"exit-home","public":"%s"}]}`, store.public))
	loaded, err := loadRelayStore(store.root)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Principal != "exit-home" || len(loaded.Exits) != 1 {
		t.Fatalf("store = %+v", loaded)
	}
	if loaded.Exits[0].Endpoint != "https://exit.example:8443/vpn" || loaded.Exits[0].Cert == nil {
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
	goodRelay := fmt.Sprintf(`{"exit":[{"endpoint":"https://exit.example:8443/vpn","name":"exit-home","public":"%s"}]}`, base.public)
	cases := []struct {
		name  string
		file  string
		body  string
		setup func(*testing.T, string)
	}{
		{"unknown field", "relay.json", strings.Replace(goodRelay, `{"exit"`, `{"extra":1,"exit"`, 1), nil},
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
