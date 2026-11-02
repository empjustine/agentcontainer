---
id: d104
type: decision
status: implemented
title: "d104 — retire the shared lib/ and the root orchestrators: a folder is a copy unit"
parent: architecture
depends-on: [d024, d039, d041, d082, d083, d101, d102]
references: [d025, d032, d042, d050, d087]
tags: [architecture, copy-unit, lib, builders, generators, tests]
---

# d104 — retire the shared lib/ and the root orchestrators

## Problem

The tree was organised as **`folder + ../lib`**: a unit's folder carried its
own code, and everything it shared — loggers, the artifact standard, the
workload API, the provider fact tables, `node-run.sh`, the model manifest —
was read out of the repo-level `lib/` by relative path. That was coherent
while `lib/` had five-plus consumers and while one root `build.sh`/`generate.sh`
sequenced every unit's work.

Both premises expired:

- `lib/`'s consumer set collapsed. `docs/d039` folded the single-consumer node
  modules back into `coding-agent/`, `docs/d101`/`docs/d102` moved the proxy's
  fact table into the estige unit's own Go-readable JSON, and the remaining
  "shared" modules were each read by two or three folders that happened to
  need slightly different rows of the same table.
- `estige/` is becoming its own repository (`docs/d082`). A folder that must be
  copyable out whole cannot depend on a parent directory one level up, and
  `git filter-repo` cannot carry `../lib` with it.

The deeper problem was the copy unit itself. `folder + ../lib` meant the unit
of reuse was *the repository*: you could not take `coding-agent/` anywhere,
`lib/` could not be pruned because every row had some consumer, and the fact
table forced every unit to ship every provider's credentials vocabulary even
where it served one provider. The root `build.mjs`/`generate.mjs` compounded
it — they were the only entrypoints, so a folder alone had no way to build or
regenerate itself (`docs/d083` had already re-added per-unit `build.sh` shims
as a workaround).

## Decision

### A folder is a copy unit

The copy unit is **one folder, alone**. Each unit carries its own `lib/` — a
hand copy of the modules and fact tables it actually uses — and nothing outside
the folder is implied by it. `lib/` at the repo root is deleted.

- **Hand copies, ownership transfer.** A copy is not a vendored dependency and
  there is no sync step, no `lib/` hash gate, and no "update all copies" tool.
  Each unit owns its copy outright: it may rename a function, prune a branch,
  or pin a different default without touching its siblings. Divergence between
  copies is ownership, not drift.
- **Pruning is the point**, not an accident of the copy. `cloud-providers.mjs`
  / `cloud-providers.json` copies carry only the rows that unit serves:
  `coding-agent/` holds the full table because it is the reference vocabulary
  `docs/d032` writes its checklist against (and the one copy `tests/` reads),
  `estige/` holds the rows its allowlist needs, and each `pi-*` extension holds
  exactly the one row it pins. `llm-local-inference/` carries no
  `cloud-providers.*` at all — it serves no cloud provider.
- **Tests travel with their subject.** Each `<unit>/tests/` exercises that
  unit's code and runs standalone from the folder. Only the guard whose subject
  is the whole unit set — `tests/committed-manifests.test.mjs` (`docs/d050`) —
  stays at the repo root, and only that harness may read across units.

### The root keeps operator files and the QA sweep, nothing importable

The repo root is **not a unit** and no unit imports from it:

- `environment.sh` stays because there is exactly one vault loader per repo —
  duplicating it would multiply the secret-handling surface.
  `provision-termux.sh`, `log.sh` and `node-run.sh` stay because the operator
  scripts and the sweep below invoke them.
- `lint.sh`, `check-types.sh`, `test.sh` and `vm-bench.sh` stay because QA is
  the maintainer's view *across* units. The sweep is allowed to read unit files
  (it is a harness); it is not a unit's dependency, and `tests/` is documented
  as the one test directory whose subject is the whole set.

### Per-unit entrypoints only

The root `build.mjs`, `build.sh`, `generate.mjs` and `generate.sh` are deleted.
Each folder owns its entrypoints — `./estige/build.sh` + `./estige/generate.sh`,
`./coding-agent/build.sh` + `./coding-agent/generate.sh`,
`./llm-local-inference/build.sh` + `./llm-local-inference/generate.sh`, and
`./pi-*/generate.sh` — and each `build.mjs` carries the capability gates its
targets already had (`docs/d087`: the llama-swap pull needs an inference
endpoint; coding-agent's image build is ungated; `estige`'s image still needs
cloud reachability). `docs/d083`'s per-unit shims become the only entrypoints
rather than a selection layer over a root builder.

### Consequences for the playbooks and the docs

- **`docs/d024`'s one-edit law is retired.** "Adding a provider is one row in
  one fact table" was the property `lib/` existed to buy. The price of a copy
  unit is that the same row is written into each unit that serves that
  provider; `docs/d032`'s checklist gains that step. The rows stay
  byte-comparable (same canonical serialization, `docs/d050`) so they can be
  diffed by eye.
- **Census of what moved.** The retirement was a full sweep, not a partial one:
  `estige/`, `coding-agent/`, the four `pi-*` units, `git/`,
  `llm-local-inference/` and the root all in one landing, with `lib/` deleted
  in that landing rather than kept as a compatibility shim.
- **The `local-llm/` folder folds flat** into `llm-local-inference/`, which is
  its only consumer: the HF-cache pipeline was already documented as belonging
  to the serving unit, and "the tooling next to the thing it provisions" is what
  the copy-unit rule asks for. Its `DESIGN.md` became
  `llm-local-inference/CACHE-DESIGN.md` (spec id `llm-local-inference-cache`).
- **Spec ids were re-pointed, not deleted**: the `lib` node is now
  `workload-api` (same doc, `docs/container-tooling.md`) and `local-llm` is now
  `llm-local-inference-cache`, so every existing `depends-on`/`parent` edge
  keeps pointing at a real node.
- **Prose law.** A unit's copy is described as "this folder's own `lib/`" —
  never `../lib`, never "the shared lib". The retired builders are described as
  "this folder's own `build.mjs` (`docs/d083`/`docs/d104`)".

## Alternatives rejected

- **Vendor `lib/` as a submodule or a published package.** Turns a copy-unit
  problem into a versioning problem: estige's split would need the package
  released before the repo, and the pruning above (one provider row per
  extension) is impossible against a single upstream table.
- **Keep `lib/` with a generated sync step.** A sync step is the stale gate the
  copies exist to avoid, and it would still leave `../lib` in every path.
- **Keep the root sequencer but per-unit-ify the builders.** The sequencer is
  precisely the root dependency a folder cannot carry; `docs/d083` had already
  shown the per-unit entrypoint is what operators actually reach for.
- **Copy modules but keep one shared `cloud-providers.json`.** The fact table is
  where pruning pays: it carries credential vocabulary per provider, and a unit
  that serves one provider should not ship a table naming eleven.

## Verification

`git diff --exit-code` after every per-unit `generate.sh` (no generated bytes
change), `go test ./...` for estige, `node --test` over every `<unit>/tests/`
plus `tests/committed-manifests.test.mjs` (via `./test.sh`), and
`./lint.sh` / `./check-types.sh` for the sweep. Search gate: no `../lib/`
outside `docs/` archive entries.
