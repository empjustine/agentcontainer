// egress.go — mode C's egress policy: what the tunnel may dial
// (docs/d073 §9: VPN-R35..R38).
//
// WHY this shape: modes A's deny-by-absence no longer covers an
// authenticated arbitrary-egress namespace, so the policy that replaces it
// has to be a reviewable DATA table (VPN-R38), not scattered conditionals.
// The default-deny set below is the requirement's own list rendered as a
// table (VPN-R35); operator opt-ins (CIDRs, ports) arrive as config data on
// top of it. S4 (d073 §13) still owns the artifact's final format and home —
// until it lands, the table lives here and overrides live in the mode C
// config block, both of which are diffable data.
//
// The pinning rule (VPN-R36) is the load-bearing invariant: resolve ONCE,
// validate every address, dial a validated address — never re-resolve —
// so a rebinding DNS answer cannot swap the destination after the check.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
)

// defaultDenyCidrs is VPN-R35's normative list, verbatim as data. These are
// denied EVEN IF they resolve for a legitimate-looking name; the operator
// opts a range back in through egress.allowCidrs (an explicit allow wins —
// that is what "unless the operator policy explicitly allows a CIDR" means,
// and it is also how the smoke test reaches its loopback upstream).
var defaultDenyCidrs = []string{
	"127.0.0.0/8",       // loopback
	"::1/128",           // loopback v6
	"169.254.0.0/16",    // link-local +169.254.169.254 cloud metadata
	"fe80::/10",         // link-local v6
	"fd00:ec2::254/128", // AWS IMDS v6 metadata
	"0.0.0.0/8",         // unspecified ("this network")
	"::/128",            // unspecified v6
	"224.0.0.0/4",       // multicast
	"ff00::/8",          // multicast v6
	"10.0.0.0/8",        // RFC 1918
	"172.16.0.0/12",     // RFC 1918
	"192.168.0.0/16",    // RFC 1918
	"fc00::/7",          // unique local (ULA)
}

// defaultEgressPorts is VPN-R37's default port policy. Ports are the
// operator's data when configured; 80/443 only when they are not.
var defaultEgressPorts = []uint16{80, 443}

// egressConfig is the config-data half of the policy (VPN-R38): opt-in
// CIDRs that override the default-deny table, and the port set that
// replaces the 80/443 default when present.
type egressConfig struct {
	AllowCidrs []string `json:"allowCidrs,omitempty"`
	Ports      []uint16 `json:"ports,omitempty"`
}

// egressPolicy is the parsed, ready-to-check form. Zero value is not usable;
// build with newEgressPolicy so bad config data fails loudly (NFR-2).
type egressPolicy struct {
	deny  []netip.Prefix
	allow []netip.Prefix
	ports map[uint16]bool
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
			return nil, fmt.Errorf("egress ports must not include 0")
		}
		p.ports[port] = true
	}
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

// splitConnectTarget parses and validates a CONNECT target "host:port".
// Host sanity mirrors the mode B authority rules (d073 §4): no userinfo, no
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

// parseIPLiteral reports whether a CONNECT host is already an address
// (VPN-R22: rejected — resolution and pinning stay server-side, so there is
// never a second, unchecked dial path).
func parseIPLiteral(host string) (netip.Addr, bool) {
	addr, err := netip.ParseAddr(host)
	return addr, err == nil
}

// dialValidated is VPN-R20/36 in one function: resolve the name ONCE with
// the system resolver, apply the policy to EVERY returned address, pin the
// first allowed one, and dial that pinned address (never the name — a second
// lookup is exactly the rebinding window this closes).
func dialValidated(ctx context.Context, p *egressPolicy, host string, port uint16) (net.Conn, netip.Addr, error) {
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
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
		return nil, netip.Addr{}, errEgressDenied{host: host}
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(chosen.String(), strconv.Itoa(int(port))))
	if err != nil {
		return nil, chosen, dialError{addr: chosen, err: err}
	}
	return conn, chosen, nil
}

// errEgressDenied is the policy verdict (distinct from resolver/transport
// failures so the CONNECT_ERR reason and the lifecycle log say "denied",
// not "failed" — the operator's action differs).
type errEgressDenied struct{ host string }

func (e errEgressDenied) Error() string { return "egress policy denied " + e.host }

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

func isEgressDenied(err error) bool {
	var e errEgressDenied
	return errors.As(err, &e)
}

func isResolutionError(err error) bool {
	var e resolutionError
	return errors.As(err, &e)
}

// egressFailureReason maps a dialValidated error onto the stable
// CONNECT_ERR reason set (VPN-R20/R35/R37 — reasons are vocabulary the
// client and log rely on, so they are produced in exactly one place).
func egressFailureReason(err error) string {
	switch {
	case isEgressDenied(err):
		return errReasonDenied
	case isResolutionError(err):
		return errReasonResolve
	default:
		return errReasonDial
	}
}
