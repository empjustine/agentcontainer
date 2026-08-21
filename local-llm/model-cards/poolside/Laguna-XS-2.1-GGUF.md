---
library_name: transformers
inference: false
extra_gated_description: To learn more about how we process your personal data, please
  read our <a href="https://poolside.ai/legal/privacy">Privacy Policy</a>.
tags:
- laguna-xs-2.1
- gguf
- llama.cpp
license: openmdw-1.1
pipeline_tag: text-generation
base_model_relation: quantized
base_model:
- poolside/Laguna-XS-2.1
---

<p align="center">
  <img alt="poolside-banner" src="https://poolside.ai/assets/laguna/laguna-xs2-1-banner.svg" width="800px">
</p>

<p align="center">
  <a href="https://openrouter.ai/poolside/laguna-xs-2.1"><strong>Use on OpenRouter</strong></a> ·
  <a href="https://poolside.ai/blog/introducing-laguna-xs-2-1"><strong>Release blog post</strong></a> ·
  <a href="https://huggingface.co/collections/poolside/laguna-xs-21"><strong>Laguna XS 2.1 collection</strong></a>
</p>

<br>

# Laguna XS 2.1

Laguna XS 2.1 is a 33B total parameter Mixture-of-Experts model with 3B activated parameters per token designed for agentic coding and long-horizon work on a local machine. This model is an upgraded version of our [Laguna XS.2](https://huggingface.co/poolside/Laguna-XS.2) model with a +5.4% jump on SWE-bench Multilingual as well as stronger performance on terminal-style tasks.

> [!NOTE]
> This repository contains official GGUF conversions from our [standard format release](https://huggingface.co/poolside/Laguna-XS-2.1) built for llama.cpp (and compatible with vLLM and SGLang). To use with [Ollama](https://ollama.com/library/laguna-xs-2.1), pull directly with `ollama pull laguna-xs-2.1`.
>
> llama.cpp support is not yet upstreamed. See below.

## Highlights
- **Mixed SWA and global attention layout**: Laguna XS 2.1 uses sigmoid gating with per-layer rotary scales, enabling mixed SWA (Sliding Window Attention) and global attention layers in a 3:1 ratio (across 40 total layers)
- **KV cache in FP8**: KV cache quantized to FP8, reducing memory per token
- **Native reasoning support**: Interleaved thinking between tool calls with support for enabling and disabling thinking per-request
- **Local-ready**: At 33B total parameters and 3B activated, Laguna XS 2.1 is compact enough to run on a Mac with 36 GB of RAM. Available on [Ollama](https://ollama.com/library/laguna-xs-2.1) and [llama.cpp](https://github.com/ggml-org/llama.cpp/pull/25165). High-quality FP8, NVFP4 and INT4 quantized variants available ([see the collection](https://huggingface.co/collections/poolside/laguna-xs-21))
- **OpenMDW-1.1 license**: Use and modify the model and associated materials freely for commercial and non-commercial purposes ([learn more about OpenMDW](https://openmdw.ai/))

---

## Model overview

- Training: pre-training, post-training and reinforcement learning stages
- Number of parameters: 33B total with 3B activated per token
- Optimizer: Muon
- Layers: 40 layers (10 layers with global attention, 30 layers with sliding window attention)
- Experts: 256 experts with 1 shared expert
- Sliding Window: 512 tokens
- Modality: text-to-text
- Context window: 262,144 tokens
- Reasoning support: interleaved thinking with preserved thinking

## Files

| File | Quant | Size |
|------|-------|------|
| `Laguna-XS-2.1-BF16.gguf` | BF16 (full precision) | 66.9 GB |
| `Laguna-XS-2.1-Q4_K_M.gguf` | Q4_K_M | 20.3 GB |

`Q4_K_M` is the recommended default for local use. Use `BF16` if you want a reference full-precision baseline or intend to produce your own quantizations.

## llama.cpp

> [!NOTE]
> Laguna XS 2.1 support is **not yet in upstream llama.cpp**. Until it lands, build llama.cpp from the PR that adds Laguna XS 2.1 support ([ggml-org/llama.cpp#25165](https://github.com/ggml-org/llama.cpp/pull/25165)).

```shell
# Build llama.cpp from the PR branch
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
git fetch origin pull/25165/head:laguna && git checkout laguna
cmake -B build && cmake --build build -j

# Download a GGUF
huggingface-cli download poolside/Laguna-XS-2.1-GGUF \
  Laguna-XS-2.1-Q4_K_M.gguf --local-dir ~/models/Laguna-XS-2.1-GGUF
```

Serve an OpenAI-compatible endpoint with `llama-server`:

```shell
./build/bin/llama-server \
  -m ~/models/Laguna-XS-2.1-GGUF/Laguna-XS-2.1-Q4_K_M.gguf \
  --jinja \
  -ngl 99 \
  -c 32768 \
  --port 8000
```

- `--jinja` applies the model's built-in chat template (reasoning and tool-calling).
- `-ngl 99` offloads all layers to the GPU (CUDA). Drop or lower it for CPU-only.
- `-c` sets the context length; the model supports up to 262,144 tokens, but a
  bounded value (e.g. `32768`) keeps KV-cache memory reasonable on local machines.

> [!NOTE]
> **macOS (Metal) users**: the same recipe works on Apple Silicon via the Metal backend. Enable flash attention (`-fa on`) for lower memory use and better throughput.

## License

This model is licensed under the [OpenMDW-1.1 License](https://huggingface.co/poolside/Laguna-XS-2.1-GGUF/blob/main/LICENSE.md).

## Intended and Responsible Use

Laguna XS 2.1 is designed for software engineering and agentic coding use cases, and you are responsible for confirming that it is appropriate for your intended application. Laguna XS 2.1 is subject to the [OpenMDW-1.1 License](https://huggingface.co/poolside/Laguna-XS-2.1-GGUF/blob/main/LICENSE.md), and should be used consistently with Poolside's [Acceptable Use Policy](https://poolside.ai/legal/acceptable-use-policy). We advise against circumventing Laguna XS 2.1 safety guardrails without implementing substantially equivalent mitigations appropriate for your use case.

Please report security vulnerabilities or safety concerns to [security@poolside.ai](mailto:security@poolside.ai).