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
- mtp
- dflash
- agentic
---

# Qwen3.8-27B GGUF (ShapeLearn Quantized)

This is a GGUF-quantized version of Qwen3.8-27B produced with **ByteShape's ShapeLearn**, which learns the optimal datatype per tensor to maintain high quality even at very low bitlengths.

This release replaces our earlier ShapeLearn-Lite quantizations of Qwen3.8-27B. Every model here has been through our **full multi-benchmark evaluation suite**, covering math, coding, general knowledge, instruction following and agentic tool use in both thinking and instruct modes, scored against the BF16 baseline.

To learn more about ShapeLearn and to see detailed benchmarks across GPUs, please visit our [blog](https://byteshape.com/blogs/Qwen3.8-27B/).

If you have questions or want to share feedback, reach us on [Reddit](https://www.reddit.com/r/ByteShape/).

## Quick Start

Pick a model from the table below and click **Get llama.cpp command** to get a ready-to-run command with all the correct sampling parameters for this model.

You can also copy the **Model Tag** from the table and use it directly:

| Tool | Command |
|------|---------|
| **llama.cpp** | `llama-server -hf <MODEL_TAG> --mmproj-auto --spec-type draft-mtp --spec-draft-n-max 3` |

This is a **vision capable** model. llama.cpp auto-downloads the model and vision projector on first run.

The MTP head is bundled inside the GGUF, so no separate draft model is required. Just pass `--spec-type draft-mtp` to enable MTP-based speculative decoding. `--spec-draft-n-max` controls how many tokens are drafted per step (see [Speculative Decoding](#speculative-decoding) below for tuning guidance and for DFlash2).

> **Build requirement:** DFlash 2 needs a llama.cpp build of **b10658 (2026-08-27) or newer**, the release where DFlash2 support landed. `draft-mtp` has been available for much longer, so any b10658+ build covers both. Check with `llama-server --help | grep spec-type`; if `draft-dflash` is missing, update from the [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases).

Once you run the llama-server, you can access the web interface at `http://localhost:<PORT>`.

## How to Pick a Model

All models in this release are **GPU-optimized**, using a hybrid mix of quantization techniques chosen per tensor by ShapeLearn. Each model covers a different size and quality tradeoff.

The chart below plots **quality versus tokens per second (TPS)** on an **RTX 5090**. Quality is the average score relative to BF16 across our benchmark suite:

- **Instruct:** GSM8K (math), IFEval (instruction following), MMLU (general knowledge), LiveCodeBench V6 (coding), Multi-IF (multi-turn and multilingual instruction following) and ACEBench (tool use and agentic tasks).
- **Thinking:** ACEBench (tool use and agentic tasks), Multiple HumanEval (coding) and BFCL V4 (tool calling and agentic tasks).

TPS is single-stream decoding speed with plain next-token prediction; speculative decoding (see below) adds another 1.4–1.8x on top. The numbered orange bubbles are the five models in this release (**1 = GPU-1 … 5 = GPU-5**); the lettered bubbles are other publicly available GGUF quantizations of Qwen3.8-27B measured under the same conditions. Bubble size scales with bits per weight.

![RTX 5090: quality vs. TPS](img/RTX5090.png)

Interactive plots for RTX 4090, 4080, 5060 Ti, 5090, 3090 and RTX PRO 6000 Blackwell, with per-model details on hover, are available on our [blog](https://byteshape.com/blogs/Qwen3.8-27B/).

**Table sorted by model size** (match the chart numbers to model IDs):

| Model ID | Bits/Weight | Model Size | Use This Model | Model Tag |
|---------|-------------|-----------|-----|-----------|
| [GPU-1](https://huggingface.co/byteshape/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-IQ2_XXS-2.56bpw.gguf) | 2.56 | 8.8 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ2_XXS-2.56bpw&platform=llamacpp) | `byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ2_XXS-2.56bpw` |
| [GPU-2](https://huggingface.co/byteshape/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-IQ3_XXS-2.88bpw.gguf) | 2.88 | 9.9 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ3_XXS-2.88bpw&platform=llamacpp) | `byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ3_XXS-2.88bpw` |
| [GPU-3](https://huggingface.co/byteshape/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-IQ3_XS-3.01bpw.gguf) | 3.01 | 10.4 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ3_XS-3.01bpw&platform=llamacpp) | `byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ3_XS-3.01bpw` |
| [GPU-4](https://huggingface.co/byteshape/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-IQ3_S-3.23bpw.gguf) | 3.23 | 11.0 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ3_S-3.23bpw&platform=llamacpp) | `byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ3_S-3.23bpw` |
| [GPU-5](https://huggingface.co/byteshape/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-IQ4_XS-3.84bpw.gguf) | 3.84 | 13.1 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ4_XS-3.84bpw&platform=llamacpp) | `byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ4_XS-3.84bpw` |

**Selection rule:** Choose the largest model that fits your VRAM budget (leave room for context and, if you use it, ~1.2 GB for the DFlash2 draft), or the fastest one that still meets your required quality.

## Speculative Decoding

In speculative decoding, a small draft model guesses what the next few tokens might be, and the main model then verifies those guesses in a single pass instead of generating them one at a time. The draft can be embedded in the GGUF file you download (MTP) or be a separate external model (DFlash 2).

### MTP: embedded, no extra download

```
--spec-type draft-mtp --spec-draft-n-max 3
```

The quantized MTP head is inside every GGUF in this release. It adds less than 250 MB to the file, and if MTP is not enabled these weights are not loaded into GPU memory. The head predicts one token ahead, so pushing `--spec-draft-n-max` much past 3 mostly adds rejected drafts. MTP works with **vision requests**.

### DFlash 2: external draft, fastest option

[DFlash 2](https://huggingface.co/incoai/Qwen3.8-27B-DFlash2-GGUF) is a ~2B block-diffusion draft model for Qwen3.8-27B from Inco AI. It drafts in blocks of 8, so it wins more tokens per verification pass than MTP even though a smaller fraction of each block survives.

```bash
llama-server \
  -hf byteshape/Qwen3.8-27B-GGUF:Qwen3.8-27B-IQ4_XS-3.84bpw \
  -hfd incoai/Qwen3.8-27B-DFlash2-GGUF:Q4_K_M \
  --spec-type draft-dflash --spec-draft-n-max 7 \
  --no-mmproj
```

DFlash 2 is auto-detected from the draft GGUF's metadata; no other flags are needed. The draft is fully offloaded to GPU by default. The Q4_K_M draft file is 1.1 GB, so budget roughly 1.2 GB of extra VRAM. Draft quantization barely affects acceptance (Q4_K_M is on par with Q8_0 and BF16), so the Q4_K_M draft is the practical choice.

> **DFlash 2 is text-only.** The draft context cannot handle image embeddings, so requests carrying an image fail with an HTTP 500 while `draft-dflash` is active (the failure is per-request and the server recovers). llama.cpp loads the vision projector by default with `-hf`, so the command above adds `--no-mmproj` to skip downloading and loading it. For mixed text and image workloads use `--spec-type draft-mtp` instead. Vision with MTP works.

### Measured throughput

RTX 5090 (32 GB), single stream, `-np 1 -fa on`, with the official thinking-mode sampling (temperature 1.0, top_p 0.95, top_k 20). The prompts are a mix of coding, math, instruction-following and general-knowledge requests. MTP uses 3 draft tokens and DFlash2 uses 7.

| Model ID | Bits/Weight | TPS | TPS with MTP | TPS with DFlash2 |
|---------|-------------|----:|-------------:|-----------------:|
| GPU-1 | 2.56 | 119 | 164 (1.38x) | 176 (1.47x) |
| GPU-2 | 2.88 | 111 | 157 (1.41x) | 176 (1.59x) |
| GPU-3 | 3.01 | 108 | 155 (1.44x) | 172 (1.59x) |
| GPU-4 | 3.23 | 104 | 148 (1.43x) | 170 (1.64x) |
| GPU-5 | 3.84 |  94 | 147 (1.57x) | 167 (1.78x) |

![RTX 5090: NTP vs. MTP vs. DFlash2](img/RTX5090-speculative.png)

**Speculative throughput is workload dependent.** The realized speedup depends on how predictable your prompt and decoded tokens are. Code completion, structured output and repetitive content benefit the most, while highly creative or out-of-distribution generation benefits less. The numbers above are **effective TPS** over the whole benchmark run, including acceptance and rejection of speculative tokens. Sampling matters too: greedy and low-temperature decoding accept more drafts and run faster than the table shows. We chose temperature-based sampling because it better reflects real usage.

On the RTX 5090, DFlash 2 leads MTP by roughly 7 to 14% across the lineup, with the gap widening on the larger models. Across all six GPUs we tested (RTX 3090, 4080, 4090, 5060 Ti, 5090 and RTX PRO 6000 Blackwell), DFlash2 reached **1.34–2.10x** the plain-decoding throughput and MTP reached **1.28–1.66x**.

If you would rather skip the extra 1.1 GB download, the embedded MTP head gets you most of the way there. Packaging MTP as a separate GGUF would not save memory: a standalone draft needs its own embedding and output layers, which are by far its largest tensors, bringing it to roughly 1 GB as well.

## Recommended Sampling Parameters

Qwen3.8 has **thinking mode on by default**; add `--reasoning off` for instruct (non-thinking) behavior. Following the official model card:

| Mode | temperature | top_p | top_k | min_p | presence_penalty |
|------|-------------|-------|-------|-------|------------------|
| Thinking (default) | 1.0 | 0.95 | 20 | 0.0 | 0.0 |
| Instruct (`--reasoning off`) | 0.7 | 0.80 | 20 | 0.0 | 1.5 |

The **Get llama.cpp command** links above emit these automatically, along with your chosen speculative-decoding mode.

## Notes on quantization labels

The labels you see (for example `IQ4_XS`) are only there to make Hugging Face show our models in the GGUF table. We do not use the conventional quantization profiles as defined in llama.cpp. In our case, these labels indicate the closest size class and average bit length. All models in this release use a hybrid mix of quantization techniques chosen per tensor by ShapeLearn.
