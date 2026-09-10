# agentcontainer - Enhanced with Cline and Thinkrail

A minimal sandbox for [pi](https://github.com/earendil-works/pi) with
support for local [llama.cpp](https://github.com/ggerganov/llama.cpp)
GGUF inference and cloud LLM peers proxied through
[llama-swap](https://github.com/mostlygeek/llama-swap).

## Quick start

```sh
# Bazzite (rootless podman) — ONE multipurpose llama-swap instance:
#   local GGUF inference + cloud peers, published on LAN port 8080
#   (the world reaches it via the tailscale FQDN reverse proxy)
cd ~/agentcontainer/llm-reverse-proxy && ./generate.sh && ./run.sh
#   then the coding agent (uses local models + cloud via auth.json)
cd ~/agentcontainer/coding-agent && ./run.sh

# a50 / Termux (peers-only serving, native llama-swap binary — alt build/run
# of llm-reverse-proxy/)
cd ~/agentcontainer/llm-reverse-proxy && ./build.sh && ./run-native.sh
```

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
├── docs/                              # Design docs, environment guides, ADRs
│   ├── environments-and-peer-variants.md   # bazzite / a50 / work matrix
│   ├── container-tooling.md                # lib/workload-runtime.sh, run scripts
│   ├── termux-serving.md                   # a50 / Termux map (detail lives in the code headers)
│   ├── d0XX-*.md                           # numbered design notes
│   └── ...
├── lib/                               # Shared infrastructure (docs/architecture.md)
│   ├── workload-runtime.sh             #   → sandbox-backend detection + workload_* API
│   ├── llamacpp-model-data.json        #   → canonical GGUF model definitions (shared with local-llm/)
│   ├── models.dev.api.json             #   → vendored models.dev catalog (shared)
│   ├── cloud-providers.mjs             #   → the one cloud-provider fact table
│   ├── refresh-models-dev.mjs          #   → atomic catalog refresh (both generate.sh)
│   └── workload-*.jq                   #   → jq filters behind the workload_* API
│
├── llm-reverse-proxy/                   # Multipurpose llama-swap (one instance per host)
│   ├── run.sh                           #   → adapts image/port/GPU/HF to the generated config.d
│   ├── generate.sh                      #   → capability-gated config.d layers (local LLM / peers)
│   ├── gen-lib.mjs                      #   → shared generator helpers
│   ├── generate-general.yaml.mjs         #   → 00-general.yaml (globals + macros; always)
│   ├── generate-local-llm-models.yaml.mjs#   → 10-local-llm-inference.yaml (GGUF; GPU hosts only)
│   ├── generate-peer-cloud.yaml.mjs      #   → peer-cloud.yaml (cloud peers; opencode via models.dev catalog)
│   ├── generate-gfx1030-models.mjs      #   → 22-peer-gfx1030.yaml (remote gfx1030 route; non-GPU hosts)
│   ├── launch-gguf.sh                   #   → HF-snapshot resolver (copied to config.d on GPU hosts)
│   ├── active-b.json                    #   → activeB table (model-id derivation)
│   ├── llama-swap-core.json             #   → general-purpose config source
│   ├── build.sh / run-native.sh         #   → Termux alt build/serve (peers-only); build.sh pre-pulls the image elsewhere
│   └── config.d/                        #   → generated split config (loaded via -config-dir)
│
├── coding-agent/                        # Bazzite usage (full pi)
│   ├── run.sh                           #   → launches pi coding-agent container
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
| [coding-agent/merge-models-json.mjs](coding-agent/merge-models-json.mjs) | layered pi `models.json` (base + `model-*.json` overlays) — contract is documented in the script header |
| [docs/peer-variant-work.md](docs/peer-variant-work.md) | coding-agent-peer (work environment; **archived** — folded into coding-agent) |
| [docs/scoped-models-and-proxy-overrides.md](docs/scoped-models-and-proxy-overrides.md) | pi models.json / settings.json scoping |
| [docs/gguf-model-tooling.md](docs/gguf-model-tooling.md) | GGUF tooling (`fetch_hf_manifests.py` live; size-estimation tools archived) |
| [docs/gguf-vram-fit-estimates.md](docs/gguf-vram-fit-estimates.md) | VRAM/KV/fit tables for all served models (gdevenyi/huggingface-estimate) |

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