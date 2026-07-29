#!/usr/bin/env node
/**
 * GGUF Metadata Parser
 *
 * Fetches the header of a GGUF file via HTTP Range request (first 100KB)
 * and extracts architecture metadata relevant for model selection.
 *
 * Usage:
 *   node gguf-metadata-parser.js <gguf-url>
 *   node gguf-metadata-parser.js <hf-repo> <hf-file>
 *
 * Examples:
 *   node gguf-metadata-parser.js https://huggingface.co/unsloth/GLM-4.7-Flash-GGUF/resolve/main/GLM-4.7-Flash-Q6_K.gguf
 *   node gguf-metadata-parser.js unsloth/GLM-4.7-Flash-GGUF GLM-4.7-Flash-Q6_K.gguf
 *
 * Outputs JSON with:
 *   - architecture
 *   - block_count (layers)
 *   - embedding_length (hidden size)
 *   - head_dim
 *   - attention.head_count
 *   - attention.head_count_kv
 *   - expert_count (MoE), expert_used_count
 *   - context_length
 *   - feed_forward_length
 *   - rope.*
 *   - size_label
 *   - estimated sizes (active_params, total_params, kv_cache_bytes_per_token)
 */

const https = require('https');
const http = require('http');

// ---- GGUF binary parsing helpers ----

class BufferReader {
  constructor(buf) {
    this.buf = buf;
    this.offset = 0;
  }

  get remaining() { return this.buf.length - this.offset; }

  readU8() {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readI8() {
    const v = this.buf.readInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readU16() {
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readI16() {
    const v = this.buf.readInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readU32() {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readI32() {
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readF32() {
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }

  readU64() {
    // JS can't natively handle full uint64, but for our metadata sizes it fits in Number
    const lo = this.buf.readUInt32LE(this.offset);
    const hi = this.buf.readUInt32LE(this.offset + 4);
    this.offset += 8;
    return lo + hi * 0x100000000;
  }

  readI64() {
    const lo = this.buf.readUInt32LE(this.offset);
    const hi = this.buf.readInt32LE(this.offset + 4);
    this.offset += 8;
    return lo + hi * 0x100000000;
  }

  readF64() {
    const v = this.buf.readDoubleLE(this.offset);
    this.offset += 8;
    return v;
  }

  readBool() {
    return this.readU8() !== 0;
  }

  readString() {
    if (this.remaining < 8) return '';
    const len = this.readU64();
    if (this.remaining < len) {
      this.offset = this.buf.length;
      return '';
    }
    const s = this.buf.toString('utf-8', this.offset, this.offset + len);
    this.offset += len;
    return s;
  }

  readBytes(n) {
    const end = Math.min(this.offset + n, this.buf.length);
    const chunk = this.buf.slice(this.offset, end);
    this.offset = end;
    return chunk;
  }
}

// ---- Metadata value type enum ----
const TYPE = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3,
  UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7,
  STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
};

function readMetadataValue(rd, type) {
  switch (type) {
    case TYPE.UINT8:   return rd.readU8();
    case TYPE.INT8:    return rd.readI8();
    case TYPE.UINT16:  return rd.readU16();
    case TYPE.INT16:   return rd.readI16();
    case TYPE.UINT32:  return rd.readU32();
    case TYPE.INT32:   return rd.readI32();
    case TYPE.FLOAT32: return rd.readF32();
    case TYPE.BOOL:    return rd.readBool();
    case TYPE.STRING:  return rd.readString();
    case TYPE.UINT64:  return rd.readU64();
    case TYPE.INT64:   return rd.readI64();
    case TYPE.FLOAT64: return rd.readF64();
    case TYPE.ARRAY: {
      const elemType = rd.readU32();
      const count = rd.readU64();
      const items = [];
      for (let i = 0; i < count && rd.remaining > 0; i++) {
        items.push(readMetadataValue(rd, elemType));
      }
      return items;
    }
    default:
      return `(unknown_type_${type})`;
  }
}

/**
 * Parse GGUF header from a Buffer containing at least the header portion
 * (typically first 100KB of the .gguf file).
 */
function parseGGUFHeader(buffer) {
  const rd = new BufferReader(buffer);

  const magic = rd.readBytes(4).toString('ascii');
  if (magic !== 'GGUF') {
    throw new Error(`Not a GGUF file (magic: ${JSON.stringify(magic)})`);
  }

  const version = rd.readU32();
  const tensorCount = rd.readU64();
  const kvCount = rd.readU64();

  const metadata = { _ggufVersion: version, _tensorCount: tensorCount };

  for (let i = 0; i < kvCount; i++) {
    if (rd.remaining < 12) break;

    const key = rd.readString();
    if (!key) break;
    if (rd.remaining < 4) break;
    const valueType = rd.readU32();
    const value = readMetadataValue(rd, valueType);

    metadata[key] = value;
  }

  return metadata;
}

// ---- Size estimation helpers ----

/**
 * Estimate the total parameter count and active parameter count
 * from architecture metadata.
 *
 * Returns { totalParams, activeParams, sizeLabel } or null if unknown.
 */
function estimateParams(meta) {
  const arch = meta['general.architecture'] || '';
  const sizeLabel = meta['general.size_label'] || '';

  // Known models from canonical names
  const modelName = (meta['general.name'] || meta['general.basename'] || '').toLowerCase();

  // Direct known values
  if (modelName.includes('qwen3.6-35b-a3b') || modelName.includes('qwen3.6-35b')) {
    return { activeParams: 3e9, totalParams: 35e9, sizeLabel: '3B/35B' };
  }
  if (modelName.includes('qwen3.6-27b')) {
    return { activeParams: 27e9, totalParams: 27e9, sizeLabel: '27B (dense)' };
  }
  if (modelName.includes('glm-4.7-flash') || modelName.includes('glm4.7')) {
    // ~4.7B total, size_label "64x2.6B" — likely 2.6B active among 64 experts
    return { activeParams: 2.6e9, totalParams: 4.7e9, sizeLabel: '2.6B/4.7B' };
  }
  if (modelName.includes('gemma-4-26b') || modelName.includes('26b-a4b')) {
    return { activeParams: 4e9, totalParams: 26e9, sizeLabel: '4B/26B' };
  }
  if (modelName.includes('gemma-4-12b')) {
    // Gemma-4-12B: MoE, but exact active count unknown; treat as 12B total
    return { activeParams: null, totalParams: 12e9, sizeLabel: '12B (MoE)' };
  }
  if (modelName.includes('gemma-4-31b')) {
    return { activeParams: null, totalParams: 31e9, sizeLabel: '31B (MoE)' };
  }
  if (modelName.includes('devstral-small-2-24b') || modelName.includes('devstral')) {
    return { activeParams: 24e9, totalParams: 24e9, sizeLabel: '24B (dense)' };
  }
  if (modelName.includes('laguna-xs-2.1') || modelName.includes('laguna')) {
    return { activeParams: 2.1e9, totalParams: 24.5e9, sizeLabel: '2.1B/24.5B' };
  }

  // Fallback: estimate from architecture fields
  const hidden = meta[`${arch}.embedding_length`];
  const layers = meta[`${arch}.block_count`];
  const ffnLen = meta[`${arch}.feed_forward_length`];
  const expertFFN = meta[`${arch}.expert_feed_forward_length`];
  const nExperts = meta[`${arch}.expert_count`];
  const nUsedExperts = meta[`${arch}.expert_used_count`];
  const vocab = meta[`${arch}.vocab_size`];

  if (hidden && layers) {
    // Rough estimate: embedding + per-layer attention + FFN
    const embParams = hidden * (vocab || 32000);
    let perLayer;
    if (nExperts) {
      // MoE: attention is shared, FFN is per-expert
      const expertFF = expertFFN || ffnLen || hidden * 4;
      const denseFF = ffnLen || 0;
      const attnParams = 4 * hidden * hidden; // Q,K,V,O projections (approx)
      const expertParams = nExperts * 3 * hidden * expertFF; // gate, up, down
      const sharedFFParams = denseFF ? 3 * hidden * denseFF : 0;
      perLayer = attnParams + expertParams + sharedFFParams;
      const total = 2 * hidden * (vocab || 32000) + layers * perLayer; // + lm_head
      const active = 2 * hidden * (vocab || 32000) + layers * (attnParams + (nUsedExperts || 1) * 3 * hidden * expertFF + sharedFFParams);
      return { activeParams: active, totalParams: total, sizeLabel: `${(active / 1e9).toFixed(1)}B/${(total / 1e9).toFixed(0)}B (est)` };
    } else {
      perLayer = 4 * hidden * hidden + 3 * hidden * (ffnLen || hidden * 4);
      const total = 2 * hidden * (vocab || 32000) + layers * perLayer;
      return { activeParams: total, totalParams: total, sizeLabel: `${(total / 1e9).toFixed(0)}B (dense est)` };
    }
  }

  return null;
}

/**
 * Estimate KV cache memory per token in bytes (raw fp16 equivalent),
 * based on architecture metadata.
 *
 * Returns { bytesPerToken, description }
 *
 * The KV cache per token (for both K and V, all layers) =
 *   2 * block_count * kv_heads * head_dim * bytes_per_element
 *
 * With quantization, the actual memory is bytes_per_element * effective_bytes_per_value.
 * q8_0 = 1B/value, q5_1 ≈ 0.625, q4_1 ≈ 0.5, q8_0 ≈ 1.0
 */
function estimateKVCache(meta) {
  const arch = meta['general.architecture'] || '';
  const totalLayers = meta[`${arch}.block_count`] || 0;
  const nHeads = meta[`${arch}.attention.head_count`] || 0;
  const nKVHeads = meta[`${arch}.attention.head_count_kv`] || nHeads;
  const hidden = meta[`${arch}.embedding_length`] || 0;

  // head_dim: prefer explicit key_length, then derive from hidden/n_heads
  const keyLen = meta[`${arch}.attention.key_length`];
  const valueLen = meta[`${arch}.attention.value_length`];
  const kvLoRARank = meta[`${arch}.attention.kv_lora_rank`]; // MLA compression
  const headDim = keyLen || (hidden && nHeads ? Math.round(hidden / nHeads) : 128);

  // ── MLA (DeepSeek2): KV is stored as a compressed latent ──
  // Only K is stored (no separate V). Dimension = kv_lora_rank + rope.dimension_count.
  // See calculations.js mlaKvCache() in huggingface-estimate.
  if (kvLoRARank) {
    const nRot = meta[`${arch}.rope.dimension_count`] || 0;
    const mlaDim = kvLoRARank + nRot;
    const bytesFP16 = totalLayers * mlaDim * 2; // *2 for fp16, V is absorbed into the latent
    return {
      bytesPerToken: bytesFP16,
      perTokenKB: (bytesFP16 / 1024).toFixed(1),
      description: `${totalLayers}L × (kv_lora=${kvLoRARank} + n_rot=${nRot})dim = ${(bytesFP16 / 1024).toFixed(0)} KB/token (fp16, MLA)`,
      breakdown: { layers: totalLayers, kvHeads: 0, headDim: mlaDim, isMLA: true, kvLoRARank, nRot, mlaDim }
    };
  }

  // ── Hybrid attention (Qwen3.5 style): some layers are recurrent, no KV cache ──
  // full_attention_interval=N means only every Nth layer (i+1 % N === 0) has KV cache.
  // attention.recurrent_layers is explicit per-layer array (1=recurrent, 0=full-attn).
  const fullAttnInterval = meta[`${arch}.full_attention_interval`];
  const recurrentLayers = meta[`${arch}.attention.recurrent_layers`];

  let effectiveLayers = 0;
  if (Array.isArray(recurrentLayers)) {
    for (let i = 0; i < totalLayers && i < recurrentLayers.length; i++) {
      if (Number(recurrentLayers[i]) === 0) effectiveLayers++;
    }
  } else if (fullAttnInterval > 0) {
    for (let i = 0; i < totalLayers; i++) {
      if ((i + 1) % fullAttnInterval === 0) effectiveLayers++;
    }
  } else {
    effectiveLayers = totalLayers;
  }

  const hybridInfo = effectiveLayers !== totalLayers
    ? ` (${effectiveLayers}/${totalLayers}L full-attn)`
    : '';

  // ── Standard transformer: separate K and V caches ──
  const bytesFP16 = 2 * effectiveLayers * nKVHeads * headDim * 2; // *2 for K+V, *2 for fp16

  return {
    bytesPerToken: bytesFP16,
    perTokenKB: (bytesFP16 / 1024).toFixed(1),
    description: `${effectiveLayers}L × ${nKVHeads}KV × ${headDim}dim × 2(K+V) = ${(bytesFP16 / 1024).toFixed(0)} KB/token (fp16)${hybridInfo}`,
    breakdown: { layers: effectiveLayers, totalLayers, kvHeads: nKVHeads, headDim, isMLA: false, fullAttnInterval: fullAttnInterval || null }
  };
}

// ---- HTTP Range request ----

function fetchWithRange(url, start = 0, end = 8388608, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Range': `bytes=${start}-${end}`,
        'User-Agent': 'gguf-metadata-parser/1.0',
      },
      timeout,
    };

    const chunks = [];
    const req = mod.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        resolve(fetchWithRange(new URL(res.headers.location, url).href, start, end, timeout));
        return;
      }
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---- Main ----

async function main() {
  let url;
  if (process.argv.length === 3) {
    url = process.argv[2];
  } else if (process.argv.length === 4) {
    const repo = process.argv[2];
    const file = process.argv[3];
    url = `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
  } else {
    console.error('Usage:');
    console.error('  node gguf-metadata-parser.js <gguf-url>');
    console.error('  node gguf-metadata-parser.js <hf-repo> <hf-file>');
    process.exit(1);
  }

  console.error(`Fetching header from: ${url}`);
  const buffer = await fetchWithRange(url, 0, 8388608);
  console.error(`Got ${buffer.length} bytes`);

  const meta = parseGGUFHeader(buffer);

  const arch = meta['general.architecture'] || 'unknown';
  const layers = meta[`${arch}.block_count`];
  const hidden = meta[`${arch}.embedding_length`];
  const ctxLen = meta[`${arch}.context_length`];
  const nHeads = meta[`${arch}.attention.head_count`];
  const nKVHeads = meta[`${arch}.attention.head_count_kv`] || nHeads;
  const nExperts = meta[`${arch}.expert_count`];
  const nUsedExperts = meta[`${arch}.expert_used_count`];
  const ffnLen = meta[`${arch}.feed_forward_length`];
  const expertFFN = meta[`${arch}.expert_feed_forward_length`];
  const sizeLabel = meta['general.size_label'] || '';
  const name = meta['general.name'] || meta['general.basename'] || '';
  const vocab = meta[`${arch}.vocab_size`];
  const kvLoRARank = meta[`${arch}.attention.kv_lora_rank`];
  const ropeDim = meta[`${arch}.rope.dimension_count`];
  const ropeBase = meta[`${arch}.rope.freq_base`];
  const ropeScalingType = meta[`${arch}.rope.scaling.type`];
  const ropeScalingFactor = meta[`${arch}.rope.scaling.factor`];
  const origCtx = meta[`${arch}.rope.scaling.original_context_length`];

  // Derive head_dim
  const keyLen = meta[`${arch}.attention.key_length`];
  const headDim = keyLen || (hidden && nHeads ? Math.round(hidden / nHeads) : null);

  // Parameter estimates
  const params = estimateParams(meta);

  // KV cache estimates
  const kvCache = estimateKVCache(meta);

  // Build compact output
  const result = {
    model: name || '(unknown)',
    architecture: arch,
    sizeLabel,
    nativeContext: ctxLen || null,
    layers: layers || null,
    hiddenSize: hidden || null,
    headDim,
    attentionHeads: nHeads || null,
    kvHeads: nKVHeads || null,
    isMoE: nExperts ? true : false,
    expertCount: nExperts || null,
    expertUsedCount: nUsedExperts || null,
    feedForwardLength: ffnLen || null,
    expertFeedForwardLength: expertFFN || null,
    vocabSize: vocab || null,
    isMLA: !!kvLoRARank,
    kvLoRARank: kvLoRARank || null,
    fullAttentionInterval: meta[`${arch}.full_attention_interval`] || null,
    recurrentLayers: meta[`${arch}.attention.recurrent_layers`] ? (Array.isArray(meta[`${arch}.attention.recurrent_layers`]) ? meta[`${arch}.attention.recurrent_layers`].slice(0,10) : meta[`${arch}.attention.recurrent_layers`]) : null,
    ropeDim: ropeDim || null,
    ropeBase: ropeBase || null,
    ropeScaling: ropeScalingType ? { type: ropeScalingType, factor: ropeScalingFactor, originalContext: origCtx } : null,

    // Selection-relevant estimates
    params: params ? {
      activeParams: params.activeParams ? Math.round(params.activeParams).toLocaleString() : null,
      totalParams: Math.round(params.totalParams).toLocaleString(),
      label: params.sizeLabel,
    } : null,
    kvCache: {
      bytesPerToken: kvCache.bytesPerToken,
      perTokenKB: kvCache.perTokenKB,
      description: kvCache.description,
      // Memory for various context lengths
      examples: ctxLen ? {
        atQuarter: { context: Math.round(ctxLen * 0.25), memoryGB: ((kvCache.bytesPerToken * ctxLen * 0.25) / 1e9).toFixed(1) },
        atHalf: { context: Math.round(ctxLen * 0.5), memoryGB: ((kvCache.bytesPerToken * ctxLen * 0.5) / 1e9).toFixed(1) },
        atFull: { context: ctxLen, memoryGB: ((kvCache.bytesPerToken * ctxLen) / 1e9).toFixed(1) },
      } : null,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
