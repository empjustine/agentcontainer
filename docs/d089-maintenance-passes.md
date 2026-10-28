---
id: d089
type: decision
status: implemented
title: "d089 — maintenance passes: align, optimize (default), deep"
parent: d044
depends-on: [d044, d060, d076]
references: [d043, d044, d060, d076]
tags: ["git", "references", "mirrors", "storage", "gc"]
---

# d089 — maintenance passes: align, optimize (default), deep

**Status: implemented.**

## Problem

`maintain-mirrors.mjs` had two phases — align (`remote update --prune`) and
optimize (`repack -adb --write-bitmap-index` + `commit-graph write --reachable
--changed-paths`). The optimize pass never forces delta recomputation, so its
pack stays only as small as the delta choices already in it: for mirrors that
barely change and sit on size-constrained cold storage, the one operation that
materially shrinks them — `git gc --aggressive`, a forced repack with
window/depth 250 — never runs. An independent agent audit flagged the gap.

Adding gc passes raised two questions that had to be answered before any flag
could exist:

1. **Does a routine non-aggressive gc undo an aggressive pass's gains?** No.
   `git repack` reuses the deltas already in the packs unless forced (`-f`),
   and neither plain `git gc` nor `repack -adb` is forced. Only another forced
   repack recomputes deltas. The passes therefore *compose*: aggressive
   rarely, routine between, with only newly fetched packs carrying weak
   deltas until the next deep pass.
2. **Which rungs are real?** A four-rung proposal — fetch/prune only, normal
   gc as the new default, aggressive gc, aggressive gc + pickaxe optimization
   — collapses on inspection:
   - "normal gc as default" is a *downgrade* of the existing optimize pass:
     partial pack consolidation (`repack -d -l -A`, not `-a`), a conditional
     bitmap write, no changed-paths guarantee — and it would silently change
     what every existing invocation does.
   - "aggressive gc" alone is dominated by "aggressive + pickaxe
     optimization": the two differ only by the bitmap and commit-graph
     writes, which cost seconds-to-minutes against an hours-long forced
     repack. A rung that pays the most expensive cost and skips the cheap
     accelerators is a footgun on a farm whose purpose is search
     (d043/d044).

## Decision

Three rungs, one new flag on the existing program, and the routine pass stays
the default:

| rung | selection | work |
|------|-----------|------|
| align | default (`--no-optimize` keeps only this) | `git remote update --prune` |
| optimize | default | config + `repack -adb --write-bitmap-index` + `commit-graph write --reachable --changed-paths` |
| deep | `--deep-optimize` | config + `git gc --aggressive` + the full optimize sequence re-run |

`--deep-optimize` implies the optimize pass and conflicts with
`--no-optimize` (rejected at argument parsing): deep without optimize repacks
and then leaves no guaranteed pickaxe accelerators — exactly the footgun the
collapsed rung avoids.

Why the optimize sequence re-runs *after* `gc --aggressive`: gc's own
commit-graph write (via `gc.writeCommitGraph`, already set by the config step)
carries no `--changed-paths` guarantee, and its bitmap write is conditional
(full repack of a bare repo, `repack.writeBitmaps`). Re-running the sequence
pins the end-state every optimizing pass must leave the mirror in, at a cost
that is noise against the forced repack.

`git maintenance start` stays rejected for this too (d044): the deep pass is
precisely the kind of multi-hour work a per-repo background timer must never
own.

### Ordering within a run

fetch → deep (when asked) → optimize. The deep work is local I/O, not
upstream requests, so it gets no pacing gate — it lives in the same per-host
queue as the fetch it follows (d076), one host never has two jobs in flight,
and different hosts' deep passes still overlap. `--min-interval` paces
fetches; that is its whole contract (d044) and it does not grow a second
meaning.

### Expected runtime

An aggressive repack is CPU- and I/O-heavy and slow on cold storage by
design; a `--deep-optimize` sweep of the farm is an hours-to-days job. It is
meant for targeted runs (`--only`, `--no-fetch`) or infrequent whole-farm
passes, not every sweep. Per-mirror maintenance logs carry a `deep` field so
the reader can see what a sweep chose (`jq` pruning is the d045 contract).

## Consequences

- The storage gap closes without changing any default: existing invocations
  keep doing exactly what they did; deep is opt-in and lives in argv (d060:
  argv is the config, no ambient env surface).
- The rungs compose across time as well as within a run. Interleaving weekly
  routine sweeps with an occasional deep pass is safe — delta reuse means
  routine work never destroys the aggressive pass's compression.
- A separate plain-`git gc` rung was rejected: the optimize pass already does
  everything a plain gc would, except pruning unreachable objects. If that
  ever matters for mirrors, it belongs where it already is — the deep pass's
  gc prunes per `gc.pruneExpire` — not in a pass only a gc provides.

## Verification

`tests/git-deep-optimize.test.mjs` builds a throwaway farm and runs the real
program with a `git` wrapper on `PATH` that records argv before exec'ing the
real git. Asserted: the default sweep never spawns `gc`; `--deep-optimize`
produces, per mirror, `gc --aggressive` followed by
`repack -adb --write-bitmap-index` and `commit-graph write --reachable
--changed-paths`; `--deep-optimize --no-optimize` is rejected.
