# agentcontainer - Enhanced with Cline and Thinkrail

A minimal sandbox for [pi](https://github.com/earendil-works/pi) with
support for local [llama.cpp](https://github.com/ggerganov/llama.cpp)
GGUF inference (via
[llama-swap](https://github.com/mostlygeek/llama-swap)) and a raw
passthrough reverse proxy for cloud LLM providers.

## Quick start

```sh
# Bazzite (rootless podman) — ONE llama-swap instance for LOCAL GGUF
# inference, published on LAN port 8101 (the world reaches it via the
# tailscale funnel → llm-reverse-proxy's /llama-swap route, docs/d027)
cd ~/agentcontainer/llm-local-inference && ./generate.sh
#   then the coding agent (local models + cloud; credentials via lib/environment.sh, docs/d046)
cd ~/agentcontainer && ./lib/environment.sh ./coding-agent/run.sh

# cloud/remote providers — raw passthrough reverse proxy (no model routing,
# no credential handling; requests must already carry valid provider keys)
cd ~/agentcontainer && ./build.sh && ./generate.sh && ./llm-reverse-proxy/run.sh
```

**One build + one generate for the whole repo (docs/d041)**: root `./build.sh`
(builds everything for THIS host — container images in parallel, the Termux
provisioning + android binary serialized) and root `./generate.sh` (every
folder's generator in sequence, continue-on-failure). Each folder's own
`generate.sh` shim still runs its generator standalone. Runners NEVER build
or generate: stale/missing artifacts are user issues, and run.sh fails loudly
pointing at the generator.

**Environment/secrets are an EXPLICIT chain step** (`lib/environment.sh` —
`infisical run` fetches the vault and spawns the target with it as plain
env, on the host, docs/d046):
`./lib/environment.sh ./coding-agent/run.sh`, `./lib/environment.sh
./llm-local-inference/run.sh`, etc.  The scripts it wraps consume plain env
and never load anything themselves; inside sandboxes the vault env is
forwarded via the `workload_env` allowlist.  Generation steps that need no
keys (llm-local-inference/generate.mjs, llm-reverse-proxy/generate.mjs) run
without the chain.  No `.env` files, no in-script loaders, no emergency
paths — a failed vault round-trip is fatal at the chain, never a silent
half-configured run.

There is no Termux/peers-only variant of llm-local-inference anymore —
cloud relay moved to llm-reverse-proxy.

### New: Enhanced with Cline and Thinkrail

This setup extends the coding agent with additional AI tools:

#### Cline CLI
Installs the official Cline CLI for AI development assistance:
```sh
npm i -g cline
```

#### Thinkrail.ai
Installs the JetBrains Thinkrail development tool:
```sh
curl -fsSL https://raw.githubusercontent.com/JetBrains/thinkrail/main/install.sh | bash
```

Both tools are now included in the container's mise configuration for reliable, repeatable installation.

## Folder layout

> Orientation map, not an exhaustive manifest: folders and files come and go.
> Keep folder-level rows honest; use `ls`/`find`/`rg` for current contents
> rather than chasing file-level churn here.

```
agentcontainer/
├── generate.sh / generate.mjs          # → run EVERY folder's generator in sequence (d041)
├── build.sh / build.mjs                # → build everything for THIS host (images ∥; termux serialized)
├── vm-bench.sh                          # → d020 Level-1 VM build bench: provision/drive the libvirt guest that runs nested podman (docs/vm-build-bench.md SOP)
├── tests/                             # standalone checks (node --test for JS, sh for workload helpers)
│   ├── check-workload.sh              # → workload_ro / workload_ro_if mount-helper tests
│   ├── canonical-json.test.mjs        # → canonicalization unit + committed-manifest canonicity guard (d050)
│   ├── lib-staging.test.mjs           # → guards the hand-maintained lib/ staging lists in generate.mjs + run.sh (d050)
│   └── modality-allowlist.test.mjs    # → the d049 admit-but-trim gate/projection contract (gen-lib capability constant)
├── docs/                              # docs tree, typed per docs/d042 (BRD / reference / design)
│   ├── requirements.md                # → BRD: what the system must do (id: goal)
│   ├── architecture.md                # → systems reference: split, standalone rule, lib inventory
│   ├── environments-and-peer-variants.md   # → bazzite / a50 / work matrix
│   ├── container-tooling.md           # → lib/workload-runtime.sh, run scripts (the lib module doc)
│   ├── coding-harness-persistence.md  # → per-harness host-side stage dirs
│   ├── hf-cache-upkeep.md, refresh-local-llm-manifest.md, gguf-*.md   # → runbooks + generated tables
│   ├── d0XX-*.md                      # → decision log (append-only history)
│   ├── archive/                       # → research findings + retired docs (index inside)
│   └── ...
├── lib/                               # Shared infrastructure (docs/architecture.md)
│   ├── workload-runtime.sh             #   → sandbox-backend detection + workload_* API
│   ├── node-run.sh                     #   → standalone node_run() (pinned node; termux-aware)
│   ├── go-build.mjs                    #   → go toolchain probe + android/host flag presets (d041)
│   ├── provision-termux.sh             #   → termux pkg/infisical provisioning (the former root build.sh)
│   ├── llamacpp-model-data.json        #   → canonical GGUF model definitions + SI-GB footprints (shared; d025/d053)
│   ├── hf-manifests/                   #   → committed HF repo listings (per-file sizes; size-source for d053)
│   ├── models.dev.api.json             #   → vendored models.dev catalog (coding-agent + llm-reverse-proxy)
│   ├── catwalk-facts.json              #   → vendored catwalk catalog (coding-agent + llm-reverse-proxy)
│   ├── cloud-providers.mjs             #   → the one cloud-provider fact table
│   ├── log.mjs / artifact.mjs / canonical-json.mjs / log.sh # → shared logger/artifact std (canonical manifest JSON — d050)
│   ├── environment.sh                   #   → EXPLICIT env chain: `infisical run` spawns <script> (d046)
│   ├── workload-*.jq                   #   → jq filters behind the workload_* API
│
├── llm-local-inference/                   # llama-swap: LOCAL GGUF inference only
│   ├── run.sh                           #   → unified-vulkan image + GPU + HF mounts on :8101
│   ├── generate.sh / generate.mjs       #   → capability-gated config.d layers (fails on non-GPU hosts)
│   ├── model-sizes.sh / model-sizes.mjs #   → footprint + cheapest-first reorder of lib/llamacpp-model-data.json (d053)
│   ├── active-b.json                    #   → activeB table (model-id derivation)
│   ├── llama-swap-core.json             #   → general-purpose config source
│   └── config.d/                        #   → generated split config (loaded via -config-dir)
│
├── llm-reverse-proxy/                   # Raw passthrough reverse proxy for cloud LLMs (Go)
│   ├── main.go                          #   → http host:port/{provider}/<path> → <base-url>/<path>, streaming as-is
│   ├── llm-reverse-proxy.example.json   #   → provider slug → base URL map (the whole config surface)
│   ├── generate.sh / generate.mjs       #   → routing table from lib/cloud-providers.mjs (d038 catalog)
│   ├── smoke-test.sh                    #   → 34 behavioural checks against the built binary/image
│   ├── README.md                        #   → operations: routing table, usage, build, port model
│   └── DESIGN.md                        #   → routing-convention rationale, 404 anti-oracle, RFC 9457 error taxonomy
│
├── coding-agent/                        # Bazzite usage (full pi)
│   ├── run.sh                           #   → launches pi coding-agent container (exec through ../lib/environment.sh)
│   ├── generate.sh / generate.mjs       #   → the folder driver: stages + runs the TWO by-agent generators (d041; broad by-agent merge)
│   ├── generate-pi-coding-agent.mjs     #   → ALL pi config: model-*.json layers → models.json + default-model.json overlay
│   ├── generate-opencode.mjs            #   → opencode overlay config (provider SINGULAR key; skipped on Termux w/o OPENCODE_CONFIG_DIR)
│   ├── gen-lib.mjs                      #   → shared generator preamble (pi shaping folded in, d039)
│   ├── peer-probe.mjs                   #   → HTTP probe toolkit (folded out of lib/, d039)
│   ├── hyper-facts.mjs / hyper-facts.json # → Charm Hyper facts cache + enricher (d039)
│   ├── catwalk-facts.mjs                #   → catwalk catalog refresher (cache stays in lib/, d039)
│   ├── refresh-models-dev.mjs           #   → atomic models.dev catalog refresh (d039)
│   ├── settings.json                    #   → static pi settings (copied by run.sh)
│   ├── config.toml                       #   → mise configuration (includes cline and thinkrail)
│   └── Containerfile                    #   → container image build
│
├── local-llm/                           # Local LLM / HF cache tooling (mostly deprecated — d053; superseded by llm-local-inference/model-sizes.mjs)
│   ├── run-all.sh                       #   → full pipeline in dependency order
│   ├── download_models.py               #   → provision served GGUFs into the HF cache
│   ├── upkeep.py                        #   → cache list/pull/prune/verify (uv run)
│   ├── fetch_hf_manifests.py            #   → refresh + audit repo:quant manifests
│   ├── fetch-model-cards.sh             #   → refresh model-card mirrors
│   ├── generate_vram_fit_tables.py      #   → VRAM/KV/fit tables via gdevenyi/huggingface-estimate
│   └── model-cards/                     #   → GGUF model documentation
│
├── git/                                 # Reference-farm tooling (mirrors + search)
│   ├── -github-clone.sh                 #   → add a non-bare clone (GitHub only; legacy references/github/ layout)
│   ├── -forge-mirror.sh                 #   → add a BARE mirror from any https forge (github/codeberg/sr.ht/gitlab; idempotent)
│   ├── audit.mjs                        #   → report anomalies in the reference farm (git/non-bare-issues.md)
│   ├── migrate-to-bare.mjs              #   → convert full clones to bare mirrors (local hardlink or redownload)
│   ├── maintain-mirrors.mjs             #   → align mirrors + repack/commit-graph (pickaxe fast)
│   ├── search-references.mjs            #   → opt-in cross-repo/cross-branch search via Zoekt container (d043)
│   └── non-bare-issues.md               #   → why bare mirrors, the farm audit, pickaxe notes
```

## Documentation index

Docs are typed per [docs/d042](docs/d042-documentation-taxonomy.md):
`requirements` (the BRD) / `reference` (systems reference) / `design` (TDD) /
`research` (one-time findings) + the append-only `d0XX` decision log.
Frontmatter `type:` is the machine signal; this index is the human map.

### Requirements (BRD)

| Doc | Covers |
|-----|--------|
| [docs/requirements.md](docs/requirements.md) | **The BRD** — goal, scope, functional + non-functional requirements, non-goals (id: goal — the parent of the doc tree) |

### Systems reference

| Doc | Covers |
|-----|--------|
| [docs/architecture.md](docs/architecture.md) | Self-contained runners vs base config generators, standalone rule, lib inventory, one-generate-one-build |
| [docs/environments-and-peer-variants.md](docs/environments-and-peer-variants.md) | Environment matrix (bazzite/a50/work), env vars, serving/usage dirs |
| [docs/container-tooling.md](docs/container-tooling.md) | lib/workload-runtime.sh, run scripts, UID/SELinux, environment matrix (the `lib` module doc) |
| [docs/workload-sandboxing-prior-art.md](docs/workload-sandboxing-prior-art.md) | sandboxing prior art from the reference farm (bwrap, landlock, seccomp, cgroups, namespaces) — threat model of the runner as the lens, overlap/unique-capability map with cover-cost per gap, per-solution pitfalls on record, the declarative-orchestration + VM/micro-VM layer above/beside the backends, and mirror candidates not yet fetched |
| [docs/blackboard-and-context-management-prior-art.md](docs/blackboard-and-context-management-prior-art.md) | blackboard / LLM task-context prior art from the reference farm (pelagos blackboard, cline teams, budget+compaction engines, file-plan skills, session persistence, provider-side context editing) — untrusted third-party statements, cross-cutting lessons, and un-mirrored candidates for the next batch |
| [docs/coding-harness-persistence.md](docs/coding-harness-persistence.md) | How each coding harness's state survives ephemeral container runs |
| [docs/hf-cache-upkeep.md](docs/hf-cache-upkeep.md) | HF cache upkeep runbook (upkeep.py: list/pull/prune/verify) |
| [docs/refresh-local-llm-manifest.md](docs/refresh-local-llm-manifest.md) | Manifest refresh runbook (repo:quant audits, cache coverage) |
| [git/non-bare-issues.md](git/non-bare-issues.md) | Reference-farm mirrors: why a checkout is pure overhead (podman `z,U` walk), the farm audit, pickaxe-fast maintenance |
| [docs/gguf-vram-fit-estimates.md](docs/gguf-vram-fit-estimates.md) | VRAM/KV/fit tables for all served models (gdevenyi/huggingface-estimate) |
| [docs/gguf-model-tooling.md](docs/gguf-model-tooling.md) | GGUF tooling (`fetch_hf_manifests.py` live; size-estimation tools archived) |
| [docs/vm-build-bench.md](docs/vm-build-bench.md) | vm-bench.sh SOP — d020 Level-1 VM as the nested-podman build bench (rootless session libvirt + cloud-init + slirp; no host podman socket) |
| [llm-reverse-proxy/README.md](llm-reverse-proxy/README.md) | Proxy operations: routing table, usage, build, port model, smoke test |

### Design (TDD)

| Doc | Covers |
|-----|--------|
| [coding-agent/DESIGN.md](coding-agent/DESIGN.md) | pi agent image + by-agent config generation — the two-generator structure, the layered-cake merge contract (single home: the generate-pi-coding-agent.mjs header), stage table, invariants |
| [llm-local-inference/DESIGN.md](llm-local-inference/DESIGN.md) | llama-swap config.d layers, generation-time path baking, capability gating, bearer auth |
| [llm-reverse-proxy/DESIGN.md](llm-reverse-proxy/DESIGN.md) | Proxy design rationale: full-real-base-URL convention, 404 anti-oracle, RFC 9457 error taxonomy, deviations |
| [local-llm/DESIGN.md](local-llm/DESIGN.md) | HF cache pipeline, shared-table boundary, the sanctioned-write rule |
| [docs/scoped-models-and-proxy-overrides.md](docs/scoped-models-and-proxy-overrides.md) | Why pi uses its own catalog with baseUrl overrides (distilled from the retired free-tier pipeline) |
| [docs/summarized-thinking.md](docs/summarized-thinking.md) | summarized-reasoning extension — CoT summarization design |

### Decision log (append-only)

> Curated, not complete: records that no longer represent the tree stay in
> `docs/` as history and are listed here only while they still shape it.

| Doc | Covers |
|-----|--------|
| [docs/d018-split-config-d.md](docs/d018-split-config-d.md) | split `config.d/` layout + llama-swap merge contract |
| [docs/d020-libvirt-qemu-sandbox.md](docs/d020-libvirt-qemu-sandbox.md) | qemu/libvirt VM sandboxes — requirements assessment (not implemented) |
| [docs/d027-path-prefix-peer-routing.md](docs/d027-path-prefix-peer-routing.md) | path-prefix peer routing — llm-reverse-proxy replaces llama-swap's model-id magic |
| [docs/d027b-models-dev-relay-fallback.md](docs/d027b-models-dev-relay-fallback.md) | models.dev catalog fetch chain (direct → llm-reverse-proxy relay → stale copy) |
| [docs/d028-provider-extensions-vs-generated-config.md](docs/d028-provider-extensions-vs-generated-config.md) | pi/opencode provider extensions vs generated-config machinery (verified; proposed) |
| [docs/d029-launch-gguf-complexity.md](docs/d029-launch-gguf-complexity.md) | the former in-container `launch-gguf.sh` path — complexity audit; option B (generation-time path baking) IMPLEMENTED |
| [docs/d030-coding-agent-flow-simplification.md](docs/d030-coding-agent-flow-simplification.md) | coding-agent flow — host↔container staging duplication, launch chain, GC, generator consolidation (proposal) |
| [docs/d031-llm-reverse-proxy-flow-simplification.md](docs/d031-llm-reverse-proxy-flow-simplification.md) | llm-reverse-proxy flow — already minimal; keep-shape notes + two small cleanups (proposal) |
| [docs/d032-adding-a-cloud-provider.md](docs/d032-adding-a-cloud-provider.md) | adding a cloud provider — the flow + surprises (worked example: inferx; two sources of truth, run.sh key allowlist, toggle-only reasoning) |
| [docs/d033-generator-cascade.md](docs/d033-generator-cascade.md) | the shared cloud/local generator detection cascade, reachability rule, and each generator's emitted layer shape |
| [docs/d034-parallel-probing-and-multi-hop-peerBase.md](docs/d034-parallel-probing-and-multi-hop-peerBase.md) | parallel provider probing (`Promise.allSettled`) + multi-hop `PEER_BASE_URLS` peer chains |
| [docs/d035-dynamic-default-model.md](docs/d035-dynamic-default-model.md) | host-aware `defaultProvider`/`defaultModel` selection from the generated `models.json` |
| [docs/d036-operator-hardcoded-default-model.md](docs/d036-operator-hardcoded-default-model.md) | default model is operator-hardcoded in settings.json; the d035 dynamic picker is retired (supersedes d035's selection mechanism) |
| [docs/d037-generator-merge-verdict.md](docs/d037-generator-merge-verdict.md) | broad generator-merge proposal verdict — cloud generators unify into one table-driven generator, the rest stay split (d030 option 6) |
| [docs/d038-proxy-full-provider-catalog.md](docs/d038-proxy-full-provider-catalog.md) | llm-reverse-proxy routes the full pi-ai ∪ models.dev ∪ catwalk provider catalog (priority pi-ai > models.dev > catwalk) |
| [docs/d039-fold-single-consumer-lib-modules.md](docs/d039-fold-single-consumer-lib-modules.md) | single-consumer lib/ modules fold back to their owning runner (peer-probe/pi-models/hyper-facts/catwalk-facts.mjs/refresh-models-dev → coding-agent; pi-ai + ai-sdk tables → generate-config) |
| [docs/d040-cline-pass-curated-lineup.md](docs/d040-cline-pass-curated-lineup.md) | cline-pass lineup is the published 13-model ClinePass table, not Cline's /models catalog (live sync disabled for it) |
| [docs/d041-unified-generate-build-entrypoints.md](docs/d041-unified-generate-build-entrypoints.md) | root `generate.mjs`/`build.mjs` unified entrypoints, `lib/node-run.sh` + `lib/go-build.mjs`, runners never build/generate |
| [docs/d042-documentation-taxonomy.md](docs/d042-documentation-taxonomy.md) | the docs taxonomy itself — requirements / reference / design / research + decision log, anchor analysis, the moves |
| [docs/d043-cross-repo-reference-search.md](docs/d043-cross-repo-reference-search.md) | cross-repo/cross-branch search — Zoekt for regex (opt-in, per repo), blob-addressed chunk embeddings for semantics, host-side serving without the farm bind mount |
| [docs/d044-work-machine-bare-mirrors.md](docs/d044-work-machine-bare-mirrors.md) | work-machine reference farm — software-forge clones to bare mirrors on NTFS, HAR export + manifest seam |
| [docs/d045-structured-logging-and-error-construct.md](docs/d045-structured-logging-and-error-construct.md) | structured logging and error construction — no interpolation, no level filtering, stdout default stream (payload scripts → stderr), full cause chains |
| [docs/d046-infisical-run.md](docs/d046-infisical-run.md) | the env chain is `infisical run` — the hand-rolled dotenv loader and its empty-vault pre-flight retire; `--expand=false` / `INFISICAL_DOMAIN` pins |
| [docs/d046b-live-listing-input-schema-poisoning.md](docs/d046b-live-listing-input-schema-poisoning.md) | live-listing `input` modality arrays (`video`/`audio`/`pdf`) poisoned `models.json` via `piModel()` verbatim passthrough → strict schemas (cline) rejected the file; fixed with a `toInput()` text+image guard; committed-snapshot writeback amplification |
| [docs/d047-llm-reverse-proxy-host-allowlist.md](docs/d047-llm-reverse-proxy-host-allowlist.md) | llm-reverse-proxy v2 (implemented, the only mode) — route by HOST allowlist (`/<host>/<path>` → scheme://host root, the client carries the upstream base path), deny-by-absence everything else; 36 owner-set hosts; no v1 slug compatibility; host-form `peerProviderUrl` for all generators; simplifies pi/opencode/charm divergence |
| [docs/d048-opencode-go-mixed-api-surface.md](docs/d048-opencode-go-mixed-api-surface.md) | opencode-go serves a MIXED api surface behind one base URL (completions/responses/messages per model) — per-model pi `api` overrides resolved from the published go.mdx endpoints table, union with the models.dev per-model `provider.npm`, d040-style agreement floor; empty map = pre-resolver behavior |
| [docs/d049-input-modality-allowlists.md](docs/d049-input-modality-allowlists.md) | implemented — modality/input capability as the uniform allowlist axis for model eligibility: `PI_MODALITY_CAPABILITY` + the `modalitiesEligible` admit-but-trim gate (drivable text in, exactly text out; unjudgeable dimensions pass) in `gen-lib`, composed gate-first at every record-backed site, `toInput` collapsed to one shared projection, name checks demoted to annotated exceptions (google/mistral `/embedding/`, `/embed|tts/`); openrouter `:free` stays an access filter that runs after the gate; metadata-rich sources only, opencode emission out of scope; verified by a regeneration audit (17 drops, all catalog-attributed, no chat model refused) + `tests/modality-allowlist.test.mjs` |
| [docs/d050-deterministic-generated-artifacts.md](docs/d050-deterministic-generated-artifacts.md) | implemented — canonical/stable generated manifests: schema-aware sort of provider maps and `models` arrays (not a deep key-sort) at the single write choke point (`lib/canonical-json.mjs` + `writeJsonArtifact`, sorted+pretty); fixes `model-012`'s `Promise.allSettled` key-order churn; one-time reformat of all 8 committed manifests + `tests/canonical-json.test.mjs` canonicity guard; NDJSON and one-line-per-model rejected; caches and `default-model.json` out of scope |
| [docs/d051-retire-termux-node-version-gate.md](docs/d051-retire-termux-node-version-gate.md) | retire the Termux node floor gate — `check-node-version.mjs` deleted (its inverted presence probe false-failed every healthy run); pi self-enforces `>= 22.19` and Termux/mise already guarantee a current node; supersedes d023 b3 |
| [docs/d053-model-size-ordering.md](docs/d053-model-size-ordering.md) | footprint data + cheapest-first `lib/llamacpp-model-data.json` — `llm-local-inference/model-sizes.mjs` sums main GGUF (all shards) + mmproj + MTP from committed `lib/hf-manifests` (cache fallback), emits SI-GB, retires the perf reorder; R4 (active-part) TODO |

### Research & archive

| Doc | Covers |
|-----|--------|
| [docs/termux-build-audit.md](docs/termux-build-audit.md) | Termux build audit — Infisical CLI `go install` impossibility + llm-reverse-proxy native build verification (anchored: d029/d031 reference this path) |
| [docs/sandbox-helper-env-analysis.md](docs/sandbox-helper-env-analysis.md) | PRoot-era sandbox env analysis (superseded; anchored: d020 references this path) |
| [docs/termux-serving.md](docs/termux-serving.md) | a50/Termux serving map, **archived** (anchored: d020/d021/d041 reference this path) |
| [docs/archive/](docs/archive/) | research findings + retired docs (peer-variant-work, mini-swe-agent, bwrap audit, endpoint rewiring, future-config-generator-system, …) — index inside |

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

## Cline and Thinkrail Integration

### Installation via Mise

Both Cline CLI and Thinkrail are now configured through mise for reliable, repeatable installation:

1. **Cline CLI**: `npm i -g cline`
   - Official AI development assistant CLI
   - Integrated with the coding agent environment

2. **Thinkrail.ai**: `curl -fsSL https://raw.githubusercontent.com/JetBrains/thinkrail/main/install.sh | bash`
   - JetBrains' development workflow enhancement
   - Works seamlessly with the containerized environment

### Container Configuration

The container's `config.toml` now includes:
```toml
"npm:cline" = "latest"
"npm:@jetbrains/thinkrail" = "latest"
```

### Usage

After running `coding-agent/run.sh`, you can:

```sh
# Use Cline CLI
cline

# Use Thinkrail
thinkrail
```

### Benefits

- **Reliable Installation**: Both tools are installed via mise, ensuring consistent versions
- **Container Isolation**: Tools are available within the coding agent container
- **Repeatable Setup**: Configuration ensures the same tools are available across different environments
- **No System Pollution**: Global system installation avoided - everything contained within the container

## License

AGPL-3.0.