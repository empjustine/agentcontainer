---
id: d060
type: architecture-design
status: implemented
title: "d060 — retire the remaining flags: the run is the review, argv is the config, the reader filters"
parent: architecture
depends-on: [d045, d050, d058]
references: [d027, d039, d041, d044, d045, d050, d053, d058]
tags: [dx, git-tooling, generators, logging, env-chain]
---

# d060 — Retire the remaining flags (verifiers, env seeds, verbosity)

**Status:** implemented

## Problem

d058 cut the *simulation* modes (dry-run/plan previews) and drew a line:
verifiers that assert about reality, and knobs that select real work, stay.
Three leftovers sat on the wrong side of that line, plus one mode pair where
the less useful half was the default:

1. **Verifier flags whose answer the run already gives.** `model-sizes.sh
   --check` recomputed the whole table and reported drift instead of fixing
   it; `migrate.sh --verify` made the fsck of a freshly built mirror
   optional — including the fsck that stood between `--delete-originals` and
   the deletion of the only working copy; `fetch_hf_manifests.py --refresh`
   made *refreshing* the optional half of a tool whose contract is "refresh +
   audit" (cache-first meant the `run-all.sh` upkeep step stopped fetching
   after the first run, and nothing passed `--refresh`).
2. **Ambient environment as a second configuration surface.** Every knob
   existed twice: `--throttle` *and* `VBS_THROTTLE`, `--retries` *and*
   `VBS_RETRIES`, `--cooldown` *and* `VBS_COOLDOWN`, `--manifest` *and*
   `VBS_MANIFEST`, `--min-interval` *and* `MIRROR_MIN_INTERVAL` ("the env
   seeds the same value; the flag wins"), plus `VBS_*` values that had no
   flag at all and identity/root settings (`VBS_DEST`, `VBS_TRANSPORT`,
   `VBS_SSH_USER`, `VBS_HTTP_USER`) that were env-only. A run could
   therefore be re-paced, re-pointed or quietly de-throttled by a variable
   exported somewhere upstream of the command.
3. **Verbosity as a code-level branch.** `model-sizes.sh --verbose` was the
   only reason that tool had a flag parser at all: the per-repo detail it
   printed was produced or not produced by an `if (verbose)` in the middle of
   the report.
4. **The less useful half behind a flag.** `git/audit.sh --deep` gated the
   `git status --porcelain` + detached-HEAD checks — i.e. the shallow default
   was the report you had to remember to re-run. Nothing calls it
   programmatically (there is no CI in this repo), so the flag existed only
   to remind people it exists.

The same shape as d058, one layer down: **a mode whose value is only visible
when someone remembers to pass it is a mode that gets forgotten.**

## Decision

Three rules, applied to the survivors:

1. **The run IS the review.** Anything a second mode merely *reports* about
   the artifact the tool already writes is deleted; you run the tool and read
   `git diff` (d050 determinism makes this exact).
2. **Ambient environment is not a configuration surface.** A run declares
   what it is doing on its command line, or in its input file. Environment
   carries host state and secrets — never run inputs, never tuning, never
   identity that a flag can name, and never a value that can win over a flag
   (nor lose to an absent one). Where a setting had both spellings, the flag
   wins and the env spelling is gone; where it had only the env spelling, it
   became a constant or a flag. One host-state read survives:
   `$WORK_MIRRORS`, the mirror root of this machine — the same default
   `git/*.mjs` take, a path no flag can supply portably. Credentials stay in
   the environment where they have to (never argv, never logged; d044);
   `-vbs-mirror-all.sh` takes none, because the HAR capture *is* the auth.
3. **Verbosity belongs to the reader.** Code emits the useful-but-noisy
   detail at `debug` and tags it; nothing is dropped on the way out — d045's
   "the producer never drops a line" stands. A consumer that wants less
   selects downstream (`jq 'select(.level!="debug")'`, or one level with
   `jq 'select(.level=="error")'`). No tool keeps a `--verbose` branch, and
   no consumer has to know which tool has one.

### Considered and rejected: a `LOG_LEVEL` gate

A threshold gate in `lib/log.{mjs,sh,py}` (default `info`, prune `debug`) was
written as part of this pass and backed out. Reasons:

- Filtering is what a *reader* wants for a particular question — a log line
  the producer dropped cannot be recovered by that reader, so the producer
  must emit everything (d045's principle, reaffirmed rather than superseded).
- The repo's stream is already one JSON object per line: pruning is a
  one-liner `jq` selection on the consumer side, no per-tool knowledge
  required, and it composes with selecting fields, tools or time ranges —
  which a level threshold cannot do.
- `LOG_LEVEL` would be the one ambient variable this record blesses as
  config, contradicting rule 2 for no gain.

### What changed

| Retired | File | Now |
|---|---|---|
| `--check` | `llm-local-inference/model-sizes.mjs` | the run rewrites byte-identically; `git diff` is the staleness report. Any argument is refused with a pointer to that fact. |
| `--verbose` | `llm-local-inference/model-sizes.mjs` | per-repo extra-quant detail is always emitted at `debug`, level-tagged for a reader-side `jq` selection. |
| `--verify` | `git/migrate-to-bare.mjs` | `git fsck --connectivity-only` runs for every conversion, before `--delete-originals` can fire. |
| `--refresh` | `local-llm/fetch_hf_manifests.py` | a networked run re-fetches and rewrites; `--offline` is the only narrowing. |
| `--deep` | `git/audit.mjs` | always: HEAD + `git status --porcelain` per repo; `detached`/`dirty` are now unconditional in the JSON report. |
| `MODELS_DEV_REFRESH` + the Termux keep-vendored default | `coding-agent/generate.mjs` (+ the root pass-through line, the DESIGN profile sentence) | catalog refresh is best-effort on every host: running `generate` means "I want current data"; a failed fetch keeps the vendored copy. |
| `MIRROR_MIN_INTERVAL` | `git/maintain-mirrors.mjs` | `--min-interval`, or the host-dependent default (60 s software forge / 0 public). |
| `VBS_MANIFEST`, `VBS_BASE`, `VBS_ORG`, `VBS_MANIFEST_JQ` | `git/-vbs-mirror-all.sh` | the manifest (argv) supplies tenant origin and org — `vbs-har.sh` always writes both — and the extractor is this file's own code. |
| `VBS_RETRIES`, `VBS_RETRY_DELAY`, `VBS_RATE_DELAY`, `VBS_BACKOFF_MAX`, `VBS_THROTTLE`, `VBS_FAIL_STREAK`, `VBS_COOLDOWN` as env | `git/-vbs-mirror-all.sh` | constants (the d044 rate-limit contract), with `--throttle`/`--retries`/`--cooldown` as the flags that move them. |
| `VBS_DEST`, `VBS_TRANSPORT`, `VBS_SSH_USER`, `VBS_HTTP_USER` as env | `git/-vbs-mirror-all.sh` | flags: `--dest DIR` (default `$WORK_MIRRORS`), `--transport ssh\|https`, `--ssh-user USER`, `--http-user USER`. They are not secrets — a username on argv is visible and that is fine (d044: "neither choice stores a secret — only the username"). |
| `--verbose` as a concept | `lib/log.mjs`, `lib/log.sh`, `lib/log.py` | no gate; the fileoverview/header policy now points readers at the `jq` selection above. |

## Tradeoffs accepted

- **`run-all.sh` upkeep hits the HF API once per repo, every run.** The
  cache-first default meant the "refresh manifests" step silently stopped
  refreshing; the cost is now paid in API traffic instead of in staleness.
  `--offline` remains the no-network path, and `--repo` narrows a run.
- **`audit.sh` is slower on a 776-clone farm** (one `git status --porcelain`
  per repo), and its report shape is now always `{detached, dirty}` where it
  was previously conditional on the flag. A slower audit that answers the
  question once beats a fast one nobody re-runs.
- **`migrate.sh` pays an `fsck --connectivity-only` per conversion** even for
  a sweep that deletes nothing. That fsck is also the only thing standing
  between `--delete-originals` and an unrecoverable delete.
- **Termux generation refetches the 4.3 MB models.dev catalog** where it used
  to keep the vendored copy. The refusal was a default, not a capability
  (d039's Termux profile still governs staging).
- **The per-repo cache detail now prints by default** (at `debug`), where a
  `--verbose` flag used to hide it. The reader prunes with `jq`; the producer
  is never the one to decide what someone else needs to see.
- **`--dest`/`--ssh-user` mean a longer command line**, and usernames are
  visible in `ps`. Neither is secret (d044), and the resolved dest/transport
  were already logged on the run's first line.
- **`VBS_MANIFEST_JQ` is gone**: a manifest whose envelope
  `default_manifest_jq` does not know now requires editing that function
  rather than exporting a variable. Editing the script was the likely next
  step anyway — the converter's output is the shape that matters, so the
  extractor belongs next to it.
- **`VBS_BASE`/`VBS_ORG` cannot be supplied by env.** A manifest without a
  `base` field now fails loudly (`no tenant origin: manifest has no base
  field`); `vbs-har.sh` always writes one.

## What was NOT removed

- **Scope/selectors**: `--only`, `--exclude`, `--jobs`, `--max-depth`,
  `--root`, `--branches`, `--port`, `--num`, `--max-entries`, `--list`,
  `--no-fetch`, `--no-optimize`, `--min-interval`, `--offline`.
- **Effect switches with real semantics**: `FORCE` (cache-bust), `SKIP_PKG`,
  `SKIP_GEN` (artifact source), `LOCAL_INFERENCE=1`, `PEERS_ONLY`,
  `BADSSL_DOWN`, `--redownload`, `--delete-originals`, `--force`,
  `--transport`.
- **Host/peer configuration**: `IMAGE_TAG`, `HOST_PORT`, `CONTAINER_TOOL`,
  `HF_HUB_CACHE`, `LOG_FORMAT`, `INFISICAL_*`, `PEER_*`, `REFERENCES_*`,
  `ZOEKT_*`, `WORK_MIRRORS`.
- **Output shapes**: `--json`, `--list`, `--format`.
- **External-CLI passthroughs** and **`--help`**.
- **The archived `local-llm/` Python tools** (`generate_vram_fit_tables.py`,
  `gguf_context_length.py`, `scan_cache_coverage.py`,
  `scan_cache_for_manifest.py`) — deliberately untouched; they are a
  separate retirement question.

## Mechanical changes

| Surface | Change |
|---|---|
| `llm-local-inference/model-sizes.mjs` | flag parser deleted; `reportCacheOnly` takes no mode; detail → `logDebug`; JSDoc that had drifted (`--verbose` "accepted without effect") deleted with the flag |
| `git/migrate-to-bare.mjs` | `verify` option, case, help line and header bullet removed; fsck unconditional with a why-comment |
| `git/audit.mjs` | `--deep` option/case/help removed; per-repo checks unconditional; report/log spreads simplified |
| `local-llm/fetch_hf_manifests.py` | `--refresh` argument removed; `load_manifest` fetches unless `--offline`; the `if args.refresh or repo not in seen` branch (which re-fetched the same repo once per entry) collapses to `if repo not in seen` |
| `coding-agent/generate.mjs`, `generate.mjs` | catalog refresh unconditional; `MODELS_DEV_REFRESH` gone from the env block and the root pass-through list |
| `git/maintain-mirrors.mjs` | env seed removed from `parseArgs` and the usage bullet |
| `git/-vbs-mirror-all.sh` | env-init split into policy constants (hard) and host state, then host state moved to flags too (`--dest`, `--transport`, `--ssh-user`, `--http-user`); manifest/base/org resolution simplified; usage rewritten; extractor override dropped; trailing newline added so `shfmt -d` is clean |
| `git/vbs-har.mjs`, `docs/d044` | the two places that named `VBS_SSH_USER`/`VBS_HTTP_USER` now name the flags |
| `lib/log.mjs`, `lib/log.sh`, `lib/log.py` | no gate: policy paragraphs now say filtering is the reader's job and name the `jq` selection (d045 reaffirmed) |
| Docs | usage surfaces updated in `git/non-bare-issues.md`, `docs/d053`, `docs/d044`, `docs/refresh-local-llm-manifest.md`, `coding-agent/DESIGN.md`, README rows |
| Records | status-line forward pointer added to **d058** (verifier + env-seed clauses); **d045** untouched and reaffirmed |

## Superseded mentions

- **d058** "What was NOT removed" — its verifier bullet (`--check`,
  `--verify`) and the `MODELS_DEV_REFRESH` entry in its effect-switch list.
  The rest of d058 stands.
- **d044**'s rate-limit caveat (env names → fixed policy + flags), its
  `--delete-originals` caveat (the fsck is unconditional), and the two
  `VBS_SSH_USER`/`VBS_HTTP_USER` mentions (→ `--ssh-user`/`--http-user`).
- **d053**'s idempotence/verbose/usage/acceptance lines for `model-sizes`.
- **d045** is *not* superseded: its no-level-filtering rule survived this
  pass (the gate was written, then removed — see above).
- **d058**'s keep-list is the baseline; this record narrows it.

## Verification

- `./check-types.sh` → rc 0; `node --test` → 25 pass, 0 fail;
  `python3 -m py_compile local-llm/fetch_hf_manifests.py` → clean.
- `shellcheck -x` on the touched `.sh` files → clean; `shfmt -d
  git/-vbs-mirror-all.sh` → clean (after the missing trailing newline).
- `./llm-local-inference/model-sizes.sh` → rewrite, then
  `git status --porcelain lib/llamacpp-model-data.json` empty (byte-identical
  ⇒ the run IS the review); its `debug` detail lines print unfiltered, and a
  stale `LOG_LEVEL=error` in the environment prunes nothing.
- `./llm-local-inference/model-sizes.sh --check` → exit 1,
  `unknown argument: --check — no flags; run it and read \`git diff\` (docs/d060)`.
- `./git/audit.sh --help` → `usage: ./git/audit.sh [--root DIR] [--max-depth N]`;
  `./git/audit.sh --deep` → `unknown flag (try --help)`; a real sweep reports
  `detached`/`dirty` with no extra flag.
- `./git/migrate.sh --help` → no `--verify` line; a temp-root conversion
  fsck's and produces a bare mirror.
- `./git/-vbs-mirror-all.sh --help` → flags block (`--dest`, `--transport`,
  `--ssh-user`, `--http-user`) plus rate-limit flags; no `Env:` block;
  `./git/-vbs-mirror-all.sh --manifest FILE` without a dest →
  `no mirror dest: pass --dest DIR (or set WORK_MIRRORS)`.
- `MIRROR_MIN_INTERVAL=999 ./git/maintain.sh --help` → unchanged usage (the
  env is never read).
- `./coding-agent/generate.sh` → rc 0 with the catalog refresh on every run.
- `./lint.sh` → rc 0.
