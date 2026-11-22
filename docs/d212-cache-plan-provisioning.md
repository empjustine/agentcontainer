---
id: d212
type: module-design
status: active
title: "d212 — the cache chain: closed scope, curated manifests, one tool per job"
parent: llm-local-inference
depends-on: [llm-local-inference]
references: [d029, d045, d058, d197, d200, d207, hf-cache-upkeep]
tags: ["hf-cache", "provisioning", "generator", "scope"]
---

# d212 — the cache chain: closed scope, curated manifests, one tool per job

## Problem

Provisioning was a hand-written list of repos in the repo-root `verify.sh`, each
pulled whole by `hf download <repo>`. Three failures came out of that shape at
once.

**A whole repo is not a serving set.** `hf download` takes every quant, every
full-precision copy, every projector and the card: 7.2 TiB of upstream manifests
for a catalog whose served files are 1.5 TiB. The run filled the primary cache
root and the secondary one.

**The list drifted in both directions.** Of its thirty repos, fourteen had no
model entry — four of them alone accounted for 4 TiB nothing could serve — while
thirteen served repos were absent from it and never checked.

**Two downloaders, two rules.** `download_models.py` read the RAW models array
(so it fetched quants the display rules hide) and looked for an `mmproj` key no
entry carries: the projector is resolved from the repo manifest, so the vision
modes had no file.

A first repair shipped a **cache plan**: the generator printed a bespoke JSON
document and the downloader consumed it. That was a second artifact for the same
facts, understood by one tool, granted a `--print-cache-plan` mode on a
generator and a `--plan` mode on a downloader. Measured against the serving
contract it duplicated (`config.d`), the file set was identical — 29 repos, zero
files different. The boundary was real; the schema was the cost, and the modes
were the symptom.

## Decision

One chain, each stage a committed artifact or a single-job tool:

    cache-scope.json -> repo manifests -> model manifest -> curation
                     -> curated manifests -> download -> run

- **`lib/cache-scope.json` is the closed INVENTORY**: every repo this unit
  keeps, in one mode, `served` or `audit-only`. It is the only
  statement of in-scope, so the manifest refresh reads it and nothing else.
  **The model manifest, not this file, is authoritative about what is served**:
  a repo with entries is served, and the scope line is bookkeeping. Disagreement
  is REPORTED, never enforced — a first version made a stale `served` line
  fatal, so curating the manifest down stopped generation and the snapshot
  outvoted the file it was derived from. An unknown mode is still a hard error
  (a closed vocabulary is not a disagreement).
- **`lib/hf-manifests/` are the facts**: what each repo ships, refreshed through
  the scope file by `10-fetch-hf-manifests.py`.
- **`lib/llamacpp-model-data.json` is the raw record** the operator writes: each
  entry names its file (shard 1), the label, and any drafter.
- **Curation is the generator's job** (`generate.mjs`): apply the display rules,
  resolve each entry's projector and shards from the repo manifest, and write
  `lib/curated/<org>--<repo>.json` — that repo's provisioning input, plus
  `config.d` rendered from the same in-memory set, so served and downloaded
  cannot disagree. Stale curated files are deleted.
- **The downloader reads the curated files and nothing else** (`40-download-models.py`).
  Not `config.d`: its cmd strings are a rendering (guest paths, macro-expanded
  flags), and parsing them is a workaround for not having the artifact.
- **One tool per job, no mode flags** (`docs/d213`, `docs/d215`): a
  tool with no flags fails on arguments, a read-only preview is its own tool,
  and manual-intervention tools sort in runbook order. A dry-run switch is the
  same smell: `60-audit-snapshots.py` is the review surface for the pruner.
  what its destructive sibling would remove).
- **Language follows age, not taste**: the Node family that emits configuration
  (`generate.mjs` and its authoring aid `20-propose-entries.mjs`, sharing
  `lib/model-entries.mjs`) stays Node; every new tool is Python (`run_all.py`,
  `50-verify-cache.py`, `60-audit-snapshots.py`,
  `40-download-models.py`). No general-purpose tooling in POSIX shell; the shell
  tools (`run-all.sh`, `fetch-model-cards.sh`, `verify.sh`, `lib/log.sh`) are
  gone.
- **One Hub fetcher for metadata** (d230): `10-fetch-hf-manifests.py`
  mirrors each in-scope repo's README beside its tree manifest. The card mirror
  side task is gone; the facts stay separate from the weights the downloader owns.
- **Accounting is by blob, not by repo.** Repo manifests carry each file's
  `oid`, so the bytes a run still needs are the files whose oid is absent from
  the store — the number `40-download-models.py` checks against free space before
  the first byte, and the reason a per-repo total is never a capacity figure.

## Consequences

- A full provision is 1.5 TiB of files / 1.53 TiB planned against 7.2 TiB of
  upstream bytes; the cache audit on the served root found 80 prunable files
  (216.9 GiB) and no out-of-scope repo.
- The two `SPLIT_RE` copies, the "keep in sync with 40-download-models.py" note, and
  the plan schema are gone; the shard fan exists once, in `lib/model-entries.mjs`.
- Promotion is ONE edit: add the entries. The scope line follows as an
  annotation (a stale one warns, it never blocks). `20-propose-entries.mjs`
  prints the entries as a `{"models": [...]}` fragment in the manifest's own
  tab formatting, so the block pastes in after review.
- `50-verify-cache.py` verifies only (checksums via `hf cache verify`, never
  `--fail-on-missing-files`, which would fail on exactly the files a curated set
  skips). `run_all.py` orders the pipeline with the manifest refresh FIRST,
  because curation resolves files from those facts.

## Leaving audit-only

A `lib/cache-scope.json` line is a claim the model manifest cannot make, so
nothing promotes, retires or reclassifies it by itself.

- `audit-only` (repo manifest present, no model entries). **Exit by serving it:**
  run `20-propose-entries.mjs`, review and paste the entries into
  `lib/llamacpp-model-data.json`. That row edit IS the promotion: the
  manifest wins, the scope line only annotates it and a stale one warns.
  **Exit by dropping it:** delete the line; absence is the declaration that the
  repo is out of scope — after which its cached files become prunable.
  its cached files become prunable.
- `unmanifested` (a line without a repo manifest). Exit by fetching:
  `10-fetch-hf-manifests.py --repo <repo>`, then re-run curation. The refresh
  edits committed truth, so that diff is reviewed before anything downloads
  against it (d060).
- `served`. Exit by removing the last entry (and flipping the line); the files
  no curated manifest names become `60-audit-snapshots.py` findings.

## Hybrid storage

The cache is content-addressed under one root: repo directories are metadata and
symlinks, and the bytes live in a shared store (`blobs/<xx>/<oid>`, with
`.refs` sidecars, plus per-repo blob files from older downloads). Consequences
this record pins:

- A per-repo split across disks duplicates every shared blob and breaks the
  refcounts `hf cache verify`/`delete` rely on, so hybrid storage is a
  filesystem decision under ONE root (bind/subvol/hardlink tier), not a routing
  decision per repo.
- Reclaiming space is refcount-aware (`hf cache rm <repo>/<file>`), never
  `rm -rf models--X`, which frees nothing and leaves the store inconsistent.
- `60-audit-snapshots.py` reports file bytes and deduplicated blob bytes side by
  side, because only the second is a capacity number.

## Alternatives rejected

**A `--print-cache-plan` mode.** An intermediate document with one consumer,
not manifest-shaped, duplicating what curation already writes. Measured
identical to `config.d`'s file set.

**Parsing `config.d` from the downloader.** A rendering is not data; guest paths
and macro-expanded flags make it a fragile input, and it leaves provisioning
unable to say what it needs before generating.

**A Python port of `generate.mjs`.** The coupling that hurt was the invented
schema, not the language. With the curated artifact and the closed scope, the
remaining shared logic is a handful of GGUF facts, single-homed in
`lib/model-entries.mjs`. Porting would additionally split the capability probes
`build.mjs` shares (d041/d087) across two runtimes, and require a second
deterministic-artifact writer (d050).

**A dispatcher with step modes.** `run_all.py` runs every step: each is
idempotent, and a step selector is a mode flag with extra words.
