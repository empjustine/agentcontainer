---
id: d064
type: decision
status: implemented
title: "d064 — LLM provider support tiers: first-class / best-effort / superficial"
parent: d063
depends-on: [d027, d033, d063]
references: [d038, d040, d047, d057, d063]
tags: [providers, support-tiers, generators, reverse-proxy, policy]
---

# d064 — provider support tiers (first-class / best-effort / superficial)

**Status:** implemented

## Problem

Ten providers sit in the fleet fact table and every one of them is treated
identically: probe it, compute its lineup, ship its metadata, care when it
breaks. That uniformity is a claim nobody made. Some providers this setup is
built around (the subscription rows, the local learner), some are conveniences,
and some exist because the reverse proxy serves them and the fact table
documents them — nothing more. When one breaks, the response should follow
what was promised, not what the code happens to do.

Relatedly: llama-swap routing is **temporarily down** (every funnel route
answered 502 while this record was applied), and the repo needs a place to
say which regressions are urgent, which are acknowledged, and which are
simply the documented state of a superficial row.

## Decision

### 1. Three tiers, declared in the one fact table

`lib/cloud-providers.mjs` gains a `support` field per row plus a
`supportTier(id)` helper (`"llama-swap"` — the local learner, not a cloud
row — is first-class; anything outside the fleet table defaults to
superficial). One table, because [d024](d024-generators-split-and-provider-facts.md)
already made this file the single place provider facts live; per-generator
tier lists would be the duplicated decision the repo forbids.

| Tier | Providers | Contract |
|------|-----------|----------|
| **first-class** | `cline-pass`, `hyper`, `verboo`, `opencode-go`, `llama-swap` (local) | fully computed lineups (live/facts/catalog cascade); regressions are fix priorities; outages preserve the last good artifact (stale-preserve) rather than dropping models |
| **best-effort** | `google` (ai studio), `mistral`, `inferx`, `openrouter` | same cascade, still route-probed wherever a probe can mean something; fixed when convenient, never a priority |
| **superficial** | `opencode` (zen), `nvidia` | supported at the REVERSE-PROXY level (d047 allowlist row) and present as metadata; NOT smoke-tested; lineup = catalog slice only; metadata may be stale or wrong and that is accepted; not a fix priority |

"Superficial" is deliberately honest about [d063](d063-proxy-only-routing.md)'s
machinery: the row still emits a proxy-routed entry (never omitted — d063 §3
applies to every tier), but nothing validates that the route answers or that
the computed provider/model metadata is valid end-to-end.

### 2. Tier consequences per consumer

- **pi generator**: superficial override-only rows skip
  `probePeerRoutes` entirely and go straight to the minimal catalog reroute
  at the proxy URL. Skipping the probe IS the "not smoke tested" statement —
  probes are the generators' only liveness mechanism, and a tier that is not
  promised liveness should not spend 8 s proving it.
- **opencode generator**: same skip for `opencode` (zen);
  `opencode-go` (first-class) and `openrouter` (best-effort) keep their
  probes.
- **first-class + best-effort**: unchanged from d063 — probes choose the
  lineup, never the route.
- **llm-reverse-proxy**: serves every tier identically. Tiers are a
  GENERATION-time expectation contract; the serving side keeps
  [d047](d047-llm-reverse-proxy-host-allowlist.md)'s deny-by-absence host
  allowlist with no knowledge of them.
- **Emission is tier-independent**: no tier may cause a provider to be
  omitted (that would restore built-in direct routing — d063 §3).

### 3. Known issue + documented follow-up: llama-swap routing is down

**Known issue (this record's lifetime):** all funnel routes — including
`/llama-swap/v1/models` — answer 502, so fresh local lineups cannot be
probed. Mitigation is exactly the first-class stale-preserve:

- `generate.mjs` now stages committed `model-*.json` layers into the
  scratch dir (d063 consequences), so a failed local probe leaves the
  previous `model-010-local-default.json` in the merge instead of silently
  deleting llama-swap from the installed artifact;
- `generate-opencode.mjs` carries the previous `local` entry forward from
  the output file it is about to rewrite when the probe fails (the same
  "output left untouched" semantics model-010 has, applied to the one entry
  whose lineup exists nowhere else).

**Follow-up (documented, NOT applied here):** all tsnet-connected proxy
instances must later be repointed at the internal bazzite tsnet route. This
record only records it — the repoint is a deployment change with its own
verification, and mixing it into a policy record would hide it in a diff.

## Consequences

- Adding a provider is now two decisions: the fact-table row (d032) and its
  tier. A new row without `support` fails type-checking rather than
  defaulting silently — the tier must be chosen.
- Superficial rows can rot without CI noticing; that is the accepted price
  of the tier (the alternative — smoke tests for rows nobody is responsible
  for — is the uniform-cost world this record rejects).
- The tier vocabulary supersedes nothing: d040/d057's per-provider lineup
  contracts read unchanged, they simply sit under first-class now.

## Alternatives rejected

- **Two tiers (supported / unsupported)** — collapses the real middle:
  best-effort rows are probed and worth repairing, superficial rows are not.
- **Tier determines emission** — a superficial provider left out of the
  artifact falls back to pi/opencode built-in DIRECT routing (d063's core
  breach); tiering must never reach into emission.
- **Tier encoded per generator** — two lists drifting apart is exactly the
  d024 re-declaration problem the fact table was built to end.
- **Tiering at the proxy** — serving behavior must not depend on
  generation-time metadata; the allowlist is about hosts, not promises.
