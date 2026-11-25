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
	role, peers, err := checkStore(resolved)
	if err != nil {
		log.Fatalf("[estige] key check: %v", err)
	}
	fmt.Printf("[estige] key check: %s store ok (%d pinned peer(s))\n", role, peers)
}

// checkStore validates whichever role files exist. A dual-role host carries
// both; one file is enough for a single-role host.
func checkStore(root string) (string, int, error) {
	relayPath := filepath.Join(root, "relay.json")
	exitPath := filepath.Join(root, "exit.json")
	_, relayErr := os.Stat(relayPath)
	_, exitErr := os.Stat(exitPath)
	if errors.Is(relayErr, os.ErrNotExist) && errors.Is(exitErr, os.ErrNotExist) {
		return "", 0, fmt.Errorf("%s holds neither relay.json nor exit.json", root)
	}
	var summary string
	var peers int
	if relayErr == nil {
		store, err := loadRelayStore(root)
		if err != nil {
			return "", 0, err
		}
		summary, peers = roleRelay, len(store.Exits)
	}
	if exitErr == nil {
		store, err := loadExitStore(root)
		if err != nil {
			return "", 0, err
		}
		summary, peers = roleExit, len(store.Relays)
	}
	return summary, peers, nil
}
