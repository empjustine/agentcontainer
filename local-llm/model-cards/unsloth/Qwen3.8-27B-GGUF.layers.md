---
model: unsloth/Qwen3.8-27B-GGUF
quants: Q8_0, Q6_K, Q4_K_M
file_Q8_0: Qwen3.8-27B-Q8_0.gguf
file_Q6_K: Qwen3.8-27B-Q6_K.gguf
file_Q4_K_M: Qwen3.8-27B-Q4_K_M.gguf
tensor_count: 866
generator: local-llm/generate-layer-cards.py
generated: 2026-08-18 01:59 UTC
---

# Layer names — unsloth/Qwen3.8-27B-GGUF

Every tensor (layer) name read from the GGUF **tensor-info header** — no weights are loaded into memory. Layer names are architecture-level and identical across quants; per-tensor sizes are listed per quant.

## Summary

| field | value |
|---|---|
| architecture | `qwen35` |
| block count | 65 (`blk.0` … `blk.64`) |
| context length | 262144 |
| embedding length | 5120 |
| total tensors | 866 |
| non-layer tensors | 3 |
| attention blocks | 17 — 3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 43, 47, 51, 55, 59, 63, 64 |
| ssm blocks | 48 — 0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 20, 21, 22, 24, 25, 26, 28, 29, 30, 32, 33, 34, 36, 37, 38, 40, 41, 42, 44, 45, 46, 48, 49, 50, 52, 53, 54, 56, 57, 58, 60, 61, 62 |
| quants analyzed | Q8_0, Q6_K, Q4_K_M |

## Non-layer tensors

| tensor | shape | MiB (Q8_0) | MiB (Q6_K) | MiB (Q4_K_M) |
|---|---|---|---|---|
| `output.weight` | [5120 x 248320] | 1288.3 | 994.6 | 994.6 |
| `output_norm.weight` | [5120] | 0.0 | 0.0 | 0.0 |
| `token_embd.weight` | [5120 x 248320] | 1288.3 | 994.6 | 682.0 |

## Block layout

### attention blocks — 17 (3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 43, 47, 51, 55, 59, 63, 64)

| tensor | shape | MiB (Q8_0) | MiB (Q6_K) | MiB (Q4_K_M) |
|---|---|---|---|---|
| `attn_k.weight` | [5120 x 1024] | 5.3 | 4.1 | 2.8 |
| `attn_k_norm.weight` | [256] | 0.0 | 0.0 | 0.0 |
| `attn_norm.weight` | [5120] | 0.0 | 0.0 | 0.0 |
| `attn_output.weight` | [6144 x 5120] | 31.9 | 24.6 | 16.9 |
| `attn_q.weight` | [5120 x 12288] | 63.8 | 49.2 | 33.8 |
| `attn_q_norm.weight` | [256] | 0.0 | 0.0 | 0.0 |
| `attn_v.weight` | [5120 x 1024] | 5.3 | 4.1 | 4.1 |
| `ffn_down.weight` | [17408 x 5120] | 90.3 | 69.7 | 69.7 |
| `ffn_gate.weight` | [5120 x 17408] | 90.3 | 69.7 | 47.8 |
| `ffn_up.weight` | [5120 x 17408] | 90.3 | 69.7 | 47.8 |
| `post_attention_norm.weight` | [5120] | 0.0 | 0.0 | 0.0 |

Blocks with additional tensors on top of the canonical set:

- `blk.64`: `nextn.eh_proj.weight`, `nextn.enorm.weight`, `nextn.hnorm.weight`, `nextn.shared_head_norm.weight`

### ssm blocks — 48 (0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 20, 21, 22, 24, 25, 26, 28, 29, 30, 32, 33, 34, 36, 37, 38, 40, 41, 42, 44, 45, 46, 48, 49, 50, 52, 53, 54, 56, 57, 58, 60, 61, 62)

| tensor | shape | MiB (Q8_0) | MiB (Q6_K) | MiB (Q4_K_M) |
|---|---|---|---|---|
| `attn_gate.weight` | [5120 x 6144] | 31.9 | 24.6 | 16.9 |
| `attn_norm.weight` | [5120] | 0.0 | 0.0 | 0.0 |
| `attn_qkv.weight` | [5120 x 10240] | 53.1 | 41.0 | 41.0 |
| `ffn_down.weight` | [17408 x 5120] | 90.3 | 69.7 | 69.7 |
| `ffn_gate.weight` | [5120 x 17408] | 90.3 | 69.7 | 47.8 |
| `ffn_up.weight` | [5120 x 17408] | 90.3 | 69.7 | 47.8 |
| `post_attention_norm.weight` | [5120] | 0.0 | 0.0 | 0.0 |
| `ssm_a` | [48] | 0.0 | 0.0 | 0.0 |
| `ssm_alpha.weight` | [5120 x 48] | 0.2 | 0.9 | 0.9 |
| `ssm_beta.weight` | [5120 x 48] | 0.2 | 0.9 | 0.9 |
| `ssm_conv1d.weight` | [4 x 10240] | 0.2 | 0.2 | 0.2 |
| `ssm_dt.bias` | [48] | 0.0 | 0.0 | 0.0 |
| `ssm_norm.weight` | [128] | 0.0 | 0.0 | 0.0 |
| `ssm_out.weight` | [6144 x 5120] | 31.9 | 31.9 | 20.6 |


## All tensors by block

- `output.weight`
- `output_norm.weight`
- `token_embd.weight`

### blk.0 (ssm)

```text
blk.0.attn_gate.weight
blk.0.attn_norm.weight
blk.0.attn_qkv.weight
blk.0.ffn_down.weight
blk.0.ffn_gate.weight
blk.0.ffn_up.weight
blk.0.post_attention_norm.weight
blk.0.ssm_a
blk.0.ssm_alpha.weight
blk.0.ssm_beta.weight
blk.0.ssm_conv1d.weight
blk.0.ssm_dt.bias
blk.0.ssm_norm.weight
blk.0.ssm_out.weight
```


### blk.1 (ssm)

```text
blk.1.attn_gate.weight
blk.1.attn_norm.weight
blk.1.attn_qkv.weight
blk.1.ffn_down.weight
blk.1.ffn_gate.weight
blk.1.ffn_up.weight
blk.1.post_attention_norm.weight
blk.1.ssm_a
blk.1.ssm_alpha.weight
blk.1.ssm_beta.weight
blk.1.ssm_conv1d.weight
blk.1.ssm_dt.bias
blk.1.ssm_norm.weight
blk.1.ssm_out.weight
```


### blk.2 (ssm)

```text
blk.2.attn_gate.weight
blk.2.attn_norm.weight
blk.2.attn_qkv.weight
blk.2.ffn_down.weight
blk.2.ffn_gate.weight
blk.2.ffn_up.weight
blk.2.post_attention_norm.weight
blk.2.ssm_a
blk.2.ssm_alpha.weight
blk.2.ssm_beta.weight
blk.2.ssm_conv1d.weight
blk.2.ssm_dt.bias
blk.2.ssm_norm.weight
blk.2.ssm_out.weight
```


### blk.3 (attention)

```text
blk.3.attn_k.weight
blk.3.attn_k_norm.weight
blk.3.attn_norm.weight
blk.3.attn_output.weight
blk.3.attn_q.weight
blk.3.attn_q_norm.weight
blk.3.attn_v.weight
blk.3.ffn_down.weight
blk.3.ffn_gate.weight
blk.3.ffn_up.weight
blk.3.post_attention_norm.weight
```


### blk.4 (ssm)

```text
blk.4.attn_gate.weight
blk.4.attn_norm.weight
blk.4.attn_qkv.weight
blk.4.ffn_down.weight
blk.4.ffn_gate.weight
blk.4.ffn_up.weight
blk.4.post_attention_norm.weight
blk.4.ssm_a
blk.4.ssm_alpha.weight
blk.4.ssm_beta.weight
blk.4.ssm_conv1d.weight
blk.4.ssm_dt.bias
blk.4.ssm_norm.weight
blk.4.ssm_out.weight
```


### blk.5 (ssm)

```text
blk.5.attn_gate.weight
blk.5.attn_norm.weight
blk.5.attn_qkv.weight
blk.5.ffn_down.weight
blk.5.ffn_gate.weight
blk.5.ffn_up.weight
blk.5.post_attention_norm.weight
blk.5.ssm_a
blk.5.ssm_alpha.weight
blk.5.ssm_beta.weight
blk.5.ssm_conv1d.weight
blk.5.ssm_dt.bias
blk.5.ssm_norm.weight
blk.5.ssm_out.weight
```


### blk.6 (ssm)

```text
blk.6.attn_gate.weight
blk.6.attn_norm.weight
blk.6.attn_qkv.weight
blk.6.ffn_down.weight
blk.6.ffn_gate.weight
blk.6.ffn_up.weight
blk.6.post_attention_norm.weight
blk.6.ssm_a
blk.6.ssm_alpha.weight
blk.6.ssm_beta.weight
blk.6.ssm_conv1d.weight
blk.6.ssm_dt.bias
blk.6.ssm_norm.weight
blk.6.ssm_out.weight
```


### blk.7 (attention)

```text
blk.7.attn_k.weight
blk.7.attn_k_norm.weight
blk.7.attn_norm.weight
blk.7.attn_output.weight
blk.7.attn_q.weight
blk.7.attn_q_norm.weight
blk.7.attn_v.weight
blk.7.ffn_down.weight
blk.7.ffn_gate.weight
blk.7.ffn_up.weight
blk.7.post_attention_norm.weight
```


### blk.8 (ssm)

```text
blk.8.attn_gate.weight
blk.8.attn_norm.weight
blk.8.attn_qkv.weight
blk.8.ffn_down.weight
blk.8.ffn_gate.weight
blk.8.ffn_up.weight
blk.8.post_attention_norm.weight
blk.8.ssm_a
blk.8.ssm_alpha.weight
blk.8.ssm_beta.weight
blk.8.ssm_conv1d.weight
blk.8.ssm_dt.bias
blk.8.ssm_norm.weight
blk.8.ssm_out.weight
```


### blk.9 (ssm)

```text
blk.9.attn_gate.weight
blk.9.attn_norm.weight
blk.9.attn_qkv.weight
blk.9.ffn_down.weight
blk.9.ffn_gate.weight
blk.9.ffn_up.weight
blk.9.post_attention_norm.weight
blk.9.ssm_a
blk.9.ssm_alpha.weight
blk.9.ssm_beta.weight
blk.9.ssm_conv1d.weight
blk.9.ssm_dt.bias
blk.9.ssm_norm.weight
blk.9.ssm_out.weight
```


### blk.10 (ssm)

```text
blk.10.attn_gate.weight
blk.10.attn_norm.weight
blk.10.attn_qkv.weight
blk.10.ffn_down.weight
blk.10.ffn_gate.weight
blk.10.ffn_up.weight
blk.10.post_attention_norm.weight
blk.10.ssm_a
blk.10.ssm_alpha.weight
blk.10.ssm_beta.weight
blk.10.ssm_conv1d.weight
blk.10.ssm_dt.bias
blk.10.ssm_norm.weight
blk.10.ssm_out.weight
```


### blk.11 (attention)

```text
blk.11.attn_k.weight
blk.11.attn_k_norm.weight
blk.11.attn_norm.weight
blk.11.attn_output.weight
blk.11.attn_q.weight
blk.11.attn_q_norm.weight
blk.11.attn_v.weight
blk.11.ffn_down.weight
blk.11.ffn_gate.weight
blk.11.ffn_up.weight
blk.11.post_attention_norm.weight
```


### blk.12 (ssm)

```text
blk.12.attn_gate.weight
blk.12.attn_norm.weight
blk.12.attn_qkv.weight
blk.12.ffn_down.weight
blk.12.ffn_gate.weight
blk.12.ffn_up.weight
blk.12.post_attention_norm.weight
blk.12.ssm_a
blk.12.ssm_alpha.weight
blk.12.ssm_beta.weight
blk.12.ssm_conv1d.weight
blk.12.ssm_dt.bias
blk.12.ssm_norm.weight
blk.12.ssm_out.weight
```


### blk.13 (ssm)

```text
blk.13.attn_gate.weight
blk.13.attn_norm.weight
blk.13.attn_qkv.weight
blk.13.ffn_down.weight
blk.13.ffn_gate.weight
blk.13.ffn_up.weight
blk.13.post_attention_norm.weight
blk.13.ssm_a
blk.13.ssm_alpha.weight
blk.13.ssm_beta.weight
blk.13.ssm_conv1d.weight
blk.13.ssm_dt.bias
blk.13.ssm_norm.weight
blk.13.ssm_out.weight
```


### blk.14 (ssm)

```text
blk.14.attn_gate.weight
blk.14.attn_norm.weight
blk.14.attn_qkv.weight
blk.14.ffn_down.weight
blk.14.ffn_gate.weight
blk.14.ffn_up.weight
blk.14.post_attention_norm.weight
blk.14.ssm_a
blk.14.ssm_alpha.weight
blk.14.ssm_beta.weight
blk.14.ssm_conv1d.weight
blk.14.ssm_dt.bias
blk.14.ssm_norm.weight
blk.14.ssm_out.weight
```


### blk.15 (attention)

```text
blk.15.attn_k.weight
blk.15.attn_k_norm.weight
blk.15.attn_norm.weight
blk.15.attn_output.weight
blk.15.attn_q.weight
blk.15.attn_q_norm.weight
blk.15.attn_v.weight
blk.15.ffn_down.weight
blk.15.ffn_gate.weight
blk.15.ffn_up.weight
blk.15.post_attention_norm.weight
```


### blk.16 (ssm)

```text
blk.16.attn_gate.weight
blk.16.attn_norm.weight
blk.16.attn_qkv.weight
blk.16.ffn_down.weight
blk.16.ffn_gate.weight
blk.16.ffn_up.weight
blk.16.post_attention_norm.weight
blk.16.ssm_a
blk.16.ssm_alpha.weight
blk.16.ssm_beta.weight
blk.16.ssm_conv1d.weight
blk.16.ssm_dt.bias
blk.16.ssm_norm.weight
blk.16.ssm_out.weight
```


### blk.17 (ssm)

```text
blk.17.attn_gate.weight
blk.17.attn_norm.weight
blk.17.attn_qkv.weight
blk.17.ffn_down.weight
blk.17.ffn_gate.weight
blk.17.ffn_up.weight
blk.17.post_attention_norm.weight
blk.17.ssm_a
blk.17.ssm_alpha.weight
blk.17.ssm_beta.weight
blk.17.ssm_conv1d.weight
blk.17.ssm_dt.bias
blk.17.ssm_norm.weight
blk.17.ssm_out.weight
```


### blk.18 (ssm)

```text
blk.18.attn_gate.weight
blk.18.attn_norm.weight
blk.18.attn_qkv.weight
blk.18.ffn_down.weight
blk.18.ffn_gate.weight
blk.18.ffn_up.weight
blk.18.post_attention_norm.weight
blk.18.ssm_a
blk.18.ssm_alpha.weight
blk.18.ssm_beta.weight
blk.18.ssm_conv1d.weight
blk.18.ssm_dt.bias
blk.18.ssm_norm.weight
blk.18.ssm_out.weight
```


### blk.19 (attention)

```text
blk.19.attn_k.weight
blk.19.attn_k_norm.weight
blk.19.attn_norm.weight
blk.19.attn_output.weight
blk.19.attn_q.weight
blk.19.attn_q_norm.weight
blk.19.attn_v.weight
blk.19.ffn_down.weight
blk.19.ffn_gate.weight
blk.19.ffn_up.weight
blk.19.post_attention_norm.weight
```


### blk.20 (ssm)

```text
blk.20.attn_gate.weight
blk.20.attn_norm.weight
blk.20.attn_qkv.weight
blk.20.ffn_down.weight
blk.20.ffn_gate.weight
blk.20.ffn_up.weight
blk.20.post_attention_norm.weight
blk.20.ssm_a
blk.20.ssm_alpha.weight
blk.20.ssm_beta.weight
blk.20.ssm_conv1d.weight
blk.20.ssm_dt.bias
blk.20.ssm_norm.weight
blk.20.ssm_out.weight
```


### blk.21 (ssm)

```text
blk.21.attn_gate.weight
blk.21.attn_norm.weight
blk.21.attn_qkv.weight
blk.21.ffn_down.weight
blk.21.ffn_gate.weight
blk.21.ffn_up.weight
blk.21.post_attention_norm.weight
blk.21.ssm_a
blk.21.ssm_alpha.weight
blk.21.ssm_beta.weight
blk.21.ssm_conv1d.weight
blk.21.ssm_dt.bias
blk.21.ssm_norm.weight
blk.21.ssm_out.weight
```


### blk.22 (ssm)

```text
blk.22.attn_gate.weight
blk.22.attn_norm.weight
blk.22.attn_qkv.weight
blk.22.ffn_down.weight
blk.22.ffn_gate.weight
blk.22.ffn_up.weight
blk.22.post_attention_norm.weight
blk.22.ssm_a
blk.22.ssm_alpha.weight
blk.22.ssm_beta.weight
blk.22.ssm_conv1d.weight
blk.22.ssm_dt.bias
blk.22.ssm_norm.weight
blk.22.ssm_out.weight
```


### blk.23 (attention)

```text
blk.23.attn_k.weight
blk.23.attn_k_norm.weight
blk.23.attn_norm.weight
blk.23.attn_output.weight
blk.23.attn_q.weight
blk.23.attn_q_norm.weight
blk.23.attn_v.weight
blk.23.ffn_down.weight
blk.23.ffn_gate.weight
blk.23.ffn_up.weight
blk.23.post_attention_norm.weight
```


### blk.24 (ssm)

```text
blk.24.attn_gate.weight
blk.24.attn_norm.weight
blk.24.attn_qkv.weight
blk.24.ffn_down.weight
blk.24.ffn_gate.weight
blk.24.ffn_up.weight
blk.24.post_attention_norm.weight
blk.24.ssm_a
blk.24.ssm_alpha.weight
blk.24.ssm_beta.weight
blk.24.ssm_conv1d.weight
blk.24.ssm_dt.bias
blk.24.ssm_norm.weight
blk.24.ssm_out.weight
```


### blk.25 (ssm)

```text
blk.25.attn_gate.weight
blk.25.attn_norm.weight
blk.25.attn_qkv.weight
blk.25.ffn_down.weight
blk.25.ffn_gate.weight
blk.25.ffn_up.weight
blk.25.post_attention_norm.weight
blk.25.ssm_a
blk.25.ssm_alpha.weight
blk.25.ssm_beta.weight
blk.25.ssm_conv1d.weight
blk.25.ssm_dt.bias
blk.25.ssm_norm.weight
blk.25.ssm_out.weight
```


### blk.26 (ssm)

```text
blk.26.attn_gate.weight
blk.26.attn_norm.weight
blk.26.attn_qkv.weight
blk.26.ffn_down.weight
blk.26.ffn_gate.weight
blk.26.ffn_up.weight
blk.26.post_attention_norm.weight
blk.26.ssm_a
blk.26.ssm_alpha.weight
blk.26.ssm_beta.weight
blk.26.ssm_conv1d.weight
blk.26.ssm_dt.bias
blk.26.ssm_norm.weight
blk.26.ssm_out.weight
```


### blk.27 (attention)

```text
blk.27.attn_k.weight
blk.27.attn_k_norm.weight
blk.27.attn_norm.weight
blk.27.attn_output.weight
blk.27.attn_q.weight
blk.27.attn_q_norm.weight
blk.27.attn_v.weight
blk.27.ffn_down.weight
blk.27.ffn_gate.weight
blk.27.ffn_up.weight
blk.27.post_attention_norm.weight
```


### blk.28 (ssm)

```text
blk.28.attn_gate.weight
blk.28.attn_norm.weight
blk.28.attn_qkv.weight
blk.28.ffn_down.weight
blk.28.ffn_gate.weight
blk.28.ffn_up.weight
blk.28.post_attention_norm.weight
blk.28.ssm_a
blk.28.ssm_alpha.weight
blk.28.ssm_beta.weight
blk.28.ssm_conv1d.weight
blk.28.ssm_dt.bias
blk.28.ssm_norm.weight
blk.28.ssm_out.weight
```


### blk.29 (ssm)

```text
blk.29.attn_gate.weight
blk.29.attn_norm.weight
blk.29.attn_qkv.weight
blk.29.ffn_down.weight
blk.29.ffn_gate.weight
blk.29.ffn_up.weight
blk.29.post_attention_norm.weight
blk.29.ssm_a
blk.29.ssm_alpha.weight
blk.29.ssm_beta.weight
blk.29.ssm_conv1d.weight
blk.29.ssm_dt.bias
blk.29.ssm_norm.weight
blk.29.ssm_out.weight
```


### blk.30 (ssm)

```text
blk.30.attn_gate.weight
blk.30.attn_norm.weight
blk.30.attn_qkv.weight
blk.30.ffn_down.weight
blk.30.ffn_gate.weight
blk.30.ffn_up.weight
blk.30.post_attention_norm.weight
blk.30.ssm_a
blk.30.ssm_alpha.weight
blk.30.ssm_beta.weight
blk.30.ssm_conv1d.weight
blk.30.ssm_dt.bias
blk.30.ssm_norm.weight
blk.30.ssm_out.weight
```


### blk.31 (attention)

```text
blk.31.attn_k.weight
blk.31.attn_k_norm.weight
blk.31.attn_norm.weight
blk.31.attn_output.weight
blk.31.attn_q.weight
blk.31.attn_q_norm.weight
blk.31.attn_v.weight
blk.31.ffn_down.weight
blk.31.ffn_gate.weight
blk.31.ffn_up.weight
blk.31.post_attention_norm.weight
```


### blk.32 (ssm)

```text
blk.32.attn_gate.weight
blk.32.attn_norm.weight
blk.32.attn_qkv.weight
blk.32.ffn_down.weight
blk.32.ffn_gate.weight
blk.32.ffn_up.weight
blk.32.post_attention_norm.weight
blk.32.ssm_a
blk.32.ssm_alpha.weight
blk.32.ssm_beta.weight
blk.32.ssm_conv1d.weight
blk.32.ssm_dt.bias
blk.32.ssm_norm.weight
blk.32.ssm_out.weight
```


### blk.33 (ssm)

```text
blk.33.attn_gate.weight
blk.33.attn_norm.weight
blk.33.attn_qkv.weight
blk.33.ffn_down.weight
blk.33.ffn_gate.weight
blk.33.ffn_up.weight
blk.33.post_attention_norm.weight
blk.33.ssm_a
blk.33.ssm_alpha.weight
blk.33.ssm_beta.weight
blk.33.ssm_conv1d.weight
blk.33.ssm_dt.bias
blk.33.ssm_norm.weight
blk.33.ssm_out.weight
```


### blk.34 (ssm)

```text
blk.34.attn_gate.weight
blk.34.attn_norm.weight
blk.34.attn_qkv.weight
blk.34.ffn_down.weight
blk.34.ffn_gate.weight
blk.34.ffn_up.weight
blk.34.post_attention_norm.weight
blk.34.ssm_a
blk.34.ssm_alpha.weight
blk.34.ssm_beta.weight
blk.34.ssm_conv1d.weight
blk.34.ssm_dt.bias
blk.34.ssm_norm.weight
blk.34.ssm_out.weight
```


### blk.35 (attention)

```text
blk.35.attn_k.weight
blk.35.attn_k_norm.weight
blk.35.attn_norm.weight
blk.35.attn_output.weight
blk.35.attn_q.weight
blk.35.attn_q_norm.weight
blk.35.attn_v.weight
blk.35.ffn_down.weight
blk.35.ffn_gate.weight
blk.35.ffn_up.weight
blk.35.post_attention_norm.weight
```


### blk.36 (ssm)

```text
blk.36.attn_gate.weight
blk.36.attn_norm.weight
blk.36.attn_qkv.weight
blk.36.ffn_down.weight
blk.36.ffn_gate.weight
blk.36.ffn_up.weight
blk.36.post_attention_norm.weight
blk.36.ssm_a
blk.36.ssm_alpha.weight
blk.36.ssm_beta.weight
blk.36.ssm_conv1d.weight
blk.36.ssm_dt.bias
blk.36.ssm_norm.weight
blk.36.ssm_out.weight
```


### blk.37 (ssm)

```text
blk.37.attn_gate.weight
blk.37.attn_norm.weight
blk.37.attn_qkv.weight
blk.37.ffn_down.weight
blk.37.ffn_gate.weight
blk.37.ffn_up.weight
blk.37.post_attention_norm.weight
blk.37.ssm_a
blk.37.ssm_alpha.weight
blk.37.ssm_beta.weight
blk.37.ssm_conv1d.weight
blk.37.ssm_dt.bias
blk.37.ssm_norm.weight
blk.37.ssm_out.weight
```


### blk.38 (ssm)

```text
blk.38.attn_gate.weight
blk.38.attn_norm.weight
blk.38.attn_qkv.weight
blk.38.ffn_down.weight
blk.38.ffn_gate.weight
blk.38.ffn_up.weight
blk.38.post_attention_norm.weight
blk.38.ssm_a
blk.38.ssm_alpha.weight
blk.38.ssm_beta.weight
blk.38.ssm_conv1d.weight
blk.38.ssm_dt.bias
blk.38.ssm_norm.weight
blk.38.ssm_out.weight
```


### blk.39 (attention)

```text
blk.39.attn_k.weight
blk.39.attn_k_norm.weight
blk.39.attn_norm.weight
blk.39.attn_output.weight
blk.39.attn_q.weight
blk.39.attn_q_norm.weight
blk.39.attn_v.weight
blk.39.ffn_down.weight
blk.39.ffn_gate.weight
blk.39.ffn_up.weight
blk.39.post_attention_norm.weight
```


### blk.40 (ssm)

```text
blk.40.attn_gate.weight
blk.40.attn_norm.weight
blk.40.attn_qkv.weight
blk.40.ffn_down.weight
blk.40.ffn_gate.weight
blk.40.ffn_up.weight
blk.40.post_attention_norm.weight
blk.40.ssm_a
blk.40.ssm_alpha.weight
blk.40.ssm_beta.weight
blk.40.ssm_conv1d.weight
blk.40.ssm_dt.bias
blk.40.ssm_norm.weight
blk.40.ssm_out.weight
```


### blk.41 (ssm)

```text
blk.41.attn_gate.weight
blk.41.attn_norm.weight
blk.41.attn_qkv.weight
blk.41.ffn_down.weight
blk.41.ffn_gate.weight
blk.41.ffn_up.weight
blk.41.post_attention_norm.weight
blk.41.ssm_a
blk.41.ssm_alpha.weight
blk.41.ssm_beta.weight
blk.41.ssm_conv1d.weight
blk.41.ssm_dt.bias
blk.41.ssm_norm.weight
blk.41.ssm_out.weight
```


### blk.42 (ssm)

```text
blk.42.attn_gate.weight
blk.42.attn_norm.weight
blk.42.attn_qkv.weight
blk.42.ffn_down.weight
blk.42.ffn_gate.weight
blk.42.ffn_up.weight
blk.42.post_attention_norm.weight
blk.42.ssm_a
blk.42.ssm_alpha.weight
blk.42.ssm_beta.weight
blk.42.ssm_conv1d.weight
blk.42.ssm_dt.bias
blk.42.ssm_norm.weight
blk.42.ssm_out.weight
```


### blk.43 (attention)

```text
blk.43.attn_k.weight
blk.43.attn_k_norm.weight
blk.43.attn_norm.weight
blk.43.attn_output.weight
blk.43.attn_q.weight
blk.43.attn_q_norm.weight
blk.43.attn_v.weight
blk.43.ffn_down.weight
blk.43.ffn_gate.weight
blk.43.ffn_up.weight
blk.43.post_attention_norm.weight
```


### blk.44 (ssm)

```text
blk.44.attn_gate.weight
blk.44.attn_norm.weight
blk.44.attn_qkv.weight
blk.44.ffn_down.weight
blk.44.ffn_gate.weight
blk.44.ffn_up.weight
blk.44.post_attention_norm.weight
blk.44.ssm_a
blk.44.ssm_alpha.weight
blk.44.ssm_beta.weight
blk.44.ssm_conv1d.weight
blk.44.ssm_dt.bias
blk.44.ssm_norm.weight
blk.44.ssm_out.weight
```


### blk.45 (ssm)

```text
blk.45.attn_gate.weight
blk.45.attn_norm.weight
blk.45.attn_qkv.weight
blk.45.ffn_down.weight
blk.45.ffn_gate.weight
blk.45.ffn_up.weight
blk.45.post_attention_norm.weight
blk.45.ssm_a
blk.45.ssm_alpha.weight
blk.45.ssm_beta.weight
blk.45.ssm_conv1d.weight
blk.45.ssm_dt.bias
blk.45.ssm_norm.weight
blk.45.ssm_out.weight
```


### blk.46 (ssm)

```text
blk.46.attn_gate.weight
blk.46.attn_norm.weight
blk.46.attn_qkv.weight
blk.46.ffn_down.weight
blk.46.ffn_gate.weight
blk.46.ffn_up.weight
blk.46.post_attention_norm.weight
blk.46.ssm_a
blk.46.ssm_alpha.weight
blk.46.ssm_beta.weight
blk.46.ssm_conv1d.weight
blk.46.ssm_dt.bias
blk.46.ssm_norm.weight
blk.46.ssm_out.weight
```


### blk.47 (attention)

```text
blk.47.attn_k.weight
blk.47.attn_k_norm.weight
blk.47.attn_norm.weight
blk.47.attn_output.weight
blk.47.attn_q.weight
blk.47.attn_q_norm.weight
blk.47.attn_v.weight
blk.47.ffn_down.weight
blk.47.ffn_gate.weight
blk.47.ffn_up.weight
blk.47.post_attention_norm.weight
```


### blk.48 (ssm)

```text
blk.48.attn_gate.weight
blk.48.attn_norm.weight
blk.48.attn_qkv.weight
blk.48.ffn_down.weight
blk.48.ffn_gate.weight
blk.48.ffn_up.weight
blk.48.post_attention_norm.weight
blk.48.ssm_a
blk.48.ssm_alpha.weight
blk.48.ssm_beta.weight
blk.48.ssm_conv1d.weight
blk.48.ssm_dt.bias
blk.48.ssm_norm.weight
blk.48.ssm_out.weight
```


### blk.49 (ssm)

```text
blk.49.attn_gate.weight
blk.49.attn_norm.weight
blk.49.attn_qkv.weight
blk.49.ffn_down.weight
blk.49.ffn_gate.weight
blk.49.ffn_up.weight
blk.49.post_attention_norm.weight
blk.49.ssm_a
blk.49.ssm_alpha.weight
blk.49.ssm_beta.weight
blk.49.ssm_conv1d.weight
blk.49.ssm_dt.bias
blk.49.ssm_norm.weight
blk.49.ssm_out.weight
```


### blk.50 (ssm)

```text
blk.50.attn_gate.weight
blk.50.attn_norm.weight
blk.50.attn_qkv.weight
blk.50.ffn_down.weight
blk.50.ffn_gate.weight
blk.50.ffn_up.weight
blk.50.post_attention_norm.weight
blk.50.ssm_a
blk.50.ssm_alpha.weight
blk.50.ssm_beta.weight
blk.50.ssm_conv1d.weight
blk.50.ssm_dt.bias
blk.50.ssm_norm.weight
blk.50.ssm_out.weight
```


### blk.51 (attention)

```text
blk.51.attn_k.weight
blk.51.attn_k_norm.weight
blk.51.attn_norm.weight
blk.51.attn_output.weight
blk.51.attn_q.weight
blk.51.attn_q_norm.weight
blk.51.attn_v.weight
blk.51.ffn_down.weight
blk.51.ffn_gate.weight
blk.51.ffn_up.weight
blk.51.post_attention_norm.weight
```


### blk.52 (ssm)

```text
blk.52.attn_gate.weight
blk.52.attn_norm.weight
blk.52.attn_qkv.weight
blk.52.ffn_down.weight
blk.52.ffn_gate.weight
blk.52.ffn_up.weight
blk.52.post_attention_norm.weight
blk.52.ssm_a
blk.52.ssm_alpha.weight
blk.52.ssm_beta.weight
blk.52.ssm_conv1d.weight
blk.52.ssm_dt.bias
blk.52.ssm_norm.weight
blk.52.ssm_out.weight
```


### blk.53 (ssm)

```text
blk.53.attn_gate.weight
blk.53.attn_norm.weight
blk.53.attn_qkv.weight
blk.53.ffn_down.weight
blk.53.ffn_gate.weight
blk.53.ffn_up.weight
blk.53.post_attention_norm.weight
blk.53.ssm_a
blk.53.ssm_alpha.weight
blk.53.ssm_beta.weight
blk.53.ssm_conv1d.weight
blk.53.ssm_dt.bias
blk.53.ssm_norm.weight
blk.53.ssm_out.weight
```


### blk.54 (ssm)

```text
blk.54.attn_gate.weight
blk.54.attn_norm.weight
blk.54.attn_qkv.weight
blk.54.ffn_down.weight
blk.54.ffn_gate.weight
blk.54.ffn_up.weight
blk.54.post_attention_norm.weight
blk.54.ssm_a
blk.54.ssm_alpha.weight
blk.54.ssm_beta.weight
blk.54.ssm_conv1d.weight
blk.54.ssm_dt.bias
blk.54.ssm_norm.weight
blk.54.ssm_out.weight
```


### blk.55 (attention)

```text
blk.55.attn_k.weight
blk.55.attn_k_norm.weight
blk.55.attn_norm.weight
blk.55.attn_output.weight
blk.55.attn_q.weight
blk.55.attn_q_norm.weight
blk.55.attn_v.weight
blk.55.ffn_down.weight
blk.55.ffn_gate.weight
blk.55.ffn_up.weight
blk.55.post_attention_norm.weight
```


### blk.56 (ssm)

```text
blk.56.attn_gate.weight
blk.56.attn_norm.weight
blk.56.attn_qkv.weight
blk.56.ffn_down.weight
blk.56.ffn_gate.weight
blk.56.ffn_up.weight
blk.56.post_attention_norm.weight
blk.56.ssm_a
blk.56.ssm_alpha.weight
blk.56.ssm_beta.weight
blk.56.ssm_conv1d.weight
blk.56.ssm_dt.bias
blk.56.ssm_norm.weight
blk.56.ssm_out.weight
```


### blk.57 (ssm)

```text
blk.57.attn_gate.weight
blk.57.attn_norm.weight
blk.57.attn_qkv.weight
blk.57.ffn_down.weight
blk.57.ffn_gate.weight
blk.57.ffn_up.weight
blk.57.post_attention_norm.weight
blk.57.ssm_a
blk.57.ssm_alpha.weight
blk.57.ssm_beta.weight
blk.57.ssm_conv1d.weight
blk.57.ssm_dt.bias
blk.57.ssm_norm.weight
blk.57.ssm_out.weight
```


### blk.58 (ssm)

```text
blk.58.attn_gate.weight
blk.58.attn_norm.weight
blk.58.attn_qkv.weight
blk.58.ffn_down.weight
blk.58.ffn_gate.weight
blk.58.ffn_up.weight
blk.58.post_attention_norm.weight
blk.58.ssm_a
blk.58.ssm_alpha.weight
blk.58.ssm_beta.weight
blk.58.ssm_conv1d.weight
blk.58.ssm_dt.bias
blk.58.ssm_norm.weight
blk.58.ssm_out.weight
```


### blk.59 (attention)

```text
blk.59.attn_k.weight
blk.59.attn_k_norm.weight
blk.59.attn_norm.weight
blk.59.attn_output.weight
blk.59.attn_q.weight
blk.59.attn_q_norm.weight
blk.59.attn_v.weight
blk.59.ffn_down.weight
blk.59.ffn_gate.weight
blk.59.ffn_up.weight
blk.59.post_attention_norm.weight
```


### blk.60 (ssm)

```text
blk.60.attn_gate.weight
blk.60.attn_norm.weight
blk.60.attn_qkv.weight
blk.60.ffn_down.weight
blk.60.ffn_gate.weight
blk.60.ffn_up.weight
blk.60.post_attention_norm.weight
blk.60.ssm_a
blk.60.ssm_alpha.weight
blk.60.ssm_beta.weight
blk.60.ssm_conv1d.weight
blk.60.ssm_dt.bias
blk.60.ssm_norm.weight
blk.60.ssm_out.weight
```


### blk.61 (ssm)

```text
blk.61.attn_gate.weight
blk.61.attn_norm.weight
blk.61.attn_qkv.weight
blk.61.ffn_down.weight
blk.61.ffn_gate.weight
blk.61.ffn_up.weight
blk.61.post_attention_norm.weight
blk.61.ssm_a
blk.61.ssm_alpha.weight
blk.61.ssm_beta.weight
blk.61.ssm_conv1d.weight
blk.61.ssm_dt.bias
blk.61.ssm_norm.weight
blk.61.ssm_out.weight
```


### blk.62 (ssm)

```text
blk.62.attn_gate.weight
blk.62.attn_norm.weight
blk.62.attn_qkv.weight
blk.62.ffn_down.weight
blk.62.ffn_gate.weight
blk.62.ffn_up.weight
blk.62.post_attention_norm.weight
blk.62.ssm_a
blk.62.ssm_alpha.weight
blk.62.ssm_beta.weight
blk.62.ssm_conv1d.weight
blk.62.ssm_dt.bias
blk.62.ssm_norm.weight
blk.62.ssm_out.weight
```


### blk.63 (attention)

```text
blk.63.attn_k.weight
blk.63.attn_k_norm.weight
blk.63.attn_norm.weight
blk.63.attn_output.weight
blk.63.attn_q.weight
blk.63.attn_q_norm.weight
blk.63.attn_v.weight
blk.63.ffn_down.weight
blk.63.ffn_gate.weight
blk.63.ffn_up.weight
blk.63.post_attention_norm.weight
```


### blk.64 (attention)

```text
blk.64.attn_k.weight
blk.64.attn_k_norm.weight
blk.64.attn_norm.weight
blk.64.attn_output.weight
blk.64.attn_q.weight
blk.64.attn_q_norm.weight
blk.64.attn_v.weight
blk.64.ffn_down.weight
blk.64.ffn_gate.weight
blk.64.ffn_up.weight
blk.64.nextn.eh_proj.weight
blk.64.nextn.enorm.weight
blk.64.nextn.hnorm.weight
blk.64.nextn.shared_head_norm.weight
blk.64.post_attention_norm.weight
```


## `--override-tensor` audit

From `llamacpp-model-data.json`:

```json
"--override-tensor 'blk\\.([0-9]|1[0-9]|2[0-2])\\.ffn_.*=CPU'"
```

- pattern: `blk\.([0-9]|1[0-9]|2[0-2])\.ffn_.*` → device `CPU`
- matching semantics: `std::regex_search` on the full tensor name (substring match), first hit wins — `src/llama-model-loader.cpp`
- matched tensors: **69**
- layers matched: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22
- bytes moved to CPU (Q8_0): 6.09 GiB
- bytes moved to CPU (Q6_K): 4.70 GiB
- bytes moved to CPU (Q4_K_M): 3.50 GiB
- `ffn_*` tensors NOT matched (stay on GPU): 126 — layers 23…64
- accidental matches (non-`ffn_*` names): none

