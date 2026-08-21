# Hugging Face cache upkeep

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

| Variable     | Meaning                                                       |
|--------------|---------------------------------------------------------------|
| `HF_HUB_CACHE` | cache dir (default `~/.cache/huggingface/hub`)              |
| `HF_HOME`      | falls back to `XDG_CACHE_HOME/huggingface`                  |
| `HF_TOKEN`     | token for gated models (optional; auto-read from cache)     |

### API note (huggingface_hub ≥ 0.23)

The cache-scanning API was rewritten. `scan_cache_dir()` now returns a single
`HFCacheInfo` whose `repos` are `CachedRepoInfo` objects (there is no longer a
per-repo `.delete_revisions`, `.commits`, or `.warnings`). Revisions are
pruned via `HFCacheInfo.delete_revisions(*hashes)`, which returns a
`DeleteCacheStrategy` you `.execute()`. In this model refs always point at a
present revision, so a ref whose commit is missing now makes the whole repo
*corrupted* (reported in `HFCacheInfo.warnings`) rather than being silently
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

`download_models.py` deliberately downloads via `snapshot_download(revision="main")`,
never via a pinned commit hash. A commit-hash download (`hf_hub_download(revision=<sha>)`)
creates `snapshots/<sha>/…` with **no** entry under `refs/` — a detached revision.
The prune step above deletes exactly those, so pinning by SHA produces an endless
cycle: provision → prune → re-provision on the next run (observed with the gemma-4
E2B/E4B qat repos). Downloading through the "main" ref writes `refs/main`, so the
revision is attached, survives pruning, and is automatically kept fresh by the
pull step. Consistency between an entry's model + mmproj files is preserved
because `snapshot_download` resolves the branch to a single commit per call.

## fetch-model-cards.sh

Refreshes the model-card mirrors under `local-llm/model-cards/<org>/<repo>.md`
from Hugging Face (the `README.md` of each repo in
`llamacpp-model-data.json`). File names are the repo id verbatim — the same
value used in the derived model ids — so cards always match the ids.

## Related

The containerized "huggingface environment" + `models-local/` flat layout +
`--model` fallback design were **archived** (scrapped) under
`old/agentcontainer/docs/` (`d015`, `d016`, `d017`) and
`old/agentcontainer/local-llm/`. `llama-server` now resolves GGUFs from
Hugging Face at runtime via `--hf-repo`/`--hf-file`; see
`openai-completions-gfx1030/generate-local-llm-models.yaml.js` and
`docs/container-tooling.md`.
