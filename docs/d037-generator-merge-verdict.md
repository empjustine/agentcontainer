---
id: d037
type: architecture-design
status: implemented
title: "d037 — generator merge verdict: cloud generators unify, the rest stay split"
parent: architecture
references:
  - d023
  - d024
  - d030
  - d033
  - d036
depends-on:
  - coding-agent
---

# d037 — generator merge verdict: cloud generators unify, the rest stay split

**Status:** implemented (narrow merge) · **SIMPLE.md's broad claim: rejected**

## The claim under test

A prior run proposed (SIMPLE.md) broadly merging most `coding-agent/`
generators into a single generator "so that it would be simpler", and claimed
the two cloud generators merge at ~48% line reduction with low risk.

## Verdict

**Broad merge: does not hold.** The five generators produce four different
output schemas and consume disjoint inputs:

| Generator | Output schema | Input |
|---|---|---|
| generate-local-llama-swap | pi layer, llama-swap peer entries (`meta.llamaswap`, PEER_API_KEY bearer) | llama-swap /v1 listing |
| generate-cloud-*(pi-native + alternative) | pi layers ×2 shapes (reroute-only override / full blocks) | live /models listings, models.dev + catwalk + hyper catalogs |
| generate-opencode.jsonc | opencode V1 config (different schema entirely) | models.dev catalog |
| generate-default-model | settings.json overlay (d036: operator-hardcoded) | settings source only |

The shared machinery is *already* extracted (`gen-lib.mjs`, `lib/peer-probe.mjs`,
`lib/pi-models.mjs`, the fact tables). Merging the remaining per-concern
bodies would couple unrelated failure domains (a llama-swap probe hiccup
killing opencode-config emission) for zero dedup. SIMPLE.md's own "not
recommended" section already defends the layered models.json merge on the
same grounds; the same reasoning applies to the generator bodies.

**Narrow merge: holds, implemented.** The two cloud generators really do
duplicate the cascade skeleton — parallel direct probes, peer path-route
probing, catalog read with fallback, per-layer artifact writes. They merge
into **one table-driven generator** (`generate-cloud-providers.mjs`) with a
`mode: "override-only" | "full"` column (d030 option 6):

- `override-only` (pi-native set): direct-reachable ⇒ emit *nothing* (pi's
  built-in routing stays); peer-usable ⇒ `providerReroute` with filtered
  models from the live listing, else bare catalog ids.
- `full` (alternative set): direct-reachable ⇒ full block at the real
  endpoint (with live-listing sync when the key exists + facts enrichment);
  peer-usable ⇒ the same full block at the peer route; unreachable ⇒ nothing.

## Correction to SIMPLE.md's estimate

The ~48% reduction is optimistic. What disappears is the duplicated cascade
scaffolding (~120 lines) and one stage in `generate.sh`/`run.sh`; what cannot
disappear is the metadata derivation (thinkingLevelMap/effort maps, hyper
facts enrichment, per-model compat mirrors) and the override-only model
scoping. Net effect: one cascade home, one fewer generator file, one fewer
stage — not half the lines. The emitted layers are byte-identical in shape
(same `model-012/015/016/017` filenames), so `merge-models-json.mjs` is
untouched.

## Files

- `coding-agent/generate-cloud-providers.mjs` — NEW, the unified generator
- `coding-agent/generate-cloud-pi-native-providers.mjs` — retired
- `coding-agent/generate-cloud-alternative-providers.mjs` — retired
- `coding-agent/generate.sh` — one cloud stage instead of two
- `coding-agent/run.sh` — mount list updated
- `docs/d033` — generator names updated (cascade + layer shapes unchanged)

The other SIMPLE.md items (host↔container staging, gen-kit, env allowlist)
are flow concerns, not generator merges; d030 option 4/5 already shipped and
option 1/2 stay tracked in d030, not re-decided here.
