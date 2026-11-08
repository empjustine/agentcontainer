---
id: d146
type: module-design
status: draft
title: "d146 — subnet routes: CIDR claims ride the ACCEPT session; IP literals match a live claim or are refused at the rendezvous"
parent: estige
depends-on: [d073, d104, d131, d145]
references: [d080, d123, d132, d144]
tags: ["estige", "tunnel", "forwarding", "routes", "subnet", "socks5", "claims", "v4"]
---

# d146 — subnet routes over SOCKS5

This record proposes the CIDR claim form of
[d145](d145-relay-remote-port-forwarding.md)'s remote port forwarding:
a relay that wants CIDR forwarding includes `routes` — `{cidr, ports}`
entries — in the claim set of its standing ACCEPT session, and a SOCKS5 or
HTTP CONNECT client at any admitted relay reaches addresses inside them
through d145's gate: match, event, re-check. It is the operator's side of a Tailscale
subnet router without a TUN device and without a control plane. It does
not cover TUN or any layer-3 transparency, UDP or ICMP (the pump is byte
streams), discovery or route propagation (the session that carries the
identity carries the routes), or the host-form claims (d145). The
decision: routes are claims on a live session — never configuration at
either end — the exit matches IP literals match-or-refuse with VPN-R22
restated below, and the relay re-checks its current claims before it ever
dials.

## Status

**Draft**, like every estige-v4 record: it extends d145's claim grammar
and match rule, so the implementing change names both records, and it
restates VPN-R22 on d073 under Requirement deltas. One code-level change
belongs here too: the relay's own IP-literal refusal at its proxy doors
relaxes to pass-through, noted under Decision. d132 takes no delta —
routes land in no config file at either end; a relay's claim seed is
d145's argv decision, `CLAIMS` frames mutate the live set, and routes
ride the same session from establishment onward.

## Problem

d145 makes a principal's named services reachable — `relay2:5432` across
the whole path. The other half of remote forwarding is address reach: the
NAS, the router admin page, the printer, the VM — endpoints that are
addresses in a LAN behind an admitted relay, not principal names. Today
those are refused at both ends of the path: the relay rejects an
IP-literal target at its proxy doors, and the exit never dials an address
the client picked (VPN-R22 — resolution and dial policy at exactly one
point).

The usual answer is Tailscale's subnet router: route distribution, an
ACL, and a TUN interface that makes the LAN reachable by any protocol.
None of it fits. The transports are byte streams, so layer-3 transparency
is a different product; and on hosts without root — Android and Termux
among them — there is no TUN device to open. What exists is a SOCKS5 and
CONNECT front the clients already speak, so the route arrives as a
proxy-side address scope instead of an interface.

## Decision

### Routes are claims, and claims ride the ACCEPT

The claim set d145's ACCEPT carries gains a second form:

```json
{ "ports": [5432], "routes": [{ "cidr": "192.168.1.0/24", "ports": [22, 80, 443] }] }
```

- Frame rules, refused in-band on violation: `cidr` parses as a valid
  IPv4 or IPv6 CIDR; `ports` is a non-empty list of individual ports in
  range — a pinhole set the operator reviews, so there is no wildcard
  spelling; a route's port is the port that is dialed (no rewrite);
  claim-set size caps follow d145's argv rules. A refusal is whole —
  d145's snapshot discipline: the ACCEPT tears down and the relay stays
  down until argv is fixed, because a partial acceptance would leave the
  exit holding a set it could not review as one statement.
- The argv spelling at establishment is `-R <cidr>:<ports>`: the first
  field contains a `/`, which is how the parser tells a route from a port
  spec, an IPv6 CIDR brackets itself (`-R [fd00::/64]:22,80`) because
  `:` is already the field separator, one argument is one route claim, and
  a malformed one refuses relay startup. A CIDR inside the exit's
  guaranteed-bogon space parses but is refused in-band at the exit —
  allocation-conflict, below — because the relay's argv stays policy-free
  and the exit owns the list.
- Scope-driven applies to the route form exactly as d145 states it: a
  relay opens its ACCEPT only if it was initiated with a route argument
  (`-R <cidr>:<ports>`), the
  routes live in that session's initial claim set and its `CLAIMS`
  snapshots, and closing the session withdraws them. Routes never exist
  outside a live session, so the exit needs no route store, no expiry
  timer and no reconciliation — the session is the storage.
- The grammar decides the branch before any lookup: a principal name
  contains no dot and no colon, an IPv4 literal always has the first and
  an IPv6 literal the second.

### The relay passes addresses through

The relay's IP-literal refusal at its proxy doors relaxes to
pass-through. The relay never dials an address out of a request — it
dials only what its own claims authorize — and the match can only happen
where the claims live. Named targets are unaffected.

### The match rule extends d145's targeting

For `CONNECT {target, port}` on an authenticated consumer's tunnel whose
host is an IP literal:

1. Candidates are the route claims on every live ACCEPT — there is no
   per-consumer filter yet, so key admission is the gate (d145).
2. Longest-prefix match wins. Distinct CIDRs of equal length cannot
   partially overlap, so prefix length orders every partial overlap
   uniquely and deterministically.
3. The same `{cidr, port}` claimed by two live ACCEPTs is refused with an
   ambiguous-claim reason: two authorities for one address is the
   undefined-answer problem d145 rejects for wildcard exports, and a loud
   refusal beats a tie-break nobody asked for.
4. The port must be on the winning route's list; otherwise the target
   falls through to refusal, never to the egress path.
5. No match means today's IP-literal refusal, byte-for-byte — VPN-R22's
   outcome for everything outside a live claim.

A match then runs the decided part of d145's bridge: `EVENT` through
the ACCEPT pipe, the relay's re-check of its current claims, `DECLINE`
on a miss — how a hit is then served is d145's Open item.

### The exit's guaranteed bogons are exit-owned

Some address space can never terminate the connection a route claim
would offer, and the exit owns it without being asked. The guaranteed
bogons: IPv4 `0.0.0.0/8` (this network), `127.0.0.0/8` (loopback),
`255.255.255.255/32` (limited broadcast), `224.0.0.0/4` (multicast — no
TCP dial can answer it), and IPv6 `::/128` (unspecified), `::1/128`
(loopback), `::ffff:0:0/96` (the IPv4-mapped block, so no IPv4 bogon can
be re-spelled around its refusal — an IPv4 target has the plain spelling
only), and `100::/64` (discard-only).

- **Claim gate:** a route claim overlapping the space is an allocation
  conflict at the exit — the snapshot is refused in-band with the
  `allocation-conflict` reason (d106's vocabulary gains it beside
  d145's unclaimed, declined and ambiguous set) and the ACCEPT tears
  down per d145's refused-snapshot discipline, so a bogus argv never
  opens a working exporter.
- **Match gate:** a consumer target inside the space is simply unmatched
  — rule 5's byte-identical refusal answers it, indistinguishable from
  any other unclaimed literal — and a constant belt-and-braces check
  keeps it that way even against a hypothetical overlapping claim,
  which the claim gate already makes impossible. The dial never happens;
  the space is unrouteable by construction, not by current claim state.

Everything else stays claimable at the operator's discretion: the
possible bogons — `240.0.0.0/4`, the documentation ranges, ULA
`fc00::/7`, link-local, ORCHIDs, NAT64 prefixes — ride the pinhole
review, because real networks get crazy allocations in days of scarce
IPv4 and pocket, non-standard IPv6 use. The egress table (d080) keeps
its own deny list (VPN-R35) for what the exit dials; this space is about
what may be bridged, and the two surfaces stay separate.

The relay-loopback reach the refusal removes was the wrong door anyway:
d145's host-form `-R` is the unambiguous alternative, and its dial half
spells the specific loopback address (`-R 22:127.0.0.2:22`) — one
principal's service, no route table consulted. For local listeners,
d144's optional bind half adopts ssh's spelling for picking which
address out of `127.0.0.0/8` the listener binds to.

### VPN-R22 restated

Requirement delta on d073, restated with its citation — the invariant is
unchanged and the checks relocate:

- **The invariant (VPN-R22):** no address is ever dialed by a party that
  did not check it, and resolution happens at exactly one point.
- **Relay side (pass-through):** the relay stops refusing IP literals at
  its proxy doors, because it never dials them — its refusal was an early
  rejection for a path that now leads somewhere real.
- **Rendezvous side (match-then-refuse):** IP literals are matched
  against live claims and refused byte-identically otherwise; the exit
  dials nothing in either case.
- **Exporter side (re-check at dial):** before dialing, the relay
  re-verifies the address and port are in its current claim set. Both
  checks read local facts — the relay its live set, the exit its live
  session registry — so defense in depth needs no coordination, and a
  claim removed between `EVENT` and re-check wins over the in-flight
  event.
- **Resolution is untouched:** IP literals involve no DNS, and names
  that miss the match still resolve at the exit under the egress table —
  VPN-R22's single resolver, one record later.

## Consequences

### Distance from a Tailscale subnet router

Honest comparison, since the shape invites it:

- **Route distribution:** claims carried up the authenticated session
  that already exists, vs a control plane pushing routes to every node.
- **Reach:** per-claim, none by default (d145's scope-driven consent),
  vs tailnet-wide ACL rules.
- **Client interface:** SOCKS5 or HTTP CONNECT, opted into per client,
  vs a transparent TUN interface any process uses without knowing.
- **Name service:** principal names matched structurally at the exit,
  vs MagicDNS.
- **NAT:** irrelevant — every tunnel is relay-initiated outbound — vs
  traversal machinery.
- **Never coming here:** UDP and ICMP. The pump is a byte stream; UDP
  ASSOCIATE is datagram framing and belongs to whatever answers
  VPN-R17, not to this record.

### The other consequences

- The egress table (d080) is untouched: its ports answer what the exit
  may dial, the claims answer what may be bridged, and only the second
  list is dynamic.
- The guaranteed-bogon space is a constant at the exit, not
  configuration: no store entry, no knob, and d132 takes no delta for it
  either.
- Nothing to cache or invalidate: claims are session RAM, removals bind
  through `CLAIMS` snapshots at the exit and the re-check at the relay,
  and an ACCEPT close takes its routes with it (new attempts only —
  d145's survivorship rule governs connections already pumping).
- A proxy-unaware consumer that must reach a plain address needs a local
  shim — socat's `PROXY` address form speaks HTTP `CONNECT`, so it rides
  estige's CONNECT door (a SOCKS5-speaking shim would ride the SOCKS5
  door) — or a [d144](d144-relay-local-port-forwarding.md) forward per
  address — operator tooling in front of the same doors, not a new
  surface.
- Verification is the Go suite ([d123](d123-go-suite-in-the-sweep.md)): claim
  frames with unparseable CIDRs, empty port lists or out-of-range ports
  refused in-band; longest-prefix preference across overlapping live
  claims; an exact `{cidr, port}` duplicate refused with the ambiguous
  reason; an unclaimed IP literal refused byte-identical to today; a
  snapshot claiming a guaranteed bogon refused in-band with the
  `allocation-conflict` reason and the ACCEPT torn down; a consumer
  target inside the space refused byte-identically to any unclaimed
  literal, with the constant gate proving the dial never happens; an
  IPv4-mapped spelling of a claimed public address refused the same way
  (the plain spelling is the only one); a
  claimed IP with an on-list port clearing the exit's match and the
  relay's re-check; an off-list port
  refused rather than routed to egress; a `CLAIMS` snapshot removing a
  route so new attempts refuse while established connections keep
  pumping; an event for a removed route declined at the relay because
  the re-check reads the current set; a unit at the dial proving the
  relay never dials outside its current claims; an ACCEPT close dropping
  its routes entirely; and no proof or event id in any log line.

## Alternatives rejected

- **A TUN-based subnet router.** Layer-3 transparency, kernel surface,
  and a privilege the design's hosts do not have — a different product
  with a different transport contract (ICMP, UDP, raw sessions).
- **A control plane for route propagation.** The coordination this
  design refuses, moved to infrastructure: claims ride the tunnel that
  already carries the identity.
- **UDP ASSOCIATE through the pump.** Datagrams need framing the byte
  pump does not have; smuggling it in here would contradict VPN-R25's
  blind-pipe contract. If it arrives, it arrives with the mux record.
- **Wildcard ports within a route.** One claim would grant the whole
  LAN, and the reviewable pinhole set is the point of listing ports.
- **Matching routes at the consumer.** The consumer would need every
  other principal's claims to decide locally — the coordination this
  design refuses, moved to the wrong side.
- **Claims frozen at session establishment.** Updating a single port
  would require tearing down and re-establishing the session — every
  adjustment a handshake, every outage window a scope leak. `CLAIMS`
  snapshots make the set live within one session, which is the whole
  point of a mutable claim set.

## Open items

- Port ranges (`8000-8100`) in route claims if lists grow unwieldy — a
  grammar change worth taking when a list demands it.
- Per-consumer or per-pair route scoping, tied to d145's `EVENT`
  consumer field and its per-consumer Open item.
