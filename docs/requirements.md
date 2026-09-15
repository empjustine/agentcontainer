---
id: goal
type: requirements
status: draft
title: agentcontainer — requirements (BRD): personal multi-host LLM serving + coding-agent fleet
tags: ["[root]", "brd", "requirements"]
---

## Goal

Serve LLMs on the owner's own fleet of hosts (bazzite GPU desktop, a50
phone/router, WSL2, an OCI VM) through **one llama-swap instance per host**, and
configure the pi coding-agent to consume that catalog — a single-user
infrastructure setup, not a product. *(User-confirmed.)*

The same tree adapts across hosts with wildly different capabilities (GPU or
none, container runtime or none, cloud access or not) without forking per-host
copies: capability detection at generation time decides what a host gets.

## Stakeholders & context

- **Operator**: a single person who owns every host and every key. No
  accounts, no tenants, no trust boundaries between the hosts beyond what the
  sandbox runtimes enforce.
- **The host matrix** (which host gets which capability) is systems-reference
  material, not a requirement: see
  [environments-and-peer-variants.md](environments-and-peer-variants.md).
- **How each requirement was implemented** is decided per-change in the
  append-only decision log (`docs/d0XX-*.md`) and explained by the systems
  reference ([architecture.md](architecture.md)) and per-module design docs.

## Scope

- **Serving** — `llm-local-inference/` (see `llm-local-inference`): local llama.cpp
  GGUF inference where the host can do it, cloud-provider peers everywhere,
  published on LAN :8101 and reachable through the tailscale funnel (which
  fronts llm-reverse-proxy on :8080 — docs/d027).
- **Usage** — `coding-agent/` (see `coding-agent`): the pi coding-agent's
  container image, generated `models.json`/`opencode.jsonc` layers, static
  settings, and credential handling.
- **Shared infrastructure** — `lib/` (see `lib`): backend-agnostic workload
  runner, structured logging, the provider/model fact tables.
- **Cache tooling** — `local-llm/` (see `local-llm`): provision and audit the
  HuggingFace cache that local inference serves from.
- **Docs & decision records** — `docs/` (the three-type taxonomy of
  docs/d042: requirements / reference / design, plus the `d0XX` decision
  log and archived research).

## Functional requirements

### Serving — `llm-local-inference/`

- **FR-S1** — Each GPU-capable container host runs exactly ONE llama-swap
  instance serving LOCAL GGUF models; there is no peers-only llama-swap mode.
- **FR-S2** — Local inference config is capability-gated: generated only where
  a container backend AND GPU devices are detected; generation fails hard
  elsewhere (a `LOCAL_INFERENCE=1` override exists for debug only).
- **FR-S3** — The instance is published on LAN :8101 and reachable from the
  world only through the tailscale funnel → llm-reverse-proxy :8080 →
  `/llama-swap/…` → :8101. Port 8080 belongs to the proxy.
- **FR-S4** — Model provisioning (downloading GGUFs) is cache tooling's job,
  never the serving module's: serving reads the HF cache read-only; a cache
  miss at generation time is an error, not a download.
- **FR-S5** — Cloud/remote provider relaying is a separate module
  (`llm-reverse-proxy/`): path-prefix routing over the FULL provider catalog
  (pi-ai ∪ models.dev ∪ catwalk, priority in that order — docs/d038),
  byte-faithful passthrough (headers, streaming, upstream errors as-is), no
  credential handling, uniform non-distinctive 404s on unknown prefixes,
  RFC 9457 problem details only for failures inside the proxy.

### Usage — `coding-agent/`

- **FR-U1** — The pi coding-agent runs in a pre-built container image that
  provides pi, opencode, the Cline CLI, and Thinkrail, configured by committed
  static inputs (`settings.json`, `auth.json`, `config.toml`, `Containerfile`).
- **FR-U2** — Model/provider configuration is GENERATED, layered
  (`model-*.json` overlays merged lexically per-provider), and capability
  gated: full generation on capable hosts, static config on peers-only hosts.
- **FR-U3** — Scoped models: the agent uses pi's own model catalog, scoped by
  `enabledModels` in static settings; generators emit provider overrides
  (base URLs, key refs), never client-side model catalogs.
- **FR-U4** — Credentials: vault secrets are loaded ONCE on the host (the
  explicit `lib/environment.sh` chain) and forwarded into sandboxes through a
  declared `workload_env` allowlist; nothing inside a sandbox touches the
  vault, and the host login state is never staged into it.
- **FR-U5** — Generated runtime config (`~/.pi/agent` settings/models.json,
  opencode.json) is ephemeral and overwritten by design on every generation:
  no merge logic, no preservation contract; pi re-persists its runtime fields.
  *(Operator-confirmed.)*
- **FR-U6** — Runners never build or generate: `run.sh` stages the COMMITTED
  config; a stale or missing artifact is a loud failure pointing at the
  generator, never an implicit regeneration (docs/d041).

### Shared infrastructure — `lib/`

- **FR-L1** — `lib/` is repo-owned shared infrastructure, never copied into a
  runner folder; data reads out of `lib/` are allowed, reaching into a sibling
  runner is not. The effective copy unit is **folder + `../lib`**.
- **FR-L2** — Secrets flow through ONE explicit chain step
  (`./lib/environment.sh <script>`): one in-memory vault round-trip on the
  host, then `exec` of the target; consumers read plain env and never load
  secrets themselves. No `.env` files, no in-script loaders, no fallbacks.
- **FR-L3** — Fact tables have exactly one home: the cloud-provider table, the
  models.dev catalog, the catwalk cache, and the GGUF model definitions each
  exist once (in `lib/` or their owning module) and every consumer derives
  from them.
- **FR-L4** — Shared toolchains are provisioned uniformly: one node runner
  (`lib/node-run.sh`, repo-pinned node) and one go builder
  (`lib/go-build.mjs`) serve every module; no module carries its own
  toolchain probe.

### Cache tooling — `local-llm/`

- **FR-C1** — The HF cache is provisioned, verified, pruned, and re-estimated
  by self-contained scripts; the served model list derives from the shared
  GGUF model table (content owned by `llm-local-inference/`, consumed
  read-only here).
- **FR-C2** — Manifests (`repo:quant`) are verified against what llama.cpp
  actually resolves; drift is reported, never silently accepted.
- **FR-C3** — Cache tooling is not a base generator: nothing in the runners'
  generation depends on it.

### Documentation

- **FR-D1** — Every doc carries exactly one type from the d042 taxonomy
  (requirements / reference / design / research, plus the `d0XX` decision
  log); README's documentation index groups by type and stays in sync.
- **FR-D2** — Decision records (`docs/d0XX-*.md`) are append-only history:
  bodies are never rewritten, superseded records point forward via newer
  records.

## Non-functional requirements

- **NFR-1** — Idempotent generation: same inputs → same outputs; generated
  live config is overwrite-by-design (FR-U5), and build idempotence comes
  from caches, not presence-skips (docs/d041).
- **NFR-2** — Loud failures over silent fallbacks: missing artifacts, stale
  paths, empty vaults, and unreachable peers surface as errors at the step
  that owns them.
- **NFR-3** — Offline where possible: generation that needs no network
  (local serving, the proxy routing table) must work without one.
- **NFR-4** — Self-contained runners: every serving/usage folder is copyable
  to a host with folder + `../lib` alone (FR-L1); retired variants are
  removed from the worktree, recorded only in docs.
- **NFR-5** — Single-user economy: no rate limiting, tenancy, or hardening
  beyond what the underlying tools ship (see Non-goals).

## Non-goals

- Not a product or multi-user platform: no account model, no tenant isolation,
  no rate-limiting beyond what llama-swap ships.
- No client-side free-tier catalog scraping: the agent uses pi's own model
  catalog, scoped by `enabledModels` (see `coding-agent`).
- PRoot is not a supported backend; Termux serves natively (see
  `docs/container-tooling.md`). A qemu/libvirt backend is assessed but not
  implemented (`docs/d020-libvirt-qemu-sandbox.md`).
