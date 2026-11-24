---
library_name: transformers
license: other
license_name: lfm1.0
license_link: LICENSE
language:
- en
- ar
- zh
- fr
- de
- ja
- ko
- es
- pt
- it
- vi
- th
- id
- hi
- ru
- pl
pipeline_tag: text-generation
tags:
- liquid
- lfm2.5
- edge
- moe
- unsloth
base_model: LiquidAI/LFM2.5-24B-A2B
---

# Run and train LFM2.5 via the [Unsloth Desktop app](https://unsloth.ai/docs/desktop)
<div>
  <p style="margin: 0 0 0px 0; margin-top: 0px;">
    <em><a href="https://unsloth.ai/docs/basics/dynamic-3.0-ggufs">Unsloth Dynamic 3.0</a> achieves superior accuracy & outperforms other leading quants.</em>
  </p>
  <div style="display: flex; gap: 5px; align-items: center; margin-bottom: 0px;">
    <a href="https://github.com/unslothai/unsloth/">
      <img src="https://github.com/unslothai/unsloth/raw/main/images/unsloth%20new%20logo.png" width="133">
    </a>
    <a href="https://discord.gg/unsloth">
      <img src="https://github.com/unslothai/unsloth/raw/main/images/Discord%20button.png" width="173">
    </a>
    <a href="https://unsloth.ai/docs/">
      <img src="https://raw.githubusercontent.com/unslothai/unsloth/refs/heads/main/images/documentation%20green%20button.png" width="143">
    </a>
  </div>
</div>

<div align="center">
  <img 
    src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/2b08LKpev0DNEk6DlnWkY.png" 
    alt="Liquid AI" 
    style="width: 100%; max-width: 100%; height: auto; display: inline-block; margin-bottom: 0.5em; margin-top: 0.5em;"
  />
  <div style="display: flex; justify-content: center; gap: 0.5em; margin-bottom: 1em;">
    <a href="https://playground.liquid.ai/"><strong>Try LFM</strong></a> • 
    <a href="https://docs.liquid.ai/lfm/getting-started/welcome"><strong>Docs</strong></a> • 
    <a href="https://discord.com/invite/liquid-ai"><strong>Discord</strong></a>
  </div>
</div>

# LFM2.5-24B-A2B

LFM2.5-24B-A2B is a 24B-parameter reasoning model with only 2B active parameters, built for **fast, private agents on-device**. It is the largest and final model in the LFM2.5 family, which now spans two orders of magnitude: from [LFM2.5-230M](https://huggingface.co/LiquidAI/LFM2.5-230M) to LFM2.5-24B-A2B.

- **Best-in-class agent**: Competitive with Qwen3.6-35B-A3B, a model with ~50% more total and active parameters, on agentic and tool-use tasks, scoring 48.09 on LiveClaw versus 38.19.
- **Reasoning at MoE speed**: Always thinks before it answers. With only 2B active parameters per token, each reasoning token is cheap.
- **Efficient inference**: Runs up to 1.7× faster than comparable MoEs on-device, with 184 tok/s on an Apple M5 Max and up to 21K output tok/s on a single NVIDIA B300 GPU.

Find more information about LFM2.5-24B-A2B in our [blog post](https://www.liquid.ai/blog/lfm2-5-24b-a2b).

![LFM2.5-24B-A2B benchmarks](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B/resolve/main/figures/LFM2.5-24B-A2B-benchmark.png)

## 🗒️ Model Details

| Model                                                                        | Parameters      | Description                            |
| ---------------------------------------------------------------------------- | --------------- | -------------------------------------- |
| [LFM2.5-24B-A2B-Base](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B-Base)   | 24B (2B active) | Pre-trained base model for fine-tuning |
| **[LFM2.5-24B-A2B](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B)**         | 24B (2B active) | Post-trained for agentic workloads     |

LFM2.5-24B-A2B is a general-purpose text-only reasoning model with the following features:

- **Total parameters**: 24.0B
- **Active parameters**: 2.45B
- **Number of layers**: 40 (30 double-gated short convolution blocks + 10 GQA)
- **Experts**: 64 per MoE block, top-4 routing
- **Training budget**: 36 trillion tokens
- **Vocabulary size**: 128,000
- **Context length**: 131,072 tokens
- **Languages**: English, Arabic, Chinese, French, German, Italian, Japanese, Korean, Portuguese, Spanish, Vietnamese, Thai, Indonesian, Hindi, Russian, Polish
- **Generation parameters**:
  - `temperature: 0.1`
  - `top_k: 50`
  - `repetition_penalty: 1.05`

| Model                                                                              | Description                                                                                                                                  |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **[LFM2.5-24B-A2B](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B)**               | Original model checkpoint in native format. Best for fine-tuning or inference with Transformers, vLLM, and SGLang.                           |
| **[LFM2.5-24B-A2B-FP8](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B-FP8)** | FP8 checkpoint (block-wise FP8 weights, dynamic FP8 activations). Best for high-throughput GPU serving with vLLM and SGLang with lower memory usage. |
| **[LFM2.5-24B-A2B-GGUF](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B-GGUF)**     | Quantized format for llama.cpp and compatible tools. Optimized for CPU inference and local deployment with reduced memory usage.             |
| **[LFM2.5-24B-A2B-ONNX](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B-ONNX)**     | ONNX Runtime format for cross-platform deployment. Enables hardware-accelerated inference across diverse environments (cloud, edge, mobile). |
| **[LFM2.5-24B-A2B-MLX-4bit](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B-MLX-4bit)** | MLX format for Apple Silicon. Optimized for fast inference on Mac devices using the MLX framework.                                           |
| LFM2.5-24B-A2B-DSpark | DSpark draft model for speculative decoding with SGLang, for faster generation. *Coming soon.* |

We recommend using it for agents that need to reason, call tools, and run reliably on your device. It is not recommended for knowledge-heavy tasks on its own: pair it with retrieval or web search, which plays to its tool-calling strength.

### Chat Template

LFM2.5 uses a ChatML-like format. See the [Chat Template documentation](https://docs.liquid.ai/lfm/key-concepts/chat-template) for details. Example:

```
<|startoftext|><|im_start|>system
You are a helpful assistant trained by Liquid AI.<|im_end|>
<|im_start|>user
What is C. elegans?<|im_end|>
<|im_start|>assistant
<think>
```

You can use [`tokenizer.apply_chat_template()`](https://huggingface.co/docs/transformers/en/chat_templating#using-applychattemplate) to format your messages automatically.

> [!TIP]
> 💡 **Note**: Unlike LFM2-24B-A2B, LFM2.5-24B-A2B is a pure reasoning model that always thinks before it answers. It adds a `<think>` tag directly in the [chat template](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B/blob/main/chat_template.jinja#L124) when starting an assistant answer.

### Tool Use

LFM2.5 supports function calling in four steps:

1. **Function definition**: Provide the list of tools as a JSON object in the system prompt, or use [`tokenizer.apply_chat_template()`](https://huggingface.co/docs/transformers/en/chat_extras#passing-tools) with `tools=...`.
2. **Function call**: By default, LFM2.5 writes Pythonic function calls (a Python list between `<|tool_call_start|>` and `<|tool_call_end|>` special tokens), as the assistant answer. You can override this behavior by asking the model to output JSON function calls in the system prompt.
3. **Function execution**: Execute the call and return the result with the `tool` role.
4. **Final answer**: LFM2.5 interprets the tool output and returns a plain-text answer addressing the original prompt.

See the [Tool Use documentation](https://docs.liquid.ai/lfm/key-concepts/tool-use) for the full guide. Example:

```
<|startoftext|><|im_start|>system
List of tools: [{"name": "get_candidate_status", "description": "Retrieves the current status of a candidate in the recruitment process", "parameters": {"type": "object", "properties": {"candidate_id": {"type": "string", "description": "Unique identifier for the candidate"}}, "required": ["candidate_id"]}}]<|im_end|>
<|im_start|>user
What is the current status of candidate ID 12345?<|im_end|>
<|im_start|>assistant
<|tool_call_start|>[get_candidate_status(candidate_id="12345")]<|tool_call_end|>Checking the current status of candidate ID 12345.<|im_end|>
<|im_start|>tool
[{"candidate_id": "12345", "status": "Interview Scheduled", "position": "Clinical Research Associate", "date": "2023-11-20"}]<|im_end|>
<|im_start|>assistant
The candidate with ID 12345 is currently in the "Interview Scheduled" stage for the position of Clinical Research Associate, with an interview date set for 2023-11-20.<|im_end|>
```

### Training

![LFM2.5-24B-A2B post-training recipe](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B/resolve/main/figures/LFM2.5-24B-A2B-Training-Recipe.png)

LFM2.5-24B-A2B keeps the LFM2-24B-A2B architecture with two changes: the context window grows from 32K to 131K tokens, and the vocabulary doubles from 65K to 128K tokens through an [in-place tokenizer expansion](https://www.liquid.ai/blog/tokenizer-expansion) for better non-Latin tokenization.

- **Pre-training**: ~33T tokens, up from ~17T.
- **Mid-training**: 2T tokens at 32K context on curated, higher-quality data weighted toward reasoning, math, code, instruction following, and multilingual text, then 300B tokens of long-context data at 131K context. Tool calls and multi-turn trajectories appear in both phases.
- **Post-training**: supervised fine-tuning, teacher specialization, two multi-domain on-policy distillation stages (one non-agentic, one agentic), and agentic reinforcement learning inside popular agent harnesses ([OpenClaw](https://openclaw.ai), [Hermes Agent](https://hermes-agent.nousresearch.com), [Pi](https://pi.dev), [OpenCode](https://opencode.ai)), so the model learns their tools, system prompts, and interaction patterns.

## 📊 Performance

### Benchmarks

We compared LFM2.5-24B-A2B with relevant MoE models on 16 benchmarks covering knowledge, instruction following, math, code, tool use, and agentic workflows.

<table>
  <thead>
    <tr>
      <th style="text-align: left;">Benchmark</th>
      <th style="text-align: center; background-color: rgba(108, 79, 224, 0.12);">LFM2.5-24B-A2B</th>
      <th style="text-align: center;">Qwen3.6-35B-A3B</th>
      <th style="text-align: center;">Gemma-4-26B-A4B-it</th>
      <th style="text-align: center;">Nemotron-3.5-Lightning (30B-A3B)</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="text-align: left;">AutomationBench</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);"><strong>27.69</strong></td>
      <td style="text-align: center;">8.72</td>
      <td style="text-align: center;">5.46</td>
      <td style="text-align: center;">2.61</td>
    </tr>
    <tr>
      <td style="text-align: left;">BFCLv4</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);"><strong>65.01</strong></td>
      <td style="text-align: center;">65.00</td>
      <td style="text-align: center;">57.09</td>
      <td style="text-align: center;">53.78</td>
    </tr>
    <tr>
      <td style="text-align: left;">ToolSandbox</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);"><strong>80.71</strong></td>
      <td style="text-align: center;">75.02</td>
      <td style="text-align: center;">72.09</td>
      <td style="text-align: center;">75.13</td>
    </tr>
    <tr>
      <td style="text-align: left;">LiveClaw</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);"><strong>48.09</strong></td>
      <td style="text-align: center;">38.19</td>
      <td style="text-align: center;">41.25</td>
      <td style="text-align: center;">37.72</td>
    </tr>
    <tr>
      <td style="text-align: left;">PinchBench</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);">83.18</td>
      <td style="text-align: center;"><strong>89.93</strong></td>
      <td style="text-align: center;">77.12</td>
      <td style="text-align: center;">84.20</td>
    </tr>
    <tr>
      <td style="text-align: left;">τ³-Bench Banking</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);"><strong>8.04</strong></td>
      <td style="text-align: center;">7.63</td>
      <td style="text-align: center;">4.54</td>
      <td style="text-align: center;">7.01</td>
    </tr>
    <tr>
      <td style="text-align: left;">WebArena Verified</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);">26.75</td>
      <td style="text-align: center;"><strong>37.62</strong></td>
      <td style="text-align: center;">25.62</td>
      <td style="text-align: center;">28.69</td>
    </tr>
    <tr>
      <td style="text-align: left;">GPQA Diamond</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);">74.42</td>
      <td style="text-align: center;"><strong>83.69</strong></td>
      <td style="text-align: center;">74.90</td>
      <td style="text-align: center;">72.42</td>
    </tr>
    <tr>
      <td style="text-align: left;">AA-Omniscience</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);">-24.90</td>
      <td style="text-align: center;">-24.35</td>
      <td style="text-align: center;">-59.39</td>
      <td style="text-align: center;"><strong>-3.58</strong></td>
    </tr>
    <tr>
      <td style="text-align: left;">HLE</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);">7.40</td>
      <td style="text-align: center;">7.69</td>
      <td style="text-align: center;"><strong>8.57</strong></td>
      <td style="text-align: center;">5.65</td>
    </tr>
    <tr>
      <td style="text-align: left;">IFEval</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);"><strong>96.75</strong></td>
      <td style="text-align: center;">93.06</td>
      <td style="text-align: center;">92.00</td>
      <td style="text-align: center;">94.19</td>
    </tr>
    <tr>
      <td style="text-align: left;">IFBench</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);"><strong>74.69</strong></td>
      <td style="text-align: center;">64.21</td>
      <td style="text-align: center;">47.44</td>
      <td style="text-align: center;">71.67</td>
    </tr>
    <tr>
      <td style="text-align: left;">Multi-IF</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);"><strong>84.38</strong></td>
      <td style="text-align: center;">81.53</td>
      <td style="text-align: center;">82.19</td>
      <td style="text-align: center;">82.34</td>
    </tr>
    <tr>
      <td style="text-align: left;">MATH-500</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);">96.04</td>
      <td style="text-align: center;"><strong>96.73</strong></td>
      <td style="text-align: center;">95.66</td>
      <td style="text-align: center;">96.40</td>
    </tr>
    <tr>
      <td style="text-align: left;">SWE-Bench Verified (OpenCode)</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);">51.00</td>
      <td style="text-align: center;"><strong>66.20</strong></td>
      <td style="text-align: center;">25.80</td>
      <td style="text-align: center;">53.40</td>
    </tr>
    <tr>
      <td style="text-align: left;">SciCode</td>
      <td style="text-align: center; background-color: rgba(108, 79, 224, 0.12);">32.71</td>
      <td style="text-align: center;"><strong>37.35</strong></td>
      <td style="text-align: center;">35.42</td>
      <td style="text-align: center;">27.78</td>
    </tr>
  </tbody>
</table>

<details>
<summary>Evaluation settings</summary>

All the models were evaluated with vLLM and the following generation parameters:

- **AutomationBench**: temperature = 0.6, top_p = 0.95, max_turns = 50, no max output tokens (bounded by the model's context window).
- **BFCLv4**: temperature = 0.001, max output tokens = 4096.
- **ToolSandbox**: temperature = 0, max output tokens = 1024; user simulator: GPT-4o-2024-08-06, temperature = 0, max output tokens = 1024.
- **LiveClaw**: temperature = 1.0 (vLLM default; the agent sets no temperature), max output tokens = 8192.
- **τ³-Bench Banking**: official user model (GPT-5.2, low reasoning effort) with default BM25 retrieval, temperature = 0, max output tokens = 16384 per turn.
- **WebArena Verified**: temperature = 0.6, top_p = 0.95, max_turns = 40 (number of browser actions allowed), no max output tokens (bounded by the model's context window).
- **Other evals**: temperature = 0.6, max output tokens = 32768.

</details>

### Edge Inference

LFM2.5-24B-A2B is the fastest of the compared MoEs at reading in prompts and generating answers. It decodes 184 tokens/s on an Apple M5 Max and 114 tokens/s on an AMD Ryzen AI Max+ 395, up to 1.7x faster than the next-best model, while using the least memory.

![LFM2.5-24B-A2B edge inference](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B/resolve/main/figures/LFM2.5-24B-A2B-edge-inference.png)

<details>
<summary>Evaluation settings</summary>

Collected on Pipette, Liquid AI's device benchmarking infrastructure, with llama.cpp, Q4_K_M quantization, and a 4K-token input context.

</details>

### GPU Inference

LFM2.5-24B-A2B is the fastest model in its size class, reaching over 21K output tokens per second at high concurrency.

![LFM2.5-24B-A2B GPU inference](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B/resolve/main/figures/LFM2.5-24B-A2B-gpu-inference.png)

<details>
<summary>Evaluation settings</summary>

We measure GPU throughput (total output tokens / wall time) on a single NVIDIA B300 GPU with SGLang 0.5.22, using 1,024 input tokens, up to 256 output tokens, and BF16 weights. At each concurrency level, we continuously maintain the target number of in-flight requests, replacing each completed request immediately.

</details>

## 📬 Contact

- Got questions or want to connect? [Join our Discord community](https://discord.com/invite/liquid-ai)
- If you are interested in custom solutions with edge deployment, please contact [our sales team](https://www.liquid.ai/contact).

## Citation

```bibtex
@article{liquidAI202624BA2B,
  author  = {Liquid AI},
  title   = {LFM2.5-24B-A2B: Built for Fast On-Device Agents},
  journal = {Liquid AI Blog},
  year    = {2026},
  note    = {www.liquid.ai/blog/lfm2-5-24b-a2b},
}
```

```bibtex
@article{liquidai2025lfm2,
  title   = {LFM2 Technical Report},
  author  = {Liquid AI},
  journal = {arXiv preprint arXiv:2511.23404},
  year    = {2025}
}
```