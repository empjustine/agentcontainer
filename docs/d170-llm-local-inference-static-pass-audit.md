---
id: d170
type: module-design
status: draft
title: "d170 — llm-local-inference static pass: the audit and the first-pass removals"
parent: llm-local-inference
depends-on: [d018, d029, d041, d053, d055, d138]
references: [goal, workload-api, d003, gguf-model-tooling, llm-local-inference-cache]
tags: ["llm-local-inference", "audit", "static-runner", "python", "bootstrap", "model-data"]
---

# d170 — llm-local-inference static pass: the audit and the first-pass removals

This record carries the audit of `llm-local-inference/generate.mjs`, `run.sh`
and `lib/workload-runtime.sh` that preceded the static pass, and it fixes the
operator's first-pass orders as decisions. It covers the runner, the manifest's
derived data and the entry point; the generator's capability gate, its snapshot
pin and the requirement text that protects them stay open and appear under Open
items. The reader is the implementer of the pass, who needs the finding, the
order and the blast radius in one place. The items under Decision are ordered
work, and the Status section says what has landed.

## Status

Draft — the audit is complete and the orders are recorded. Landed so far:
the size-gb/size-parts strip of Decision 2 (the fields are gone from the
table and `model-sizes.mjs` is deleted), the quant-display rules in
`generate.mjs`'s `pruneQuantDisplay`, Decision 1 (`active-b.json` and the
slug are gone; `model-010-local-default.json` reseeded by hand and
`models.json`/`opencode.jsonc` id-stripped in place — a full regeneration
there waits for its host run), Decision 3 (estimator + VRAM tables deleted;
all three mmproj modes emit again), Decision 4 (the `.paths` manifest is
gone from the generator, the runner and config.d), Decisions 5–6 (mount-source
checks and the env allowlist are gone; `TLALOCAYOTL_API_KEY` fails
forward), Decision 7 (`run.py` + the root `py-run.sh`, the jq stack and
`run.sh` deleted, `run-all.sh` sources `lib/log.sh` directly) and Decision
8 (`pyproject.toml` added, then reversed — see below). The dead
`./npm-run.sh llm-local-inference ...` citations are replaced with the actual invocations across the docs.
Still open: the `fetch-model-cards.sh` fold, the generator/tests pass, the
requirements-gated items, and the staleness owner. This record moves to
active when that remainder lands.

Follow-up simplifications, also landed: the ctx slug went the way of the
active-b slug (ids are `[<mmprojMode>-]repo:quant` — the context window a
model serves is a property of the entry, and a second id spelling only
invites callers to pin a stale one), and small models get their context
raised to the 256k fleet cap, never past the GGUF header's native
`context_length` (`ctx-native`, filled from header reads — since d197 the
value lives in the generated `lib/gguf-facts.json`, not a table column;
absent means no raise). The same header reads
mis-sized two repos through side artifacts, which is why `mainGgufSizes`
now also excludes the partial `dflash`/`dspark` builds some repos ship
beside the main quants: the JetBrains blend's `dflash` bf16 read the 27B
blend as 1.9B and would have raised it to 256k — it is unsized by the
manifest and pinned at 131072 instead. Two native reads are still missing
because the repos are not cached on any audited host:
`unsloth/DeepSeek-V4-Flash-0731` (whose only full-precision file is a
`dspark` side build, so it stays unsized) and the Spark repos wait for a
cached host (their manifests carry the 1M native limit; the raise is
capped at 256k regardless). The committed `10-local` layer does not yet
reflect the new ids/rules — it regenerates on the serving host.

**Decision 8 is reversed: the unit carries no `pyproject.toml`.** uv
materializes a project's environment at `<project>/.venv`, so the first tool
run through `py-run.sh` wrote a venv of third-party sources INTO the copy unit
— gitignored, but not outside the biome leg of `./lint.sh` (it prunes only the
root `.venv`), so the gate went red for whoever ran a tool. The floor was
stated twice already: each tool's PEP 723 block and the root `pyproject.toml`
that the gate's ty leg resolves against. `py-run.sh` and `run-all.sh` now pass
`uv run --script`, which resolves the inline block into uv's cache — nothing
lands in the tree, and a tool copied out of the folder still runs alone.

## Findings

### Generation binds to the host that runs it

- `generate.mjs` emits the serving layer only when `config-detection.yaml`
  reports inference plus an NVIDIA or GFX1030 GPU, and `LOCAL_INFERENCE=1`
  bypasses that gate. Without the bypass the `else` branch deletes the committed
  `config.d/10-local-llm-inference.yaml` and `10-local-llm-inference.paths` and
  exits 94; the audit host exercised it, and both files were restored from git.
  FR-S2 in [goal](requirements.md) mandates the gate, so the gate stays for
  this pass.
- With the bypass set, generation exits 1: `bakeSnapshotPaths` reads the
  Hugging Face cache for each entry's repo, and
  `bartowski/ai9stars_G9v3-3B-GGUF` is absent there — 4 of the manifest's 28
  repos are uncached on the host — so the committed serving layer does not
  regenerate from committed inputs. FR-S4 mandates exactly that error, and it
  stays for this pass too.
- The documented entry point does not exist: `./npm-run.sh llm-local-inference
  generate` exits 64 because the unit carries no `package.json` and never
  carried one, while `README.md`, `DESIGN.md`, `architecture.md`,
  `container-tooling.md` and the quickstart cite it.
- Stale strings ride along: the snapshot error and `generate.mjs`'s header name
  `./generate.sh`, and the refresh runbook plus `gguf-model-tooling.md` name
  `model-sizes.sh` and `estimate_active_params.py` — all three files are gone.

### The runner reads its host at runtime

| inspection                                   | where it happens          | disposition                                       |
| -------------------------------------------- | ------------------------- | ------------------------------------------------- |
| `.paths` staleness preflight                 | `run.sh`                  | removed — Decision 4                              |
| backend detection (`detect_workload_tool`)   | `lib/workload-runtime.sh` | ported to Python as a probe; pinning is deferred  |
| GPU device probe (`detect_gpu_devs`)         | `lib/workload-runtime.sh` | ported to Python as a probe; pinning is deferred  |
| mount-source checks (`_require`)             | `lib/workload-runtime.sh` | removed — Decision 5                              |
| env allowlist (`printenv`)                   | `lib/workload-runtime.sh` | removed — Decision 6                              |
| jq argv render, `id`, post-launch log peek   | `run.sh`                  | removed with the shell runner — Decision 7        |
| required-keys, empty `config.d`, stale `.hb` | `run.sh`                  | kept — these validate generated inputs, not hosts |

`run.sh` is 101 lines that source a 327-line workload runtime and five jq
filters to build one `podman run` argv. The description API exists because
shell has no arrays; that constraint ends when the runner changes language.

### The manifest carries estimator weight

- `active-b.json` is a 162-entry repo-basename to active-params table. Its only
  consumer is `deriveModelId` in `generate.mjs`, which bakes the value into
  every model id. Those ids reach
  `coding-agent/model-010-local-default.json`, `models.json` and
  `opencode.jsonc` — three committed artifacts in another unit, with no guard
  anywhere against drift between them and the manifest. The tool that refreshed
  the table, `estimate_active_params.py`, no longer exists.
- `size-gb` and `size-parts` are written only by `model-sizes.mjs`, which also
  reorders the manifest cheapest-first under
  [d053](d053-model-size-ordering.md). Nothing reads either field.
- The VRAM estimator is `generate_vram_fit_tables.py` plus the committed
  `gguf-vram-fit-estimates.md` and `.data.json`. Interpretation note for the
  order: the manifest carries no RAM or VRAM fields, so "the ram estimator
  parts" is read as this toolchain and its outputs, and "size parts" as
  `size-gb` plus `size-parts`.

### Records that block the removals

- FR-S2 and FR-S4 in [goal](requirements.md) are paused under
  [d108](d108-serving-edge-tunnel-only.md) but their text still binds the
  generator. Removing the gate and the cache probe needs a requirements edit
  and its own record; this pass leaves both.
- [d053](d053-model-size-ordering.md) and
  [d055](d055-mmproj-offload-size-gate.md) die with the removals and move to
  `deprecated` when the code lands.
- [d018](archive/d018-split-config-d.md)'s layer table lists `active-b.json` as a
  layer, and [d003](d003-llamacpp-context-windows.md) describes the active-b
  slug. Records stay history; the corrected descriptions live in the living
  docs listed under Consequences.

### The generator has no test

`llm-local-inference/tests/` does not exist, so nothing asserts that two
generations from committed inputs produce identical bytes — the property the
static pass exists to buy.

## Decision

The operator ordered the first pass; the items below carry the orders in
durable form.

1. **Delete `active-b.json` and the active-b slug.** `deriveModelId` drops the
   component (and, as implemented, the ctx slug too — ids are
   `[<mmprojMode>-]repo:quant`). The change reaches
   `coding-agent/model-010-local-default.json` by hand edit — its llama-swap
   block is carried forward verbatim by coding-agent's generator — and
   `models.json` plus `opencode.jsonc` follow from a regeneration there. The
   coding-agent test suite runs afterwards, since their canonical form is
   test-guarded.
2. **Delete `size-gb` and `size-parts` from every manifest entry, and delete
   `model-sizes.mjs`.** The manifest's order freezes where it stands, and
   [d053](d053-model-size-ordering.md)'s cheapest-first rule is superseded.
3. **Delete the VRAM estimator:** `generate_vram_fit_tables.py`,
   `gguf-vram-fit-estimates.md` and `gguf-vram-fit-estimates.data.json`. The
   mmproj offload gate (`MMPROJ_OFFLOAD_MAX_SIZE_GB = 14`) goes with them, so
   all three mmproj modes emit for every image entry — swap time pays for the
   restored downloads on entries above 14 GB, and
   [d055](d055-mmproj-offload-size-gate.md) is superseded.
4. **Delete the `.paths` preflight** from the runner and **stop `generate.mjs`
   writing `.paths`**; the committed copy goes too. The generation-time bake of
   `HUB_HOST` stays as it is.
5. **Delete the mount-source checks.** The runner must not inspect host
   sources; `_require`'s only callers leave with the shell runner.
6. **Fail forward on `TLALOCAYOTL_API_KEY`.** Read the variable once before
   launch, die with one line naming the variable when it is empty — never its
   contents — and forward it unconditionally when it is set. The allowlist
   machinery and its `printenv` call go with it.
7. **Fold the runner into Python and make Python the stack's language.**
   `run.sh` becomes `run.py`, entered as
   `./environment.sh ./py-run.sh llm-local-inference/run.py`. The root
   `./py-run.sh` mirrors `./node-run.sh`'s shape: resolve `uv`, die loudly when
   it is absent, `exec uv run "$@"` — with no Termux branch, because an
   inference host carries the RAM and the GPU that Termux lacks. `run.py` logs
   through `lib/log.py`; `lib/workload-runtime.sh` and `lib/workload-*.jq`
   leave the unit, and `run-all.sh` sources `lib/log.sh` directly for its
   `log_*` calls. The rule from here: new and rewritten stack code is Python.
   `generate.mjs` and `build.mjs` keep node until the deferred generator pass
   folds them too, and `run-all.sh` and `fetch-model-cards.sh` fold in a
   follow-up — the latter already carries a Python body behind a shell shim.
8. **Add a `llm-local-inference/pyproject.toml`**, not a `package.json`. The
   unit's own language is Python (see the language rationale below Decision 7),
   so the project file follows the language it would name: `uv` already
   resolves a PEP 723-less project for `uv run` from that file, and one file
   owns the dependency floor the stack's tools carry (the `gguf` reader, the
   HF client, the log lib import path). The stale `./npm-run.sh
   llm-local-inference generate` citations then die with the docs edit rather
   than becoming true — node-run-style trampolines stay a thing the other
   units have, and this unit gets `py-run.sh` instead.

The quant-display simplifications verified against the working tree land as
orders here, in the same pass; none of them needs its own record because each
removes or narrows, never adds a mechanism.

- **The committed hf-manifests stay.** An earlier direction imagined the
  `hf-repo`/`hf-file` keys inferable from a cache scan (`find` over the HF
  hub cache) and the manifest pull dropped. That inference is rejected for the
  same partiality [d053](d053-model-size-ordering.md)'s R5 already named: the
  cache holds only the quants this host has pulled, so a scan cannot answer
  "does the repo have a BF16 at all" for an entry whose quant is not cached,
  and it cannot be host-independent. `fetch_hf_manifests.py` stays in
  `run-all.sh` and the manifests remain the repo:quant audit and — with the
  parameter-count rule below — a load-bearing source of truth.
- **Total parameter counts come from the manifests, not a metadata table.** A
  repo's total parameter count is its committed hf-manifest BF16 (fallback
  F16) main-GGUF size divided by two: at 2 bytes per parameter those file
  sizes ARE the count, so no separate estimator returns. The size scan
  excludes mmproj and MTP-drafter files — both carry their own BF16/F16
  variants whose sizes have nothing to do with the count — and a repo with
  neither full-precision file passes through unfiltered rather than guessed
  at, the same "unsized keeps, never guesses" stance d055's gate took.
- **Full-precision variants display only where they are servable.** A repo at
  or above 4 billion total parameters never displays BF16 or F16 (restated
  since as a share of the fleet card — d199 owns the units, the boundary is the
  same): the variant
  is outside every footprint this fleet can serve and only bloats the config
  with a model that can never load. Below that line the variant is genuinely
  useful and stays.
- **Low-parameter repos drop their cheapest four quants, keeping the top two.**
  A repo below 4 billion total parameters (d199: under a quarter of the fleet
  card) loses its four smallest-quant
  entries (ranked by manifest size, which is the quant ordering), but never
  past the top two — a repo with few quants must keep a servable floor.
  Repos at or above the line keep their whole quant ladder.
- **The pruning lives in the generator, not the flat table.**
  `pruneQuantDisplay` runs inside `generate.mjs` over
  `llamacpp-model-data.json`'s entries, and the flat table keeps serving as
  the full record of every quant a repo publishes. Narrowing the table itself
  would lose that record and make the rules untestable against known input.

The language choice follows the tooling: five of the stack's six tools are
Python (`download_models.py`, `upkeep.py`, `fetch_hf_manifests.py`,
`scan_cache_coverage.py`, `generate_vram_fit_tables.py`) plus the embedded body
in `fetch-model-cards.sh`, and `uv` with PEP 723 script metadata already
bootstraps them.

The runner's input validation — required llama-swap keys, empty `config.d`,
stale `.hb` — stays; it checks generated inputs, not the host.

## Consequences

- Removing the preflight leaves staleness without a runtime owner: a shard
  moved or pruned after generation surfaces as a swap-time 127 from
  llama-server, not a runner refusal that names the path. A tool-side verify —
  `upkeep.py` or `freshness.sh`, offline against the baked `HUB_HOST` list —
  is the open follow-up.
- Model ids change, so saved chats and sessions that name an old id lose their
  model reference.
- The manifest keeps its current order as the running order, and entries above
  14 GB gain two mmproj modes back.
- The cross-unit edit is mandatory, not optional: `model-010-local-default.json`
  is reseeded, `models.json` and `opencode.jsonc` regenerate through
  coding-agent's own `generate.mjs`, and its test suite runs.
- On landing: [d053](d053-model-size-ordering.md) and
  [d055](d055-mmproj-offload-size-gate.md) move to `deprecated`, this record
  moves to `active`, and `gguf-model-tooling.md`, `CACHE-DESIGN.md`, the
  refresh runbook, `DESIGN.md`, `architecture.md`, `container-tooling.md` and
  `environments-and-variants.md` update to match the new shape.

## Open items

- The capability gate, the cache probe, and the env and tool pins — untouched
  here; each needs the requirements edit that FR-S2 and FR-S4 currently forbid,
  plus its own record.
- The staleness owner: a tool-side verify or a pin-at-swap design, per the
  consequence above.
- The backend and device pins: this pass ports both probes to Python as probes;
  pinning them waits with the gate items.
- `run-all.sh` and `fetch-model-cards.sh` fold to Python under Decision 7's
  rule.
- The tests to add: generation determinism (two runs, byte-identical
  `config.d/`) and a `run.py` argv snapshot.
- `termux-serving.md`'s local-inference row and the refresh runbook steps that
  name deleted tools.

## Alternatives rejected

- **A shell runner that keeps the jq stack.** Rejected: `run.py` would carry a
  second argv builder beside it, and the jq filters exist only because shell
  has no arrays.
- **A node runner** that keeps the stack one language with `generate.mjs`.
  Rejected: the stack's tooling is Python-side, and node's foothold folds with
  the generator pass.
- **Per-script `uv run` shebangs** instead of `py-run.sh`. Rejected:
  [d138](d138-sh-interpreter-trampolines.md)'s lesson is that one root file
  owns the interpreter decision; shebangs scatter it across files and turn a
  missing `uv` into a per-file ENOEXEC.
