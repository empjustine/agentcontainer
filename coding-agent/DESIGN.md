---
id: coding-agent
type: design
status: draft
title: coding-agent — pi agent image + by-agent layered config generation
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

Charter: own the pi coding-agent's container image (`Containerfile` +
`config.toml` mise manifest) and generate its model/provider configuration —
the *baseline* every environment consumes.

Configuration is generated rather than written once because every host sits
somewhere on a two-axis capability matrix, and one config tree must serve all
of it without per-host forks:

- **local inference** — can the host run LLM inference itself? Hosts that can
  serve models locally; hosts that can't consume what the rest of the fleet
  serves.
- **cloud reachability** — can the host reach cloud LLM APIs on its own?
  Hosts with direct egress; hosts without, whose cloud traffic goes through
  the fleet's relay.

Generation produces what the host's capabilities allow; the committed static
config covers what they don't. Which host lands in which cell is systems-reference
material, not this doc's job — see `environments`. The normative requirement
statement lives in the BRD
([../docs/requirements.md](../docs/requirements.md), FR-U1–FR-U6); this doc
owns the shape and the non-obvious mechanics.

The image provides a pre-configured development environment including:
- **pi**: The core coding agent.
- **opencode**: Alternative coding agent.
- **Cline CLI**: Official AI development assistant CLI.
- **Thinkrail**: JetBrains' development workflow enhancement.

## Shape

Since docs/d041 `generate.mjs` (via the `generate.sh` shim) IS the folder
driver, and since the by-agent merge it drives exactly TWO generators — one
per coding agent (the broad merge that supersedes docs/d037's narrow
per-concern verdict; the supersession is recorded in the
`generate-pi-coding-agent.mjs` header). One generate run:

1. installs static `settings.json` into the agent dir (`PI_CODING_AGENT_DIR`,
   default `~/.pi/agent`; pre-overwrite backup as `.bak-<ts>`), refreshes the
   models.dev catalog (docs/d027b fetch chain), stages the generator tree into
   a writable scratch dir (`RUN_DIR` — the module dir may be a read-only
   mount), runs each generator as a child process on the same pinned node,
   then installs the artifacts (there is no separate install step).

| Generator | Emits | Scope |
|---|---|---|
| `generate-pi-coding-agent.mjs` | the `model-*.json` layers → merged `models.json`, plus the `default-model.json` overlay | ALL pi config — the four former stage generators are its internal stages, in order: `generateLocalLlamaSwap` (`model-010-local-default.json`, **ADDS** the `llama-swap` provider for local GGUF), `generateCloudProviders` (`model-012-cloud-pi-native.json` override-only, empty when every pi-native endpoint is reachable, plus `model-015/016/017/018-*.json` — authoritative full rows for `cline-pass`/`hyper`/`inferx`/`verboo`, docs/d037/d033/d057), `mergeModels` (models.json), `generateDefaultModel` (`default-model.json` — the operator's hardcoded pair, docs/d036) |
| `generate-opencode.mjs` | `opencode.jsonc` (the committed overlay, refreshed on host runs) or `$OPENCODE_CONFIG_DIR/opencode.json` | the opencode-format twin — different schema and input set, same detection cascade minus cline-pass/hyper (docs/d033); skipped on Termux unless `OPENCODE_CONFIG_DIR` is set |

**The layered cake** — the merge contract's single home is the
`generate-pi-coding-agent.mjs` header (the former `merge-models-json.mjs`
folded in): every `model-*.json` is a `models.json`-shaped layer;
`mergeModels` reads them in zero-padded lexical order (`010` < `012` < `015`
< `016` < `017`, so filename sort IS merge order); per-provider deep merge —
objects recurse, scalars/arrays are replaced by the later layer. The run's
final act patches the installed `settings.json` with the pair from the
`default-model.json` overlay: the operator decision stays in the COMMITTED
settings source (docs/d036); the overlay is only the plumbing between the
stage and the install.

Credentials are **not** staged as a file — vault keys are forwarded
through the `workload_env` allowlist (below) and pi resolves the `"$VAR"`
api-key refs in `models.json` from the forwarded environment. The model scope
the agent cycles through is pinned by `enabledModels` in `settings.json` —
generators enumerate **no** model lists
(`docs/scoped-models-and-proxy-overrides.md`).

`run.sh` launches the container: loads vault secrets **once on the host** via
lib/environment.sh and forwards them through the `workload_env` allowlist — nothing
inside the workload runs infisical, and no credential store file is staged
(the earlier staged-store design is tombstoned in `docs/d052`). It mounts the
host agent dir RW as `PI_CODING_AGENT_DIR` and stages a per-run session dir RW
as `PI_CODING_AGENT_SESSION_DIR` (docs/d054): the agent dir is the generator's
install target, so config/skills persist, and sessions are per-run audit state
kept out of that shared config store. A populated `auth.json` in the host agent
dir aborts the run (keys resolve from forwarded env — pi's own empty `{}` is
ignored; d052/d054). It NEVER generates (docs/d041, docs/d056): the generator
tree is NOT mounted into the container, so an in-container session works
against the host-generated config mounted above. `run.sh` takes
`[DIRECTORY [DIRECTORY...]]` instead — CWD is the implicit first directory —
and exposes each at its own path rw with the first as the workdir; the
`~/Downloads/references` mirror is passed as just another directory, replacing
the former `CODING_AGENT_REFERENCES` toggle (docs/d043, docs/d056). `run.sh` is
container-ONLY (docs/d059): without podman/docker it refuses at the top —
before staging anything — and names the sandbox-free path
(`./lib/environment.sh pi`, which spawns a bare PATH command as well as a
script). A missing
installed artifact is a loud failure pointing at the generator, never an
implicit regeneration.

Generation profiles (detected at runtime — generation runs on both kinds of
host; only container hosts launch, docs/d059): **Termux** — system node (Termux's bionic
build; pi enforces its own ≥ 22.19 engines floor at launch), secrets arrive
as plain env via the explicit chain, the models.dev catalog refresh is
best-effort like everywhere else (running generate means "I want current
networked data", docs/d060), the opencode stage is skipped unless
`OPENCODE_CONFIG_DIR` is set. **Everywhere else** — repo-pinned node via `lib/node-run.sh`, catalog
refreshed best-effort, peer routing walks the vault-sourced `PEER_BASE_URLS`
multi-hop chain.

## Decisions & invariants

- **Layer ids carry the merge order** (`010` < `012` < `015`, zero-padded
  lexorank); each layer source owns exactly one merge semantic
  (`docs/d024-generators-split-and-provider-facts.md`). The merge contract
  has a single home: the `generate-pi-coding-agent.mjs` header.
- **By-agent, not by-concern**: docs/d037 kept the four pi stages as separate
  processes; the by-agent merge consolidated them into ONE generator process
  (stages as functions, documented order). This supersedes d037's process
  split while keeping its per-layer merge verdicts — d037/d033 remain the
  semantic specs for the layers themselves.
- **Parallel probing + multi-hop peer chains** (docs/d034): a generator's
direct probes fire concurrently (`Promise.allSettled`), and the peer base is a
vault-sourced `PEER_BASE_URLS` chain (`peer-probe.mjs peerBaseUrls()`) that
`probePeerRoutes`/`refreshProviderFacts` walk in order. A thrown probe keeps its
provider id so the peer path-route is still attempted.
- **Peer routing is per-provider path-prefix** (docs/d027): cloud peer
  routes are `<peerBase>/<providerId>` on the simplified cloud router
  (llm-reverse-proxy, no credential handling — clients carry the provider's
  own key); the llama-swap `/v1` + model-id-magic face serves LOCAL GGUF
  only (`$PEER_API_KEY`).
- **Scoped models, not generated catalogs**: pi's own model catalog is used
  (`pi update --models`); providers are re-routed via `baseUrl` overrides only.
  The retired free-tier pipeline's decisions are distilled in
  `docs/scoped-models-and-proxy-overrides.md` ("spirit of the retired notes").
- **The prompt and the tool loadout are configured separately**:
  `settings.json`'s `defaultTools` adds capability (the base four plus
  `grep`, `find`, `ls`, and the `codemode` built-in extension) without
  touching `SYSTEM.md`/`APPEND_SYSTEM.md`/`AGENTS.md`,
  and `codemode.mode = "only"` with `inlineBudget: 0` keeps the model's
  declared tool set down to the codemode tool itself, so the request payload
  shrinks while every built-in stays active and callable from scripts.
  `tool_search` is left off on purpose: it is the one declared tool whose
  *use* rewrites the declared tool set mid-session, while `searchTools()`
  inside codemode already reaches every deferred tool (docs/d061).
  Intent lives here; pi owns the mechanics (its `settings.md#tools` and
  `codemode.md`). Cost accepted: the model drives tools through codemode
  scripts and must `searchTools()`/`describeTool()` for signatures instead
  of reading declarations.
- **Key naming / baseUrl baking / proxy env**: `docs/d001-proxy-env-and-namespace.md`.
- A zero-provider merge result is **kept as-is** (never clobbers a good
  `models.json` with an empty merge).
- pi requires node ≥ 22.19; the floor is enforced by pi's own engines at
  launch (the Termux pre-stage `check-node-version.mjs` gate was retired —
  docs/d051).

## Boundary

Copy unit = this folder + `../lib` (`docs/architecture.md`). `gen-lib.mjs` is
the shared preamble for the pi-layer stages: it carries the pi shaping
helpers (folded from the former `lib/pi-models.mjs`, docs/d039), re-exports
the shared lib/ modules (`lib/log.mjs`, `lib/cloud-providers.mjs`) via
`$LIB_DIR`, and its same-dir siblings `peer-probe.mjs`, `provider-facts.mjs`,
`catwalk-facts.mjs`, `refresh-models-dev.mjs` (all single-consumer, folded
out of lib/ by d039). It reads `lib/models.dev.api.json` (shared with
llm-reverse-proxy) and the caches (`<id>-facts.json` beside its module,
`lib/catwalk-facts.json` — the proxy reads that one too). Must not reach
into `llm-local-inference/` or `local-llm/`.

`generate.mjs` stages exactly this tree into the scratch dir — the two
generators + `gen-lib.mjs` + `peer-probe.mjs` + `provider-facts.mjs` +
`catwalk-facts.mjs` + `refresh-models-dev.mjs`. The staging list is host-only:
the container mount of this tree was removed in docs/d056.
