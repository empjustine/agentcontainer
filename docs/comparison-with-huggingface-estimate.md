# Comparison: `gguf-metadata-parser.js` vs `huggingface-estimate`

> Date: 2026-07-25
> Tool: [`gdevenyi/huggingface-estimate`](https://github.com/gdevenyi/huggingface-estimate) at `/reference/github/gdevenyi/huggingface-estimate/`
> Our parser: `/workspace/huggingface/gguf-metadata-parser.js`

## What is `huggingface-estimate`?

A production-grade Node.js tool that:
- Parses GGUF metadata (using the official `@huggingface/gguf` npm package)
- Computes **exact weight memory** from per-tensor GGUF metadata (not estimates)
- Calculates **KV cache** (standard, MLA, ISWA, SWA, hybrid, T5, MTP)
- Calculates **activations** (attention + FFN per layer)
- Estimates **speed-of-light throughput** (GPU bandwidth/FLOPs models)
- Handles **100+ quantization types** with per-fork BPE tables
- Supports **89 architectures** with custom tensor classification
- Detects **multimodal projectors** (mmproj)

## Scope of Comparison

For our project (model selection and capability metadata), we compared the:
1. **KV cache formula** — the dominant memory cost at inference
2. **Parameter estimation** — active/total params
3. **Architecture metadata extraction** — layers, heads, hidden size, MoE topology

## Three Critical Bugs Found & Fixed

### 1. MLA KV Cache Formula (GLM-4.7-Flash)

**The bug**: Our parser treated MLA (Multi-head Latent Attention) identically to standard attention, counting both K and V as separate caches. In MLA, V is **absorbed into the compressed latent** — there is no separate V cache. Additionally, MLA's cache dimension is `kv_lora_rank + rope.dimension_count`, not just `kv_lora_rank`.

| | Formula | Result for GLM-4.7-Flash |
|---|---|---|
| **Wrong** | `2 × layers × kv_heads × kv_lora_rank × 2 (fp16)` | **94 KB/token** (1.78× over) |
| **Correct (huggingface-estimate)** | `layers × (kv_lora_rank + rope_dim) × 2 (fp16)` | **52.9 KB/token** |

The correct formula is from `calculations.js` line 69-77:

```js
function mlaKvCache(meta, ctxSize, kvTypeK, kvTypeV) {
  const kv_lora_rank = meta[`${arch}.attention.kv_lora_rank`];
  const n_rot = meta[`${arch}.rope.dimension_count`];
  const n_layer = meta[`${arch}.block_count`];
  const totalElemsK = n_layer * (kv_lora_rank + n_rot) * ctxSize;
  return {
    bytesK: totalElemsK * BPE[kvTypeK],
    bytesV: 0,  // ← No separate V cache!
  };
}
```

**Verification**: GGUF header of `unsloth/GLM-4.7-Flash-GGUF` confirms:
- `deepseek2.attention.kv_lora_rank = 512`
- `deepseek2.rope.dimension_count = 64`
- Layer count = 47
- `47 × (512 + 64) × 2 bytes = 54,144 bytes/token = 52.9 KB/token` ✅

---

### 2. Hybrid Attention / Full-Attention Interval (Qwen3.6 Models)

**The bug**: Our parser assumed **all layers** participate in KV caching. Qwen3.6 models use **hybrid attention** — only every 4th layer has a classic KV cache; the remaining 75% are recurrent/linear with no KV cache at all.

The metadata key is `qwen35moe.full_attention_interval` (or `qwen35.full_attention_interval`) with value `4`.

| Model | Layers | Full-Attn Layers | Wrong KV (old) | Correct KV (hg-estimate) |
|-------|--------|-----------------|----------------|-------------------------|
| Qwen3.6-35B-A3B | 40 | 10 (every 4th) | 80.0 KB/tok | **20.0 KB/tok** |
| Qwen3.6-27B | 64 | 16 (every 4th) | 256.0 KB/tok | **64.0 KB/tok** |

The correct logic from `calculations.js` (lines 168-175):

```js
function qwen35FullAttnFilter(meta) {
  const arch = meta['general.architecture'];
  const interval = meta[`${arch}.full_attention_interval`] || 4;
  return (i) => ((i + 1) % interval === 0);
}
```

**Impact**: For Qwen3.6-35B-A3B at full 262K context:
- Wrong estimate: 80 KB × 262K = **21.5 GB** (fp16)
- Correct estimate: 20 KB × 262K = **5.4 GB** (fp16) — 4× reduction

For Qwen3.6-27B:
- Wrong estimate: 256 KB × 262K = **68.7 GB** (fp16)
- Correct estimate: 64 KB × 262K = **17.2 GB** (fp16) — 4× reduction

This is the most impactful bug — it affects model selection decisions by dramatically overstating KV cache requirements for the cheapest models.

**Verification**: GGUF headers confirm:
- `qwen35moe.full_attention_interval = 4` → 10/40 full-attn layers ✅
- `qwen35.full_attention_interval = 4` → 16/64 full-attn layers ✅
- `deepseek2.full_attention_interval` → absent (all layers full-attn) ✅

---

### 3. Metadata Buffer Size & Bounds Checking

**The bug**: The GGUF header (first 100KB) was too small for models with large tokenizer vocabularies (≥150K tokens). The tokenizer data alone requires ~3-4MB:

| Component | Size for 154K vocab |
|-----------|-------------------|
| `tokenizer.ggml.tokens` (array of strings) | ~2.2 MB |
| `tokenizer.ggml.scores` (array of float32) | ~620 KB |
| `tokenizer.ggml.token_type` (array of uint32) | ~620 KB |
| Architecture metadata | ~2 KB |
| **Total metadata** | **~3.4 MB** |

**Fix**: 
- Increased range request from 100KB → **5MB**, then **8MB** for safety
- Added bounds checks in `readString()` to gracefully handle truncation
- Changed metadata loop guard from `rd.remaining < 4` to `rd.remaining < 12` (need room for a string U64 length + value type)
- Made `readBytes()` clamp to available buffer data

## What My Parser Still Doesn't Do vs huggingface-estimate

| Capability | Why It Matters for Model Selection | Does hg-estimate? | Does our parser? |
|-----------|-----------------------------------|-------------------|-----------------|
| **Exact weight memory** (from tensor sizes) | Know precisely how much RAM a quantized model needs | ✅ Uses per-tensor GGUF metadata | ❌ Estimates from architecture fields (±10-20% error) |
| **Activations memory** | Peak VRAM during inference | ✅ Computes attention + FFN activations | ❌ Not computed |
| **Per-quantization BPE** | Memory varies 2-5× between quant types | ✅ 100+ types with fork overrides | ❌ fp16 only |
| **Performance (tokens/sec)** | Throughput on target hardware | ✅ GPU bandwidth/FLOPs models | ❌ Not computed |
| **ISWA / SWA** | Models like Gemma-4 use interleaved sliding window | ✅ Full support | ❌ Not handled (models are dense or MLA) |

## What Our Parser Has That huggingface-estimate Doesn't Need

| Feature | Notes |
|---------|-------|
| **Zero dependencies** | Hand-rolled GGUF parser works without npm |
| **HTTP Range fetching** | Single-file Node.js script, no browser needed |
| **Model selection focus** | Output optimized for comparing model tradeoffs |
| **Parameter estimation** | Reasonably close without downloading full (multi-GB) GGUF files |

## Verdict

**For our use case (model selection for a model serving platform):** Our parser is **sufficient** now that the MLA and hybrid-attention bugs are fixed. The KV cache numbers match the authoritative `huggingface-estimate` methodology. Weight memory and performance estimates would be nice-to-haves but aren't blockers for the current milestone.

**If we wanted to improve further**, the most valuable additions would be:
1. Extract **exact tensor sizes** from the GGUF tensor info section (already present in the fetched header, just not parsed)
2. Compute **weight memory per quantization type** using a BPE table
3. Handle **ISWA/SWA** for Gemma-4 architectures (check if they have `sliding_window` or `sliding_window_pattern` keys)

## Key Takeaway

> **Two models had wrong KV cache values by 2-4× before this comparison.**
> 
> The `huggingface-estimate` tool exposed both a formula error (MLA) and a missing feature (hybrid attention detection) that would have led to incorrect model selection decisions. The project should consider using `@huggingface/gguf` directly instead of a hand-rolled parser for production reliability.
