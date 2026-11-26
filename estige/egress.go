// egress.go — the tunnel's egress policy (carriers): what it may dial
// (docs/d073 §9: VPN-R35..R38).
//
// WHY this shape: modes A's deny-by-absence no longer covers an
// authenticated arbitrary-egress namespace, so the policy that replaces it
// has to be a reviewable DATA table (VPN-R38), not scattered conditionals.
// The default-deny set below is the requirement's own list rendered as a
// table (VPN-R35); operator opt-ins (CIDRs, ports) arrive as config data on
// top of it. S4 (d073 §13) still owns the artifact's final format and home —
// until it lands, the table lives here and overrides live in the tunnel
// config block, both of which are diffable data.
//
// The pinning rule (VPN-R36) is the load-bearing invariant: resolve ONCE,
// validate every address, dial a validated address — never re-resolve —
// so a rebinding DNS answer cannot swap the destination after the check.
//
// The d047 host allowlist is deliberately absent from this path: it is mode
// A's control; this table is the whole policy for the forward-proxy modes
// (docs/d080).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
)

// defaultDenyCidrs is the operator's reservation table when none is
// configured, and it is EMPTY by design: a VPN carries IP traffic, so private,
// link-local and ULA space is a normal destination and only space that can
// never answer a connection is refused out of the box — that set is
// guaranteedBogonCidrs, which is code and answers before any table (d163).
//
// The trade is stated in the record that owns this default: 169.254.169.254
// (cloud metadata) is reachable until an operator reserves it, because
// link-local is also where real peers live. An operator restores the old
// posture with one denyCidrs entry per range.
var defaultDenyCidrs = []string{}

// defaultEgressPorts is VPN-R37's default port policy. Ports are the
// operator's data when configured; 80/443 only when they are not.
var defaultEgressPorts = []uint16{80, 443}

// guaranteedBogonCidrs is d146's exit-owned set, now enforced by the relay
// door as well as the exit's dial (d163): space that can never answer a
// connection, so neither end spends a lookup or a socket on it. It is
// deliberately narrower than defaultDenyCidrs — RFC 1918, link-local and the
// documentation ranges are d146's "possible bogons", left to the pinhole
// review because a real network does allocate them.
var guaranteedBogonCidrs = []string{
	"0.0.0.0/8",          // this network
	"127.0.0.0/8",        // loopback
	"255.255.255.255/32", // limited broadcast
	"224.0.0.0/4",        // multicast — no TCP dial answers it
	"::/128",             // unspecified v6
	"::1/128",            // loopback v6
	"::ffff:0:0/96",      // v4-mapped: an IPv4 target has the plain spelling only
	"100::/64",           // discard-only
}

// guaranteedBogons parses the constant once at load. The list is code, not
// config, so a bad entry is a programming error — a panic here says so
// louder than a mis-verdict at some later dial would.
var guaranteedBogons = func() []netip.Prefix {
	out := make([]netip.Prefix, 0, len(guaranteedBogonCidrs))
	for _, c := range guaranteedBogonCidrs {
		p, err := netip.ParsePrefix(c)
		if err != nil {
			panic("internal: bad guaranteed-bogon CIDR " + c)
		}
		out = append(out, p)
	}
	return out
}()

// isGuaranteedBogon answers for one address AS SPELLED. The spelling is
// load-bearing: the mapped block sits in the list precisely so an IPv4
// bogon cannot be re-spelled around its refusal, and unmapping first would
// undo that (d146: the plain spelling is the only one for an IPv4 target).
func isGuaranteedBogon(addr netip.Addr) bool {
	for _, p := range guaranteedBogons {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// isBogonName is the DNS half of the same refusal (d163): RFC 6761 reserves
// localhost, every name under the .localhost TLD resolves inside the host by
// the same rule, and guaranteedBogonNames carries the /etc/hosts family
// beside them — no lookup can produce a useful answer for any of them, so
// both ends refuse the name before resolution. The trailing dot (DNS's root
// anchor) and the case (DNS's case-insensitivity) are the same name wearing
// another spelling, and neither spelling may dodge the refusal.
func isBogonName(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(host, "."))
	return h == localhostName || strings.HasSuffix(h, ".localhost") || guaranteedBogonNames[h]
}

// localhostName is RFC 6761's reserved loopback name, spelled once because
// three surfaces must agree on it: the name door refuses it (d163),
// requireLoopback accepts it as loopback (VPN-R23), and proxyEnvLoopback
// lists it as always-direct.
const localhostName = "localhost"

// guaranteedBogonNames is the /etc/hosts half of the name door: the
// localhost4/localhost6 and .localdomain spellings a default Fedora/RHEL
// hosts file sets beside localhost, all carrying loopback's meaning.
// Exact spellings rather than a prefix rule, because a localhost* pattern
// would also swallow names like localhost.example.com, which the network
// may answer for (d163).
var guaranteedBogonNames = map[string]bool{
	"localhost.localdomain":   true,
	"localhost4":              true,
	"localhost4.localdomain4": true,
	"localhost6":              true,
	"localhost6.localdomain6": true,
}

// parseEgressConfig is the one strict reader for an egress object, shared by
// exit.json's process table and a relay row's own table (docs/d078/d236): a
// second parser would be a second truth about what "empty" means.
func parseEgressConfig(raw, what string) (egressConfig, error) {
	var cfg egressConfig
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return egressConfig{}, fmt.Errorf("%s must be a JSON object {\"denyCidrs\": [\"169.254.169.254/32\"], \"allowCidrs\": [\"10.1.2.0/24\"], \"ports\": [443]}: %w", what, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return egressConfig{}, fmt.Errorf("%s has content after the JSON object", what)
	}
	if len(cfg.DenyCidrs) == 0 && len(cfg.AllowCidrs) == 0 && len(cfg.Ports) == 0 && !cfg.RefuseIPLiterals {
		return egressConfig{}, fmt.Errorf("%s names no range, port or switch — the defaults need no egress block", what)
	}
	return cfg, nil
}

// egressConfig is the config-data half of the policy (VPN-R38): the ranges an
// operator reserves, the exceptions inside them, and the port set that
// replaces the 80/443 default when present.
//
// WHY reservations are opt-in data rather than a default table: the default is
// "route IP traffic" (a VPN's job), so refusing a range is an operator
// decision about their own network. The one refusal that is not a decision is
// guaranteedBogonCidrs — space that can never answer — and that is code.
type egressConfig struct {
	// DenyCidrs reserves ranges: a resolved or literal address inside one is
	// refused unless AllowCidrs carves it back out. Absent means no
	// reservations, so private and link-local space is reachable.
	DenyCidrs []string `json:"denyCidrs,omitempty"`
	// AllowCidrs is the exception list for DenyCidrs (an explicit allow wins
	// over the operator's own reservation, d073 VPN-R35's rule).
	AllowCidrs []string `json:"allowCidrs,omitempty"`
	Ports      []uint16 `json:"ports,omitempty"`
	// RefuseIPLiterals restores the form-level refusal of address targets
	// (the pre-v5 default). Absent means address targets are dialed like
	// names; the guarantee and the reservation table answer either way.
	RefuseIPLiterals bool `json:"refuseIPLiterals,omitempty"`
}

// hostLookup is the exit's one DNS path (VPN-R36): dialValidated resolves
// through this and nothing else.
type hostLookup interface {
	LookupIPAddr(dialCtx context.Context, host string) ([]net.IPAddr, error)
}

// defaultHostLookup fills every new policy's resolver. Tests swap it in
// TestMain for a table over the suite's alias names — the door refuses
// `localhost`/`.localhost` before any lookup (d163), so a test that must
// reach a loopback upstream by name dials its alias instead, and no test
// may let the host's DNS decide a policy outcome: an accidental lookup has
// to fail as NXDOMAIN, not as a packet leaving the machine.
var defaultHostLookup hostLookup = net.DefaultResolver

// egressPolicy is the parsed, ready-to-check form. Zero value is not usable;
// build with newEgressPolicy so bad config data fails loudly (NFR-2).
type egressPolicy struct {
	deny           []netip.Prefix
	allow          []netip.Prefix
	ports          map[uint16]bool
	refuseLiterals bool
	resolver       hostLookup
}

func newEgressPolicy(cfg egressConfig) (*egressPolicy, error) {
	p := &egressPolicy{ports: make(map[uint16]bool, len(defaultEgressPorts))}
	for _, c := range defaultDenyCidrs {
		prefix, err := netip.ParsePrefix(c)
		if err != nil {
			return nil, fmt.Errorf("internal: bad default-deny CIDR %q: %w", c, err)
		}
		p.deny = append(p.deny, prefix)
	}
	for _, c := range cfg.DenyCidrs {
		prefix, err := netip.ParsePrefix(c)
		if err != nil {
			return nil, fmt.Errorf("egress denyCidrs %q: %w", c, err)
		}
		p.deny = append(p.deny, prefix)
	}
	for _, c := range cfg.AllowCidrs {
		prefix, err := netip.ParsePrefix(c)
		if err != nil {
			return nil, fmt.Errorf("egress allowCidrs %q: %w", c, err)
		}
		p.allow = append(p.allow, prefix)
	}
	ports := cfg.Ports
	if len(ports) == 0 {
		ports = defaultEgressPorts
	}
	for _, port := range ports {
		if port == 0 {
			return nil, errors.New("egress ports must not include 0")
		}
		p.ports[port] = true
	}
	p.refuseLiterals = cfg.RefuseIPLiterals
	p.resolver = defaultHostLookup
	return p, nil
}

// allowAddr answers the policy question for one resolved address
// (VPN-R35): default-deny, operator allow wins.
func (p *egressPolicy) allowAddr(ip netip.Addr) bool {
	ip = ip.Unmap() // IPv4-mapped v6 (::ffff:127.0.0.1) must not slip past v4 rules
	inDeny := false
	for _, d := range p.deny {
		if d.Contains(ip) {
			inDeny = true
			break
		}
	}
	if !inDeny {
		return true
	}
	for _, a := range p.allow {
		if a.Contains(ip) {
			return true
		}
	}
	return false
}

func (p *egressPolicy) allowPort(port uint16) bool {
	return p.ports[port]
}

// targetVerdict is the pre-dial decision for one CONNECT target: the stable
// CONNECT_ERR reason the target must die with, or "" when the dial path may
// take it. It reads no DNS — the door runs it before any lookup, and the
// resolution half (VPN-R36) stays below in dialValidated.
//
// The order is the policy (d163): guaranteed refusals answer first, so no
// knob can re-enable a name or an address with no possible answer on the
// other end; then the form switch an operator may have set to refuse address
// targets; then the port set. The reservation table is consulted after
// resolution instead, because that is where the addresses are — and a literal
// target is checked against it here, being already an address.
func (p *egressPolicy) targetVerdict(host string, port uint16) string {
	if isBogonName(host) {
		return errReasonBogon
	}
	if addr, ok := parseIPLiteral(host); ok {
		if isGuaranteedBogon(addr) {
			return errReasonBogon
		}
		if p.refuseLiterals {
			return errReasonTargetIP
		}
		if !p.allowAddr(addr) {
			return errReasonDenied
		}
	}
	if !p.allowPort(port) {
		return errReasonPortDenied
	}
	return ""
}

// splitConnectTarget parses and validates a CONNECT target "host:port".
// Host sanity mirrors the the authenticated relay's authority rules (d073 §4): no userinfo, no
// path/escape tricks, length-bounded — the target reaches DNS and a socket,
// so anything that is not plainly a host:port pair dies here (VPN-R20).
// Port is mandatory: a CONNECT without one would need an implicit default,
// and every tunnel target carries one (VPN-R21).
func splitConnectTarget(target string) (host string, port uint16, err error) {
	h, p, err := net.SplitHostPort(target)
	if err != nil {
		return "", 0, fmt.Errorf("%w: target %q is not host:port", ErrProtocol, target)
	}
	if h == "" {
		return "", 0, fmt.Errorf("%w: target %q has no host", ErrProtocol, target)
	}
	if len(h) > 253 || len(h) < 1 {
		return "", 0, fmt.Errorf("%w: target host length %d out of bounds", ErrProtocol, len(h))
	}
	for _, r := range h {
		if r == '@' || r == '/' || r == '\\' || r == '%' || r == ' ' || r < 0x21 || r > 0x7e {
			return "", 0, fmt.Errorf("%w: target host %q contains an illegal character", ErrProtocol, h)
		}
	}
	n, err := strconv.ParseUint(p, 10, 16)
	if err != nil || n == 0 {
		return "", 0, fmt.Errorf("%w: target port %q is not a valid port", ErrProtocol, p)
	}
	return h, uint16(n), nil
}

// parseIPLiteral reports whether a CONNECT host is already an address, and
// returns it as spelled. The trailing dot is DNS's root anchor, so
// "1.2.3.4." is the same target spelled as a name: trimming it here is what
// keeps that spelling from dodging the address rules by failing the parse
// (VPN-R22 — one classification for one target, whichever door asks).
func parseIPLiteral(host string) (netip.Addr, bool) {
	addr, err := netip.ParseAddr(strings.TrimSuffix(host, "."))
	return addr, err == nil
}

// dialValidated is VPN-R20/36 in one function: resolve the name ONCE with
// the system resolver, apply the policy to EVERY returned address, pin the
// first allowed one, and dial that pinned address (never the name — a second
// lookup is exactly the rebinding window this closes).
func dialValidated(dialCtx context.Context, p *egressPolicy, host string, port uint16) (net.Conn, netip.Addr, error) {
	ips, err := p.resolver.LookupIPAddr(dialCtx, host)
	if err != nil {
		return nil, netip.Addr{}, resolutionError{host: host, err: err}
	}
	var chosen netip.Addr
	for _, ip := range ips {
		addr, ok := netip.AddrFromSlice(ip.IP)
		if !ok {
			continue
		}
		if p.allowAddr(addr) {
			// Unmap: LookupIPAddr reports v4 addresses in v4-in-6 form; the
			// pinned address the policy judged must be the one dialed AND the
			// one returned, or post-dial checks compare different spellings
			// of the same address.
			chosen = addr.Unmap()
			break
		}
	}
	if !chosen.IsValid() {
		return nil, netip.Addr{}, egressDeniedError{host: host}
	}
	conn, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", net.JoinHostPort(chosen.String(), strconv.Itoa(int(port))))
	if err != nil {
		return nil, chosen, dialError{addr: chosen, err: err}
	}
	return conn, chosen, nil
}

// egressDeniedError is the policy verdict (distinct from resolver/transport
// failures so the CONNECT_ERR reason and the lifecycle log say "denied",
// not "failed" — the operator's action differs).
type egressDeniedError struct{ host string }

func (e egressDeniedError) Error() string { return "egress policy denied " + e.host }

// resolutionError and dialError keep the three CONNECT_ERR vocabularies
// (denied / resolve-failed / dial-failed) separable WITHOUT the caller
// string-matching errors — classification by type, not by text.
type resolutionError struct {
	host string
	err  error
}

func (e resolutionError) Error() string { return "resolve " + e.host + ": " + e.err.Error() }
func (e resolutionError) Unwrap() error { return e.err }

type dialError struct {
	addr netip.Addr
	err  error
}

func (e dialError) Error() string { return "dial " + e.addr.String() + ": " + e.err.Error() }
func (e dialError) Unwrap() error { return e.err }

// egressFailureReason maps a dialValidated error onto the stable
// CONNECT_ERR reason set (VPN-R20/R35/R37 — reasons are vocabulary the
// relay node and the log rely on, so they are produced in exactly one place).
//
// The As checks are inline on purpose: each family is classified here and
// nowhere else, so a named predicate would be a second spelling of the same
// question with only this switch, plus tests, as callers.
func egressFailureReason(err error) string {
	var denied egressDeniedError
	var resolve resolutionError
	switch {
	case errors.As(err, &denied):
		return errReasonDenied
	case errors.As(err, &resolve):
		return errReasonResolve
	default:
		return errReasonDial
	}
}
