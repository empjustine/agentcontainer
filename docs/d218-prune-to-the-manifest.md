---
id: d218
type: module-design
status: active
title: "d218 — the cache prunes to the model manifest, and to a failed checksum"
parent: llm-local-inference
depends-on: [d212, d215]
references: [d213, d214, hf-cache-upkeep]
tags: ["hf-cache", "pruning", "manifests", "verification"]
---

# d218 — the cache prunes to the model manifest, and to a failed checksum

## Problem

The serving set shrinks as the manifest is curated, but nothing erased the bytes
that left it: after the model manifest went from 29 repos to 16, the retired
quants and repos still occupied the cache, and the only removal paths were a
whole-repo `hf cache rm` (which deletes wanted neighbours too) or a shell loop
over a hand list. A file that fails its checksum had no removal path at all:
`hf cache verify` reports the mismatch and exits, leaving the corrupt weight in
place for the next load to fail on.

Sizing is what makes the rule simple. The manifests — `lib/hf-manifests/` and
`lib/llamacpp-model-data.json` — are kilobytes each and never enter the HF cache;
one wrongly fetched GGUF is gigabytes. So the pruning decision is about weights
only, and a manifest is never a candidate: what must be pruned is anything the
weights set does not name.

## Decision

One tool, `70-prune-cache.py`, with one job and no flags (d215). It removes, in
this order:

1. **Every cached file outside the serving set** — the curated manifests' files
   plus the model manifest's rows, shards expanded from the committed repo
   manifest. This is the cheap pass (filenames and sizes, no reads) and it runs
   first because it shrinks what the second pass has to read.
2. **Every file a checksum verification reports as a mismatch**
   (`hub_api.verify_repo_checksums`). The expensive pass, on what survived.

Deletion always goes through `HFCacheInfo.delete_files`, the refcount-aware API
whose CLI face is `hf cache rm`: the snapshot entry is removed and a blob only
when no other revision references it. Cleverness about the shared content store
is forbidden here — that bookkeeping is the one thing a pruner must not
re-implement, and a wrong refcount removes a weight another repo still serves.

Three consequences are deliberate:

- **`audit-only` stops protecting weights.** The model manifest is the keep
  order (d212); an audit-only repo keeps its facts — the repo manifest stays
  committed, so `20-propose-entries.mjs` still works offline — and its cached
  weights are prunable like any other undeclared file.
- **The preview is a separate tool** (`60-audit-snapshots.py`), sharing the
  classification through `_serving_set.py` so the report and the deletion cannot
  disagree. `50-verify-cache.py` stays verification-only.
- **Pruning is idempotent with provisioning**: a removed file is fetched again
  by `40-download-models.py` the moment the manifest declares it, so the cost of
  pruning too eagerly is a re-download, never a broken config.

## Consequences

- The retired quant of a served repo, a full-precision sibling nobody serves, a
  repo the manifest dropped, a README, an imatrix, a corrupt blob: one reason
  each in the audit, one deletion each in the pruner.
- The audit on the primary root reported 156 prunable files (1010 GiB) after the
  catalog was curated to 16 repos: 605 GiB of undeclared GGUFs, 405 GiB of
  audit-only repos, and a tenth of a gigabyte of non-GGUF files.
- Verification needs the Hub for its checksum list; without it the pruner still
  performs the undeclared pass, logs the failed verification, and exits 1.
- A repo whose bytes must survive belongs in the model manifest. "Keep it
  cached but serve nothing" is no longer expressible, and that is the point: two
  sources of keep authority is how the scope file started vetoing the manifest.

## Alternatives rejected

**A `--prune` flag on `50-verify-cache.py`.** A no-flag tool must fail closed
(d215), and verification with a deletion side effect is two jobs in one
command; the read-only sibling is the preview (d213).

**Pruning by repo.** `hf cache rm <repo>` takes the wanted quants with it, so it
answers "drop this model", not "drop what nothing declares".

**Extending `upkeep.py`.** It prunes detached revisions and orphan blobs; it has
no knowledge of the model manifest, and giving it one would make the cache
upkeep tool double as the serving authority.

**Trusting the scope file as a keep list.** It would protect audit-only weights
and let a generated snapshot outvote the file it was derived from — the failure
d212 already corrected in the generator.
