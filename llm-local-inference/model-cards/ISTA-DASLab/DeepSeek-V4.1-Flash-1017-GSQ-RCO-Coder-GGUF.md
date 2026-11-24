---
base_model: deepseek-ai/DeepSeek-V4.1-Flash-1017
base_model_relation: quantized
pipeline_tag: image-text-to-text
library_name: gguf
license: mit
tags:
  - text-generation
  - image-text-to-text
  - vision
  - gguf
  - gsq
  - rco
  - quantization
  - pruning
  - expert-pruning
  - mixed-precision
  - ist-daslab
  - moe
  - deepseek
  - code
---

<div align="center">

<a href="https://github.com/IST-DASLab"><img src="assets/banner.png" alt="DeepSeek-V4.1-Flash-1017 GSQ-RCO Coder, expert-pruned GGUF" width="100%"/></a>

<br/>

# DeepSeek-V4.1-Flash-1017 &middot; GSQ-RCO Coder

**A 763B-parameter mixture-of-experts model at 1 bit per parameter**, with half of its 384 experts per layer removed and the rest quantized, built for code and agentic workflows.
**72.1 GB** of transformer weights, **1.05 bits per parameter** measured against the original model's transformer (see [Overview](#overview)).

[![arXiv: GSQ](https://img.shields.io/badge/arXiv-GSQ_2604.18556-b31b1b?logo=arxiv&logoColor=white)](https://arxiv.org/abs/2604.18556)
[![arXiv: RCO](https://img.shields.io/badge/arXiv-RCO_2605.00649-b31b1b?logo=arxiv&logoColor=white)](https://arxiv.org/abs/2605.00649)
[![GSQ code](https://img.shields.io/badge/code-GSQ-181717?logo=github&logoColor=white)](https://github.com/IST-DASLab/GSQ)
[![RCO code](https://img.shields.io/badge/code-RCO-181717?logo=github&logoColor=white)](https://github.com/IST-DASLab/RCO)
[![DASLab](https://img.shields.io/badge/DASLab-GitHub-101048?logo=github&logoColor=white)](https://github.com/IST-DASLab)
[![license](https://img.shields.io/badge/license-MIT-19a34a)](#license)

</div>

![Coding benchmarks: Coder vs the base model](assets/plots/DeepSeek-V4.1-Flash-1017-Coder-coding_bars.png)

---

## Overview

This release is a capability-targeted compression of DeepSeek-V4.1-Flash-1017. Half of the routed experts are removed from the model rather than quantized, and the remaining weights keep the per-tensor quantization of the [IQ2_XXS build](https://huggingface.co/ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF) (2.00 bpw).

The base model has 763.2B parameters, 551.9B of them in the transformer. The Coder stores that transformer in **72.1 GB**, against 138.2 GB for the unpruned IQ2_XXS build. The two Engram lookup tables (110.6 GB, shared with the unpruned release) are read one row per token and may stay on disk.

**How the 1 bit is counted.** The Coder's 72.12 GB of transformer weights, divided by the 551.9B transformer parameters of the original model, give **1.05 bits per parameter**, which we round to 1 bit. The count is against the original model, so every removed expert counts as zero bits. The figure is an effective rate: it amortises the removed experts over the original parameter count, and so expresses the combined effect of pruning and quantization. The 280.1B parameters the Coder keeps average 2.06 bits: they keep the per-tensor types of the IQ2_XXS build, and the dense tensors, held at higher precision, make up a larger share of what remains. Removing 192 of 384 experts per layer (50% of the routed-expert parameters) accounts for the remainder of the reduction. As in the unpruned release, the figure is reported over the transformer and excludes the Engram tables (196.6B parameters at a fixed 4.50 bpw); over the whole model including them, the rate is 1.92 bits per parameter.

Removing half of a model's experts necessarily reduces its capabilities. The contribution of this release is that the reduction is directed towards **code, agentic tool use, long context and vision**, and the retained experts are therefore those that support these domains. Degradation outside this set is an accepted cost of the method. For general-purpose use, the [unpruned GSQ-RCO releases](https://huggingface.co/ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF) are the appropriate choice.

| | SWE-bench Verified | LiveCodeBench v6 |
|---|---|---|
| Base model (FP8 / FP4) | 81.20 | 89.71 |
| **GSQ-RCO Coder (72.1 GB, 1 bit: 1.05 bpw)** | **77.00** | **88.57** |
| retained | 94.8% | 98.7% |

All accuracy numbers in this card were measured at **reasoning effort 50**.

LiveCodeBench v6 retains 98.7% of the base score. SWE-bench Verified, which evaluates extended agentic trajectories over real repositories, retains 94.8%. The gap between the two is consistent with the expectation that sustained multi-step tasks accumulate error across turns, and therefore tolerate capacity reduction less well than single-problem code generation.

This is an experimental release and feedback is welcome, particularly on capabilities that were not represented in the calibration data.

---

## What Expert Pruning Is

A mixture-of-experts layer holds many independent feed-forward blocks and a small router that picks a few per token. DeepSeek-V4.1-Flash-1017 has **384 routed experts per layer, with 6 active per token**, so the experts hold the overwhelming majority of the parameters while only a fraction runs on any given token.

Expert pruning removes entire experts from the model. It is therefore distinct from quantization, which retains every parameter and reduces the precision at which it is stored. Pruning removes parameters from the model outright, reducing both file size and resident memory, and restricts the router to a smaller candidate pool. The two techniques are complementary and are combined here: 192 of 384 experts per layer are removed, and the remaining 192 keep the quantization of the IQ2_XXS build.

The central question is which experts to remove. Since experts specialise, importance is not an intrinsic property of an expert but is defined relative to a distribution of inputs. That distribution is supplied by the calibration data, which consequently determines which capabilities survive compression.

---

## How the Experts Are Chosen

Selection was done with **RCO** ([paper](https://arxiv.org/abs/2605.00649), [code](https://github.com/IST-DASLab/RCO)), optimizing the KL divergence between the pruned and the unpruned model on calibration data, rather than ranking experts by a heuristic importance score. The search runs on the quantized IQ2_XXS build, which is both the model being pruned and the reference, so it chooses the experts whose removal changes that build's outputs least, under the quantization they are shipped with.

The GGUF format constrains the problem in a particular way. It stores **a single expert count for the entire model**, so every layer must retain the same number of experts. A single global budget would permit the search to remove more experts from insensitive layers and fewer from sensitive ones, which generally yields a better model, but produces per-layer counts that the format cannot represent without padding that forfeits the memory saved.

RCO enforces budgets exactly by treating the feasible set as a smooth manifold, and admits **multiple simultaneous budgets**. Replacing the global budget with one budget per layer expresses the format's structural requirement directly as constraints. These constraints are mutually independent, as no expert belongs to more than one layer, so the projection and retraction steps decompose into per-layer operations and remain inexpensive.

The constraints decompose, but **the objective does not**: the loss is the KL divergence of the full model, so the gradient for any layer reflects the state of all others. The layers are optimised jointly and only budget enforcement proceeds per layer. This distinguishes the method from the common alternative of retaining a fixed number of top-ranked experts per layer under a heuristic importance score, with no joint search. A penalty-based formulation would additionally require one coefficient per layer, and these coefficients interact; RCO requires none.

---

## Drawing and Animation

SVG and three.js generation are part of the calibration data, so the Coder keeps the ability to write graphics code. As an informal qualitative check, the "pelican riding a bicycle" prompt is used, which requires object knowledge, spatial composition and correct SVG syntax simultaneously. The Coder's answer is animated: the wheels and cranks turn, the legs pedal, the throat pouch jiggles, and the sea, headlands, clouds and road scroll at different speeds.

<div align="center">
<img src="assets/pelican.svg" alt="Animated SVG of a pelican riding a bicycle along a coastal road, drawn by the pruned model" width="600"/>
</div>

<!-- TBD: the exact prompt and reasoning effort used for the drawing. -->

---

## Available Files

The Coder backbone is a GGUF in five shards in the folder `IQ2_XXS/`, named `DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder-IQ2_XXS-0000i-of-00006.gguf`, i = 1 to 5. The name keeps the identifier of the IQ2_XXS build, whose per-tensor quantization types the Coder keeps. Shard 1 holds the metadata only, shards 2 to 5 the transformer weights with 192 of 384 experts per layer.

The Engram file is shard 6 of the Coder. It is the same file as in the unpruned release (also shard 6 there), so llama.cpp needs a link to it named `IQ2_XXS/DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder-IQ2_XXS-00006-of-00006.gguf` (one command, see [llama.cpp](#llamacpp)).

| File | Size | Notes |
|---|---|---|
| `IQ2_XXS/DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder-IQ2_XXS-0000i-of-00006.gguf`, i = 1 to 5 | 72.12 GB | Transformer weights, 192 of 384 experts per layer, 1.05 bits per parameter of the original transformer |
| `DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf` | 110.60 GB | Shard 6: the two Engram lookup tables (IQ4_NL, 4.50 bpw), neither pruned nor searched; identical to the file of the unpruned release |
| **Total** | **182.72 GB** | against 248.84 GB for the unpruned IQ2_XXS build |

The Engram tables are a lookup rather than a matmul weight, so they are held at a fixed 4.50 bpw and excluded from both the quantization search and the pruning. If you already downloaded the [unpruned release](https://huggingface.co/ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF), its Engram file is the same and does not need to be downloaded again. The vision projector, `mmproj-DeepSeek-V4.1-Flash-1017-BF16.gguf` (0.97 GB), is also the file of the unpruned release. GB is 10<sup>9</sup> bytes.

The repository also contains the chat template the GGUF embeds (`chat_template.jinja`) and the result of the expert search: `expert-selection/DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder-IQ2_XXS.kept-experts.json` lists the 192 experts kept in each layer. Expert j of a layer in the Coder is the j-th listed expert of the base model, and every other tensor equals the IQ2_XXS build.

---

## Usage

### Strata Engine

[Strata](https://github.com/Niko1221/Strata) runs these GGUFs on a single NVIDIA GPU, with a one-click installer and an OpenAI-compatible endpoint on localhost. The builds were optimized together with Strata for local inference.

<!-- TBD: Strata steps for this repo, and whether to state the 12 GB GPU figure of the unpruned release for this build. -->

### llama.cpp

Requires llama.cpp [b11870](https://github.com/ggml-org/llama.cpp/releases/tag/b11870) or newer, which supports DeepSeek-V4.1.

```bash
# download the Coder and the Engram file (requires: pip install -U "huggingface_hub[cli]")
hf download ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder-GGUF \
  --include "IQ2_XXS/*" "*Engram*" --local-dir .

# the Engram file is shard 6 of the Coder
ln -s ../DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf \
  IQ2_XXS/DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder-IQ2_XXS-00006-of-00006.gguf

llama-cli -m IQ2_XXS/DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder-IQ2_XXS-00001-of-00006.gguf -ngl 99
```
`-m` takes the first shard; llama.cpp opens shards 2 to 6 from the same directory. If you already have the Engram file of the unpruned release, leave `"*Engram*"` out of the download and point the link at your copy. On Windows, `mklink /H IQ2_XXS\DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder-IQ2_XXS-00006-of-00006.gguf DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf` makes the link.

The Engram table stays memory-mapped on disk and is read one row per token, as in the [unpruned release](https://huggingface.co/ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF#llamacpp).

### Images

Download the vision projector and pass it with `--mmproj`:

```bash
hf download ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder-GGUF \
  --include "mmproj-*" --local-dir .

llama-server -m IQ2_XXS/DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder-IQ2_XXS-00001-of-00006.gguf \
  --mmproj mmproj-DeepSeek-V4.1-Flash-1017-BF16.gguf -ngl 99
```
With `llama-mtmd-cli`, also pass `--jinja` so that the chat template embedded in the GGUF is used.

### Chat template and reasoning effort

The chat template and reasoning effort work as in the [unpruned release](https://huggingface.co/ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF#chat-template-and-reasoning-effort): the GGUF embeds the same template, also included here as `chat_template.jinja`.

```bash
llama-server -m IQ2_XXS/DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder-IQ2_XXS-00001-of-00006.gguf -ngl 99 \
  --reasoning on --reasoning-effort 50
```

---

## Method

| | |
|---|---|
| **GSQ** ([paper](https://arxiv.org/abs/2604.18556), [code](https://github.com/IST-DASLab/GSQ)) | Post-training scalar quantization that learns grid assignments and group scales jointly, closing most of the gap to vector quantization at low bit-widths while staying deployable in standard GGUF types. |
| **RCO** ([paper](https://arxiv.org/abs/2605.00649), [code](https://github.com/IST-DASLab/RCO)) | Budget-constrained optimization on a Riemannian manifold. Used here to choose which experts to remove under one exact budget per layer, and in the unpruned release to assign per-tensor quantization types. |

Both developed at the [Deep Algorithms and Systems Lab (DASLab)](https://github.com/IST-DASLab), Institute of Science and Technology Austria.

---

## Citation

```bibtex
@article{gsq2026,
  title  = {GSQ: Highly-Accurate Low-Precision Scalar Quantization for LLMs via Gumbel-Softmax Sampling},
  author = {Dadgarnia, Alireza and Tabesh, Soroush and Nikdan, Mahdi and Helcig, Michael and Kurtic, Eldar and Kleinegger, Maximilian and Alistarh, Dan},
  journal= {arXiv preprint arXiv:2604.18556},
  year   = {2026}
}

@article{rco2026,
  title  = {Model Compression with Exact Budget Constraints via Riemannian Manifolds},
  author = {Helcig, Michael and Alistarh, Dan},
  journal= {arXiv preprint arXiv:2605.00649},
  year   = {2026}
}
```

---

## Acknowledgements

We thank [Verda](https://verda.com/) and Scientific Computing at the Institute of Science and Technology Austria for the compute used to produce these models.

## License

These weights inherit the license of the base model (**DeepSeek-V4.1-Flash-1017**, MIT). The GSQ-RCO tooling is released by the Deep Algorithms and Systems Lab under its repository license.

<div align="center">
<sub>Built with <b>GSQ</b> and <b>RCO</b> at the <a href="https://github.com/IST-DASLab">Deep Algorithms and Systems Lab</a> &middot; Institute of Science and Technology Austria</sub>
</div>
