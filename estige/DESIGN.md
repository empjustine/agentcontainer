---
id: estige-design
type: module-design
status: active
title: "estige — design: tunnel transports, the 404 policy, error taxonomy"
parent: estige
tags: ["serving", "proxy", "design"]
---

# estige — design rationale

Rationale that is not graspable from `main.go` at a glance: why the funnel
answers the way it does for everything that is not a tunnel, how tunnel-side
failures are reported, and what the deleted reverse proxy left behind.
Operation (usage, build, ports) lives in [README.md](README.md); the
requirement statement is FR-S5 in [../docs/requirements.md](../docs/requirements.md);
the transport requirements are [d188](../docs/d188-tunnel-contract.md)'s.

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
deployment, and h2-post-unbounded's unauthenticated tunnel probes. No JSON, no URN, no
distinctive header: a differential body would confirm to a prober that custom
software lives here, and a client from the deleted deployment learns nothing
about why its old route stopped working. Mistakes are debugged from the
Combined Log Format line, which records each request, and from the session
records beside it (docs/d106): an open/close pair per session on both nodes,
joined by one id, carrying the matched key, the carrier, the target, byte
counters and the outcome — never the credential and never a forward URL's query.

## Error reporting (RFC 9457)

Only failures _inside_ the tunnel produce a problem detail, and only to a
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
- No egress without policy: the exit node resolves and pins a named target and
  enforces the egress table before the first byte leaves. The default posture
  routes IP traffic (d242): only space that can never answer a connection is
  refused out of the box, private and link-local ranges are ordinary
  destinations, and an operator reserves ranges with `exit.json`'s
  `egress.denyCidrs` (with `allowCidrs` as its exception list, and a relay row
  able to narrow its own — docs/d078/d236/d242). The port set defaults to
  80/443.
- No silent degradation: a node that is not armed refuses to boot rather than
  binding a port that answers 404 to everything (docs/d084's kill-switch law),
  and a degraded relay posture exists only behind `-insecure-exit` (docs/d171).
  The exit's state is readable on its own loopback surface (`-status-listen`,
  docs/d106), never on the funnel face.

## The SSL-VPN transport family (docs/d073, delivered in phases)

The requirements for the family grew out of the reverse-proxy era and are
owned by [d073](../docs/archive/d073-ssl-vpn-three-modes.md), not this file. The
feasibility verdict there is the load-bearing part: Tailscale Funnel does
**not** support the HTTP `CONNECT` method as a general tunnel, but it does
support the WebSocket upgrade, so the tunnel is `CONNECT`-inside-`wss`. The
trust-model table in d073 explains why the tunnel transports can drop the
client's trust in the middle where the allowlist and authenticated relays
cannot — and that table is the reason the reverse proxy is now deleted
(docs/d108).

Roles are named by network position, not protocol role (docs/d088): the
**exit node** (free internet + tsnet to the LLM endpoints, installed as
`estige.service` on Oracle Linux or the Termux runit service) and the
**relay node** (local restricted-internet deployment, installed as
`estige-relay.service`; `estige proxy-env` prints the chain-step spelling for a
child, docs/d095). Inside the tunnel protocol itself the ends stay
"client"/"server" — wire roles, not deployments — and `relay.go`'s byte pump
is shared verbatim by both nodes.

## Deployment boundary: packages, not launchers

The deployment used to be two POSIX launchers plus a 328-line workload
description library and six jq filters. That surface did jobs the service
manager already does better — select a container or native shape, start a
process, restart it, wait for readiness, hand it an environment — while
putting a second copy of the workload API in this unit, making `node`/`jq`
prerequisites for a Go service, and forcing the operator to read shell to
learn which credential a role reads.

The boundary is now: the binary starts, the service manager supervises, the
package owns host integration. `vpn-exit.sh`, `vpn-relay.sh`,
`lib/workload-runtime.sh` and `lib/workload-*.jq` are deleted, not wrapped. No
config file grew in their place: the Termux runit `run` script sources
`$PREFIX/etc/estige/env`, systemd reads `/etc/estige/estige.env` through
`EnvironmentFile=`, and the binary still sees only environment variables
(docs/d108/d110).

Two units, not one `estige@.service`: the roles carry disjoint host keys and
pairing files (`exit.json` vs `relay.json`, d236) and disjoint listeners (the
funnel port vs loopback CONNECT/SOCKS5). A template would need per-instance
store indirection and would still ship two different `ExecStart=` shapes;
two readable units state the boundary directly (docs/d090). The env files are
`%config(noreplace)` / conffiles, so upgrades do not overwrite operator edits,
and both units ship an empty `CapabilityBoundingSet` — a low port is an explicit
operator drop-in, not a silent grant.

The container image survives (it is still the artifact for a container host),
packaged from the host-built binary by `go run build.go` and launched by
`go run run.go` (d236). The in-process launch does not: the operator runs it
with their own service manager, or systemd unit. That is why the workload API is
no longer a dependency of this unit — the frontmatter edge is gone.
