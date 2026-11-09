---
id: d118
type: architecture-design
status: active
title: "d118 — a pi extension folder carries no lib/: folder-root modules and a script table are its whole surface"
parent: architecture
depends-on: [d024, d045, d060, d070, d113]
references: [d039, d041, d050, d074, d086]
tags: [pi-extensions, lib, entrypoints, copy-unit]
---

# d118 — a pi extension folder carries no `lib/`

## Problem

d113 gave every folder its own `lib/` hand copy, sized for the _container
runner_ shape: a `run.sh` sourced a workload API out of it and a generator
wrote artifacts through it. The six `pi-*` folders are not that shape. They are
**pi extensions** — a `index.ts` the pi host loads, plus (in four of them) a
generator that refreshes a committed catalog — and the copy they inherited was
mostly dead weight:

| file                                        | lines | used by the folder                                   |
| ------------------------------------------- | ----- | ---------------------------------------------------- |
| `lib/log.mjs`                               | 200   | 4 of 6 exports, in 2 files                           |
| `lib/canonical-json.mjs`                    | 192   | 1 of 4 exports (`serializeArtifact`)                 |
| `lib/artifact.mjs`                          | 62    | only through `generate.mjs`                          |
| `lib/cloud-providers.mjs`                   | 78    | a _loader_ for a 9–16 line JSON holding **one row**  |
| `lib/node-run.sh` (retired by d138)         | —     | a pinned-node bootstrap; the runner is now repo-root |
| `lib/workload-runtime.sh` + `workload-*.jq` | —     | absent (never needed here)                           |

2533 lines across the six folders to serve about five functions each. Two of
those files exist only to be imported: the loader to read one JSON row, and
`artifact.mjs` to re-export one function from `canonical-json.mjs`. And
`node-run.sh` pinned an interpreter for scripts that pi itself runs — the
runtime is guaranteed to work, because a broken one would break pi, not just
this folder.

## Decision

**The `pi-*` family carries no `lib/` at all.** Its kernels are modules at the
folder root, imported statically by the folder's own files.

- **`log.mjs` at the folder root**, pruned to the level functions that folder
  actually calls, keeping the JSONL contract intact (`docs/d045`, `docs/d060`:
  one object per line, `msg` first and `ts`/`severityNumber`/`tool` last per
  `docs/d151`, level filtering is the consumer's job). `setLogStream` and the
  `LOG_FORMAT=logfmt` serializer are deleted: nothing in an extension sets
  them, and a knob with no call site is a contract nobody can honour.
- **The writer is inlined into its only caller.** The four generating folders
  fold the atomic write (temp + rename) and the canonical serialization it
  applies into `generate.mjs` (`docs/d050`'s choke point is preserved
  verbatim), and the `canonicalize*` exports no call site reaches are deleted
  rather than moved.
- **The fact-table row is a frozen literal at its one consumer.** The loader
  and its JSON go. In the four generating folders the row lives in
  `sources.mjs` beside the fetch it feeds; in `pi-mistral`/`pi-opencode` —
  watchdogs with no generator — its only consumer is the folder's own test, so
  that is where it lives (`docs/d070`'s "one row per folder" is unchanged, only
  its encoding).
- **`generate.sh` is deleted; `package.json` is the entrypoint table.** A
  folder's scripts (`generate`, `test`) are the command lines, invoked through
  the repo-root `./npm-run.sh`:
  `./npm-run.sh pi-hyper generate --check`. The wrapper only
  supplies the pinned node — it reads the command line out of the folder's own
  `package.json`, so there is no second table to drift and no `npm` on the path
  (npm is itself a node program; letting PATH choose its interpreter would
  defeat the pin, `docs/d107`).
- **No bootstrap shell in the folder.** `node-run.sh` is not copied here: the
  pin is a _repo_ fact, the folder ships no `.sh` to run it from (docs/d138), and
  its own shell surface is empty.

`coding-agent/lib/npm-run.sh` was a per-unit copy of `./npm-run.sh`; it went
with the other runner copies (docs/d138), which is the one place the copy-unit
rule (docs/d113) does not reach: a folder ships its code, not its way of being
run.
The root `npm-run.sh` is the same helper for folders that ship no shell at all;
the difference in home is the difference in copy unit, not a fork of the logic.

## What this does not change

- **Artifacts are still generated output, byte for byte.** Every fold proves it:
  the pre-fold and post-fold folders are run side by side, and `models.js` /
  `models.json` come out identical. The committed header even keeps telling the
  reader how to regenerate — the instruction text was updated in the template
  and in the artifact together, and `--check` confirms they still agree.
- **`docs/d024`'s one-edit law stays retired** (`docs/d113`): a fact edit is
  still one edit per consumer. Folding a row into a literal does not merge
  consumers; it only stops hiding them behind a loader.
- **The workload API is untouched here.** `estige/` and
  `llm-local-inference/` keep their `lib/workload-runtime.sh` + `workload-*.jq`
  copies; `coding-agent/`'s move is its own record (d119).

## Consequences

- **Pruning becomes deletion.** The old copies had to stay API-complete because
  a future consumer might want the missing branch; a folder-root module can
  drop what the folder does not call, and knip enforces that it stays dropped.
- **`*/lib/*.mjs` in `tsconfig.json`/`knip.jsonc` no longer covers this family.**
  Their modules are reached by static import, so they are ordinary project
  files — a checker sees them without an entry-list exemption, and unused
  exports inside them become real findings.
- **One logger per folder is six near-identical files.** That is the d113
  bargain: they are not synced, and a folder that needs a different field set
  changes only its own.
- **An operator who exported `LOG_FORMAT=logfmt` loses it for these folders.**
  It had no call site here (the container runners' `log.sh` keeps it where it is
  used), and the alternative is carrying a serializer no folder exercises.
- **Divergence inside the family is legitimate** and already visible: `pi-hyper`
  dropped `logWarn` (no call site there), the row literal is exported where a
  test asserts against it and inlined where the test is the only consumer, and
  `pi-synthetic`'s row keeps `support` but drops a `note` that argued for a
  catalog cascade the folder deleted in `docs/d096`.

## Alternatives rejected

- **Keep a minimal `lib/`** (log + writer only). It preserves the exemption in
  `knip.jsonc` and one import path per folder, at the cost of a directory that
  exists to hold two files — and an extension folder is not a runner, so there
  is no second consumer the directory could ever serve.
- **Keep the loader and JSON, prune the JSON to one row.** The 9-line JSON was
  never the problem; the 78-line loader around it was. A literal is smaller
  than either and cannot be missing its row.
- **Copy `log.mjs` unpruned.** Five of six exports would be unused and knip
  would flag them, so the copy would be dead code that still had to be kept
  typing-clean — pruning is what makes a private copy honest.
- **Keep `generate.sh` sourcing the folder's own `node-run.sh`.** That is the
  container-runner shape d113 established, and it needs a shell bootstrap in
  every folder to serve a runtime the folder already has.
- **Copy a `npm-run.sh` into each of the six folders.** Six copies of a
  60-line wrapper to avoid one root file the sweep already owns; the pi folders
  ship no shell by design, so the wrapper belongs where the sweep lives.
