---
id: d082
type: architecture-design
status: accepted (logic-only boundary landed with this record; git split deferred)
title: "d082 — llm-reverse-proxy toward its own repository: logic-only boundary now, git split later"
parent: llm-reverse-proxy
depends-on: [d041, d042]
references: [d015, d027, d027b, d031, d032, d038, d047, d070, d073, d077, d078, d080, d081]
---

## Decision

`./llm-reverse-proxy/` separates into its own git repository — in two
phases. **Phase 1 (logic-only, landed with this record)** makes the folder a
self-contained unit whose entire cross-repo surface is one injectable
directory (`LIB_DIR`). **Phase 2 (the physical split)** is deferred with no
date; §4 sketches its mechanics so the boundary cannot rot silently before
it happens.

## Why

- **Different product, different change rhythm.** The proxy is a
  self-contained Go binary with its own tests, image, ops surface, and
  security-review surface (the VPN family); this repo is the fleet's
  agentcontainer infrastructure. The root docs (README index, architecture
  map, BRD) churn on every proxy change while owning none of its reasoning.
- **External consumers already exist.** d079's proxy-first harness and the
  restricted work environment's clients want the proxy without the coding
  agent, llama-swap, or the vault chain — today that is "copy the folder
  plus parts of `../lib`" folklore. A repository boundary makes it a
  checkout.
- **The folder is already the copy unit.** architecture.md's law is
  folder + `../lib`; the proxy's `../lib` tail is small and enumerable
  (§2), making it the cheapest unit to cut loose first.

## §1 The boundary

**Belongs to the unit** (travels at split):
- `llm-reverse-proxy/**` — the Go module and tests, `Containerfile`,
  `generate.sh`/`generate.mjs`, `run.sh`, `smoke-test.sh`,
  `README.md`, `DESIGN.md`, `llm-reverse-proxy.example.json`, the
  generated `llm-reverse-proxy.json`;
- its requirements: the BRD's FR-S5 extract and d073's `VPN-R*` block
  (copied out at split — the BRD itself stays here);
- its decision log entries: d015, d027, d027b, d031, d038, d047, d073,
  d077, d078, d080, d081. History is **copied, not moved**: this repo's
  `docs/` keeps its record as the fleet's history (d042's taxonomy is
  unchanged).

**Shared / stays** (copied or re-derived at split, never moved): the `lib/`
modules the unit touches (§2); d032 (fact-table extension), d039/d041/
d045/d046/d050 (repo infrastructure), d070 (canonical URLs — shared with
coding-agent), d071/d072 (vocabulary/maintainability).

## §2 Seams — the entire cross-repo surface

| Seam | Today | At split |
|---|---|---|
| `lib/log.mjs`, `lib/artifact.mjs`, `lib/cloud-providers.mjs` (generate.mjs) | `LIB_DIR` injectable, default `../lib` | vendor the modules + the fact JSONs they read, or fetch them |
| `lib/node-run.sh` (generate.sh) | `LIB_DIR` injectable after this record | vendor the shim, or plain `node` |
| `lib/workload-runtime.sh` (run.sh) | `LIB_DIR` injectable after this record | vendor the declarative sandbox API, or rewrite the two run modes |
| root `build.mjs` + `lib/go-build.mjs` (image + native/android compile) | root-owned per d041; per-unit `build.sh` selection shim since d083 | the shim becomes the unit's own `build.mjs` entry (go toolchain direct) |
| `lib/environment.sh` (vault chain) | invoked by the operator, never by the unit — run.sh reads plain env | any env loader; "plain env in" is the whole contract |
| `tests/canonical-json.test.mjs` (validates the generated json) | repo harness | travels with the unit |

After this record every seam but the build runs through `LIB_DIR`; the
build seam stays root-owned until the split — d041's one-build-entry law
still governs this repo.

## §3 Landed with this record

- `generate.sh` / `run.sh`: the `LIB_DIR` seam
  (`${LIB_DIR:-$SCRIPT_DIR/../lib}`), and run.sh's stale header claims
  corrected — the `build.sh` references to d041's root `./build.mjs`, and
  the retired "llama-swap at http://127.0.0.1:8101" loopback-alias rationale
  to d070 §2's shape (the funnel's own loopback hop is what host networking
  serves).
- `llm-reverse-proxy/README.md`: a Repository boundary section pointing
  here.

## §4 Split checklist (deferred; mechanics only)

1. `git filter-repo` over `llm-reverse-proxy/` + the traveling records
   (§1); copy the shared ones (d032, d070, …) in as history context.
2. Extract FR-S5 + `VPN-R*` into the new repo's requirements doc.
3. Promote the unit's `build.sh` shim (d083) into its own `build.mjs`
   (port `lib/go-build.mjs`'s toolchain probe) and CI running `go test
   ./...` + the canonical-json check — findings waiting ahead of the
   split in `llm-reverse-proxy/CI.md`, so the workflow lands with the
   move, not after it.
4. Decide the fact-data story for `generate.mjs` (vendored snapshots vs a
   fetch step) — the one real content decision the split forces.
5. Trim this repo's docs to pointers: README folder rows, architecture.md's
   folder row, and a one-line FR-S5 pointer in the BRD.

## Non-goals

- **No file moves today.** `docs/` stays the home of the decision log
  (d042), and nothing in `lib/` is copied into the folder — architecture.md's
  law holds; the seams stay seams until §4 gives them new homes.
- **No submodule, no subtree, no date.** The split happens when its
  checklist is worth doing, not before.
