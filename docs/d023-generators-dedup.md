# d023 — Generator code-flow audit: findings and consolidation

The generator pipelines (`llm-reverse-proxy/generate.sh` + its `.mjs`
generators, `coding-agent/generate.sh` + its `.mjs` generators) grew
organically: helpers were copy-pasted between files as new generators were
added, and a few retired mechanisms left debris behind. This document records
a full audit — what is dead, what is single-use, what is duplicated — and the
consolidation that was applied (and deliberately not applied).

Findings were classified as:

- **(a)** never used → remove
- **(b)** used exactly once → inline / merge where it helps
- **(c)** used in several places, CWD-independent → move to `lib/`

## (a) Never used / dead

| #  | Item | Where | Evidence |
|----|------|-------|----------|
| a1 | `logDebug` re-export | `llm-reverse-proxy/gen-lib.mjs` | No `.mjs` consumer anywhere. |
| a2 | `logDie` export | `lib/log.mjs` | Zero JS consumers (shell has its own `log_die` in `lib/log.sh`). |
| a3 | Duplicated paragraph | `gen-lib.mjs` KEY-NAMING CONTRACT | The "PLAIN environment variable names / `__`-prefix" bullet block was pasted twice verbatim. |
| a4 | `lib/sandbox-*.jq` mount loop | `coding-agent/run.sh` | The glob never matches (filters were renamed `workload-*.jq`); nothing was ever mounted, and the justifying comment was stale anyway — the in-container launch chain never calls `workload_*`. |
| a5 | `00-model-base.json` staging | `coding-agent/generate.sh`, `coding-agent/run.sh` | The file does not exist anywhere in the repo; both guarded lines never fire. `merge-models-json.mjs`'s optional base-file handling was simplified away with it. |
| a6 | Stale references | `gen-lib.mjs`, `llm-reverse-proxy/generate.sh` (`OLD/docs/d019…`), `lib/workload-runtime.sh` (`tests/check-workload.sh` → actually `tests/check-sandbox.sh`; `docs/d020-libvirt-qemu-workload.md` → actually `…-sandbox.md`) | Archived/renamed targets. |
| a7 | Stale probe-cascade comment | `llm-reverse-proxy/generate.sh` gfx1030 section | Claims the probe still tries `localhost:18080`; the localhost candidates were removed (docs/d022). |
| a8 | `filter-relays.mjs` in `tsconfig.json` | removed file still listed in `include` | The relay-drop machinery is gone (see the `coding-agent/generate.sh` header); `lint.sh`'s jq gate had the same stale `lib/sandbox-*.jq` glob. |
| a9 | `loadModelsDev` exported | `gen-lib.mjs` | Only called inside `gen-lib.mjs` itself — un-exported. |
| a10 | `_render_container` call | `tests/check-sandbox.sh` | The lib renamed the renderer to `_render_workload` in the sandbox→workload sweep; the test died at its first case (`_render_container: not found`) and reported MISMATCH on every run. Renamed — the suite passes again (3/3 cases). |

## (b) Used once — assessed, mostly kept

| #  | Item | Assessment |
|----|------|------------|
| b1 | `gen-lib.mjs: loadCore()` — single consumer (`generate-general.yaml.mjs`) | Kept: trivial, and its export documents the core-file contract. |
| b2 | `gen-lib.mjs: peerEntry()` — single consumer | **Kept deliberately**: it encodes the `${env.*}` macro convention; inlining would scatter that knowledge. |
| b3 | `coding-agent/check-node-version.mjs` — single caller (Termux branch) | Kept: it is the only home of the 22.19 rationale, and it is distinct from the llm-reverse-proxy ≥18 floor (different products). |
| b4 | `count-providers.mjs` + `list-providers.mjs` — one caller each | Kept for now (separate staging entries are cheap); merging them is a possible follow-up. |

## (c) Duplicated across files — consolidated into `lib/`

`lib/` was already the shared kernel (`lib/log.sh`, `lib/log.mjs`,
`lib/workload-runtime.sh` are hard dependencies of both families; the
coding-agent container ro-mounts them under `/opt/lib`). The consolidation
extends that kernel. The copy unit is **folder + `../lib`**, not the folder
alone — `docs/architecture.md` was amended accordingly.

### c1. One `refresh-models-dev.mjs` instead of two near-identical copies

The two copies differed only in the `LOG_TOOL` name and which providers the
catalog payload is validated against — and the split had already caused a
latent bug: the llm-reverse-proxy copy validated `opencode` + `opencode-go`
but **not** `cline-pass`, although `gen-lib.PROVIDERS` fetches cline-pass
models from that very catalog. The unified `lib/refresh-models-dev.mjs`
validates the union (`opencode`, `opencode-go`, `cline-pass`). Callers pass
the output path as before (`node refresh-models-dev.mjs [out]`).

### c2. One HTTP probe toolkit: `lib/peer-probe.mjs`

`fetchModelEntries` (+ bearer headers, 8 s timeout, `/v1/models` fallback,
status-carrying errors), `probeDirect` (the ok/auth/reachable/unreachable
classification), `probeCandidates` (ordered candidate cascade) and
`AUTH_REJECTED_STATUSES` were copy-pasted across `generate-models.json.mjs`,
`generate-cline-pass.mjs` and `generate-opencode.jsonc.mjs` (~150 lines each)
with drifting semantics. They now live once in `lib/peer-probe.mjs`:

- the canonical "reachable ≠ authenticated" rationale comment exists once;
- `generate-cline-pass.mjs`'s probe (which folded `auth` into `reachable`)
  maps the shared `auth` outcome to the same decision it always made (keep
  the real route) — behavior preserved, the duplicated `write()` branches
  collapsed;
- the undici `EnvHttpProxyAgent` setup moved here too, so the coding-agent
  probes now honor `http(s)_proxy` (they previously did not; only
  `gen-lib.mjs` and `refresh-models-dev.mjs` did). Intentional improvement.
- `gen-lib.mjs` delegates to it as well (its own `fetchModelsJson` /
  `fetchWithTimeout` / proxy block are gone; error message wording changed
  slightly: `GET … -> 404 …` instead of `GET … returned 404 …`).

### c5. Shell helpers into `lib/workload-runtime.sh`

Both `generate.sh` scripts repeated, verbatim-ish:

- the Termux profile `case "${PREFIX:-}" in */com.termux/*)` — now set once
  at source time as `_termux`;
- `node_run()` (system node on Termux, `mise exec node@24` elsewhere — the
  two copies used `mise x` vs `mise exec`, same thing);
- the `RUN_DIR` default derivation (`${TMPDIR:-${PREFIX}/tmp}` on Termux,
  `${TMPDIR:-/tmp}` elsewhere) — now `default_run_dir`.

The differing node *floors* stay per-caller (18 for the llm-reverse-proxy
generators, 22.19 for pi — different products' requirements).

### c6. One vendored models.dev catalog

`llm-reverse-proxy/models.dev.api.json` and
`coding-agent/models.dev.api.json` were two ~6.3 MB copies that had **already
diverged** (different checksums) — a silent staleness hazard. There is now a
single `lib/models.dev.api.json`; both `generate.sh` scripts default
`MODELS_DEV_JSON` to it, `gen-lib.loadModelsDev()` resolves it relative to the
repo layout, and the coding-agent container ro-mounts it under `/opt/lib`.
`coding-agent/generate-cline-pass.mjs` keeps its scratch-sibling lookup first
(preserving the refreshed-catalog handoff through `generate.sh`'s scratch
symlink) and falls back to the shared copy for manual in-place runs.

### The import plumbing: `LOG_LIB` → `LIB_DIR`

With shared code living in `lib/`, the per-generator
`LOG_LIB`-pointing-at-a-copied-`log.mjs` mechanism is replaced by one env
var: `LIB_DIR` (default `../lib` relative to the importing module).
`coding-agent/generate.sh` stages `lib/log.mjs` + `lib/peer-probe.mjs` into
`$_scratch/lib/` and exports `LIB_DIR`; `lib/peer-probe.mjs` and
`lib/refresh-models-dev.mjs` import their sibling `./log.mjs` statically, so
the logger module instance is shared per directory.

## Applied cleanup of (a)

All of (a) was applied: dead exports removed, the duplicated paragraph
deduped, the `sandbox-*.jq` debris dropped from `coding-agent/run.sh` and
`lint.sh` (the jq compile gate now actually runs against `lib/workload-*.jq`),
`00-model-base.json` staging removed **and** `merge-models-json.mjs`
simplified (no more optional base-file handling; it merges exactly the
`model-*.json` layers present), stale comment references corrected,
`tsconfig.json` pruned (`filter-relays.mjs` out; `generate-cline-pass.mjs`
and `lib/peer-probe.mjs` in), and `tests/check-sandbox.sh` repaired
(`_render_container` → `_render_workload`, a10) — the suite had been failing
at HEAD since the sandbox→workload rename.

## Deliberately NOT done

- **Merging the two `CLOUD_PROVIDERS` logics** (`generate-models.json.mjs` vs
  `generate-opencode.jsonc.mjs`): their override-vs-builtin semantics
  legitimately differ (pi-shaped vs opencode-shaped output). Only the shared
  *probe mechanics* were unified; the provider tables themselves remain
  per-family (unifying the provider *facts* into one table is a possible
  follow-up — see the audit's c3/c4).
- **Inlining `peerEntry()` / `check-node-version.mjs`** (b2/b3): see (b).
- **A shared `BAZZITE_ROUTER_TAILSCALE_URL` constant** (audit c4): still
  duplicated in four files; harmless (a single hostname) and left as-is to
  keep this change set focused.

## Verification

- `./check-types.sh` (tsc, checkJs strict) — green.
- `./lint.sh` (shellcheck -x + jq compile gate + shfmt advisory) — green.
- `biome check` — green.
- `./tests/check-sandbox.sh` — green (3/3 cases; was failing at HEAD, a10).
- End-to-end: `llm-reverse-proxy/generate.sh` and `coding-agent/generate.sh`
  were run on a container-less host; both pipelines completed (catalog
  refresh via `lib/refresh-models-dev.mjs`, capability gate, gfx1030 probe
  sync, shrunken-peer-set rollback, scratch-dir staging with `$LIB_DIR`,
  install with 0-provider guard). The regenerated `config.d/00-general.yaml`
  and `10-local-llm-inference.yaml` are byte-identical to the committed
  layers.
- Behavioral invariants preserved: the gfx1030 keep-on-probe-failure policy,
  the shrunken-peer-set rollback, the 0-provider install guard, the scratch
  staging contract, and the Termux/container-host profiles are unchanged.
