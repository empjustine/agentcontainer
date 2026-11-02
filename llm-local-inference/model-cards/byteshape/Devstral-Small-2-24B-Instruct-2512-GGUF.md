---
library_name: transformers
license: apache-2.0
pipeline_tag: text-generation
base_model:
- mistralai/Devstral-Small-2-24B-Instruct-2512
tags:
- mistral
- devstral
- byteshape
---

# Devstral-Small-2-24B-Instruct-2512 GGUF (ShapeLearn Quantized)

This is a GGUF-quantized version of Devstral-Small-2-24B-Instruct-2512 produced with **ByteShape's ShapeLearn**, which learns the optimal datatype per tensor to maintain high quality even at very low bitlengths.

To see interactive plots and benchmarks for Nvidia GPUs, please visit our [blog](https://byteshape.com/blogs/Devstral-Small-2-24B-Instruct-2512/).

If you have questions or want to share feedback, reach us on [Reddit](https://www.reddit.com/r/ByteShape/).


## How to Pick a Model

We provide models optimized for NVIDIA RTX 40- and 50-series GPUs in llama.cpp.

The chart below shows **quality versus tokens per second (TPS)**, with Unsloth used as the baseline for comparison.
Quality is measured across seven benchmarks, including function calling and vision: BFCL-V3, LiveCodeBench V6, HumanEval, GSM8K-V, Math500, GSM8K, and MMLU.

**Selection rule:** Choose the model with the highest quality at your target throughput or the fastest model that still meets your required quality.

![GPU Benchmark - RTX 5090](img/RTX5090.png)

**Table sorted by model size** (match the chart numbers to model IDs):

| Model ID | Bits/Weight | Model Size |
|---------|-------------|-----------|
| [IQ-1](https://huggingface.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF/blob/main/Devstral-Small-2-24B-Instruct-2512-IQ2_S-2.34bpw.gguf) | 2.34 | 6.9 GB |
| [IQ-2](https://huggingface.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF/blob/main/Devstral-Small-2-24B-Instruct-2512-IQ2_S-2.43bpw.gguf) | 2.43 | 7.2 GB |
| [IQ-3](https://huggingface.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF/blob/main/Devstral-Small-2-24B-Instruct-2512-IQ3_S-2.67bpw.gguf) | 2.67 | 7.9 GB |
| [IQ-4](https://huggingface.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF/blob/main/Devstral-Small-2-24B-Instruct-2512-IQ3_S-2.78bpw.gguf) | 2.78 | 8.2 GB |
| [IQ-5](https://huggingface.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF/blob/main/Devstral-Small-2-24B-Instruct-2512-IQ3_S-2.96bpw.gguf) | 2.96 | 8.7 GB |
| [IQ-6](https://huggingface.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF/blob/main/Devstral-Small-2-24B-Instruct-2512-IQ3_S-3.19bpw.gguf) | 3.19 | 9.4 GB |
| [IQ-7](https://huggingface.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF/blob/main/Devstral-Small-2-24B-Instruct-2512-IQ3_S-3.47bpw.gguf) | 3.47 | 10.2 GB |
| [IQ-8](https://huggingface.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF/blob/main/Devstral-Small-2-24B-Instruct-2512-IQ4_XS-4.04bpw.gguf) | 4.04 | 11.9 GB |

## Notes on quantization labels

The labels you see (for example `IQ4_XS`) are only there to make Hugging Face show our models in the GGUF table. We do not use the conventional quantization profiles as defined in llama.cpp. In our case, these labels indicate the primary quantization approach and average bit length.

## Running these models with Ollama

All GGUF files in this repo can be used directly with Ollama.

To run a model with Ollama, use:

```bash
ollama run hf.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF:FILE_NAME.gguf
```

Replace `FILE_NAME.gguf` with the GGUF filename you want. For example:

```bash
ollama run hf.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF:Devstral-Small-2-24B-Instruct-2512-IQ4_XS-4.04bpw.gguf
```

## Running these models with llama.cpp (vision with `--mmproj`)

Devstral is a multimodal model, so for vision use cases in `llama.cpp` you must provide both:

- a GGUF model file via `-m`
- the matching multimodal projector file via `--mmproj`

Example (server mode):

```bash
./llama-server \
  -m /path/to/Devstral-Small-2-24B-Instruct-2512-IQ4_XS-4.04bpw.gguf \
  --mmproj /path/to/mmproj-bf16.gguf \
  -c 8192 \
  -ngl 99 \
  --port 8080
```
Then you can access the web interface at `http://localhost:8080`.