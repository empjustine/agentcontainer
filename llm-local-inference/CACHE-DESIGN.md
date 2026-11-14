---
id: llm-local-inference-cache
type: submodule-design
status: draft
title: "llm-local-inference cache pipeline — HF cache provisioning & audit tooling"
parent: llm-local-inference
references:
  - llm-local-inference
tags:
  - cache
  - hf
  - tooling
---

> **Deprecated beyond the manifests (docs/d053, then d170).** The
> audit/table/estimator tooling here is retired outright: the
> footprint/order pass (`model-sizes.mjs`) and the VRAM-fit generator
> (`generate_vram_fit_tables.py` + `gguf-vram-fit-estimates.md`) are gone,
> and the committed HF manifests stay in `lib/hf-manifests/` — now the
> param-count/quant-display source (d170). Only cache provisioning
> (`download_models.py`) and upkeep (`upkeep.py`) remain load-bearing.
>
> **Folded flat (docs/d113).** This pipeline used to be the sibling folder
> `local-llm/`, importing the shared repo-level lib. It now lives _in_ this
> folder, one level under the serving unit it feeds, and reads its `lib/` — the
> same `lib/` the generator and `run.py` use. Nothing about the workflow
> changed; the folder boundary that forced the shared table into the old
> repo-level `lib/` is gone (docs/d025's problem, dissolved rather than
> solved).

## Responsibility

Charter: provision and audit the HuggingFace cache tree that local GGUF
inference serves from — download the served models, verify the `repo:quant`
manifests against what llama.cpp actually resolves, keep the cache healthy
(prune/verify), and regenerate the VRAM/fit estimate tables. The normative
requirement statement lives in the BRD
([../docs/requirements.md](../docs/requirements.md), FR-C1–FR-C3). It is
**cache tooling, not a base generator** — the generator reads the model table,
never anything produced by this pipeline.

## Shape

`run-all.sh` orchestrates the pipeline in dependency order:

1. `download_models.py` — provision served GGUFs into the HF cache.
2. `fetch_hf_manifests.py` — refresh + audit repo:quant manifests (writes
   `lib/hf-manifests/`; deprecated as a _workflow_, still the manifest writer).
3. `upkeep.py` — cache list/pull/prune/verify.
   The VRAM/KV/fit table generator (`generate_vram_fit_tables.py` →
   `gguf-vram-fit-estimates.md`) is retired (docs/d053, then d170 removed the
   file with the tables it produced).

Plus PoC/audit helpers (`scan_cache_coverage.py`, `gguf_context_length.py`,
`fetch-model-cards.sh`). All are `uv` PEP-723 scripts (dependencies declared
inline, no venv) logging through `lib/log.py`. The two cache scanners share
`_hf_cache.py` — the sidecar filter and the cache-root order are
facts about the HF cache, not about either scanner, and keeping two copies is
what let them drift; operational detail lives in each script header.

## Boundary

- The canonical model list is `lib/llamacpp-model-data.json` — **this folder's
  own copy** (its manifest-refresh workflow is
  `llm-local-inference/refresh-llm-local-inference-manifest.md`). The pipeline
  never edits it — entries are hand-edited per the runbook (the one sanctioned
  write the retired `generate_vram_fit_tables.py` used to make is gone, d170).
- The folder boundary that used to separate this pipeline from its consumer is
  gone (docs/d113): it is a sub-spec of the unit, so the "consumed read-only
  here / owned there" split is now an intra-folder rule about which script may
  write the table, not a cross-unit contract.
- Everything is flat here — no `local-llm/` subfolder, and no import from a
  sibling unit; the only lib reads are this folder's own `lib/`
  (`log.py`, `llamacpp-model-data.json`, `hf-manifests/`).
