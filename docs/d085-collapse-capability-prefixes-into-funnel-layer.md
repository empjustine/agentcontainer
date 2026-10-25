---
id: d085
type: decision
status: accepted
title: "d085 — collapsing the capability prefixes into the Tailscale Funnel layer"
parent: llm-reverse-proxy
depends-on: [d073, d077, d084]
references: [d078, d082]
---

# d085 — collapsing the capability prefixes into the Tailscale Funnel layer

## 1. What the deployment reality showed

Two facts, both measured against the live Funnel deployment and confirmed
against Tailscale's code:

1. **The Funnel edge strips its mount prefix before a request reaches the
   backend.** `tailscale serve` wraps every non-root mount in
   `http.StripPrefix` (`ipn/ipnlocal/serve.go`, `serveWebHandler`). Measured:
   a request for `…/<funnel-id>/openrouter.ai/…` reached the proxy as
   `/openrouter.ai/…` — a 200 against a config that contains no funnel-id
   entry and dispatches on the FIRST path segment.
2. **Therefore the proxy never sees the Funnel's capability path.** If
   `VPN_TUNNEL_PREFIX` were set to it — the natural reading of "the
   capability is in the path" — `isTunnelPath` would never match: every
   tunnel request would fall through to the camouflage 404 while boot still
   logged `tunnel … enabled`. The enabled line attests configuration, not
   reachability.

The designed construction did work around fact 2 — VPN-R44 demanded a
*second* path segment beyond the mount — but the two-secret shape bred
exactly the confusion above, and its security marginality is thin (§3).

## 2. The decision

The proxy-side capability prefix is retired (VPN-R44's `${prefix}` clause
reversed):

- The tunnel family lives at one fixed reserved path, **`/vpn`** — VPN-R42's
  "one Funnel path for the family" taken literally. Mode dispatch inside the
  family stays protocol negotiation (d077 §4), unchanged.
- `enableTunnel` keeps VPN-R42's collision rule in its new form: the
  reserved name `vpn` may never be an allowlist host (startup is where
  "never" is enforceable).
- The operator keyset env (`VPN_OPERATOR_KEYS`/`VPN_OPERATOR_TOKEN`) is now
  both the whole capability and the arming signal — d084's rule amended: the
  credential is the opt-in.
- Client URL: `wss://host[/<funnel-mount>]/vpn`. The mount part is the
  edge's routing key (stripped there); `/vpn` is the proxy's dispatch key.
- The log-redaction machinery dies with the secret: CLF lines log the real
  URI, and the lifecycle line drops the `tunnel=` digest column.

Several Funnel mounts may target the same server (longest-prefix match, one
StripPrefix per mount) — so edge-side capability rotation, per-purpose
mounts, or a future mode B namespace are all just more mounts on one
backend. The proxy sees none of it and needs none of it.

## 3. Why one layer is enough — the calculus that changed

d073's options list explicitly rejected "reusing the Funnel id as the tunnel
prefix". That rejection stands for *reusing the id* (it is shared by all
clients and semi-credential in edge logs, d070) — but the two-layer design's
claimed second factor does not survive the deployment model:

- `VPN_TUNNEL_URL` + `VPN_OPERATOR_TOKEN` live in the same vault chain
  ("its whole surface" — run.sh). Theft takes both together, so the path
  secret is not an independent factor.
- Bearer theft is answered by rotation — d078's per-principal keys with
  per-key revocation — not by a second path secret.
- Edge traffic already carries a 122-bit mount capability.
- The construction demonstrably bred a silent-death trap (§1).

What is honestly lost: the direct-reach surface (the proxy listens on
:8080 and is reachable on the tailnet, bypassing the Funnel) loses path
secrecy — `/vpn` becomes probeable. Accepted: the camouflage 404 (VPN-R34)
means a probe cannot even confirm the route exists, VPN-R31 + d078 rotation
gate the rest, and tailnet ACLs remain available to the operator.

## 4. What survives, what is reversed

| Unchanged | Reversed |
|---|---|
| VPN-R31 bearer, VPN-R32 env-only, d078 principal set | VPN-R44's `${prefix}` capability-key clause |
| VPN-R34 camouflage 404 (a probe learns nothing) | the `/<prefix>/…` namespace construction |
| VPN-R42 namespace dispatch — now on the fixed reserved path | URI redaction + the lifecycle `tunnel=` digest |
| d084's tri-state `tunnel.enabled` | d084's arm env (`VPN_TUNNEL_PREFIX` → operator keyset) |
| egress policy, demotion, d081's mode E plan | mode B's deferred `${prefix}` namespace — it rides a Funnel mount |

## 5. Consequences

- `VPN_TUNNEL_PREFIX` disappears from the env surface (main.go, run.sh,
  READMEs). A deployment that had set it to the Funnel mount now works with
  no proxy-side config at all; one that had set a distinct segment simply
  stops using it.
- The boot fingerprint shrinks to `tunnel (modes C–E): enabled at /vpn`.
- d081's completion work is untouched: `/vpn` dispatch precedes provider
  parsing exactly as before.

## 6. Alternatives rejected

- **Keep two layers (mount + prefix) and document the URL shape precisely.**
  Rejected — the second factor is not independent (§3), and the shape is a
  live trap (§1).
- **A custom header as the second factor.** Rejected — one secret in a
  different place is still one secret; mTLS remains d073's deferred option
  if a genuine second factor is ever wanted.
- **Freeze, change nothing.** Rejected — the current shape is a documented
  trap that already misled the operator.
