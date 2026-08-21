---
model: unsloth/GLM-4.7-Flash-GGUF
quants: Q6_K, Q8_0
file_Q6_K: GLM-4.7-Flash-Q6_K.gguf
file_Q8_0: GLM-4.7-Flash-Q8_0.gguf
tensor_count: 844
generator: local-llm/generate-layer-cards.py
generated: 2026-08-18 01:59 UTC
---

# Layer names — unsloth/GLM-4.7-Flash-GGUF

Every tensor (layer) name read from the GGUF **tensor-info header** — no weights are loaded into memory. Layer names are architecture-level and identical across quants; per-tensor sizes are listed per quant.

## Summary

| field | value |
|---|---|
| architecture | `deepseek2` |
| block count | 47 (`blk.0` … `blk.46`) |
| context length | 202752 |
| embedding length | 2048 |
| total tensors | 844 |
| non-layer tensors | 3 |
| attention blocks | 47 — 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46 |
| quants analyzed | Q6_K, Q8_0 |

## Non-layer tensors

| tensor | shape | MiB (Q6_K) | MiB (Q8_0) |
|---|---|---|---|
| `output.weight` | [2048 x 154880] | 248.1 | 321.4 |
| `output_norm.weight` | [2048] | 0.0 | 0.0 |
| `token_embd.weight` | [2048 x 154880] | 248.1 | 321.4 |

## Block layout

### attention blocks — 47 (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46)

| tensor | shape | MiB (Q6_K) | MiB (Q8_0) |
|---|---|---|---|
| `attn_k_b.weight` | [192 x 512 x 20] | 2.0 | 2.0 |
| `attn_kv_a_mqa.weight` | [2048 x 576] | 1.2 | 1.2 |
| `attn_kv_a_norm.weight` | [512] | 0.0 | 0.0 |
| `attn_norm.weight` | [2048] | 0.0 | 0.0 |
| `attn_output.weight` | [5120 x 2048] | 8.2 | 10.6 |
| `attn_q_a.weight` | [2048 x 768] | 1.2 | 1.6 |
| `attn_q_a_norm.weight` | [768] | 0.0 | 0.0 |
| `attn_q_b.weight` | [768 x 5120] | 3.1 | 4.0 |
| `attn_v_b.weight` | [512 x 256 x 20] | 2.7 | 2.7 |
| `ffn_norm.weight` | [2048] | 0.0 | 0.0 |

Blocks with additional tensors on top of the canonical set:

- `blk.0`: `ffn_down.weight`, `ffn_gate.weight`, `ffn_up.weight`
- `blk.1`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.2`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.3`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.4`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.5`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.6`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.7`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.8`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.9`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.10`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.11`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.12`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.13`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.14`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.15`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.16`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.17`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.18`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.19`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.20`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.21`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.22`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.23`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.24`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.25`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.26`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.27`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.28`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.29`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.30`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.31`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.32`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.33`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.34`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.35`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.36`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.37`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.38`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.39`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.40`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.41`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.42`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.43`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.44`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.45`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.46`: `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`


## All tensors by block

- `output.weight`
- `output_norm.weight`
- `token_embd.weight`

### blk.0 (attention)

```text
blk.0.attn_k_b.weight
blk.0.attn_kv_a_mqa.weight
blk.0.attn_kv_a_norm.weight
blk.0.attn_norm.weight
blk.0.attn_output.weight
blk.0.attn_q_a.weight
blk.0.attn_q_a_norm.weight
blk.0.attn_q_b.weight
blk.0.attn_v_b.weight
blk.0.ffn_down.weight
blk.0.ffn_gate.weight
blk.0.ffn_norm.weight
blk.0.ffn_up.weight
```


### blk.1 (attention)

```text
blk.1.attn_k_b.weight
blk.1.attn_kv_a_mqa.weight
blk.1.attn_kv_a_norm.weight
blk.1.attn_norm.weight
blk.1.attn_output.weight
blk.1.attn_q_a.weight
blk.1.attn_q_a_norm.weight
blk.1.attn_q_b.weight
blk.1.attn_v_b.weight
blk.1.exp_probs_b.bias
blk.1.ffn_down_exps.weight
blk.1.ffn_down_shexp.weight
blk.1.ffn_gate_exps.weight
blk.1.ffn_gate_inp.weight
blk.1.ffn_gate_shexp.weight
blk.1.ffn_norm.weight
blk.1.ffn_up_exps.weight
blk.1.ffn_up_shexp.weight
```


### blk.2 (attention)

```text
blk.2.attn_k_b.weight
blk.2.attn_kv_a_mqa.weight
blk.2.attn_kv_a_norm.weight
blk.2.attn_norm.weight
blk.2.attn_output.weight
blk.2.attn_q_a.weight
blk.2.attn_q_a_norm.weight
blk.2.attn_q_b.weight
blk.2.attn_v_b.weight
blk.2.exp_probs_b.bias
blk.2.ffn_down_exps.weight
blk.2.ffn_down_shexp.weight
blk.2.ffn_gate_exps.weight
blk.2.ffn_gate_inp.weight
blk.2.ffn_gate_shexp.weight
blk.2.ffn_norm.weight
blk.2.ffn_up_exps.weight
blk.2.ffn_up_shexp.weight
```


### blk.3 (attention)

```text
blk.3.attn_k_b.weight
blk.3.attn_kv_a_mqa.weight
blk.3.attn_kv_a_norm.weight
blk.3.attn_norm.weight
blk.3.attn_output.weight
blk.3.attn_q_a.weight
blk.3.attn_q_a_norm.weight
blk.3.attn_q_b.weight
blk.3.attn_v_b.weight
blk.3.exp_probs_b.bias
blk.3.ffn_down_exps.weight
blk.3.ffn_down_shexp.weight
blk.3.ffn_gate_exps.weight
blk.3.ffn_gate_inp.weight
blk.3.ffn_gate_shexp.weight
blk.3.ffn_norm.weight
blk.3.ffn_up_exps.weight
blk.3.ffn_up_shexp.weight
```


### blk.4 (attention)

```text
blk.4.attn_k_b.weight
blk.4.attn_kv_a_mqa.weight
blk.4.attn_kv_a_norm.weight
blk.4.attn_norm.weight
blk.4.attn_output.weight
blk.4.attn_q_a.weight
blk.4.attn_q_a_norm.weight
blk.4.attn_q_b.weight
blk.4.attn_v_b.weight
blk.4.exp_probs_b.bias
blk.4.ffn_down_exps.weight
blk.4.ffn_down_shexp.weight
blk.4.ffn_gate_exps.weight
blk.4.ffn_gate_inp.weight
blk.4.ffn_gate_shexp.weight
blk.4.ffn_norm.weight
blk.4.ffn_up_exps.weight
blk.4.ffn_up_shexp.weight
```


### blk.5 (attention)

```text
blk.5.attn_k_b.weight
blk.5.attn_kv_a_mqa.weight
blk.5.attn_kv_a_norm.weight
blk.5.attn_norm.weight
blk.5.attn_output.weight
blk.5.attn_q_a.weight
blk.5.attn_q_a_norm.weight
blk.5.attn_q_b.weight
blk.5.attn_v_b.weight
blk.5.exp_probs_b.bias
blk.5.ffn_down_exps.weight
blk.5.ffn_down_shexp.weight
blk.5.ffn_gate_exps.weight
blk.5.ffn_gate_inp.weight
blk.5.ffn_gate_shexp.weight
blk.5.ffn_norm.weight
blk.5.ffn_up_exps.weight
blk.5.ffn_up_shexp.weight
```


### blk.6 (attention)

```text
blk.6.attn_k_b.weight
blk.6.attn_kv_a_mqa.weight
blk.6.attn_kv_a_norm.weight
blk.6.attn_norm.weight
blk.6.attn_output.weight
blk.6.attn_q_a.weight
blk.6.attn_q_a_norm.weight
blk.6.attn_q_b.weight
blk.6.attn_v_b.weight
blk.6.exp_probs_b.bias
blk.6.ffn_down_exps.weight
blk.6.ffn_down_shexp.weight
blk.6.ffn_gate_exps.weight
blk.6.ffn_gate_inp.weight
blk.6.ffn_gate_shexp.weight
blk.6.ffn_norm.weight
blk.6.ffn_up_exps.weight
blk.6.ffn_up_shexp.weight
```


### blk.7 (attention)

```text
blk.7.attn_k_b.weight
blk.7.attn_kv_a_mqa.weight
blk.7.attn_kv_a_norm.weight
blk.7.attn_norm.weight
blk.7.attn_output.weight
blk.7.attn_q_a.weight
blk.7.attn_q_a_norm.weight
blk.7.attn_q_b.weight
blk.7.attn_v_b.weight
blk.7.exp_probs_b.bias
blk.7.ffn_down_exps.weight
blk.7.ffn_down_shexp.weight
blk.7.ffn_gate_exps.weight
blk.7.ffn_gate_inp.weight
blk.7.ffn_gate_shexp.weight
blk.7.ffn_norm.weight
blk.7.ffn_up_exps.weight
blk.7.ffn_up_shexp.weight
```


### blk.8 (attention)

```text
blk.8.attn_k_b.weight
blk.8.attn_kv_a_mqa.weight
blk.8.attn_kv_a_norm.weight
blk.8.attn_norm.weight
blk.8.attn_output.weight
blk.8.attn_q_a.weight
blk.8.attn_q_a_norm.weight
blk.8.attn_q_b.weight
blk.8.attn_v_b.weight
blk.8.exp_probs_b.bias
blk.8.ffn_down_exps.weight
blk.8.ffn_down_shexp.weight
blk.8.ffn_gate_exps.weight
blk.8.ffn_gate_inp.weight
blk.8.ffn_gate_shexp.weight
blk.8.ffn_norm.weight
blk.8.ffn_up_exps.weight
blk.8.ffn_up_shexp.weight
```


### blk.9 (attention)

```text
blk.9.attn_k_b.weight
blk.9.attn_kv_a_mqa.weight
blk.9.attn_kv_a_norm.weight
blk.9.attn_norm.weight
blk.9.attn_output.weight
blk.9.attn_q_a.weight
blk.9.attn_q_a_norm.weight
blk.9.attn_q_b.weight
blk.9.attn_v_b.weight
blk.9.exp_probs_b.bias
blk.9.ffn_down_exps.weight
blk.9.ffn_down_shexp.weight
blk.9.ffn_gate_exps.weight
blk.9.ffn_gate_inp.weight
blk.9.ffn_gate_shexp.weight
blk.9.ffn_norm.weight
blk.9.ffn_up_exps.weight
blk.9.ffn_up_shexp.weight
```


### blk.10 (attention)

```text
blk.10.attn_k_b.weight
blk.10.attn_kv_a_mqa.weight
blk.10.attn_kv_a_norm.weight
blk.10.attn_norm.weight
blk.10.attn_output.weight
blk.10.attn_q_a.weight
blk.10.attn_q_a_norm.weight
blk.10.attn_q_b.weight
blk.10.attn_v_b.weight
blk.10.exp_probs_b.bias
blk.10.ffn_down_exps.weight
blk.10.ffn_down_shexp.weight
blk.10.ffn_gate_exps.weight
blk.10.ffn_gate_inp.weight
blk.10.ffn_gate_shexp.weight
blk.10.ffn_norm.weight
blk.10.ffn_up_exps.weight
blk.10.ffn_up_shexp.weight
```


### blk.11 (attention)

```text
blk.11.attn_k_b.weight
blk.11.attn_kv_a_mqa.weight
blk.11.attn_kv_a_norm.weight
blk.11.attn_norm.weight
blk.11.attn_output.weight
blk.11.attn_q_a.weight
blk.11.attn_q_a_norm.weight
blk.11.attn_q_b.weight
blk.11.attn_v_b.weight
blk.11.exp_probs_b.bias
blk.11.ffn_down_exps.weight
blk.11.ffn_down_shexp.weight
blk.11.ffn_gate_exps.weight
blk.11.ffn_gate_inp.weight
blk.11.ffn_gate_shexp.weight
blk.11.ffn_norm.weight
blk.11.ffn_up_exps.weight
blk.11.ffn_up_shexp.weight
```


### blk.12 (attention)

```text
blk.12.attn_k_b.weight
blk.12.attn_kv_a_mqa.weight
blk.12.attn_kv_a_norm.weight
blk.12.attn_norm.weight
blk.12.attn_output.weight
blk.12.attn_q_a.weight
blk.12.attn_q_a_norm.weight
blk.12.attn_q_b.weight
blk.12.attn_v_b.weight
blk.12.exp_probs_b.bias
blk.12.ffn_down_exps.weight
blk.12.ffn_down_shexp.weight
blk.12.ffn_gate_exps.weight
blk.12.ffn_gate_inp.weight
blk.12.ffn_gate_shexp.weight
blk.12.ffn_norm.weight
blk.12.ffn_up_exps.weight
blk.12.ffn_up_shexp.weight
```


### blk.13 (attention)

```text
blk.13.attn_k_b.weight
blk.13.attn_kv_a_mqa.weight
blk.13.attn_kv_a_norm.weight
blk.13.attn_norm.weight
blk.13.attn_output.weight
blk.13.attn_q_a.weight
blk.13.attn_q_a_norm.weight
blk.13.attn_q_b.weight
blk.13.attn_v_b.weight
blk.13.exp_probs_b.bias
blk.13.ffn_down_exps.weight
blk.13.ffn_down_shexp.weight
blk.13.ffn_gate_exps.weight
blk.13.ffn_gate_inp.weight
blk.13.ffn_gate_shexp.weight
blk.13.ffn_norm.weight
blk.13.ffn_up_exps.weight
blk.13.ffn_up_shexp.weight
```


### blk.14 (attention)

```text
blk.14.attn_k_b.weight
blk.14.attn_kv_a_mqa.weight
blk.14.attn_kv_a_norm.weight
blk.14.attn_norm.weight
blk.14.attn_output.weight
blk.14.attn_q_a.weight
blk.14.attn_q_a_norm.weight
blk.14.attn_q_b.weight
blk.14.attn_v_b.weight
blk.14.exp_probs_b.bias
blk.14.ffn_down_exps.weight
blk.14.ffn_down_shexp.weight
blk.14.ffn_gate_exps.weight
blk.14.ffn_gate_inp.weight
blk.14.ffn_gate_shexp.weight
blk.14.ffn_norm.weight
blk.14.ffn_up_exps.weight
blk.14.ffn_up_shexp.weight
```


### blk.15 (attention)

```text
blk.15.attn_k_b.weight
blk.15.attn_kv_a_mqa.weight
blk.15.attn_kv_a_norm.weight
blk.15.attn_norm.weight
blk.15.attn_output.weight
blk.15.attn_q_a.weight
blk.15.attn_q_a_norm.weight
blk.15.attn_q_b.weight
blk.15.attn_v_b.weight
blk.15.exp_probs_b.bias
blk.15.ffn_down_exps.weight
blk.15.ffn_down_shexp.weight
blk.15.ffn_gate_exps.weight
blk.15.ffn_gate_inp.weight
blk.15.ffn_gate_shexp.weight
blk.15.ffn_norm.weight
blk.15.ffn_up_exps.weight
blk.15.ffn_up_shexp.weight
```


### blk.16 (attention)

```text
blk.16.attn_k_b.weight
blk.16.attn_kv_a_mqa.weight
blk.16.attn_kv_a_norm.weight
blk.16.attn_norm.weight
blk.16.attn_output.weight
blk.16.attn_q_a.weight
blk.16.attn_q_a_norm.weight
blk.16.attn_q_b.weight
blk.16.attn_v_b.weight
blk.16.exp_probs_b.bias
blk.16.ffn_down_exps.weight
blk.16.ffn_down_shexp.weight
blk.16.ffn_gate_exps.weight
blk.16.ffn_gate_inp.weight
blk.16.ffn_gate_shexp.weight
blk.16.ffn_norm.weight
blk.16.ffn_up_exps.weight
blk.16.ffn_up_shexp.weight
```


### blk.17 (attention)

```text
blk.17.attn_k_b.weight
blk.17.attn_kv_a_mqa.weight
blk.17.attn_kv_a_norm.weight
blk.17.attn_norm.weight
blk.17.attn_output.weight
blk.17.attn_q_a.weight
blk.17.attn_q_a_norm.weight
blk.17.attn_q_b.weight
blk.17.attn_v_b.weight
blk.17.exp_probs_b.bias
blk.17.ffn_down_exps.weight
blk.17.ffn_down_shexp.weight
blk.17.ffn_gate_exps.weight
blk.17.ffn_gate_inp.weight
blk.17.ffn_gate_shexp.weight
blk.17.ffn_norm.weight
blk.17.ffn_up_exps.weight
blk.17.ffn_up_shexp.weight
```


### blk.18 (attention)

```text
blk.18.attn_k_b.weight
blk.18.attn_kv_a_mqa.weight
blk.18.attn_kv_a_norm.weight
blk.18.attn_norm.weight
blk.18.attn_output.weight
blk.18.attn_q_a.weight
blk.18.attn_q_a_norm.weight
blk.18.attn_q_b.weight
blk.18.attn_v_b.weight
blk.18.exp_probs_b.bias
blk.18.ffn_down_exps.weight
blk.18.ffn_down_shexp.weight
blk.18.ffn_gate_exps.weight
blk.18.ffn_gate_inp.weight
blk.18.ffn_gate_shexp.weight
blk.18.ffn_norm.weight
blk.18.ffn_up_exps.weight
blk.18.ffn_up_shexp.weight
```


### blk.19 (attention)

```text
blk.19.attn_k_b.weight
blk.19.attn_kv_a_mqa.weight
blk.19.attn_kv_a_norm.weight
blk.19.attn_norm.weight
blk.19.attn_output.weight
blk.19.attn_q_a.weight
blk.19.attn_q_a_norm.weight
blk.19.attn_q_b.weight
blk.19.attn_v_b.weight
blk.19.exp_probs_b.bias
blk.19.ffn_down_exps.weight
blk.19.ffn_down_shexp.weight
blk.19.ffn_gate_exps.weight
blk.19.ffn_gate_inp.weight
blk.19.ffn_gate_shexp.weight
blk.19.ffn_norm.weight
blk.19.ffn_up_exps.weight
blk.19.ffn_up_shexp.weight
```


### blk.20 (attention)

```text
blk.20.attn_k_b.weight
blk.20.attn_kv_a_mqa.weight
blk.20.attn_kv_a_norm.weight
blk.20.attn_norm.weight
blk.20.attn_output.weight
blk.20.attn_q_a.weight
blk.20.attn_q_a_norm.weight
blk.20.attn_q_b.weight
blk.20.attn_v_b.weight
blk.20.exp_probs_b.bias
blk.20.ffn_down_exps.weight
blk.20.ffn_down_shexp.weight
blk.20.ffn_gate_exps.weight
blk.20.ffn_gate_inp.weight
blk.20.ffn_gate_shexp.weight
blk.20.ffn_norm.weight
blk.20.ffn_up_exps.weight
blk.20.ffn_up_shexp.weight
```


### blk.21 (attention)

```text
blk.21.attn_k_b.weight
blk.21.attn_kv_a_mqa.weight
blk.21.attn_kv_a_norm.weight
blk.21.attn_norm.weight
blk.21.attn_output.weight
blk.21.attn_q_a.weight
blk.21.attn_q_a_norm.weight
blk.21.attn_q_b.weight
blk.21.attn_v_b.weight
blk.21.exp_probs_b.bias
blk.21.ffn_down_exps.weight
blk.21.ffn_down_shexp.weight
blk.21.ffn_gate_exps.weight
blk.21.ffn_gate_inp.weight
blk.21.ffn_gate_shexp.weight
blk.21.ffn_norm.weight
blk.21.ffn_up_exps.weight
blk.21.ffn_up_shexp.weight
```


### blk.22 (attention)

```text
blk.22.attn_k_b.weight
blk.22.attn_kv_a_mqa.weight
blk.22.attn_kv_a_norm.weight
blk.22.attn_norm.weight
blk.22.attn_output.weight
blk.22.attn_q_a.weight
blk.22.attn_q_a_norm.weight
blk.22.attn_q_b.weight
blk.22.attn_v_b.weight
blk.22.exp_probs_b.bias
blk.22.ffn_down_exps.weight
blk.22.ffn_down_shexp.weight
blk.22.ffn_gate_exps.weight
blk.22.ffn_gate_inp.weight
blk.22.ffn_gate_shexp.weight
blk.22.ffn_norm.weight
blk.22.ffn_up_exps.weight
blk.22.ffn_up_shexp.weight
```


### blk.23 (attention)

```text
blk.23.attn_k_b.weight
blk.23.attn_kv_a_mqa.weight
blk.23.attn_kv_a_norm.weight
blk.23.attn_norm.weight
blk.23.attn_output.weight
blk.23.attn_q_a.weight
blk.23.attn_q_a_norm.weight
blk.23.attn_q_b.weight
blk.23.attn_v_b.weight
blk.23.exp_probs_b.bias
blk.23.ffn_down_exps.weight
blk.23.ffn_down_shexp.weight
blk.23.ffn_gate_exps.weight
blk.23.ffn_gate_inp.weight
blk.23.ffn_gate_shexp.weight
blk.23.ffn_norm.weight
blk.23.ffn_up_exps.weight
blk.23.ffn_up_shexp.weight
```


### blk.24 (attention)

```text
blk.24.attn_k_b.weight
blk.24.attn_kv_a_mqa.weight
blk.24.attn_kv_a_norm.weight
blk.24.attn_norm.weight
blk.24.attn_output.weight
blk.24.attn_q_a.weight
blk.24.attn_q_a_norm.weight
blk.24.attn_q_b.weight
blk.24.attn_v_b.weight
blk.24.exp_probs_b.bias
blk.24.ffn_down_exps.weight
blk.24.ffn_down_shexp.weight
blk.24.ffn_gate_exps.weight
blk.24.ffn_gate_inp.weight
blk.24.ffn_gate_shexp.weight
blk.24.ffn_norm.weight
blk.24.ffn_up_exps.weight
blk.24.ffn_up_shexp.weight
```


### blk.25 (attention)

```text
blk.25.attn_k_b.weight
blk.25.attn_kv_a_mqa.weight
blk.25.attn_kv_a_norm.weight
blk.25.attn_norm.weight
blk.25.attn_output.weight
blk.25.attn_q_a.weight
blk.25.attn_q_a_norm.weight
blk.25.attn_q_b.weight
blk.25.attn_v_b.weight
blk.25.exp_probs_b.bias
blk.25.ffn_down_exps.weight
blk.25.ffn_down_shexp.weight
blk.25.ffn_gate_exps.weight
blk.25.ffn_gate_inp.weight
blk.25.ffn_gate_shexp.weight
blk.25.ffn_norm.weight
blk.25.ffn_up_exps.weight
blk.25.ffn_up_shexp.weight
```


### blk.26 (attention)

```text
blk.26.attn_k_b.weight
blk.26.attn_kv_a_mqa.weight
blk.26.attn_kv_a_norm.weight
blk.26.attn_norm.weight
blk.26.attn_output.weight
blk.26.attn_q_a.weight
blk.26.attn_q_a_norm.weight
blk.26.attn_q_b.weight
blk.26.attn_v_b.weight
blk.26.exp_probs_b.bias
blk.26.ffn_down_exps.weight
blk.26.ffn_down_shexp.weight
blk.26.ffn_gate_exps.weight
blk.26.ffn_gate_inp.weight
blk.26.ffn_gate_shexp.weight
blk.26.ffn_norm.weight
blk.26.ffn_up_exps.weight
blk.26.ffn_up_shexp.weight
```


### blk.27 (attention)

```text
blk.27.attn_k_b.weight
blk.27.attn_kv_a_mqa.weight
blk.27.attn_kv_a_norm.weight
blk.27.attn_norm.weight
blk.27.attn_output.weight
blk.27.attn_q_a.weight
blk.27.attn_q_a_norm.weight
blk.27.attn_q_b.weight
blk.27.attn_v_b.weight
blk.27.exp_probs_b.bias
blk.27.ffn_down_exps.weight
blk.27.ffn_down_shexp.weight
blk.27.ffn_gate_exps.weight
blk.27.ffn_gate_inp.weight
blk.27.ffn_gate_shexp.weight
blk.27.ffn_norm.weight
blk.27.ffn_up_exps.weight
blk.27.ffn_up_shexp.weight
```


### blk.28 (attention)

```text
blk.28.attn_k_b.weight
blk.28.attn_kv_a_mqa.weight
blk.28.attn_kv_a_norm.weight
blk.28.attn_norm.weight
blk.28.attn_output.weight
blk.28.attn_q_a.weight
blk.28.attn_q_a_norm.weight
blk.28.attn_q_b.weight
blk.28.attn_v_b.weight
blk.28.exp_probs_b.bias
blk.28.ffn_down_exps.weight
blk.28.ffn_down_shexp.weight
blk.28.ffn_gate_exps.weight
blk.28.ffn_gate_inp.weight
blk.28.ffn_gate_shexp.weight
blk.28.ffn_norm.weight
blk.28.ffn_up_exps.weight
blk.28.ffn_up_shexp.weight
```


### blk.29 (attention)

```text
blk.29.attn_k_b.weight
blk.29.attn_kv_a_mqa.weight
blk.29.attn_kv_a_norm.weight
blk.29.attn_norm.weight
blk.29.attn_output.weight
blk.29.attn_q_a.weight
blk.29.attn_q_a_norm.weight
blk.29.attn_q_b.weight
blk.29.attn_v_b.weight
blk.29.exp_probs_b.bias
blk.29.ffn_down_exps.weight
blk.29.ffn_down_shexp.weight
blk.29.ffn_gate_exps.weight
blk.29.ffn_gate_inp.weight
blk.29.ffn_gate_shexp.weight
blk.29.ffn_norm.weight
blk.29.ffn_up_exps.weight
blk.29.ffn_up_shexp.weight
```


### blk.30 (attention)

```text
blk.30.attn_k_b.weight
blk.30.attn_kv_a_mqa.weight
blk.30.attn_kv_a_norm.weight
blk.30.attn_norm.weight
blk.30.attn_output.weight
blk.30.attn_q_a.weight
blk.30.attn_q_a_norm.weight
blk.30.attn_q_b.weight
blk.30.attn_v_b.weight
blk.30.exp_probs_b.bias
blk.30.ffn_down_exps.weight
blk.30.ffn_down_shexp.weight
blk.30.ffn_gate_exps.weight
blk.30.ffn_gate_inp.weight
blk.30.ffn_gate_shexp.weight
blk.30.ffn_norm.weight
blk.30.ffn_up_exps.weight
blk.30.ffn_up_shexp.weight
```


### blk.31 (attention)

```text
blk.31.attn_k_b.weight
blk.31.attn_kv_a_mqa.weight
blk.31.attn_kv_a_norm.weight
blk.31.attn_norm.weight
blk.31.attn_output.weight
blk.31.attn_q_a.weight
blk.31.attn_q_a_norm.weight
blk.31.attn_q_b.weight
blk.31.attn_v_b.weight
blk.31.exp_probs_b.bias
blk.31.ffn_down_exps.weight
blk.31.ffn_down_shexp.weight
blk.31.ffn_gate_exps.weight
blk.31.ffn_gate_inp.weight
blk.31.ffn_gate_shexp.weight
blk.31.ffn_norm.weight
blk.31.ffn_up_exps.weight
blk.31.ffn_up_shexp.weight
```


### blk.32 (attention)

```text
blk.32.attn_k_b.weight
blk.32.attn_kv_a_mqa.weight
blk.32.attn_kv_a_norm.weight
blk.32.attn_norm.weight
blk.32.attn_output.weight
blk.32.attn_q_a.weight
blk.32.attn_q_a_norm.weight
blk.32.attn_q_b.weight
blk.32.attn_v_b.weight
blk.32.exp_probs_b.bias
blk.32.ffn_down_exps.weight
blk.32.ffn_down_shexp.weight
blk.32.ffn_gate_exps.weight
blk.32.ffn_gate_inp.weight
blk.32.ffn_gate_shexp.weight
blk.32.ffn_norm.weight
blk.32.ffn_up_exps.weight
blk.32.ffn_up_shexp.weight
```


### blk.33 (attention)

```text
blk.33.attn_k_b.weight
blk.33.attn_kv_a_mqa.weight
blk.33.attn_kv_a_norm.weight
blk.33.attn_norm.weight
blk.33.attn_output.weight
blk.33.attn_q_a.weight
blk.33.attn_q_a_norm.weight
blk.33.attn_q_b.weight
blk.33.attn_v_b.weight
blk.33.exp_probs_b.bias
blk.33.ffn_down_exps.weight
blk.33.ffn_down_shexp.weight
blk.33.ffn_gate_exps.weight
blk.33.ffn_gate_inp.weight
blk.33.ffn_gate_shexp.weight
blk.33.ffn_norm.weight
blk.33.ffn_up_exps.weight
blk.33.ffn_up_shexp.weight
```


### blk.34 (attention)

```text
blk.34.attn_k_b.weight
blk.34.attn_kv_a_mqa.weight
blk.34.attn_kv_a_norm.weight
blk.34.attn_norm.weight
blk.34.attn_output.weight
blk.34.attn_q_a.weight
blk.34.attn_q_a_norm.weight
blk.34.attn_q_b.weight
blk.34.attn_v_b.weight
blk.34.exp_probs_b.bias
blk.34.ffn_down_exps.weight
blk.34.ffn_down_shexp.weight
blk.34.ffn_gate_exps.weight
blk.34.ffn_gate_inp.weight
blk.34.ffn_gate_shexp.weight
blk.34.ffn_norm.weight
blk.34.ffn_up_exps.weight
blk.34.ffn_up_shexp.weight
```


### blk.35 (attention)

```text
blk.35.attn_k_b.weight
blk.35.attn_kv_a_mqa.weight
blk.35.attn_kv_a_norm.weight
blk.35.attn_norm.weight
blk.35.attn_output.weight
blk.35.attn_q_a.weight
blk.35.attn_q_a_norm.weight
blk.35.attn_q_b.weight
blk.35.attn_v_b.weight
blk.35.exp_probs_b.bias
blk.35.ffn_down_exps.weight
blk.35.ffn_down_shexp.weight
blk.35.ffn_gate_exps.weight
blk.35.ffn_gate_inp.weight
blk.35.ffn_gate_shexp.weight
blk.35.ffn_norm.weight
blk.35.ffn_up_exps.weight
blk.35.ffn_up_shexp.weight
```


### blk.36 (attention)

```text
blk.36.attn_k_b.weight
blk.36.attn_kv_a_mqa.weight
blk.36.attn_kv_a_norm.weight
blk.36.attn_norm.weight
blk.36.attn_output.weight
blk.36.attn_q_a.weight
blk.36.attn_q_a_norm.weight
blk.36.attn_q_b.weight
blk.36.attn_v_b.weight
blk.36.exp_probs_b.bias
blk.36.ffn_down_exps.weight
blk.36.ffn_down_shexp.weight
blk.36.ffn_gate_exps.weight
blk.36.ffn_gate_inp.weight
blk.36.ffn_gate_shexp.weight
blk.36.ffn_norm.weight
blk.36.ffn_up_exps.weight
blk.36.ffn_up_shexp.weight
```


### blk.37 (attention)

```text
blk.37.attn_k_b.weight
blk.37.attn_kv_a_mqa.weight
blk.37.attn_kv_a_norm.weight
blk.37.attn_norm.weight
blk.37.attn_output.weight
blk.37.attn_q_a.weight
blk.37.attn_q_a_norm.weight
blk.37.attn_q_b.weight
blk.37.attn_v_b.weight
blk.37.exp_probs_b.bias
blk.37.ffn_down_exps.weight
blk.37.ffn_down_shexp.weight
blk.37.ffn_gate_exps.weight
blk.37.ffn_gate_inp.weight
blk.37.ffn_gate_shexp.weight
blk.37.ffn_norm.weight
blk.37.ffn_up_exps.weight
blk.37.ffn_up_shexp.weight
```


### blk.38 (attention)

```text
blk.38.attn_k_b.weight
blk.38.attn_kv_a_mqa.weight
blk.38.attn_kv_a_norm.weight
blk.38.attn_norm.weight
blk.38.attn_output.weight
blk.38.attn_q_a.weight
blk.38.attn_q_a_norm.weight
blk.38.attn_q_b.weight
blk.38.attn_v_b.weight
blk.38.exp_probs_b.bias
blk.38.ffn_down_exps.weight
blk.38.ffn_down_shexp.weight
blk.38.ffn_gate_exps.weight
blk.38.ffn_gate_inp.weight
blk.38.ffn_gate_shexp.weight
blk.38.ffn_norm.weight
blk.38.ffn_up_exps.weight
blk.38.ffn_up_shexp.weight
```


### blk.39 (attention)

```text
blk.39.attn_k_b.weight
blk.39.attn_kv_a_mqa.weight
blk.39.attn_kv_a_norm.weight
blk.39.attn_norm.weight
blk.39.attn_output.weight
blk.39.attn_q_a.weight
blk.39.attn_q_a_norm.weight
blk.39.attn_q_b.weight
blk.39.attn_v_b.weight
blk.39.exp_probs_b.bias
blk.39.ffn_down_exps.weight
blk.39.ffn_down_shexp.weight
blk.39.ffn_gate_exps.weight
blk.39.ffn_gate_inp.weight
blk.39.ffn_gate_shexp.weight
blk.39.ffn_norm.weight
blk.39.ffn_up_exps.weight
blk.39.ffn_up_shexp.weight
```


### blk.40 (attention)

```text
blk.40.attn_k_b.weight
blk.40.attn_kv_a_mqa.weight
blk.40.attn_kv_a_norm.weight
blk.40.attn_norm.weight
blk.40.attn_output.weight
blk.40.attn_q_a.weight
blk.40.attn_q_a_norm.weight
blk.40.attn_q_b.weight
blk.40.attn_v_b.weight
blk.40.exp_probs_b.bias
blk.40.ffn_down_exps.weight
blk.40.ffn_down_shexp.weight
blk.40.ffn_gate_exps.weight
blk.40.ffn_gate_inp.weight
blk.40.ffn_gate_shexp.weight
blk.40.ffn_norm.weight
blk.40.ffn_up_exps.weight
blk.40.ffn_up_shexp.weight
```


### blk.41 (attention)

```text
blk.41.attn_k_b.weight
blk.41.attn_kv_a_mqa.weight
blk.41.attn_kv_a_norm.weight
blk.41.attn_norm.weight
blk.41.attn_output.weight
blk.41.attn_q_a.weight
blk.41.attn_q_a_norm.weight
blk.41.attn_q_b.weight
blk.41.attn_v_b.weight
blk.41.exp_probs_b.bias
blk.41.ffn_down_exps.weight
blk.41.ffn_down_shexp.weight
blk.41.ffn_gate_exps.weight
blk.41.ffn_gate_inp.weight
blk.41.ffn_gate_shexp.weight
blk.41.ffn_norm.weight
blk.41.ffn_up_exps.weight
blk.41.ffn_up_shexp.weight
```


### blk.42 (attention)

```text
blk.42.attn_k_b.weight
blk.42.attn_kv_a_mqa.weight
blk.42.attn_kv_a_norm.weight
blk.42.attn_norm.weight
blk.42.attn_output.weight
blk.42.attn_q_a.weight
blk.42.attn_q_a_norm.weight
blk.42.attn_q_b.weight
blk.42.attn_v_b.weight
blk.42.exp_probs_b.bias
blk.42.ffn_down_exps.weight
blk.42.ffn_down_shexp.weight
blk.42.ffn_gate_exps.weight
blk.42.ffn_gate_inp.weight
blk.42.ffn_gate_shexp.weight
blk.42.ffn_norm.weight
blk.42.ffn_up_exps.weight
blk.42.ffn_up_shexp.weight
```


### blk.43 (attention)

```text
blk.43.attn_k_b.weight
blk.43.attn_kv_a_mqa.weight
blk.43.attn_kv_a_norm.weight
blk.43.attn_norm.weight
blk.43.attn_output.weight
blk.43.attn_q_a.weight
blk.43.attn_q_a_norm.weight
blk.43.attn_q_b.weight
blk.43.attn_v_b.weight
blk.43.exp_probs_b.bias
blk.43.ffn_down_exps.weight
blk.43.ffn_down_shexp.weight
blk.43.ffn_gate_exps.weight
blk.43.ffn_gate_inp.weight
blk.43.ffn_gate_shexp.weight
blk.43.ffn_norm.weight
blk.43.ffn_up_exps.weight
blk.43.ffn_up_shexp.weight
```


### blk.44 (attention)

```text
blk.44.attn_k_b.weight
blk.44.attn_kv_a_mqa.weight
blk.44.attn_kv_a_norm.weight
blk.44.attn_norm.weight
blk.44.attn_output.weight
blk.44.attn_q_a.weight
blk.44.attn_q_a_norm.weight
blk.44.attn_q_b.weight
blk.44.attn_v_b.weight
blk.44.exp_probs_b.bias
blk.44.ffn_down_exps.weight
blk.44.ffn_down_shexp.weight
blk.44.ffn_gate_exps.weight
blk.44.ffn_gate_inp.weight
blk.44.ffn_gate_shexp.weight
blk.44.ffn_norm.weight
blk.44.ffn_up_exps.weight
blk.44.ffn_up_shexp.weight
```


### blk.45 (attention)

```text
blk.45.attn_k_b.weight
blk.45.attn_kv_a_mqa.weight
blk.45.attn_kv_a_norm.weight
blk.45.attn_norm.weight
blk.45.attn_output.weight
blk.45.attn_q_a.weight
blk.45.attn_q_a_norm.weight
blk.45.attn_q_b.weight
blk.45.attn_v_b.weight
blk.45.exp_probs_b.bias
blk.45.ffn_down_exps.weight
blk.45.ffn_down_shexp.weight
blk.45.ffn_gate_exps.weight
blk.45.ffn_gate_inp.weight
blk.45.ffn_gate_shexp.weight
blk.45.ffn_norm.weight
blk.45.ffn_up_exps.weight
blk.45.ffn_up_shexp.weight
```


### blk.46 (attention)

```text
blk.46.attn_k_b.weight
blk.46.attn_kv_a_mqa.weight
blk.46.attn_kv_a_norm.weight
blk.46.attn_norm.weight
blk.46.attn_output.weight
blk.46.attn_q_a.weight
blk.46.attn_q_a_norm.weight
blk.46.attn_q_b.weight
blk.46.attn_v_b.weight
blk.46.exp_probs_b.bias
blk.46.ffn_down_exps.weight
blk.46.ffn_down_shexp.weight
blk.46.ffn_gate_exps.weight
blk.46.ffn_gate_inp.weight
blk.46.ffn_gate_shexp.weight
blk.46.ffn_norm.weight
blk.46.ffn_up_exps.weight
blk.46.ffn_up_shexp.weight
```


