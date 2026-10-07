---
id: d058
type: architecture-design
status: implemented · verifier + env-seed clauses superseded by d060
title: "d058 — retire simulation modes: writes are atomic swaps, review is git diff"
parent: architecture
depends-on: [d041, d042, d050]
references: [d030, d033, d041, d043, d044, d049, d053, d055]
tags: [generators, build, git-tooling, dx]
---

# d058 — Retire simulation modes (dry-run / plan flags)

**Status:** implemented · superseded in part by **d060** — the two "reality
verifiers" it kept (`model-sizes --check`, `migrate --verify`) and the env-seeded
knobs it listed as effect switches (`MODELS_DEV_REFRESH`, `MIRROR_MIN_INTERVAL`,
the `VBS_*` env surface) are retired as well; the keep-list below now ends at
scope selectors, real effect switches, `--help`, and reader-side verbosity
filtering (`jq 'select(.level=="...")'`, d045's rule reaffirmed).

## Problem

Three flavours of "pretend to do it" had accreted across the repo:

1. **`DRY_RUN=1`** on every generator — the write landed in a sibling
   `<out>.dry-run` preview instead of replacing the artifact. It started as a
   repo-wide standard (`lib/artifact.mjs` exported `isDryRun()`), so every
   consumer carried the branch: the proxy generator's post-write check had to
   know which path was "real", the coding-agent orchestrator documented the
   interplay with `SKIP_GEN`, the README taught it as normal usage.
2. **`BUILD_PLAN=1`** on the root build — log the target set, exit 0.
3. **`--dry-run`** on four `git/` maintenance tools — "print the plan, touch
   nothing".

The modes failed on their own terms:

- **The preview is not the artifact.** Ordering (d050 canonical JSON), merge
  effects, and the stale-layer removal only show up in the real write, so the
  preview had to be read *and* the real run had to happen anyway.
- **Two execution paths per tool.** The path nobody runs is the path that
  rots; `search-references --dry-run` was explicitly documented as *the*
  test path on a host with no container tool, i.e. a simulation of testing.
- **Every consumer re-implemented the mode**, which is how the writer's
  contract leaked into orchestration code and README prose.
- **The repo already has a review surface.** Generated artifacts are
  committed and ordering is deterministic (d050): regenerate, `git diff`, and
  the diff *is* the preview — against real inputs, not a simulation of them.

## Decision

1. **`lib/artifact.mjs` writes only by atomic substitution**: sorted tmp
   file, then `rename(2)` over the destination. A byte-identical destination
   is left alone; a *missing* destination is a hard error (the writer exists
   to replace things). No `DRY_RUN`, no `.dry-run` previews, no `isDryRun()`
   export.
2. **`build.mjs` always builds.** It still logs the resolved target set and
   `force` level before starting — that log is orientation, not a mode.
3. **`git/` tools drop `--dry-run`.** `migrate` (local conversion),
   `maintain` (align + optimize), `-software-forge-mirror` (clone/align) and
   `search-references index/serve` were already idempotent and already leave
   the target as-is on failure with a loud log.
4. **Review = run it, then `git diff`.** Previewing a change to a committed
   artifact means producing the change.

## Tradeoffs (accepted)

- **The Termux branch of `build.mjs` has no non-executing check from a
  container host** — `BUILD_PLAN=1` was the only such mode (d041's own
  bullet said so). Accepted: one code path beats a second path kept alive
  for testability; reviewing that branch stays a code read.
- **`search-references` can no longer be exercised on a host without
  podman/docker.** Accepted: its preview printed an argv that never ran, so
  it validated nothing about the real invocation.
- **Inspecting a pending change costs a real run**, including hosts where a
  run needs the GPU gate or network. Accepted: those hosts own the artifact
  anyway (d041 evidence: a keyless/GPU-less host cannot regenerate
  `config.d/` and says so loudly rather than previewing).

## What was NOT removed (and why)

Flags that select *what work happens* or change its inputs are not
simulation modes, and stay:

- **Scope/selectors**: `--only`, `--exclude`, `--jobs`, `--max-depth`,
  `--no-fetch`, `--no-optimize`, `--min-interval`, `--branches`, `--port`.
- **Effect switches with real semantics**: `FORCE` (cache-bust),
  `SKIP_PKG`, `SKIP_GEN` (artifact *source*: committed file vs. fresh
  generation), `MODELS_DEV_REFRESH`, `LOCAL_INFERENCE=1`, `PEERS_ONLY`,
  `BADSSL_DOWN`, `--redownload`, `--delete-originals`, `--force`.
- **Verifiers that assert about reality instead of previewing an
  alternative**: `model-sizes --check` (exit 1 on drift), `migrate --verify`
  (fsck of the produced mirror), `--help`.

## Mechanical change list

| Surface | Change |
| --- | --- |
| `lib/artifact.mjs` | `DRY_RUN` branch, `isDryRun()` export, `<out>.dry-run` previews removed; writer is always tmp + rename |
| `build.mjs` | `BUILD_PLAN` read/exit removed; target log reworded to "build targets" |
| `coding-agent/generate.mjs`, `llm-reverse-proxy/generate.mjs`, `llm-local-inference/generate.mjs`, `model-sizes.mjs`, root `generate.mjs` | `DRY_RUN` env docs and `.dry-run` orchestration branches removed |
| `git/maintain-mirrors.mjs`, `git/migrate-to-bare.mjs`, `git/software-forge-mirror.mjs`, `git/search-references.mjs` | `--dry-run` flag, "would …" branches, and no-container-tool placeholder paths removed |
| `llm-reverse-proxy/README.md`, `git/non-bare-issues.md` | usage surfaces updated |

## Superseded mentions (left as record, not rewritten)

Past-tense verification/evidence lines keep their history; the *living*
usage surfaces above were updated in place and point here: d030
(SKIP_GEN/DRY_RUN orthogonality bullet), d033 (usage), d041 (BUILD_PLAN
bullet; evidence sections), d043 (usage + preview bullet), d044 (dry-run
verification note), d049 (audit note), d053 (usage line; acceptance),
d055 (dry-run generation evidence).

## Verification

- `./check-types.sh` (tsc `--strict` on `checkJs`) — rc 0.
- `./lint.sh` (biome + shellcheck) — rc 0.
- `node --test` — 25/25 pass.
- `llm-reverse-proxy/generate.mjs` run to a `/tmp` path — writes, post-write
  check runs against the real `out`.
- `lib/artifact.mjs` round-trip in `/tmp` — create, then substitute: same
  destination path, no `.tmp`/`.dry-run` leftovers.
- Generators that write committed artifacts were **not** rerun on this host
  (no GPU / no container tool — see d041's evidence sections).
