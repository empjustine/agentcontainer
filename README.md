# agentcontainer

A minimal sandbox for [pi](https://github.com/earendil-works/pi) with 
support for local [llama.cpp](https://github.com/ggerganov/llama.cpp)
GGUF inference and cloud LLM peers proxied through
[llama-swap](https://github.com/mostlygeek/llama-swap).

## Quick start

```sh
# Bazzite (rootless podman) — ONE multipurpose llama-swap instance:
#   local GGUF inference + cloud peers, published on LAN port 8080
#   (the world reaches it via the tailscale FQDN reverse proxy)
cd ~/agentcontainer/openai-completions && ./generate.sh && ./run.sh
#   then the coding agent (uses local models + cloud via auth.json)
cd ~/agentcontainer/coding-agent && ./run.sh

# a50 / Termux (peers-only serving, native llama-swap binary — alt build/run
# of openai-completions/)
cd ~/agentcontainer/openai-completions && ./build.sh && ./run-native.sh
```

See [docs/environments-and-peer-variants.md](docs/environments-and-peer-variants.md)
for the full environment matrix.

## Folder layout

```
agentcontainer/
├── docs/                              # Design docs, environment guides, ADRs
│   ├── environments-and-peer-variants.md   # bazzite / a50 / work matrix
│   ├── container-tooling.md                # container-tool.sh, run scripts
│   ├── termux-serving.md                   # a50 / Termux map (detail lives in the code headers)
│   ├── d0XX-*.md                           # numbered design notes
│   └── ...
├── container-tool.sh                    # Shared sandbox-backend detection (podman/docker)
│
├── openai-completions/                   # Multipurpose llama-swap (one instance per host)
│   ├── run.sh                           #   → adapts image/port/GPU/HF to the generated config.d
│   ├── generate.sh                      #   → capability-gated config.d layers (local LLM / peers)
│   ├── gen-lib.mjs                      #   → shared generator helpers
│   ├── generate-general.yaml.mjs         #   → 00-general.yaml (globals + macros; always)
│   ├── generate-local-llm-models.yaml.mjs#   → 10-local-llm-inference.yaml (GGUF; GPU hosts only)
│   ├── generate-peer-cloud.yaml.mjs      #   → peer-cloud.yaml (cloud peers; opencode via models.dev catalog)
│   ├── refresh-models-dev.mjs           #   → atomic refresh of the vendored models.dev catalog
│   ├── models.dev.api.json              #   → vendored models.dev catalog (refreshed, never clobbered on failure)
│   ├── generate-gfx1030-models.mjs      #   → 22-peer-gfx1030.yaml (remote gfx1030 route; non-GPU hosts)
│   ├── launch-gguf.sh                   #   → HF-snapshot resolver (copied to config.d on GPU hosts)
│   ├── llamacpp-model-data.json         #   → canonical GGUF model definitions
│   ├── active-b.json                    #   → activeB table (model-id derivation)
│   ├── llama-swap-core.json             #   → general-purpose config source
│   ├── build.sh / run-native.sh         #   → Termux alt build/serve (peers-only); build.sh pre-pulls the image elsewhere
│   └── config.d/                        #   → generated split config (loaded via -config-dir)
│
├── coding-agent/                        # Bazzite usage (full pi)
│   ├── run.sh                           #   → launches pi coding-agent container
│   ├── auth.json                        #   → pi credentials (copied into container by run.sh)
│   ├── settings.json                    #   → static pi settings (copied by run.sh)
│   └── Containerfile                    #   → container image build
│
├── local-llm/                           # Local LLM / HF cache tooling
│   ├── run-all.sh                       #   → full pipeline in dependency order
│   ├── download_models.py               #   → provision served GGUFs into the HF cache
│   ├── upkeep.py                        #   → cache list/pull/prune/verify (uv run)
│   ├── fetch_hf_manifests.py            #   → refresh + audit repo:quant manifests
│   ├── fetch-model-cards.sh             #   → refresh model-card mirrors
│   ├── generate_vram_fit_tables.py      #   → VRAM/fit tables via gdevenyi/huggingface-estimate
│   └── model-cards/                     #   → GGUF model documentation
│   # huggingface/ + fetch-manifest/ archived → old/agentcontainer/local-llm/
│
└── old/                                 # Legacy generators (retired, for reference)
```

## Documentation index

| Doc | Covers |
|-----|--------|
| [docs/environments-and-peer-variants.md](docs/environments-and-peer-variants.md) | Environment matrix (bazzite/a50/work), env vars, serving/usage dirs |
| [docs/architecture.md](docs/architecture.md) | Self-contained runners vs base config generators, standalone rule |
| [docs/future-config-generator-system.md](docs/future-config-generator-system.md) | NEXT-step (PENDING) config-generator system split by concern |
| [docs/container-tooling.md](docs/container-tooling.md) | container-tool.sh, run scripts, UID/SELinux, PEERS_ONLY |
| [docs/termux-serving.md](docs/termux-serving.md) | a50/Termux native build — map; the build/serve/env detail lives in the `openai-completions/` script headers |
| [docs/d018-split-config-d.md](docs/d018-split-config-d.md) | split `config.d/` layout + llama-swap merge contract |
| [docs/d020-libvirt-qemu-sandbox.md](docs/d020-libvirt-qemu-sandbox.md) | qemu/libvirt VM sandboxes — requirements assessment (not implemented) |
| [coding-agent/merge-models-json.mjs](coding-agent/merge-models-json.mjs) | layered pi `models.json` (base + `model-*.json` overlays) — contract is documented in the script header |
| [docs/peer-variant-work.md](docs/peer-variant-work.md) | coding-agent-peer (work environment; **archived** — folded into coding-agent) |
| [docs/scoped-models-and-proxy-overrides.md](docs/scoped-models-and-proxy-overrides.md) | pi models.json / settings.json scoping |
| [docs/gguf-model-tooling.md](docs/gguf-model-tooling.md) | GGUF tooling (`fetch_hf_manifests.py` live; size-estimation tools archived) |
| [docs/gguf-vram-fit-estimates.md](docs/gguf-vram-fit-estimates.md) | VRAM/KV/fit tables for all served models (gdevenyi/huggingface-estimate) |



| Model | Path | Status | Content-Type | Cached | Prompt | Generated | Drafted | Prefill | Decode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 03b-ctx128-LiquidAI/LFM2.5-2.6B-GGUF:Q8_0 | /v1/chat/completions | 200 | text/event-stream | - | 130 | 1.024 | - | 652.74 t/s | 116.28 t/s |
| 03b-ctx128-LiquidAI/LFM2.5-2.6B-GGUF:Q6_K | /v1/chat/completions | 200 | text/event-stream | - | 130 | 1.024 | - | 625.08 t/s | 138.52 t/s |
| 03b-ctx128-LiquidAI/LFM2.5-2.6B-GGUF:Q4_0 | /v1/chat/completions | 200 | text/event-stream | - | 130 | 1.024 | - | 598.40 t/s | 161.00 t/s |
| 03b-ctx128-LiquidAI/LFM2.5-2.6B-GGUF:QAD-Q4_0 | /v1/chat/completions | 200 | text/event-stream | - | 130 | 1.024 | - | 571.30 t/s | 156.60 t/s |
| 03b-ctx128-LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M | /v1/chat/completions | 200 | text/event-stream | - | 130 | 1.024 | - | 538.08 t/s | 158.36 t/s |
| 02b-ctx128-unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL | /v1/chat/completions | 200 | text/event-stream | - | 155 | 1.024 | - | 512.15 t/s | 142.29 t/s |
| 03b-ctx128-LiquidAI/LFM2.5-2.6B-GGUF:Q5_K_M | /v1/chat/completions | 200 | text/event-stream | - | 130 | 1.024 | - | 509.36 t/s | 143.50 t/s |
| 03b-ctx128-LiquidAI/LFM2.5-2.6B-GGUF:F16 | /v1/chat/completions | 200 | text/event-stream | - | 130 | 1.024 | - | 385.29 t/s | 55.56 t/s |
| 01b-ctx125-unsloth/LFM2.5-8B-A1B-GGUF:Q8_0 | /v1/chat/completions | 200 | text/event-stream | - | 129 | 1.024 | - | 364.36 t/s | 150.36 t/s |
| 01b-ctx125-unsloth/LFM2.5-8B-A1B-GGUF:UD-Q8_K_XL | /v1/chat/completions | 200 | text/event-stream | - | 129 | 1.024 | - | 325.72 t/s | 131.67 t/s |
| 03b-ctx128-LiquidAI/LFM2.5-2.6B-GGUF:BF16 | /v1/chat/completions | 200 | text/event-stream | - | 130 | 1.024 | - | 300.65 t/s | 51.68 t/s |
| 01b-ctx128-bartowski/Ling-3.0-tiny-GGUF:Q8_0 | /v1/chat/completions | 200 | text/event-stream | - | 161 | 1.024 | - | 225.69 t/s | 126.55 t/s |
| 02b-ctx128-unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q2_K_XL | /v1/chat/completions | 200 | text/event-stream | - | 155 | 1.024 | - | 187.24 t/s | 161.38 t/s |
| 01b-ctx128-bloomer010/Ling-3.0-tiny-GGUF:UD-Q8_K_XL | /v1/chat/completions | 200 | text/event-stream | - | 161 | 1.024 | - | 149.16 t/s | 77.32 t/s |
| 03b-ctx128-poolside/Laguna-XS-2.1-GGUF:Q4_K_M | /v1/chat/completions | 200 | text/event-stream | - | 180 | 1.024 | - | 47.96 t/s | 30.30 t/s |
| 03b-ctx064-unsloth/GLM-4.7-Flash-GGUF:Q6_K | /v1/chat/completions | 200 | text/event-stream | - | 124 | 1.024 | - | 29.24 t/s | 19.38 t/s |
| 03b-ctx064-unsloth/GLM-4.7-Flash-GGUF:UD-Q6_K_XL | /v1/chat/completions | 200 | text/event-stream | - | 124 | 1.024 | - | 27.99 t/s | 18.78 t/s |
| 03b-ctx064-unsloth/GLM-4.7-Flash-GGUF:Q8_0 | /v1/chat/completions | 200 | text/event-stream | - | 124 | 1.024 | - | 19.78 t/s | 15.58 t/s |
| 03b-ctx064-unsloth/GLM-4.7-Flash-GGUF:UD-Q8_K_XL | /v1/chat/completions | 200 | text/event-stream | - | 124 | 1.024 | - | 16.43 t/s | 11.76 t/s |
| 27b-ctx064-byteshape/Qwen3.8-27B-GGUF:IQ3_S-3.44bpw | /v1/chat/completions | 200 | text/event-stream | - | 20 | 256 | - | 14.07 t/s | 12.90 t/s |
| 27b-ctx064-byteshape/Qwen3.8-27B-GGUF:IQ4_XS-3.67bpw | /v1/chat/completions | 200 | text/event-stream | - | 20 | 256 | - | 12.76 t/s | 10.74 t/s |
| 27b-ctx064-byteshape/Qwen3.8-27B-GGUF:IQ4_XS-4.00bpw | /v1/chat/completions | 200 | text/event-stream | - | 20 | 245 | - | 10.69 t/s | 7.69 t/s |
| 27b-ctx064-byteshape/Qwen3.8-27B-GGUF:IQ4_XS-4.40bpw | /v1/chat/completions | 200 | text/event-stream | - | 20 | 228 | - | 10.19 t/s | 6.01 t/s |
| 27b-ctx064-byteshape/Qwen3.8-27B-GGUF:Q5_K_S-4.72bpw | /v1/chat/completions | 200 | text/event-stream | - | 20 | 256 | - | 9.56 t/s | 5.64 t/s |
| 27b-ctx064-unsloth/Qwen3.8-27B-GGUF:Q4_K_M | /v1/chat/completions | 200 | text/event-stream | - | 20 | 256 | - | 11.86 t/s | 5.44 t/s |
| 27b-ctx064-unsloth/Qwen3.6-27B-GGUF:Q4_K_M | /v1/chat/completions | 200 | text/event-stream | - | 20 | 256 | - | 15.66 t/s | 4.84 t/s |
| 27b-ctx064-byteshape/Qwen3.8-27B-GGUF:Q5_K_M-5.60bpw | /v1/chat/completions | 200 | text/event-stream | - | 20 | 229 | - | 10.02 t/s | 3.54 t/s |

Exported from [llama-swap](https://github.com/mostlygeek/llama-swap) at 2026-08-30 14:59:02

## License

AGPL-3.0.

