---
library_name: transformers
license: other
license_name: lfm1.0
license_link: https://huggingface.co/LiquidAI/LFM2.5-8B-A1B/blob/main/LICENSE
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
pipeline_tag: text-generation
tags:
- liquid
- unsloth
- lfm2.5
- edge
base_model:
- LiquidAI/LFM2.5-8B-A1B
---

## Updated from Liquid's chat template update

<div>
<p style="margin-top: 0;margin-bottom: 0;">
    <em><a href="https://docs.unsloth.ai/basics/unsloth-dynamic-v2.0-gguf">Unsloth Dynamic 2.0</a> achieves superior accuracy & outperforms other leading quants.</em>
  </p>
  <div style="display: flex; gap: 5px; align-items: center; ">
    <a href="https://github.com/unslothai/unsloth/">
      <img src="https://github.com/unslothai/unsloth/raw/main/images/unsloth%20new%20logo.png" width="133">
    </a>
    <a href="https://discord.gg/unsloth">
      <img src="https://github.com/unslothai/unsloth/raw/main/images/Discord%20button.png" width="173">
    </a>
    <a href="https://docs.unsloth.ai/">
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
    <a href="https://leap.liquid.ai/"><strong>LEAP</strong></a> • 
    <a href="https://discord.com/invite/liquid-ai"><strong>Discord</strong></a>
  </div>
</div>


# LFM2.5-8B-A1B

LFM2.5 is a new family of hybrid models designed for on-device deployment. It builds on the LFM2 architecture with extended pre-training and reinforcement learning.

- **On-device personal assistant**: Designed to power real-life applications, chaining tool calls, and following complex instructions on all devices.
- **Compressed performance**: Competitive with much larger dense and MoE models on instruction following and agentic tasks.
- **Unmatched throughput**: Fastest in its size class on both CPU and GPU inference, with day-one support for llama.cpp, MLX, vLLM, and SGLang.

Find more information about LFM2.5-8B-A1B in our [blog post](https://www.liquid.ai/blog/lfm2-5-8b-a1b).

![image](https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/qUZVGkns1bg3sZUShBbhv.png)

**AA-Omniscience Index (higher is better) rewards correct answers and penalizes hallucinations. Scores range from -100 to 100. See more results on [Artificial Analysis](https://artificialanalysis.ai/evaluations/omniscience).*

## 🗒️ Model Details

| Model | Parameters | Description |
| --- | --- | --- |
| [LFM2.5-8B-A1B-Base](https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-Base) | 8.3B total / 1.5B active | Pre-trained base model for fine-tuning |
| [**LFM2.5-8B-A1B**](https://huggingface.co/LiquidAI/LFM2.5-8B-A1B) | 8.3B total / 1.5B active | Reasoning-tuned general-purpose model |

LFM2.5-8B-A1B is a general-purpose text-only model with the following features:

- **Total parameters**: 8.3B
- **Active parameters**: 1.5B
- **Number of layers**: 24 (18 double-gated LIV conv + 6 GQA)
- **Training budget**: 38 trillion tokens
- **Context length**: 131,072
- **Vocabulary size**: 128,000
- **Languages**: English, Arabic, Chinese, French, German, Japanese, Korean, Portuguese, Spanish
- **Generation parameters**: We recommend the following parameters:
  - `temperature: 0.2`
  - `top_k: 80`
  - `repetition_penalty: 1.05`

| Model | Description |
| --- | --- |
| [**LFM2.5-8B-A1B**](https://huggingface.co/LiquidAI/LFM2.5-8B-A1B) | Original model checkpoint in native format. Best for fine-tuning or inference with Transformers, vLLM, and SGLang. |
| [LFM2.5-8B-A1B-GGUF](https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-GGUF) | Quantized format for llama.cpp and compatible tools. Optimized for edge inference and local deployment. |
| [LFM2.5-8B-A1B-ONNX](https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-ONNX) | ONNX Runtime format for cross-platform deployment. |
| [LFM2.5-8B-A1B-MLX](https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-MLX-8bit) | MLX format for Apple Silicon. Optimized for fast inference on Mac devices. |

We recommend using LFM2.5-8B-A1B for agentic workflows, tool use, structured outputs, multilingual assistants, and on-device personal-assistant applications. It is not the best fit for heavy programming or knowledge-intensive question answering without retrieval.

### Chat Template

LFM2.5 uses a ChatML-like format. See the [Chat Template documentation](https://docs.liquid.ai/lfm/key-concepts/chat-template) for details. Example:

```
<|startoftext|><|im_start|>system
You are a helpful assistant trained by Liquid AI.<|im_end|>
<|im_start|>user
What is C. elegans?<|im_end|>
<|im_start|>assistant
```

Because LFM2.5-8B-A1B is a reasoning model, assistant turns contain an explicit chain of thought before the final answer. You can use [`tokenizer.apply_chat_template()`](https://huggingface.co/docs/transformers/en/chat_templating#using-applychattemplate) to format your messages automatically.

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

## 🏃 Inference

LFM2.5-8B-A1B is supported by many inference frameworks. See the [Inference documentation](https://docs.liquid.ai/lfm/inference/transformers) for the full list.

| Name | Description | Docs | Notebook |
|------|-------------|------|:--------:|
| [Transformers](https://github.com/huggingface/transformers) | Simple inference with direct access to model internals. | <a href="https://docs.liquid.ai/lfm/inference/transformers">Link</a> | <a href="https://colab.research.google.com/drive/1_q3jQ6LtyiuPzFZv7Vw8xSfPU5FwkKZY?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |
| [vLLM](https://github.com/vllm-project/vllm) | High-throughput production deployments with GPU. | <a href="https://docs.liquid.ai/lfm/inference/vllm">Link</a> | <a href="https://colab.research.google.com/drive/1VfyscuHP8A3we_YpnzuabYJzr5ju0Mit?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | Cross-platform inference with CPU offloading. | <a href="https://docs.liquid.ai/lfm/inference/llama-cpp">Link</a> | <a href="https://colab.research.google.com/drive/1ohLl3w47OQZA4ELo46i5E4Z6oGWBAyo8?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |
| [MLX](https://github.com/ml-explore/mlx) | Apple's machine learning framework optimized for Apple Silicon. | <a href="https://docs.liquid.ai/lfm/inference/mlx">Link</a> | — |
| [LM Studio](https://lmstudio.ai/) | Desktop application for running LLMs locally. | <a href="https://docs.liquid.ai/lfm/inference/lm-studio">Link</a> | — |

Quick start with Transformers (compatible with `transformers>=5.0.0`):

```python
from transformers import AutoModelForCausalLM, AutoTokenizer, TextStreamer

model_id = "LiquidAI/LFM2.5-8B-A1B"
model = AutoModelForCausalLM.from_pretrained(
    model_id,
    device_map="auto",
    dtype="bfloat16",
#   attn_implementation="flash_attention_2" <- uncomment on compatible GPU
)
tokenizer = AutoTokenizer.from_pretrained(model_id)
streamer = TextStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)

prompt = "What is C. elegans?"

input_ids = tokenizer.apply_chat_template(
    [{"role": "user", "content": prompt}],
    add_generation_prompt=True,
    return_tensors="pt",
    tokenize=True,
).to(model.device)

output = model.generate(
    input_ids,
    do_sample=True,
    temperature=0.2,
    top_k=80,
    repetition_penalty=1.05,
    max_new_tokens=8192,
    streamer=streamer,
)
```

## 🔧 Fine-Tuning

We recommend fine-tuning LFM2.5 for your specific use case to achieve the best results.

| Name | Description | Docs | Notebook |
|------|-------------|------|----------|
| CPT ([Unsloth](https://github.com/unslothai/unsloth)) | Continued Pre-Training using Unsloth for text completion. | <a href="https://docs.liquid.ai/lfm/fine-tuning/unsloth">Link</a> | <a href="https://colab.research.google.com/drive/10fm7eNMezs-DSn36mF7vAsNYlOsx9YZO?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |
| CPT ([Unsloth](https://github.com/unslothai/unsloth)) | Continued Pre-Training using Unsloth for translation. | <a href="https://docs.liquid.ai/lfm/fine-tuning/unsloth">Link</a> | <a href="https://colab.research.google.com/drive/1gaP8yTle2_v35Um8Gpu9239fqbU7UgY8?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |
| SFT ([Unsloth](https://github.com/unslothai/unsloth)) | Supervised Fine-Tuning with LoRA using Unsloth. | <a href="https://docs.liquid.ai/lfm/fine-tuning/unsloth">Link</a> | <a href="https://colab.research.google.com/drive/1vGRg4ksRj__6OLvXkHhvji_Pamv801Ss?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |
| SFT ([TRL](https://github.com/huggingface/trl)) | Supervised Fine-Tuning with LoRA using TRL. | <a href="https://docs.liquid.ai/lfm/fine-tuning/trl">Link</a> | <a href="https://colab.research.google.com/drive/1j5Hk_SyBb2soUsuhU0eIEA9GwLNRnElF?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |
| DPO ([TRL](https://github.com/huggingface/trl)) | Direct Preference Optimization with LoRA using TRL. | <a href="https://docs.liquid.ai/lfm/fine-tuning/trl">Link</a> | <a href="https://colab.research.google.com/drive/1MQdsPxFHeZweGsNx4RH7Ia8lG8PiGE1t?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |
| GRPO ([Unsloth](https://github.com/unslothai/unsloth)) | GRPO with LoRA using Unsloth. | <a href="https://docs.liquid.ai/lfm/fine-tuning/unsloth">Link</a> | <a href="https://colab.research.google.com/drive/1mIikXFaGvcW4vXOZXLbVTxfBRw_XsXa5?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |
| GRPO ([TRL](https://github.com/huggingface/trl)) | GRPO with LoRA using TRL. | <a href="https://docs.liquid.ai/lfm/fine-tuning/trl">Link</a> | <a href="https://colab.research.google.com/github/Liquid4All/cookbook/blob/main/finetuning/notebooks/grpo_for_verifiable_tasks.ipynb"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |

## 📊 Performance

### Improvements over LFM2-8B-A1B

Thanks to reasoning, scaled-up pre-training, and large-scale RL, LFM2.5-8B-A1B improves over its predecessor across the board:

| Benchmark | LFM2-8B-A1B | LFM2.5-8B-A1B | Δ |
| :--- | ---: | ---: | ---: |
| AA-Omniscience Index | -78.42 | -24.70 | +53.62 |
| AA-Omniscience Accuracy | 7.33 | 8.67 | +1.34 |
| AA-Omniscience Non-Hallucination Rate | 7.46 | 63.47 | +56.01 |
| IFEval | 79.44 | 91.84 | +12.40 |
| IFBench | 26.00 | 56.47 | +30.47 |
| Multi-IF | 58.54 | 79.93 | +21.39 |
| MATH500 | 74.80 | 88.76 | +13.96 |
| AIME25 | 20.00 | 42.53 | +22.53 |
| BFCLv3 | 45.07 | 64.36 | +19.29 |
| BFCLv4 | 25.52 | 48.50 | +22.98 |
| Tau² Telecom | 13.60 | 88.07 | +74.47 |
| Tau² Retail | 7.02 | 39.82 | +32.80 |

### Knowledge and instruction following

| Model | Parameters | AA-Omni. Index | AA-Omni. Accuracy | AA-Omni. Non-Halluc. | IFEval | IFBench | Multi-IF |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| LFM2.5-8B-A1B | 8B/A1B | -24.70 | 8.67 | 63.47 | 91.84 | 56.47 | 79.93 | |
| Granite-4.0-H-Tiny | 7B/A1B | -75.50 | 9.37 | 6.38 | 82.23 | 21.28 | 59.00 | |
| Qwen3.5-4B | 4B | -51.53 | 17.20 | 16.99 | 87.80 | 50.38 | 67.43 | |
| Qwen3-30B-A3B-Thinking-2507 | 30.5B/3.3B | -51.31 | 18.80 | 13.87 | 90.82 | 51.11 | 79.04 | |
| Gemma-4-E2B-IT | 5.1B | -72 | 7.00 | 15.05 | 82.93 | 33.53 | 69.70 | |
| Gemma-4-E4B-IT | 8B | -50.67 | 8.10 | 36.06 | 87.74 | 39.48 | 77.58 | |
| Gemma-4-26B-A4B-IT | 26B/4B | -62.07 | 14.37 | 10.75 | 91.40 | 47.25 | 82.06 | |
| gpt-oss-20b | 21B/3.6B | -49.17 | 14.57 | 24.50 | 86.73 | 58.65 | 76.64 | |

### Math and agentic workflows

| Model | Parameters | MATH500 | AIME25 | AIME26 | BFCLv3 | BFCLv4 | Tau² Telecom | Tau² Retail |
|---|---|---|---|---|---|---|---|---|
| LFM2.5-8B-A1B | 8B/A1B | 88.76 | 42.53 | 50.00 | 64.79 | 49.73 | 88.07 | 39.82 |
| Granite-4.0-H-Tiny | 7B/A1B | 59.20 | 4.93 | 3.33 | 56.89 | 28.52 | 16.67 | 18.42 |
| Qwen3.5-4B | 4B | 80.76 | 54.28 | 58.33 | 71.06 | 54.01 | 87.72 | 71.93 |
| Qwen3-30B-A3B-Thinking-2507 | 30.5B/3.3B | 86.48 | 71.67 | 66.67 | 73.39 | 50.53 | 21.93 | 56.14 |
| Gemma-4-E2B-IT | 5.1B | 64.00 | 26 | 30 | 56.44 | 31.91 | 22.37 | 18.95 |
| Gemma-4-E4B-IT | 8B | 65.00 | 34.33 | 40.67 | 57.31 | 33.92 | 26.75 | 42.11 |

### CPU Inference

![image](https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/yWAChLNCguGTl9lXBL47p.png)

### GPU Inference

LFM2.5-8B-A1B is the fastest model in its size class, reaching **18.5K output tokens per second at high concurrency**, over 1.6B tokens per day on a single H100.

![image](https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/LX3oIXQeDm51eaLQs64an.png)

## 📬 Contact

- Got questions or want to connect? [Join our Discord community](https://discord.com/invite/liquid-ai).
- If you are interested in custom solutions with edge deployment, please contact [our sales team](https://www.liquid.ai/contact).

## Citation

```bibtex
@article{liquidAI20268BA1B,
  author  = {Liquid AI},
  title   = {LFM2.5-8B-A1B: Personal Assistant On Your Laptop},
  journal = {Liquid AI Blog},
  year    = {2026},
  note    = {www.liquid.ai/blog/lfm2-5-8b-a1b},
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