---
base_model: Qwen/Qwen3.8-Flash-Next
base_model_relation: quantized
pipeline_tag: image-text-to-text
library_name: gguf
license: apache-2.0
tags:
  - gguf
  - gsq
  - rco
  - quantization
  - pruning
  - expert-pruning
  - mixed-precision
  - ist-daslab
  - moe
  - code
---

<div align="center">

<a href="https://github.com/IST-DASLab"><img src="https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF/resolve/main/assets/banner.png" alt="GGUF, GSQ-RCO expert-pruned coder" width="100%"/></a>

<br/>

# Qwen3.8-Flash-Next &middot; GSQ-RCO Coder

**A 512-expert mixture-of-experts model with half of its experts removed**, targeted at code and retaining multimodal capability.
**58.4 GB** against 354 GB at BF16, an effective **1.89 bits per parameter of the original transformer**.

[![arXiv: GSQ](https://img.shields.io/badge/arXiv-GSQ_2604.18556-b31b1b?logo=arxiv&logoColor=white)](https://arxiv.org/abs/2604.18556)
[![arXiv: RCO](https://img.shields.io/badge/arXiv-RCO_2605.00649-b31b1b?logo=arxiv&logoColor=white)](https://arxiv.org/abs/2605.00649)
[![GSQ code](https://img.shields.io/badge/code-GSQ-181717?logo=github&logoColor=white)](https://github.com/IST-DASLab/GSQ)
[![RCO code](https://img.shields.io/badge/code-RCO-181717?logo=github&logoColor=white)](https://github.com/IST-DASLab/RCO)
[![DASLab](https://img.shields.io/badge/DASLab-GitHub-101048?logo=github&logoColor=white)](https://github.com/IST-DASLab)
[![license](https://img.shields.io/badge/license-apache--2.0-19a34a)](#license)

</div>

> **Update, October 17, 2026.** The model has been improved: looping is reduced and coding performance is higher, with SWE-bench Verified rising from 75.60 to 79.20 and LiveCodeBench v6 from 86.28 to 87.43. Only the first shard changed; if you downloaded the earlier build, re-download that shard.

![Coding Benchmarks After 50% Expert Pruning](https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF/resolve/main/assets/plots/Qwen3.8-Flash-Next-Coder-coding_benchmarks.png)

---

## Overview

This release is a capability-targeted compression of Qwen3.8-Flash-Next. Half of the routed experts are removed from the model rather than quantized, and the remaining weights are stored at 3.5 bpw.

The base model has 176.9B parameters and occupies 354 GB at BF16. The compressed model reduces to only 29.6 GB which must reside in memory: the n-gram shard is a lookup table and may be served from disk. The resident working set of a 176.9B-parameter model is therefore within the capacity of a single 32 GB accelerator.

Averaged over the transformer, this corresponds to **1.89 bits per parameter of the original model**. The figure is an effective rate: it amortises the removed experts over the original parameter count, and so expresses the combined effect of pruning and quantization. No individual weight is stored at 1.89 bits. The retained weights are stored at 3.5 bpw, unchanged by pruning, and the halved expert count accounts for the remainder of the reduction. Following the convention of the accompanying releases, the figure is reported over the transformer and excludes the fixed-precision n-gram shard.

Removing half of a model's experts necessarily reduces its capabilities. The contribution of this release is that the reduction is directed towards code, agentic tool use, vision, and spatial reasoning, and the retained experts are therefore those that support these domains. Degradation outside this set is an accepted cost of the method. For general-purpose use, the [unpruned GSQ-RCO releases](https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF) are the appropriate choice.

| | SWE-bench Verified | LiveCodeBench v6 |
|---|---|---|
| BF16 base (354 GB) | 82.80 | 87.43 |
| **GSQ-RCO Coder (58.4 GB)** | **79.20** | **87.43** |
| retained | 95.7% | 100.0% |

All numbers in this card were measured at **xhigh reasoning effort**.

This is an experimental release and feedback is welcome, particularly on capabilities that were not represented in the calibration mixture.

LiveCodeBench v6 matches the base score. SWE-bench Verified, which evaluates extended agentic trajectories over real repositories, retains 95.7%. The gap between the two is consistent with the expectation that sustained multi-step tasks accumulate error across turns, and therefore tolerate capacity reduction less well than single-problem code generation.

---

## What Expert Pruning Is

A mixture-of-experts layer holds many independent feed-forward blocks and a small router that picks a few per token. Flash-Next has **512 experts per layer across 48 layers, with 10 active per token**, so the experts hold the overwhelming majority of the parameters while only a fraction runs on any given token.

Expert pruning removes entire experts from the model. It is therefore distinct from quantization, which retains every parameter and reduces the precision at which it is stored. Pruning removes parameters from the model outright, reducing both file size and resident memory, and restricts the router to a smaller candidate pool. The two techniques are complementary and are combined here: 50% of experts are removed, and the remaining weights are quantized to 3.5 bpw.

The central question is which experts to remove. Since experts specialise, importance is not an intrinsic property of an expert but is defined relative to a distribution of inputs. That distribution is supplied by the calibration data, which consequently determines which capabilities survive compression.

---

## How the Experts Are Chosen

Selection was done with **RCO** ([paper](https://arxiv.org/abs/2605.00649), [code](https://github.com/IST-DASLab/RCO)), optimizing the KL divergence between the pruned and unpruned model on calibration data, rather than ranking experts by a heuristic importance score.

The GGUF format constrains the problem in a particular way. It stores **a single expert count for the entire model**, so every layer must retain the same number of experts. A single global budget would permit the search to remove more experts from insensitive layers and fewer from sensitive ones, which generally yields a better model, but produces per-layer counts that the format cannot represent without padding that forfeits the memory saved.

RCO enforces budgets exactly by treating the feasible set as a smooth manifold, and admits **multiple simultaneous budgets**. Replacing the global budget with one budget per layer expresses the format's structural requirement directly as constraints. These constraints are mutually independent, as no expert belongs to more than one layer, so the projection and retraction steps decompose into per-layer operations and remain inexpensive.

The constraints decompose, but **the objective does not**, the loss is the KL divergence of the full model, so the gradient for any layer reflects the state of all others; the layers are optimised jointly and only budget enforcement proceeds per layer. This distinguishes the method from the common alternative of retaining a fixed number of top-ranked experts per layer under a heuristic importance score, with no joint search. A penalty-based formulation would additionally require one coefficient per layer, and these coefficients interact; RCO requires none.

---

## Vision Capability

An initial search used code and agentic calibration data only. It removed the experts on which the vision pathway depends, and image capability degraded substantially while coding scores were unaffected. This is the expected behaviour rather than a failure of the method: absent calibration data that exercises vision, the search correctly determines that those experts do not contribute to the measured objective.

The released model was searched with vision represented in the calibration mixture and retains the capability. As an informal qualitative check, the "pelican riding a bicycle" prompt is used, which requires object knowledge, spatial composition and correct SVG syntax simultaneously:

<div align="center">
<img src="https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF/resolve/main/assets/pelican-on-bike.svg" alt="SVG of a pelican riding a bicycle, drawn by the pruned model" width="440"/>
</div>

---

## Available Files

Two shards, both required. `llama.cpp` loads the pair when given the first.

| File | Size | Must be resident | Notes |
|---|---|---|---|
| `...-00001-of-00002.gguf` | 29.6 GB | yes | Transformer weights, 256 of 512 experts per layer, 1.89 bpw over the original parameters |
| `...-00002-of-00002.gguf` | 28.8 GB | no | Per-layer n-gram table (IQ4_NL, 4.5 bpw), neither pruned nor searched |
| **Total** | **58.4 GB** | **29.6 GB** | against 354 GB and 354 GB resident for BF16 |

The n-gram table is a lookup rather than a matmul weight, so it is held at a fixed 4.5 bpw and excluded from both the quantization search and the pruning.

### llama.cpp
```bash
hf download <this-repo> --local-dir .
llama-cli -m IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf \
  -p "Refactor this function to be iterative." -ngl 99
```

### Strata Engine

Many users report strong results with [Strata](https://github.com/Niko1221/Strata), a third-party engine that runs these GGUFs on a single NVIDIA GPU from 8 GB of VRAM, with a one-click installer and an OpenAI-compatible endpoint on localhost.

---

## Method

| | |
|---|---|
| **GSQ** ([paper](https://arxiv.org/abs/2604.18556), [code](https://github.com/IST-DASLab/GSQ)) | Post-training scalar quantization that learns grid assignments and group scales jointly, closing most of the gap to vector quantization at low bit-widths while staying deployable in standard GGUF types. |
| **RCO** ([paper](https://arxiv.org/abs/2605.00649), [code](https://github.com/IST-DASLab/RCO)) | Budget-constrained optimization on a Riemannian manifold. Used here to choose which experts to remove under one exact budget per layer, and in the base releases to assign per-tensor quantization types. |

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

These weights inherit the license of the base model (**Qwen3.8-Flash-Next**). The GSQ-RCO tooling is released by the Deep Algorithms and Systems Lab under its repository license.

<div align="center">
<sub>Built with <b>GSQ</b> and <b>RCO</b> at the <a href="https://github.com/IST-DASLab">Deep Algorithms and Systems Lab</a> &middot; Institute of Science and Technology Austria</sub>
</div>
