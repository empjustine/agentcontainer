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
> (`40-download-models.py`) and upkeep (`upkeep.py`) remain load-bearing.
>
> **Folded flat (docs/d113).** This pipeline used to be the sibling folder
> `local-llm/`, importing the shared repo-level lib. It now lives _in_ this
> folder, one level under the serving unit it feeds, and reads its `lib/` — the
> same `lib/` the generator and `run.py` use. Nothing about the workflow
> changed; the folder boundary that forced the shared model manifest into the old
> repo-level `lib/` is gone (docs/d025's problem, dissolved rather than
> solved).

## Responsibility

Charter: provision and audit the HuggingFace cache tree that local GGUF
inference serves from — download the served models, verify the `repo:quant`
manifests against what llama.cpp actually resolves, keep the cache healthy
(prune/verify), and regenerate the VRAM/fit estimate tables. The normative
requirement statement lives in the BRD
([../docs/requirements.md](../docs/requirements.md), FR-C1–FR-C3). It is
**cache tooling, not a base generator** — the generator reads the model manifest,
never anything produced by this pipeline.

## Shape

`run_all.py` orchestrates the pipeline in dependency order — repo
manifests first, because curation resolves each entry's files from them:

0. `10-fetch-hf-manifests.py` — refresh the repo manifests of every repo
   `lib/cache-scope.json` names (the scope is closed: nothing else is
   refreshed), then audit each served row's `:quant` label.
1. `30-generate.mjs` — curation: the display rules, the projector each entry
   resolves from its repo manifest, and the shard fan, written as
   `lib/curated/<org>--<repo>.json` and rendered as `config.d`.
2. `40-download-models.py` — provision exactly the curated files, after
   refusing when the oid-deduplicated missing bytes exceed free space.
3. `upkeep.py` — refresh newer revisions, prune detached, verify.
4. `fetch_model_cards.py` — mirror the served repos' READMEs.
5. `50-verify-cache.py` — checksum-verify every cached served repo.

Plus the audit/prune pair (`60-audit-snapshots.py` reports;
`70-prune-cache.py` erases the undeclared and the corrupt, docs/d218),
aid) and the GGUF helpers (`gguf_context_length.py`,
`scan_cache_coverage.py`, `scan_cache_for_manifest.py`). Every Python
tool is a PEP-723 script logging through `lib/log.py`; there is no shell
tooling left in this unit (docs/d212).

## Boundary

- The plan is the interface between the two halves: the generator owns what
  serves (pruning, projector resolution, file fan) and the downloader owns the
  Hub (refs, etags, retries). Neither re-derives the other's rules.
- `lib/cache-scope.json` declares the repos kept in cache scope that the model manifest
  cannot name (a candidate, a mirror). `audit-only` means verified if already
  cached and never downloaded; a repo in neither file is out of scope. A line
  for a repo the model manifest serves is refused, so promotion removes it in the same
  edit (docs/d212).
- The canonical model list is `lib/llamacpp-model-data.json` — **this folder's
  own copy** (its manifest-refresh workflow is
  `llm-local-inference/refresh-llm-local-inference-manifest.md`). The pipeline
  never edits it — entries are hand-edited per the runbook (the one sanctioned
  write the retired `generate_vram_fit_tables.py` used to make is gone, d170).
- The folder boundary that used to separate this pipeline from its consumer is
  gone (docs/d113): it is a sub-spec of the unit, so the "consumed read-only
  here / owned there" split is now an intra-folder rule about which script may
  write the model manifest, not a cross-unit contract.
- Everything is flat here — no `local-llm/` subfolder, and no import from a
  sibling unit; the only lib reads are this folder's own `lib/`
  (`log.py`, `llamacpp-model-data.json`, `hf-manifests/`).
