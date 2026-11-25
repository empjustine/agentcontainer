---
id: coding-agent
type: module-design
status: draft
title: coding-agent — pi agent image + by-agent layered config generation
parent: architecture
depends-on:
  - workload-api
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
the _baseline_ every environment consumes.

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

Under d232 `generate.mjs` (run as `./npm-run.sh coding-agent generate`) IS the folder
driver, and since the by-agent merge it drives exactly TWO generators — one
per coding agent (the broad merge that supersedes docs/d037's narrow
per-concern verdict; the supersession is recorded in the
`generate-pi-coding-agent.mjs` header). One generate run:

1. installs static `settings.json` into the agent dir (`PI_CODING_AGENT_DIR`,
   default `~/.pi/agent`; pre-overwrite backup as `.bak-<ts>`), refreshes the
   models.dev catalog (docs/d114 fetch chain), and runs each generator IN
   PLACE as a child process on the same pinned node, with every intermediate
   written to a per-run output dir under `RUN_DIR` (docs/d072 retired the
   scratch staging of the generator tree — d056 already stopped mounting that
   tree anywhere), then installs the artifacts (there is no separate install
   step).

| Generator                      | Emits                                                                                                                                                                                                 | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate-pi-coding-agent.mjs` | the `model-*.json` layers → merged `models.json`, plus the `default-model.json` overlay                                                                                                               | ALL pi config — the four former stage generators are its internal stages, in order: `generateLocalLlamaSwap` (`model-010-local-default.json`, **ADDS** the `llama-swap` provider for local GGUF), `generateCloudProviders` (`model-012-cloud-pi-native.json` override-only, empty when every pi-native endpoint is reachable, plus `model-015/016/017/018/019-*.json` — authoritative full rows for `cline-pass`/`hyper`/`inferx`/`verboo`/`synthetic`, docs/d037/d033/d057), `mergeModels` (models.json), `generateDefaultModel` (`default-model.json` — the operator's hardcoded pair, docs/d036) |
| `generate-opencode.mjs`        | `opencode.json` → BOTH the host config dir (`$OPENCODE_CONFIG_DIR`, default `${XDG_CONFIG_HOME:-$HOME/.config}/opencode` — the sandbox's mount source) and the committed `opencode.jsonc` (docs/d065) | the opencode-format twin — different schema and input set, same detection cascade minus cline-pass/hyper (docs/d033); skipped on Termux unless `OPENCODE_CONFIG_DIR` is set                                                                                                                                                                                                                                                                                                                                                                                                                         |

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
api-key refs in `models.json` from the forwarded environment. The generators
enumerate **no** model lists: the agent cycles pi's own catalog
(`docs/archive/scoped-models-and-proxy-overrides.md` — archived with the proxy
role it worked around). The `enabledModels`
setting is **deprecated** — no tooling here sets it (see `docs/requirements.md`
FR-U3).

`run.mjs` (started by `./node-run.sh coding-agent/run.mjs`) launches the container:
loads vault secrets **once on the host** via
./environment.sh and forwards them through the `workload_env` allowlist — nothing
inside the workload runs infisical, and no credential store file is staged
(the earlier staged-store design is tombstoned in `docs/d052`). Every harness
state dir it mounts is the HOST's own, mounted RW at the CONTAINER's default
path for that harness (docs/d216): pi's agent dir (`PI_CODING_AGENT_DIR`, which
carries its `sessions/`), opencode's config and data dirs (docs/d065), Cline's
`~/.cline`, ThinkRail's `~/.thinkrail`. There is no per-run stage and no
env pin: the generator's install target, the host harness and the sandboxed
harness are one directory. A populated `auth.json` in the pi agent dir or the
opencode data dir is host state the mount exposes, not a launch refusal — it
carries the same keys the forwarded env already does (d227's amendment). The
Cline/ThinkRail credential-shaped files are still reported at launch. It NEVER
generates (d232, docs/d056):
the generator tree is NOT mounted into the container, so an in-container
session works against the host-generated config mounted above. `run.mjs` takes
`[DIRECTORY [DIRECTORY...]]` instead — CWD is the implicit first directory,
assembled by `run.mjs`'s pure `buildLaunch(argv, env)` so the mount manifest is
a value the tests assert instead of a second run of the whole launcher —
and exposes each rw — a home-relative path is spelled `/home/$USER/...` on
the container side (docs/d068) — with the first as the workdir; the
`~/Downloads/references` mirror is passed as just another directory, replacing
the former `CODING_AGENT_REFERENCES` toggle (docs/d043, docs/d056). The launcher is
container-ONLY (docs/d059): without podman/docker it refuses at the top —
before creating anything — and names the sandbox-free path
(`./environment.sh pi`, which spawns a bare PATH command as well as a
script). It reads no mounted config either: an absent, empty or hand-edited
artifact launches, and the harness reports what it makes of it (docs/d227 —
exit 94 retired with that gate).

Generation profiles (detected at runtime — generation runs on both kinds of
host; only container hosts launch, docs/d059): **Termux** — system node (Termux's bionic
build; pi enforces its own ≥ 22.19 engines floor at launch), secrets arrive
as plain env via the explicit chain, the models.dev catalog refresh is
best-effort like everywhere else (running generate means "I want current
networked data", docs/d060), the opencode stage is skipped unless
`OPENCODE_CONFIG_DIR` is set. **Everywhere else** — repo-pinned node via the repo-root `node-run.sh`, catalog
refreshed best-effort, probes addressing each provider's canonical upstream
through the environment proxy.

## Decisions & invariants

- **Layer ids carry the merge order** (`010` < `012` < `015`, zero-padded
  lexorank); the pi generator owns every layer source (d232; d024 is history).
  The merge contract has a single home: the `generate-pi-coding-agent.mjs` header.
- **By-agent, not by-concern**: d037 kept the four pi stages as separate
  processes; the by-agent merge consolidated them into ONE generator process
  (stages as functions, documented order). This supersedes d037's process
  split while keeping its per-layer merge verdicts — d033 remains the semantic
  spec for the layers; d037 is history (d232).
- **Canonical URLs everywhere** (docs/d108 supersedes d063's route half;
  URL form per docs/d070): committed and installed artifacts both carry the
  fact-table canonical upstream, probes fetch each provider's canonical
  `<baseUrl>/models`, and both reach the edge through the environment proxy
  (`NODE_USE_ENV_PROXY=1`, docs/d074) — no base URL, no per-provider
  prefixed route, and no install-time rewrite anywhere in this folder.
  Probes run concurrently (`Promise.allSettled`) and only the LINEUP source
  is chosen; a thrown probe keeps its provider id so the remaining rows still
  probe.
- **One base-url schema for every provider.** A provider row carries its key
  env, and the upstream override derives from it the way Azure OpenAI spells the
  pair: `OPENROUTER_API_KEY` → `OPENROUTER_BASE_URL`,
  `AZURE_OPENAI_API_KEY` → `AZURE_OPENAI_BASE_URL`. `providerBaseUrl` in
  `lib/cloud-providers.mjs` is the ONE derivation: an unset or empty override
  keeps the fact table's canonical URL, a trailing slash is trimmed, and a value
  that is not an absolute http(s) URL throws instead of falling back (a typo
  must not send traffic to the canonical upstream while the operator believes
  the provider is pointed elsewhere). A key env that does not end in
  `_API_KEY` gets no derived name, because a guessed name silently retargets a
  provider. The generator bakes whichever URL the run used, so an artifact is
  canonical _for its host_; `check-canonical-artifacts.mjs` accepts the override
  only while the same environment derives it. The `pi-*` provider extensions
  adopt the same derivation at registration (a `sources.mjs` row resolves its
  exported `*_BASE_URL`, and the reroute-only mistral/opencode units attach
  `baseUrl` only when an override is set, leaving pi's built-ins untouched).
  One consequence of deriving from the key env: two rows sharing one key env
  share one override. `opencode` and `opencode-go` are the one such pair
  (`OPENCODE_API_KEY` → `OPENCODE_BASE_URL`), so a gateway named there must
  serve both surfaces; the generator and the extension both apply it to both.
  Which providers the extensions must cover, and which surfaces stay
  generator-only (the layer cake, the catalog cascade, the default pair,
  `mcp.json`), is docs/d239's rule.
- **The shell surface is bootstrap only** (`node-scripts` port): every
  entrypoint is an npm script over `build.mjs`/`generate.mjs`/`run.mjs`, and the
  three `.sh` files that remain only pick the interpreter (the repo-root
  `node-run.sh`) and start a script under it (the repo-root `npm-run.sh`, so
  `npm` itself never lands on an entrypoint's path). The launcher's argv assembly is a pure `buildLaunch` — the
  mount manifest is asserted, not incidentally produced — and the workload
  description is a JS module, so this folder needs **no `jq`** on the host
  (`estige/` and `llm-local-inference/` still ship their own jq copies,
  docs/d113). `lib/log.sh` went with the shell: `lib/log.mjs` was already the
  same contract.
- **URL form is verified, not assumed** (docs/d070):
  `check-canonical-artifacts.mjs` is the one detector — canonical upstreams
  over the committed artifacts (guarded by `tests/artifact-urls.test.mjs`) and
  inside generation. It is not a launch gate (docs/d227): the agent dir is host
  state, so a route-form leftover there is caught by a committed-snapshot
  review or by regenerating, not by refusing the launch.
- **Route building is gone** (docs/d027, removed as insecure by docs/d108):
  cloud routes were `<base>/<upstream-host>` on the reverse proxy; clients
  reach upstreams through the tunnel's proxy env instead (v3 transports, d104
  proofs). What remains on the estige side is the server removal diff.
- **Scoped models, not generated catalogs**: pi's own model catalog is used
  (`pi update --models`); providers are re-routed via `baseUrl` overrides only.
  The retired free-tier pipeline's decisions are distilled in
  `docs/archive/scoped-models-and-proxy-overrides.md` ("spirit of the retired
  notes"); the document is archived with the proxy role it served.
- **The prompt and the tool loadout are configured separately**:
  `settings.json`'s `defaultTools` adds capability (the base four plus
  `grep`, `find`, `ls`, and the `codemode` built-in extension) without
  touching `SYSTEM.md`/`APPEND_SYSTEM.md`/`AGENTS.md`,
  and `codemode.mode = "only"` with `inlineBudget: 0` keeps the model's
  declared tool set down to the codemode tool itself, so the request payload
  shrinks while every built-in stays active and callable from scripts.
  `tool_search` is left off on purpose: it is the one declared tool whose
  _use_ rewrites the declared tool set mid-session, while `searchTools()`
  inside codemode already reaches every deferred tool (docs/d061).
  Intent lives here; pi owns the mechanics (its `settings.md#tools` and
  `codemode.md`). Cost accepted: the model drives tools through codemode
  scripts and must `searchTools()`/`describeTool()` for signatures instead
  of reading declarations.
- **Key naming / baseUrl baking / proxy env**: d232 owns the law (d001 is history); native node proxy handling: `docs/d074-native-node-env-proxy.md`.
- A zero-provider merge result is **kept as-is** (never clobbers a good
  `models.json` with an empty merge).
- pi requires node ≥ 22.19; the floor is enforced by pi's own engines at
  launch (the Termux pre-stage `check-node-version.mjs` gate was retired —
  docs/d051).

## Provenance

The generators reach outside this folder for provider knowledge in exactly
four ways, and every one of them is a **read**: nothing this folder generates
depends on a data file in the tree (docs/d191), so a sibling's file cannot
change what a generate here emits. Three are LIVE legs — a fetch per run, no
committed copy — and one is a behavioral copy, the caveat worth knowing:

- **models.dev + catwalk**: live catalogs, fetched once per run through the
  relay chain and consumed-shape-validated. A fetch that does not answer
  aborts the run (models.dev) or empties the row (catwalk) — there is no
  committed fallback to degrade to (docs/d191, retired d114's stale copy).
- **Per-provider listings** (hyper `/provider`, synthetic `/models`, verboo
  `/models`, docs/d057): the providers' own documents, fetched per run and
  handed over in memory. The live answer IS the lineup; a source that cannot
  answer publishes nothing (docs/d190, d191).
- **Published docs read from git mirrors** (cline/cline
  `clinepass.mdx`, anomalyco/opencode `go.mdx`): pinned sources read with
  `git show` through the reference farm — the opencode mirror's HEAD must
  be the dev branch, and a stale mirror degrades to the committed fallback
  (cline-pass) or the historical resolver path (opencode-go), never to a
  wrong-priced lineup. The @ai-sdk/* package names models.dev records carry
  are vocabulary (the api-shape enum, docs/d048), not dependencies.
- **charmbracelet/pi-hyper-provider** `src/models.ts`: the ONE behavioral
  copy. The hyper row's modelCompat (supportsStore/thinkingFormat/
  maxTokensField), the ON_OFF thinking map, and the User-Agent convention
  are transcribed from that repo. Upstream can revise its compat table and
  this mirror has NO tripwire — a silent rot would ship wrong wire claims
  to every hyper turn. Mitigations today: the transcription is documented
  at the spec row, and the standalone projection (pi-hyper-provider/merge.mjs, whose
  tests pin the values) makes a divergence between the two copies visible
  as an artifact diff. The honest fix — re-deriving compat from what
  hyper's own listing publishes, or pinning a tested commit of that repo —
  is open and recorded in docs/d100.

The same inventory, per extension folder, lives in each `pi-*/README.md`'s
Provenance section (docs/d100 owns the classification rule: live data,
attribution, or behavioral copy — and every behavioral copy must be flagged).

## Boundary

Copy unit = **this folder alone** (`docs/architecture.md`, docs/d113): its own
`lib/`, its own build/generate entry, its own `tests/`. Nothing one level
up is implied — and nothing below is shared either: `tests/committed-manifests.test.mjs`
(docs/d050's canonicity guard) lives here because this folder owns every
manifest it asserts on.

`lib/` here is a hand copy, owned outright — no sync step, no upstream to keep
in step with, and this folder may retune any of it without touching a sibling.
It carries what this unit actually uses:

| Copy                                  | Why it is here                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log.mjs`                             | structured logging, same shape as every unit's                                                                                                                                                                                                                                                                                                        |
| `artifact.mjs` + `canonical-json.mjs` | the atomic write choke point and the canonical serialization it applies (docs/d050) — they only work as a pair                                                                                                                                                                                                                                        |
| `cloud-providers.mjs`                 | **the full** provider fact table: this folder is the reference vocabulary docs/d032's checklist and the tests read                                                                                                                                                                                                                                    |
| (no catalog)                          | the models.dev payload and every provider listing are fetched per run into that run's output dir, never committed (docs/d191)                                                                                                                                                                                                                         |
| (no caches)                           | nothing in this folder can go stale — a failed fetch publishes nothing (docs/d190, d191)                                                                                                                                                                                                                                                              |
| (deleted)                             | lib/fact-table.mjs published a committed cache; with no cache there is no publish path (docs/d191)                                                                                                                                                                                                                                                    |
| `…/node-run.sh`, `…/npm-run.sh`       | NOT here: both runners are one copy each at the repo root (docs/d138), and this folder ships **no `.sh` at all** — its entries are `./node-run.sh coding-agent/run.mjs` and `./npm-run.sh coding-agent {build,generate}`. `npm-run.sh` runs this folder's `package.json` script under the same pinned node, so no `npm` lands on an entrypoint's PATH |
| `workload-runtime.mjs`                | the workload API `run.mjs` describes the container with (`docs/container-tooling.md`) — description in, `container run` argv out. Replaced `workload-runtime.sh` + the six `workload-*.jq` filters, which is why this unit needs no `jq` on the host                                                                                                  |

`gen-lib.mjs` carries the pi shaping helpers shared by the pi-layer stages
(folded from the former `lib/pi-models.mjs`, docs/d039) and the paths both
generators use. The generators import logging, artifacts, provider facts, catalog
reads and route probes from their owning modules; `gen-lib.mjs` re-exports none
of them (docs/d233). Loading it runs nothing and reads nothing: the fact table
arrives as a value from the entry point, and every listing is fetched per run
(docs/d191). Must not reach into `llm-local-inference/`, `estige/` or any `pi-*`
sibling.

Nothing copies this tree anywhere at generate time (docs/d072): the generators
run from their own dir, output goes to the per-run `RUN_DIR` dir, and the
commit-backs to `model-*.json` / `opencode.jsonc` are the only writes that
touch the source tree — warn-only when it is read-only (docs/d056 removed the
container mounts, so the tree a generate runs from is a host checkout).
