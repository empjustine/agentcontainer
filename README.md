# agentcontainer

A minimal sandbox for [pi](https://github.com/earendil-works/pi) with
support for local [llama.cpp](https://github.com/ggerganov/llama.cpp)
GGUF inference (via
[llama-swap](https://github.com/mostlygeek/llama-swap)) and a raw
passthrough reverse proxy for cloud LLM providers.

## Quick start

```sh
# Bazzite (rootless podman) — ONE llama-swap instance for LOCAL GGUF
# inference, published on LAN port 8101 (the coding agent reaches it in-network;
# the world reaches estige's tunnel at the funnel mount, docs/d073/d108)
cd ~/agentcontainer && ./npm-run.sh llm-local-inference generate
#   then the coding agent (local models + cloud; credentials via ./environment.sh, docs/d046)
#   extra ARGV dirs mount rw too (CWD is implicit first): ./node-run.sh coding-agent/run.mjs ~/Downloads/references
cd ~/agentcontainer && ./environment.sh ./node-run.sh coding-agent/run.mjs

# cloud/remote providers — the SSL-VPN tunnel node (no model routing, no
# credential handling; requests must already carry valid provider keys)
# estige installs as a service: build the packages, then let the service
# manager run it (docs/d120)
cd ~/agentcontainer && ./node-run.sh estige/build.mjs estige-packages
#   Termux:   dpkg -i estige/packaging/out/estige_<v>_aarch64.deb && sv-enable estige
#   Oracle Linux: rpm -i estige/packaging/out/estige-<v>-1.x86_64.rpm && systemctl enable --now estige
#   direct run instead of a package: ./environment.sh ./estige/estige -mode exit
# relay node (restricted network, docs/d095): the installed estige-relay
# service, and the chain step that points a local consumer at its loopback
# proxy — the chain step starts nothing (docs/d120)
#   eval "$(./estige/estige proxy-env)" && ./node-run.sh coding-agent/run.mjs
```

**Every folder is a copy unit, and it is built from that folder (docs/d113)**:
each carries the modules it needs (its own `lib/`, or folder-local modules in
the pi extension family, d118), its own build/generate entry (a `build.mjs` /
`generate.mjs` where it builds or generates something, a `package.json` script
table in the pi extension family — and no `.sh` of its own, d138), and its own
`tests/`.
There is **no root build or generate entry point** — you invoke the unit you
are building: `./node-run.sh estige/build.mjs`, `./npm-run.sh coding-agent generate`,
`./npm-run.sh llm-local-inference generate`, and for the pi extensions
`./npm-run.sh pi-hyper generate` (the wrapper only supplies the
pinned node; the command line comes from the folder's own `package.json`).
That holds because a folder has to survive being copied out of this tree on its own
(docs/architecture.md), and a root sequencer would make every folder
reference a parent that no longer exists in the copy. `./lint.sh`,
`./check-types.sh`, `./test.sh` and `./vm-bench.sh` are the repo-wide **QA
sweep**: the maintainer's view across units, which no unit imports. The first
three are offline by contract; `./freshness.sh` is the fourth and the only one
that touches the network, because "is this committed cache still what upstream
serves?" cannot be answered offline ([docs/d122](docs/d122-data-freshness-gate.md)).
Runners NEVER build or generate: stale/missing artifacts are user issues, and the
launcher fails loudly pointing at the generator.

**Environment/secrets are an EXPLICIT chain step** (`./environment.sh` —
`infisical run` fetches the vault and spawns the target with it as plain
env, on the host, docs/d046):
`./environment.sh ./node-run.sh coding-agent/run.mjs`, `./environment.sh
./llm-local-inference/run.sh`, etc. The target may also be a bare command:
`./environment.sh pi` runs pi with the vault env and no sandbox — the run
path for a host with no container backend (docs/d059). The scripts it wraps consume plain env
and never load anything themselves; inside sandboxes the vault env is
forwarded via the `workload_env` allowlist. Generation steps that need no
keys (llm-local-inference/generate.mjs, every `pi-*/generate.mjs`) run
without the chain. No `.env` files, no in-script loaders, no emergency
paths — a failed vault round-trip is fatal at the chain, never a silent
half-configured run.

There is no Termux/peers-only variant of llm-local-inference anymore —
cloud relay moved to estige.

## Folder layout

> Orientation map, not an exhaustive manifest: folders and files come and go.
> Keep folder-level rows honest; use `ls`/`find`/`rg` for current contents
> rather than chasing file-level churn here.

```
agentcontainer/
├── environment.sh                       # → EXPLICIT env chain: `infisical run` spawns <script-or-command> (d046; a bare command = the sandbox-free run path, d059)
├── provision-termux.sh                  # → termux pkg/infisical provisioning (the former root build.sh)
├── node-run.sh / npm-run.sh / node-run.ps1 # → THE interpreter runners (d138): one copy each, and THE way to start a unit — `./node-run.sh <entry> [args]`, `./npm-run.sh <unit> <script>` — no per-folder copies and no per-entry shims (the pin is one edit); ps1 is the Windows counterpart (d062)
├── log.sh / npm-tools.sh                # → operator-level shell, never imported by a unit: structured logger · on-demand npm devDependency install (d107)
├── lint.sh / check-types.sh / test.sh / vm-bench.sh # → the repo-wide QA sweep (d113): biome+knip+jq+golangci-lint gates · tsc · every unit's tests (test.sh globs `<unit>/tests/` and runs estige's Go suite explicitly, d123), driven from the root because no unit imports them (the sweep owns no test of its own)
├── freshness.sh                         # → the QA sweep's one NETWORK gate (d122): every pi-* `generate --check` + the offline HF manifest audit, so a stale committed cache fails a gate instead of a review; key-gated listings skip loudly, run it via ./environment.sh to include them
├── docs/                                # docs tree, typed per docs/spec-graph-standard.md
│   ├── requirements.md                  # → BRD: what the system must do (id: goal)
│   ├── architecture.md                  # → systems reference: the copy unit, per-unit lib, root QA sweep
│   ├── environments-and-variants.md     # → bazzite / a50 / work matrix
│   ├── container-tooling.md             # → the workload-api spec every unit's own copy implements (lib/workload-runtime.mjs in coding-agent, the .sh+.jq pair elsewhere)
│   │   # cross-cutting docs only (d117): a living doc that guides ONE unit lives in that unit's folder
│   ├── d0XX-*.md                        # → decision log (history; kept mechanically accurate, FR-D2)
│   ├── archive/                         # → research findings + retired docs (index inside)
│   ├── docs/                            # → VENDORED writing references, outside the spec graph (no id/type): Google style guide + Technical Writing One/Two (clipped), Microsoft Writing Style Guide (source Markdown). CC BY 4.0, NOT this repo's license — read the README there
│   └── ...
│
├── llm-local-inference/                 # llama-swap: LOCAL GGUF inference only
│   ├── run.sh                           #   → unified-vulkan image + GPU + HF mounts on :8101 (real logic: the workload API)
│   ├── generate.mjs                     #   → capability-gated config.d layers (fails on non-GPU hosts); `./npm-run.sh llm-local-inference generate`
│   ├── build.mjs                        #   → pulls the llama-swap image (inference-endpoint gate, d087); `./npm-run.sh llm-local-inference build`
│   ├── model-sizes.sh / model-sizes.mjs #   → footprint + cheapest-first reorder of its own lib/llamacpp-model-data.json (d053)
│   ├── active-b.json                    #   → activeB table (model-id derivation)
│   ├── llama-swap-core.json             #   → general-purpose config source
│   ├── config.d/                        #   → generated split config (loaded via -config-dir)
│   ├── lib/                             #   → THIS FOLDER's own copy (d113): workload-runtime.sh + workload-*.jq, log.mjs/log.sh/log.py, artifact.mjs, canonical-json.mjs, host-capabilities.mjs, llamacpp-model-data.json, hf-manifests/ (size source for d053); the interpreter runner is repo-root, not per-folder (d138)
│   ├── tests/                           #   → this folder's own tests, standalone-runnable
│   ├── CACHE-DESIGN.md                  #   → HF cache pipeline (the folded local-llm/ tooling, flat here since d113), table-write rule
│   ├── DESIGN.md                        #   → llama-swap config.d layers, generation-time path baking, capability gating, bearer auth
│   └── *.md                             #   → this unit's own living docs (d117): hf-cache-upkeep / refresh-...-manifest runbooks, gguf-model-tooling + its generated gguf-vram-fit-estimates tables
│
├── estige/                              # SSL-VPN tunnel node (Go, one binary, two roles: exit + relay), installed as a package (d073/d077/d120)
│   ├── main.go                          #   → dispatches the two roles: `-mode exit` (tunnel server) / `-mode relay`, plus `proxy-env` and `-version`
│   ├── packaging/                       #   → the deb/rpm writers (pure Go) + termux/ and ol/ format inputs; `out/` is gitignored (docs/d120)
│   ├── build.mjs                        #   → this folder's own build (d083/d113): go-build probe + target selection (native · image · packages), no root builder; `./node-run.sh estige/build.mjs`
│   ├── *.go / *_test.go                 #   → egress policy, tunnel transports, relay node, `proxy-env`, VPN end-to-end tests (go test ./...)
│   ├── lib/                             #   → THIS FOLDER's own copy (d113), now build-only: go-build.mjs, host-capabilities.mjs, log.mjs (no shell, no jq — docs/d120)
│   ├── README.md                        #   → operations: package install, service units, env-only config, `proxy-env`, build, port model
│   └── DESIGN.md                        #   → deployment boundary (binary/supervisor/package), tunnel-transport rationale, 404, error taxonomy
│
├── coding-agent/                        # Bazzite usage (full pi)
│   ├── run.mjs                          #   → launches the pi coding-agent CONTAINER; no backend → ./environment.sh pi (d059); ARGV = extra dirs to mount rw (CWD implicit, d056). `./node-run.sh coding-agent/run.mjs`
│   ├── generate.mjs                     #   → the folder driver: stages + runs the TWO by-agent generators (d041; broad by-agent merge); `./npm-run.sh coding-agent generate` runs the package.json script
│   ├── build.mjs / package.json         # → this folder's own image build (d083/d113) + its script table (build/generate/run/test); `./npm-run.sh coding-agent build`
│   ├── generate-pi-coding-agent.mjs     #   → ALL pi config: model-*.json layers → models.json + default-model.json overlay
│   ├── generate-opencode.mjs            #   → opencode overlay config (provider SINGULAR key; skipped on Termux w/o OPENCODE_CONFIG_DIR)
│   ├── gen-lib.mjs                      #   → shared generator preamble (pi shaping folded in, d039)
│   ├── route-probe.mjs                  #   → HTTP route/probe toolkit (renamed peer-probe.mjs, d071; folded out of the root lib, d039)
│   ├── check-canonical-artifacts.mjs    #   → committed artifacts carry canonical upstreams, installed ones carry routes (d070)
│   ├── catalog-facts.mjs                #   → the two catalog fact caches: per-provider (`<id>-facts.json`, d057) + catwalk (lib/, d039) — d072 merged them
│   ├── hyper-facts.json / verboo-facts.json # → committed facts caches (d057: verboo's is its lineup)
│   ├── refresh-models-dev.mjs           #   → atomic models.dev catalog refresh (d039/d086)
│   ├── settings.json                    #   → static pi settings (generator installs into PI_CODING_AGENT_DIR)
│   ├── mcp.json                         #   → committed default MCP servers, merged into the agent dir (docs/d061)
│   ├── config.toml                      #   → mise configuration (includes cline and thinkrail)
│   ├── Containerfile                    #   → container image build
│   ├── *.md                             #   → this unit's own living docs (d117): DESIGN, plus coding-harness-persistence / scoped-models-and-proxy-overrides / summarized-thinking
│   ├── lib/                             #   → THIS FOLDER's own copy (d113), the largest: workload-runtime.mjs (the workload_* API in node, no jq on the host), log.mjs, artifact.mjs, canonical-json.mjs, fact-table.mjs, host-capabilities.mjs, cloud-providers.mjs/.json (the full table), models.dev.api.json, catwalk-facts.json; the interpreter runners are repo-root (d138)
│   └── tests/                           #   → this folder's own tests (canonicalization, committed-manifest guard (d050), fact table, URL forms, modality gate, cost map, launcher argv + workload rendering, the jq-free guard)
│
├── pi-synthetic/                        # Synthetic as a pi package (d096): ONE generator + ONE loadable extension, in this folder
│   ├── sources.mjs                      #   → the ONE data source: the provider's /models listing, at the fact table's canonical upstream (d070)
│   ├── merge.mjs                        #   → the ONE shaping step + both projections (pi models.json entry, pi-ai extension entry)
│   ├── generate.mjs / package.json       #   → one fetch in, two artifacts out; --check verifies them without writing. The script table replaces generate.sh (d118): `./npm-run.sh <unit> generate`
│   ├── index.ts / package.json          #   → the extension entry + its pi.extensions manifest — the folder IS the package
│   ├── models.json / models.js          #   → GENERATED pi models.json-shaped block (canonical upstream, d070) · the extension's seed
│   ├── log.mjs                          #   → the folder's JSONL logger (d045/d060), folder-local since d118 — no lib/, no bootstrap shell
│   ├── tests/                           #   → this folder's own tests
│   ├── AGENTS.md / README.md / TODO.md / PENDING.md #   → folder rules · install + open items · the review that collapsed the design
│
├── pi-opencode/                         # opencode + opencode-go as ONE pi package (d097, unified by d100): catalog FRESHNESS WATCHDOGS — no model data, because pi builds both providers in
│   ├── index.ts / package.json          #   → the extension entry + its pi.extensions manifest — the folder IS the package, and there is nothing to generate
│   ├── tests/                           #   → this folder's own tests — and the only home of its fact-table rows (d118)
│   ├── tests/                           #   → this folder's own tests
│   ├── AGENTS.md / README.md            #   → folder rules · the built-in-provider rule + install + provenance
│
├── pi-cline-pass/                       # ClinePass as a pi package (d040): the reconciled lineup (Cline's docs table ∪ models.dev) as ONE generator + ONE loadable extension
│   ├── sources.mjs                      #   → the two published sources + the ONE reconciliation contract (match floor, cline-pass/ billing-prefix guard)
│   ├── merge.mjs                        #   → the ONE shaping step + both projections (pi models.json entry, pi-ai extension entry)
│   ├── generate.mjs / package.json       #   → two sources in, two artifacts out; --check verifies them without writing. The script table replaces generate.sh (d118): `./npm-run.sh <unit> generate`
│   ├── index.ts / package.json          #   → the extension entry + its pi.extensions manifest — the folder IS the package
│   ├── models.json / models.js          #   → GENERATED pi models.json-shaped block (canonical upstream, d070) · the extension's seed
│   ├── log.mjs                          #   → the folder's JSONL logger (d045/d060), folder-local since d118 — no lib/, no bootstrap shell
│   ├── tests/                           #   → this folder's own tests
│   ├── AGENTS.md / README.md            #   → folder rules · install + the lineup contract
│
├── pi-hyper/                            # Charm Hyper as a pi package (d100): ONE generator + ONE loadable extension — the provider's /provider catalog is PUBLIC
│   ├── sources.mjs / merge.mjs          #   → the ONE source read (the provider's /provider document) · the ONE shaping step + both projections (incl. the transcribed compat mirror, d033)
│   ├── generate.mjs / package.json       #   → one fetch in, two artifacts out; --check verifies them without writing. The script table replaces generate.sh (d118): `./npm-run.sh <unit> generate`
│   ├── index.ts / package.json          #   → the extension entry + its pi.extensions manifest — the folder IS the package
│   ├── models.json / models.js          #   → GENERATED pi models.json-shaped block (canonical upstream, d070) · the extension's seed
│   ├── log.mjs                          #   → the folder's JSONL logger (d045/d060), folder-local since d118 — no lib/, no bootstrap shell
│   ├── tests/                           #   → this folder's own tests
│   ├── AGENTS.md / README.md            #   → folder rules · install + the behavioral-copy provenance flag
│
├── pi-verboo/                           # Verboo as a pi package (d100): same shape against the AUTH-GATED /models listing — no prices ever asserted (d057)
│   ├── sources.mjs / merge.mjs          #   → the ONE source read (the provider's own listing — models.dev carries no verboo row at all, d057) · the ONE shaping step + both projections
│   ├── generate.mjs / package.json       #   → one keyed fetch in, two artifacts out; --check verifies them without writing. The script table replaces generate.sh (d118): `./npm-run.sh <unit> generate`
│   ├── index.ts / package.json          #   → the extension entry + its pi.extensions manifest — the folder IS the package
│   ├── models.json / models.js          #   → GENERATED pi models.json-shaped block (canonical upstream, d070) · the extension's seed
│   ├── log.mjs                          #   → the folder's JSONL logger (d045/d060), folder-local since d118 — no lib/, no bootstrap shell
│   ├── tests/                           #   → this folder's own tests
│   ├── AGENTS.md / README.md            #   → folder rules · install + the seeding provenance + the fleet seam
│
├── pi-mistral/                           # mistral as a pi package (d100): an AUTH-GATED watchdog — no model data (pi builds it in), silent without a key
│   ├── index.ts / package.json          #   → the extension entry + its pi.extensions manifest — the folder IS the package, and there is nothing to generate
│   ├── tests/                           #   → this folder's own tests — and the only home of its fact-table row (d118)
│   ├── AGENTS.md / README.md            #   → folder rules (the opencode watchdog deltas) · install + provenance
│
├── pi-summarized-thinking/              # end-of-turn reasoning summaries as a pi package (human-facing only): a `custom` entry per completed turn — never in the model's context
│   ├── README.md                        #   → install + usage: the `custom` entry (not `custom_message`), the two deliveries, the model chain, the commands, the invariants
│   ├── FINDINGS.md                      #   → the pi 1.5.0 + ThinkRail contracts it rests on, cited by symbol · the cache arithmetic · the superseded claims
│   ├── AGENTS.md / TODO.md              #   → folder rules (this extension never touches the context) · the open worklist, unbuilt (the `why` is coding-agent/summarized-thinking.md)
│
├── git/                                 # Reference-farm tooling (mirrors + search); the only shell is the flock pair (d121/d138)
│   ├── README.md                        #   → the module doc: the farm's three jobs, boundary, entry points
│   ├── -forge-mirror.sh                 #   → add a BARE mirror from any forge: https public forges + the software-forge tenant (idempotent; farm-wide flock, d099)
│   ├── farm-tool.sh → farm-tool.mjs     #   → d099's MCP tool surface (capped reads + two flocked maintenance verbs), one JSON object per call
│   ├── -vbs-mirror-all.sh → vbs-mirror-all.mjs  # → mirror a whole VBS tenant from a manifest (no jq, no live session, d121)
│   ├── audit.mjs                        #   → report anomalies in the reference farm (git/non-bare-issues.md)
│   ├── migrate-to-bare.mjs              #   → convert full clones to bare mirrors (local hardlink or redownload)
│   ├── maintain-mirrors.mjs             #   → align mirrors + repack/commit-graph (pickaxe fast; --deep-optimize adds gc --aggressive, d089)
│   ├── search-references.mjs            #   → opt-in cross-repo/cross-branch search via Zoekt container (d043)
│   ├── lib/                             #   → THIS FOLDER's core library (d121): the floor (git-core, forge-remotes) + the plumbing every entry shares
│   │                                    #     (cli, retry, farm-lock, farm-posture) + its own kernel copies (log.mjs, artifact, canonical-json); the node runners are repo-root (d138)
│   ├── farm-lock.sh                     #   → the ONE shell that still holds logic: flock(1) has no node equivalent (d121)
│   ├── tests/                           #   → this folder's own tests (pacer, globs, argv, retry, lock probe, and both ports end to end)
│   └── non-bare-issues.md               #   → why bare mirrors, the farm audit, pickaxe notes
```
## Documentation index

Docs are **typed and self-describing**: every Markdown file in this tree whose frontmatter carries `id` + `type` is a node in the spec graph, shaped by [docs/spec-graph-standard.md](docs/spec-graph-standard.md) (adopted in [docs/d111](docs/d111-spec-graph-standard-alignment.md)).

**This index describes the patterns, not the inventory.** Each entry's frontmatter already carries `id`, `type`, `status`, `parent` and its links, and the body says what it covers — so a specific answer is one search away (`grep -l '^status: active' docs/d127*.md`, `rg 'egress policy' docs/`, or the spec tools). Enumerating 130+ docs here only guaranteed this file was edited on nearly every doc landing, and drifted from the graph besides. Read the pattern, then search.

### The five types

| `type` | Scope — one sentence each | Where they live |
| --- | --- | --- |
| `goal-and-requirements` | What the product must do: goal, scope, functional + non-functional requirements, non-goals. Normative. | [docs/requirements.md](docs/requirements.md) (id `goal`, the root of the tree) |
| `architecture-design` | System-wide decisions, the reference map, topology, and prior-art studies that drive a cross-module call. | `docs/` — the record files (`dNNN-*.md`) and the reference docs beside them |
| `module-design` | One runner folder or one module: its responsibilities, boundary, invariants and the *why* behind its shape. | the unit's own folder under [d117](docs/d117-living-docs-beside-their-unit.md) (`README.md` = what it is, `DESIGN.md` = why), plus `docs/` for cross-cutting module records |
| `submodule-design` | A subsystem inside a package — narrower than a module, still independently describable. | beside its subject |
| `task-spec` | One piece of work in flight: request, product, design, deferrals. Temporary — its durable content moves into the owning spec. | `.thinkrail/context/TASK-*.md` (gitignored) |

**Lifecycle** is the frontmatter `status:` field: `draft` / `active` / `stale` / `done` / `deprecated`. A qualifier ("proposed", "design only", "landed, unverified") belongs in the body's `## Status` section, never inside the status value. `docs/archive/` holds investigations that reached `done`.

### Start here

A short reading path rather than a catalog — pick the one that matches what you are doing:

- **What the system is for** → [docs/requirements.md](docs/requirements.md), then [docs/architecture.md](docs/architecture.md) (the copy unit, per-unit `lib/`, the root QA sweep).
- **Running it** → [estige/README.md](estige/README.md) for the tunnel nodes, [coding-agent/DESIGN.md](coding-agent/DESIGN.md) for the agent sandbox, [docs/container-tooling.md](docs/container-tooling.md) for the workload API every unit's own copy implements.
- **Why the tunnel looks like this** → [docs/d073](docs/d073-ssl-vpn-three-modes.md) (transports + `VPN-R*` requirements), [docs/d077](docs/d077-ssl-vpn-transport-ladder.md) (the ladder), [docs/d108](docs/d108-serving-edge-tunnel-only.md) (generations v1–v4, the one vocabulary), [docs/d104](docs/d104-mutual-exit-relay-credential.md) (v4's credential).
- **Why the generators look like this** → [docs/d033](docs/d033-generator-cascade.md), [docs/d070](docs/d070-canonical-upstream-urls-and-install-time-routing.md), [docs/d100](docs/d100-pi-provider-extension-family.md).
- **How docs and specs are written here** → [AGENTS.md](AGENTS.md), [docs/spec-graph-standard.md](docs/spec-graph-standard.md), [docs/d042](docs/d042-documentation-taxonomy.md), [docs/d117](docs/d117-living-docs-beside-their-unit.md).
- **Before adding to a unit** → [docs/d113](docs/d113-retire-shared-lib-and-root-orchestration.md): a folder is a copy unit, and `lib/` code should be inlined until the unit has genuinely earned a library.

The `d0XX` log is **history**: each record is kept mechanically accurate ([d072](docs/d072-maintainability-review.md)) but never rewritten wholesale, so a record's vocabulary is the vocabulary of its day and a newer record supersedes it by name. Search it freely — every record names its own status and what it supersedes.

## Code conventions

Comments are deliberately verbose, but they exist only to explain **WHY** —
intent, rationale, history, invariants, gotchas, and pointers to the owning
design doc. They must **not** restate the **HOW**: the mechanics are carried by
correct, unambiguous names for functions, types, classes, and variables, not by
comments. If a comment narrates what the code does, fix the name (or move the
explanation to `docs/`) instead. The authoritative statement and examples live
in [AGENTS.md](AGENTS.md); design essays belong in `docs/` and are indexed
above.

Prefer **metadata over prose comments**, so the facts live where tooling can
surface them and cannot drift from the signature:

- Parameter/type invariants go in JSDoc (`@param`, `@property`, `@returns`,
  `@typedef`, `@type`), not in a `//` beside the value.
- Whole-file purpose, contract, usage and env surface go in the top-of-file
  ESM `@fileoverview` block.
- Trivial HOW comments that the code (or the adjacent doc) already says are
  deleted, not rewritten.

## License

AGPL-3.0.
