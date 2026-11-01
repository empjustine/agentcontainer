---
id: d103
type: architecture-design
status: accepted
title: "d103 — the relay may parse cleartext HTTP/WS: byte visibility is the invariant, not the blind-pump shape"
parent: d073
depends-on: [d073, d080, d094, d095]
references: [d047, d077, d088]
tags: [proxy, tunnel, vpn, http, security]
---

# d103 — the relay may parse cleartext HTTP/WS

**Status: accepted.** Documentation-only: this record settles what an
implementing change is allowed to do, and the loopback surface still answers
405 to absolute-form requests until that change lands. The estige code is
under concurrent change for other work, so the implementation is its own diff
and it owns the tests the Verification section asks for.

## Problem

Two constraints of this deployment collide on one loopback port.

- **Where the relay runs, the payload does not get out on its own.** The LLM
  inference request shape (`POST …/completions` and its family) does not
  cross the restricted network the relay node sits on — that blockage is the
  reason the tunnel exists.
- **Where the exit runs, the edge cannot serve both surfaces at once.**
  Tailscale Funnel is the TLS terminator, and what it serves is
  prefix-route-based HTTPS reverse proxying (mode A's shape — the property
  that keeps the internal network from being scanned "for free" and drops
  undesirable internet radiation at the edge). It does not support the HTTP
  `CONNECT` method as a forward-proxy surface, and the one dynamic upgrade it
  does support is the WebSocket the tunnel rides (d073's feasibility verdict,
  "CONNECT-inside-WebSocket"). So there is no edge surface that could give
  plain `http://`/`ws://` targets a route of their own: forward traffic of
  every shape has to ride the tunnel's TLS-protected route.

Against that, the chain step (d095) exports the conventional `HTTP_PROXY`
spelling, and a client honoring it for a cleartext `http://` URL sends an
**absolute-form** request to the relay's loopback listener. Today that request
dies on a 405, because d080's Decision says the surface "stays a byte pump
that never parses an absolute-form request". The practical result — verified
against a live relay — is that plain HTTP never reaches the vpn-exit at all:
it fails loudly (no silent leak, but no route either).

Before keeping or dropping the blind-pump property on this surface, it needs
its honest accounting:

- **Against the relay host it buys nothing for cleartext.** The bytes sit in
  the relay process's address space whether or not the code parses them; a
  hostile relay reads them either way.
- **Against the origin it buys nothing.** An `http://` origin sees plaintext
  by construction — that is what `http://` means.
- **Against the network it buys nothing that parsing would cost.** The tunnel
  already carries these bytes as framed payload inside its own TLS; whether
  the relay's HTTP layer looked at them one hop earlier does not change what
  anyone between the nodes can see.

What cleartext HTTP can still lose is **where it travels** — a routing
property, not a parsing property. The naive completion of the HTTP premise
("anything in the middle is trusted") is wrong and this record does not rely
on it; the weaker, true half is enough: parsing by an already-trusted loopback
component creates no new visibility class, while delivering the bytes to the
wrong place creates exactly the exposure the tunnel exists to prevent.

## Decision

**The relay's loopback forward-proxy surface may parse, rewrite, and forward
absolute-form `http://` and `ws://` requests over the same tunnel path
`CONNECT` and SOCKS5 already use. The "must be a blind TCP pump" requirement
is dropped for that cleartext surface.** d080's "never consults a host set"
half stands untouched; its "never parses an absolute-form request" half is
superseded here.

The requirement the dropped one is replaced by is a **party-visibility
invariant: the actual bytes must be visible only to parties that are VPN or
localhost.** Concretely, per leg:

- **Loopback leg** — the listeners stay loopback-only (VPN-R23), so the only
  parties that ever see these bytes in the clear are the local client and the
  relay process itself.
- **Relay ↔ exit leg** — the bytes ride inside the tunnel's TLS (the funnel
  route this traffic is given because the edge offers it no other): the
  Funnel edge and every hop between the two nodes see ciphertext; only the
  two VPN endpoints see the frames.
- **Exit ↔ origin leg** — the wire the client addressed: `http://` origins
  see what `http://` means (the origin is a party the client chose), and
  `https://`/`wss://` targets stay untouched (below).

What this record does **not** drop — each still binds:

- **VPN-R25 (no TLS termination, no MITM)** — `https://` and `wss://`
  targets keep riding `CONNECT` as opaque bytes the relay never opens. The
  relay still terminates no TLS, holds no certificate for any target, and
  mints none.
- **VPN-R19 as scoped here** — the tunnel's framing relay and every TLS
  payload stay uninspected, unbuffered, unlogged; cleartext parsing happens
  only at the loopback surface, before framing.
- **VPN-R26 (fail-closed)** — the tunnel opens first and a refusal answers
  locally; there is still no direct-dial path. An absolute-form request must
  fail the same way a refused `CONNECT` does.
- **d080's host-policy verdict** — no allowlist and no per-target host check
  arrive with the parsing; the exit node's egress table (default-deny CIDRs,
  operator ports, resolve-once-and-pin) stays the only egress policy.
- **d094's chain stays blind** — that is the relay's own tunnel-leg chain, a
  different leg with its own visibility question; provider requests still
  never ride it.

### Why this simplifies the proxy components

The implementation's to write; the decision's to justify. With parsing
allowed, the cleartext path uses ordinary HTTP server/client machinery instead
of hand-rolled wire rewrites, and three properties fall out that a raw byte
pump cannot give:

- **One rewrite, done by a real HTTP message writer** — origin-form
  request-target, `Host` preserved, `Proxy-*` and hop-by-hop headers
  stripped, instead of bytes the pump forwards as they arrived.
- **Connection pinning made explicit** — one tunneled exchange per client
  connection with `Connection: close` forced. A hijacked raw pump pins the
  connection to target A while HTTP keep-alive legally lets the same client
  connection ask for host B next; a pump cannot detect that misdelivery, a
  forwarding layer simply never hands out a reusable connection.
- **The `ws://` upgrade is an explicit 101 path** — not bytes the pump
  hopes are an upgrade.

## Consequences

- Plain `http`/`ws` from a chain child reaches the vpn-exit through the
  tunnel once implemented; the exported `HTTP_PROXY` spelling (d095) becomes
  true for cleartext URLs instead of 405-ing them. Until then this record
  states intent, not behavior — said rather than papered over.
- The relay process becomes a *reader* of cleartext provider credentials and
  bodies for `http://` targets. The visibility class is unchanged (they were
  already plaintext in that process's memory and at the origin), but the code
  change must never let the reader role grow TLS-adjacent duties: VPN-R25 is
  the fence, not the byte-pump phrasing.
- d073's feasibility verdict, trust-model discussion, VPN-R19, and VPN-R24
  carry amendment pointers to this record; d080's Decision, rejected
  alternatives, and Verification carry narrowing pointers. No record is
  renumbered and no requirement number changes (d072's curated history).
- Unchanged by this decision: `vpn-relay.sh`, `vpn-exit.sh`, the tunnel
  framing, `tunnelserver.go`'s CONNECT phase, `egress.go`, the transport
  ladder, d094's chain, and d095's chain step.

## Alternatives rejected

- **Keep the 405 and route cleartext HTTP over the SOCKS leg instead**
  (`ALL_PROXY=socks5h://…` with `HTTP_PROXY` unset) — that works today for
  curl and python, but Go's `net/http` and Node's `NODE_USE_ENV_PROXY` ignore
  `ALL_PROXY`, so the chain step's most common children still fail. It would
  make the one env spelling the restricted network speaks depend on which
  language the child is written in.
- **Absolute-form forwarding *with* the d047 host allowlist** — d080's
  rejected alternative stands in full: the coupling of every request to a
  generated route row is what was rejected, not the parsing.
- **Giving these routes TLS termination instead** (relay- or edge-minted
  certificates) — that is mode A's property, where the proxy sees plaintext
  the client believes protected; for the tunnel family the client validates
  the payload's own certificate, and a proxy-minted certificate is the MITM
  VPN-R25 forbids. It would also ask the funnel edge for exactly the
  capability this deployment's starting constraint says it does not have.
- **Leaving the blind-pump claim in the docs while the code parses anyway** —
  the drift class d080 was written to prevent; this record exists so code and
  records agree.

## Verification

When the implementing change lands:

- an absolute-form `http://` request at the loopback listener is answered
  from the tunnel, not 405;
- a refused or dead tunnel produces a local problem detail for that request
  too — never a direct dial (the VPN-R26 ordering is the same as CONNECT's);
- `https://` still rides `CONNECT`, and no code path opens those bytes;
- the response forces `Connection: close` — one tunneled exchange per client
  connection, no cross-host reuse of a pinned tunnel;
- a `ws://` upgrade answers 101 and then pumps bytes, still loopback-only;
- an IP-literal absolute-form target is refused by the exit node's policy
  verdict, not dialed (resolution and pinning stay server-side);
- no host-allowlist table is reachable from the loopback surface — d080's
  Verification keeps its teeth, its 405 clause alone being superseded.

Until then: a live relay answers 405 to absolute-form requests.
