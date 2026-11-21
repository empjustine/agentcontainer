---
id: goal
type: goal-and-requirements
status: draft
title: "agentcontainer — requirements (BRD): personal multi-host LLM serving + coding-agent fleet"
tags: ["[root]", "brd", "requirements"]
---

## Goal

Serve LLMs on the owner's own fleet of hosts through **one llama-swap
instance per host**, and configure the pi coding-agent to consume that
catalog — a single-user infrastructure setup, not a product. _(User-confirmed;
the local-serving half is deprecated for now by docs/d108, and the goal text
is kept as the original statement.)_

The same tree adapts to every host without forking per-host copies.
Generation is capability-driven on ONE axis: **can the host run LLM
inference itself?** — if not, it consumes inference served elsewhere in the
fleet. The second axis this goal originally named — **can the host reach
cloud LLM APIs directly?** — no longer changes generated config: since d063
every host's cloud traffic is routed through the fleet's relay ("routing by
host", the accepted method; alternatives such as a TLS-level VPN or a
non-HTTP-proxy transport are under study, docs/d072). The consequence is
visible in code: capability detection now serves generation only for local
inference (`llm-local-inference/30-generate.mjs`), and `cloudReachable()` is
left answering nothing that generation asks (docs/d072).

## Stakeholders & context

- **Operator**: a single person who owns every host and every key. No
  accounts, no tenants, no trust boundaries between the hosts beyond what the
  sandbox runtimes enforce.
- **The host matrix** (which host gets which capability) is systems-reference
  material, not a requirement: see
  [environments-and-variants.md](environments-and-variants.md).
- **How each requirement was implemented** is decided per-change in the
  decision log (`docs/d0XX-*.md`) and explained by the systems
  reference ([architecture.md](architecture.md)) and per-module design docs.

## Scope

- **Serving** — `llm-local-inference/` (deprecated for now, docs/d108; see
  `llm-local-inference`): local llama.cpp
  GGUF inference where the host can do it, cloud providers everywhere else
  (directly, or relayed for hosts that cannot reach them),
  published on LAN :8101 and reachable through the tailscale funnel (which
  fronts estige on :8080 — docs/d027).
- **Usage** — `coding-agent/` (see `coding-agent`): the pi coding-agent's
  container image, generated `models.json`/`opencode.jsonc` layers, static
  settings, and credential handling.
- **Per-unit infrastructure** — each folder's own `lib/` (see `workload-api`):
  backend-agnostic workload runner, structured logging, the provider/model
  fact tables, pruned to what that folder serves (docs/d113).
- **Cache tooling** — flat inside `llm-local-inference/` (see
  `llm-local-inference-cache`): provision and audit the HuggingFace cache that
  local inference serves from (folded in by docs/d113).
- **Docs & decision records** — `docs/` (typed per
  `docs/spec-graph-standard.md`: goal-and-requirements / architecture-design /
  module-design / submodule-design / task-spec, plus the `d0XX` decision log
  and archived research).

**Delivered (docs/d187, docs/d188):** the SSL-VPN tunnel family in
`estige/` is the whole serving edge — the allowlist relay and the
authenticated relay are deleted (docs/d108). [d188](d188-tunnel-contract.md)
is the requirements register (end-to-end TLS with no MITM, default-deny
egress, the loopback client); [d077](d077-ssl-vpn-transport-ladder.md) owns
the transport carriers (h2-post-unbounded, WebSocket, h1.1-post-windowed) and
[d187](d187-tunnel-family-complete-arms-by-default.md) the arming and the
offer (the whole ladder, chosen per dial; the operator keyset is the arm
signal, docs/d085/d093). The tunnel's operator credential is mutual
per-principal Ed25519 proofs (docs/d104, d131-d133) over the bounded principal
set of [d078](d078-ssl-vpn-operator-keys.md) (the NFR-5 exception). FR-E1 is
the one BRD row about the tunnel credential itself; the fuller requirements
(`VPN-R*`) live in [d188](d188-tunnel-contract.md).

## Functional requirements

> **Direction changed (docs/d108).** FR-S1–FR-S4 (the llama-swap serving path)
> are paused _for now_: the code keeps working, but no new clients or
> features. FR-S5's reverse-proxy mode (legacy allowlist relay) and FR-U2's route
> substitution are **gone**: a TLS-terminating edge sees plaintext provider
> keys, so the allowlist relay and the client-side route form were removed
> outright — generators emit canonical upstream URLs only, and the SSL-VPN
> tunnel transports replace the mode. FR-U4's env allowlist remains for the
> coding-agent. The requirement text below is unchanged, so the record of what
> was required stays readable; the implementation status is d108's.

### Serving — `llm-local-inference/`

- **FR-S1** — Each host that can serve models locally runs exactly ONE
  llama-swap instance serving LOCAL GGUF models; a host without that
  capability gets no llama-swap at all — serving is never delegated to
  another host's instance.
- **FR-S2** — Local inference config is capability-gated: generated only where
  a container backend AND GPU devices are detected; generation fails hard
  elsewhere.
- **FR-S3** — The instance is published on LAN :8101 and reachable from the
  world only through the tailscale funnel → estige :8080 →
  llama-swap's row in the host allowlist (its tsnet serve hostname — a
  fact-table row like any other, docs/d047; the `llama-swap` alias key is
  retired, docs/d070 §2). Port 8080 belongs to the proxy.
- **FR-S4** — Model provisioning (downloading GGUFs) is cache tooling's job,
  never the serving module's: serving reads the HF cache read-only; a cache
  miss at generation time is an error, not a download.
- **FR-S5** — Cloud/remote provider relaying is a separate module
  (`estige/`): path-prefix routing over the FULL provider catalog
  (pi-ai ∪ models.dev ∪ catwalk, priority in that order — docs/d038),
  byte-faithful passthrough (headers, streaming, upstream errors as-is), no
  credential handling, uniform non-distinctive 404s on unknown prefixes,
  RFC 9457 problem details only for failures inside the proxy. _Host
  allowlist routing (docs/d047 — by decision the only HOST-policy transport,
  docs/d080): `/<host>/<path>` → scheme://host root, the client carries
  the upstream base path, ~36 owner-set hosts, deny-by-absence for
  everything else; the tunnel/forward-proxy surfaces carry egress policy
  instead (docs/d080)._

### Usage — `coding-agent/`

- **FR-U1** — The pi coding-agent runs in a pre-built container image that
  provides pi, opencode, the Cline CLI, and Thinkrail, configured by committed
  static inputs (`settings.json`, `config.toml`, `Containerfile`).
- **FR-U2** — Model/provider configuration is GENERATED, layered
  (`model-*.json` overlays merged lexically per-provider), and capability
  gated on local inference: generation emits what the host can serve itself,
  and every other provider routes through the fleet's relay (proxy-only,
  docs/d063) — a failed generation fails closed rather than falling back to a
  committed artifact (docs/d070 §6).
- **FR-U3** — Scoped models: the agent uses pi's own model catalog; generators
  emit provider overrides (base URLs, key refs), never client-side model
  catalogs.

  _Deprecated: the `enabledModels` setting._ No coding-agent tooling is
  expected to set it — not the generators, not the launcher, not a committed
  `settings.json`. The requirement that survives is the second half of FR-U3
  (generators emit overrides only); how an operator scopes their own model
  list, if they choose to, is operator state in their own settings file and
  nobody's contract. `settings.json` as committed today carries no such key,
  which is correct, not an omission.

- **FR-U4** — Credentials: vault secrets are loaded ONCE on the host (the
  explicit `./environment.sh` chain) and forwarded into sandboxes through a
  declared `workload_env` allowlist; nothing inside a sandbox touches the
  vault, and the host login state is never staged into it.
- **FR-U5** — Generated runtime config (`~/.pi/agent` settings/models.json,
  opencode.json) is ephemeral and overwritten by design on every generation:
  no merge logic, no preservation contract; pi re-persists its runtime fields.
  **`mcp.json` is the deliberate, documented exception**: the agent dir is
  shared with the host pi and an operator's MCP servers exist nowhere else,
  so committed entries are defaults merged UNDER what is already there
  (docs/d061; flagged as intentional, docs/d072).
  _(Operator-confirmed.)_
- **FR-U6** — Runners never build or generate: `run.sh` mounts the
  generator-installed config (`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`,
  docs/d054); a stale or missing artifact is a loud failure pointing at the
  generator, never an implicit regeneration (docs/d041).

### Edge — `estige/`

- **FR-E1** — The tunnel's operator credential is **mutual**: each direction is
  signed by its own principal's Ed25519 private key, the verifier holds only
  public keys, and no shared secret exists — so neither end can mint the other's
  direction, and a verifier cannot impersonate the peer it authenticates
  (docs/d104). Key material lives in a role-scoped store on the host that holds
  it (0700, PKCS#8 DER, never in env, never in git, never through the vault
  chain step) with public keys embedded in the pairing helpers, and freshness is
  a single-use nonce, both ends consuming what they verify — no clock anywhere in
  the auth path (docs/d131, docs/d132). Failures are indistinguishable from the
  allowlist relay's camouflage 404, and every configuration ambiguity refuses at
  boot rather than guessing (VPN-R26/R33/R34). The transport requirements
  themselves live in [d188](d188-tunnel-contract.md) (`VPN-R*`), superseding
  d073's register; the mechanics are d077's, the auth d104/d131-d133, and d133
  owns operating it.

### Copy units and per-unit infrastructure

- **FR-L1** — A folder is the copy unit (docs/d113): every serving/usage
  folder carries its own `lib/` — a hand copy of the kernels it uses — plus its
  own `build.sh`/`generate.sh` and `tests/`, so it can be copied out whole.
  There is no repo-level `lib/`. Copies are owned outright, not vendored: no
  sync step, no hash gate, no shared upstream. Reaching into a sibling unit is
  not allowed: a unit's tests exercise that unit and read only its own folder,
  and the repo-wide sweep exists to run them all, not to add its own.
- **FR-L2** — Secrets flow through ONE explicit chain step
  (`./environment.sh <script>` at the repo root): `infisical run` fetches the
  vault and spawns the target with it as plain env (docs/d046); consumers read
  plain env and never load secrets themselves. No `.env` files, no in-script
  loaders, no fallbacks, no second loader.
- **FR-L3** — Fact-table copies are **pruned per consumer** (docs/d113): the
  cloud-provider table, the models.dev catalog, the catwalk cache and the GGUF
  model definitions exist only in folders that read them, carrying only the
  rows that folder serves. `coding-agent/lib/cloud-providers.mjs` is the full
  reference table; each `pi-*` extension carries its own row; the serving units
  carry none. A fact edit is one edit per consumer (retiring docs/d024's
  one-edit law), and the rows stay byte-comparable (docs/d050) so divergence is
  visible in a diff.
- **FR-L4** — Toolchains are provisioned uniformly without a shared dependency:
  the node runner (`node-run.sh`), the go builder probe and the npm dev-tool
  lock exist as per-unit copies of one kernel, and every copy pins the same
  versions (repo-pinned node, docs/d041; `./npm-tools.sh` from
  `package-lock.json`, docs/d107), so no unit drags a toolchain of its own.

### Documentation

- **FR-D1** — Every doc carries exactly one type from the spec-graph
  standard (`docs/spec-graph-standard.md`: goal-and-requirements /
  architecture-design / module-design / submodule-design / task-spec) and one
  lifecycle status (`draft` / `active` / `stale` / `done` / `deprecated`);
  README's documentation index groups by type and stays in sync.
- **FR-D2** — Decision records (`docs/d0XX-*.md`) are history, not
  immutable: a record is never rewritten wholesale to change what was decided
  or why (supersession points forward via a newer record), but mechanical
  upkeep that keeps it honest — a path rename, a census count, the file list
  of the refactor that record itself describes — may be edited in place so it
  never lies about the tree (docs/d072).

## Non-functional requirements

- **NFR-1** — Idempotent generation: same inputs → same outputs; generated
  live config is overwrite-by-design (FR-U5), and build idempotence comes
  from caches, not presence-skips (docs/d041).
- **NFR-2** — Loud failures over silent fallbacks: missing artifacts, stale
  paths, a failing vault, and unreachable upstreams surface as errors at the
  step that owns them. (A successful-but-EMPTY vault is the one deliberate
  exception — the chain no longer detects it, docs/d046; consumers'
  tolerate-missing-keys contract covers it downstream.)
- **NFR-3** — Offline where possible: generation that needs no network
  (local serving, the proxy routing table) must work without one.
- **NFR-4** — Self-contained units: every serving/usage folder is copyable to
  a host on its own (FR-L1) — including a `git filter-repo` extraction into
  its own repository (docs/d082) — and each builds and generates itself;
  retired variants are removed from the worktree, recorded only in docs.
- **NFR-5** — Single-user economy: no rate limiting, tenancy, or hardening
  beyond what the underlying tools ship (see Non-goals).
- **NFR-6** — Design priorities hold of every change: untangled flows, local
  placement, direct code, maintainable and observable shapes, few vetted
  dependencies, terse text (statements and rationale:
  [design-priorities](design-priorities.md)).

## Non-goals

- Not a product or multi-user platform: no account model, no tenant isolation,
  no rate-limiting beyond what llama-swap ships.
- No client-side free-tier catalog scraping: the agent uses pi's own model
  catalog (see `coding-agent`).
- PRoot is not a supported backend; Termux serves natively (see
  `docs/container-tooling.md`). A qemu/libvirt backend is assessed but not
  implemented (`docs/d020-libvirt-qemu-sandbox.md`).
