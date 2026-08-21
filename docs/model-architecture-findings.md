# Model Architecture Findings

## How Architecture Data Was Obtained

All data below was obtained **without downloading any full model files**, using two lightweight approaches:

| Method | When | Works for |
|--------|------|-----------|
| **HuggingFace API** (`/raw/main/config.json`) | Public base models | Qwen, Gemma, Laguna, etc. |
| **GGUF header Range request** (first 100KB via `curl -r 0-100000`) | Any model with a `.gguf` file on HF | Gated models, HF-inaccessible configs |

The GGUF header approach is the universal fallback: GGUF v3 stores all architecture metadata as key-value pairs in the first few KB of the file. The spec is at `/reference/github/ggml-org/ggml/docs/gguf.md`. Strings use `uint64_t` length prefixes. A reusable parser is at `gguf-metadata-parser.js`.

---

## Model Selection Matrix

For model selection, the four critical numbers are:

1. **Native context** — maximum tokens the model was trained on
2. **Active parameters** — params used per forward pass (determines throughput/latency)
3. **Total parameters** — params on disk/in RAM (determines memory for loading)
4. **KV cache per token** — memory consumed per token of context (determines how far you can fill the context window)

### All Models

| Model | Arch | Native Ctx | Active Params | Total Params | KV Cache / token (fp16) | KV @ full ctx | Vision |
|---|---|---|---|---|---|---|---|
| **Qwen3.6-35B-A3B** | qwen35moe | 262K | **~3B** | ~35B | 20 KB (hybrid¹) | **5.4 GB** | ✅ |
| **Qwen3.6-27B** | qwen35 | 262K | **~27B** (dense) | ~27B | 64 KB (hybrid¹) | **17.2 GB** | ✅ |
| **GLM-4.7-Flash** | deepseek2 (MLA) | 203K | **~2.6B** | ~4.7B | 53 KB (MLA²) | **10.7 GB** | ❌ |
| **Gemma-4-26B-A4B** | gemma4 | 262K | **~4B** | ~26B | 120 KB | **31 GB** | ✅ |
| **Gemma-4-12B** | gemma4_unified | 262K | **~?B** | ~12B | 192 KB | **50 GB** | ✅ |
| **Gemma-4-31B** | gemma4 | 262K | **~?B** | ~31B | 480 KB³ | **126 GB** | ✅ |
| **Devstral-24B** | mistral3 | 393K | **~24B** (dense) | ~24B | 80 KB | **31 GB** | ❌ |
| **Laguna-XS-2.1** | laguna | 262K | **~2.1B** | ~24.5B | 80 KB | **21 GB** | ❌ |

> **Footnotes:** ① **Hybrid attention**: Qwen3.6 models use `full_attention_interval=4` — only 1/4 of layers have KV cache (10/40 for 35B, 16/64 for 27B). The other 3/4 are recurrent/linear. ② **MLA**: GLM-4.7-Flash uses DeepSeek2-style MLA with `kv_lora_rank=512`. The KV cache is compressed — only K is stored (no separate V). Dimension = kv_lora_rank + rope.dim_count = 512 + 64. ③ **Gemma-4-31B**: Appears to use ISWA (interleaved sliding window attention), which may reduce effective KV cache. Needs GGUF verification.

### Key Insights

**Hybrid attention (Qwen3.6)**: Qwen3.6-35B and Qwen3.6-27B use `full_attention_interval=4` — only every 4th layer has a classic KV cache; other layers are recurrent. This reduces KV cache by 4× vs naive estimates: 20 KB vs 80 KB for the MoE variant, 64 KB vs 256 KB for the dense variant. Verified via GGUF header metadata.

**MoE models dominate**: 6 of 8 models are MoE. Only Qwen3.6-27B and Devstral-24B are dense.

**KV cache is the real bottleneck**: Even with aggressive quantization (q4_1 = 0.5 B/value), filling the full context window requires GB of RAM. For example, Gemma-4-31B at full 262K context needs ~126 GB *in fp16* — with q4_1 that's still ~63 GB just for KV cache.

**MLA dramatically reduces KV cache**: GLM-4.7-Flash uses DeepSeek2-style Multi-head Latent Attention with `kv_lora_rank=512`, compressing KV by ~20× vs a standard 20-head model. Its 53 KB/token KV cache is the smallest per-token among visionless models. Verified via GGUF header: only K is stored (no separate V), dimension = kv_lora_rank + rope.dim.

**Devstral is dense, not MoE**: Despite the "Small-2-24B" naming suggesting MoE, the GGUF header reveals `architecture: mistral3` with no expert keys. It's a pure dense 24B model with YaRN scaling (8K → 393K).

---

## Architecture Deep Dive

### Qwen3.6-35B-A3B (`qwen3_5_moe`)
- **MoE**: 256 experts, 8 active per token
- **Layers**: 40, **Hidden**: 2048, **Head dim**: 256
- **Attention**: 16 heads, 2 KV heads (8:1 GQA)
- **Vision encoder**: hidden_size=1152
- **Note**: The `A3B` suffix means ~3B active params. Total 35B params means only ~9% of params are active per token — very efficient inference.

**Hybrid attention**: `full_attention_interval=4` → only 10/40 layers have KV cache. This 4× reduction is critical for context scaling — at full 262K context, KV cache is only 5.4 GB (fp16) instead of 21.5 GB.

### Qwen3.6-27B (`qwen35` dense)
- **MoE**: No (dense)
- **Layers**: 64, **Hidden**: 5120, **Head dim**: 256
- **Attention**: 24 heads, 4 KV heads (6:1 GQA)
- **Vision encoder**: same as 35B variant
- **Note**: Dense 27B means every token uses all 27B params — much higher compute per token than MoE variants.

**Hybrid attention**: Same `full_attention_interval=4` — only 16/64 layers have KV cache. At full 262K context: 17.2 GB (fp16) instead of 68.7 GB.

### GLM-4.7-Flash (`deepseek2`)
- **MoE**: 64 experts, **4 active** per token, 1 shared expert
- **Layers**: 47 blocks + 1 leading dense block
- **Hidden**: 2048, **Expert FF**: 1536, **Dense FF**: 10240
- **Attention**: 20 heads, **1 KV head** (MLA with kv_lora_rank=512)
- **MLA specifics**: q_lora_rank=768, kv_lora_rank=512, key_length=576, value_length=512
- **Note**: The most KV-cache-efficient model in the list. MLA means: (a) no separate V cache (absorbed into the latent), (b) dimension = kv_lora_rank + rope.dim_count. At 47 layers × 576 dims × 2 bytes = 53 KB/token in fp16. This is ~6× smaller than a comparable 20-head standard model. Native context is 202,752 tokens (slightly below the 256K ceiling).

### Gemma-4-26B-A4B (`gemma4`)
- **MoE**: 128 experts (active count unknown from available data)
- **Layers**: 30, **Hidden**: 2816, **Head dim**: 256
- **Attention**: 16 heads, 8 KV heads (2:1 GQA)
- **Vision**: Dedicated vision encoder (gemma4_vision, 27 layers, hidden=1152)
- **Note**: Relatively shallow (30 layers) but each layer has 128 experts. The `A4B` suggests ~4B active.

### Gemma-4-12B (`gemma4_unified`)
- **MoE**: Yes (exact expert count needs GGUF header check)
- **Layers**: 48, **Hidden**: 3840, **Head dim**: 256
- **Attention**: 16 heads, 8 KV heads
- **Vision**: Unified architecture (gemma4_unified_vision)
- **Note**: Unified vision-language — weights are shared between vision and text.

### Gemma-4-31B (`gemma4`)
- **MoE**: Yes (exact expert count needs GGUF header check)
- **Layers**: 60, **Hidden**: 5376, **Head dim**: 256
- **Attention**: 32 heads, 16 KV heads
- **Vision**: Separate vision encoder (27 layers, hidden=1152)
- **Note**: Largest memory footprint for KV cache: 480 KB/token in fp16. At 262K context, that's 126 GB just for cache.

### Devstral-Small-2-24B (`mistral3`)
- **MoE**: No — **dense** model
- **Layers**: 40, **Hidden**: 5120, **FF**: 32768, **Head dim**: 128
- **Attention**: 32 heads, 8 KV heads (4:1 GQA)
- **Context scaling**: YaRN from 8192 → 393216 (factor=48), freq_base=100M
- **Note**: Despite "Small-2-24B" name suggesting MoE, it's dense. Largest native context (393K).

### Laguna-XS-2.1 (`laguna`)
- **MoE**: 256 experts, 8 active per token
- **Layers**: 40, **Hidden**: 2048, **Head dim**: 128
- **Attention**: 48 heads, 8 KV heads (6:1 GQA)
- **Note**: Similar architecture to Qwen3.6-35B-A3B but with different head count and head dim. No vision.

---

## GGUF Header Parser

See `gguf-metadata-parser.js` for a reusable Node.js script that:
- Fetches GGUF headers via HTTP Range (first 100KB)
- Parses all metadata per the v3 spec
- Extracts architecture-relevant fields
- Estimates parameter counts and KV cache memory
- Outputs JSON

Usage:
```bash
node gguf-metadata-parser.js <hf-repo> <hf-file>
node gguf-metadata-parser.js <full-gguf-url>
```

---

## Receipt: How to Get Architecture Data for Any Model

1. **Find a GGUF file** for the model (e.g., on HuggingFace under `*-GGUF` repos)
2. **Fetch the header** (first 100KB is enough for any model):
   ```bash
   curl -s -L -r 0-100000 \
     "https://huggingface.co/{REPO}/resolve/main/{FILE}.gguf" \
     -o /tmp/header.gguf
   ```
3. **Parse the metadata** using the Python or Node.js parser
4. **Look for these keys**:
   - `general.architecture` — e.g., `llama`, `qwen3_5_moe`, `deepseek2`
   - `{arch}.block_count` — number of layers
   - `{arch}.embedding_length` — hidden size
   - `{arch}.attention.head_count` / `.head_count_kv` — attention heads
   - `{arch}.expert_count` / `expert_used_count` — MoE topology
   - `{arch}.context_length` — native max context
   - `{arch}.attention.kv_lora_rank` — MLA compression (if present)
   - `{arch}.rope.scaling.*` — context extension method

Alternatively, for **non-gated** models, query the HuggingFace config.json:
```bash
curl -s "https://huggingface.co/{HF_ID}/raw/main/config.json" | jq '.'
```
