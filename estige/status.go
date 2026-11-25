// status.go — the exit node's loopback status surface and the live-session
// registry shared with drain (docs/d106).
//
// WHY the exit needs one at all: the relay has /healthz because VPN-R27 binds
// the client-facing proxy, and the exit has nothing — so the operator can see
// "the relay is up and its tunnel is broken" but not "the exit is up and
// nobody is connected". d106 left the question open; this is its answer, and
// it is deliberately off by default and loopback-only: the funnel face is the
// camouflage 404 (VPN-R34) and no state may ride the public port.
package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"sync"
	"time"
)

// drainGrace is how long a signal waits for live sessions before closing
// them. It is generous because the work is a streaming LLM response: a
// restart during a long completion should let that completion finish rather
// than truncate it (the v3 credential rotates by restart).
const drainGrace = 20 * time.Second

// liveRegistry is every admitted session on one node: the pull side of
// docs/d106's observability (status surface) and the drain's work list. Both
// nodes keep one — the exit in its tunnelServer, the relay in its relayNode —
// because net/http tracks neither hijacked connections nor a carrier's
// goroutines.
type liveRegistry struct {
	mu  sync.Mutex
	set map[*liveSession]struct{}
}

func newLiveRegistry() liveRegistry {
	return liveRegistry{set: make(map[*liveSession]struct{})}
}

func (r *liveRegistry) register(l *liveSession) {
	r.mu.Lock()
	r.set[l] = struct{}{}
	r.mu.Unlock()
}

func (r *liveRegistry) unregister(l *liveSession) {
	r.mu.Lock()
	delete(r.set, l)
	r.mu.Unlock()
}

func (r *liveRegistry) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.set)
}

// snapshot is the in-flight list, oldest first. No periodic log lines: a
// windowed stream emits many exchanges, and this answers the same question at
// zero log volume (docs/d106).
func (r *liveRegistry) snapshot() []map[string]any {
	r.mu.Lock()
	sessions := make([]*liveSession, 0, len(r.set))
	for s := range r.set {
		sessions = append(sessions, s)
	}
	r.mu.Unlock()
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].start.Before(sessions[j].start) })
	out := make([]map[string]any, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, map[string]any{
			"id":         s.id,
			"key":        s.keyID,
			"label":      s.label,
			"via":        s.via,
			"transport":  s.transport,
			"target":     s.target,
			"bytes_up":   s.up.Load(),
			"bytes_down": s.down.Load(),
			"age_ms":     time.Since(s.start).Milliseconds(),
		})
	}
	return out
}

func (r *liveRegistry) closeAll() {
	r.mu.Lock()
	sessions := make([]*liveSession, 0, len(r.set))
	for s := range r.set {
		sessions = append(sessions, s)
	}
	r.mu.Unlock()
	for _, s := range sessions {
		_ = s.stream.Close()
	}
}

// drainLive waits for the registry to empty, then closes whatever is left at
// the deadline. Both nodes need it for the same reason: net/http does not
// wait for a hijacked connection, so the registry — not Shutdown — is the
// real count of work in flight.
func drainLive(r *liveRegistry, grace time.Duration) {
	deadline := time.Now().Add(grace)
	for r.count() > 0 {
		if time.Now().After(deadline) {
			r.closeAll()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// serveStatus binds the loopback status listener. A failure is logged and
// the process keeps serving: a diagnostic surface must never be the reason
// the tunnel is down.
func serveStatus(addr string, s *server) {
	mux := http.NewServeMux()
	mux.HandleFunc("/status", s.handleStatus)
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	logLine(sevInfo, "[estige] status surface on http://%s/status (loopback only)", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logLine(sevWarn, "[estige] status surface: %v", err)
	}
}

// handleStatus reports state, never secrets: ids, targets, carriers and
// byte counts are d106's vocabulary; the credential has no field here.
func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body := map[string]any{
		"status":   "ok",
		"role":     nodeRole,
		"armed":    s.vpn != nil,
		"sessions": s.tunnelSessions(),
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		logLine(sevWarn, "[estige] status encode: %v", err)
	}
}

func (s *server) tunnelSessions() []map[string]any {
	if s.vpn == nil {
		return []map[string]any{}
	}
	return s.vpn.live.snapshot()
}

func (s *server) tunnelLiveCount() int {
	if s.vpn == nil {
		return 0
	}
	return s.vpn.live.count()
}

func (s *server) closeAllTunnelSessions() {
	if s.vpn == nil {
		return
	}
	s.vpn.live.closeAll()
}

func (s *server) drainTunnelSessions(grace time.Duration) {
	if s.vpn == nil {
		return
	}
	drainLive(&s.vpn.live, grace)
}
