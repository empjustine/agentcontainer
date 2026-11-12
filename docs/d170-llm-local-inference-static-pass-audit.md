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

Draft — the audit is complete and the orders are recorded; none of the code or
data named under Decision has changed yet. The record moves to active when the
pass lands.

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
  every model id (`03b-ctx128-…`). Those ids reach
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
- [d018](d018-split-config-d.md)'s layer table lists `active-b.json` as a
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
   component, so ids become `ctxNNN[-mode]-repo:quant`. The change reaches
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
6. **Fail forward on `REVERSE_PROXY_API_KEY`.** Read the variable once before
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
8. **Add `llm-local-inference/package.json`** with the generate and build
   script table in [d138](d138-sh-interpreter-trampolines.md)'s shape, so every
   documented `npm-run.sh` citation becomes true again.

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
