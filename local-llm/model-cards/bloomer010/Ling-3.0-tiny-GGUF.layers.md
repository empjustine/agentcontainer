---
model: bloomer010/Ling-3.0-tiny-GGUF
quants: Ling-3.0-tiny-UD-Q8_K_XL
file_Ling-3.0-tiny-UD-Q8_K_XL: Ling-3.0-tiny-UD-Q8_K_XL.gguf
tensor_count: 526
generator: local-llm/generate-layer-cards.py
generated: 2026-08-18 02:02 UTC
---

# Layer names — bloomer010/Ling-3.0-tiny-GGUF

Every tensor (layer) name read from the GGUF **tensor-info header** — no weights are loaded into memory. Layer names are architecture-level and identical across quants; per-tensor sizes are listed per quant.

## Summary

| field | value |
|---|---|
| architecture | `bailingmoe3` |
| block count | 24 (`blk.0` … `blk.23`) |
| context length | 131072 |
| embedding length | 1536 |
| total tensors | 526 |
| non-layer tensors | 3 |
| attention blocks | 24 — 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23 |
| quants analyzed | Ling-3.0-tiny-UD-Q8_K_XL |

## Non-layer tensors

| tensor | shape | MiB (Ling-3.0-tiny-UD-Q8_K_XL) |
|---|---|---|
| `output.weight` | [1536 x 157184] | 244.6 |
| `output_norm.weight` | [1536] | 0.0 |
| `token_embd.weight` | [1536 x 157184] | - |

## Block layout

### attention blocks — 24 (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23)

| tensor | shape | MiB (Ling-3.0-tiny-UD-Q8_K_XL) |
|---|---|---|
| `attn_norm.weight` | [1536] | 0.0 |
| `attn_output.weight` | [2048 x 1536] | - |
| `ffn_norm.weight` | [1536] | 0.0 |

Blocks with additional tensors on top of the canonical set:

- `blk.0`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `ffn_down.weight`, `ffn_gate.weight`, `ffn_up.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.1`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.2`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.3`: `attn_gate.weight`, `attn_k_b.weight`, `attn_kv_a_mqa.weight`, `attn_kv_a_norm.weight`, `attn_q_a.weight`, `attn_q_a_norm.weight`, `attn_q_b.weight`, `attn_v_b.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.4`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.5`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.6`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.7`: `attn_gate.weight`, `attn_k_b.weight`, `attn_kv_a_mqa.weight`, `attn_kv_a_norm.weight`, `attn_q_a.weight`, `attn_q_a_norm.weight`, `attn_q_b.weight`, `attn_v_b.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.8`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.9`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.10`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.11`: `attn_gate.weight`, `attn_k_b.weight`, `attn_kv_a_mqa.weight`, `attn_kv_a_norm.weight`, `attn_q_a.weight`, `attn_q_a_norm.weight`, `attn_q_b.weight`, `attn_v_b.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.12`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.13`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.14`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.15`: `attn_gate.weight`, `attn_k_b.weight`, `attn_kv_a_mqa.weight`, `attn_kv_a_norm.weight`, `attn_q_a.weight`, `attn_q_a_norm.weight`, `attn_q_b.weight`, `attn_v_b.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.16`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.17`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.18`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.19`: `attn_gate.weight`, `attn_k_b.weight`, `attn_kv_a_mqa.weight`, `attn_kv_a_norm.weight`, `attn_q_a.weight`, `attn_q_a_norm.weight`, `attn_q_b.weight`, `attn_v_b.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`
- `blk.20`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.21`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.22`: `attn_k.weight`, `attn_q.weight`, `attn_v.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`, `ssm_a`, `ssm_beta.weight`, `ssm_conv1d_k.weight`, `ssm_conv1d_q.weight`, `ssm_conv1d_v.weight`, `ssm_dt.bias`, `ssm_f_a.weight`, `ssm_g_a.weight`, `ssm_norm.weight`
- `blk.23`: `attn_gate.weight`, `attn_k_b.weight`, `attn_kv_a_mqa.weight`, `attn_kv_a_norm.weight`, `attn_q_a.weight`, `attn_q_a_norm.weight`, `attn_q_b.weight`, `attn_v_b.weight`, `exp_probs_b.bias`, `ffn_down_exps.weight`, `ffn_down_shexp.weight`, `ffn_gate_exps.weight`, `ffn_gate_inp.weight`, `ffn_gate_shexp.weight`, `ffn_up_exps.weight`, `ffn_up_shexp.weight`


## All tensors by block

- `output.weight`
- `output_norm.weight`
- `token_embd.weight`

### blk.0 (attention)

```text
blk.0.attn_k.weight
blk.0.attn_norm.weight
blk.0.attn_output.weight
blk.0.attn_q.weight
blk.0.attn_v.weight
blk.0.ffn_down.weight
blk.0.ffn_gate.weight
blk.0.ffn_norm.weight
blk.0.ffn_up.weight
blk.0.ssm_a
blk.0.ssm_beta.weight
blk.0.ssm_conv1d_k.weight
blk.0.ssm_conv1d_q.weight
blk.0.ssm_conv1d_v.weight
blk.0.ssm_dt.bias
blk.0.ssm_f_a.weight
blk.0.ssm_g_a.weight
blk.0.ssm_norm.weight
```


### blk.1 (attention)

```text
blk.1.attn_k.weight
blk.1.attn_norm.weight
blk.1.attn_output.weight
blk.1.attn_q.weight
blk.1.attn_v.weight
blk.1.exp_probs_b.bias
blk.1.ffn_down_exps.weight
blk.1.ffn_down_shexp.weight
blk.1.ffn_gate_exps.weight
blk.1.ffn_gate_inp.weight
blk.1.ffn_gate_shexp.weight
blk.1.ffn_norm.weight
blk.1.ffn_up_exps.weight
blk.1.ffn_up_shexp.weight
blk.1.ssm_a
blk.1.ssm_beta.weight
blk.1.ssm_conv1d_k.weight
blk.1.ssm_conv1d_q.weight
blk.1.ssm_conv1d_v.weight
blk.1.ssm_dt.bias
blk.1.ssm_f_a.weight
blk.1.ssm_g_a.weight
blk.1.ssm_norm.weight
```


### blk.2 (attention)

```text
blk.2.attn_k.weight
blk.2.attn_norm.weight
blk.2.attn_output.weight
blk.2.attn_q.weight
blk.2.attn_v.weight
blk.2.exp_probs_b.bias
blk.2.ffn_down_exps.weight
blk.2.ffn_down_shexp.weight
blk.2.ffn_gate_exps.weight
blk.2.ffn_gate_inp.weight
blk.2.ffn_gate_shexp.weight
blk.2.ffn_norm.weight
blk.2.ffn_up_exps.weight
blk.2.ffn_up_shexp.weight
blk.2.ssm_a
blk.2.ssm_beta.weight
blk.2.ssm_conv1d_k.weight
blk.2.ssm_conv1d_q.weight
blk.2.ssm_conv1d_v.weight
blk.2.ssm_dt.bias
blk.2.ssm_f_a.weight
blk.2.ssm_g_a.weight
blk.2.ssm_norm.weight
```


### blk.3 (attention)

```text
blk.3.attn_gate.weight
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
blk.4.attn_k.weight
blk.4.attn_norm.weight
blk.4.attn_output.weight
blk.4.attn_q.weight
blk.4.attn_v.weight
blk.4.exp_probs_b.bias
blk.4.ffn_down_exps.weight
blk.4.ffn_down_shexp.weight
blk.4.ffn_gate_exps.weight
blk.4.ffn_gate_inp.weight
blk.4.ffn_gate_shexp.weight
blk.4.ffn_norm.weight
blk.4.ffn_up_exps.weight
blk.4.ffn_up_shexp.weight
blk.4.ssm_a
blk.4.ssm_beta.weight
blk.4.ssm_conv1d_k.weight
blk.4.ssm_conv1d_q.weight
blk.4.ssm_conv1d_v.weight
blk.4.ssm_dt.bias
blk.4.ssm_f_a.weight
blk.4.ssm_g_a.weight
blk.4.ssm_norm.weight
```


### blk.5 (attention)

```text
blk.5.attn_k.weight
blk.5.attn_norm.weight
blk.5.attn_output.weight
blk.5.attn_q.weight
blk.5.attn_v.weight
blk.5.exp_probs_b.bias
blk.5.ffn_down_exps.weight
blk.5.ffn_down_shexp.weight
blk.5.ffn_gate_exps.weight
blk.5.ffn_gate_inp.weight
blk.5.ffn_gate_shexp.weight
blk.5.ffn_norm.weight
blk.5.ffn_up_exps.weight
blk.5.ffn_up_shexp.weight
blk.5.ssm_a
blk.5.ssm_beta.weight
blk.5.ssm_conv1d_k.weight
blk.5.ssm_conv1d_q.weight
blk.5.ssm_conv1d_v.weight
blk.5.ssm_dt.bias
blk.5.ssm_f_a.weight
blk.5.ssm_g_a.weight
blk.5.ssm_norm.weight
```


### blk.6 (attention)

```text
blk.6.attn_k.weight
blk.6.attn_norm.weight
blk.6.attn_output.weight
blk.6.attn_q.weight
blk.6.attn_v.weight
blk.6.exp_probs_b.bias
blk.6.ffn_down_exps.weight
blk.6.ffn_down_shexp.weight
blk.6.ffn_gate_exps.weight
blk.6.ffn_gate_inp.weight
blk.6.ffn_gate_shexp.weight
blk.6.ffn_norm.weight
blk.6.ffn_up_exps.weight
blk.6.ffn_up_shexp.weight
blk.6.ssm_a
blk.6.ssm_beta.weight
blk.6.ssm_conv1d_k.weight
blk.6.ssm_conv1d_q.weight
blk.6.ssm_conv1d_v.weight
blk.6.ssm_dt.bias
blk.6.ssm_f_a.weight
blk.6.ssm_g_a.weight
blk.6.ssm_norm.weight
```


### blk.7 (attention)

```text
blk.7.attn_gate.weight
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
blk.8.attn_k.weight
blk.8.attn_norm.weight
blk.8.attn_output.weight
blk.8.attn_q.weight
blk.8.attn_v.weight
blk.8.exp_probs_b.bias
blk.8.ffn_down_exps.weight
blk.8.ffn_down_shexp.weight
blk.8.ffn_gate_exps.weight
blk.8.ffn_gate_inp.weight
blk.8.ffn_gate_shexp.weight
blk.8.ffn_norm.weight
blk.8.ffn_up_exps.weight
blk.8.ffn_up_shexp.weight
blk.8.ssm_a
blk.8.ssm_beta.weight
blk.8.ssm_conv1d_k.weight
blk.8.ssm_conv1d_q.weight
blk.8.ssm_conv1d_v.weight
blk.8.ssm_dt.bias
blk.8.ssm_f_a.weight
blk.8.ssm_g_a.weight
blk.8.ssm_norm.weight
```


### blk.9 (attention)

```text
blk.9.attn_k.weight
blk.9.attn_norm.weight
blk.9.attn_output.weight
blk.9.attn_q.weight
blk.9.attn_v.weight
blk.9.exp_probs_b.bias
blk.9.ffn_down_exps.weight
blk.9.ffn_down_shexp.weight
blk.9.ffn_gate_exps.weight
blk.9.ffn_gate_inp.weight
blk.9.ffn_gate_shexp.weight
blk.9.ffn_norm.weight
blk.9.ffn_up_exps.weight
blk.9.ffn_up_shexp.weight
blk.9.ssm_a
blk.9.ssm_beta.weight
blk.9.ssm_conv1d_k.weight
blk.9.ssm_conv1d_q.weight
blk.9.ssm_conv1d_v.weight
blk.9.ssm_dt.bias
blk.9.ssm_f_a.weight
blk.9.ssm_g_a.weight
blk.9.ssm_norm.weight
```


### blk.10 (attention)

```text
blk.10.attn_k.weight
blk.10.attn_norm.weight
blk.10.attn_output.weight
blk.10.attn_q.weight
blk.10.attn_v.weight
blk.10.exp_probs_b.bias
blk.10.ffn_down_exps.weight
blk.10.ffn_down_shexp.weight
blk.10.ffn_gate_exps.weight
blk.10.ffn_gate_inp.weight
blk.10.ffn_gate_shexp.weight
blk.10.ffn_norm.weight
blk.10.ffn_up_exps.weight
blk.10.ffn_up_shexp.weight
blk.10.ssm_a
blk.10.ssm_beta.weight
blk.10.ssm_conv1d_k.weight
blk.10.ssm_conv1d_q.weight
blk.10.ssm_conv1d_v.weight
blk.10.ssm_dt.bias
blk.10.ssm_f_a.weight
blk.10.ssm_g_a.weight
blk.10.ssm_norm.weight
```


### blk.11 (attention)

```text
blk.11.attn_gate.weight
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
blk.12.attn_k.weight
blk.12.attn_norm.weight
blk.12.attn_output.weight
blk.12.attn_q.weight
blk.12.attn_v.weight
blk.12.exp_probs_b.bias
blk.12.ffn_down_exps.weight
blk.12.ffn_down_shexp.weight
blk.12.ffn_gate_exps.weight
blk.12.ffn_gate_inp.weight
blk.12.ffn_gate_shexp.weight
blk.12.ffn_norm.weight
blk.12.ffn_up_exps.weight
blk.12.ffn_up_shexp.weight
blk.12.ssm_a
blk.12.ssm_beta.weight
blk.12.ssm_conv1d_k.weight
blk.12.ssm_conv1d_q.weight
blk.12.ssm_conv1d_v.weight
blk.12.ssm_dt.bias
blk.12.ssm_f_a.weight
blk.12.ssm_g_a.weight
blk.12.ssm_norm.weight
```


### blk.13 (attention)

```text
blk.13.attn_k.weight
blk.13.attn_norm.weight
blk.13.attn_output.weight
blk.13.attn_q.weight
blk.13.attn_v.weight
blk.13.exp_probs_b.bias
blk.13.ffn_down_exps.weight
blk.13.ffn_down_shexp.weight
blk.13.ffn_gate_exps.weight
blk.13.ffn_gate_inp.weight
blk.13.ffn_gate_shexp.weight
blk.13.ffn_norm.weight
blk.13.ffn_up_exps.weight
blk.13.ffn_up_shexp.weight
blk.13.ssm_a
blk.13.ssm_beta.weight
blk.13.ssm_conv1d_k.weight
blk.13.ssm_conv1d_q.weight
blk.13.ssm_conv1d_v.weight
blk.13.ssm_dt.bias
blk.13.ssm_f_a.weight
blk.13.ssm_g_a.weight
blk.13.ssm_norm.weight
```


### blk.14 (attention)

```text
blk.14.attn_k.weight
blk.14.attn_norm.weight
blk.14.attn_output.weight
blk.14.attn_q.weight
blk.14.attn_v.weight
blk.14.exp_probs_b.bias
blk.14.ffn_down_exps.weight
blk.14.ffn_down_shexp.weight
blk.14.ffn_gate_exps.weight
blk.14.ffn_gate_inp.weight
blk.14.ffn_gate_shexp.weight
blk.14.ffn_norm.weight
blk.14.ffn_up_exps.weight
blk.14.ffn_up_shexp.weight
blk.14.ssm_a
blk.14.ssm_beta.weight
blk.14.ssm_conv1d_k.weight
blk.14.ssm_conv1d_q.weight
blk.14.ssm_conv1d_v.weight
blk.14.ssm_dt.bias
blk.14.ssm_f_a.weight
blk.14.ssm_g_a.weight
blk.14.ssm_norm.weight
```


### blk.15 (attention)

```text
blk.15.attn_gate.weight
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
blk.16.attn_k.weight
blk.16.attn_norm.weight
blk.16.attn_output.weight
blk.16.attn_q.weight
blk.16.attn_v.weight
blk.16.exp_probs_b.bias
blk.16.ffn_down_exps.weight
blk.16.ffn_down_shexp.weight
blk.16.ffn_gate_exps.weight
blk.16.ffn_gate_inp.weight
blk.16.ffn_gate_shexp.weight
blk.16.ffn_norm.weight
blk.16.ffn_up_exps.weight
blk.16.ffn_up_shexp.weight
blk.16.ssm_a
blk.16.ssm_beta.weight
blk.16.ssm_conv1d_k.weight
blk.16.ssm_conv1d_q.weight
blk.16.ssm_conv1d_v.weight
blk.16.ssm_dt.bias
blk.16.ssm_f_a.weight
blk.16.ssm_g_a.weight
blk.16.ssm_norm.weight
```


### blk.17 (attention)

```text
blk.17.attn_k.weight
blk.17.attn_norm.weight
blk.17.attn_output.weight
blk.17.attn_q.weight
blk.17.attn_v.weight
blk.17.exp_probs_b.bias
blk.17.ffn_down_exps.weight
blk.17.ffn_down_shexp.weight
blk.17.ffn_gate_exps.weight
blk.17.ffn_gate_inp.weight
blk.17.ffn_gate_shexp.weight
blk.17.ffn_norm.weight
blk.17.ffn_up_exps.weight
blk.17.ffn_up_shexp.weight
blk.17.ssm_a
blk.17.ssm_beta.weight
blk.17.ssm_conv1d_k.weight
blk.17.ssm_conv1d_q.weight
blk.17.ssm_conv1d_v.weight
blk.17.ssm_dt.bias
blk.17.ssm_f_a.weight
blk.17.ssm_g_a.weight
blk.17.ssm_norm.weight
```


### blk.18 (attention)

```text
blk.18.attn_k.weight
blk.18.attn_norm.weight
blk.18.attn_output.weight
blk.18.attn_q.weight
blk.18.attn_v.weight
blk.18.exp_probs_b.bias
blk.18.ffn_down_exps.weight
blk.18.ffn_down_shexp.weight
blk.18.ffn_gate_exps.weight
blk.18.ffn_gate_inp.weight
blk.18.ffn_gate_shexp.weight
blk.18.ffn_norm.weight
blk.18.ffn_up_exps.weight
blk.18.ffn_up_shexp.weight
blk.18.ssm_a
blk.18.ssm_beta.weight
blk.18.ssm_conv1d_k.weight
blk.18.ssm_conv1d_q.weight
blk.18.ssm_conv1d_v.weight
blk.18.ssm_dt.bias
blk.18.ssm_f_a.weight
blk.18.ssm_g_a.weight
blk.18.ssm_norm.weight
```


### blk.19 (attention)

```text
blk.19.attn_gate.weight
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
blk.20.attn_k.weight
blk.20.attn_norm.weight
blk.20.attn_output.weight
blk.20.attn_q.weight
blk.20.attn_v.weight
blk.20.exp_probs_b.bias
blk.20.ffn_down_exps.weight
blk.20.ffn_down_shexp.weight
blk.20.ffn_gate_exps.weight
blk.20.ffn_gate_inp.weight
blk.20.ffn_gate_shexp.weight
blk.20.ffn_norm.weight
blk.20.ffn_up_exps.weight
blk.20.ffn_up_shexp.weight
blk.20.ssm_a
blk.20.ssm_beta.weight
blk.20.ssm_conv1d_k.weight
blk.20.ssm_conv1d_q.weight
blk.20.ssm_conv1d_v.weight
blk.20.ssm_dt.bias
blk.20.ssm_f_a.weight
blk.20.ssm_g_a.weight
blk.20.ssm_norm.weight
```


### blk.21 (attention)

```text
blk.21.attn_k.weight
blk.21.attn_norm.weight
blk.21.attn_output.weight
blk.21.attn_q.weight
blk.21.attn_v.weight
blk.21.exp_probs_b.bias
blk.21.ffn_down_exps.weight
blk.21.ffn_down_shexp.weight
blk.21.ffn_gate_exps.weight
blk.21.ffn_gate_inp.weight
blk.21.ffn_gate_shexp.weight
blk.21.ffn_norm.weight
blk.21.ffn_up_exps.weight
blk.21.ffn_up_shexp.weight
blk.21.ssm_a
blk.21.ssm_beta.weight
blk.21.ssm_conv1d_k.weight
blk.21.ssm_conv1d_q.weight
blk.21.ssm_conv1d_v.weight
blk.21.ssm_dt.bias
blk.21.ssm_f_a.weight
blk.21.ssm_g_a.weight
blk.21.ssm_norm.weight
```


### blk.22 (attention)

```text
blk.22.attn_k.weight
blk.22.attn_norm.weight
blk.22.attn_output.weight
blk.22.attn_q.weight
blk.22.attn_v.weight
blk.22.exp_probs_b.bias
blk.22.ffn_down_exps.weight
blk.22.ffn_down_shexp.weight
blk.22.ffn_gate_exps.weight
blk.22.ffn_gate_inp.weight
blk.22.ffn_gate_shexp.weight
blk.22.ffn_norm.weight
blk.22.ffn_up_exps.weight
blk.22.ffn_up_shexp.weight
blk.22.ssm_a
blk.22.ssm_beta.weight
blk.22.ssm_conv1d_k.weight
blk.22.ssm_conv1d_q.weight
blk.22.ssm_conv1d_v.weight
blk.22.ssm_dt.bias
blk.22.ssm_f_a.weight
blk.22.ssm_g_a.weight
blk.22.ssm_norm.weight
```


### blk.23 (attention)

```text
blk.23.attn_gate.weight
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


