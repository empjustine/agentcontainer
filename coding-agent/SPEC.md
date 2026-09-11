---
id: coding-agent
type: module-design
status: draft
title: coding-agent — pi agent image + layered config generation
parent: architecture
depends-on:
  - lib
references:
  - environments
tags:
  - usage
  - pi
  - generators
---

## Responsibility

Own the pi coding-agent's container image (`Containerfile` + `config.toml`
mise manifest) and generate its model/provider configuration — the *baseline*
every environment consumes. Full generation on capable hosts; static
config (no generation) on peers-only hosts (`wsl2`, `oci-e21micro` — see
`environments`).

## Shape

`generate.sh` stages the generators + the `lib` modules they need into a
scratch dir (`LIB_DIR`), then runs, in order:

| Generator | Layer | Merge semantic |
|---|---|---|
| `generate-local-llama-swap.mjs` | `model-010-local-default.json` | **ADDS** the `llama-swap` provider (peer-routed local GGUF) |
| `generate-cloud-pi-native-providers.mjs` | `model-012-cloud-pi-native.json` | override-**only** (empty when every pi-native endpoint is reachable) |
| `generate-cloud-alternative-providers.mjs` | `model-015-cloud-cline-pass.json` + `model-016-cloud-hyper.json` | **authoritative** full blocks (pi has no native `cline-pass`/`hyper`; one layer per PROVIDER_SPECS row) |
| `merge-models-json.mjs` | → `models.json` | lexical `model-*.json` order; per-provider deep merge (objects recurse, scalars/arrays replaced by later layer) |

`generate-opencode.jsonc.mjs` is the opencode-format twin (skipped on Termux).
`settings.json` is static and installed first; credentials are **not** staged
via `auth.json` — vault keys are forwarded through the `workload_env`
allowlist (see below) and pi resolves the `"$VAR"` api-key refs in
`models.json` from the forwarded environment. The model scope the agent
cycles through is pinned by `enabledModels` in
`settings.json` — generators enumerate **no** model lists
(`docs/scoped-models-and-proxy-overrides.md`).

`run.sh` launches the container: loads vault secrets **once on the host** via
`load_secrets` and forwards them through the `workload_env` allowlist — nothing
inside the workload runs infisical, and no `auth.json` credential store is
staged (the host login state stays out of the sandbox). The generator input set is mounted **file
by file** (never the repo dir): the list in `run.sh` must cover every file
`generate.sh` reads, or in-container generation aborts on first unlisted read.

## Decisions & invariants

- **Layer ids carry the merge order** (`010` < `012` < `015`, zero-padded
  lexorank); each generator owns exactly one merge semantic
  (`docs/d024-generators-split-and-provider-facts.md`).
- **Scoped models, not generated catalogs**: pi's own model catalog is used
  (`pi update --models`); providers are re-routed via `baseUrl` overrides only.
  The retired free-tier pipeline's decisions are distilled in
  `docs/scoped-models-and-proxy-overrides.md` ("spirit of the retired notes").
- **Key naming / baseUrl baking / proxy env**: `docs/d001-proxy-env-and-namespace.md`.
- A zero-provider merge result is **kept as-is** (never clobbers a good
  `models.json` with an empty merge); `SKIP_GEN=1` installs the committed
  artifact instead of generating.
- pi requires node ≥ 22.19 (Termux gates via `check-node-version.mjs`).

## Boundary

Copy unit = this folder + `../lib` (`docs/architecture.md`). Imports
`lib/log.mjs`, `lib/peer-probe.mjs`, `lib/cloud-providers.mjs`,
`lib/pi-models.mjs`, reads `lib/models.dev.api.json`. Must not reach into
`llm-reverse-proxy/` or `local-llm/`.
