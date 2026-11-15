---
id: d198
type: module-design
status: draft
title: "d198 — reversible mutation: journal, checkpoint, and the surface width they buy"
parent: codemode2
depends-on: [d196, d194]
references:
  [d020, d026, d054, d162, d164, workload-api, workload-sandboxing-prior-art, bwrap-runtime-audit]
tags: ["codemode2", "reversibility", "snapshot", "journal", "worktree", "isolation", "design"]
---

# d198 — reversible mutation: journal, checkpoint, and the surface width they buy

This record prices the isolation envelope [d196](d196-refusal-cascade-and-isolation-envelope.md)
designs. It states the invariant that connects reversal to the tool surface, what the
prior work in this tree already covers, the mechanisms that can provide reversal at
what cost, the two-level shape worth building, and the five measurements that decide
whether "reversible" is cheap enough to be the default grade.

It is not a containment design — that is the workload layer's question
([workload-sandboxing-prior-art](workload-sandboxing-prior-art.md),
[d020](d020-libvirt-qemu-sandbox.md)) — and it is not built. The reader is whoever
implements the executor's write nodes, whoever operates the refusal cascade, and
whoever audits a rollback after the fact.

## Status

Draft, unbuilt, and mostly unmeasured. It took the next free number when a concurrent
line of work claimed d197. The one measured number it leans on is
[d162](d162-powershell-endpoints-are-deleted.md)'s reflink figure, taken on a WSL2
host, not on this tree. Everything else below is a mechanism's documented property
plus a design argument; the measurement plan is the last section.

## The invariant: width is bought by reversibility

A verb is not auto-graded because it is harmless. It is auto-graded because its
**effect is undoable**. Stated the useful way round: the refusal rate a model meets
is proportional to the irreversibility of its verbs, so shrinking the irreversible
set and widening the surface are the same work.

Three consequences follow, and they are the reason this record exists rather than
living as an implementation note.

- The cascade's destructive table can **allow with a journal** instead of refusing
  (d196's third rung), because the journal is what makes the allowance honest.
- Reversal is a **product feature of the surface**, not a storage detail: it is what
  decides how much familiar tooling the model gets.
- Review is the **residue** after reversal, not the main gate. A queue built before
  the reversible/irreversible split is a queue of everything.

## What the prior research covers

| what                                | where                                                                                                                                                                                   | what it settles                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VM-level snapshot and rollback      | [d020](d020-libvirt-qemu-sandbox.md) (`virsh snapshot-*` over qcow2)                                                                                                                    | cheap full-state reset, and the question that recurs here: decide deliberately what is inside the snapshot — a shared workspace mount survives a VM reset                 |
| the industrial shape                | [workload-sandboxing-prior-art](workload-sandboxing-prior-art.md)'s `state_model` facet (`ephemeral / resumable / persistent / copy_apply`) and e2b's "a sandbox is a resumed snapshot" | the cost these products optimise is **restore** time; [d026](d026-data-diode-audit.md)'s per-run stage is this tree's `copy_apply`                                        |
| the cheap primitive's price         | [d162](d162-powershell-endpoints-are-deleted.md)                                                                                                                                        | `cp --reflink=always` of 100 MiB moved `df` by **152 KiB** on the WSL2 filesystem; the same copy on an NTFS volume is 102,400 KiB of new blocks                           |
| the mount layout that would host it | [bwrap-runtime-audit](archive/bwrap-runtime-audit.md)                                                                                                                                   | read-only binds, a private `/tmp`, fresh `/proc` and `/dev` — and no copy-on-write of the workload directory                                                              |
| ephemerality against audit          | [d054](d054-pi-agent-and-session-dir-mounts.md)                                                                                                                                         | a tmpfs store was rejected because it costs the host-side audit trail, which is the asset the stage protects — so a rollback must leave a journal, not delete a directory |
| micro-VM limits                     | [workload-sandboxing-prior-art](workload-sandboxing-prior-art.md) (firecracker and cloud-hypervisor ship no 9p/virtiofs)                                                                | at that tier a read-write workspace is an in-guest clone plus push-back, which is a snapshot mechanism, not a mount                                                       |
| step boundaries                     | [d164](d164-signals-stop-at-a-step-boundary.md)                                                                                                                                         | a signal stops at a step boundary, which is where a rollback can safely begin                                                                                             |

What is not covered anywhere in the tree: per-mutation undo, the choice between the
mechanisms below, snapshot policy, and any latency or space measurement of them.

## Mechanisms

| mechanism                                  | cost                                      | constraint                                                                     | provides                                                 |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| reflink copy (`--reflink=always`)          | metadata only; d162's 152 KiB per 100 MiB | a filesystem with reflink; `always`, never `auto`                              | whole-run checkpoint                                     |
| btrfs/zfs subvolume snapshot               | O(1), instant destroy                     | the run directory must own its subvolume                                       | checkpoint and reset                                     |
| overlayfs (lower = base, upper = run)      | copy-up on first touch, then normal       | rootless user namespaces; absent at the micro-VM tier                          | checkpoint **and** the changed-file diff                 |
| hardlink farm, break on write              | cheapest space of all                     | sound only when nothing writes in place                                        | checkpoint, if writes are interposed                     |
| journal plus content-addressed prior bytes | proportional to changed content           | none; portable                                                                 | per-operation undo, exact rollback, the operator summary |
| git object database                        | already paid for tracked content          | untracked and large files sit outside it; the index is the most damagable file | history below the checkpoint                             |

Four properties of that table decide the build.

- **The write monopoly licenses the cheapest mechanism.** A hardlink farm is unsafe in
  a general sandbox because `dd`, `sed -i` and a mapped write reach the same inode; here
  every mutation goes through a write node the runtime owns, so break-on-write is
  enforceable rather than hoped for. That is a direct payoff of the closed surface.
- **Reflink must fail loudly.** `--reflink=auto` silently pays a full copy on a
  filesystem without reflink, which is the silent fallback [requirements](requirements.md)'s
  NFR-2 forbids; the checkpoint either proves metadata-only or refuses to start.
- **The journal is the only mechanism that produces the operator summary.** d054's
  lesson generalises: an envelope that discards work without a record has traded the
  audit trail for silence.
- **The object database is free history below the checkpoint.** It covers tracked
  content well, untracked and large files not at all, and nothing chronicles the
  index — which is why it is a named grant in d196 rather than a directory.

## The two-level shape

Semantics and space separate, so the build is two layers rather than one mechanism.

- **Journal plus content-addressed prior bytes, per mutation.** A record carries
  `{seq, node, path, prior_hash, prior_bytes, post_hash, lease_id}`; unchanged content
  costs nothing, overwrites and deletes cost their prior bytes, and the run's summary
  is the journal rendered. Rollback is a reverse replay to a sequence number, or the
  run dropped and the checkpoint restored.
- **One checkpoint per run**, taken before the first node: reflink primary, overlay
  where reflink is absent, a loud refusal otherwise. Because the executor reviews the
  whole tree before executing (d196), one checkpoint usually suffices; a second, taken
  at the last reversible boundary before a destructive class, is the exception.
- **Rollback begins at a step boundary** (d164), so an interrupted step either
  completed and journaled or did not happen.
- **Retention is the run.** The checkpoint and the journal are discarded when the run
  ends; the export door of d196 is the only way bytes leave.

The budget that decides whether this is affordable is d196's "time before first node":
a checkpoint is metadata work on a reflink filesystem, and the journal costs a hash plus
a copy only when content is actually replaced.

## The five measurements

Each number unblocks a decision rather than satisfying curiosity.

| measurement                                                                                              | decides                                                                                                |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| checkpoint latency against repo size, including a `--reflink=always` failure on a non-reflink filesystem | whether a checkpoint is per run, per session, or per destructive class                                 |
| journal bytes per 1000 mutations                                                                         | the space envelope, and how aggressively prior bytes need a content store                              |
| rollback latency per node and for a whole run                                                            | whether rollback can be silent, or has to be reported                                                  |
| copy-up cost for a 1 GiB binary                                                                          | the file-size class where a checkpoint beats a journal entry                                           |
| fraction of real mutations that overwrite or delete                                                      | how often the journal actually pays — the same number that sets how much surface reversibility can buy |

The last one comes from the session logs ([d180](d180-session-collection-leg.md),
[d181](d181-session-ingest-route.md)) applied to the surface's write nodes, not from a
synthetic trace.

## Open questions

- **Hardlink farm alongside reflink.** The farm needs no filesystem feature but relies
  on the write monopoly; it earns a place only if an in-place-write fuzz over every
  write node fails to find a bypass.
- **Large binaries.** A 1 GiB file overwritten five times is 5 GiB of journal; a
  checkpoint-plus-revert is cheaper — so the file-size class decides, and the journal
  needs a per-size policy rather than one rule.
- **Whole-directory renames and hard links.** The journal granularity question d196
  leaves open lands here, where replay correctness is decided.
- **Whether the checkpoint is also exported**, or only the journal — d026's stage says
  the record is the asset.
- **Signal timing.** d164 stops a signal at a step boundary; a rollback triggered by a
  signal needs the same boundary, and that composition is unbuilt.
