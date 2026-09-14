---
id: d039
type: architecture-design
status: implemented
title: "d039 — fold single-consumer lib/ modules back to their owning runner"
parent: d023
references:
  - d023
  - d037
  - d038
  - d025
depends-on:
  - coding-agent
  - llm-reverse-proxy
---

# d039 — fold single-consumer lib/ modules back to their owning runner

**Status:** implemented

## Problem

`lib/` grew into a mix of genuinely shared infrastructure and modules whose
only consumer is one runner's generator. After the d037 generator merge (and
d038's proxy catalog), the consumer matrix is:

| lib module              | coding-agent | llm-local-inference | llm-reverse-proxy | lib-internal         |
|-------------------------|--------------|---------------------|-------------------|----------------------|
| log.mjs / artifact.mjs  | gen-lib      | gen-lib             | generate-config   | most lib modules     |
| peer-probe.mjs          | 3 generators | —                   | — (comment only)  | hyper, catwalk, refresh |
| pi-models.mjs           | gen-lib only | —                   | —                 | —                    |
| cloud-providers.mjs     | 2 generators | —                   | generate-config   | hyper-facts (hyper)  |
| hyper-facts.mjs/.json   | cloud gen    | —                   | —                 | —                    |
| catwalk-facts.mjs       | cloud gen    | —                   | — (reads raw JSON)| —                    |
| catwalk-facts.json      | cloud gen    | —                   | generate-config   | —                    |
| refresh-models-dev.mjs  | generate.sh  | —                   | —                 | peer-probe           |
| pi-ai-providers.mjs     | —            | —                   | generate-config   | —                    |
| ai-sdk-package-endpoints.mjs | —       | —                   | generate-config   | —                    |
| models.dev.api.json     | gen + refresh| —                   | generate-config   | —                    |
| llamacpp-model-data.json| —            | yaml generator      | —                 | 5 × local-llm tools  |

`docs/architecture.md` makes `lib/` the shared-infrastructure copy unit, not a
general dumping ground: modules with exactly one runner consumer blur the
boundary the folder exists to draw (d023's staging list drags 7 modules into
every coding-agent scratch run, 5 of which nothing but one generator reads).

`llm-local-inference` has nothing to fold back: its only lib dependencies are
`log.mjs` + `artifact.mjs` (multi-runner) and `llamacpp-model-data.json`,
which d025 moved to `lib/` precisely because five `local-llm/` tools
(`download_models.py`, `fetch_hf_manifests.py`, `generate_vram_fit_tables.py`,
`scan_cache_coverage.py`, `fetch-model-cards.sh`) read it too.

## Decision

Fold every single-consumer lib/ module back to its owning runner; keep lib/ for
what is genuinely shared.

### → coding-agent/

1. **`lib/peer-probe.mjs` → `coding-agent/peer-probe.mjs`** (relocation). Its
   consumers are the three coding-agent generators (via gen-lib) and three
   coding-agent-side fact modules. It keeps the d023 LIB_DIR import convention
   for `log.mjs` (`process.env.LIB_DIR ?? <scriptDir>/../lib`) — its old static
   `./log.mjs` import only worked from inside lib/, and the scratch dir stages
   coding-agent sources at the root while lib stays in `$LIB_DIR`. Its sibling
   importers switch to static same-dir imports.
2. **`lib/pi-models.mjs` → inlined into `coding-agent/gen-lib.mjs`**. Pure
   shaping (no imports, no I/O) with a single consumer file; a separate module
   for 174 lines of llama-swap/cloud shaping helpers is ceremony. gen-lib is
   already the shared-preamble module SIMPLE.md pointed at.
3. **`lib/hyper-facts.mjs` + `lib/hyper-facts.json` → `coding-agent/`** (the
   cache moves with the module: single consumer, and the module header already
   specified "cache lives next to this file"). Its `log.mjs`/`cloud-providers.mjs`
   imports keep the LIB_DIR convention; `peer-probe.mjs` becomes a sibling
   import; `FACTS_PATH` defaults to next to the module (`HYPER_FACTS_JSON`
   env override stays).
4. **`lib/catwalk-facts.mjs` → `coding-agent/catwalk-facts.mjs`**, but
   **`lib/catwalk-facts.json` stays in lib/**: the proxy's generate-config
   reads the raw JSON (source 3 of d038), so the cache is multi-runner data.
   The module's `FACTS_PATH` keeps resolving through LIB_DIR
   (`env ?? <scriptDir>/../lib`), and `CATWALK_FACTS_JSON` remains the override.
5. **`lib/refresh-models-dev.mjs` → `coding-agent/refresh-models-dev.mjs`**
   (only `coding-agent/generate.sh` runs it). Its static `./log.mjs` /
   `./artifact.mjs` imports switch to the LIB_DIR convention; `peer-probe.mjs`
   becomes a sibling import. generate.sh runs the staged scratch copy.
6. **gen-lib.mjs** imports the four moved modules statically as same-dir
   siblings and drops its dead re-exports (`logError`, `loadCatwalkFacts`,
   `CATWALK_PROVIDER_MAP` — no generator imports them post-d037).

### → llm-reverse-proxy/

7. **`lib/pi-ai-providers.mjs` + `lib/ai-sdk-package-endpoints.mjs` →
   inlined into `llm-reverse-proxy/generate-config.mjs`** as labelled source
   sections (frozen tables, rationale comments kept). Sole consumer; the proxy
   reads `../lib` in place with no scratch staging, so two mounted files whose
   only job was to feed one script are pure indirection. The `LIB_DIR`-based
   imports for them disappear.

### Stays in lib/

`log.mjs`, `artifact.mjs`, `cloud-providers.mjs` (coding-agent + proxy),
`models.dev.api.json` (coding-agent + proxy), `catwalk-facts.json`
(coding-agent + proxy), `llamacpp-model-data.json` (d025: llm-local-inference
+ local-llm tooling), `log.sh`, `log.py`, `environment.sh`, `workload-*`.
lib/*.mjs count: 11 → 3.

### Consequences

- The moved modules keep the LIB_DIR import convention, so in-place runs
  (default `../lib`) and d023 scratch staging (env `LIB_DIR`) both resolve
  without per-runner branches.
- `generate.sh` staging: peer-probe/hyper-facts/catwalk-facts/
  refresh-models-dev move from the lib copy list to the generator copy list;
  `pi-models.mjs` leaves both lists; the hyper-facts.json cache stages from
  `SCRIPT_DIR` next to its module. `run.sh` mirrors the moves.
- `hyper-facts.json` in `coding-agent/` is safe from merge-models-json's
  `model-*.json` layer glob (name doesn't match).
- Historical decision docs (d022/d024/d027/d028/d033 era texts) keep their old
  paths — they describe their time; d039 owns the current layout.
