---
id: hf-cache-upkeep
type: module-design
status: active
title: "Hugging Face cache upkeep — upkeep.py runbook"
parent: llm-local-inference-cache
tags: ["reference", "runbook", "hf-cache"]
---

# Hugging Face cache upkeep

## Provisioning: the curated manifests

`40-download-models.py` downloads nothing it was not told to. Its input is
`lib/curated/<org>--<repo>.json`, written by `30-generate.mjs` from the
model manifest and the committed repo manifests — the same run that renders
`config.d`, so served and downloaded cannot diverge:

    uv run --script llm-local-inference/40-download-models.py

Per repo a curated file names every shard of each surviving quant (rows the
display rules hide are absent), the projector the generator resolved (no entry
declares one), any drafter sidecar, and the split index when the repo ships it.

`lib/cache-scope.json` is the closed inventory: every repo this unit keeps,
in one mode. `served` repos have model entries and curated manifests;
`audit-only` repos are refreshed and verified but never downloaded, and their
cached weights are prunable: the model manifest is the keep order, so an
audit-only repo keeps its facts (the repo manifest) for an offline promotion
and not its bytes (docs/d218). A repo with no line is out of scope.

The curated manifests are COMMITTED, so a host that only provisions needs no
GPU, no endpoint and no Hub beyond the download itself: `40-download-models.py`
reads them, and they carry the projector the generated config passes as
`--mmproj`. Regenerating them (`30-generate.mjs`) is the step that wants the
serving host — on a plain prep box it needs `LOCAL_INFERENCE=1` and an existing
`HF_HUB_CACHE` directory. Pruning does not depend on either: it keeps every
projector the repo manifest of a repo in the set ships, not just the one
curation picked (docs/d218).

The checksum step is `50-verify-cache.py` (its own tool: never
`--fail-on-missing-files`, which would fail on exactly the files a curated set
skips). Provisioning and verification are separate jobs on purpose.

docs/d212's "Leaving audit-only" lists the three exits.

The operator's one shot is `uv run --script llm-local-inference/run_all.py`, and the
checksum pass is its own tool: `uv run --script llm-local-inference/50-verify-cache.py`.

- One cache root per run (`HF_HUB_CACHE`): the generator bakes paths against
  it and `run.py` binds it, so a second root is a second run, not a stage.
  `hf cache verify` does not fail on files present upstream only, which is what
  makes a partial (plan-sized) snapshot verifiable; never pass
  `--fail-on-missing-files`.

## upkeep.py

Lists, prunes, pulls newer revisions, and verifies the local Hugging Face
model cache. It uses
`huggingface_hub` directly (no podman, no `hf` CLI, no jq). Runs the full
pipeline by default:

1. **list** cached model repos
2. **pull** newer revisions of tracked refs (network)
3. **prune** detached revisions + orphan blobs
4. **verify** each model repo (fail on corrupted / missing)

The pull runs before the prune so an interrupted pull can never leave a ref
pointing at an incomplete revision while its only complete (now detached)
predecessor gets deleted.

Env:

| Variable       | Meaning                                                 |
| -------------- | ------------------------------------------------------- |
| `HF_HUB_CACHE` | cache dir (default `~/.cache/huggingface/hub`)          |
| `HF_HOME`      | falls back to `XDG_CACHE_HOME/huggingface`              |
| `HF_TOKEN`     | token for gated models (optional; auto-read from cache) |

### API note (huggingface_hub ≥ 0.23)

The cache-scanning API was rewritten. `scan_cache_dir()` now returns a single
`HFCacheInfo` whose `repos` are `CachedRepoInfo` objects (there is no longer a
per-repo `.delete_revisions`, `.commits`, or `.warnings`). Revisions are
pruned via `HFCacheInfo.delete_revisions(*hashes)`, which returns a
`DeleteCacheStrategy` you `.execute()`. In this model refs always point at a
present revision, so a ref whose commit is missing now makes the whole repo
_corrupted_ (reported in `HFCacheInfo.warnings`) rather than being silently
prunable. The closest safe GC to the old "prune dangling refs + orphan blobs"
step is to drop revisions that no ref points at (detached), which also
reclaims the blobs those revisions were the sole user of.

### XET note

If the XET client is installed, weights for XET-enabled repos are fetched as
content-addressed chunks into a **separate** XET chunk cache (default
`~/.cache/huggingface/xet`, override with `XET_CACHE_PATH`). Those chunks are
**not** scanned by `scan_cache_dir`/prune/verify, which only understand the
`blobs/` + `snapshots/` + `refs/` layout. The reassembled snapshot files are
still tracked normally; only the underlying chunk store is outside this
tool's GC.

### Prune semantics

Because the rewritten API no longer surfaces "dangling" refs, the safe,
equivalent GC is to drop revisions that no ref points at (detached); shared
blobs that other revisions still reference are kept.

### Pull semantics

For each tracked ref, the remote branch target is compared to the local
commit. When they differ, only the weights already in the cache are refreshed
(e.g. the single GGUF quant an engine actually serves) rather than re-fetching
the whole repo at the new revision, via `snapshot_download` with
`allow_patterns`. GGUF repos additionally pre-fetch the small index/metadata
files (`ignore_patterns=["*.gguf"]`) the loader resolves against on first use,
while still skipping the unused heavy `.gguf` quants.

### Provisioning must go through refs

`40-download-models.py` deliberately downloads via `snapshot_download(revision="main")`,
never via a pinned commit hash. A commit-hash download (`hf_hub_download(revision=<sha>)`)
creates `snapshots/<sha>/…` with **no** entry under `refs/` — a detached revision.
The prune step above deletes exactly those, so pinning by SHA produces an endless
cycle: provision → prune → re-provision on the next run (observed with the gemma-4
E2B/E4B qat repos). Downloading through the "main" ref writes `refs/main`, so the
revision is attached, survives pruning, and is automatically kept fresh by the
pull step. Consistency between an entry's model + mmproj files is preserved
because `snapshot_download` resolves the branch to a single commit per call.

## fetch_model_cards.py

Refreshes the model-card mirrors under `llm-local-inference/model-cards/<org>/<repo>.md`
from Hugging Face (the `README.md` of each repo in
`llamacpp-model-data.json`). File names are the repo id verbatim — the same
value used in the derived model ids — so cards always match the ids.

The mirrors are the upstream `README.md` byte-for-byte, so their
repo-relative image links (`./img/…`) dangle locally: images are not
mirrored on purpose (the cards are read for content, and a picture copy would
bloat the repo to serve nothing). A broken image in a card is that, not a
missing fetch — read the diagrams on the Hub.

## Related

The containerized "huggingface environment" + `models-local/` flat layout +
`--model` fallback design were **retired** (scrapped; the d015–d017 notes
and their tooling live only in the archive). `llama-server` now resolves GGUFs from
Hugging Face at runtime via `--hf-repo`/`--hf-file`; see
`llm-local-inference/generate-local-llm-models.yaml.mjs` and
`docs/container-tooling.md`.
