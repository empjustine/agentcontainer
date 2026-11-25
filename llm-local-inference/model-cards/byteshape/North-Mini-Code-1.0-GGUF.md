---
library_name: transformers
license: apache-2.0
license_link: https://huggingface.co/CohereLabs/North-Mini-Code-1.0/blob/main/LICENSE
pipeline_tag: text-generation
base_model:
  - CohereLabs/North-Mini-Code-1.0
tags:
  - agent
  - cohere
  - byteshape
---

# North-Mini-Code-1.0 GGUF (ShapeLearn Quantized)

This is a GGUF-quantized version of North-Mini-Code-1.0 produced with **ByteShape's ShapeLearn**, which learns the optimal datatype per tensor to maintain high quality even at very low bitlengths.

To learn more about ShapeLearn and to see detailed benchmarks across GPUs, please visit our [blog](https://byteshape.com/blogs/North-Mini-Code-1.0/).

If you have questions or want to share feedback, reach us on [Reddit](https://www.reddit.com/r/ByteShape/).

## Quick Start

Pick a model from the table below and click **Get llama.cpp command** to get a ready-to-run command with all the correct sampling parameters for this model.

You can also copy the **Model Tag** from the table and use it directly:

| Tool          | Command                        |
| ------------- | ------------------------------ |
| **llama.cpp** | `llama-server -hf <MODEL_TAG>` |

llama.cpp auto-downloads the model on first run.

Once you run the llama-server, you can access the web interface at `http://localhost:<PORT>`.

## How to Pick a Model

These models are **optimized for GPU inference**.

The chart below shows **quality versus tokens per second (TPS)**, measured on RTX 4090.
Quality is measured across two benchmarks, LiveCodeBench V6 and MultiPL-E HumanEval, both in thinking mode normalized by the BF16 baseline model.

**Selection rule:** Choose the model with the highest quality at your target throughput or the fastest model that still meets your required quality.

### GPU Models

Interactive plots for RTX 4090, 4080, 5060Ti, and 5090 are available [here](https://byteshape.com/blogs/North-Mini-Code-1.0/).

![GPU Benchmark - RTX 4090](img/RTX4090.png)

**Table sorted by model size** (match the chart numbers to model IDs):

| Model ID                                                                                                             | Bits/Weight | Model Size | Use This Model                                                                                                                                           | Model Tag                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [GPU-1](https://huggingface.co/byteshape/North-Mini-Code-1.0-GGUF/blob/main/North-Mini-Code-1.0-IQ3_S-3.17bpw.gguf)  | 3.17        | 12.1 GB    | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/North-Mini-Code-1.0-GGUF:North-Mini-Code-1.0-IQ3_S-3.17bpw&platform=llamacpp)  | `byteshape/North-Mini-Code-1.0-GGUF:North-Mini-Code-1.0-IQ3_S-3.17bpw`  |
| [GPU-2](https://huggingface.co/byteshape/North-Mini-Code-1.0-GGUF/blob/main/North-Mini-Code-1.0-IQ4_XS-4.14bpw.gguf) | 4.14        | 15.8 GB    | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/North-Mini-Code-1.0-GGUF:North-Mini-Code-1.0-IQ4_XS-4.14bpw&platform=llamacpp) | `byteshape/North-Mini-Code-1.0-GGUF:North-Mini-Code-1.0-IQ4_XS-4.14bpw` |
| [GPU-3](https://huggingface.co/byteshape/North-Mini-Code-1.0-GGUF/blob/main/North-Mini-Code-1.0-IQ4_XS-4.27bpw.gguf) | 4.27        | 16.3 GB    | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/North-Mini-Code-1.0-GGUF:North-Mini-Code-1.0-IQ4_XS-4.27bpw&platform=llamacpp) | `byteshape/North-Mini-Code-1.0-GGUF:North-Mini-Code-1.0-IQ4_XS-4.27bpw` |
| [GPU-4](https://huggingface.co/byteshape/North-Mini-Code-1.0-GGUF/blob/main/North-Mini-Code-1.0-IQ4_XS-5.64bpw.gguf) | 5.64        | 21.5 GB    | [Get llama.cpp command](https://byteshape.com/run-hf-model/?tag=byteshape/North-Mini-Code-1.0-GGUF:North-Mini-Code-1.0-IQ4_XS-5.64bpw&platform=llamacpp) | `byteshape/North-Mini-Code-1.0-GGUF:North-Mini-Code-1.0-IQ4_XS-5.64bpw` |

## Notes on quantization labels

The labels you see (for example `IQ4_XS`) are only there to make Hugging Face show our models in the GGUF table. We do not use the conventional quantization profiles as defined in llama.cpp. In our case, these labels indicate the primary quantization approach and average bit length. Note that these models may use a mix of quantization techniques optimized for GPU inference, which is why several models can share the same tag.
