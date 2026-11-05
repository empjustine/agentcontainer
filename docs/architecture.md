---
id: architecture
type: architecture-design
status: active
title: "Architecture: self-contained runners + base config generators"
parent: goal
tags: ["topology", "standalone-rule", "generators"]
---

# Architecture: self-contained runners + base config generators

This repo is a set of small, self-contained mini-projects. Each lives in its
own folder and must be copyable onto a host in isolation. This page documents
the split and the one rule that lets some folders reuse others.

## Functional split

| Side        | Responsibility                                                                                                                                                                                 | Instance                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **serving** | run llama-swap (`llm-local-inference*`, LOCAL GGUF only; **deprecated for now**, d108) and estige (`estige/`, SSL-VPN tunnel family only — the reverse proxy is deleted, d108; docs/d073/d077) | `llm-local-inference/` (local layer, capability-gated) + `estige/` (exit node + relay node) |
| **usage**   | run the pi coding-agent (`coding-agent*`)                                                                                                                                                      | `coding-agent/`                                                                             |

The serving side is split by concern (docs/d027): llama-swap
(`llm-local-inference/`) is a **single local-GGUF instance** on GPU-capable
container hosts — there is no peers-only llama-swap mode — while cloud
provider relay is `estige/` (the path-prefix cloud router),
deployable wherever the cloud is reachable.

The old fixed-purpose split (`openai-completions-gfx1030/` +
`openai-completions-peer/`) and the `coding-agent-peer/` usage variant were
retired — the capability-gated generation pattern (pioneered by
`coding-agent/`) made the variant folders redundant.

Direction (docs/d108): the local llama-swap provider is deprecated for now,
and the reverse-proxy mode (legacy "mode A", the allowlist relay) is **deleted**
— it was deprecated as insecure (a TLS-terminating edge sees plaintext provider
keys) and the shape dragged route-rewriting generator machinery behind it. The
tunnel transports are the only serving shape left; the prose above that
describes an allowlist route is history, kept because the records it points at
keep their verdicts.

## Standalone rule (copy units)

Every serving/usage folder is **self-contained**, and since **docs/d113** the
copy unit is the folder **alone**: each unit carries its own `lib/` — a hand
copy of the kernels it actually uses — plus its own `build.mjs`/`generate.mjs`
and its own `tests/`. The `pi-*` extension family carries no `lib/` at all
(docs/d118): their kernels are folder-root modules imported statically by the
folder's own files, because an extension is loaded by the pi host rather than
bootstrapped by a shell script. Nothing one level up is implied by a folder, so
`estige/` can be copied out whole when it becomes its own repository
(docs/d082) and `git filter-repo` carries everything it needs.

**Ownership, not vendoring.** A copy is not a dependency with an upstream:
there is no sync step, no hash gate, no "update all copies" tool. The unit
that owns a copy may rename, prune, or retune it without touching its
siblings, and divergence between copies is ownership rather than drift
(docs/d113). **Pruning is the point**: `cloud-providers.mjs`/`.json` copies
carry only the rows that unit serves — `coding-agent/` holds the full table
because it is the reference vocabulary docs/d032 writes its checklist
against, each `pi-*` extension holds the one row it pins, and
`llm-local-inference/` and `estige/` carry none (neither serves a cloud
provider route; estige's allowlist edge is deleted, docs/d108).

The price is that a fact edit is **one edit per consumer**: docs/d024's
one-edit law is retired by docs/d113, and docs/d032's provider checklist gains
the step. The rows stay byte-comparable (same canonical serialization,
docs/d050), so divergence is visible in a diff.

Non-base folders must not reach into each other. Examples of what this rule
prohibits (and what was removed):

- `openai-completions-peer/` importing `modelArgs` from `../local-llm/...` — the
  helper is now inlined in its generator. The HF-cache tooling it came from now
  lives flat inside `llm-local-inference/` (docs/d113), its only consumer.
- `openai-completions-arm5/build.sh` searching `../openai-completions-peer/
  `.env`and`../openai-completions-gfx1030/.env`for keys (removed before the
  whole arm5/ MikroTik folder was retired) —
  each runner uses only its own`.env`.

- `llm-local-inference/` is the **local GGUF serving instance** (local
  inference only): it owns the local-llm generator — since docs/d041 the
  whole generator (former `gen-lib.mjs`, `generate-general.yaml.mjs`,
  `generate-local-llm-models.yaml.mjs`) is folded into one
  `generate.mjs` (`active-b.json` + its own `lib/llamacpp-model-data.json` →
  `config.d/00-general.yaml` + `config.d/10-local-llm-inference.yaml` + its
  `.paths` staleness manifest, emitted only on GPU-capable container hosts;
  snapshot paths are baked at generation — `docs/d029` option B), plus
  `llama-swap-core.json`, `config.d/` and `run.sh`. Cloud/remote relaying is
  NOT here — it moved to `estige/`; the relay layer generators, Termux
  build/serve, and peers-only mode were removed with that handoff.
- `coding-agent/` is the **pi workload baseline generator**: it owns the
  `Containerfile`/`config.toml` image definition and the canonical
  `settings.json`. Archived runners (`-cloud`, `-peer`) used to
  consume that image and copy those artifacts; their concerns are now handled
  by layered generation inside `coding-agent/` itself.

Retired variant runners and scrapped tooling are **not kept in the worktree**:
they live only in the external archive (the github mirror). Docs record the
retirement and the decisions behind it, but never point at worktree paths that
don't exist.

## Each unit's own `lib/`, and what stays at the repo root

There is **no repo-level `lib/`** (docs/d113). Every kernel below exists as one
hand copy per unit that uses it — inside that unit's `lib/`, or at the folder
root where the unit is a pi extension (docs/d118).

The **interpreter runners are the one exception** (docs/d138): `node-run.sh`,
`npm-run.sh` and `node-run.ps1` sit at the repo root, one copy each, and they
ARE the entry point — `./node-run.sh <unit>/<entry>.mjs [args]`,
`./npm-run.sh <unit> <script>`, with no per-entry `.sh` shim in between. A
version pin is a single fact, so a copy per unit is a fork waiting to happen
(`estige/build.sh` had inlined the pin as a function before d138) — and a runner
is invoked, not imported, so no unit's _code_ depends on the root. What that
costs is stated where it belongs: a folder copied out of this tree ships its
code, not its way of being started.

- `workload-runtime.sh` / `workload-runtime.mjs` — the two implementations of
  the same API (spec id `workload-api`, contract in
  `docs/container-tooling.md`): container-runtime detection (podman vs docker,
  UID/SELinux flags), the declarative workload description API, structured
  shell logging, and the profile/runner helpers the run scripts reuse
  (`_termux`, `default_run_dir`). The `.sh` copies — only
  `llm-local-inference/`'s now, with the `workload-*.jq` filters beside it
  (`estige/` retired its pair with the packaging change, docs/d120) —
  resolve their siblings from the **sourcing script's** `SCRIPT_DIR` + `lib`,
  honoring `WORKLOAD_LIB_DIR` when the caller is not the unit's own run script
  (POSIX sh cannot self-locate a sourced file). `coding-agent/` has the `.mjs`
  one: a description in, a `container run` argv out, which is why that unit
  needs no `jq` on the host (docs/d119). Secrets are NOT part of either:
  loading is the explicit `./environment.sh` chain (below). This is the one
  kernel with more than one consumer, so its copies are the ones most likely
  to diverge — deliberately (d113).
- `log.sh` / `log.mjs` / `log.py` — the structured loggers (per language). In
  the `pi-*` folders the logger sits at the folder root (`<unit>/log.mjs`,
  docs/d118), pruned to the level functions that folder calls; there is no
  `lib/` around it.
- `node-run.sh` — the pinned-node runner, at the repo root, invoked as a
  command (docs/d041, d138): `./node-run.sh ./coding-agent/run.mjs <args>`,
  system node on Termux and `mise exec node@24` elsewhere. It is a program
  rather than a sourced function, so `exec`, `flock` and non-shell callers all
  reach the same pin — and nothing has to stay resident to carry a status back.
  The two entries that keep a `.sh` of their own do so for `flock`
  (`git/maintain.sh`, `git/-forge-mirror.sh`), never for the interpreter.
- `node-run.ps1` — the PowerShell counterpart, at the repo root and invoked the
  same way (docs/d062, d138), used by `git/maintain.ps1`: same pin policy, but it
  branches on mise PRESENCE — Windows carries no Termux-style profile signal to
  key on.
- `go-build.mjs` — the go toolchain probe + android/host build-env presets
  (docs/d041): one probe (`go version` must actually EXECUTE — mise shims
  answer PATH lookups even with no version set) so a builder never guesses.
- `artifact.mjs` / `canonical-json.mjs` — the write choke point and the
  canonical serialization it applies (docs/d050). They travel together: an
  `artifact.mjs` copy without its `canonical-json.mjs` sibling cannot write.
  The four generating `pi-*` folders fold both into `generate.mjs` instead
  (docs/d118) — one writer, one file, no module whose only job is to re-export
  another.
- `fact-table.mjs` — the fact-table publisher (docs/d086): canonical order,
  `_meta` provenance and the skip-when-unchanged rule in one place. It has
  exactly one consumer (`coding-agent/catalog-facts.mjs` and
  `coding-agent/refresh-models-dev.mjs`), so it lives in `coding-agent/lib/`
  and nowhere else (docs/d113).
- `cloud-providers.mjs` — the cloud-provider fact table (id / label / key env /
  real base URL), pruned per unit as above (docs/d024, amended by d113). No
  `pi-*` folder carries the loader or its JSON any more: the row is a frozen
  literal at its single consumer — `sources.mjs` in the four generating
  folders, the folder's own test in `pi-mistral`/`pi-opencode` (docs/d118).
- `models.dev.api.json`, `catwalk-facts.json`, `llamacpp-model-data.json`,
  `hf-manifests/` — the vendored data tables, each in the unit that reads it.
  The first two live in `coding-agent/lib/` (the models.dev mirror carries no
  `_meta` block because the document itself is the provider namespace,
  docs/d086); the GGUF footprint data and HF listings live in
  `llm-local-inference/lib/`, their only consumer since docs/d113 folded the
  `local-llm/` pipeline in.
- `workload-*.jq` — the jq filters behind the shell implementation of the
  workload description API, one copy per unit that still uses it — today only
  `llm-local-inference/`. `coding-agent/` deleted its copy with the node port
  (docs/d119) and `estige/` with the packaged service (docs/d120); `jq` is
  therefore no longer a host prerequisite for either.
- **`git/` has one more layer than a copy unit needs** (docs/d121): its `lib/`
  is a _core library_ — beside this folder's hand copies of the kernels above,
  it holds the floor every `git/` entry runs on (`git-core.mjs`'s
  non-interactive `git`, `forge-remotes.mjs`'s tenant URL normalization) and
  the plumbing they share (`cli.mjs` argv tables + the report tail,
  `retry.mjs`'s backoff policy with an injected clock, `farm-lock.mjs`'s view
  of the mutation lock, `farm-posture.mjs`'s caps and scrubbed spawn). The
  same record left every top-level `.sh` in that folder an interpreter shim,
  and d138 deleted all but two of them: `git/maintain.sh` and
  `git/-forge-mirror.sh` remain because `farm-lock.sh` — `flock` in fd mode
  around the repo-root `node-run.sh`, holding the lock in the caller's own
  process — is behavior, not indirection.

What stays at the repo root is **not importable by any unit** — nothing a unit
imports lives up there — with the two runner exceptions above, which units
execute rather than import. The rest is operator files and the QA sweep.

- `environment.sh` — THE environment loader: `infisical run` fetches the
  vault and spawns the named script with it as plain env
  (`./environment.sh ./node-run.sh coding-agent/run.mjs`, docs/d046). Consumers
  read plain env and never load secrets themselves; a failing vault is
  fatal here via the CLI's own exit code. Exactly one loader per repo is the
  invariant (docs/d113).
- `provision-termux.sh` — Termux provisioning (pkg node/jq + the infisical
  CLI source build; the former root `build.sh`), exec'd by `estige/build.mjs`
  for the Termux target. Stays shell on purpose — every path in it is
  Termux-only and untestable from a container host.
- `node-run.sh`, `npm-run.sh`, `node-run.ps1`, `log.sh` — the runners every
  unit executes (docs/d138), and the sweep's own copy of the shell logger.
  `./npm-run.sh <unit> <script>` runs a unit's
  `package.json` script under the pinned node without ever putting `npm` on the
  path, which is how the `pi-*` family — whose folders ship no shell — is built
  and generated (docs/d118).
- `npm-tools.sh` — the one install path for the npm-pinned JS gates
  (docs/d107): `npm ci --ignore-scripts` from `package-lock.json` when the
  lock changes. The same lock carries the Android Biome/oxc builds, so Termux
  and the container hosts run identical gate versions.
- `lint.sh`, `check-types.sh`, `test.sh`, `vm-bench.sh` — the repo-wide QA
  sweep: QA is the maintainer's view _across_ units, so it lives outside all of
  them and no unit imports it. It owns **no test of its own** — every test sits
  in `<unit>/tests/` beside the code it exercises (docs/d113), including
  docs/d050's committed-manifest guard, which followed its manifests into
  `coding-agent/tests/` once d108 left it a single unit. `test.sh`'s globs
  (`*/tests/*.test.mjs`, `*/tests/*.sh`) are the contract; a glob that matches
  nothing is skipped, not an error, because no unit has to ship a shell test
  (docs/d118 turned the last two into `*.test.mjs`, and docs/d121 left the
  repository with no shell test at all — the globs stay as the contract).
  estige is the one suite the globs cannot see (Go, in-package), so `test.sh`
  runs it explicitly and skips loudly on a host with no toolchain (docs/d123).
- `freshness.sh` — the sweep's one **network** gate (docs/d122). The offline
  gates cannot see a stale cache: it parses, its tests pass, and plain
  `generate` would rewrite it without complaint, so staleness used to be a
  review catch and was in practice nothing at all. Each unit answers with its
  own contract (`<unit>/package.json` `generate --check` for the `pi-*`
  extensions, the offline HF manifest audit for llm-local-inference); a
  key-gated listing without its key is skipped loudly rather than failing the
  gate, and `coding-agent` stays out because its generator's per-source
  fallbacks make byte-equality a property of the host. `lint.sh` and `test.sh`
  remain offline by contract — lint and test must survive a host with no
  network, freshness is the one question that cannot.

The probe/facts/refresh modules that used to sit in a shared lib
(`route-probe.mjs`, then named `peer-probe.mjs` (docs/d071), `pi-models.mjs`,
`provider-facts.mjs`, `catwalk-facts.mjs`, `refresh-models-dev.mjs`) were
single-consumer and folded back into `coding-agent/` (docs/d039).

Runner run-scripts source their lib modules relative to their own location
(`$SCRIPT_DIR/lib`), so a checkout may live anywhere and a copied folder keeps
working. No unit reads `../lib` — there is nothing there any more.

## Per-unit generate and build (docs/d083/d113)

**A unit builds and generates itself.** There is no root sequencer (docs/d113
deleted `build.mjs`/`generate.mjs` and their shims): you invoke the folder you
are working on, through the root runner (docs/d138).

- `./npm-run.sh llm-local-inference generate` (capability-gated: emits both config.d
  layers only on an inference endpoint), `./npm-run.sh coding-agent generate`
  (network-heavy: catalogs + model layers), and `./node-run.sh estige/build.mjs` — estige
  has **no generator** since docs/d108 deleted `estige generate` with the
  allowlist.
- The `pi-*` family generates one provider each through its own
  `package.json` script (`./npm-run.sh <unit> generate`, docs/d118)
  rather than a shell entry; a unit with nothing to generate has no script.
- `./node-run.sh estige/build.mjs`, `./npm-run.sh coding-agent build` and
  `./npm-run.sh llm-local-inference build` build for THIS host: container images in
  parallel on podman/docker hosts, Termux provisioning + the android binary
  strictly serialized on ~1 GB devices. Each accepts target names
  (`./node-run.sh estige/build.mjs <target>…`, docs/d083) — each entry selects
  its unit's targets in its own `build.mjs`. Capability gates key target registration on
  hardware/network facts: the llama-swap pull needs an inference endpoint —
  render devices plus the RAM floor (docs/d087; d083's coding-agent free-disk
  gate retired with the image's shrink) — and estige's container targets
  register only while outbound cloud networking is reachable, its native target
  always.
- The repo-wide sweep stays at the root and is the only cross-unit view:
  `./lint.sh` (biome + knip + jq + golangci-lint + the capability-URL and
  retired-root-lib patterns; the Go rule set is `estige/.golangci.yml`,
  docs/d137), `./check-types.sh` (tsc over every unit's JS), `./test.sh` (runs
  every `<unit>/tests/` plus estige's in-package Go suite, and owns none of
  them), `./vm-bench.sh` (docs/vm-build-bench.md), and `./freshness.sh`
  (docs/d122) — the one sweep that needs the network, because a stale committed
  cache is otherwise a valid artifact that only review could catch.

Runners NEVER build or generate: the launcher stages the COMMITTED config and a
stale/missing artifact is a loud failure pointing at the generator, never an
implicit regeneration.

## Local vs cloud (two modules, two instances)

**Local llama.cpp (GGUF) model support lives only in `llm-local-inference/`** —
`config.d/10-local-llm-inference.yaml`, generated by the folded
`llm-local-inference/generate.mjs` (docs/d041) from `llamacpp-model-data.json`,
and only on hosts where generation detects a container backend + GPU devices.
`config.d/` carries exactly two layers:

| Layer                                                         | Role                | Generated by                                                                                                                        | When                             |
| ------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `00-general.yaml`                                             | globals + macros    | `llm-local-inference/generate.mjs`                                                                                                  | always                           |
| `10-local-llm-inference.yaml` (+ `.paths` staleness manifest) | local GGUF `models` | `llm-local-inference/generate.mjs` (from its own `lib/llamacpp-model-data.json`; snapshot paths baked at generation, `docs/d029` B) | container backend + GPU detected |

Cloud providers are NOT a config layer anymore: `estige/` (raw
passthrough proxy) serves them. The former `peer-cloud.yaml` and
`22-peer-gfx1030.yaml` layers — and the layer snapshot/rollback machinery
they required — were removed with that handoff.

(The old fixed-purpose `openai-completions-gfx1030/` / `openai-completions-peer/`
folders and the `coding-agent-cloud/`/`coding-agent-peer/` usage runners are
retired — the capability-gated layered generation pattern made
the variant folders redundant.)

| Folder                                            | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | What makes it work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm-local-inference/` (deprecated for now, d108) | local GGUF serving only (GPU container hosts; hard-fails elsewhere)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `generate.mjs` (both layers, docs/d041) + `active-b.json`, `llama-swap-core.json`, `config.d/`, `run.sh`                                                                                                                                                                                                                                                                                                                                                                                            |
| `estige/` (tunnel-only since d108)                | the SSL-VPN tunnel transports (h2-POST, WebSocket, h1.1-POST; docs/d073/d077/d105) in one binary in two network positions (docs/d088): the **exit node** (funnel front + tunnel server, egress enforced from `tunnel.egress`) and the **relay node** (loopback CONNECT/SOCKS5, served as a host service; the chain step that points a child at it is the binary's own `estige proxy-env`, docs/d095) — each installed as a service by the deb/rpm package (docs/d120). One reserved path (`/vpn`) serves the tunnels; **every other path answers the plain funnel 404** (d073 VPN-R34) — the allowlist reverse proxy that used to serve those paths (docs/d047/d063/d070) is deleted, not disabled (d108). WebSocket tunnel deployed; h2-POST tunnel default-on (d084); **no config file at all** (d108's tree-shake) — the arming credential, the bind (`PORT`, d110) and the egress opt-ins all arrive on the env chain, with d104's role store slated to own the policy half; standalone-repo boundary defined in docs/d082 (split-time CI findings in `estige/CI.md`) | `main.go`, the tunnel family — `relaynode.go`, `relaychain.go`, `tunnelserver.go`, `tunnelproto.go`, `modec.go`, `websocket.go`, `relay.go`, `egress.go` — plus the `packaging/` tree (pure-Go deb/rpm writers + the Termux and Oracle Linux service inputs, docs/d120); the POSIX launchers and the shell+jq workload library are deleted (docs/d120), as are `generate.go`, `estige.json`, `estige.example.json` and `smoke-test.go` with the allowlist (docs/d108); built by its own `build.mjs` |
| `coding-agent/`                                   | base pi workload image + artifacts (includes Cline CLI and Thinkrail)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `generate.mjs` orchestrator + stage generators, `Containerfile`, `config.toml`, `run.mjs`, `settings.json`; image built by its own `build.mjs`                                                                                                                                                                                                                                                                                                                                                      |

The former "next planned step" sketch (a simplified config-generator system
split by concern) is archived at
[archive/future-config-generator-system.md](archive/future-config-generator-system.md)
— d030/d037 implemented its generator split, d041 the unified entrypoints.
Document typing follows the spec-graph standard
(`docs/spec-graph-standard.md`): every doc carries one type
(goal-and-requirements / architecture-design / module-design /
submodule-design / task-spec) and one lifecycle status; the `d0XX` decision log
is the history (d042 for the numbering constraint that still binds). Placement
follows the parent edge (docs/d117): a living doc that guides one unit lives in
that unit's folder — `llm-local-inference/`'s runbooks and generated tables,
`coding-agent/`'s harness persistence and proxy-override notes — and `docs/`
holds only what spans units or describes the repo itself.
