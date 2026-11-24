---
license: other
license_name: openmdw-1.1
license_link: https://openmdw.ai/license/1-1/
pipeline_tag: text-generation
language:
- en
- ar
- bg
- cs
- da
- de
- el
- es
- et
- fi
- fr
- hi
- hr
- hu
- id
- it
- ja
- ko
- lt
- lv
- nl
- no
- pl
- pt
- ro
- ru
- sk
- sl
- sv
- th
- tr
- uk
- vi
- zh
tags:
- nvidia
- pytorch
- nemotron-3.5
- unsloth
base_model: nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-BF16
base_model_relation: quantized
datasets:
- nvidia/nemotron-post-training-v3
- nvidia/nemotron-pre-training-datasets
---
# Read our How to [Run Nemotron 3.5 Bolt Guide!](https://unsloth.ai/docs/models/nemotron-3.5-bolt)

<div>
<p style="margin-top: 0;margin-bottom: 0;">
   <em>See <a href="https://unsloth.ai/docs/basics/unsloth-dynamic-v3.0-gguf">Unsloth Dynamic 3.0 GGUFs</a> for our quantization benchmarks.</em>
  </p>
  <div style="display: flex; gap: 5px; align-items: center; ">
    <a href="https://github.com/unslothai/unsloth/">
      <img src="https://github.com/unslothai/unsloth/raw/main/images/unsloth%20new%20logo.png" width="133">
    </a>
    <a href="https://discord.gg/unsloth">
      <img src="https://github.com/unslothai/unsloth/raw/main/images/Discord%20button.png" width="173">
    </a>
    <a href="https://unsloth.ai/docs/models/nemotron-3.5-bolt">
      <img src="https://raw.githubusercontent.com/unslothai/unsloth/refs/heads/main/images/documentation%20green%20button.png" width="143">
    </a>
  </div>
</div>

---

# NVIDIA-Nemotron-3.5-Bolt-E4B-4GB

<div align="center" style="line-height: 1;">
  <a href="https://developer.nvidia.com/nemotron" target="_blank" style="margin: 2px;">
    <img alt="Homepage" src="https://img.shields.io/badge/🏠 Nemotron Developer Page-Learn More Here!-536af5?color=76B900&logoColor=white" style="display: inline-block; vertical-align: middle;"/>
  </a>
  <a href="https://discord.gg/9xpKQtVvrk" target="_blank" style="margin: 2px;">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-NVIDIA%20AI%20Developer-7289da?logo=discord&logoColor=white&color=7289da" style="display: inline-block; vertical-align: middle;"/>
  </a>
  <a href="https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB-Technical-Report.pdf" target="_blank" style="margin: 2px;">
    <img alt="Paper" src="https://img.shields.io/badge/📝 Paper-Read Now!-536af5?color=76B900&logoColor=white" style="display: inline-block; vertical-align: middle;"/>
  </a>
  <a href="https://research.nvidia.com/labs/nemotron/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB/" target="_blank" style="margin: 2px;">
    <img alt="Blog" src="https://img.shields.io/badge/📝 Blog-Read Now!-536af5?color=76B900&logoColor=white" style="display: inline-block; vertical-align: middle;"/>
  </a>
  <a href="https://openmdw.ai/license/1-1/" style="margin: 2px;">
    <img alt="License" src="https://img.shields.io/badge/License-OpenMDW--1.1-f5de53" style="display: inline-block; vertical-align: middle;"/>
  </a>
</div>

![image](bolt-smart-and-fast.png)

## Description

**NVIDIA-Nemotron-3.5-Bolt-E4B-4GB** is a small language model (SLM) further post-trained from [Gemma-4-E4B-it](https://huggingface.co/google/gemma-4-E4B-it) by NVIDIA. Nemotron-3.5-Bolt-E4B carries forward Gemma’s strong conversational capabilities and further improves multi-turn tool use, instruction following, and input grounding for fast local voice/device assistants, interactive personas, and embedded/edge interfaces. Designed for low-memory, low-TTFT operation, the model allows agents to respond quickly while preserving headroom for applications or adjacent model pipelines.

![demo](reachy-bolt.gif)

For speculative decoding, use the companion [DFlash drafter](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB-DFlash). For the full-precision (BF16) version, see [NVIDIA-Nemotron-3.5-Bolt-E4B-BF16](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-BF16).

This model is ready for commercial or non‑commercial use.


## Model Summary

| | |
|:---|:---|
| **Total Parameters** | 8B (4B effective) |
| **Architecture** | Gemma-4-E4B |
| **Precision** | Q4_K_M |
| **Context Length** | Input: up to 64K tokens; output: up to 64K tokens |
| **Inputs / Outputs** | Text / text |
| **Deployment** | llama.cpp (recipe pending) |
| **Reasoning Mode** | Chat-template controls (`enable_thinking=True/False`) and runtime thinking budget |
| **Conversational Mode** | Chat-template controls (`conversational_mode=True/False`) |
| **Recommended Sampling** | Temperature 1.0, top_p 0.95 in both thinking modes |
| **Best For** | Local voice and device assistants, interactive personas, and embedded interfaces |
| **License** | [OpenMDW-1.1](https://github.com/OpenMDW/OpenMDW/blob/main/1.1/LICENSE.OpenMDW-1.1) |

## Model Overview

**Model Developer:** NVIDIA Corporation

**Model Dates:** December 2025 - May 2026

**Data Freshness:**

* The post-training data has a cutoff date of May 2026.

### What is Nemotron?

NVIDIA Nemotron™ is a family of open models with open weights, training data, and recipes, delivering leading efficiency and accuracy for building specialized AI agents.

## Quick Start

```
export MODEL_REPO=nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB
export MODEL_FILE=Nemotron-3.5-Bolt-E4B-Q4_K_M.gguf

export DRAFTER_REPO=nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB-DFlash
export DRAFTER_FILE=Nemotron-3.5-Bolt-E4B-DFlash-BF16.gguf

export MODEL_DIR="$PWD/bolt-models"

hf download "$MODEL_REPO" "$MODEL_FILE" \
  --local-dir "$MODEL_DIR"

hf download "$DRAFTER_REPO" "$DRAFTER_FILE" \
  --local-dir "$MODEL_DIR"
```

### Without drafter

```
docker run --rm --gpus all \
  -p 8000:8000 \
  -v "$MODEL_DIR:/models:ro" \
  ghcr.io/ggml-org/llama.cpp:server-cuda13-b11459 \
  -m "/models/$MODEL_FILE" \
  --alias nemotron-bolt \
  --host 0.0.0.0 \
  --port 8000 \
  -c 65536 \
  -ngl 999 \
  --jinja
```

### With DFlash drafter

```
docker run --rm --gpus all \
  -p 8000:8000 \
  -v "$MODEL_DIR:/models:ro" \
  ghcr.io/ggml-org/llama.cpp:server-cuda13-b11459 \
  -m "/models/$MODEL_FILE" \
  --spec-draft-model "/models/$DRAFTER_FILE" \
  --spec-type draft-dflash \
  --spec-draft-n-max 7 \
  --spec-draft-ngl 999 \
  --alias nemotron-bolt \
  --host 0.0.0.0 \
  --port 8000 \
  -c 65536 \
  -ngl 999 \
  --jinja
```

```
curl --fail-with-body -sS \
  http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "nemotron-bolt",
    "messages": [
      {"role": "user", "content": "What is 17 multiplied by 23?"}
    ],
    "temperature": 0.0,
    "max_tokens": 512,
    "chat_template_kwargs": {
      "enable_thinking": true
    }
  }'
```

For more details on how to deploy and use the model — see the [Quick Start Guide](#quick-start-guide) below!

## License/Terms of Use

**Governing Terms:** Use of this model is governed by the [OpenMDW License Agreement, version 1.1](https://github.com/OpenMDW/OpenMDW/blob/main/1.1/LICENSE.OpenMDW-1.1). This model has been post-trained on the Google Gemma 4 model, and use of the Google Gemma 4 model is governed by [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0)

## Benchmarks

### Reasoning Benchmark Evaluations

## Benchmarks

We evaluated our model on the following benchmarks:

| Benchmark | Nemotron-3.5<br>Bolt-E4B<br>BF16 | Gemma4<br>E4B-it<br>BF16 | Qwen3.5<br>4B<br>BF16 | Nemotron-3<br>Nano-4B<br>BF16 | Nemotron-3.5<br>Bolt-E4B-4GB<br>Q4_K_M | Gemma4<br>E4B-it<br>Q4_K_M | Qwen3.5<br>4B<br>Q4_K_M | Nemotron-3<br>Nano-4B<br>Q4_K_M |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| MultiChallenge | **53.10** | 42.08 | 51.76 | 35.30 | **55.60** | 39.36 | 52.23 | 34.53 |
| RoleBench Custom | **67.05** | 49.95 | 53.66 | 12.02 | **71.21** | 60.51 | 52.35 | 10.86 |
| RoleMRC | **80.63** | 74.62 | 65.81 | 47.00 | **79.12** | 75.24 | 62.61 | 45.84 |
| EQ-Bench v3 | 39.40 | **41.17** | 32.92 | 19.31 | 38.15 | **39.77** | 32.07 | 19.45 |
| Brevity Benchmark | **82.52** | 79.99 | 75.35 | 73.60 | **82.84** | 78.49 | 75.17 | 70.98 |
| BFCL-v3 | 68.51 | 66.39 | **70.95** | 61.10 | 67.31 | 65.03 | **70.56** | 59.07 |
| When2Call Multi-Turn | **63.36** | 62.90 | 37.85 | 27.70 | 60.50 | **61.12** | 42.88 | 35.96 |
| ToolSandbox | 68.77 | 65.43 | **69.54** | 57.88 | 74.13 | 68.31 | **74.51** | 59.78 |
| Tau2-Bench | 55.10 | 38.50 | **75.06** | 29.20 | 52.32 | 38.72 | **61.74** | 14.89 |
| IHEval | **84.79** | 67.04 | 60.57 | 51.31 | **82.40** | 66.61 | 62.87 | 53.75 |
| AgentIF | **25.81** | 21.89 | 20.44 | 20.08 | **22.95** | 20.05 | 22.24 | 21.25 |
| StructEval-T | **80.40** | 79.27 | 76.01 | 63.50 | **79.99** | 77.28 | 76.38 | 16.54 |
| IFBench | **63.79** | 42.84 | 58.91 | 60.10 | 64.00 | 42.67 | **66.67** | 58.58 |
| InverseIFEval | **46.84** | 42.00 | 30.98 | 35.25 | **45.26** | 39.75 | 22.04 | 36.02 |
| RULER (64K) | 86.99 | 86.55 | **95.15** | 91.51 | 85.76 | 86.14 | **95.37** | 91.31 |
| LongMemEval | **72.10** | 70.95 | 66.85 | 25.20 | 69.92 | 67.95 | **76.60** | 27.15 |
| LongBench v2 (48K) | 50.50 | 49.34 | **59.93** | 31.40 | 48.67 | 45.70 | **58.28** | 37.42 |
| SysBench | **67.88** | 65.85 | 67.34 | 60.88 | 67.22 | 65.62 | **67.90** | 60.45 |
| GaRAGe | **42.61** | 34.73 | 24.66 | 25.18 | **40.73** | 30.91 | 31.78 | 24.80 |
| RAGTruth | **77.59** | 76.97 | 75.60 | 71.40 | **77.88** | 77.17 | 74.08 | 71.75 |
| RelyToolBench | **63.16** | 61.60 | 43.35 | 41.20 | **69.29** | 67.15 | 38.34 | 38.97 |

**Note:**
- Evaluations are conducted in reasoning mode except for RoleBench, EQ-Bench v3, and RULER.
- Bold indicates the highest score within each precision group (BF16 and Q4_K_M) for each row. All tied highest scores are bold.
- Accuracy numbers are measured by NVIDIA under a consistent harness ([NeMo Gym](https://github.com/NVIDIA-NeMo/Gym)); they may differ from vendors' self-reported numbers.

### Deployment Geography: Global

### Use Case

NVIDIA-Nemotron-3.5-Bolt-E4B-4GB is designed for fast local voice and device assistants, interactive personas, and embedded interfaces, with an emphasis on multi-turn tool use, instruction following, and input grounding.

### Release Date

- Hugging Face 10/23/2026 via https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB
- Build.NVIDIA.com 10/23/2026 via https://build.nvidia.com/nvidia/nemotron-3.5-bolt-e4b

## Reference(s)

* [NVIDIA Nemotron 3 model family on Hugging Face](https://huggingface.co/collections/nvidia/nvidia-nemotron-v3)
* [NVIDIA Nemotron 3.5 Bolt E4B 4GB Technical Report](https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB-Technical-Report.pdf)
* [NVIDIA Nemotron 3.5 Bolt E4B 4GB Technical Blog](https://research.nvidia.com/labs/nemotron/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB/)

## Model Architecture

- **Architecture Type:** Gemma 4
- **Network Architecture:** Gemma-4-E4B
- **Number of model parameters:** 8B (4B effective parameters)

## Model Design

The model was further post-trained from Gemma-4-E4B-it.

## Training Methodology

Reinforcement Learning

* The model underwent multi-environment reinforcement learning using GRPO (Group Relative Policy Optimization) across instruction following, multi-step tool use, multi-turn conversations, and structured output environments. It utilized an asynchronous RL architecture that decouples training from inference.
* Software used for reinforcement learning: [NeMo RL](https://github.com/NVIDIA-NeMo/RL), [NeMo Gym](https://github.com/NVIDIA-NeMo/Gym)

NVIDIA-Nemotron-3.5-Bolt-E4B-4GB is a result of the above work.

## Input

- **Input Type(s):** Text
- **Input Format(s):** String
- **Input Parameters:** One-Dimensional (1D): Sequences
- **Other Properties Related to Input:** Maximum context length up to 64K tokens. Supported languages include English, Spanish, French, German, Italian, and Japanese, among others.

## Output

- **Output Type(s):** Text
- **Output Format:** String
- **Output Parameters:** One-Dimensional (1D): Sequences
- **Other Properties Related to Output:** Maximum context length up to 64K tokens

Our AI models are designed and/or optimized to run on NVIDIA GPU-accelerated systems. By leveraging NVIDIA's hardware (e.g. GPU cores) and software frameworks (e.g., CUDA libraries), the model achieves faster training and inference times compared to CPU-only solutions.

## Software Integration

- **Runtime Engine(s):** PyTorch
- **Supported Hardware Microarchitecture Compatibility:** NVIDIA Ampere - A100; NVIDIA Blackwell; NVIDIA Hopper - H100-80GB
- **Supported Operating System(s):** Linux

The integration of foundation and fine-tuned models into AI systems requires additional testing using use-case-specific data to ensure safe and effective deployment. Following the V-model methodology, iterative testing and validation at both unit and system levels are essential to mitigate risks, meet technical and functional requirements, and ensure compliance with safety and ethical standards before deployment.

## Model Version(s)

* GA (10/23/2026)

## Quick Start Guide

```
export MODEL_REPO=nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB
export MODEL_FILE=Nemotron-3.5-Bolt-E4B-Q4_K_M.gguf

export DRAFTER_REPO=nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB-DFlash
export DRAFTER_FILE=Nemotron-3.5-Bolt-E4B-DFlash-BF16.gguf

export MODEL_DIR="$PWD/bolt-models"

hf download "$MODEL_REPO" "$MODEL_FILE" \
  --local-dir "$MODEL_DIR"

hf download "$DRAFTER_REPO" "$DRAFTER_FILE" \
  --local-dir "$MODEL_DIR"
```

### Without drafter

```
docker run --rm --gpus all \
  -p 8000:8000 \
  -v "$MODEL_DIR:/models:ro" \
  ghcr.io/ggml-org/llama.cpp:server-cuda13-b11459 \
  -m "/models/$MODEL_FILE" \
  --alias nemotron-bolt \
  --host 0.0.0.0 \
  --port 8000 \
  -c 65536 \
  -ngl 999 \
  --jinja
```

### With DFlash drafter

```
docker run --rm --gpus all \
  -p 8000:8000 \
  -v "$MODEL_DIR:/models:ro" \
  ghcr.io/ggml-org/llama.cpp:server-cuda13-b11459 \
  -m "/models/$MODEL_FILE" \
  --spec-draft-model "/models/$DRAFTER_FILE" \
  --spec-type draft-dflash \
  --spec-draft-n-max 7 \
  --spec-draft-ngl 999 \
  --alias nemotron-bolt \
  --host 0.0.0.0 \
  --port 8000 \
  -c 65536 \
  -ngl 999 \
  --jinja
```

```
curl --fail-with-body -sS \
  http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "nemotron-bolt",
    "messages": [
      {"role": "user", "content": "What is 17 multiplied by 23?"}
    ],
    "temperature": 0.0,
    "max_tokens": 512,
    "chat_template_kwargs": {
      "enable_thinking": true
    }
  }'
```

### API Client

The examples below use the OpenAI-compatible client and work with the serving backend above. Recommended sampling settings are **Temperature 1.0** and **Top\_P 0.95** in both thinking enabled and disabled modes.

```py
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8000/v1", api_key="EMPTY")
MODEL = "nemotron-bolt"
```

Bolt-E4B exposes reasoning control through chat-template kwargs: thinking enabled (the default), thinking disabled for direct answers, and a runtime thinking budget.

#### Reasoning On

```py
response = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "Write a haiku about GPUs"}],
    max_tokens=16000,
    temperature=1.0,
    top_p=0.95,
    extra_body={
        "skip_special_tokens": False,
        "chat_template_kwargs": {"enable_thinking": True},
    }
)
print(response.choices[0].message.content)
```

#### Reasoning Off

```py
response = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "What is the capital of Japan?"}],
    max_tokens=16000,
    temperature=1.0,
    top_p=0.95,
    extra_body={
        "skip_special_tokens": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
)
print(response.choices[0].message.content)
```

#### Streaming

```py
stream = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "Explain speculative decoding in two sentences"}],
    max_tokens=16000,
    temperature=1.0,
    top_p=0.95,
    stream=True,
    extra_body={"skip_special_tokens": False},
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

#### Tool Calling

For vLLM, add the following to any serve command above:

```sh
--enable-auto-tool-choice \
--tool-call-parser gemma4 \
--reasoning-parser gemma4 \
```

Sample request with tool-calling enabled:

```py
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

response = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "What's the weather in Santa Clara?"}],
    tools=tools,
    max_tokens=16000,
    temperature=1.0,
    top_p=0.95,
    extra_body={
        "skip_special_tokens": False,
        "chat_template_kwargs": {"enable_thinking": True},
    },
)
print(response.choices[0].message.tool_calls)
```

#### Conversational Mode

Bolt-E4B supports a conversational mode. If enabled, Bolt-E4B responds concisely and without as much textual formatting. This mode is suitable for conversational and spoken interaction-based applications. Conversational mode can be toggled as follows:

```py
response = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "What is the capital of Japan?"}],
    max_tokens=16000,
    temperature=1.0,
    top_p=0.95,
    extra_body={
        "skip_special_tokens": False,
        "chat_template_kwargs": {"conversational_mode": True},
    }
)
print(response.choices[0].message.content)
```

Conversational mode can be combined with thinking enabled and disabled mode, as well as tool-calling.

#### Runtime Thinking Budget Control

With llama-server you can control thinking budget by specifying the `--reasoning-budget` argument:
```
docker run --rm --gpus all \
  -p 8000:8000 \
  -v "$MODEL_DIR:/models:ro" \
  ghcr.io/ggml-org/llama.cpp:server-cuda13-b11459 \
  -m "/models/$MODEL_FILE" \
  --alias nemotron-bolt \
  --host 0.0.0.0 \
  --port 8000 \
  -c 65536 \
  -ngl 999 \
  --jinja \
  --reasoning on \
  --reasoning-budget <reasoning budget in tokens>
```

##### Limits and Recommendations for Runtime Budget Control

- Restricted token allocations may truncate thought processes mid-sentence. While output clarity is typically maintained, task-specific output evaluation remains necessary.  
- The client halts execution immediately upon reaching the pre-configured initial generation ceiling, ignoring subsequent line boundaries.  
- Conduct systematic allocation sweeps using standard evaluation prompts prior to establishing deployment parameters.  
- Illustration: To maintain a strict 500-token overall threshold, evaluate unconstrained model generation metrics (e.g., averaging 200 tokens). Assigning a dedicated 300-token reasoning parameter alongside a 500-token global ceiling forces thought termination at 300 tokens, reserving 200 tokens for output synthesis.  
- To encourage brief output (excluding internal reasoning steps), incorporate explicit word- or sentence-count constraints within system prompts.

#### Asynchronous Tool Calling

Bolt-E4B's chat template currently does not allow stray tool responses (`messages` with `tool` role that do not immediately follow a message with `assistant` role and `tool_calls`). However, this model can support asynchronous tool-calling with in the following manner:

<details>
<summary>Asynchronous tool-calling usage</summary>

If the model invokes a tool in `message.tool_calls` that has a later arriving result, respond with a `tool` message in the immediate next turn that acknowledges the tool-call and shows the tool result as pending.

Example:

Assistant tool-call

```json
{
  "role": "assistant",
  "tool_calls": [{
    "id": "call_1",
    "type": "function",
    "function": {
      "name": "build_report",
      "arguments": "{\"_task_id\":\"task_1\",\"scope\":\"weekly\"}"
    }
  }]
}
```

Immediate acknowledgement with pending result

```json
{
  "role": "tool",
  "tool_call_id": "call_1",
  "content": "{\"status\":\"pending\",\"task_id\":\"task_1\",\"function\":\"build_report\"}"
}
```

The model can continue the conversation with the user after this acknowledgement `tool` result message.

Once the tool result is available, respond with a `user` message that provides the tool result in a structured format, prefixed with something like `"TOOL RESULT:"`

Example:

Later tool result completion result

```json
{
  "role": "user",
  "content": "TOOL UPDATE: {\"status\":\"completed\",\"task_id\":\"task_1\",\"function\":\"build_report\",\"response\":\"Report is ready.\"}"
}
```

The model processes the finalized payload to resume the conversation.

</details>

## Prompting Guidelines

General guidelines for using Bolt-E4B in conversational and interactive agent applications.

### Prompt Structure and Content

- Put persistent role definitions, behavioral constraints, and operating rules in the system prompt.
- Use consistent headings which clearly identify the purpose of a section of the prompt, Example: ROLE, IDENTITY, INPUT FORMAT, TASK RULES, PERSONALITY, SPEECH EXAMPLES, etc.
- State the primary objective clearly. Define what counts as completion for multi-step workflows.
- Write instructions as conditions and actions: “After crafting succeeds, call the delivery tool.”
- Remove redundant instructions rather than repeatedly adding stronger versions.
- Use response-length limits that fit the application. A one- or two-sentence limit can suit spoken replies; it will not restrict tool arguments or reasoning.
- Use explicit constraints (e.g., `"limit responses to 1-2 sentences"`) instead of vague requests (e.g., `"be brief"`).
- Preserve genuine conversation history. Do not insert fabricated assistant actions, promises, or tool calls as if they occurred.
- If using few-shot examples, identify them as examples. Test whether the model copies their wording or themes and adjust instructions accordingly.
- Strictly adhere to standard `system/user/assistant/tool` turn sequences.

### Identity, Ownership, and Perspective

- Define the agent and user as separate entities with separate actions, locations, possessions, and knowledge.
- Explain pronouns when both entities appear in state: “In the state update following a user turn, ‘my’ refers to the user; but in a state update after an assistant turn, ‘my’ refers to you.”
- Use explicit labels such as YOUR INVENTORY, PLAYER VIEW, and SHARED CHEST to reinforce ownership.
- Distinguish unavailable information from empty state. An inaccessible user inventory is unknown, not empty.
- Distinguish visible resources from possessed resources. A nearby item or chest does not mean the agent owns its contents.
- Make character lore consistent with available information and tools. Explain any restrictions on what the character can perceive or use.

### Conveying Environment State

- Mark state blocks clearly, for example with # CURRENT STATE.
- Explain that state is operational context, not a new request or text to repeat aloud.
- Share state updates via new `user` or `system` messages. The model supports consecutive `user` and `system` messages. It is important to maintain correct chronology when conveying state information/updates and continuing the conversation.

For example, for a user message that is conditioned upon a state update,  the state update `user` or `system` message must come *before* the user response:
```
# CURRENT STATE
...

----------------

<actual user message>
```

OR in two user/system messages:
```
[..., {"role": "user/system", "content": "# CURRENT STATE..."}, {"role": "user", "content": "<actual user message>"}, ...]
```

But, for conveying an updated state that occurs after a tool is executed, the state update `user` or `system` message must come *after* the tool execution response:

```
[..., {"role": "tool", "content": "<tool execution result that updates a state>"}, {"role": "user/system", "content": "# CURRENT STATE... <state that got changed with tool execution>"}, {"role": "user", "content": "<next user message>"}, ...]
```

### Tool Definitions and Calling

- Send tools through the native tools array and read actions from message.tool_calls.
- Use stable function names and parameter schemas. Describe prerequisites, argument meanings, units, defaults, effects, and failure conditions.
- Make tool descriptions match actual behavior. “Drops an item toward the player” must not be described as guaranteed placement in the player’s inventory.

## Training, Testing, and Evaluation Datasets

### Training

#### Dataset Overview

**Data Modality:** Text

**Training Data Size:** More than 20 Trillion Tokens

**Dataset partition:** *Training [100%], testing [0%], validation [0%]*

**Time period for training data collection:** 2013 to December 2025

**Time period for testing data collection:** 2013 to December 2025

**Time period for validation data collection:** 2013 to December 2025

**Data Collection Method by dataset:** Hybrid: Automated, Manually-Collected, Synthetic

**Labeling Method by dataset:** Hybrid: Automated, Manually-Labeled, Synthetic

The post-training corpus for NVIDIA-Nemotron-3.5-Bolt-E4B-4GB consists of high-quality curated and synthetically-generated data. Primary languages used for post-training include English, French, German, Italian, Japanese, Spanish, and Chinese.

These datasets, such as FinePDFs, EssentialWeb, HotpotQA, SQuAD, and HelpSteer3, do not collectively or exhaustively represent all demographic groups (and proportionally therein). For instance, these datasets do not contain explicit mentions of demographic classes such as age, gender, or ethnicity in 64-99% of samples, depending on the source. In the subset where such terms are present, document-based datasets (FinePDFs and EssentialWeb) contain representational skews, such as references to "male" outnumbering those to "female", and mentions of "White" as the most frequent among ethnic identifiers (comprising 43-44% of ethnicity mentions). To mitigate these imbalances, we recommend considering evaluation techniques such as bias audits, fine-tuning with demographically balanced datasets, and mitigation strategies like counterfactual data augmentation to align with the desired model behavior. This evaluation used a 3,000-sample subset per dataset, identified as the optimal threshold for maximizing embedder accuracy.

During post-training, we generate synthetic data by distilling trajectories, solutions, and translations from strong teacher models and agent systems, often grounded in real tasks or documents and aggressively filtered for quality. For math, code, and science, we start from curated problem sets and use open source permissive models such as GPT-OSS-120B to produce step-by-step reasoning traces, candidate solutions, best-of-n selection traces, and verified CUDA kernels. For long-context and science, we build synthetic QA and reasoning data by retrieving passages from long documents, generating MCQ/OpenQA questions and answers, and paraphrasing them into multiple prompt/response formats to ensure diversity. Across all pipelines we stack automated verification—compilers, numerical checks, language identification—to ensure our data is high quality.

For all domains, we apply a unified data filtering pipeline to ensure that only high-quality, license-compliant, and verifiable samples are used for post-training. We first discard malformed examples using structural checks (e.g., missing tool definitions when tool calls are present). We then aggressively filter reasoning traces exhibiting pathological repetition, such as repeated n-grams within a sliding window or across the entire trajectory, which we found to be a strong indicator of malformed or low-quality reasoning. Finally, based on internal audits of synthetically generated datasets, we observed that some teacher models occasionally produce reasoning traces and final responses that implicitly align with specific political entities or promote nationalistic narratives. To mitigate this, we apply targeted keyword- and regex-based filters and remove all trajectories matching such behavior.

Alongside the model, we release our final pre-training and post-training data, as outlined in this section. For ease of analysis, there is a sample set that is ungated. For all remaining code, math and multilingual data, gating and approval is required, and the dataset is permissively licensed for model training purposes.

<details>
<summary>Detailed dataset information</summary>

#### Public Datasets

| Dataset | Collection Period |
| :---- | :---- |
| [GSM8K](https://github.com/openai/grade-school-math) | 4/23/2025 |
| [CC-NEWS](https://commoncrawl.org/blog/news-dataset-available) | 4/23/2025 |
| [Common Crawl](https://commoncrawl.org/) | 4/23/2025 |
| [Wikimedia](https://dumps.wikimedia.org/) | 4/23/2025 |
| [Bespoke-Stratos-17k](https://huggingface.co/datasets/bespokelabs/Bespoke-Stratos-17k) | 4/23/2025 |
| [tigerbot-kaggle-leetcodesolutions-en-2k](https://huggingface.co/datasets/TigerResearch/tigerbot-kaggle-leetcodesolutions-en-2k) | 4/23/2025 |
| [glaive-function-calling-v2](https://huggingface.co/datasets/glaiveai/glaive-function-calling-v2) | 4/23/2025 |
| [APIGen Function-Calling](https://huggingface.co/datasets/Salesforce/xlam-function-calling-60k) | 4/23/2025 |
| [LMSYS-Chat-1M](https://huggingface.co/datasets/lmsys/lmsys-chat-1m) | 4/23/2025 |
| [Open Textbook Library - CC BY-SA & GNU subset](https://open.umn.edu/opentextbooks/textbooks/) and [OpenStax - CC BY-SA subset](https://openstax.org/) | 4/23/2025 |
| [Advanced Reasoning Benchmark](https://github.com/TheDuckAI/arb), [tigerbot-kaggle-leetcodesolutions-en-2k](https://huggingface.co/datasets/TigerResearch/tigerbot-kaggle-leetcodesolutions-en-2k), [PRM800K](https://github.com/openai/prm800k), and [SciBench](https://github.com/mandyyyyii/scibench) | 4/23/2025 |
| [FineWeb-2](https://huggingface.co/datasets/HuggingFaceFW/fineweb-2) | 4/23/2025 |
| [Court Listener](https://www.courtlistener.com/help/api/bulk-data/) | Legacy Download |
| [peS2o](https://huggingface.co/datasets/allenai/peS2o) | Legacy Download |
| [OpenWebMath](https://huggingface.co/datasets/open-web-math/open-web-math) | Legacy Download |
| [BioRxiv](https://www.biorxiv.org/tdm) | Legacy Download |
| [PMC Open Access Subset](https://pmc.ncbi.nlm.nih.gov/tools/openftlist/) | Legacy Download |
| [OpenWebText2](https://openwebtext2.readthedocs.io/en/latest/) | Legacy Download |
| [Stack Exchange Data Dump](https://archive.org/details/stackexchange) | Legacy Download |
| [PubMed Abstracts](https://github.com/thoppe/The-Pile-PubMed) | Legacy Download |
| [NIH ExPorter](https://exporter.nih.gov/ExPORTER_Catalog.aspx) | Legacy Download |
| [arXiv](https://info.arxiv.org/help/bulk_data/index.html) | Legacy Download |
| [BigScience Workshop Datasets](https://github.com/bigscience-workshop/bigscience/tree/master/train/tr11-176B-ml#datasets) | Legacy Download |
| [Reddit Dataset](https://files.pushshift.io/reddit/) | Legacy Download |
| [SEC's Electronic Data Gathering, Analysis, and Retrieval (EDGAR)](https://www.sec.gov/search-filings) | Legacy Download |
| [Advanced Mathematical Problem Solving](https://github.com/hendrycks/math?tab=readme-ov-file) | Legacy Download |
| [MathPile](https://github.com/GAIR-NLP/MathPile/) | Legacy Download |
| [NuminaMath CoT](https://huggingface.co/datasets/AI-MO/NuminaMath-CoT) | Legacy Download |
| [PMC Article](https://pmc.ncbi.nlm.nih.gov/tools/textmining/) | Legacy Download |
| [FLAN](https://github.com/google-research/FLAN) | Legacy Download |
| [Advanced Reasoning Benchmark](https://github.com/TheDuckAI/arb) | Legacy Download |
| [SciBench](https://github.com/mandyyyyii/scibench) | Legacy Download |
| [WikiTableQuestions](https://huggingface.co/datasets/wikitablequestions) | Legacy Download |
| [FinQA](https://finqasite.github.io/) | Legacy Download |
| [Riddles](https://github.com/crawsome/riddles) | Legacy Download |
| [Problems in Elementary Mathematics for Home Study](https://archive.org/details/AntonovVygodskyNikitinSankinProblemsInElementaryMathematicsForHomeStudyMir1982) | Legacy Download |
| [MedMCQA](https://huggingface.co/datasets/openlifescienceai/medmcqa) | Legacy Download |
| [Cosmos QA](https://huggingface.co/datasets/allenai/cosmos_qa) | Legacy Download |
| [MCTest](https://huggingface.co/datasets/sagnikrayc/mctest) | Legacy Download |
| [AI2's Reasoning Challenge](https://huggingface.co/datasets/ai2_arc) | Legacy Download |
| [OpenBookQA](https://github.com/allenai/OpenBookQA) | Legacy Download |
| [MMLU Auxiliary Train](https://huggingface.co/datasets/cais/mmlu/viewer/all/auxiliary_train) | Legacy Download |
| [social-chemestry-101](https://huggingface.co/datasets/tasksource/social-chemestry-101) | Legacy Download |
| [Moral Stories](https://huggingface.co/datasets/demelin/moral_stories) | Legacy Download |
| [The Common Pile v0.1](https://huggingface.co/common-pile) | Legacy Download |
| [FineMath](https://huggingface.co/datasets/HuggingFaceTB/finemath) | Legacy Download |
| [MegaMath](https://huggingface.co/datasets/LLM360/MegaMath) | Legacy Download |
| [MultiverseMathHard](https://huggingface.co/datasets/Nexusflow/MultiverseMathHard) | 10/2/2025 |
| [SWE-Gym](https://huggingface.co/datasets/SWE-Gym/SWE-Gym) | 10/2/2025 |
| [WorkBench](https://github.com/olly-styles/WorkBench/tree/main/data/raw) | 10/2/2025 |
| [WildChat-1M](https://huggingface.co/datasets/allenai/WildChat-1M) | 10/2/2025 |
| [OpenCodeReasoning-2](https://huggingface.co/datasets/nvidia/OpenCodeReasoning-2) | 10/2/2025 |
| [HelpSteer3](https://huggingface.co/datasets/nvidia/HelpSteer3) | 10/2/2025 |
| [opc-sft-stage2](https://huggingface.co/datasets/OpenCoder-LLM/opc-sft-stage2) | 10/2/2025 |
| [Big-Math-RL-Verified](https://huggingface.co/datasets/SynthLabsAI/Big-Math-RL-Verified) | 10/2/2025 |
| [MetaMathQA](https://huggingface.co/datasets/meta-math/MetaMathQA) | 10/2/2025 |
| [simple-arithmetic-problems](https://huggingface.co/datasets/garrethlee/simple-arithmetic-problems) | 10/2/2025 |
| [arithmetic](https://huggingface.co/datasets/EleutherAI/arithmetic) | 10/2/2025 |
| [Skywork-OR1-RL-Data](https://huggingface.co/datasets/Skywork/Skywork-OR1-RL-Data) | 10/2/2025 |
| [FastChat](https://github.com/lm-sys/FastChat/blob/main/playground/data/dummy.json) | 10/2/2025 |
| [News Commentary](https://opus.nlpl.eu/News-Commentary.php) | 10/2/2025 |
| [Essential-Web](https://huggingface.co/datasets/EssentialAI/essential-web-v1.0) | 10/2/2025 |
| [finepdfs](https://huggingface.co/datasets/HuggingFaceFW/finepdfs) | 10/2/2025 |
| [HotpotQA](https://huggingface.co/hotpot_qa/datasets) | 10/2/2025 |
| [SQuAD2.0](https://rajpurkar.github.io/SQuAD-explorer/) | 10/2/2025 |
| [NLTK Words Lists](https://www.nltk.org/nltk_data/) | 10/2/2025 |

#### Private Non-publicly Accessible Datasets of Third Parties

| Dataset | Model(s) used |
|---------|---------------|
| Global Regulation | Unknown |
| TAUS Translation Memory | Unknown |
| Scale HLE | Unknown |
| HackerRank Coding | Unknown |
| RL data for Search | Gemini 3; GPT-5 |
| Mercor SWE-AgentsV1 | Undisclosed |

#### Private Non-publicly Accessible Datasets by NVIDIA

| Dataset | Model(s) used |
|---------|---------------|
| Simple Minesweeper | Undisclosed |
| Simple Sudoku | Undisclosed |
| Multitool Typewriter Hard | Undisclosed |
| Machine Translation of News Commentary and TAUS Translation Memory | Undisclosed |
| Machine Translation of STEM - | [Qwen2.5-14B-Instruct](https://huggingface.co/Qwen/Qwen2.5-14B-Instruct) |
| Competitive Coding RL data from Nemotron Cascade | Undisclosed |
| Long context RL | Undisclosed |
| Single-step SWE RL for patch generation | Undisclosed |
| OpenHands SWE | Undisclosed |

#### NVIDIA-Sourced Synthetic Datasets (Post-Training)

| Dataset | Modality | Dataset Size | Seed Dataset | Model(s) used for generation |
| :---- | :---- | :---- | :---- | :---- |
| Synthetic Competitive MATH Proofs from DeepSeek-V4-Pro | Text | Undisclosed | [AMC 8 Problems and Solutions, AMC 10 Problems and Solution, and AIME Problems and Solutions] | [deepseek-ai/DeepSeek-V4-Pro] |
| Synthetic Hermes Agent Reasoning Traces | Text | Undisclosed | [lambda/hermes-agent-reasoning-traces] | [hermes-agent-generator] |
| Synthetic Competitive Coding from DeepSeek-V4-Pro | Text | Undisclosed | [NVCompetitiveCodingV1] | [deepseek-ai/DeepSeek-V4-Pro] |
| Synthetic Competitive Science Reasoning from DeepSeek-V4-Pro | Text | Undisclosed | [AMC 8 Problems and Solutions, AMC 10 Problems and Solution, and AIME Problems and Solutions]; [EssentialAI/essential-web-v1.0]; [cdquestions.com]; [Pile-FreeLaw]; [Vedantu]; [askfilo]; [doubtnut]; [ICHO-IPH0 Dataset]; [LIMO dataset (Less is More for Reasoning)]; [AAPT]; [ChemData 700K]; [oMeBench]; [Flavor Analysis and Recognition Transformer]; [ChemCoTBench]; [Llama Nemotron Dataset] | [deepseek-ai/DeepSeek-V4-Pro] |
| Synthetic Competitive MATH CoT and TIR from Nemotron 5.5 | Text | Undisclosed | [Pile-FreeLaw]; [AMC 8 Problems and Solutions, AMC 10 Problems and Solution, and AIME Problems and Solutions] | [Nemotron 5.5] |
| Vendor Terminal Bench-like Tasks from Mercor | Text | Undisclosed | [Terminal bench like tasks curated by the vendor] | [Undisclosed - purchased dataset] |
| Turing Math Data Pack | Text | Undisclosed | [Turing Math Data Pack dataset] | [Undisclosed - purchased dataset] |
| Synthetic Holdout, Skywork, DAPO, and Turing Math from GPT-5.5 | Text | Undisclosed | [DocQA-RL-1.6K]; [DAPO-Math-17k] | [GPT-5.5] |
| Synthetic Long Context RL from QwenLong L1 and DocQA-RL-1.6K | Text | Undisclosed | [DocQA-RL-1.6K] | Undisclosed |
| Synthetic Competitive Coding Gym Tasks | Text | Undisclosed | [NVCompetitiveCodingV1.1] | Undisclosed |
| Synthetic Finance SEC Search Agent from GPT-OSS-120B and Qwen3 | Text | Undisclosed | [SEC filings from sec.gov] | [GPT-OSS-120B]; [Qwen3-235B-A22B-Instruct]; [Qwen3-4B-Instruct] |
| Synthetic Structured Outputs from Qwen3-30B-A3B-Instruct-2507, Qwen3-30B-A3B-Thinking-2507, Qwen3-235B-A22B-Instruct-2507, and Qwen3-235B-A22B-Thinking-2507 | Text | Undisclosed | [Nemotron-RL-agent-structured-outputs-v1] | [Qwen3-30B-A3B-Instruct-2507]; [Qwen3-235B-A22B-Instruct-2507] |
| Synthetic Long Context Equivalence Rule from Qwen3-235B-A22B-Thinking-2507 and DeepSeek-R1 | Text | Undisclosed | [Long-context SFT data] | [Qwen/Qwen3-235B-A22B-Thinking-2507]; [Deepseek-ai/DeepSeek-R1] |
| Synthetic Science RL Data Blend from Qwen2.5-32B | Text | Undisclosed | [doubtnut]; [Pile-FreeLaw]; [Llama Nemotron Dataset]; [askfilo]; [EssentialAI/essential-web-v1.0]; [Vedantu]; [auxiliary_train]; [cdquestions.com]; [AMC 8 Problems and Solutions, AMC 10 Problems and Solution, and AIME Problems and Solutions]; [AAPT]; [ICHO-IPH0 Dataset]; [LIMO dataset (Less is More for Reasoning)] | [Qwen2.5-32B] |
| Synthetic Abstention Data from Nemotron Super v3 | Text | Undisclosed | [Go abstention Dataset] | [nvidia/nvidia/nemotron-3-super-v3] |
| Synthetic Chemistry Data from Nemotron Super v3 | Text | Undisclosed | [ChemData 700K] | [nvidia/nvidia/nemotron-3-super-v3] |
| Synthetic Tool Call Schema for RL | Text | 469,983 | [UltraTool]; [ToolEyes]; [AutoTools]; [API-Bank]; [Nemotron-Personas-USA]; [Salesforce xLAM function-calling]; [Glaive function-calling-v2]; [Agent-Ark/Toucan-1.5M] | [DeepSeek-V3.2]; [GLM-4.6]; [gpt-oss-120b]; [Kimi-K2-Instruct] |
| Synthetic Freeform Text Formatting from GPT-OSS-120B | Text | Undisclosed | [In-house data] | [GPT OSS 120B - Apache 2.0] |
| Synthetic Citation Formatting from GPT-OSS-120B | Text | Undisclosed | [In-house data] | [GPT OSS 120B - Apache 2.0] |
| Droid Harness Pivot Vendor Data | Text | Undisclosed | [Droid Harness Pivot vendor data] | Undisclosed |
| Synthetic HotpotQA Training Data from Qwen3-235B | Text | Undisclosed | [HotpotQA] | [Qwen3-235B] |
| Synthetic Natural Language Math Proofs from Nemotron 5.5 | Text | Undisclosed | [AMC8, AMC10, and AIME problem sets hosted on Art of Problem Solving]; [Pile-StackExchange] | [Nemotron 5.5] |
| Synthetic Stack Overflow OpenQ | Text | Undisclosed | [Pile-FreeLaw] | Undisclosed |
| Chemistry Ether0 Vendor Data | Text | Undisclosed | [Chemistry ether0 vendor data] | Undisclosed |
| Synthetic Litmus-Bench Chemistry from ChEMBL | Text | Undisclosed | [ChEMBL]; [Nemo Gym RL dataset generated from ChEMBL with RDKit] | Undisclosed |
| Synthetic ZINC Chemistry from Nemotron Super v3 | Text | Undisclosed | [ZINC] | [Nemotron Super v3] |
| ARC-AGI Gym Environment | Text | Undisclosed | [ARC-AGI-2] | [ARC-AGI-2] |
| Synthetic Agentic Search Tool-Use from DeepSeek-V3.2 | Text | Undisclosed | [Mercor Data] | [DeepSeek-V3.2] |
| Synthetic Text-To-SQL | Text | 96,564 | [In-house Text-to-SQL data] | [gpt-oss-120b] |
| Dialog Memory Vendor Data | Text | Undisclosed | [Patronus external vendor agreement] | Undisclosed |
| Synthetic Indirect Prompt Injection from Nemotron Super v3 and Qwen3-Next-80B-A3B-Instruct | Text | Undisclosed | [In-house indirect prompt injection data] | [nvidia/nemotron-3-super-v3, qwen/qwen3-next-80b-a3b-instruct] |
| Synthetic Malicious Code and Agentic Security | Text | Undisclosed | [In-house malicious-code / agentic-security data] | Undisclosed |
| Synthetic Single-Step SWE Patch Selection | Text | Undisclosed | [SWE-Gym Dataset]; [SWE Bench Verified Benchmark] | [ground truth and task checks] |
| Synthetic Natural Language Math Final Answers from Nemotron 5.5 | Text | Undisclosed | [AMC8, AMC10, and AIME problem sets hosted on Art of Problem Solving]; [Pile-StackExchange] | [nemotron 5.5] |
| Synthetic Simple Math Prompts for Token Efficiency | Text | Undisclosed | [In-house simple math prompts] | Undisclosed |
| Synthetic Abstention Data from Nemotron Super v3 (CRAG) | Text | Undisclosed | [CRAG] | [nvidia/nvidia/nemotron-3-super-v3] |
| Synthetic Agentless SWE | Text | 242,536 | [SWE-Rebench-V2]; [SWEbench Training Set]; [R2E-Gym/R2E-Gym-Subset]; [SWE-Gym/SWE-Gym]; [SWE-Rebench] | [openai/gpt-oss-120b] |
| Synthetic Agentless SWE from DeepSeek-R1-0528 | Text | 209,976 | [SWE-Bench-Train]; [SWE-Fixer-Train]; [SWE-reBench]; [SWE-Smith] | [deepseek-ai/DeepSeek-R1-0528] |
| Synthetic Agentic CUDA Traces from GLM-4.7 | Text | 2,276 | [Internal CUDA task data] | [GLM-4.7] |
| Synthetic Math Proofs from DeepSeek-V3.2-Speciale | Text | 820,772 | [Nemotron-Math-Proofs-v1] | [SDG: DeepSeek-V3.2-Speciale]; [Filter: proof validation] |
| Synthetic Multilingual SFT from DeepSeek-V3 | Text | 1,245,284 | [Nano v3 SFT data] | [DeepSeek-V3] |
| Synthetic Agentic Code from gpt-oss-120b | Text | 109,086 | [NVAgenticCLIPrompts-v1]; [NVAgenticSkills-v1]; [NVAgenticCLIMultiTurnPrompts-v1] | [openai/gpt-oss-120b] |
| Synthetic Agentic CLI and Web Skills from gpt-oss-120b | Text | 27,418 | [NVAgenticCLIPrompts-v1]; [NVAgenticSkills-v1]; [NVAgenticCLIMultiTurnPrompts-v1]; [NVAgenticCLIPrompts-Web-v1] | [openai/gpt-oss-120b] |
| Synthetic Agentic Coding from gpt-oss-120b | Text | 160,531 | [NVAgenticCLIPrompts-v1]; [NVAgenticSkills-v1]; [NVAgenticCLIMultiTurnPrompts-v1]; [NVAgenticCLIPrompts-Web-v1] | [openai/gpt-oss-120b] |
| Synthetic OpenCode Agentic Tasks from gpt-oss-120b | Text | 614,773 | [NVAgenticCLIPrompts-v1]; [NVAgenticSkills-v1]; [NVAgenticCLIMultiTurnPrompts-v1]; [NVAgenticCLIPrompts-Web-v1] | [openai/gpt-oss-120b] |
| Synthetic SWE Unverified | Text | Undisclosed | [NVAgenticCLIPrompts-v1]; [NVAgenticSkills-v1]; [NVAgenticCLIMultiTurnPrompts-v1]; [NVAgenticCLIPrompts-Web-v1] | [gpt-oss-120b]; [Qwen/Qwen3-Coder-480B-A35B-Instruct]; [GLM-4.7-Flash] |
| Synthetic ARC-AGI Ultra Data | Text | 192,016 | [ARC-AGI-2]; [arc dataset collection] | [ARC-AGI-2] |
| Synthetic LiveCodeBench TIR from DeepSeek-R1-0528 | Text | 1,283,398 | [Nemotron-X training datasets] | [DeepSeek-R1-0528] |
| Synthetic Verilog and SystemVerilog Code from DeepSeek-R1-0528 and GPT-OSS-120B | Text | 1,233,247 | [Verilog/SystemVerilog seed code] | [SDR: DeepSeek R1 0528 and GPT-OSS-120B]; [Filtering: Claude 4 Sonnet] |
| Synthetic Aider Python Tasks from DeepSeek-R1-0528 | Text | 236,099 | [Exercism (GitHub Python)] | [Deepseek R1 0528] |
| Synthetic Chat Reasoning-Off Data from GLM-5 | Text | 646,738 | [lmarena-ai/repochat-arena-preference-4k user prompts] | [Multi-turn conversations generated by GLM-5 with best-of-4 selection via Qwen3-Nemotron-235B-A22B-GenRM] |
| Synthetic Chat Reasoning-On Data from GLM-5 | Text | 644,286 | [lmarena-ai/repochat-arena-preference-4k user prompts]; [lmarena-ai/arena-expert-5k user prompts]; [lmarena-ai/arena-human-preference-55k user prompts]; [lmarena-ai/arena-human-preference-100k user prompts]; [lmarena-ai/arena-human-preference-140k user prompts] | [Multi-turn conversations generated by GLM-5 with best-of-4 selection via Qwen3-Nemotron-235B-A22B-GenRM] |
| Synthetic Multilingual Safety from Riva-Translate-4B-Instruct-v1.1 | Text | 132,067 | [Safety SFT Data: Ultra] | [nvidia/Riva-Translate-4B-Instruct-v1.1] |
| Synthetic Science Reasoning Effort Medium | Text | 502,722 | [science-reasoning-effort-medium-v0] | Undisclosed |
| Synthetic Telecom Tool-Use Trajectories from gpt-oss-120b | Text | 12,455 | [Existing Tau2 telecom trajectories originally generated with DeepSeek V3.2] | [gpt-oss-120b] |
| Synthetic Terminal Bench Data from OpenReasoningv2 | Text | Undisclosed | [OpenCodeReasoningv2]; [OpenMathReasoning]; [nemo-swe-bench-repos]; [SWE-Rebench]; [SWE-Fixer-110K] | [OpenReasoningv2] |
| Synthetic Tulu Instruction Following from DeepSeek-R1-0528 | Text | 105,361 | [Nemotron-X training datasets] | [DeepSeek-R1-0528] |
| Synthetic Instruction Following from gpt-oss-120b | Text | 151,988 | [IFEval]; [IFEvalG] | [gpt-oss-120b] |
| Synthetic Instruction Following for RL | Text | Undisclosed | [WildChat-1M]; [LMSYS-340B-Eval Dataset]; [LMSYS-Chat-1M Prompts]; [IFEval]; [IFEvalG] | [Qwen/Qwen3-235B-A22B-Thinking-2507]; [gpt-oss-120b]; [Qwen3-235B-A22B-Instruct-2507] |
| Synthetic Identity Data from Qwen3-Next-80B-A3B-Instruct and Qwen3-235B-A22B-Instruct-2507 | Text | 25,992 | [Hand-written prompts] | [Qwen3-Next-80B-A3B-Instruct]; [Qwen3-235B-A22B-Instruct-2507] |
| Synthetic Terminus Ultra Agentic Reasoning Blend | Text | 96,881 | [ARC-AGI-2]; [OpenCodeReasoningv2]; [OpenMathReasoning]; [SWE-Fixer-110K]; [SWE-Rebench]; [SWE-Smith] | [DeepSeek-V3.2]; [Qwen3-235B-A22B-Thinking-2507]; [Ring-1T]; [Kimi-K2.5]; [GLM-4.7-FP8]; [Qwen3-Next-80B-A3B-Thinking]; [gpt-oss-120b]; [Ministral-3-14B-Reasoning-2512]; [LM-4.5-Air-FP8] |
| Synthetic STEM from Qwen3-235B-A22B-Thinking-2507 | Text | 1,174,694 | [IChO-IPhO-RL-v2]; [Physics-Big Dataset]; Scale HLE; [OpenMathReasoning]; [OpenCodeReasoning] | [Qwen3-235B-A22B-Thinking-2507] |
| Synthetic STEM from Qwen3-235B-A22B-Instruct-2507 and gpt-oss-120b | Text | Undisclosed | [arXiv]; [National Institutes of Health ExPorter]; [BioRxiv]; [PMC Article]; [USPTO Backgrounds]; [peS2o]; Global Regulation; [CORE]; [PG-19]; [DOAB CC BY & CC BY-SA subset]; [NDLTD] | [Qwen3-235B-A22B-Instruct-2507]; [gpt-oss-120b] |
| Translation Data from TAUS | Text | 1,618,055 | [TAUS proprietary dataset] | Undisclosed |
| Synthetic Art of Problem Solving and Stack Exchange from gpt-oss-120b, Qwen2.5-32B-Instruct, and Goedel-Prover-V2-32B | Text | 860,469 | [Nemotron-Math-Proofs-v1] | [Goedel-Prover-V2-32B] |
| Synthetic Art of Problem Solving and Stack Exchange from gpt-oss-120b | Text | 1,201,815 | [Upstream released math dataset]; [AoPS]; [StackOverflow / StackExchange] | [gpt-oss-120b] |
| Synthetic Multilingual Science and Code data from DeepSeek-R1, DeepSeek-R1-0528, Qwen2.5-32B-Instruct, and Qwen3-235B-A22B, translated with Qwen2.5-32B-Instruct and Qwen2.5-14B-Instruct | Text | Undisclosed | [Nano-V3 SFT Data (without tool call)] | [Qwen/Qwen2.5-14B-Instruct]; [Qwen/Qwen3-4B-Thinking-2507] |
| Synthetic Multilingual Science and Code data from DeepSeek-R1, DeepSeek-R1-0528, Qwen2.5-32B-Instruct, and Qwen3-235B-A22B, translated with Qwen2.5-32B-Instruct and Qwen2.5-14B-Instruct (Stack Exchange lineage) | Text | Undisclosed | [Stack Exchange]; [SCP-116K]; [LIMO]; [TACO]; Code Contest; Codeforces | [DeepSeek-R1]; [DeepSeek-R1-0528]; [Qwen2.5-32B-Instruct]; [Qwen3-235B-A22B] |
| Synthetic Search Graph Walk | Text | 6,977 | [Wikidata / Wikipedia KnowledgeBase] | [MiniMaxAI/MiniMax-M2] |
| Synthetic Agentic Diverse Domains | Text | 281,537 | [Handwritten prompts (synthetic; no external seed data used)] | [SDG model: deepseek-ai/DeepSeek-V3.2, deepseek-ai/DeepSeek-R1-0528, Qwen/Qwen3-235B-A22B-Thinking-2507, Qwen/Qwen3-32B]; [Filtering model: openai/gpt-oss-120b, Qwen/Qwen3-32B, Qwen/Qwen3-235B-A22B-Instruct-2507] |
| Synthetic Long Context from Qwen3-235B-A22B-Instruct-2507 | Text | Undisclosed | [Long-context SFT seed blend (pre-training blend + nano-v1 post-training data)]; [Long-context SFT data: lc_nothink 256k, MRCR 200k, RULER 256k]; [AALCR seed blend: SEC Filings, CC, Wikipedia, FinePDFs, ArXiv, Pile-NIH ExPorter, BioRxiv, PMC Article, USPTO Backgrounds, peS2o, Global Regulations, CORE, Gutenberg (PG-19), DOAB CC-BY, NDLTD, Amps, StackExchange, MathPile, Numinas] | [Qwen/Qwen3-235B-A22B-Thinking-2507]; [deepseek-ai/DeepSeek-R1]; [Qwen3-30B-A3B] |
| Synthetic Nemotron Math SFT from DeepSeek-V3.2-Speciale | Text | 1,900,553 | [Nemotron-Math-v2 (AOPS and StackExchange-math problems)] | [DeepSeek-V3.2-Speciale] |
| Synthetic Nemotron Math TIR from DeepSeek-V3.2 | Text | 1,789,258 | [Nemotron-Math-v2 (AOPS and StackExchange-math problems)] | [DeepSeek-V3.2] |
| Synthetic NemoCascade OCR Distillation from gpt-oss-120b | Text | 682,864 | [Nemotron-X training datasets] | [gpt-oss-120b] |
| Synthetic CUDA 100k | Text | 93,086 | [KernelBook]; [HuggingFace Transformers]; [FlashInfer] | [gpt-oss-120b]; [DeepSeek-R1-0528] |
| Synthetic Science MCQ and QA Diversity from GPT-OSS and Kimi-K2 | Text | 30,358 | [doubtnut]; [Pile-FreeLaw]; [Llama Nemotron Dataset]; [askfilo]; [EssentialAI/essential-web-v1.0]; [Vedantu]; [auxiliary_train]; [cdquestions.com]; [AMC 8 Problems and Solutions, AMC 10 Problems and Solution, and AIME Problems and Solutions]; [AAPT]; [ICHO-IPH0 Dataset]; [LIMO dataset (Less is More for Reasoning)] | [GPT-OSS]; [Kimi-K2] |
| Synthetic Science HLE with Python from GPT-OSS and Kimi-K2 | Text | 85,184 | [doubtnut]; [Pile-FreeLaw]; [Llama Nemotron Dataset]; [askfilo]; [EssentialAI/essential-web-v1.0]; [Vedantu]; [auxiliary_train]; [cdquestions.com]; [AMC 8 Problems and Solutions, AMC 10 Problems and Solution, and AIME Problems and Solutions]; [AAPT]; [ICHO-IPH0 Dataset]; [LIMO dataset (Less is More for Reasoning)] | [GPT-OSS]; [Kimi-K2] |
| Synthetic Science Search and Python from GPT-OSS and Kimi-K2 | Text | 6,179 | [doubtnut]; [Pile-FreeLaw]; [Llama Nemotron Dataset]; [askfilo]; [EssentialAI/essential-web-v1.0]; [Vedantu]; [auxiliary_train]; [cdquestions.com]; [AMC 8 Problems and Solutions, AMC 10 Problems and Solution, and AIME Problems and Solutions]; [AAPT]; [ICHO-IPH0 Dataset]; [LIMO dataset (Less is More for Reasoning)] | [GPT-OSS]; [Kimi-K2] |
| Synthetic Science Search from GPT-OSS and Kimi-K2 | Text | 32,554 | [doubtnut]; [Pile-FreeLaw]; [Llama Nemotron Dataset]; [askfilo]; [EssentialAI/essential-web-v1.0]; [Vedantu]; [auxiliary_train]; [cdquestions.com]; [AMC 8 Problems and Solutions, AMC 10 Problems and Solution, and AIME Problems and Solutions]; [AAPT]; [ICHO-IPH0 Dataset]; [LIMO dataset (Less is More for Reasoning)] | [GPT-OSS]; [Kimi-K2] |
| Synthetic Finance Reasoning from GPT-OSS-120B and Qwen3-235B-A22B-Instruct-2507 | Text | 326,700 | [SEC filings] | [GPT-OSS-120B, Qwen3-235B-A22B-Instruct-2507] |
| Synthetic Science Diversity MCQ from GPT-OSS and Kimi-K2 | Text | 532,942 | [doubtnut]; [Pile-FreeLaw]; [Llama Nemotron Dataset]; [askfilo]; [EssentialAI/essential-web-v1.0]; [Vedantu]; [auxiliary_train]; [cdquestions.com]; [AMC 8 Problems and Solutions, AMC 10 Problems and Solution, and AIME Problems and Solutions]; [AAPT]; [ICHO-IPH0 Dataset]; [LIMO dataset (Less is More for Reasoning)] | [GPT-OSS]; [Kimi-K2] |
| Synthetic Science Diversity OpenQ from GPT-OSS and Kimi-K2 | Text | 131,045 | [doubtnut]; [Pile-FreeLaw]; [Llama Nemotron Dataset]; [askfilo]; [EssentialAI/essential-web-v1.0]; [Vedantu]; [auxiliary_train]; [cdquestions.com]; [AMC 8 Problems and Solutions, AMC 10 Problems and Solution, and AIME Problems and Solutions]; [AAPT]; [ICHO-IPH0 Dataset]; [LIMO dataset (Less is More for Reasoning)] | [GPT-OSS]; [Kimi-K2] |
| Synthetic Science Reasoning No-Tool from GPT-OSS and Kimi-K2 | Text | 2,085,600 | [doubtnut]; [Pile-FreeLaw]; [Llama Nemotron Dataset]; [askfilo]; [EssentialAI/essential-web-v1.0]; [Vedantu]; [auxiliary_train]; [cdquestions.com]; [AMC 8 Problems and Solutions, AMC 10 Problems and Solution, and AIME Problems and Solutions]; [AAPT]; [ICHO-IPH0 Dataset]; [LIMO dataset (Less is More for Reasoning)] | [GPT-OSS]; [Kimi-K2] |
| Synthetic Text-To-SQL from gpt-oss-120b | Text | Undisclosed | [In-house Text-to-SQL data] | [gpt-oss-120b] |
| Synthetic Tool Call Schema for RL (extended) | Text | 707,967 | [UltraTool]; [ToolEyes]; [AutoTools]; [API-Bank]; [Nemotron-Personas-USA]; [Salesforce xLAM function-calling]; [Glaive function-calling-v2]; [Agent-Ark/Toucan-1.5M] | [DeepSeek-V3.2]; [GLM-4.6]; [gpt-oss-120b]; [Kimi-K2-Instruct] |
| Synthetic Safety from gemma-3-4b-it, Nemotron-Nano-9B-v2, and gpt-oss-120b | Text | 44,091 | [Safety SFT Data] | [google/gemma-3-4b-it]; [Nemotron-Nano-9B-v2]; [gpt-oss-120b] |
| Synthetic Safety from DeepSeek-R1-0528, gpt-oss-120b, DeepSeek-R1-Distill-Qwen-7B, and Mixtral-8x7B-v0.1 | Text | Undisclosed | [Nemotron Content Safety Dataset V2]; [Gretel Synthetic Safety Alignment Dataset]; [RedTeam-2K]; [Malicious Tasks]; [Nemotron-Personas-USA] | [DeepSeek-R1-0528]; [gpt-oss-120b]; [DeepSeek-R1-Distill-Qwen-7B]; [Qwen3-30B-A3B-Thinking-2507]; [Qwen3-235B-A22B-Instruct-2507]; [Mixtral-8x7B-v0.1] |
| Synthetic Tool Calling from Qwen3-235B-A22B-Thinking-2507 and Qwen3-Next-80B-A3B-Thinking | Text | Undisclosed | [ToolBench]; [glaive-function-calling-v2]; [APIGen Function-Calling]; [Nemotron-Personas-USA] | [Qwen3-235B-A22B-Thinking-2507]; [Qwen3-Next-80B-A3B-Thinking] |
| Synthetic Chat from gpt-oss-120b, Mixtral-8x22B-Instruct-v0.1, Qwen3-235B-A22B-Instruct-2507, and Qwen3-235B-A22B-Thinking-2507 | Text | Undisclosed | [C4]; [LMSYS-Chat-1M]; [ShareGPT]; [GSM8K]; [PRM800K]; [FinQA]; [WikiTableQuestions]; [Riddles]; [glaive-function-calling-v2]; [SciBench]; [tigerbot-kaggle-leetcodesolutions-en-2k]; [OpenBookQA]; [Advanced Reasoning Benchmark]; Software Heritage; [Khan Academy Math Keywords]; [WildChat-1M]; [Nemotron-Personas-USA] | [gpt-oss-120b]; [Mixtral-8x22B-Instruct-v0.1]; [Qwen3-235B-A22B-Instruct-2507]; [Qwen3-235B-A22B-Thinking-2507] |
| Synthetic Tool Use Interactive Agent from gpt-oss-120b, DeepSeek-R1-0528, Qwen3-32B, and Qwen3-235B-A22B-Thinking-2507 | Text | Undisclosed | NVIDIA Internal | [gpt-oss-120b]; [DeepSeek-R1-0528]; [Qwen3-32B]; [Qwen3-235B-A22B-Thinking-2507] |
| Synthetic DocFinQA and SWE-smith from Qwen3-Coder-480B-A35B-Instruct and Kimi-K2-Thinking | Text | Undisclosed | [DocFinQA]; [SWE-smith] | [Qwen3-Coder-480B-A35B-Instruct]; [Kimi-K2-Thinking] |
| Synthetic SWE-Gym from Qwen3-Coder-480B-A35B-Instruct | Text | Undisclosed | [SWE-Gym] | [Qwen3-Coder-480B-A35B-Instruct] |
| Synthetic SWE-Gym and R2E-Gym-Subset from Qwen3-Coder-480B-A35B-Instruct | Text | Undisclosed | [SWE-Gym]; [R2E-Gym-Subset] | [Qwen3-Coder-480B-A35B-Instruct] |
| Synthetic SWE-Gym and R2E-Gym-Subset from DeepSeek-R1-0528 | Text | Undisclosed | [SWE-Gym]; [R2E-Gym-Subset] | [DeepSeek-R1-0528] |
| Synthetic HelpSteer, LMSYS-Chat-1M, and Nemotron-Personas-USA from gpt-oss-120b, Qwen3-235B-A22B-Instruct-2507, and Qwen3-235B-A22B-Thinking-2507 | Text | Undisclosed | [HelpSteer2]; [HelpSteer3]; [LMSYS-Chat-1M]; [Nemotron-Personas-USA] | [gpt-oss-120b]; [Qwen3-235B-A22B-Instruct-2507]; [Qwen3-235B-A22B-Thinking-2507] |
| Synthetic Nemotron-Personas-USA from gpt-oss-120b and Qwen3-8B | Text | Undisclosed | [Nemotron-Personas-USA] | [gpt-oss-120b]; [Qwen3-8B] |
| Vendor Terminal Bench-like Tasks (Droid) | Text | Undisclosed | [Droid Harness Pivot vendor data] | Undisclosed |

#### Language Distribution in Post-Training

For our post-training recipe, we focused on the following languages in addition to English: French, German, Italian, Japanese, Spanish, and Chinese. Those languages were represented in the form of multilingual reasoning and translation tasks.

</details>

## Testing Datasets

**Data Collection Method by dataset** <br>
* Hybrid: Automated, Manually-Collected, Synthetic

**Labeling Method by dataset** <br>
* Hybrid: Automated, Manually-Labeled, Synthetic

**Properties:** This corpus comprises a mix of high-quality standard benchmarks and test suites for modern agentic AI. These benchmarks test model capabilities on tasks such as tool-calling and instruction following.

## Evaluation Datasets

**Data Collection Method by dataset** <br>
* Hybrid: Automated, Manually-Collected, Synthetic

**Labeling Method by dataset** <br>
* Hybrid: Automated, Manually-Labeled, Synthetic

**Properties:** This corpus comprises a mix of high-quality standard benchmarks and test suites for modern agentic AI. These benchmarks test model capabilities on tasks such as tool-calling and instruction following.

## Inference

* **Acceleration Engine:** PyTorch
* **Test Hardware:**
    * NVIDIA Hopper
      - 1-8x H100
      - 1-8x H200
    * NVIDIA Blackwell
      - GB200
      - GeForce RTX 5090
      - DGX Spark
      - RTX Spark
    * NVIDIA Jetson
      - Jetson Orin
      - Jetson Thor

## Ethical Considerations

NVIDIA believes Trustworthy AI is a shared responsibility and we have established policies and practices to enable development for a wide array of AI applications. Developers should work with their internal model team to ensure this model meets requirements for the relevant industry and use case and addresses unforeseen product misuse.

We advise against circumvention of any provided safety guardrails contained in the Model without a substantially similar guardrail appropriate for your use case. For more details: [Safety](./safety.md) and [Explainability](./explainability.md) Subcards.

For more detailed information on ethical considerations for this model, please see the Model Card++ [Bias](./bias.md), [Explainability](./explainability.md), [Safety & Security](./safety.md), and [Privacy](./privacy.md) Subcards.

Please report model quality, risk, security vulnerabilities or NVIDIA AI Concerns [here](https://www.nvidia.com/en-us/support/submit-security-vulnerability/).
