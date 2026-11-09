package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"testing"
	"time"
)

// VPN-R35's deny list as behavior: default-deny means every address on the
// table is refused unless the operator's allowCIDRs put it back — this test
// IS the requirements table, so a config-shaped change that silently opens
// loopback fails here.
func TestEgressDefaultDenyTable(t *testing.T) {
	p, err := newEgressPolicy(egressConfig{})
	if err != nil {
		t.Fatal(err)
	}
	denied := []string{
		"127.0.0.1", "::1", "169.254.169.254", "fe80::1", "fd00:ec2::254",
		"0.0.0.0", "::", "224.0.0.1", "ff02::1",
		"10.0.0.1", "172.16.0.1", "192.168.1.1", "fc00::1",
		// IPv4-mapped form must not slip past the v4 rules.
		"::ffff:127.0.0.1", "::ffff:169.254.169.254",
	}
	for _, s := range denied {
		ip := netip.MustParseAddr(s)
		if p.allowAddr(ip) {
			t.Errorf("%s: expected DENIED by default", s)
		}
	}

	allowed := []string{"1.1.1.1", "8.8.8.8", "2606:4700::1111", "93.184.216.34"}
	for _, s := range allowed {
		ip := netip.MustParseAddr(s)
		if !p.allowAddr(ip) {
			t.Errorf("%s: public address should pass by default", s)
		}
	}
}

// The explicit-allow override (VPN-R35's "unless the operator policy
// explicitly allows a CIDR") — also how the smoke test reaches a loopback
// upstream.
func TestEgressExplicitAllowOverridesDeny(t *testing.T) {
	p, err := newEgressPolicy(egressConfig{AllowCidrs: []string{"127.0.0.0/8", "169.254.169.254/32"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"127.0.0.1", "127.1.2.3", "169.254.169.254"} {
		if !p.allowAddr(netip.MustParseAddr(s)) {
			t.Errorf("%s: operator-allowed CIDR must pass", s)
		}
	}
	// One allowlist entry does not become a blanket: private stays closed.
	if p.allowAddr(netip.MustParseAddr("192.168.1.1")) {
		t.Error("192.168.1.1: unrelated private range must stay denied")
	}
}

// VPN-R37: 80/443 by default; an explicit port set REPLACES it (that is
// what "only when the operator policy says so" means for the default set).
func TestEgressPortPolicy(t *testing.T) {
	dflt, err := newEgressPolicy(egressConfig{})
	if err != nil {
		t.Fatal(err)
	}
	for port, want := range map[uint16]bool{80: true, 443: true, 22: false, 8080: false, 53: false} {
		if dflt.allowPort(port) != want {
			t.Errorf("port %d: got %v, want %v", port, dflt.allowPort(port), want)
		}
	}

	custom, err := newEgressPolicy(egressConfig{Ports: []uint16{8443}})
	if err != nil {
		t.Fatal(err)
	}
	if custom.allowPort(8443) != true || custom.allowPort(443) != false {
		t.Error("explicit port set must replace the 80/443 default, not extend it")
	}

	if _, err := newEgressPolicy(egressConfig{Ports: []uint16{0}}); err == nil {
		t.Error("port 0 must be rejected as config")
	}
	if _, err := newEgressPolicy(egressConfig{AllowCidrs: []string{"not-a-cidr"}}); err == nil {
		t.Error("bad CIDR must fail loudly (NFR-2)")
	}
}

// splitConnectTarget is the target-shaping gate: host:port only, bounded,
// no userinfo/path/escape tricks (VPN-R20's "validate what CONNECT asked").
func TestSplitConnectTarget(t *testing.T) {
	host, port, err := splitConnectTarget("api.example.com:443")
	if err != nil || host != "api.example.com" || port != 443 {
		t.Fatalf("got (%q, %d, %v)", host, port, err)
	}
	host, port, err = splitConnectTarget("[2001:db8::1]:80")
	if err != nil || host != "2001:db8::1" || port != 80 {
		t.Fatalf("got (%q, %d, %v)", host, port, err)
	}

	rejected := []string{
		"no-port",
		":443",
		"user@evil:443",
		"host:0",
		"host:99999",
		"host:",
		"exa mple:443",
		"host/../x:443",
		"host%2fx:443",
	}
	for _, target := range rejected {
		if _, _, err := splitConnectTarget(target); !errors.Is(err, ErrProtocol) {
			t.Errorf("%q: expected ErrProtocol, got %v", target, err)
		}
	}
}

// VPN-R22's classification: names pass through to the exit node's resolver,
// literals do not reach the exit node at all.
func TestParseIPLiteral(t *testing.T) {
	for _, s := range []string{"1.2.3.4", "::1", "2001:db8::1"} {
		if _, ok := parseIPLiteral(s); !ok {
			t.Errorf("%s: expected literal", s)
		}
	}
	for _, s := range []string{"example.com", "localhost", "1.2.3.4.example.com"} {
		if _, ok := parseIPLiteral(s); ok {
			t.Errorf("%s: expected name", s)
		}
	}
	// The root anchor is spelling, not a different target: "1.2.3.4." is
	// that address and must classify as one, or the rules die to a dot
	// (d163).
	if _, ok := parseIPLiteral("1.2.3.4."); !ok {
		t.Error("1.2.3.4.: trailing dot must not dodge the address classification")
	}
}

// VPN-R36 end to end: resolve once, filter EVERY address, dial the pinned
// one. "localhost" resolves to loopback — denied under default policy, and
// (the important half) an ALLOWED policy dials a validated literal address.
func TestDialValidated(t *testing.T) {
	target, err := new(net.ListenConfig).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	port := portOf(t, target.Addr().String())

	// Default policy: name resolves into denied space → refused, nothing dialed.
	p, err := newEgressPolicy(egressConfig{Ports: []uint16{port}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// The asserted property is the VOCABULARY the relay and the log key on
	// (egressFailureReason), not a predicate name: that is what a caller can
	// observe, and it is the one place the classification lives.
	if _, _, err := dialValidated(ctx, p, "localhost", port); err == nil {
		t.Fatal("default policy must refuse a loopback-resolving name")
	} else if got := egressFailureReason(err); got != errReasonDenied {
		t.Fatalf("expected the policy-denied reason, got %v → %s", err, got)
	}

	// Operator-allowed: same name now passes, and the connection lands.
	p2, err := newEgressPolicy(egressConfig{AllowCidrs: []string{"127.0.0.0/8"}, Ports: []uint16{port}})
	if err != nil {
		t.Fatal(err)
	}
	conn, pinned, err := dialValidated(ctx, p2, "localhost", port)
	if err != nil {
		t.Fatalf("allowed dial failed: %v", err)
	}
	defer conn.Close()
	if !pinned.Is4() || !pinned.IsLoopback() {
		t.Fatalf("pinned address should be the validated v4 loopback, got %s", pinned)
	}
	if !p2.allowAddr(pinned) {
		t.Fatalf("pinned %s must itself be policy-allowed (post-dial invariant)", pinned)
	}

	// Unresolvable names are resolve-failed, NOT policy-denied — the
	// vocabulary split the CONNECT_ERR reasons depend on.
	if _, _, err := dialValidated(ctx, p2, "definitely-not-a-host.invalid", 443); err == nil {
		t.Fatal("expected resolution failure")
	} else if got := egressFailureReason(err); got != errReasonResolve {
		t.Fatalf("expected resolve-failed vocabulary, got %v → %s", err, got)
	}
}

// d163's door predicate: the guaranteed set is the NO-ANSWER space, and the
// complementary half of the test is what keeps it that narrow — RFC 1918,
// link-local, the metadata address and the documentation ranges stay under
// the operator's allow table, because a pinhole for one of those is a
// reviewable decision while a guaranteed refusal must not be one.
func TestGuaranteedRefusals(t *testing.T) {
	for _, s := range []string{
		"0.0.0.1", "127.0.0.1", "127.1.2.3", "255.255.255.255",
		"224.0.0.1", "239.1.2.3",
		"::", "::1", "::ffff:127.0.0.1", "::ffff:1.2.3.4", "100::1",
	} {
		addr, err := netip.ParseAddr(s)
		if err != nil {
			t.Fatalf("fixture %q: %v", s, err)
		}
		if !isGuaranteedBogon(addr) {
			t.Errorf("%s: must be a guaranteed refusal", s)
		}
	}
	for _, s := range []string{
		"10.0.0.1", "172.16.0.1", "192.168.1.1",
		"169.254.169.254",
		"240.0.0.1", "192.0.2.1", "203.0.113.7",
		"fe80::1", "fc00::1", "2001:db8::1",
		"8.8.8.8", "2001:4860:4860::8888",
	} {
		addr, err := netip.ParseAddr(s)
		if err != nil {
			t.Fatalf("fixture %q: %v", s, err)
		}
		if isGuaranteedBogon(addr) {
			t.Errorf("%s: stays under the operator's allow table, not the guaranteed door", s)
		}
	}
}

// d163's name door: `localhost`, the whole .localhost TLD, the dev
// sub-tree and the /etc/hosts loopback family are refused spellings of
// names, checked as written — trailing dot and case are the same name, and
// a lookalike (or a name that merely starts with "localhost") stays a name
// the exit's policy owns.
func TestIsBogonName(t *testing.T) {
	for _, s := range []string{
		"localhost", "localhost.", "LOCALHOST", "LocalHost.",
		"x.localhost", "dev.localhost", "a.dev.localhost", "dev.localhost.",
		"localhost4", "localhost6", "localhost.localdomain",
		"localhost4.localdomain4", "localhost6.localdomain6",
		"LOCALHOST4.", "Localhost.Localdomain.",
	} {
		if !isBogonName(s) {
			t.Errorf("%s: must be refused at the door", s)
		}
	}
	for _, s := range []string{
		"example.com", "local.test",
		"example.localhost.com", "localhost:443",
		"localhost.example.com", "localhost4.example.com",
	} {
		if isBogonName(s) {
			t.Errorf("%s: not a guaranteed-refused name", s)
		}
	}
}

// d163's refusal order in the one function that owns it: guaranteed
// refusals first, then the IP-exit switch, then the port set. Several rows
// name a config whose LATER gates would accept the target — the open config
// allows every address and every port in the row — which is exactly what
// the order has to defeat.
func TestTargetVerdictOrder(t *testing.T) {
	open := egressConfig{AllowIPLiterals: true, AllowCidrs: []string{"0.0.0.0/0"}, Ports: []uint16{80, 443, 8443}}
	for _, tc := range []struct {
		name string
		cfg  egressConfig
		host string
		port uint16
		want string
	}{
		{"bogon name before the switch", egressConfig{AllowIPLiterals: true}, "localhost", 443, errReasonBogon},
		{"bogon name under the default config", egressConfig{}, "a.dev.localhost", 80, errReasonBogon},
		{"hosts-file loopback name before the switch", egressConfig{AllowIPLiterals: true}, "localhost6.localdomain6", 443, errReasonBogon},
		{"bogon address before its own allow rule", open, "127.0.0.1", 8443, errReasonBogon},
		{"v4-mapped spelling cannot dodge", open, "::ffff:127.0.0.1", 443, errReasonBogon},
		{"literal without the switch", egressConfig{}, "1.2.3.4", 443, errReasonTargetIP},
		{"literal with the switch, port in set", open, "1.2.3.4", 8443, ""},
		{"literal with the switch, port out", open, "1.2.3.4", 22, errReasonPortDenied},
		{"name, port in set", open, "example.com", 443, ""},
		{"name, port out", egressConfig{}, "example.com", 8443, errReasonPortDenied},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := newEgressPolicy(tc.cfg)
			if err != nil {
				t.Fatal(err)
			}
			if got := p.targetVerdict(tc.host, tc.port); got != tc.want {
				t.Fatalf("targetVerdict(%q, %d) = %q, want %q", tc.host, tc.port, got, tc.want)
			}
		})
	}
}
