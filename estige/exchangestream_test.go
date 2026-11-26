package main

// exchangestream_test.go — traceparent's grammar and the retired-carrier
// refusal (docs/d077 §4, d239).

import (
	"bytes"
	"context"
	"maps"
	"net/http"
	"strings"
	"testing"
)

func TestParseTraceparent(t *testing.T) {
	trace := "0123456789abcdef0123456789abcdef"
	tests := []struct {
		in       string
		wantID   string
		wantSpan uint64
		wantErr  bool
	}{
		{in: "00-" + trace + "-000000000000002a-01", wantID: trace, wantSpan: 42},
		{in: "00-" + strings.ToUpper(trace) + "-000000000000002a-00", wantID: trace, wantSpan: 42},
		{in: "01-" + trace + "-000000000000002a-01", wantErr: true},                   // unknown version
		{in: "00-" + trace + "-000000000000002a", wantErr: true},                      // 3 fields
		{in: "00-0123456789abcdef-000000000000002a-01", wantErr: true},                // short trace-id
		{in: "00-" + strings.Repeat("z", 32) + "-000000000000002a-01", wantErr: true}, // not hex
		{in: "00-" + strings.Repeat("0", 32) + "-000000000000002a-01", wantErr: true}, // all-zero trace-id
		{in: "00-" + trace + "-0000000000000000-01", wantErr: true},                   // all-zero span-id
		{in: "00-" + trace + "-000000000000002a-0", wantErr: true},                    // short flags
		{in: "00-" + trace + "-000000000000002a-0g", wantErr: true},                   // flags not hex
	}
	for _, tc := range tests {
		gotID, gotSpan, err := parseTraceparent(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("parseTraceparent(%q) err=nil, want error", tc.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseTraceparent(%q) unexpected err: %v", tc.in, err)
			continue
		}
		if gotID != tc.wantID || gotSpan != tc.wantSpan {
			t.Errorf("parseTraceparent(%q) = (%q, %d), want (%q, %d)", tc.in, gotID, gotSpan, tc.wantID, tc.wantSpan)
		}
	}

	t.Run("build/parse round-trip", func(t *testing.T) {
		id, err := newSessionID()
		if err != nil {
			t.Fatal(err)
		}
		gotID, gotSpan, err := parseTraceparent(buildTraceparent(id, 99))
		if err != nil || gotID != id || gotSpan != 99 {
			t.Fatalf("round-trip = (%q, %d, %v)", gotID, gotSpan, err)
		}
	})
}

// TestRetiredH1WindowedFailsClosed pins d239: an authenticated window shaped
// like h1.1-post-windowed (traceparent, no window header) is refused with the
// camouflage 404 and no carrier answer — never served unprotected.
func TestRetiredH1WindowedFailsClosed(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{})
	backend := newHTTPServer(t, s)
	store, err := loadRelayStore(storeRoot())
	if err != nil {
		t.Fatal(err)
	}
	hdr, _, err := channelRequestHeaders(store.Private, store.Principal, store.Exits[0].Name, store.SelfDER)
	if err != nil {
		t.Fatal(err)
	}
	hello, err := encodeHello("retired-carrier")
	if err != nil {
		t.Fatal(err)
	}
	body, err := encodeFrame(frameHello, tunnelStreamV1, hello)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
		backend.URL+tunnelPath, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	maps.Copy(req.Header, hdr)
	req.Header.Set("Traceparent", buildTraceparent("000000000000000000000000000000e1", 1))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("retired h1.1-post-windowed window answered %d, want the camouflage 404", resp.StatusCode)
	}
}

// TestWindowedSessionAdmission pins the windowed carriers' session rules, which
// the retired h1.1 suite used to cover: a window must authenticate as the key
// that minted the session, only span 1 mints, and only the next span in
// sequence is admitted. Every refusal is the camouflage 404 and no refusal may
// report who else holds the trace-id.
func TestWindowedSessionAdmission(t *testing.T) {
	// accept lives on the server (it spawns the session's pump), so the
	// fixture builds the minimum server around the registry.
	server := &tunnelServer{sessions: newExchangeSessions()}
	const (
		alice   = "relay_alice"
		mallory = "relay_mallory"
		traceID = "0123456789abcdef0123456789abcdef"
		other   = "fedcba9876543210fedcba9876543210"
	)
	ctx := t.Context()

	t.Run("span 1 mints a session bound to its key", func(t *testing.T) {
		session, compromised := server.accept(ctx, traceID, firstWindowSpan, &operatorKey{id: alice})
		if session == nil || compromised != nil {
			t.Fatalf("accept = (%v, %v), want a minted session", session, compromised)
		}
		t.Cleanup(func() { _ = session.Close() })
		if session.keyID != alice {
			t.Fatalf("session key = %q, want %q", session.keyID, alice)
		}
		// A continuation on the same trace-id from the same key is the session.
		if again, _ := server.accept(ctx, traceID, firstWindowSpan, &operatorKey{id: alice}); again != session {
			t.Fatal("a same-key continuation minted a second session")
		}
		// A different (individually valid) key must not drive it, and the
		// refusal hands the session back so the caller can kill it.
		if _, compromised := server.accept(ctx, traceID, firstWindowSpan, &operatorKey{id: mallory}); compromised != session {
			t.Fatal("a foreign key was allowed to reach another principal's session")
		}
	})

	t.Run("a continuation on an unknown trace-id is refused", func(t *testing.T) {
		// Span > 1 with no state is a misrouted window, not a new session:
		// answering "minting works" would be an oracle (VPN-R34).
		if session, _ := server.accept(ctx, other, firstWindowSpan+1, &operatorKey{id: alice}); session != nil {
			t.Fatal("a continuation without state minted a session")
		}
	})

	t.Run("only the next span in sequence is admitted, one at a time", func(t *testing.T) {
		id := "000000000000000000000000000000aa"
		session, _ := server.accept(ctx, id, firstWindowSpan, &operatorKey{id: alice})
		if session == nil {
			t.Fatal("fresh session not minted")
		}
		t.Cleanup(func() { _ = session.Close() })
		if !session.beginWindow(firstWindowSpan) {
			t.Fatal("the minting window was refused")
		}
		if session.beginWindow(firstWindowSpan + 1) {
			t.Fatal("a second window was admitted while one was in flight")
		}
		session.endWindow()
		if session.beginWindow(firstWindowSpan + 2) {
			t.Fatal("a desynced span was admitted")
		}
		if !session.beginWindow(firstWindowSpan + 1) {
			t.Fatal("the next span was refused")
		}
		session.endWindow()
	})
}
