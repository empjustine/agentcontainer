---
quantized_by: bartowski
pipeline_tag: text-generation
license: mit
base_model: inclusionAI/Ling-3.0-tiny
base_model_relation: quantized
---

## Llamacpp imatrix Quantizations of Ling-3.0-tiny by inclusionAI

Using <a href="https://github.com/ggml-org/llama.cpp/">llama.cpp</a> release <a href="https://github.com/ggml-org/llama.cpp/releases/tag/b10472">b10472</a> for quantization.

Original model: https://huggingface.co/inclusionAI/Ling-3.0-tiny

**Model details:**
- Parameter count: 8B
- Input support: text
- Speculative decoding: no
- imatrix: yes - [details](#imatrix)
- Perplexity/KLD measured: no

[How to run](#how-to-run)

## Prompt format

```
<role>SYSTEM</role>{system_prompt}
detailed thinking on<|role_end|><role>HUMAN</role>{prompt}<|role_end|><role>ASSISTANT</role>
<think>
```

**Don't know which to choose?** Grab [Q4_K_M](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q4_K_M.gguf) (4.92GB) - usually a good mix of size and performance. Download instructions available [here](#downloading-using-the-hugging-face-cli)

## Available files:

| Filename | Quant type | File Size | Split | Description |
| -------- | ---------- | --------- | ----- | ----------- |
| [Ling-3.0-tiny-bf16.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-bf16.gguf) | bf16 | 15.80GB | false | Full BF16 weights. |
| [Ling-3.0-tiny-Q8_0.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q8_0.gguf) | Q8_0 | 8.41GB | false | Extremely high quality, generally unneeded but max available quant. |
| [Ling-3.0-tiny-Q6_K_L.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q6_K_L.gguf) | Q6_K_L | 6.96GB | false | Uses Q8_0 for embed and output weights. Very high quality, near perfect, *recommended*. |
| [Ling-3.0-tiny-Q6_K.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q6_K.gguf) | Q6_K | 6.84GB | false | Very high quality, near perfect, *recommended*. |
| [Ling-3.0-tiny-Q5_K_L.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q5_K_L.gguf) | Q5_K_L | 5.87GB | false | Uses Q8_0 for embed and output weights. High quality, *recommended*. |
| [Ling-3.0-tiny-Q5_K_M.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q5_K_M.gguf) | Q5_K_M | 5.72GB | false | High quality, *recommended*. |
| [Ling-3.0-tiny-Q5_K_S.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q5_K_S.gguf) | Q5_K_S | 5.55GB | false | High quality, *recommended*. |
| [Ling-3.0-tiny-Q4_K_L.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q4_K_L.gguf) | Q4_K_L | 5.10GB | false | Uses Q8_0 for embed and output weights. Good quality, *recommended*. |
| [Ling-3.0-tiny-Q4_1.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q4_1.gguf) | Q4_1 | 5.08GB | false | Legacy format, similar performance to Q4_K_S but with improved tokens/watt on Apple silicon. |
| [Ling-3.0-tiny-Q4_K_M.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q4_K_M.gguf) | Q4_K_M | 4.92GB | false | Good quality, default size for most use cases, *recommended*. |
| [Ling-3.0-tiny-Q4_K_S.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q4_K_S.gguf) | Q4_K_S | 4.75GB | false | Slightly lower quality with more space savings, *recommended*. |
| [Ling-3.0-tiny-Q4_0.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q4_0.gguf) | Q4_0 | 4.62GB | false | Legacy format, kept for compatibility with older tools. |
| [Ling-3.0-tiny-IQ4_NL.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-IQ4_NL.gguf) | IQ4_NL | 4.62GB | false | Similar to IQ4_XS, but slightly larger. |
| [Ling-3.0-tiny-IQ4_XS.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-IQ4_XS.gguf) | IQ4_XS | 4.39GB | false | Decent quality, smaller than Q4_K_S with similar performance, *recommended*. |
| [Ling-3.0-tiny-Q3_K_XL.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q3_K_XL.gguf) | Q3_K_XL | 4.13GB | false | Uses Q8_0 for embed and output weights. Lower quality but usable, good for low RAM availability. |
| [Ling-3.0-tiny-IQ3_M.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-IQ3_M.gguf) | IQ3_M | 3.93GB | false | Medium-low quality, new method with decent performance comparable to Q3_K_M. |
| [Ling-3.0-tiny-Q3_K_L.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q3_K_L.gguf) | Q3_K_L | 3.91GB | false | Lower quality but usable, good for low RAM availability. |
| [Ling-3.0-tiny-Q3_K_M.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q3_K_M.gguf) | Q3_K_M | 3.79GB | false | Low quality. |
| [Ling-3.0-tiny-IQ3_XS.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-IQ3_XS.gguf) | IQ3_XS | 3.78GB | false | Lower quality, new method with decent performance, slightly better than Q3_K_S. |
| [Ling-3.0-tiny-Q3_K_S.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q3_K_S.gguf) | Q3_K_S | 3.64GB | false | Low quality, not recommended. |
| [Ling-3.0-tiny-IQ3_XXS.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-IQ3_XXS.gguf) | IQ3_XXS | 3.46GB | false | Lower quality, new method with decent performance, comparable to Q3 quants. |
| [Ling-3.0-tiny-Q2_K_L.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q2_K_L.gguf) | Q2_K_L | 3.24GB | false | Uses Q8_0 for embed and output weights. Very low quality but surprisingly usable. |
| [Ling-3.0-tiny-Q2_K.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q2_K.gguf) | Q2_K | 3.00GB | false | Very low quality but surprisingly usable. |
| [Ling-3.0-tiny-IQ2_M.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-IQ2_M.gguf) | IQ2_M | 2.83GB | false | Relatively low quality, uses SOTA techniques to be surprisingly usable. |

Download a specific file:

```
hf download bartowski/Ling-3.0-tiny-GGUF --include "Ling-3.0-tiny-Q4_K_M.gguf" --local-dir ./
```

## Downloading using the Hugging Face CLI

<details>
  <summary>Click to view download instructions</summary>

First, make sure you have the Hugging Face CLI installed:

```
pip install -U "huggingface_hub[cli]"
```

Download a specific file:

```
hf download bartowski/Ling-3.0-tiny-GGUF --include "Ling-3.0-tiny-Q4_K_M.gguf" --local-dir ./
```

</details>

## How to run

These quants run with [llama.cpp](https://github.com/ggml-org/llama.cpp) - installable in one line via [llama.app](https://llama.app/):

```
curl -LsSf https://llama.app/install.sh | sh
llama-server -hf bartowski/Ling-3.0-tiny-GGUF:Q4_K_M
```

llama-server includes a built-in chat web UI, served at http://localhost:8080 by default.

These quants were made with llama.cpp release b10472 - if this model's architecture is newly supported, you'll need that release or newer to run them.

They also work in: [LM Studio](https://lmstudio.ai/) · [koboldcpp](https://github.com/LostRuins/koboldcpp) · [ramalama](https://github.com/containers/ramalama) · [Jan AI](https://www.jan.ai/) · [Text Generation Web UI](https://github.com/oobabooga/text-generation-webui) · [LoLLMs](https://github.com/ParisNeo/lollms) · [Atomic Chat](https://atomic.chat/)

## imatrix

All quants made using imatrix option, with a calibration corpus rendered through this model's own chat template. The corpus pairs plain prose with tool-calling and reasoning conversations ([corpus source data](https://gist.github.com/bartowski1182/e26453c0404e24eb317543ec5360f87a)), encoded exactly as this model sees them at inference and processed with `--parse-special`, so chat-format special tokens contribute to the importance matrix. The corpus rendered for this model is included in this repo: [Ling-3.0-tiny-calibration-v6.txt](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-calibration-v6.txt). The imatrix is available here: [Ling-3.0-tiny-imatrix.gguf](https://huggingface.co/bartowski/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-imatrix.gguf).

<details>
<summary>Calibration render details</summary>

```json
{
  "generator": "auto_quant_v2 calibration renderer",
  "recipe": "calibration-v6",
  "model": "Ling-3.0-tiny",
  "encoder": "chat_template",
  "chunk_size": 512,
  "prose_chunks": 220,
  "tool_chunks": 345,
  "total_chunks": 565,
  "tool_chunk_fraction": 0.611,
  "n_conversations": 137,
  "extension_convs_used": 0,
  "conversation_token_lengths": [
    523,
    1594,
    1193,
    1476,
    1046,
    1300,
    3127,
    754,
    1163,
    1353,
    1019,
    2059,
    836,
    1200,
    2755,
    1189,
    1099,
    948,
    694,
    677,
    1326,
    990,
    1308,
    1167,
    1839,
    1463,
    1601,
    844,
    1376,
    1604,
    1472,
    1161,
    1211,
    1003,
    1019,
    1650,
    1619,
    1147,
    433,
    1912,
    1392,
    1048,
    1355,
    1973,
    2023,
    1230,
    1569,
    824,
    2903,
    1063,
    2811,
    723,
    955,
    915,
    924,
    655,
    2396,
    840,
    1100,
    1045,
    1166,
    1133,
    868,
    1151,
    1114,
    1530,
    873,
    1483,
    2099,
    803,
    333,
    1071,
    3285,
    2856,
    671,
    865,
    974,
    1022,
    1244,
    1052,
    1074,
    753,
    1152,
    983,
    1244,
    1468,
    1321,
    2041,
    795,
    608,
    2714,
    658,
    1345,
    1626,
    1936,
    1168,
    581,
    1336,
    1136,
    1653,
    1759,
    1625,
    782,
    961,
    976,
    2730,
    697,
    679,
    709,
    1354,
    1011,
    1544,
    731,
    361,
    327,
    2569,
    947,
    1085,
    1815,
    1970,
    2651,
    2644,
    759,
    931,
    797,
    884,
    1190,
    944,
    809,
    1266,
    793,
    668,
    1711,
    965,
    880,
    1240,
    1409
  ],
  "warnings": []
}
```

</details>

## Embed/output weights

Some of these quants (Q3_K_XL, Q4_K_L etc) are the standard quantization method with the embeddings and output weights quantized to Q8_0 instead of what they would normally default to.

## ARM/AVX information

llama.cpp automatically "repacks" weights into an interleaved layout at load time for faster inference on ARM and AVX machines - details in [this PR](https://github.com/ggml-org/llama.cpp/pull/9921). This once required downloading special Q4_0_4_4/4_8/8_8 files; those are long gone. Online repacking now covers Q4_0, IQ4_NL, and most K-quants, so no special quant choice is needed for CPU inference.

## Which file should I choose?

<details>
  <summary>Click here for details</summary>

An older (early 2024) but still useful write-up with charts comparing quant performances is provided by Artefact2 [here](https://gist.github.com/Artefact2/b5f810600771265fc1e39442288e8ec9)

The first thing to figure out is how big a model you can run. To do this, you'll need to figure out how much RAM and/or VRAM you have.

If you want your model running as FAST as possible, you'll want to fit the whole thing on your GPU's VRAM. Aim for a quant with a file size 1-2GB smaller than your GPU's total VRAM.

If you want the absolute maximum quality, add both your system RAM and your GPU's VRAM together, then similarly grab a quant with a file size 1-2GB Smaller than that total.

Hugging Face can also do this math for you: add your hardware in your [Local Apps settings](https://huggingface.co/settings/local-apps) and the model page will show which files fit.

Next, you'll need to decide if you want to use an 'I-quant' or a 'K-quant'.

If you don't want to think too much, grab one of the K-quants. These are in format 'QX_K_X', like Q5_K_M.

If you want to get more into the weeds, you can check out this extremely useful feature chart:

[llama.cpp feature matrix](https://github.com/ggml-org/llama.cpp/wiki/Feature-matrix)

But basically, if you're aiming for below Q4, and you're running cuBLAS (Nvidia) or rocBLAS (AMD), you should look towards the I-quants. These are in format IQX_X, like IQ3_M. These are newer and offer better performance for their size.

These I-quants can also be used on CPU, but will be slower than their K-quant equivalent, so speed vs performance is a tradeoff you'll have to decide.

</details>

## Credits

Thank you kalomaze and Dampf for assistance in creating the imatrix calibration dataset.

Thank you ZeroWw for the inspiration to experiment with embed/output.

Want to support my work? Visit my ko-fi page here: https://ko-fi.com/bartowski
