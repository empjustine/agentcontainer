// exchangestream.go — the windowed carriers' shared exchange machinery
// (docs/d077 §3/§4, d236, d241).
//
// WHY this exists at all: h2-post-windowed carries a session through a
// sequence of bounded HTTP exchanges, so the exit needs session state that
// outlives one handler — a per-trace-id registry, one window in flight at a
// time, and a frame queue between the session pump and whichever window is
// open. W3C traceparent is the dispatch discriminator and the demux: the
// trace-id is the session, the span-id its window position, and an unknown
// trace-id or out-of-order span answers the camouflage 404 (VPN-R34).
//
// WHY h1.1-post-windowed is not here any more (d241): its channel needs a
// bidirectional window, which an upgrade-stripping gateway cannot carry — the
// carrier answers only after the request body ends. Serving it without the
// inner session would be a silent downgrade, so v5 fails closed on that shape
// instead and the relay no longer offers it.
package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// maxExchangeSessions bounds the per-trace-id registry (d081: TTL'd
	// state, never leak). Sessions delete themselves on close — every phase
	// is deadline-bounded (handshake, relay idle, window ResponseHeader
	// timeout), so runSession always reaches its deferred Close; the cap
	// only bounds a burst of live sessions. Full registry refuses new mints
	// loudly (logged), never evicts a live session.
	maxExchangeSessions = 1024
	// firstWindowSpan is the span-id that mints state: W3C span ids are
	// nonzero, and the sequence starts at 1 so a continuation without state
	// (span > 1, empty registry) is distinguishable from a fresh session.
	firstWindowSpan = 1
)

// ---------------------------------------------------------------------------
// traceparent — the dispatch discriminator and demux (docs/d077 §4)
// ---------------------------------------------------------------------------

// parseTraceparent parses the W3C traceparent value
// version(2)-traceId(32)-spanId(16)-flags(2) into the trace-id key and the
// window's sequence position. Only version 00 is accepted — we emit it, and
// a version we do not understand is not a window this server can serve.
// The trace-id is lowercased so one connection can never register twice
// under case-distinct keys. Returns (trace-id, span, error).
func parseTraceparent(v string) (string, uint64, error) {
	bad := func(why string) (string, uint64, error) {
		return "", 0, fmt.Errorf("traceparent: %s", why)
	}
	parts := strings.Split(v, "-")
	if len(parts) != 4 {
		return bad("want 4 fields")
	}
	if parts[0] != "00" {
		return bad("unsupported version")
	}
	if len(parts[1]) != 32 {
		return bad("trace-id length")
	}
	if _, err := hex.DecodeString(parts[1]); err != nil {
		return bad("trace-id not hex")
	}
	if strings.Trim(parts[1], "0") == "" {
		return bad("all-zero trace-id")
	}
	if len(parts[2]) != 16 {
		return bad("span-id length")
	}
	if _, err := hex.DecodeString(parts[2]); err != nil {
		return bad("span-id not hex")
	}
	span, err := strconv.ParseUint(parts[2], 16, 64)
	if err != nil || span == 0 {
		return bad("all-zero span-id")
	}
	if len(parts[3]) != 2 {
		return bad("flags length")
	}
	if _, err := hex.DecodeString(parts[3]); err != nil {
		return bad("flags not hex")
	}
	return strings.ToLower(parts[1]), span, nil
}

// buildTraceparent renders the header one window carries: version 00, the
// session's trace-id, the window's sequence position (nonzero, W3C),
// sampled flag.
func buildTraceparent(traceID string, span uint64) string {
	return fmt.Sprintf("00-%s-%016x-01", traceID, span)
}

// ---------------------------------------------------------------------------
// Server side — the exit node's exchangeStream and its registry
// ---------------------------------------------------------------------------

// exchangeSessions is the per-trace-id registry: one entry per live windowed
// session, minted by a span-1 window, removed by the session's own Close
// (runSession is deadline-bounded end to end, so every entry that can exist
// also always reaches its removal — the cap bounds the live set, nothing
// needs a janitor).
type exchangeSessions struct {
	mu      sync.Mutex
	byTrace map[string]*exchangeStream
}

// newExchangeSessions returns an empty per-trace-id registry.
func newExchangeSessions() *exchangeSessions {
	return &exchangeSessions{byTrace: make(map[string]*exchangeStream)}
}

// accept resolves a window's trace-id to its session: an existing entry
// continues (the span check lives in beginWindow, next to the sequence
// state), a fresh trace-id mints iff the span says it is the first window.
// A nil return means "not a serveable window" — the caller answers the
// camouflage 404.
//
// The session is bound to the key that MINTED it: a window bearing a
// different (but individually valid) operator key is refused, and the refusal
// is indistinguishable from every other one (VPN-R34). Without the binding any
// operator key that learned a trace-id could drive — or destroy — a session it
// never authenticated for. This is a session-authentication rule, not a
// per-key right: d078 §1 keeps scopes, egress policy and namespaces out of
// scope, and this adds none of them.
//
// The third return says the refusal was an AUTHENTICATION event on a live
// session rather than a routing one, and hands that session back so the caller
// can destroy it OUTSIDE this lock (Close takes the registry lock). It is
// non-nil only for the key-mismatch case: a desynced span or an unknown
// trace-id is a misrouted window, not evidence that someone else holds the
// carrier.
func (t *tunnelServer) accept(runCtx context.Context, traceID string, span uint64, key *operatorKey) (session *exchangeStream, compromised *exchangeStream) {
	t.sessions.mu.Lock()
	defer t.sessions.mu.Unlock()
	if s := t.sessions.byTrace[traceID]; s != nil {
		if s.keyID != key.id {
			// Attribution side only: the arriving key is named in the log (it
			// authenticated), never in the response, and the session's own key
			// is deliberately NOT logged here — a refusal must not report who
			// else holds the trace-id.
			logLine(sevWarn, "[estige] tunnel h2-post-windowed: AUTH FAILURE — window authenticated as key=%s, but this session was minted by another principal; killing the session", key.id)
			return nil, s
		}
		return s, nil
	}
	if span != firstWindowSpan {
		// A continuation without state: unknown trace-id is camouflage
		// 404 by decision (d077 §3, VPN-R34) — the answer must not tell a
		// prober that minting works.
		return nil, nil
	}
	if len(t.sessions.byTrace) >= maxExchangeSessions {
		// Loud, not silent: a full registry means a session leak or an
		// operator burst, and refusing a NEW session is survivable while a
		// half-minted one would not be (NFR-2).
		logLine(sevWarn, "[estige] tunnel h2-post-windowed: session registry full (%d) — refusing new session", maxExchangeSessions)
		return nil, nil
	}
	s := newExchangeStream(traceID, t.sessions, key.id)
	t.sessions.byTrace[traceID] = s
	// Attribution lives on the session's own open record now (docs/d106):
	// the id and key appear there, once, instead of a second line per
	// session that said almost nothing.
	go t.runSession(runCtx, s, key)
	return s, nil
}

// exchangeStream is h2-post-windowed's tunnelStream on the exit-node side:
// reads pop the windows handlers drained into inbound; writes park in the
// one-frame outbound slot until the current (or next) window's handler
// flushes it.
// Slot capacity one IS VPN-R18 — the relay's next read cannot happen until
// this frame is on the wire of some window.
type exchangeStream struct {
	traceID  string
	sessions *exchangeSessions
	// keyID is the principal whose credential minted this session. Every
	// later window must authenticate as the same key (accept enforces it), so
	// the session is as bound to one authentication as a websocket carrier is to
	// its handshake — the per-connection authentication d104 states as a
	// security bound, expressed for a multi-request carrier.
	keyID string

	// timerMu guards readTimer between the pump's setReadDeadline and the
	// handler's Close; s.mu is the sequence state and stays untouched.
	timerMu sync.Mutex

	// mu guards the sequence state AND the one-window-at-a-time contract:
	// beginWindow is the only mutator, so response writers are serialized
	// structurally (no separate write mutex).
	mu       sync.Mutex
	nextSpan uint64
	inFlight bool

	inbound  chan []byte
	outbound chan []byte // cap 1: one frame of backpressure (VPN-R18)

	closeOnce sync.Once
	closed    chan struct{}
	readTimer *time.Timer
	timedOut  atomic.Bool
}

// newExchangeStream builds an unstarted session carrier (runSession is
// spawned by accept once the registry holds it).
func newExchangeStream(traceID string, sessions *exchangeSessions, keyID string) *exchangeStream {
	return &exchangeStream{
		traceID:  traceID,
		sessions: sessions,
		keyID:    keyID,
		nextSpan: firstWindowSpan,
		// Small on purpose: a handler blocks on a full queue instead of the
		// queue growing, and the relay consumer is always running — during
		// the handshake phases each window carries 1–2 frames, far below.
		inbound:  make(chan []byte, 4096),
		outbound: make(chan []byte, 1),
		closed:   make(chan struct{}),
	}
}

// beginWindow admits a window iff the stop-and-wait sequence holds: no
// other window in flight, and the span is exactly the next position. A
// desynced or concurrent peer gets the camouflage 404 and, with its
// session's answer never coming, dies with the exchange — no in-protocol
// recovery (one stream, one life).
func (s *exchangeStream) beginWindow(span uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inFlight || span != s.nextSpan {
		return false
	}
	s.inFlight = true
	s.nextSpan++
	return true
}

// endWindow releases the sequence slot (deferred by the handler).
func (s *exchangeStream) endWindow() {
	s.mu.Lock()
	s.inFlight = false
	s.mu.Unlock()
}

// readTunnelMsg pops the next admitted frame — or waits for the next window
// to carry one. The read deadline fires through Close (the timer of
// setReadDeadline), which is how the handshake bound and the relay's idle
// reap reach a carrier with no socket of its own. A window's own byte budget
// is enforced where it is read (drainBound), so no counter lives here.
func (s *exchangeStream) readTunnelMsg() ([]byte, error) {
	select {
	case msg := <-s.inbound:
		return msg, nil
	case <-s.closed:
		if s.timedOut.Load() {
			return nil, os.ErrDeadlineExceeded
		}
		return nil, io.EOF
	}
}

// writeTunnelMsg parks one frame in the outbound slot; the current
// window's flush or the next window's takes it. Blocking here IS the
// backpressure (VPN-R18): the relay's read of the target stalls until some
// window carries this frame, and Close releases the park.
func (s *exchangeStream) writeTunnelMsg(msg []byte) error {
	select {
	case s.outbound <- msg:
		return nil
	case <-s.closed:
		if s.timedOut.Load() {
			return os.ErrDeadlineExceeded
		}
		return io.ErrClosedPipe
	}
}

// setReadDeadline arms the timer that closes the session on expiry —
// the exchange carrier's equivalent of a conn read deadline (VPN-R39/R14).
func (s *exchangeStream) setReadDeadline(t time.Time) error {
	s.timerMu.Lock()
	if s.readTimer != nil {
		s.readTimer.Stop()
		s.readTimer = nil
	}
	if t.IsZero() {
		s.timerMu.Unlock()
		return nil
	}
	s.timedOut.Store(false)
	s.readTimer = time.AfterFunc(time.Until(t), func() {
		s.timedOut.Store(true)
		_ = s.Close()
	})
	s.timerMu.Unlock()
	return nil
}

// protocolViolation has no in-band signal (same as the h2-post-unbounded body
// carrier): ending the session is the abort the peer observes.
func (s *exchangeStream) protocolViolation() { _ = s.Close() }

// transport names the carrier for the lifecycle log: the exit node saw a
// plain POST — the edge stripped the plane evidence (docs/d077 §4).
func (s *exchangeStream) transport() string { return carrierH2Windowed }

func (s *exchangeStream) sessionID() string { return s.traceID }

// Close releases the session exactly once: parked readers/writers and any
// in-flight handler see closed, and the registry entry goes with it.
func (s *exchangeStream) Close() error {
	s.closeOnce.Do(func() {
		s.timerMu.Lock()
		if s.readTimer != nil {
			s.readTimer.Stop()
			s.readTimer = nil
		}
		s.timerMu.Unlock()
		close(s.closed)
		s.sessions.mu.Lock()
		if s.sessions.byTrace[s.traceID] == s {
			delete(s.sessions.byTrace, s.traceID)
		}
		s.sessions.mu.Unlock()
	})
	return nil
}
