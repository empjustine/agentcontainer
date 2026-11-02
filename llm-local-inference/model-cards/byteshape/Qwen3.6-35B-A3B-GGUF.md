---
library_name: transformers
license: apache-2.0
license_link: https://huggingface.co/Qwen/Qwen3.6-35B-A3B/blob/main/LICENSE
pipeline_tag: image-text-to-text
base_model:
- Qwen/Qwen3.6-35B-A3B
tags:
- qwen3.6
- byteshape
---

# Qwen3.6-35B-A3B GGUF (ShapeLearn Quantized)

This is a GGUF-quantized version of Qwen3.6-35B-A3B produced with **ByteShape's ShapeLearn**, which learns the optimal datatype per tensor to maintain high quality even at very low bitlengths.

To learn more about ShapeLearn and to see detailed benchmarks across GPUs, CPUs, and even the Raspberry Pi, please visit our [blog](https://byteshape.com/blogs/Qwen3.6-35B-A3B/).

If you have questions or want to share feedback, reach us on [Reddit](https://www.reddit.com/r/ByteShape/).

## Quick Start

Pick a model from the tables below and click **Get llama.cpp command** to get a ready-to-run command with all the correct sampling parameters for this model.

You can also copy the **Model Tag** from the table and use it directly:

| Tool | Command |
|------|---------|
| **llama.cpp** | `llama-server -hf <MODEL_TAG> --mmproj-auto` |

This is a **vision capable** model. llama.cpp auto-downloads the model and vision projector on first run.

Once you run the llama-server, you can access the web interface at `http://localhost:<PORT>`.


> **Note on Ollama:** As of this release, Ollama does not support Qwen3.6-35B-A3B based on Llama.cpp GGUFs. We suggest using [llama.cpp](https://github.com/ggml-org/llama.cpp) or [LM Studio](https://lmstudio.ai/) as an alternative.


## How to Pick a Model

We provide **CPU and GPU optimized variants** for llama.cpp:

- **CPUs:** Models labeled as KQ (Q*_K), optimized for CPU inference with predominantly KQ quantization.
- **GPUs:** Models labeled as IQ, optimized for GPU inference with a hybrid approach combining KQ and IQ quantization for better throughput.

Each hardware target includes a range of models covering different size and quality tradeoffs.

The chart below shows **quality versus tokens per second (TPS)**, with several providers used as the baseline for comparison.
Quality is measured across six benchmarks, including function calling: BFCL-V3, LiveCodeBench V6, HumanEval, GSM8K, IFEVAL, and GSM8K_V in both thinking and instruct modes.

**Selection rule:** Choose the model with the highest quality at your target throughput or the fastest model that still meets your required quality.

### GPU Models
Interactive plots for RTX 4090, 4080, 5060Ti, 5090, and RTX Pro 6000 Blackwell are available [here](https://byteshape.com/blogs/Qwen3.6-35B-A3B/).

![GPU Benchmark - RTX 4090](img/RTX4090.png)

**Table sorted by model size** (match the chart numbers to model IDs):

| Model ID | Bits/Weight | Model Size | Use This Model | Model Tag |
|---------|-------------|-----------|-----|-----------|
| [GPU-1](https://huggingface.co/byteshape/Qwen3.6-35B-A3B-GGUF/blob/main/Qwen3.6-35B-A3B-IQ2_S-2.17bpw.gguf) | 2.17 | 9.42 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-IQ2_S-2.17bpw&platform=llamacpp) | `byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-IQ2_S-2.17bpw` |
| [GPU-2](https://huggingface.co/byteshape/Qwen3.6-35B-A3B-GGUF/blob/main/Qwen3.6-35B-A3B-IQ3_S-3.00bpw.gguf) | 3.00 | 13 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-IQ3_S-3.00bpw&platform=llamacpp) | `byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-IQ3_S-3.00bpw` |
| [GPU-3](https://huggingface.co/byteshape/Qwen3.6-35B-A3B-GGUF/blob/main/Qwen3.6-35B-A3B-IQ3_S-3.48bpw.gguf) | 3.48 | 15.1 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-IQ3_S-3.48bpw&platform=llamacpp) | `byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-IQ3_S-3.48bpw` |
| [GPU-4](https://huggingface.co/byteshape/Qwen3.6-35B-A3B-GGUF/blob/main/Qwen3.6-35B-A3B-IQ4_XS-3.93bpw.gguf) | 3.93 | 17 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-IQ4_XS-3.93bpw&platform=llamacpp) | `byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-IQ4_XS-3.93bpw` |
| [GPU-5](https://huggingface.co/byteshape/Qwen3.6-35B-A3B-GGUF/blob/main/Qwen3.6-35B-A3B-IQ4_XS-4.15bpw.gguf) | 4.15 | 18 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-IQ4_XS-4.15bpw&platform=llamacpp) | `byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-IQ4_XS-4.15bpw` |


### CPU Models
Interactive plots for Ryzen 9 5900X, Intel Core i7 12700KF, Ultra 7 265KF, and Raspberry Pi 5 (16 GB) are available [here](https://byteshape.com/blogs/Qwen3.6-35B-A3B/).
![CPU Benchmark - Ryzen 9 5900X](img/Ryzen9.png)

**Table sorted by model size** (match the chart numbers to model IDs):

| Model ID | Bits/Weight | Model Size | Use This Model | Model Tag |
|---------|-------------|-----------|-----|-----------|
| [CPU-1](https://huggingface.co/byteshape/Qwen3.6-35B-A3B-GGUF/blob/main/Qwen3.6-35B-A3B-Q3_K_S-2.69bpw.gguf) | 2.69 | 11.7 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-Q3_K_S-2.69bpw&platform=llamacpp) | `byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-Q3_K_S-2.69bpw` |
| [CPU-2](https://huggingface.co/byteshape/Qwen3.6-35B-A3B-GGUF/blob/main/Qwen3.6-35B-A3B-Q3_K_S-2.71bpw.gguf) | 2.71 | 11.7 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-Q3_K_S-2.71bpw&platform=llamacpp) | `byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-Q3_K_S-2.71bpw` |
| [CPU-3](https://huggingface.co/byteshape/Qwen3.6-35B-A3B-GGUF/blob/main/Qwen3.6-35B-A3B-Q3_K_S-3.39bpw.gguf) | 3.39 | 14.7 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-Q3_K_S-3.39bpw&platform=llamacpp) | `byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-Q3_K_S-3.39bpw` |
| [CPU-4](https://huggingface.co/byteshape/Qwen3.6-35B-A3B-GGUF/blob/main/Qwen3.6-35B-A3B-Q4_K_S-3.80bpw.gguf) | 3.80 | 16.5 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-Q4_K_S-3.80bpw&platform=llamacpp) | `byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-Q4_K_S-3.80bpw` |
| [CPU-5](https://huggingface.co/byteshape/Qwen3.6-35B-A3B-GGUF/blob/main/Qwen3.6-35B-A3B-Q4_K_S-4.22bpw.gguf) | 4.22 | 18.3 GB | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-Q4_K_S-4.22bpw&platform=llamacpp) | `byteshape/Qwen3.6-35B-A3B-GGUF:Qwen3.6-35B-A3B-Q4_K_S-4.22bpw` |

## Notes on quantization labels

The labels you see (for example `IQ4_XS`) are only there to make Hugging Face show our models in the GGUF table. We do not use the conventional quantization profiles as defined in llama.cpp. In our case, these labels indicate the primary quantization approach and average bit length. Note that both KQ and IQ models may use a mix of quantization techniques optimized for their target hardware, which is why several models can share the same tag.
