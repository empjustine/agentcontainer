---
base_model:
- LiquidAI/LFM2.5-VL-3B
library_name: transformers
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
pipeline_tag: image-text-to-text
tags:
- liquid
- unsloth
- lfm2.5
- edge
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

# LFM2.5-VL-3B

LFM2.5-VL-3B is a multimodal variant of LFM2.5, a family of hybrid models designed for **on-device deployment**. It builds on LFM2-VL-3B with further mid- and post-training. LFM2.5-VL-3B can process both text and images, and uses the LFM2.5-2.6B language model as its backbone, combined with a SigLIP2 NaFlex vision encoder.

* **Better grounding**: Improved grounding and object detection with natural language queries.
* **Better OCR**: Full page OCR with layout annotation. See [layout annotation format](#layout-annotation-format) for more information.
* **Efficient inference**: 228 tok/s on an Apple M5 Max and 116 tok/s on an AMD Ryzen AI Max+ 395, in under 3.3 GB of memory.

Find more information about LFM2.5-VL-3B in our [release post](https://www.liquid.ai/blog/lfm2-5-vl-3b).

![lfm2_5_vl_3b_task_group_averages](https://cdn-uploads.huggingface.co/production/uploads/644249b08443bce4c9890a0f/xw2m32B8IA0mRbhn_KG7f.png)

> [!NOTE]
> 💻 **Demos**: Try LFM2.5-VL-3B's vision understanding capabilities in a Hugging Face space without any setup:
> **[Vision-capable chat in your browser](https://huggingface.co/spaces/LiquidAI/LFM2.5-VL-3B-WebGPU)**: allows you to upload images or use the webcam to capture images and let the model interact with them, as well as use tool calls and display generated bounding boxes. If you just want to chat about images, the [LiquidAI playground](http://playground.liquid.ai/chat?model=lfm2.5-vl-3b) is a fast way to do that.

## Model Details

| Model | Description |
|-------|-------------|
| **[LFM2.5&#8209;VL&#8209;3B](https://huggingface.co/LiquidAI/LFM2.5-VL-3B)** | Original checkpoint in native format. Best for fine-tuning and inference with HF Transformers, vLLM and SGLang |
| **[LFM2.5&#8209;VL&#8209;3B&#8209;GGUF](https://huggingface.co/LiquidAI/LFM2.5-VL-3B-GGUF)** | Quantized GGUF exports of the original checkpoint. Best for CPU inference with reduced memory usage with llama.cpp |
| **[LFM2.5&#8209;VL&#8209;3B&#8209;ONNX](https://huggingface.co/LiquidAI/LFM2.5-VL-3B-ONNX)** | Quantized ONNX exports for cross-platform deployment. Enables hardware-accelerated inference across diverse environments (cloud, edge, mobile). See the [demo](https://huggingface.co/spaces/LiquidAI/LFM2.5-VL-3B-WebGPU). |
| **[LFM2.5-VL-3B-MLX](https://huggingface.co/LiquidAI/LFM2.5-VL-3B-MLX-8bit)** | Quantized MLX exports for Apple Silicon. Optimized for fast inference on Mac devices using the [mlx-vlm](https://github.com/Blaizzy/mlx-vlm) framework. |

- **LM Backbone**: LFM2.5-2.6B
- **Vision encoder**: SigLIP2 NaFlex shape‑optimized 400M
- **Vocabulary size:** 128,000
- **Context length**: 32,768 tokens
- **Languages**: English, Arabic, Chinese, French, German, Italian, Japanese, Korean, Portuguese, Spanish, Vietnamese, Thai, Indonesian, Hindi, Russian, Polish
- **Native resolution processing**: Uses SigLIP2's NaFlex; large images are split into non-overlapping 512×512 patches and a resized whole-image thumbnail.
- **Generation parameters**:
  - text: `temperature=0.2`, `top_k=50`, `repetition_penalty=1.0`
  - vision: Use the `processor_config.json` file.

We recommend using it for single-turn, high-throughput, low-latency tasks; for example, for near-realtime object detection in automotive applications, batch processing scanned documents with OCR with layout information for turning PDFs into searchable text, or for on-device translation of menus and road signs into your native language.

It is not recommended for long-context, reasoning-intensive tasks, such as visual web design, or answering highly technical questions about blueprints.

### Chat Template

LFM2.5 uses a ChatML-like format. See the [Chat Template documentation](https://docs.liquid.ai/lfm/key-concepts/chat-template#vision-models) for details. Example:

```
<|startoftext|><|im_start|>system
You are a helpful assistant trained by Liquid AI.<|im_end|>
<|im_start|>user
What species is in this picture?<image><|im_end|>
<|im_start|>assistant
```

You can use [`tokenizer.apply_chat_template()`](https://huggingface.co/docs/transformers/en/chat_templating#using-applychattemplate) to format your messages automatically.

> [!TIP]
> **Note**: The `apply_chat_template()` method automatically inserts the `<image>` tag for each image in your message. Do not include `<image>` in your message content.

## Inference

LFM2.5-VL is supported by many inference frameworks. See the [Inference documentation](https://docs.liquid.ai/lfm/inference/transformers) for the full list.

| Name | Description | Docs | Notebook |
|------|-------------|------|----------|
| [Transformers](https://github.com/huggingface/transformers) | Simple inference with direct access to model internals. | <a href="https://docs.liquid.ai/lfm/inference/transformers#vision-models">Link</a>| <a href="https://colab.research.google.com/drive/1WVQpf4XrHgHFkP0FnlZfx2nK8PugvQNZ?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |
| [vLLM](https://github.com/vllm-project/vllm) | High-throughput production deployments with GPU. | <a href="https://docs.liquid.ai/deployment/gpu-inference/vllm#vision-models">Link</a> | <a href="https://colab.research.google.com/drive/1sUfQlqAvuAVB4bZ6akYVQPGmHtTDUNpF?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |
| [SGLang](https://github.com/sgl-project/sglang) | High-throughput production deployments with GPU. | <a href="https://docs.liquid.ai/deployment/gpu-inference/sglang#vision-models">Link</a> | <a href="https://colab.research.google.com/drive/1qJlAFag223yFOZGzuMIkYUFhybM9ao5g?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | Cross-platform inference with CPU offloading. | <a href="https://docs.liquid.ai/lfm/inference/llama-cpp#vision-models">Link</a> | <a href="https://colab.research.google.com/drive/1q2PjE6O_AahakRlkTNJGYL32MsdUcj7b?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="Colab link"></a> |

### Quick start
Quick start with Transformers (compatible with `transformers>=5.0.0`):

You will need `torch`, `transformers`, and `torchvision`.

```python
import torch
from transformers import AutoModelForImageTextToText, AutoProcessor

model_id = "LiquidAI/LFM2.5-VL-3B"

model = AutoModelForImageTextToText.from_pretrained(model_id, dtype=torch.bfloat16)
processor = AutoProcessor.from_pretrained(model_id)

messages = [
    {
        "role": "user",
        "content": [
            {"type": "image", "url": "https://placecats.com/300/200"},
            {"type": "text", "text": "Describe this image."},
        ],
    }
]

inputs = processor.apply_chat_template(
    messages,
    add_generation_prompt=True,
    tokenize=True,
    return_dict=True,
    return_tensors="pt",
).to(model.device)

with torch.inference_mode():
    output_ids = model.generate(
        **inputs,
        do_sample=True,
        temperature=0.2,
        top_k=50,
        repetition_penalty=1.0,
        max_new_tokens=256,
    )

generated_ids = output_ids[:, inputs["input_ids"].shape[1] :]
print(processor.batch_decode(generated_ids, skip_special_tokens=True)[0])
```

### Tool Use

LFM2.5-VL-3B supports function calling in four steps:

1. **Function definition**: Provide the list of tools as a JSON object in the system prompt, or use [`tokenizer.apply_chat_template()`](https://huggingface.co/docs/transformers/en/chat_extras#passing-tools) with `tools=...`.
2. **Function call**: By default, LFM2.5 writes Pythonic function calls (a Python list between `<|tool_call_start|>` and `<|tool_call_end|>` special tokens), as the assistant answer.
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

### Layout Annotation Format

LFM2.5-VL-3B can do OCR with layout annotation. The layout annotation is a list of regions, each with a label, bounding box, and content. The format is:

```text
image_index=<n> <label> [xmin, ymin, xmax, ymax]
<content>

image_index=<n> <label> [xmin, ymin, xmax, ymax]
<content>

image_index=<n> <label> [xmin, ymin, xmax, ymax]
<content>

...
```

where:

- `image_index` is the zero-based index of image
- `<label>` is one of these layout labels:
  - text
  - title
  - list
  - table
  - table_caption
  - table_footnote
  - image
  - image_block
  - image_caption
  - image_footnote
  - chart
  - equation
  - formula_number
  - code
  - code_caption
  - algorithm
  - aside_text
  - ref_text
  - phonetic
  - page_header
  - page_footer
  - page_number
  - page_footnote
- `[xmin, ymin, xmax, ymax]` are normalized integer coordinates in [0, 1000], same as our grounding format.
- `<content>` is the region's content:
  - plain text for text regions
  - LaTeX for equations
  - OTSL (Optimized Table Structure Language, introduced [here](https://arxiv.org/pdf/2305.03393) by IBM) for tables
  - a short description for images and charts

There will be a blank line between each region.

To prompt the model to generate this structured output, use a system or user prompt that includes this:

```text
Parse this document into its layout regions. The pages are provided as images in reading order. For every region, in reading order across all pages, output a header line immediately followed by the region's content:

image_index=<n> <label> [xmin, ymin, xmax, ymax]
<content>

where:
- image_index is the zero-based index of the page image the region appears on (0 for the first image, 1 for the second, and so on)
- <label> is one of these layout labels: text, title, list, table, table_caption, table_footnote, image, image_block, image_caption, image_footnote, chart, equation, formula_number, code, code_caption, algorithm, aside_text, ref_text, phonetic, page_header, page_footer, page_number, page_footnote
- [xmin, ymin, xmax, ymax] are normalized integer coordinates in [0, 1000]
- <content> is the region's content: plain text for text regions, LaTeX for equations, OTSL for tables, and a short description for images and charts

Separate each region block with one blank line. Return only the parsed regions.
```

*Note that the layout annotation format is still experimental: it may change, may be unreliable, and may not be trivial to parse. We encourage users to try it out and provide feedback!*

## Fine-Tuning

We recommend fine-tuning LFM2.5-VL models for your specific use case to achieve the best results.

| Notebook  | Description                                                          | Link |
|-----------|----------------------------------------------------------------------|------|
| SFT (Unsloth) | Supervised Fine-Tuning with LoRA using Unsloth. | <a href="https://colab.research.google.com/drive/1FaR2HSe91YDe88TG97-JVxMygl-rL6vB?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="https://colab.research.google.com/github/Liquid4All/cookbook/blob/main/finetuning/notebooks/sft_for_vision_language_model.ipynb"></a> |
| SFT (TRL) | Supervised Fine-Tuning with LoRA using TRL. | <a href="https://colab.research.google.com/drive/10530_jt_Joa5zH2wgYlyXosypq1R7PIz?usp=sharing"><img src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/vlOyMEjwHa_b_LXysEu2E.png" width="110" alt="https://colab.research.google.com/github/Liquid4All/cookbook/blob/main/finetuning/notebooks/sft_for_vision_language_model_with_trl.ipynb"></a>|

## Performance

### Benchmarks

LFM2.5-VL-3B significantly improves over LFM2-VL-3B in screen understanding, grounding, multi-image input, and tool use:

| Benchmark | **LFM2.5&#8209;VL&#8209;3B (3.1B)** | LFM2&#8209;VL&#8209;3B (3.1B) | Gemma4&nbsp;E2B (5.1B) | Gemma4&nbsp;E4B (8B) | InternVL&nbsp;3.5&nbsp;4B (4.7B) | Qwen3.5-2B (2.3B) | Qwen3.5-4B (4.7B) |
|-----------|--------------------------|--------------------|-------------------|-----------------|-------------------------|--------------------|--------------------|
| ScreenSpot-v2 (avg) | <ins>80.7</ins> | - | 31.1 | 50.9 | **84.2** | 66.5 | 78.5 |
| RefCOCO (Macro&nbsp;Prec@1) | <ins>87.9</ins> | 57.1<br>(<span style="color: red;">-30.8</span>) | 67.3 | 72.1 | **88.9** | 78.5 | 86.6 |
| BLINK | <ins>61.5</ins> | 50.2<br>(<span style="color: red;">-11.3</span>) | 51.8 | 56.4 | 57.4 | 59.3 | **65.0** |
| MuirBench | <ins>58.3</ins> | 34.9<br>(<span style="color: red;">-23.4</span>) | 40.7 | 48.9 | 53.4 | 49.0 | **67.0** |
| ToolSandBox | 59.5 | 26.4<br>(<span style="color: red;">-33.1</span>) | 56.5 | <ins>61.6</ins> | *n/a*<a href="#fn-internvl-tools" class="footnote-ref" role="doc-noteref"><sup>1</sup></a> | 47.7 | **65.0** |
| BFCLv4 | 32.5 | 20.5<br>(<span style="color: red;">-12.0</span>) | 33.2 | <ins>40.0</ins> | *n/a*<a href="#fn-internvl-tools" class="footnote-ref" role="doc-noteref"><sup>1</sup></a> | 33.9 | **53.6** |

A selection of benchmarks for LFM2.5-VL-3B, including multimodal reasoning, math, and OCR (see our [blog post](https://www.liquid.ai/blog/lfm2-5-vl-3b) for more benchmarks and details):

| Benchmark | **LFM2.5&#8209;VL&#8209;3B (3.1B)** | LFM2&#8209;VL&#8209;3B (3.1B) | Gemma4&nbsp;E2B (5.1B) | Gemma4&nbsp;E4B (8B) | InternVL&nbsp;3.5&nbsp;2B (2.4B) | InternVL&nbsp;3.5&nbsp;4B (4.7B) | Qwen3.5-2B (2.3B) | Qwen3.5-4B (4.7B) |
|-----------|-------------------------|-------------------|-------------------|-----------------|------------------------|------------------------|-------------------|-------------------|
| MME | 73.1 | 73.0 | 54.9 | 68.1 | 73.3 | 80.8 | 76.4 | 79.5 |
| MMStar | 63.3 | 57.7 | 57.9 | 61.9 | 57.5 | 65.3 | 67.9 | 73.3 |
| RealWorldQA | 73.1 | 71.1 | 56.2 | 61.8 | 61.4 | 68.6 | 71.4 | 76.2 |
| CountBenchQA | 87.3 | 92.2 | 70.8 | 80.1 | 70.6 | 82.5 | 83.2 | 86.9 |
| MMMB | 83.0 | 81.9 | 75.7 | 80.5 | 76.4 | 81.5 | 73.6 | 83.4 |
| MM-IF Eval | 60.6 | 51.4 | 64.5 | 66.7 | 48.4 | 54.6 | 52.1 | 63.8 |
| MathVista | 68.5 | 68.5 | 62.1 | 52.9 | 56.6 | 59.1 | 68.8 | 69.7 |
| MMMU Pro | 30.5 | 28.7 | 34.5 | 39.1 | 27.4 | 31.6 | 43.5 | 60.9 |
| ChartQA | 81.3 | 80.4 | 43.5 | 41.9 | 81.8 | 86.5 | 78.3 | 84.2 |
| OCRBenchv2<a href="#fn-ocrbenchv2" class="footnote-ref" role="doc-noteref"><sup>2</sup></a> | 47.5 | 43.9 | 44.7 | 48.7 | 45.5 | 49.2 | 48.0 | 58.8 |
| POPE | 88.7 | 89.2 | 84.0 | 86.9 | 87.3 | 88.9 | 88.7 | 86.0 |

*<p id="fn-internvl-tools">[1]: InternVL 3.5 doesn't support tool use.</p>*

*<p id="fn-ocrbenchv2">[2]: English-only subset of OCRBenchv2.</p>*

### On-device Inference

LFM2.5-VL-3B decodes 228 tokens/s on an Apple M5 Max and 116 tokens/s on an AMD Ryzen AI Max+ 395, and fits in about 3 GB of memory. It even reaches 20 tokens/s on a Galaxy S26 Ultra, so you can run it fully on-device.

![lfm2_5_vl_3b_on-device_inference_TTFT](https://cdn-uploads.huggingface.co/production/uploads/644249b08443bce4c9890a0f/X_0b2x4XSB32MC5obpCOL.png)

### GPU Inference

On a single NVIDIA H100 with vLLM, LFM2.5-VL-3B reaches the highest output throughput of any model we tested, about 11K tokens per second at high concurrency, or nearly 1B tokens per day.

![lfm2_5_vl_3b_throughput](https://cdn-uploads.huggingface.co/production/uploads/644249b08443bce4c9890a0f/qt4ipuEqxd--SR6CDZx1Y.png)

Because it answers directly instead of reasoning, LFM2.5-VL-3B is quick to first token on a single H100, reaching about 34 ms on a 5-frame clip.

![lfm2_5_vl_3b_ttft](https://cdn-uploads.huggingface.co/production/uploads/644249b08443bce4c9890a0f/oez5EIDV4MSTYyRvsFwGl.png)

## Contact

- Got questions or want to connect? [Join our Discord community](https://discord.com/invite/liquid-ai)
- If you are interested in custom solutions with edge deployment, please contact [our sales team](https://www.liquid.ai/contact).

## Citation

```
@article{liquidAI2026VL3B,
  author  = {Liquid AI},
  title   = {LFM2.5-VL-3B: A Better and Faster Vision-Language Model for the Edge},
  journal = {Liquid AI Blog},
  year    = {2026},
  note    = {www.liquid.ai/blog/lfm2-5-vl-3b},
}
```
