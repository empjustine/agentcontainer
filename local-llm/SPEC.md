---
id: local-llm
type: module-design
status: draft
title: local-llm — HF cache provisioning & audit tooling
parent: architecture
depends-on:
  - lib
references:
  - llm-reverse-proxy
tags:
  - cache
  - hf
  - tooling
---

## Responsibility

Provision and audit the HuggingFace cache tree that local GGUF inference serves
from: download the served models, verify the `repo:quant` manifests against
what llama.cpp actually resolves, keep the cache healthy (prune/verify), and
regenerate the VRAM/fit estimate tables. It is **cache tooling, not a base
generator** — nothing here is consumed by the runners' generation.

## Shape

`run-all.sh` orchestrates the pipeline in dependency order:

1. `download_models.py` — provision served GGUFs into the HF cache.
2. `fetch_hf_manifests.py` — refresh + audit repo:quant manifests.
3. `upkeep.py` — cache list/pull/prune/verify.
4. `generate_vram_fit_tables.py` — VRAM/KV/fit tables via
   gdevenyi/huggingface-estimate → regenerates
   `docs/gguf-vram-fit-estimates.md` (+ raw-data JSON).

Plus PoC/audit helpers (`scan_cache_coverage.py`, `gguf_context_length.py`,
`fetch-model-cards.sh`). All are self-contained `uv` PEP-723 scripts logging
through `lib/log.py`; operational detail lives in each script header.

## Boundary

- The canonical model list is the shared `lib/llamacpp-model-data.json` —
  **content owned by `llm-reverse-proxy/`** (its manifest-refresh workflow,
  `docs/refresh-local-llm-manifest.md`), consumed read-only here
  (`docs/d025-shared-model-data-to-lib.md`). local-llm must not edit it as part
  of pipeline work (the `--update-model-data` reorder in
  `generate_vram_fit_tables.py` is the one sanctioned write, done explicitly).
- Copy unit = this folder + `../lib`; must not import code from sibling runner
  folders.

*(Boundary inferred from the d025 move and the code's current reads — the
sanctioned-write rule above is the only judgment call here, unconfirmed.)*
