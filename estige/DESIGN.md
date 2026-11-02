---
id: estige-design
type: module-design
status: active
title: "estige — design: tunnel transports, the 404 policy, error taxonomy"
parent: estige
depends-on: [workload-api]
tags: ["serving", "proxy", "design"]
---

# estige — design rationale

Rationale that is not graspable from `main.go` at a glance: why the funnel
answers the way it does for everything that is not a tunnel, how tunnel-side
failures are reported, and what the deleted reverse proxy left behind.
Operation (usage, build, ports) lives in [README.md](README.md); the
requirement statement is FR-S5 in [../docs/requirements.md](../docs/requirements.md);
the transport requirements are [d073](../docs/d073-ssl-vpn-three-modes.md)'s.

> **The reverse proxy is gone (docs/d108).** The v2 host-allowlist routing
> convention — host-key table, client-carried base path, the generated
> `allowHosts` — is deleted, not deprecated in place: a TLS-terminating edge
> sees plaintext provider keys, and d073's trust table shows no credential
> scheme fixes that. The mode's history (and why the shape forced
> route-rewriting generator machinery) is [d047](../docs/d047-llm-reverse-proxy-host-allowlist.md)
> and [d108](../docs/d108-serving-edge-tunnel-only.md); nothing below depends
> on it.

## One reserved path, everything else is the funnel 404

The tunnel family owns exactly one path, `/vpn` (docs/d085 — the Funnel mount
prefix is stripped at the edge, so the process only needs one fixed place to
dispatch on). Dispatch is an exact-path test, not a prefix table: there is one
namespace and no ordering question left to get wrong (VPN-R42).

**Every other path answers the identical tailscale-funnel 404** — plain-text
`404 page not found` (Go-default body, `text/plain; charset=utf-8`, `nosniff`).
That includes `/`, garbage, a stale reverse-proxy route from an older
deployment, and mode C's unauthenticated tunnel probes. No JSON, no URN, no
distinctive header: a differential body would confirm to a prober that custom
software lives here, and a client from the deleted deployment learns nothing
about why its old route stopped working. Mistakes are debugged from the
Combined Log Format line, which records each request.

## Error reporting (RFC 9457)

Only failures *inside* the tunnel produce a problem detail, and only to a
caller that already authenticated: a bad-gateway condition during the egress
exchange, a hijack that failed, a malformed CONNECT target. The same body
shape serves both nodes:

```json
{
  "type": "hijack-failed",
  "title": "…",
  "status": 500,
  "raw": "the verbatim Go error",
  "instance": "/vpn"
}
```

The old `type: "urn:…:error:<code>"` URN and a separate `code` member said the
same thing twice; the type IS the bare cause token now (RFC 9457 resolves
relative type URIs, so this is a valid problem type). Classification is
best-effort but the verbatim error is always attached as `raw`, and families
that have one add a canonical, non-secret dump as `details` (operator-known
facts only: host names, resolver addresses, flags — never keys or request
bodies). Unknown-path probes are answered by the funnel 404 above, never by a
problem detail: the distinction between "internal failure" and "not a tunnel
path" is exactly the oracle the 404 policy exists to remove.

## What the tunnel does not do to the exchange

- No request or response rewriting beyond what the transport requires; the
  relay node's localhost CONNECT/SOCKS5 proxies hand the target's own
  certificate to the client, so TLS verification is end-to-end and the nodes
  are never in the trust path.
- No credential handling for the target: the client's provider keys ride
  inside the tunnel's TLS and are never seen by the exit node's policy layer.
- No egress without policy: the exit node resolves and pins the target and
  enforces the egress table (default deny for RFC 1918/metadata/loopback,
  ports 80/443; operator opt-ins arrive as `VPN_TUNNEL_EGRESS` until d104's
  store carries them — docs/d108) before the first byte leaves.
- No silent degradation: a node that is not armed refuses to boot rather than
  binding a port that answers 404 to everything (docs/d084's kill-switch law).

## The SSL-VPN transport family (docs/d073, delivered in phases)

The requirements for the family grew out of the reverse-proxy era and are
owned by [d073](../docs/d073-ssl-vpn-three-modes.md), not this file. The
feasibility verdict there is the load-bearing part: Tailscale Funnel does
**not** support the HTTP `CONNECT` method as a general tunnel, but it does
support the WebSocket upgrade, so the tunnel is `CONNECT`-inside-`wss`. The
trust-model table in d073 explains why the tunnel transports can drop the
client's trust in the middle where the allowlist and authenticated relays
cannot — and that table is the reason the reverse proxy is now deleted
(docs/d108).

Roles are named by network position, not protocol role (docs/d088): the
**exit node** (free internet + tsnet to the LLM endpoints, `vpn-exit.sh`) and
the **relay node** (local restricted-internet deployment, `vpn-relay.sh` —
serve it, or ride it as the chain step that points a child at it, docs/d095).
Inside the tunnel protocol itself the ends stay "client"/"server" — wire
roles, not deployments — and `relay.go`'s byte pump is shared verbatim by
both nodes.
