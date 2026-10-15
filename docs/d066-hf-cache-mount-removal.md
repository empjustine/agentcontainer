---
id: d066
type: decision
status: implemented
title: "d066 — coding-agent/run.sh stops mounting the host Hugging Face cache"
parent: coding-agent
depends-on: [coding-agent]
references: [d026, d052, d056, d059, coding-harness-persistence]
tags: [coding-agent, mounts, huggingface, cache, sandbox]
---

# d066 — No Hugging Face cache mount in the coding-agent sandbox

**Status: implemented.** `coding-agent/run.sh` no longer binds the host's
Hugging Face cache into the sandbox. The `HF_HUB_CACHE` default computation
and the `workload_rw "$HF_HUB_CACHE" /home/$USER/.cache/huggingface/hub`
call are deleted, along with the commented-out `workload_ro_if` variant that
had been sitting next to it. A launch that wants the cache names it as a
DIRECTORY argument, like any other extra mount (docs/d056).

Superseded in part by **d068**: "mounts it at its own host path" is the host
side; in the sandbox the DIRECTORY lands at `~/.cache/huggingface/hub` —
Hugging Face's default path — so the warm cache needs no in-container
`HF_HUB_CACHE` override either (decision 3).

## Problem

The mount was the last remaining unconditional, existence-unguarded host bind
in the runner. Three properties compounded:

1. **Unconditional.** Every launch bound the cache, whether or not the
   session had anything to do with Hugging Face. Nothing in the ARGV or the
   environment selected it; the only way to avoid it was to edit the script.
2. **Existence-unguarded, in the aborting direction.** `workload_rw` routes
   through `_require` (`lib/workload-runtime.sh`), so a missing
   `$HF_HUB_CACHE` does not skip the mount — it kills the launch
   (`log_die 91 "read-write mount ... not found"`). A host that has never
   run `hf download` could not start the sandbox at all. The
   `workload_ro_if` helper (skip when the source is absent) is the variant
   that matches an optional cache, and the script even carried a commented
   `workload_ro_if` line for exactly this path — the live call was not it.
3. **Read-write, over the host's real model store.** The sandbox received
   write access to the operator's cache — on the reference host 2.4 TB under
   `~/.cache/huggingface/hub` — so an in-container `hf` invocation could
   modify or delete host models that the llm-local-inference workload serves
   from that same directory. A cache the sandbox only ever needed to *read*
   was mounted rw by default.

The cache also rode along on the `z,U` relabel path
(`lib/workload-render.jq`), so its walk was paid on every launch and grew
with the store — the cost class docs/d056 moved to an explicit ARGV opt-in
for the reference mirror. Here it stayed a hidden default.

## Decisions

1. **No HF cache mount.** The binding, its `HF_HUB_CACHE` default chain
   (`HF_HUB_CACHE` → `XDG_CACHE_HOME/huggingface/hub` → `~/.cache/...`),
   and the dead commented `workload_ro_if` line are gone. The runner's
   mount set is now exactly: the argv DIRECTORYs, pi's agent dir and session
   stage (docs/d054), opencode's config and data dirs (docs/d065), Cline,
   ThinkRail, and the launch chain + logger. Every one of them is either
   named by the operator or required by a harness contract.
2. **The image's own cache is what `hf` uses in-container.** The
   Containerfile already creates and chowns `~/.cache/huggingface/hub`
   (the `huggingface-hub` pipx tool is in `config.toml`), so the CLI works
   unchanged — it just writes to the container's own layer, i.e. the download
   is per-container and ephemeral. That is the correct default for a coding
   sandbox: nothing the agent downloads silently becomes host state.
3. **The warm host cache stays reachable, explicitly.** `./run.sh
   ~/.cache/huggingface/hub` mounts it at its own host path (the d056
   contract), and an in-container `HF_HUB_CACHE` pointed at that path makes
   `hf`/transformers use it. There is deliberately no env toggle
   re-introducing a special case: argv is the mount manifest (docs/d056,
   docs/d060).
4. **`llm-local-inference/run.sh` keeps its mount.** That workload's
   `llama-server` commands are generated with paths *inside*
   `/home/ubuntu/.cache/huggingface/hub`, so the cache is load-bearing
   there, and it is already mounted read-only (`workload_ro`). This record
   changes only the coding-agent sandbox.

## Invariants and consequences

- **A host with no HF cache can launch the sandbox.** The exit-91 abort for a
  missing mount source no longer has this path to fire on; the remaining
  mount sources are all `mkdir -p`-ed by `run.sh` or produced by it
  (stage, launch chain).
- **The sandbox can no longer write to the host model store.** Downloads done
  inside the container land in the container layer; a container that is
  removed takes them with it.
- **`HF_HUB_CACHE` is no longer read by `run.sh`.** It remains a real
  variable for the HF tooling (docs/hf-cache-upkeep.md,
  `llm-local-inference/run.sh`, the archived `local-llm/` scanners) and for
  the in-container opt-in above — it simply stops being a mount control here.
- **Relabel cost drops** for launches that never wanted the cache; the
  per-file walk (2938 files on the reference host) is no longer paid
  unconditionally.
- **Nothing inside the sandbox regresses silently**: the image's cache dir
  exists and is writable, so an `hf` call fails the same way it would on a
  cold host, not with a missing-mount error.

## Alternatives considered

- **`workload_ro_if` (the commented-out line).** Fixes the abort and the
  write exposure, keeps the unconditional relabel cost and the implicit
  default. Rejected: it is a smaller edit with most of the problem left.
- **`workload_rw_if`.** The helper was removed (`lib/workload-runtime.sh`:
  "nothing called it") and rw over the host model store is the exposure this
  record is removing. Rejected.
- **Opt-in via a host env var (mount only when `HF_HUB_CACHE` is set).**
  Ambient env as a config surface is what docs/d060 retired; a launch that
  wants the cache can say so in the ARGV. Rejected.
- **Mount it read-only unconditionally.** Still a hidden default, still a
  hard dependency, still an unrequested host dir in every sandbox. Rejected.
- **Leave it as-is and document the escape.** The default is the defect; a
  doc note does not stop the sandbox from writing into the host model store.

## References

- `coding-agent/run.sh` — the mount manifest and the deleted binding.
- `coding-agent/Containerfile` — creates the image's own
  `~/.cache/huggingface/hub`.
- `docs/d056-run-directory-mounts.md` — argv is the mount manifest; the
  reference-mirror relabel cost is the same class this record retires.
- `docs/d054-pi-agent-and-session-dir-mounts.md` /
  `docs/d065-opencode-host-config-mount.md` — the host-backed mounts that
  remain, and why they are harness contracts rather than conveniences.
- `docs/coding-harness-persistence.md` — the persistence table this record
  updates (the Hugging Face row is gone).
- `docs/d026-data-diode-audit.md` — the direction-of-flow concern the rw
  host mount violated.
