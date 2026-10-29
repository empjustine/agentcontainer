---
id: d090
type: decision
status: accepted
title: "d090 — tunnel env, one spelling per fact: VPN_TUNNEL_URL speaks the ladder's wire forms, operator credentials split by node"
parent: llm-reverse-proxy
depends-on: [d073, d077, d078, d081, d084, d085, d088]
references: [d071, d080]
---

# d090 — tunnel env: one spelling per fact

## Problem

The tunnel's env surface carries two facts in the wrong spellings, and both
fail the same law from opposite directions — a fact must have exactly one
name, on exactly one side.

**1. `VPN_TUNNEL_URL` is spelled `ws`/`wss` for a ladder whose wire forms are
`https` and `http`.** The scheme has been a canonical form since d077: each
carrier rewrites it internally (`openPOST` requires `wss` and rewrites to
`https`; `openExchange` maps `ws→http`, `wss→https`; `wsDial` speaks
`ws`/`wss` directly). So the config *works* for modes C/D/E — but only if the
operator writes a deliberate fiction: an h2-only or h1-only endpoint with no
WebSocket support at all must still be configured `wss://`, and the README
and `run.sh` gate teach that fiction as the whole story. Worse, the fiction's
one real inconsistency is caught lazily: mode C cannot run without a TLS leg,
so `ws://` + `-modes c` fails per-CONNECT with an *empty*
`no offered mode survived (fail-closed VPN-R26):` — a config error routed
around like censorship instead of refused at startup (NFR-2).

**2. `VPN_OPERATOR_TOKEN` has two roles on two nodes.** It is the relay
node's bearer (the credential it presents on every mode's auth point) and,
via d078 §2's back-compat clause, the exit node's implicit `"default"`
principal — merged in `operatorKeysFromEnv`, dup-checked against
`VPN_OPERATOR_KEYS`, and OR-ed into d084's arming signal
(`operatorCredentialInEnv`). One variable, read by both sides, with a merge
path, a collision path, and an arming path that a stray TOKEN on an
exit-node host turns into a boot failure. The merge existed to make d078's
migration a two-step vault edit; the migration is done.

## Decision

### 1. `VPN_TUNNEL_URL` accepts the URL's honest wire form

`relayConfigFromEnv` accepts all four standardized schemes — `http`, `https`,
`ws`, `wss` — and **normalizes once, immediately after `url.Parse`**:
`http→ws`, `https→wss`. Everything downstream (`wsDial`, `alpnNegotiate`,
`openPOST`, `openExchange`, `validate`, `/healthz`, the startup log) keeps
speaking the canonical two and is untouched. One spelling per fact lives
*inside* the binary; the honest spelling lives at the boundary the operator
crosses.

This is not d071's alias violation: d071's law is one spelling per env
**name**. A URL scheme is part of a standardized *value* space, and the
normalization point is exactly one function — there is still precisely one
internal spelling, and no second env var, no per-mode URL fields, no carrier
change.

The fallback ladder needs nothing: `dialTransport`'s C → D → E demotion
(d077 §4, d081's floor amendment) already does the right thing once the URL
is honest. An operator running C/E only writes `https://host/path`; mode D
probes the upgrade, gets refused, and demotes to E exactly as it would
through an upgrade-stripping gateway.

### 2. Mode C requires TLS, checked at startup

`relayConfig.validate()` gains one cross-check: the offered mode set
containing `c` requires the normalized scheme to be `wss` — h2's TLS leg is
mode C's floor (d077 §3). `ws://`/`http://` + `-modes c` becomes a startup
refusal before any listener binds (VPN-R26), replacing the lazy empty-error
path. `openPOST`'s own defensive `wss` check stays as a backstop.

### 3. Operator credentials split by node, one role each

- **`VPN_OPERATOR_KEYS` is the exit node's principal set and nothing else**
  — the JSON object of d078 §2, parsed and validated exactly as today.
- **`VPN_OPERATOR_TOKEN` is the relay node's bearer and nothing else** —
  the single token it presents on the Authorization header, exactly as today.
- **d078 §2's back-compat merge retires.** `operatorKeysFromEnv` reads
  `VPN_OPERATOR_KEYS` alone. The arming signal (`operatorCredentialInEnv`,
  d084/d085) keeps its OR — it answers "did the operator opt in?", not
  "what does this node read?" — so a TOKEN-only exit node arms and is then
  **refused loudly at `enableTunnel`** with the migration spelled out,
  never silently unarmed and never silently merged.
- **When both are set on an exit node, `KEYS` wins and `TOKEN` is ignored
  there.** Refusing would break a native host that runs both roles from one
  shared environment (exit + local relay, one vault round-trip) — and the
  ignored variable is not silent for long: it is the relay node's credential,
  and the relay node on that host is reading it.
- The relay node reads `VPN_OPERATOR_TOKEN` only; a keyset-only relay host
  fails `validate()` with "no operator token" — loud, already.

The migration is **zero-wire**: the bearer bytes never change, only which
vault variable holds them on the exit side (`{"default": "<same token>"}`).
Safe order is the one d078's merge was built for, reversed: vault edit first
(both spellings work on the old binary), then binary upgrade (TOKEN-only
exit now refuses loudly).

## Requirement deltas (restated with citations)

- **d078 §2 "Back-compat" (retired here)** — the `VPN_OPERATOR_TOKEN` →
  `default` merge and its collision check are struck; `VPN_OPERATOR_KEYS`
  alone is the exit node's credential. d078's body keeps the history
  (d071's law — records keep the names of the day).
- **VPN-R26/R31 (unchanged, applied)** — a TOKEN-only exit node refuses
  startup with the migration hint; an unparsable keyset refuses exactly as
  before. Fail-closed, loud, before the surface exists.
- **VPN-R44 (unchanged)** — credentials stay env-only; this record moves a
  value between two env names, and adds no config field, no log line, no
  second copy.
- **d084/d085 arming (semantics kept, comment corrected)** — the keyset env
  remains the opt-in; the OR detector detects intent, `enableTunnel`
  enforces the exit node's spelling. Tri-state `tunnel.enabled` untouched.

## Alternatives rejected

- **Keep `ws`/`wss`-only and document it harder** — the fiction works, but
  the error message, README, and `run.sh` gate would all keep teaching a
  scheme the wire never uses for C/E, and the empty per-CONNECT failure for
  `ws://` + `-modes c` survives. Status quo loses on operator error surface.
- **Keep the URL as-given plus derived per-mode forms in `relayConfig`** —
  two fields that can drift; every consumer (health, log, validate) would
  have to choose which to print. The normalization point is cheaper and
  cannot drift.
- **A second env var per plane** (`VPN_TUNNEL_HTTP_URL`, …) — two facts,
  two vars; the exact fragmentation this record exists to remove.
- **Merge the other way: relay reads `VPN_OPERATOR_KEYS` and picks an id** —
  the relay is a single-principal client and the wire is one
  `Authorization: Bearer` header; a keyset on the dumbest node buys id
  management nobody needs. Split-by-role is the collapse, not a merge.
- **Refuse an exit node that carries both vars** — correct for two-node
  deployments, fatal for a native host running both roles from one shared
  env; `KEYS`-wins + relay-reads-`TOKEN` keeps both deployments honest.
- **Drop `TOKEN` from the arming OR** — a TOKEN-only exit would then be
  silently unarmed (d085's silent-death trap, exactly); the OR + loud
  refusal at `enableTunnel` is the fail-loud half.

## Phases

1. **This record + index** (docs/d090; README index row; d078's index row
   annotated "back-compat retired by d090" — d078's body untouched).
2. **Code** — `relaynode.go` (four-scheme accept + normalize; `validate`
   C⇒`wss` check), `tunnelserver.go` (`operatorKeysFromEnv` reads KEYS
   alone; migration-hint error), `main.go` (env-surface comment; arming
   comment), `run.sh` (relay gate hint becomes the accepted scheme set; exit
   container allowlist drops `VPN_OPERATOR_TOKEN`; header comment), unit
   `README.md` env-surface row.
3. **Tests** — scheme-normalization table; `validate` cross-check
   (C-on-cleartext refuses before bind); `operatorKeysFromEnv` TOKEN-only →
   migration-hint error, both-set → KEYS wins; an https-only endpoint e2e
   proving the C → D-demote → E ladder on the generalized URL.

## Code deltas

- `relaynode.go` — `relayConfigFromEnv` accepts `http`/`https`/`ws`/`wss`,
  rewrites to the canonical pair immediately; `validate` gains C⇒`wss`;
  comments point at d090 instead of re-teaching the mapping.
- `tunnelserver.go` — `operatorKeysFromEnv` drops the `TOKEN` merge and
  collision check; the "no operator credential" error names the migration.
- `main.go` — `operatorCredentialInEnv` keeps the OR, comment states the
  detector/enforcer split; the env-surface comment block states the
  disjoint roles.
- `run.sh` — `wss://host[/<funnel-mount>]/vpn` hints become the four-scheme
  accepted set; `workload_env_allowlist` for the exit node drops
  `VPN_OPERATOR_TOKEN`.
- No wire change, no config-file change, no carrier change, no change to
  `dialTransport`'s ladder.

## Acceptance

- `https://host/vpn` + default `cde`: starts; a mode C session opens when
  the endpoint offers h2; an h1-only endpoint demotes C → D → E and the
  session opens on E — the ladder, on an honest URL.
- `http://host/vpn` + `-modes e`: cleartext mode E session opens.
- `https://host/vpn` + `-modes c`: starts, C negotiates (ALPN path
  unchanged — normalization made `https` indistinguishable from `wss`).
- `ws://host/vpn` + `-modes c`: startup refusal naming the C⇒TLS rule,
  before any listener binds.
- `ws://`/`wss://` configs behave byte-for-byte as before (normalization is
  idempotent on them).
- Exit node with `KEYS` only: unchanged, including attribution and the
  constant-time full scan.
- Exit node with `TOKEN` only: boot refuses with the `{"default": …}`
  migration hint (arming still detects the intent).
- Exit node with both: starts, `KEYS` authenticates, `TOKEN` ignored there;
  the local relay on the same host still authenticates with it.
- Relay node with `KEYS` only: `validate()` refuses — "no operator token".
- Existing suite green.
