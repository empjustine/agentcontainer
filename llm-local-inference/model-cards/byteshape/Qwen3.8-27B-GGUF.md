---
library_name: transformers
license: apache-2.0
license_link: https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/LICENSE
pipeline_tag: image-text-to-text
base_model:
- Qwen/Qwen3.8-27B
tags:
- qwen3.8
- byteshape
- shapelearn
---

# Qwen3.8-27B GGUF (ShapeLearn-Lite Quantized)

This is a GGUF-quantized version of Qwen3.8-27B produced with **ShapeLearn-Lite**, a faster variant of ByteShape's ShapeLearn algorithm that learns the datatype for each tensor. With our current compute allocation, ShapeLearn-Lite enabled us to make high-quality quantizations available shortly after the model's release.

This initial release was validated through targeted spot checks rather than our full multi-benchmark evaluation suite.

- The two largest variants, at 5.60 and 4.72 bits per weight, are expected to retain baseline quality comparable to the original BF16 model.
- The smaller variants trade some quality for meaningful reductions in memory use and improvements in speed, providing a practical range of size–quality options.

Questions and feedback are welcome here and on our [Reddit](https://www.reddit.com/r/ByteShape/).

## Quick Start

Pick a model from the table below and click **Get llama.cpp command** to get a ready-to-run command with all the correct sampling parameters for this model.

You can also copy the **Model Tag** from the table and use it directly:

| Tool | Command |
|------|---------|
| **llama.cpp** | `llama-server -hf <MODEL_TAG> --mmproj-auto` |

This is a **vision capable** model. llama.cpp auto-downloads the model and vision projector on first run.

Once you run the llama-server, you can access the web interface at `http://localhost:<PORT>`.

### Multi-Token Prediction (up to 2× faster)

These GGUFs ship with Qwen3.8's **MTP (multi-token prediction) head embedded**, so llama.cpp can use the model as its own speculative draft, with no separate draft model needed. Add:

```
--spec-type draft-mtp --spec-draft-n-max 3
```

to the `llama-server` command and decode speed roughly **doubles** (see the TPS columns below). The **Get llama.cpp command** links enable MTP by default; set the draft-tokens field to 0 to disable it.

## How to Pick a Model

All models in this release are **GPU-optimized**. The table is sorted by model size; throughput was measured on an **RTX PRO 6000 Blackwell** (single stream, llama.cpp b10430).

**Selection rule:** Choose the largest model that fits your VRAM budget (leave room for context), or the fastest one that still meets your required quality.

| Model ID | Bits/Weight | Model Size | TPS | TPS with MTP | Use This Model | Model Tag |
|---------|-------------|-----------|-----|--------------|-----|-----------|
| [GPU-1](https://huggingface.co/byteshape/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-IQ3_S-3.44bpw.gguf) | 3.44 | 11.8 GB | 94 | 167 | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ3_S-3.44bpw&platform=llamacpp) | `byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ3_S-3.44bpw` |
| [GPU-2](https://huggingface.co/byteshape/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-IQ4_XS-3.67bpw.gguf) | 3.67 | 12.6 GB | 90 | 166 | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ4_XS-3.67bpw&platform=llamacpp) | `byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ4_XS-3.67bpw` |
| [GPU-3](https://huggingface.co/byteshape/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-IQ4_XS-4.00bpw.gguf) | 4.00 | 13.7 GB | 86 | 165 | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ4_XS-4.00bpw&platform=llamacpp) | `byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ4_XS-4.00bpw` |
| [GPU-4](https://huggingface.co/byteshape/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-IQ4_XS-4.40bpw.gguf) | 4.40 | 15.0 GB | 81 | 162 | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ4_XS-4.40bpw&platform=llamacpp) | `byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ4_XS-4.40bpw` |
| [GPU-5](https://huggingface.co/byteshape/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-Q5_K_S-4.72bpw.gguf) | 4.72 | 16.1 GB | 77 | 152 | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-Q5_K_S-4.72bpw&platform=llamacpp) | `byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-Q5_K_S-4.72bpw` |
| [GPU-6](https://huggingface.co/byteshape/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-Q5_K_M-5.60bpw.gguf) | 5.60 | 19.1 GB | 68 | 139 | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-Q5_K_M-5.60bpw&platform=llamacpp) | `byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-Q5_K_M-5.60bpw` |

*TPS = tokens per second generating a 2K-token response, single stream. "TPS with MTP" adds `--spec-type draft-mtp --spec-draft-n-max 3`. Expect the MTP speedup to vary a little with sampling settings and workload.*

**Quality expectations:** **GPU-6** and **GPU-5** are expected to match the BF16 baseline. From **GPU-4** down, quality gradually decreases with size, but each model remains a strong pick at its memory budget.

## Recommended Sampling Parameters

Qwen3.8 has **thinking mode on by default**; add `--reasoning off` for instruct (non-thinking) behavior. Following the official model card:

| Mode | temperature | top_p | top_k | min_p | presence_penalty |
|------|-------------|-------|-------|-------|------------------|
| Thinking (default) | 1.0 | 0.95 | 20 | 0.0 | 0.0 |
| Instruct (`--reasoning off`) | 0.7 | 0.80 | 20 | 0.0 | 1.5 |

The **Get llama.cpp command** links above emit these automatically.

## Notes on quantization labels

The labels you see (for example `IQ4_XS`) are only there to make Hugging Face show our models in the GGUF table. We do not use the conventional quantization profiles as defined in llama.cpp. In our case, these labels indicate the closest size class and average bit length. All models in this release use a hybrid mix of quantization techniques chosen per tensor by ShapeLearn-Lite, which is why several models share a tag and why models above 4.5 bits/weight carry K-quant labels.
