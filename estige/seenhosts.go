// seenhosts.go — the untrusted certificate hint (d236).
//
// WHY this is a log event and not a file: a queue on disk would need rotation
// and would collect noise from peers that were never trusted. The line is a
// pasteable helper element; emitting it grants no trust.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

const eventSeenHosts = "seen_hosts"

// The hint is operator evidence, not an event log: a well-formed but
// unpublished certificate can be minted by anyone, and the exit's path is
// Funnel-public, so an unbounded event would cost one warn line with ~1.1 KB
// of attacker-chosen public material per request. The budget is therefore a
// total per window, not a per-peer one: no amount of distinguishable
// certificates can buy more than seenHostBudget lines a minute. The trade is
// stated in d236 — a prober can consume the budget and mute hints for the rest
// of the window, which is strictly better than an unbounded amplifier on a
// public path.
const (
	seenHostWindow = time.Minute
	seenHostBudget = 32
)

var seenHostRecent = struct {
	mu          sync.Mutex
	windowStart time.Time
	last        map[string]time.Time
}{last: make(map[string]time.Time, seenHostBudget)}

// resetSeenHosts forgets the window. It exists for tests that assert the hint
// IS emitted: the budget is process-global, so a repeat run of the same test
// (go test -count=2) would otherwise still be inside the first run's window.
func resetSeenHosts() {
	seenHostRecent.mu.Lock()
	defer seenHostRecent.mu.Unlock()
	seenHostRecent.windowStart = time.Time{}
	seenHostRecent.last = make(map[string]time.Time, seenHostBudget)
}

// seenHostSuppressed reports whether this peer's hint is already covered by
// the current window — logged before, or past the window's budget.
func seenHostSuppressed(role, name, public string) bool {
	key := role + "\x00" + name + "\x00" + public
	now := time.Now()
	seenHostRecent.mu.Lock()
	defer seenHostRecent.mu.Unlock()
	if now.Sub(seenHostRecent.windowStart) >= seenHostWindow {
		// A new window: the previous one's peers and its spent budget go.
		seenHostRecent.windowStart = now
		seenHostRecent.last = make(map[string]time.Time, seenHostBudget)
	}
	if _, logged := seenHostRecent.last[key]; logged {
		return true
	}
	if len(seenHostRecent.last) >= seenHostBudget {
		return true
	}
	seenHostRecent.last[key] = now
	return false
}

type seenHostEntry struct {
	Endpoint string `json:"endpoint,omitempty"`
	Name     string `json:"name"`
	Public   string `json:"public"`
}

type seenHostRecord struct {
	TS             int64         `json:"ts"`
	SeverityNumber int           `json:"severityNumber"`
	Msg            string        `json:"msg"`
	Role           string        `json:"role"`
	Entry          seenHostEntry `json:"entry"`
}

func logSeenHost(role, endpoint, name, public string) error {
	if role != roleRelay && role != roleExit {
		return errors.New("seen_hosts role must be relay or exit")
	}
	if role == roleRelay && endpoint == "" {
		return errors.New("relay seen_hosts entry needs an endpoint")
	}
	if err := validPrincipal(name); err != nil {
		return fmt.Errorf("seen_hosts name: %w", err)
	}
	if _, _, err := parseEPubHeader([]string{public}); err != nil {
		return fmt.Errorf("seen_hosts public: %w", err)
	}
	if role == roleExit {
		endpoint = ""
	}
	if seenHostSuppressed(role, name, public) {
		return nil
	}
	record := seenHostRecord{
		TS:             time.Now().UnixMilli(),
		SeverityNumber: sevWarn.number(),
		Msg:            eventSeenHosts,
		Role:           role,
		Entry:          seenHostEntry{Endpoint: endpoint, Name: name, Public: public},
	}
	line, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode seen_hosts: %w", err)
	}
	fields := []journalField{
		{"EVENT", eventSeenHosts},
		{"ROLE", role},
		{"NAME", name},
		{"PUBLIC", public},
	}
	if endpoint != "" {
		fields = append(fields, journalField{"ENDPOINT", endpoint})
	}
	activeSink.emit(sevWarn, string(line), fields)
	return nil
}
