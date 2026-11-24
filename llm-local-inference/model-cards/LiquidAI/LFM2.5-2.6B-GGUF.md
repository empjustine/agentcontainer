---
library_name: gguf
license: other
license_name: lfm1.0
license_link: LICENSE
language:
- ar
- zh
- en
- fr
- de
- hi
- id
- it
- ja
- ko
- pl
- pt
- ru
- es
- th
- vi
pipeline_tag: text-generation
base_model: LiquidAI/LFM2.5-2.6B
tags:
- liquid
- lfm2.5
- gguf
- llama.cpp
---

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

# LFM2.5-2.6B-GGUF

LFM2.5 is a new family of hybrid models designed for **on-device deployment**. It builds on the LFM2 architecture with extended pre-training and reinforcement learning.

Find more details in the original model card: https://huggingface.co/LiquidAI/LFM2.5-2.6B

## 🏃 How to run LFM2

Example usage with [llama.cpp](https://github.com/ggml-org/llama.cpp):

```
llama-cli -hf LiquidAI/LFM2.5-2.6B-GGUF --conversation \
    --temp 0.1 --top-k 50 --repeat-penalty 1.1
```

## QAD Q4_0 GGUF

The Quantization-Aware Distillation (QAD) checkpoint is available as
[`LFM2.5-2.6B-QAD-Q4_0.gguf`](https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF/blob/main/LFM2.5-2.6B-QAD-Q4_0.gguf).

This is distinct from the post-training-quantized `LFM2.5-2.6B-Q4_0.gguf`;
both use the GGUF Q4_0 format.

## QAD source weights (safetensors)

The original FP32 QAD source checkpoint is available in
[`qad/`](https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF/tree/main/qad), with its model config,
tokenizer, generation defaults, and the same chat template as the released QAD GGUF.
It can be loaded in Transformers by passing `subfolder="qad"`:

```python
from transformers import AutoModelForCausalLM, AutoTokenizer

repo_id = "LiquidAI/LFM2.5-2.6B-GGUF"
tokenizer = AutoTokenizer.from_pretrained(repo_id, subfolder="qad")
model = AutoModelForCausalLM.from_pretrained(
    repo_id, subfolder="qad", dtype="auto", device_map="auto"
)

inputs = tokenizer.apply_chat_template(
    [{"role": "user", "content": "What is 2 + 2?"}],
    tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors="pt",
).to(model.device)
outputs = model.generate(**inputs, max_new_tokens=128)
print(tokenizer.decode(outputs[0, inputs["input_ids"].shape[-1]:], skip_special_tokens=True))
```

These weights are intended for fine-tuning and experimentation. Published QAD
results apply to the Q4_0 GGUF; direct FP32/BF16 inference and other quantization
formats may behave differently. See the [source checkpoint documentation](qad/README.md)
for validation details and the license.

