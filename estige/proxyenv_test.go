package main

import (
	"reflect"
	"strings"
	"testing"
)

// The exact line set is a contract, not a snapshot: an operator evals this
// output, so a missing or misspelled variable is a child that dials direct
// (docs/d130). socks5h is part of it — the relay's SOCKS listener refuses a
// literal-IP target by design (VPN-R22), so a client told `socks5://` resolves
// first, sends ATYP=IPv4/6, and is refused.
func TestProxyEnvLinesMergesNoProxyAndQuotes(t *testing.T) {
	t.Setenv("NO_PROXY", "internal.test, 127.0.0.1")

	got := proxyEnvLines("127.0.0.1:3128", "127.0.0.1:1080")
	want := []string{
		"export HTTP_PROXY='http://127.0.0.1:3128'",
		"export http_proxy='http://127.0.0.1:3128'",
		"export HTTPS_PROXY='http://127.0.0.1:3128'",
		"export https_proxy='http://127.0.0.1:3128'",
		"export ALL_PROXY='socks5h://127.0.0.1:1080'",
		"export all_proxy='socks5h://127.0.0.1:1080'",
		"export NO_PROXY='127.0.0.1,localhost,::1,internal.test'",
		"export no_proxy='127.0.0.1,localhost,::1,internal.test'",
		"export NODE_USE_ENV_PROXY='1'",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("proxyEnvLines mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

// The conventional proxy variables have no agreed case: curl honors
// `http_proxy` but ignores `HTTP_PROXY` for http:// URLs, and GNU wget reads
// only the lowercase spelling — so a spelling exported in one case sends that
// child to the internet DIRECT, past the kill switch (VPN-R26). Both cases
// therefore carry the same value, always (docs/d130).
func TestProxyEnvLinesPairsEveryCase(t *testing.T) {
	t.Setenv("NO_PROXY", "internal.test")

	values := map[string]string{}
	for _, line := range proxyEnvLines("127.0.0.1:3128", "127.0.0.1:1080") {
		name, value, ok := strings.Cut(strings.TrimPrefix(line, "export "), "=")
		if !ok {
			t.Fatalf("not an export assignment: %q", line)
		}
		values[name] = value
	}

	// NODE_USE_ENV_PROXY is node's own switch and has no lowercase form; every
	// other variable is a conventional spelling a client may read in either
	// case, so both cases must be present and agree.
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"} {
		upper, okUpper := values[name]
		lower, okLower := values[strings.ToLower(name)]
		if !okUpper || !okLower {
			t.Fatalf("%s exported in one case only (upper=%v lower=%v): %v", name, okUpper, okLower, values)
		}
		if upper != lower {
			t.Fatalf("%s cases disagree: %q vs %q", name, upper, lower)
		}
	}
	if values["NODE_USE_ENV_PROXY"] == "" {
		t.Fatalf("NODE_USE_ENV_PROXY missing: %v", values)
	}
}

// ALL_PROXY must name socks5h: the relay's SOCKS listener refuses literal IPs
// because the exit node owns resolution and pinning (VPN-R22, d073's VPN-R24),
// so a client that resolves first is refused by design — the scheme has to be
// the one that keeps the name on the wire (docs/d130).
func TestAllProxySpellsSocks5h(t *testing.T) {
	t.Setenv("NO_PROXY", "")
	for _, name := range []string{"ALL_PROXY", "all_proxy"} {
		if got, want := proxyEnvValue(t, name), "'socks5h://127.0.0.1:1080'"; got != want {
			t.Fatalf("%s = %s, want %s", name, got, want)
		}
	}
}

func proxyEnvValue(t *testing.T, name string) string {
	t.Helper()
	for _, line := range proxyEnvLines("127.0.0.1:3128", "127.0.0.1:1080") {
		if rest, ok := strings.CutPrefix(line, "export "+name+"="); ok {
			return rest
		}
	}
	t.Fatalf("%s not exported by proxyEnvLines", name)
	return ""
}

func TestShellQuoteSurvivesApostrophe(t *testing.T) {
	if got, want := shellQuote("a'b"), `'a'\''b'`; got != want {
		t.Fatalf("shellQuote = %q, want %q", got, want)
	}
}
