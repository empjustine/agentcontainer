---
id: d188
type: module-design
status: active
title: "d188 — the tunnel contract: end-to-end TLS with no MITM, default-deny egress"
parent: estige
depends-on: [d073, d077]
references: [d103, d104, d105, d108, d131, d132, d133, d169, d171]
tags: ["serving", "vpn", "tunnel", "estige", "requirements", "egress", "tls"]
---

# d188 — the tunnel contract

## Status

Supersedes d073 as the live requirements register; d073 remains the
requirements-and-feasibility study and keeps the history of what was rejected.
Everything the tunnel-only edge (d108) retired is dropped here: the
allowlist-relay requirements (VPN-R1-R3), the authenticated-relay grammar and
compatibility rewrites (VPN-R4-R10, R42/R43, R53/R54), the prefix capability
(VPN-R44, reversed by d085), and the v3 deferrals that were never built (rate
limiting VPN-R45-R47; UDP VPN-R48-R52). The surviving requirements keep their
`VPN-R*` ids so the tree's citations stay meaningful.

## What the tunnel is

A TLS-tunnelled TCP relay in the "SSL VPN" sense, not IPsec and not an IP-layer
tunnel: a client opens a TLS connection to estige, which relays the client's
TCP flows to arbitrary destinations while the client's own TLS to the
destination rides through untouched. It is not a TUN/TAP interface, not IP
routing, not an exit node. The client configures a proxy (HTTP `CONNECT` or
SOCKS5) and the harness needs no other change.

## Trust and certificates

The load-bearing property: the tunnel leg presents the edge's public
certificate, and the payload TLS is end-to-end between the client and the
target because the relay never holds a certificate for the target and never
MITMs.

- **VPN-R28** — The tunnel requires no trust anchor beyond the public CA the
  edge already presents.
- **VPN-R29** — End-to-end certificate validation is preserved: a target with
  an invalid certificate fails **at the client**, not at the relay. This is the
  acceptance test that proves no MITM.
- **VPN-R30** — The relay needs no TLS termination for any transport.

## The protocol

- **VPN-R11** — The transport is the ladder (d077): **h2-post-unbounded**
  preferred, then **websocket**, then **h1.1-post-windowed**, chosen by
  protocol negotiation on the one `/vpn` path, never by the HTTP `CONNECT`
  method. The offer is the whole ladder (d187); carriers are named by
  mechanism, never by letters (d105). An edge that caps a single request body
  gets a second exit port whose requests refuse h2-post-unbounded at request
  initiation (d222): the relay learns that posture from one refusal and ranks
  websocket, then **h2-post-windowed**, then h1.1-post-windowed. The ladder is
  still one offer, not an operator selection. The exit serves one port per
  edge (`PORT`, and optionally `PORT_CLOUDFLARE`, docs/d222) and decides a
  request's edge from its own listening port, never from a request header.
- **VPN-R15** — The framing is a small, versioned, documented protocol,
  implementable in Go and Node with no third-party dependency.
- **VPN-R16** — Control frames cover `HELLO`/`HELLO_OK`, `CONNECT`,
  `CONNECTED`, `CONNECT_ERR`, `CLOSE` (half-close aware) and `PING`/`PONG`;
  data frames carry opaque bytes. The client label is non-secret identity only.
- **VPN-R17** — One tunnel stream per `CONNECT` in the v1 shape; the framing
  reserves a stream id so a muxed tunnel is additive.
- **VPN-R18** — End-to-end backpressure, a bounded frame size, and half-close
  semantics.
- **VPN-R19** — The relay must not inspect, decrypt, buffer or log payload
  bytes; its logs carry only payload-free metadata — who (the authenticated
  principal and the client label, never the credential) and where (target
  `host:port`, tunnel, bytes in/out, duration, outcome). (d103 bounds the
  loopback surface's own parsing of cleartext `http`/`ws` requests.)
  Amended by d106: the who is the matched key id on a session record, joined
  across nodes by a per-session id, and the forward door's query string is
  stripped rather than logged.

## The target connection

- **VPN-R20** — On `CONNECT` the relay resolves the target itself, applies
  the egress policy to every resolved address, pins the validated address, and
  dials it while presenting the client's original host as SNI/`Host`.
- **VPN-R21** — TCP/443 and TCP/80 targets are supported; other ports obey the
  egress policy.
- **VPN-R22** — A `CONNECT` whose target is a literal IP address is rejected:
  resolution and pinning stay server-side, with no second path that dials an
  unchecked address.

## The client and the loopback proxy

- **VPN-R23** — The client is the same binary in a client mode, unprivileged,
  bound only to loopback. d144's `-L` listeners are part of this surface and
  obey the same rule: a non-loopback bind half is refused at parse time.
- **VPN-R24** — It offers an HTTP proxy listener implementing
  `CONNECT host:port` (for `HTTPS_PROXY`) and SOCKS5 with remote-name
  resolution (for `ALL_PROXY` and non-HTTP TCP).
- **VPN-R25** — The client never terminates TLS, never holds a certificate for
  a target, and is never a MITM.
- **VPN-R26** — The client authenticates to the relay and fails closed: no
  credential, no tunnel; no tunnel, no proxying. A dropped tunnel must not
  silently leak to a direct connection.
- **VPN-R27** — A loopback health/status surface distinguishes "proxy down"
  from "upstream down". (The loopback listener is HTTP/1.1 on purpose — its h2
  refusal is d073's recorded rationale.) Amended by d106: the relay's
  `/healthz` reports the live session set beside the endpoint and last
  error, and the exit node gains an optional loopback-only `/status`
  (`-status-listen`, off by default) so the same question is answerable on
  the other node without touching the funnel face.

## Authentication and secrets

- **VPN-R31** — The tunnel authenticates the _operator_, never the upstream:
  credentials are the relay's own, distinct from the client-owned provider
  keys. Amended by d104: the credential is mutual Ed25519 proofs — each
  direction signed by its own principal's key, the verifier holding only
  public keys, no shared secret on the wire. Until that lands, the v3 bearer
  is the credential, and each named principal may carry its own egress table
  (d078) so one leaked token does not inherit every relay's reach.
- **VPN-R32** — Key material lives in a role-scoped store on the host that
  holds it (never env, never git, never through the vault chain step; d104,
  d131-d133); the env carries only non-secret runtime knobs (d090, d130).
- **VPN-R33** — Credential comparison is constant-time and credentials never
  appear in logs or error bodies.
- **VPN-R34** — Any unauthenticated request to the tunnel namespace answers the
  same camouflage 404 as any other garbage path — never a 401, which would
  confirm a second service lives behind the front.

## Egress policy

- **VPN-R35** — Default-deny egress: loopback, link-local, cloud metadata,
  unspecified, multicast and RFC 1918/ULA ranges are denied unless the
  operator policy explicitly allows a CIDR.
- **VPN-R36** — Resolution is pinned and re-checked: policy applies to every
  resolved address, the dial uses a validated address, and redirects/rebinds
  cannot escape the validated set.
- **VPN-R37** — Ports are policy-controlled (default 80/443).
- **VPN-R38** — The policy is data, not code — a reviewed config diff.
- **VPN-R39** — Unauthenticated requests are rejected cheaply (before
  significant allocation), and the protocol bounds frame size and idle
  duration. Throughput quotas stay out of scope (single-user economy).

## Invariants kept

- **VPN-R40** — The relay must not store or inject provider credentials in any
  transport; the tunnel strengthens this (the payload is opaque).
- **VPN-R41** — The tunnel's authenticated egress policy is its security
  boundary, replacing the allowlist relay's deny-by-absence for this namespace
  (the allowlist relay itself is gone, d108).

## Non-goals

- Not IPsec, not an IP-layer tunnel, not a TUN device, not an exit-node
  replacement.
- Not a UDP tunnel, and not MASQUE/CONNECT-UDP conformance (the assessment and
  its edge facts are d073's).
- Not a multi-tenant control plane and not a general unauthenticated web proxy.
- Not a way to make the relay hold provider keys.

## Consequences

- The egress policy is the tunnel's security surface; the no-MITM property and
  the camouflage 404 are its two observable acceptance tests.
- A future transport joins the ladder (d077/d187); a future degraded mode stays
  behind `-insecure-exit` (d171).
- One node's state is readable without the log (d106): the relay's live set on
  `/healthz`, the exit's on its loopback `/status`, and both nodes'
  session records share an id.
- Policy that used to belong to the process can belong to a principal
  (d078); d104's store is still where it moves next.
