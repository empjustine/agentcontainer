---
id: d186
type: architecture-design
status: active
title: "d186 — retire the legacy full-catalog decision notes (d004–d015)"
parent: architecture
depends-on: [d001]
references:
  [
    d003,
    d004,
    d005,
    d006,
    d009,
    d010,
    d012,
    d013,
    d014,
    d015,
    d108,
    d119,
    scoped-models-and-proxy-overrides,
  ]
tags: [generators, retirement, provider-config, documentation]
---

# d186 — retire the legacy full-catalog decision notes

## Status

Its consequence that retired notes keep their files on the `docs/` root is superseded by d232: deprecated decisions now move to `docs/archive/`. Retirement record. The code the nine notes describe had already left the tree;
nothing here changes behavior. It exists so the notes can move to `deprecated`
without a reader losing the law they recorded.

## Problem

Nine records from the free-tier generation era were still `status: active`
while every mechanism they describe was gone:

- **d004** — provider-id renaming and the `METADATA_PROVIDER_MAP` bridge.
- **d005** — Google dynamic discovery over the generated `/models` fetch.
- **d006** — the virtual-cost heuristic.
- **d009** — per-provider `fetchAuth` schemes and `modelIdPrefix` stripping.
- **d010** — the `opencode-go-pricing.json` documented-cost override.
- **d012** — intermediate raw JSON dumps under `./cloud-llm/`.
- **d013** — removing non-working "free" providers from the filter list.
- **d014** — dropping paid-only "freeish" providers from the filter list.
- **d015** — the `cloud-llm/api-gateway` credential-injecting gateway.

A reader landing on one of them learned a design the code no longer has. The
scoped-models rationale (`coding-agent/scoped-models-and-proxy-overrides.md`)
had distilled their one-line essence but left their lifecycle untouched, so the
graph still presented them as current.

## Decision

The nine notes retire to `status: deprecated`; each carries a `## Status`
line naming this record. What replaced the mechanisms they describe:

- **A scoped catalog replaces the generated one.** The generators emit only
  provider overrides (`baseUrl` + `apiKey`) for pi's built-in providers, and
  pi uses its own catalog (`pi update --models`). There is no client-side
  `/models` fetch, no free-tier filter, no catalog merge and no catalog dump —
  which is why the id bridge (d004), the Google discovery (d005), the auth and
  prefix quirks (d009), the provider pruning (d013, d014) and the raw dumps
  (d012) have no successor mechanism to restate. The current shape is
  `coding-agent/DESIGN.md`; the rationale is the scoped-models doc.
- **Costs come from the catalog, not a heuristic.** pi's cost tracker reads the
  built-in catalog pricing, so the virtual-cost formula (d006) and the
  documented-cost table (d010) are replaced by that one source.
- **The gateway's role moved twice and is gone.** The api-gateway's
  credential-injection role moved to the reverse proxy and then to the SSL-VPN
  tunnel (d108); the one raw catalog the generators read is the vendored
  `lib/models.dev.api.json`, not a worktree dump (d012, d015).

The law these notes pointed forward at is **not** retired: d001 (proxy env,
plain un-prefixed key naming, `baseUrl` baking) and d003 (generation-time
context-window embedding) stay in force and are the records the current code
cites.

## Consequences

- A search for any retired decision still finds it, with the replacement in
  view: the note's body is history, its `## Status` line points here.
- The nine keep their numbers and files — the dNNN log stays one chronological
  shelf in `docs/` — and only their lifecycle value changes.
- No code, configuration, or living-doc behavior is affected; this is a
  documentation correction that closes drift the generators had already left.

## Alternatives rejected

- **Deleting the nine**, as the scoped-models doc said they "can be removed".
  The standard keeps a superseded decision as `deprecated` history rather than
  deleting it; deletion would lose why the free-tier pipeline existed.
- **Rewriting the notes' bodies into the scoped-models doc.** A record is never
  rewritten wholesale to change what was decided (d072/FR-D2); the successor
  records the replacement, the old body stays its own moment.
