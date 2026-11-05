// main_test.go — the exit node's HTTP surface contracts that are not
// transport-specific: the problem-body bounds and the role-scoped instance
// field. The tunnel namespace's own behaviour is covered by the carrier
// suites; what lives here is the one surface BOTH roles share.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// decodeProblem runs writeProblem and returns the body it wrote.
func decodeProblem(t *testing.T, r *http.Request, err error) (map[string]any, *httptest.ResponseRecorder) {
	t.Helper()
	rec := httptest.NewRecorder()
	writeProblem(rec, r, http.StatusBadGateway, "dnserror", "Resolution failed", err)
	var body map[string]any
	if decodeErr := json.Unmarshal(rec.Body.Bytes(), &body); decodeErr != nil {
		t.Fatalf("problem body is not JSON: %v (%q)", decodeErr, rec.Body.String())
	}
	return body, rec
}

// An error text is reflected to the caller, so its length must be bounded: the
// Go errors that reach here are operator-facing, but the shape is the same one
// any reflected input has, and a caller must not be able to make the exit node
// emit an arbitrarily large body.
func TestWriteProblemBoundsRawError(t *testing.T) {
	err := errors.New(strings.Repeat("x", maxRawError*4))
	body, _ := decodeProblem(t, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/vpn", nil), err)

	raw, _ := body["raw"].(string)
	if len(raw) > maxRawError+len("… (truncated)") {
		t.Fatalf("raw is %d bytes, want it bounded at %d", len(raw), maxRawError)
	}
	if !strings.HasSuffix(raw, "(truncated)") {
		t.Fatalf("truncation is not visible in the body: %q", raw[len(raw)-32:])
	}
}

// A short error passes through verbatim: the bound must not degrade diagnostics.
func TestWriteProblemKeepsShortRawError(t *testing.T) {
	body, _ := decodeProblem(t, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/vpn", nil), errors.New("dial tcp: connection refused"))
	if got := body["raw"]; got != "dial tcp: connection refused" {
		t.Fatalf("raw = %v, want the verbatim error", got)
	}
}

// The instance URI is a loopback-surface diagnostic. On the exit node the URI
// came off the network, and echoing it makes a fixed-path tunnel reflect
// whatever the caller put on the wire.
func TestWriteProblemInstanceIsRoleScoped(t *testing.T) {
	restore := nodeRole
	defer func() { nodeRole = restore }()

	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/vpn/whatever?injected=1", nil)

	nodeRole = roleExit
	body, _ := decodeProblem(t, r, errors.New("boom"))
	if got, ok := body["instance"]; ok {
		t.Fatalf("exit node echoed instance %q; it must be omitted", got)
	}

	nodeRole = roleRelay
	body, _ = decodeProblem(t, r, errors.New("boom"))
	if got := body["instance"]; got != "/vpn/whatever?injected=1" {
		t.Fatalf("relay instance = %v, want the request URI (its own loopback diagnostic)", got)
	}
}

// The problem body keeps its RFC 9457 content type and no-store caching, so a
// bounded body is still a well-formed problem response.
func TestWriteProblemKeepsProblemContract(t *testing.T) {
	_, rec := decodeProblem(t, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/vpn", nil), errors.New("boom"))
	if got := rec.Header().Get("Content-Type"); got != "application/problem+json" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
}
