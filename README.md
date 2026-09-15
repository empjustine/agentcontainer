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
#   then the coding agent (uses local models + cloud via auth.json)
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
the ONE infisical vault round-trip, on the host, then `exec` of the target):
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

```
agentcontainer/
├── generate.sh / generate.mjs          # → run EVERY folder's generator in sequence (d041)
├── build.sh / build.mjs                # → build everything for THIS host (images ∥; termux serialized)
├── docs/                              # Design docs, environment guides, ADRs
│   ├── environments-and-peer-variants.md   # bazzite / a50 / work matrix
│   ├── container-tooling.md                # lib/workload-runtime.sh, run scripts
│   ├── termux-serving.md                   # a50 / Termux map (detail lives in the code headers)
│   ├── d0XX-*.md                           # numbered design notes
│   └── ...
├── lib/                               # Shared infrastructure (docs/architecture.md)
│   ├── workload-runtime.sh             #   → sandbox-backend detection + workload_* API
│   ├── node-run.sh                     #   → standalone node_run() (pinned node; termux-aware)
│   ├── go-build.mjs                    #   → go toolchain probe + android/host flag presets (d041)
│   ├── provision-termux.sh             #   → termux pkg/infisical provisioning (the former root build.sh)
│   ├── llamacpp-model-data.json        #   → canonical GGUF model definitions (shared with local-llm/)
│   ├── models.dev.api.json             #   → vendored models.dev catalog (coding-agent + llm-reverse-proxy)
│   ├── catwalk-facts.json              #   → vendored catwalk catalog (coding-agent + llm-reverse-proxy)
│   ├── cloud-providers.mjs             #   → the one cloud-provider fact table
│   ├── log.mjs / artifact.mjs / log.sh #   → shared logger/artifact std (all generators + shell)
│   ├── environment.sh                   #   → EXPLICIT env chain: infisical vault → exec <script>
│   ├── workload-*.jq                   #   → jq filters behind the workload_* API
│
├── llm-local-inference/                   # llama-swap: LOCAL GGUF inference only
│   ├── run.sh                           #   → unified-vulkan image + GPU + HF mounts on :8101
│   ├── generate.sh / generate.mjs       #   → capability-gated config.d layers (fails on non-GPU hosts)
│   ├── active-b.json                    #   → activeB table (model-id derivation)
│   ├── llama-swap-core.json             #   → general-purpose config source
│   └── config.d/                        #   → generated split config (loaded via -config-dir)
│
├── llm-reverse-proxy/                   # Raw passthrough reverse proxy for cloud LLMs (Go)
│   ├── main.go                          #   → http host:port/{provider}/<path> → <base-url>/<path>, streaming as-is
│   ├── llm-reverse-proxy.example.json   #   → provider slug → base URL map (the whole config surface)
│   ├── generate.sh / generate.mjs       #   → routing table from lib/cloud-providers.mjs (d038 catalog)
│   ├── smoke-test.sh                    #   → 32 behavioural checks against the built binary/image
│   └── README.md                        #   → RFC 9457 502 error taxonomy, deviations
│
├── coding-agent/                        # Bazzite usage (full pi)
│   ├── run.sh                           #   → launches pi coding-agent container (exec through ../lib/environment.sh)
│   ├── generate.sh / generate.mjs       #   → orchestrates the stage generators below (d041)
│   ├── gen-lib.mjs                      #   → shared generator preamble (pi shaping folded in, d039)
│   ├── peer-probe.mjs                   #   → HTTP probe toolkit (folded out of lib/, d039)
│   ├── hyper-facts.mjs / hyper-facts.json # → Charm Hyper facts cache + enricher (d039)
│   ├── catwalk-facts.mjs                #   → catwalk catalog refresher (cache stays in lib/, d039)
│   ├── refresh-models-dev.mjs           #   → atomic models.dev catalog refresh (d039)
│   ├── generate-cloud-providers.mjs     #   → cloud layers (table-driven, d037; cline-pass lineup d040)
│   ├── auth.json                        #   → pi credentials (copied into container by run.sh)
│   ├── settings.json                    #   → static pi settings (copied by run.sh)
│   ├── config.toml                       #   → mise configuration (includes cline and thinkrail)
│   └── Containerfile                    #   → container image build
│
├── local-llm/                           # Local LLM / HF cache tooling
│   ├── run-all.sh                       #   → full pipeline in dependency order
│   ├── download_models.py               #   → provision served GGUFs into the HF cache
│   ├── upkeep.py                        #   → cache list/pull/prune/verify (uv run)
│   ├── fetch_hf_manifests.py            #   → refresh + audit repo:quant manifests
│   ├── fetch-model-cards.sh             #   → refresh model-card mirrors
│   ├── generate_vram_fit_tables.py      #   → VRAM/KV/fit tables via gdevenyi/huggingface-estimate
│   └── model-cards/                     #   → GGUF model documentation
```

## Documentation index

| Doc | Covers |
|-----|--------|
| [docs/environments-and-peer-variants.md](docs/environments-and-peer-variants.md) | Environment matrix (bazzite/a50/work), env vars, serving/usage dirs |
| [docs/architecture.md](docs/architecture.md) | Self-contained runners vs base config generators, standalone rule |
| [docs/future-config-generator-system.md](docs/future-config-generator-system.md) | NEXT-step (PENDING) config-generator system split by concern |
| [docs/container-tooling.md](docs/container-tooling.md) | lib/workload-runtime.sh, run scripts, UID/SELinux, PEERS_ONLY |
| [docs/termux-serving.md](docs/termux-serving.md) | a50/Termux native build — map; the build/serve/env detail lives in the code headers |
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
| [docs/d037-generator-merge-verdict.md](docs/d037-generator-merge-verdict.md) | SIMPLE.md merge claim verdict — cloud generators unify into one table-driven generator, the rest stay split (d030 option 6) |
| [docs/d038-proxy-full-provider-catalog.md](docs/d038-proxy-full-provider-catalog.md) | llm-reverse-proxy routes the full pi-ai ∪ models.dev ∪ catwalk provider catalog (priority pi-ai > models.dev > catwalk) |
| [docs/d039-fold-single-consumer-lib-modules.md](docs/d039-fold-single-consumer-lib-modules.md) | single-consumer lib/ modules fold back to their owning runner (peer-probe/pi-models/hyper-facts/catwalk-facts.mjs/refresh-models-dev → coding-agent; pi-ai + ai-sdk tables → generate-config) |
| [docs/d040-cline-pass-curated-lineup.md](docs/d040-cline-pass-curated-lineup.md) | cline-pass lineup is the published 13-model ClinePass table, not Cline's /models catalog (live sync disabled for it) |
| [docs/d041-unified-generate-build-entrypoints.md](docs/d041-unified-generate-build-entrypoints.md) | root `generate.mjs`/`build.mjs` unified entrypoints, `lib/node-run.sh` + `lib/go-build.mjs`, runners never build/generate |
| [docs/termux-build-audit.md](docs/termux-build-audit.md) | Termux build audit — Infisical CLI `go install` impossibility + llm-reverse-proxy native build verification |
| [coding-agent/merge-models-json.mjs](coding-agent/merge-models-json.mjs) | layered pi `models.json` (base + `model-*.json` overlays) — contract is documented in the script header |
| [docs/peer-variant-work.md](docs/peer-variant-work.md) | coding-agent-peer (work environment; **archived** — folded into coding-agent; routing/env superseded by d027 + the vault — see its banner) |
| [docs/scoped-models-and-proxy-overrides.md](docs/scoped-models-and-proxy-overrides.md) | pi models.json / settings.json scoping |
| [docs/gguf-model-tooling.md](docs/gguf-model-tooling.md) | GGUF tooling (`fetch_hf_manifests.py` live; size-estimation tools archived) |
| [docs/gguf-vram-fit-estimates.md](docs/gguf-vram-fit-estimates.md) | VRAM/KV/fit tables for all served models (gdevenyi/huggingface-estimate) |

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