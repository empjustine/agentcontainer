---
id: d030
type: architecture-design
status: proposed
title: "d030 — coding-agent flow: complexity audit and simplification options"
parent: architecture
---

# d030 — coding-agent flow: complexity audit and simplification options

status: proposed (nothing decided) · relates-to: d023, d024, d027, d029

## Implementation status (2026-09)

Option 4 (`workload_env_allowlist` in `lib/workload-runtime.sh`, now used by
both run scripts) and option 5 (`coding-agent/gen-lib.mjs` generator kit) have
shipped, with a behavioural test for option 4 in `tests/check-workload.sh`.
Option 3 (prefix GC) was drafted and then REVERTED: the stage dirs under
`~/workspace/agentcontainer-*` are the mounted agent state (session /
transcript history) and `workload_rm` also discards container logs, so pruning
by prefix destroys history — not a simplification. Options 1+2 (host staging +
slim launch chain) and 6 (unify the two cloud generators) remain open; these
figures still describe pre-batch sizes for those options.

## Scope of the flow (as measured)

The sizes below are **order-of-magnitude** figures: they drift as the code
grows, so read them as "a few hundred lines", not a contract.

The coding-agent flow is the repo's largest machinery:

| Piece | Size | Role |
|---|---|---|
| `coding-agent/run.sh` | ~260 ln | dual-branch launcher (container sandbox / Termux native) |
| `coding-agent/generate.sh` | ~345 ln | unified generator: staging, probe cascades, install, fallbacks |
| 5 generators + 3 helpers | ~1,450 ln | models.json layers (010/012/015/016), merge, opencode config |
| `lib/*.mjs` shared toolkit | ~1,250 ln | probe engine, shaping, fact tables, artifact/log contracts |

The good news first: the probe semantics are already centralized
(`lib/peer-probe.mjs` owns the "reachable ≠ authenticated" rule that used to
be pasted in three generators, d022/d023), and model shaping is shared
(`lib/pi-models.mjs`, d024). The remaining complexity is concentrated in the
**host↔container plumbing** and in **two generators that are near-duplicates
by table**.

## Findings

**F1 — the input manifest exists four times.** The fact "which files the
generators and their lib/ imports need" is encoded as: (a) `run.sh`'s
per-file `workload_ro` loop over the generator dir (~15 mounts), (b) `run.sh`'s
lib/ mount block (7 more), (c) `generate.sh`'s scratch-stage copy loop over
the same generator list, (d) `generate.sh`'s lib-copy loop over the same lib
list. The comments record what happens when these drift ("settings.json used
to be missing: it died at the settings cp … a bare `cp: cannot stat` as the
only clue"). Four lists that must agree by hand is the single largest
maintenance hazard in the flow.

**F2 — the scratch staging is mostly redundant.** `generate.sh` copies
generators+lib into a `$RUN_DIR/pi-models-gen.$$` scratch dir because its own
dir may be a read-only mount inside the container — but `run.sh` already
builds a per-run staging dir on the host (`~/workspace/<container>`). The
staging could happen *on the host*, mounted once; the in-container copy
loop, the `models.dev.api.json` symlink trick, and the "catalog not
writable → tmp+rename replaces the symlink" subtlety all exist to work around
mounts that wouldn't be needed. (Note: run.sh's "never mount the whole dir —
it also carries host-local, untracked files" comment stays true; the point is
staging a *clean* subset on the host, not mounting the raw dir.)

**F3 — the generated `launch.sh` duplicates failure reporting that
`generate.sh` already owns.** The heredoc in `run.sh` implements tee + an
rc-file PIPESTATUS emulation (because `/bin/sh` has neither) + last-line
failure quoting — while `generate.sh` itself already has a structured EXIT
trap that logs `generate.sh aborted` with stage + exit code, machine-quotable.
Two overlapping failure-reporting layers on the same stream.

**F4 — no GC for timestamped containers/stages.** Each container-host run
creates `agentcontainer-$(date +%Y%m%d%H%M%S%3N)` and a staged dir under
`~/workspace/`; `workload_rm` only ever removes the *current* name; nothing
prunes the prefix. On a long-lived GPU host this accumulates one container +
one stage dir per run, forever. (Hygiene/reliability, not correctness.)

**F5 — the env allowlist is per-runner and hand-copied.** `run.sh` forwards
11 vault keys in an inline loop; `llm-local-inference/run.sh` forwards 2
individually. The key *lists* drift risk; the mechanism (non-empty check,
`workload_env`) is identical and belongs in `lib/workload-runtime.sh`.

**F6 — near-duplicate cloud generators.** `generate-cloud-pi-native-
providers.mjs` (~225 ln, override-only for providers pi ships) and
`generate-cloud-alternative-providers.mjs` (~635 ln, full blocks for providers
pi lacks) already share the probe toolkit, the fact tables, the shaping, and
the direct-vs-peer route cascade; both are table-driven. The *only* semantic
difference is full-block vs override-only output. ~860 lines where ~500
might do, at the cost of a wider single file.

**F7 — generator boilerplate ×5.** Every `.mjs` generator re-derives
`scriptDir` / `LIB_DIR` / import headers (~15-25 lines each).
`llm-local-inference/gen-lib.mjs` is the repo's own precedent for a per-folder
kit; `lib` has no equivalent for the coding-agent generators.

## Options

1. **Stage on the host, mount once** (fixes F1+F2): `run.sh` assembles the
   scratch tree in `$workload_stage/gen` (it already stages there), mounts
   that single dir (rw — it is host-local throwaway and the catalog refresh
   wants to write), and `generate.sh` consumes it directly. The manifest
   moves to exactly one place (host-side staging); the copy loops, symlinks,
   and three of the four lists disappear. Highest value, moderate effort.
2. **Slim the launch chain** (F3): either switch the chain to `bash` with
   `set -o pipefail` (the image has bash — the chain already execs bash at
   the end) and delete the rc-file emulation, or drop the tee and trust the
   EXIT trap; keep one failure reporter, not two.
3. **GC by prefix** (F4): at run start, remove containers whose name matches
   `agentcontainer-*` and stage dirs under `~/workspace/` matching the same
   prefix (opt-out env for concurrent sessions). ~10 lines in `run.sh`.
4. **`workload_env_allowlist`** in lib (F5): a shared function taking the
   key names; each run.sh passes its list, which can then live next to the
   provider fact table it derives from.
5. **Extract a `lib` generator kit** (F7): the scriptDir/LIB_DIR/import
   preamble becomes one import; optionally home for shared cascade helpers.
   Low risk, mechanical.
6. **Unify the two cloud generators** (F6): one table with a
   `mode: override|full` column. Do this *after* 5; it is the riskiest of
   these (semantics differ subtly — e.g. cline-pass `supportsDeveloperRole:
   false`, hyper's deepseek thinking format) and deserves its own diff.

## Recommendation

5 → 3 → 4 (mechanical), then 1+2 together as the structural cut (they touch
the same host/container boundary), with 6 deferred until 1 has landed and the
staging contract is stable.

## Explicitly not flagged

- The layered `models.json` merge (filename-ordered `model-*.json` overlays +
  deep merge) — its contract is documented in `merge-models-json.mjs`, the
  layers are machine-generated, and the 0-provider keep-guard is a real
  correctness feature. Keep.
- The dual Termux/container profile: already unified into one script pair;
  the remaining branch points are honest environment differences.
- SKIP_GEN/DRY_RUN orthogonality: documented, coherent, keep.
