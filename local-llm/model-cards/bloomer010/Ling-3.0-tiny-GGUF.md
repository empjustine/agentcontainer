---
license: mit
base_model:
  - inclusionAI/Ling-3.0-tiny
pipeline_tag: text-generation
library_name: llama.cpp
tags:
  - gguf
  - bailingmoe3
  - mixture-of-experts
  - conversational
---

# Ling-3.0-tiny GGUF

GGUF conversions of [inclusionAI/Ling-3.0-tiny](https://huggingface.co/inclusionAI/Ling-3.0-tiny),
converted directly from the released BF16 safetensors.

🔔 2026-08-21: added `reasoning_effort` support (low = thinking off, high = on, default same). 
If you want `reasoning_effort`, re-download or override with [chat_template.jinja](./chat_template.jinja). 

🎉 `bailingmoe3` (including the Q-LoRA attention path) is supported in stock llama.cpp since
[PR #26608](https://github.com/ggml-org/llama.cpp/pull/26608) (merged 2026-08-17, commit
`3733366720`). Any build from that commit onward loads these files directly:

```bash
llama-server -hf bloomer010/Ling-3.0-tiny-GGUF:Q4_K_M
```

## Files

For tiny models, precision is especially crucial.

*Generally...* 
Larger files = more precision.  
More compression = more slop and misbehavin'.

Use UD-Q8_K_XL for near-full precision performance. 

| Quant | Size | your memory |
| --- | ---: | --- |
| BF16 | 15.8 GB | 16 GB+ |
| UD-Q8_K_XL | 11.19 GB | 12 GB+ |
| Q8_0 | 8.41 GB | 10 GB+ |
| UD-Q6_K_XL | 7.27 GB | 8 GB+ |
| Q6_K | 6.50 GB | 8 GB+ |
| Q5_K_M | 5.64 GB | 7 GB+ |
| Q5_K_S | 5.48 GB | 6 GB+ |
| Q5_0 | 5.48 GB | 6 GB+ |
| Q4_K_M | 4.82 GB | 6 GB+ |
| Q4_K_S | 4.55 GB | 6 GB+ |
| Q4_0 | 4.53 GB | 6 GB+ |
| MXFP4_MOE | 4.72 GB | 6 GB+ ¹ |
| IQ4_XS | 4.29 GB | 5 GB+ |
| Q3_K_M | 3.84 GB | 5 GB+ |
| Q3_K_S | 3.51 GB | 5 GB+ |
| IQ3_S | 3.51 GB | 4 GB+ |
| IQ3_XXS | 3.13 GB | 4 GB+ |
| Q2_K | 2.99 GB | 4 GB+ |
| IQ2_M | 2.70 GB | 3 GB+ |
| IQ2_S | 2.48 GB | 3 GB+ |
| IQ2_XS | 2.43 GB | 3 GB+ |
| IQ2_XXS | 2.21 GB | 3 GB+ |
| IQ1_M | 1.93 GB | 3 GB+ |
| IQ1_S | 1.76 GB | 2 GB+ |
| Q1_0 | 1.30 GB | 2 GB+ |

¹ `MXFP4_MOE` runs its native path on MXFP4-capable GPUs (Blackwell RTX 50-series, GB10/DGX
Spark). Elsewhere it falls back to a slower dequant path — prefer a K-quant on older hardware.

## Importance Matrix

The IQ-quant rungs (`IQ1_S` through `IQ4_XS`) were generated with a model-specific importance
matrix:

- Wikitext-2 raw training text
- 100 chunks
- 512 tokens per chunk
- 51,200 calibration tokens total
- 332 matrix entries

## XL Quantization Recipes

`UD-Q8_K_XL` uses Q8_0 for the main expert gate and up tensors. Token embeddings, expert down
projections, attention and Q-LoRA projections, and KDA projections remain BF16.

`UD-Q6_K_XL` uses Q6_K for the main expert gate and up tensors. Token embeddings, output weights,
expert down projections, attention and Q-LoRA projections, and KDA projections use Q8_0. It was
generated with the importance matrix described above.

## Architecture

- 7.9B total parameters and 1.3B active parameters per token
- 24 layers: 18 KDA layers and 6 MLA layers
- 128 routed experts, 8 active per token, plus 1 shared expert
- Q-LoRA rank 256 and KV-LoRA rank 512
- 131,072-token context in the released configuration
- No bundled MTP block for this model (`num_nextn_predict_layers: 0`)

## Validation

- BF16 conversion completed with 526 tensors, including all 18 Q-LoRA tensors
- CPU and CUDA architecture tests passed
- BF16, Q8_0, Q6_K, Q4_K_M, and MXFP4_MOE loaded and generated tokens with CUDA
- Q1_0, IQ2_M, Q3_K_M, Q5_K_S, and Q5_K_M passed CPU-only prompt processing and token generation
  tests
- UD-Q6_K_XL and UD-Q8_K_XL passed CPU-only prompt processing and token generation tests
- IQ1_S, IQ1_M, IQ2_S, IQ2_XS, IQ2_XXS, IQ3_XXS, IQ3_S, IQ4_XS, Q2_K, Q3_K_S, Q4_K_S, Q4_0, and
  Q5_0 passed load and generation tests
- CUDA testing used an RTX 4070 and RTX 3060

## Build

```bash
git clone https://github.com/ggml-org/llama.cpp.git   # bailingmoe3 merged 2026-08-17
# pre-merge builds:
# git clone --branch bailingmoe3-support https://github.com/aetherbird/llama.cpp.git
cd llama.cpp
cmake -B build -DGGML_CUDA=ON
cmake --build build --config Release -j --target llama-cli llama-server
```

## Usage

```bash
./build/bin/llama-server \
  -m Ling-3.0-tiny-Q4_K_M.gguf \
  -c 131072 \
  -ngl auto \
  --flash-attn auto \
  --temp 1.0 --top-p 0.95 --top-k 20 \
  --jinja
```

Thinking is enabled by default; disable per request with
`"chat_template_kwargs": {"enable_thinking": false}`. Recommended sampling parameters from the
source model card are `temperature=1.0`, `top_p=0.95`, and `top_k=20`.
