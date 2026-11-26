// check.go — estige key check: the pre-boot gate on the role stores (d104/d236).
//
// WHY loading is the check: boot and validation must agree on what a trusted
// row means, so this verb calls the same strict loaders the two roles use.
package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

func runKeyCheck(args []string) {
	log.SetFlags(0)
	fs := flag.NewFlagSet("key check", flag.ExitOnError)
	dir := fs.String("dir", "", "store root (default $XDG_DATA_HOME/estige or ~/.local/share/estige)")
	_ = fs.Parse(args)
	resolved, err := resolveStoreDir(*dir)
	if err != nil {
		log.Fatalf("[estige] key check: %v", err)
	}
	summary, err := checkStore(resolved)
	if err != nil {
		log.Fatalf("[estige] key check: %v", err)
	}
	fmt.Printf("[estige] key check: %s store ok (%s)\n", resolved, summary)
}

// checkStore validates whichever role files exist. A dual-role host carries
// both; one file is enough for a single-role host. It reports every role it
// loaded, so a dual-role host does not read as if only one had been checked.
//
// WHY it builds the policies and not just the stores: enableTunnel turns every
// egress table into a compiled policy, and that is where a bad CIDR or a zero
// port is refused. A gate that only parsed the JSON would say "ok" for a store
// whose exit then crash-loops at boot — the one answer a pre-enable check must
// never give.
func checkStore(root string) (string, error) {
	relayPath := filepath.Join(root, "relay.json")
	exitPath := filepath.Join(root, "exit.json")
	_, relayErr := os.Stat(relayPath)
	_, exitErr := os.Stat(exitPath)
	if errors.Is(relayErr, os.ErrNotExist) && errors.Is(exitErr, os.ErrNotExist) {
		return "", fmt.Errorf("%s holds neither relay.json nor exit.json", root)
	}
	var reports []string
	if relayErr == nil {
		store, err := loadRelayStore(root)
		if err != nil {
			return "", err
		}
		reports = append(reports, fmt.Sprintf("%s: %d pinned exit(s)", roleRelay, len(store.Exits)))
	}
	if exitErr == nil {
		store, err := loadExitStore(root)
		if err != nil {
			return "", err
		}
		if _, err := newEgressPolicy(store.Egress); err != nil {
			return "", fmt.Errorf("exit.json egress: %w", err)
		}
		for _, entry := range store.Relays {
			if entry.Egress == nil {
				continue
			}
			if _, err := newEgressPolicy(*entry.Egress); err != nil {
				return "", fmt.Errorf("exit.json relay %q egress: %w", entry.Name, err)
			}
		}
		reports = append(reports, fmt.Sprintf("%s: %d admitted relay(s)", roleExit, len(store.Relays)))
	}
	return strings.Join(reports, "; "), nil
}
