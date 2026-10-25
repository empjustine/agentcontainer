---
id: d080
type: architecture-design
status: accepted
title: "d080 — the d047 host allowlist is mode-A-only: the forward-proxy modes carry the egress policy instead"
parent: d047
depends-on: [d047, d073, d077]
references: [d074, d078, d079]
tags: ["proxy", "tunnel", "egress", "host-allowlist", "security"]
---

# d080 — the d047 host allowlist is mode-A-only

**Status: accepted.** No code change: the tree already behaves this way. The
record exists to settle, as a verdict, the question the code left dangling —
so a future egress-hardening pass does not “finish” the allowlist onto the
forward-proxy surface.

## Problem

d047's host allowlist (deny-by-absence on the first path segment) is the
load-bearing control for the proxy's REVERSE surface (mode A): an
unauthenticated, Funnel-public edge, where the alternative to the allowlist
is forwarding to any host a catalog row names (d047 problem 1). d073's
tunnel family (modes C–E) then added a FORWARD-proxy surface — the client's
loopback HTTP CONNECT + SOCKS5 listeners (VPN-R23/R24) and the tunnel
server's CONNECT phase — whose policy was written fresh (d073 §9:
VPN-R35..R38, “the policy is the security boundary that deny-by-absence used
to be for mode A”).

Two places in the tree still read as if extending the d047 allowlist to that
surface were a pending obligation rather than a settled no:

- `client.go`'s 405-for-absolute-form comment (“forwarding absolute-form
  requests would need the v2 allowlist on this surface too”) — phrased as a
  deferral, citing a d073 requirement number that no longer carries it;
- nothing anywhere states the opposite, so nothing blocks the
  “obvious completion”.

## Decision

**The d047 host allowlist is scoped to mode A, permanently. The
forward-proxy surfaces carry no host-name policy and must never gain one:**

- the client's loopback HTTP surface answers only `CONNECT` and
  `GET /healthz` (405 otherwise) — it stays a byte pump that never parses an
  absolute-form request and never consults a host set;
- the tunnel server's CONNECT phase applies exactly the d073 §9 policy:
  parse, refuse IP literals (VPN-R22), port check (VPN-R37),
  resolve-once-and-pin dial (VPN-R36, VPN-R20) — no `allowHosts` table, no
  per-target host check;
- egress policy on this surface is VPN-R38 reviewable DATA (the egress
  table: default-deny CIDRs + operator ports), the same generated-table
  discipline d047's allowHosts follows — the policy differs, the discipline
  does not.

### Why this is the right boundary, not an omission

1. **Different question, different control.** Mode A is unauthenticated and
   public; deny-by-absence is what keeps a catalog row from minting a
   routable endpoint there. The forward-proxy path is authenticated end to
   end — loopback-only listeners (VPN-R23) plus operator-key auth
   (VPN-R26, d078's constant-time scan, VPN-R31/R33) — so the question it
   faces is “what may a credentialed principal dial”, which VPN-R35..R38
   already answer. A host allowlist there would duplicate one policy with
   another while mitigating nothing: an unauthenticated caller cannot reach
   the surface at all.
2. **Generic CONNECT is the point of the surface.** d079's proxy-first
   harness transport rides `HTTP(S)_PROXY` through the loopback CONNECT
   endpoint (d074 made node honor the env natively). A tool addressing a
   provider host canonically must be able to CONNECT to it without the
   proxy first holding a route row for it — an allowlist there would
   re-couple every client to the generated route table, the exact coupling
   the forward-proxy modes exist to delete.
3. **The name-based control point survives where it belongs.** IP literals
   are refused server-side (VPN-R22) precisely so policy applies to NAMES
   after a single server-side resolution with pinning. If a deployment ever
   needs narrower-than-port egress, VPN-R38's operator data (`allowCidrs`,
   `ports`) is the knob — not an allowlist resurrection.

## Consequences

- Egress through the forward-proxy modes is “any public DNS name on the
  policy's ports”. That is the accepted posture, owned by d073 §9 / VPN-R38,
  not an accident this record ratifies blindly: the principal is the
  operator's own keyed client on the operator's own loopback.
- d047's verdict is unchanged for mode A — deny-by-absence stays the route
  surface's control, and d079 keeps mode A as fallback, so the route
  machinery is demoted, not deleted.
- d078's per-key egress remains a forward hook; this record does not open
  it (d078 already excludes per-key rights from the key model).

## Alternatives rejected

- **Extending `allowHosts` to the CONNECT/tunnel path** — duplicates
  VPN-R35..R38 with a second data table, requires the client to parse and
  police absolute-form requests (the 405 exists to avoid exactly that), and
  breaks the generic-CONNECT transport d079 needs.
- **Absolute-form forward-proxy support on the client surface, with the
  allowlist** — the same coupling cost plus the client would have to become
  an HTTP client instead of a byte pump; no use case once env-proxy
  dispatch exists (d074).

## Verification

- `client.go`'s loopback HTTP surface: CONNECT and `/healthz` only, 405
  otherwise — no code path that could carry a host policy.
- `tunnelserver.go`'s CONNECT phase: parse, VPN-R22 refusal, VPN-R37 port
  check, VPN-R36 pinned dial — no host-name set consulted.
- `egress.go` owns the only egress data on the tunnel path (default-deny
  CIDRs + operator ports); `allowHosts` appears nowhere under it.