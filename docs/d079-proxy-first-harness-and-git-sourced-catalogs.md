---
id: d079
type: architecture-design
status: draft
title: "d079 — generator inputs: proxy-first harness transport, git-sourced catalogs"
parent: coding-agent
depends-on: [d063, d070, d073, d077]
references: [d027b, d028, d038, d052, d065, d072, d074]
tags: ["generators", "routing", "proxy", "tunnel", "catalogs", "git", "draft"]
---

# d079 — proxy-first harness transport, git-sourced catalogs

**Status: draft.** Nothing in this record is implemented. It proposes two
independent deltas that compound: **(1)** harnesses reach providers through
the tunnel client's local CONNECT endpoint instead of install-time
base-URL rewriting; **(2)** the two catalog refresh legs (models.dev,
catwalk) take their input from pinned git clones instead of relay-routed
HTTP fetches. Both shrink the generator's external dependency surface by
**consolidating onto dependencies that are already mandatory** — GitHub
(the repo is hosted there) and the local tunnel client (built, d077) —
rather than carrying additional fail-able endpoints. §4 restates the deltas
with citations; §6 lists the verification items that gate implementation.

## 1. Premise — fold optional dependencies into existing MUSTs

Already-mandatory, per repo evidence:

- **GitHub.** The repo lives there; `docs/` cites a reference farm of
  mirrors (`git/-forge-mirror.sh` — bare mirrors from any https forge,
  idempotent; `git/maintain-mirrors.mjs`; legacy `git/-github-clone.sh`)
  and `~/Downloads/references/github` as a convenience cache, never the
  canonical (`docs/coding-harness-persistence.md:95`, `docs/d028`).
- **The tunnel client.** Loopback-only listeners (`d073` VPN-R23, built),
  CONNECT that terminates at the real origin (`d073` §5.1).
- **The secrets chain.** Unchanged (`d046`, d073 VPN-R32).

Currently carried *in addition*: install-time base-URL substitution and
its verification (`d070`), the relay base chain
(`REVERSE_PROXY_BASE_URLS`, `d063` §5), and two live catalog endpoints
fetched through that chain (`d027b`). Each is an extra failure class with
its own code, env, and prose (DESIGN.md's "cloud reachability" matrix axis
exists mostly to route *around* them).

**The counter-law stays in force:** `d027b` finding 2 — a
generation-time transient must never become a hard generation failure
("generation is how you fix things"). Consolidation here changes *where
inputs come from*, never *whether missing inputs stop generation*: both
deltas keep the stale-copy / best-effort / loud-log semantics exactly as
they are.

## 2. Delta 1 — proxy-first harness transport

### 2.1 Shape

The harness is launched with `HTTP_PROXY`/`HTTPS_PROXY` (or the
equivalent tool-specific proxy setting) pointing at the tunnel client's
loopback CONNECT listener; the harness then speaks canonical upstream URLs
directly. Two consequences make this strictly better than rewriting:

- **End-to-end trust improves.** CONNECT carries SNI/Host to the origin, so
  the harness validates the *real* provider certificate — the d073 VPN-R28
  posture (system roots, no override) now covers harness→provider hops too,
  where install-time substitution left the harness trusting whatever cert
  the intercepting hop presented.
- **Canonical stays canonical.** Artifacts keep `d070`'s canonical URLs
  unconditionally; no install-time rewrite, so there is no "installed" shape
  to diverge from the committed shape.

pi honors `HTTP_PROXY`/`HTTPS_PROXY` (pi `docs/environment-variables.md`);
other harnesses are a §6 verification item.

### 2.2 What retires on adoption

- `generate.mjs` route substitution + zero-canonical verification
  (≈ lines 225–360).
- Both "no `REVERSE_PROXY_BASE_URLS` → refuse" guards
  (`generate.mjs:350`, `generate-pi-coding-agent.mjs:1766`).
- `check-routed-artifacts.mjs --installed` and its `run.sh` gate — the
  installed-vs-committed comparison collapses once installed == committed.
- Vault base-chain probing as a *base-URL* concern
  (`route-probe.mjs` base-chain half; `generate-pi:136`,
  `generate-opencode:104`).
- DESIGN.md's "cloud reachability" matrix axis, halved: harness reachability
  is now one local listener, not per-base reachability.

### 2.3 What survives, and why

- **The layer cake** (`d065`): base URL is one input; key hubs, license
  gating, and deliberately-omitted compat schemas are orthogonal axes.
- **Lineup bounding** (`probeRoutes`): still needed to know *which*
  providers exist — retargeted at canonical hosts via an explicit proxy
  dialer (§6), not through relay bases.
- **`providerReroute`'s rationale**: it becomes the *fallback* regime's
  documentation (mode A, `d073`) rather than the primary path.
- **Credentials** (`d052`): untouched.
- **Mode A stays a fallback** (`d073`): route machinery is demoted to
  fallback-only, not deleted — deletion needs its own retirement record.

### 2.4 The guard moves — and must stay loud

`d070`'s install-time zero-canonical check is the loud-failure guarantee
(NFR-2) that a harness never silently talks direct. Under proxy-first the
same guarantee becomes a **launch-time env-shape check in
`coding-agent/run.sh`**: refuse to start a harness unless the proxy env
vars are present, well-formed, and aimed at the expected loopback
listener. Without this, the failure mode silently degrades from
"misconfigured install (refuses)" to "harness bypasses the tunnel
(direct egress)" — the exact regression `d070` was written to prevent.

### 2.5 Preconditions

- Per-harness proxy support (§6).
- Node fetch ignores proxy env without an explicit undici `ProxyAgent` —
  `route-probe.mjs` gains one (the harness ride uses its own client, this
  is only the probe path).
- Generation-time reachability precondition changes from "relay bases
  reachable" to "tunnel client running" — no boot-order regression: probes
  still skip-and-log on failure (`d027b` finding 4's probe-failure
  semantics preserved).

## 3. Delta 2 — git-sourced catalogs (models.dev, catwalk)

### 3.1 Today

Two refresh legs, both relay-only by rule (`d063`), both best-effort into
committed snapshots:

- `refresh-models-dev.mjs` (205 lines): candidate chain over
  `MODELS_DEV_RELAY_URL` or `REVERSE_PROXY_BASE_URLS` (`relayCandidates`,
  `route-probe.mjs:194`), `/api.json?type=all`, 15 s timeouts,
  consumed-shape validation, tmp+rename; `generate.mjs:410–432` logs
  "using vendored copy" on any failure.
- `catalog-facts.mjs` (428 lines, catwalk leg within): same skeleton for
  `https://catwalk.charm.land/v2/providers` — relay-only, TLS-skip rule,
  age-stamped cache → `lib/catwalk-facts.json`.

Consumers read the committed `lib/` copies (`lib/models.dev.api.json`
shared with `llm-reverse-proxy/generate.mjs`; `lib/catwalk-facts.json`
via `gen-lib`); the vendored copies are what generation actually depends on.

### 3.2 Proposal

The refresh **source** becomes a pinned git clone — bare mirror via the
existing `git/` tooling (storage: `--depth 1`/`--filter=blob:none` where
the farm layout allows), of:

- `github.com/charmbracelet/catwalk`
- `github.com/anomalyco/models.dev`

The **interface does not move**: committed `lib/` JSON stays what
consumers read; validation, atomic rename, and the stale-copy rule stay
byte-for-byte in force. Only the *update path* changes from HTTP chain to
`git fetch`.

### 3.3 Verdict — honest, per source

- **catwalk: clean win.** The data is JSON in-repo
  (`internal/providers/configs/<provider>.json`, 41 providers ≈ d028's
  `/v2/providers` observation — §6 verifies parity). Aggregation
  (read-dir → normalize → age-stamp) replaces the whole fetch chain:
  relay candidates, timeouts, TLS-skip, env-proxy for that leg.
- **models.dev: conditional.** The repo publishes its *source* as TOML
  (`providers/<p>/provider.toml`, `providers/<p>/models/<m>.toml`,
  `models/...`); the consumed `api.json?type=all` is a **built** artifact
  of their bun/sst stack (no release artifacts found). Options:
  **(a)** keep this leg on HTTP (status quo for one source);
  **(b)** run their build from the clone (endpoint dependency → toolchain
  dependency; rejected, heavier than what it replaces);
  **(c)** a small in-repo assembler over the pinned TOML (adds a TOML
  parser + coupling to upstream *internals* — but a pinned commit makes
  upstream refactors a controlled, validation-gated update absorbed at our
  cadence, not a live-API surprise; the consumed-shape validation we
  already run is exactly the breakage tripwire). Draft leans (c) **only if**
  the assembler is smaller than the 205-line script it replaces; else (a).
  §6 decides.

The contract nuance, stated plainly: HTTP `api.json` is a public contract;
the TOML tree is internal layout. Pinning is what makes the internal layout
acceptable — but if §6's sizing says the assembler is not a simplification,
**models.dev stays on HTTP** and the record still wins on catwalk + §3.5.

### 3.4 What does not simplify (by law, not oversight)

Validation, atomic rename, stale-copy fallback, and provenance stamping
stay for *both* sources — `d027b` finding 2 binds unchanged. The clones
are the update path, never a generation precondition: clone fetch failure
logs and advances with the last good snapshot, exactly as today.

### 3.5 What it buys beyond line-count

- **Provenance and reproducibility:** `fetchedFrom` becomes an exact
  commit SHA; a pinned source means identical inputs for identical
  artifacts — today's live endpoint can change under a generation run
  (reviewable only as an unexplained artifact diff, d072's diff-discipline
  itch).
- **One update tool** matching the existing MUST (the premise), including
  its failure semantics — git is already exercised and maintained on every
  host (`git/` farm tooling).
- **Egress synergy with §2:** git honors `HTTPS_PROXY`/`http.proxy`, so
  after proxy-first even an egress-restricted host refreshes catalogs
  through the tunnel — the relay chain stops being the reachability story
  for catalogs too.
- **Compounding:** with §2 retired as harness path and this delta retired
  as catalog path, `REVERSE_PROXY_BASE_URLS` loses its generator consumers
  and can leave the generation env entirely (lineup probes remaining —
  which §2.3 retargets).

### 3.6 Why this is not the proposal `d027b` rejected

`d027b` rejected routing the fetch through the relay: it "would replace
one HTTP endpoint with another, not delete the file handling" (finding 5),
and warned against coupling generation to live liveness (finding 2). This
record differs only where it actually **deletes machinery** — catwalk's
chain, and models.dev's only under option (c) — while inheriting finding 2
verbatim (§3.4). Where upstream publishes source instead of the consumed
artifact (models.dev option (a)/(c) territory) it risks being `d027b`'s
trap with git branding; §6's sizing check is the guard against that, and
"a clean win for one source, status quo for the other" is an acceptable
outcome for this record.

## 4. Deltas restated (draft; with citations)

- **`d070` (implemented)** → superseded *on hosts adopting §2*:
  install-time substitution retires; its zero-canonical guarantee is
  re-homed as `run.sh`'s launch-time proxy-env check (NFR-2 loud failure
  preserved, §2.4). `d070`'s first clause — canonical URLs in committed
  artifacts — is *strengthened*, not changed.
- **`d063` (implemented)** → "refresh is relay-only" becomes
  "refresh is git-source-first"; the relay chain survives only for a
  catalog with no usable git source (today: models.dev, provisionally).
  Harness routing obeys §2, not base chains.
- **`d027b` (accepted)** → unchanged; finding 2 (best-effort, stale copy,
  never clobber) and finding 4 (probe failure skips, never aborts) bind
  both deltas verbatim (§1, §3.4).
- **`d073`/`d077`** → unchanged; they *provide* what §2 rides (VPN-R23
  loopback listeners, mode D/C transports). No new mode is introduced.
- **New:** catalog refresh source = pinned git clones of the two named
  repos; `MODELS_DEV_RELAY_URL` retired; harness launch precondition =
  proxy env wired to the tunnel listener.

## 5. Implementation surface (not in this draft)

`coding-agent/`: `generate.mjs` (substitution, guards), `generate-pi-`,
`generate-opencode.mjs` (guards, base-chain probe), `route-probe.mjs`
(ProxyAgent dialer; base-chain demoted), `refresh-models-dev.mjs`,
`catalog-facts.mjs` (source swap), `check-routed-artifacts.mjs`,
`run.sh` (env-shape guard). Reuse `git/` farm tooling for mirrors.
Amendment notes to `d063`/`d070` land only when implemented.

## 6. Verification items (gate implementation)

1. **catwalk parity:** in-repo `configs/*.json` == served
   `/v2/providers` payload; aggregate matches `lib/catwalk-facts.json`
   (41 providers / ~2,400 models per `d028`).
2. **models.dev sizing:** prototype option (c)'s assembler vs the 205-line
   script; pick a TOML parser per dep policy; frozen-shape test against the
   vendored `lib/models.dev.api.json`. Output: adopt (c) or keep (a).
3. **Harness proxy matrix:** pi documented; opencode / Cline / Thinkrail —
   confirm exact proxy env/settings semantics (SOCKS vs HTTP, `NO_PROXY`
   handling).
4. **Probe path:** undici `ProxyAgent` for `route-probe.mjs`; lineup
   parity (same provider set as the relay path today).
5. **Mirror footprint:** bare-mirror size for both repos (models.dev carries
   thousands of TOML files + logos); farm location + retention conventions
   (`git/audit.mjs` participation).
6. **Restricted-egress refresh:** git fetch through the tunnel
   (`http.proxy` / `HTTPS_PROXY`) on a no-direct-egress host.

## 7. Non-goals

- Retiring mode A or the relay (`d073` fallback stays; this record only
  shrinks the generator's coupling to it).
- Changing catalog content schemas, consumer contracts, or the vendored
  `lib/` locations (`d025`).
- The secrets/vault chain (`d046`) — untouched either delta.
- The per-provider facts legs of `catalog-facts.mjs` — provider endpoints
  are inherent content dependencies, not git sources; out of scope.
