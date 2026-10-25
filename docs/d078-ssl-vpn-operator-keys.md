---
id: d078
type: architecture-design
status: implemented
title: "d078 — SSL-VPN operator keys: a bounded static principal set carried in one JSON env value"
parent: llm-reverse-proxy
depends-on: [d073, d077]
references: [d046, d031, d052]
tags: ["serving", "proxy", "vpn", "ssl-vpn", "auth", "secrets", "json", "proposed"]
---

# d078 — Operator keys: bounded static principals

**Status:** proposed. This record amends d073 §8's credential model from one
operator credential to a **bounded set of static operator principals** — one
independent key per security principal — without changing the wire, the
camouflage, the trust model, or the tenancy stance. It is the delta d073
VPN-R31 gains; the deltas are restated below with their citations so this
record is checkable without re-reading d073 (the d077 §9 convention).

## 1. What "isolated" means here

Each principal is an independent bearer credential with exactly two isolation
properties, and deliberately no others:

- **Revocation** — removing one key from the set invalidates that principal
  alone; every other client keeps working. Today, rotating the single
  `VPN_OPERATOR_TOKEN` breaks every client simultaneously, which is the
  whole problem this record exists to solve.
- **Attribution** — a successful authentication is attributable to a principal
  id in server-side logs, so "which key was this?" is answerable.

**Not** included, on purpose: per-key scopes, per-key egress policy, per-key
namespaces, expiry, hierarchies, rate limits, or any account model. Those are
the point at which "keys" becomes "tenancy", and NFR-5 (d073 §10) still says
no tenancy; §6 records that boundary and the forward hook.

## 2. Decision — one JSON env value

The env surface grows by exactly one variable, `VPN_OPERATOR_KEYS`, whose
value is a **JSON object** mapping principal id → token:

```json
{"ops": "<token>", "laptop": "<token>", "ci": "<token>"}
```

Encoding choices, considered:

- **JSON (chosen).** The repo's config is already JSON, so the parsing
  idiom is one the code and the operator already share; tokens sit raw in
  JSON strings with no per-byte encoding step; the grammar is exactly
  specified (RFC 8259); and the object form gives ids and tokens distinct
  structural roles instead of one flattened pair syntax.
- **application/x-www-form-urlencoded (considered).** Also standardized, but
  every reserved byte in a token becomes a percent-encoding obligation at the
  vault-writing layer — an encoding requirement that can silently corrupt a
  credential. It buys nothing JSON does not, so it loses on operator error
  surface.

Invariants of the value:

- The value MUST decode to an object of string → string. A parse error, a
  non-object top level, or an **empty** object MUST refuse tunnel startup
  (VPN-R26/R31 fail-closed — an unparsable key set is a missing key set, and
  a missing key set means the surface does not exist, VPN-R2).
- Duplicate ids in the input MUST be rejected, not last-wins: a shadowed
  entry means a principal the operator believes exists does not, which is a
  silent auth change (NFR-2's fail-loudly rule).
- Every token MUST be ≥ 16 bytes, same floor as d073's current check; ids
  MUST be unique, non-empty, and shaped as log-safe labels — 1..64
  characters of `[A-Za-z0-9_-]`. Ids reach server logs (§5), so they must
  never be secret-shaped: an id is a name, not a capability (VPN-R44).
- The set MUST be bounded by a small constant cap (currently 32) and refuse
  to start above it. The cap is not a performance concern — the scan in §4 is
  linear regardless — it is the structural guard that keeps this record from
  drifting into the user directory NFR-5 forbids.

**Back-compat.** `VPN_OPERATOR_TOKEN` (d073 §6.3) keeps its meaning: when
`VPN_OPERATOR_KEYS` is unset it is the single implicit principal
`default`, byte-for-byte today's behaviour. When both are set they merge —
that is what makes migration a two-step vault edit (add `VPN_OPERATOR_KEYS`,
then drop the old variable) with no window in which any client is rejected —
and a merge that collides on `default` (or any id) MUST refuse startup.
Clients do not change at all: each machine already holds its own vaulted
token; its token simply becomes one of N.

**Why not hashed at rest.** Hashes-at-rest (config JSON holding per-key
digests) were considered and rejected: the env chain (VPN-R32) *is* the
secret store, so a digest written beside the plaintext it hashes would be a
second copy of credential material adding zero protection — precisely the
second-copy problem VPN-R44 exists to prevent. Tokens stay env-only; the
committed config gains **no new field**.

## 3. Requirement deltas (restated with citations)

- **VPN-R31 (amended)** — Modes B–E MUST authenticate *an operator principal
  from a bounded static set* (one independent credential per principal,
  shared across the B and tunnel namespaces alike), and, in mode B, the
  `${prefix}` path capability; never the upstream. Provider keys stay
  client-owned and are never injected (VPN-R6/R40 — untouched).
- **VPN-R33 (amended)** — Credential comparison MUST be constant-time **per
  entry, over every entry, with no early exit**: the scan MUST visit the
  whole set whether or not a match was found, so neither the principal's
  position nor the set's contents leak through timing. Tokens MUST NOT appear
  in logs, the Combined Log Format line, or error bodies — but the matched
  **id MAY** appear in server-side logs (§5).
- **VPN-R34 (unchanged, load-bearing)** — Wrong token, unknown id, missing
  prefix, missing header: all answer mode A's camouflage 404, byte-identical,
  with no signal distinguishing which check failed. This is what makes the
  *size* of the key set non-enumerable: nothing in the response vocabulary
  counts the keys.
- **VPN-R26/R31 (restated)** — Fail-closed per §2: empty, unparsable,
  duplicate-id, undersized-token, or over-cap input means no tunnel, loud, at
  startup — never a running surface that authenticates nobody.
- **VPN-R44 (unchanged)** — Tokens arrive only through the env chain, never
  the config file. Ids are labels, not capabilities; they are logged, the
  tokens are not.
- **NFR-5 (exception, phrased)** — The exception granted here is a *bounded
  operator key set*: still no accounts, no signup, no tenancy, no isolation
  between principals beyond revocation and attribution.

## 4. Matching, without early exit

`checkBearer`'s single-secret constant-time compare becomes a full-set scan
that returns the matched id (or none): hash/compare discipline per VPN-R33,
every entry visited, result = the id, timing ≈ (set size × one compare). With
plaintext tokens in env there is nothing to hash *for* — see §2's
rejected-hash rationale — so the comparison stays a direct constant-time
byte-compare, exactly today's primitive, looped.

## 5. Attribution lives beside the CLF, not in it

The Combined Log Format line must stay a standard CLF line — main.go's log
contract is that the output be consumable by GoAccess/ELK "without a custom
parser". Attribution therefore is one server-side log line, in the existing
`[llm-reverse-proxy] …` style, carrying the matched id at successful
authentication of a tunnel session (Mode D sessions are one per CONNECT, so
the volume is sessions, not requests; modes C/E attribute at their
authentication points under d077 §9's per-request bearer). Failed attempts
log nothing about ids (VPN-R34 — a failure must not reveal whether an id
exists).

## 6. Boundary and forward hook

Per-key *rights* (scope, egress, namespace) are explicitly out of scope. The
hook is structural only: the per-principal struct introduced by this record
may later carry a scope field, so if access isolation is ever wanted it is a
field fill plus its own decision record — not another credential-model
refactor. Until that record exists, every principal has identical rights,
and "multi-tenant" remains rejected as written (d073 §12).

## 7. Code deltas

- `tunnelserver.go` — `tunnelServer.token` → a principal slice; `enableTunnel`
  parses and validates §2 via `operatorKeysFromEnv`/`decodeOperatorKeys`;
  `checkBearer` becomes `matchOperatorKey`, returning the matched id (full
  scan).
- `main.go` — env-surface comment gains `VPN_OPERATOR_KEYS`.
- Tests — §8's acceptance list. No `tunnelproto`, no wire change, no
  config-file change, no client change.

## 8. Acceptance

- Two principals authenticate; revoking one (removing its entry) rejects only
  that principal — the other's token still opens the tunnel.
- Unknown token, known-id-wrong-token, missing header, unknown prefix →
  byte-identical camouflage 404, indistinguishable (VPN-R34).
- Malformed JSON, non-object value, empty object, duplicate id, token < 16
  bytes, set > cap → loud startup refusal; the tunnel surface does not exist
  (VPN-R26, VPN-R2).
- `VPN_OPERATOR_TOKEN` alone still works as `default`; merge with a
  colliding id refuses startup.
- Server logs contain the id on success and never a token; the CLF line's
  format is unchanged; existing suite green.
