---
model: unsloth/gemma-4-26B-A4B-it-qat-GGUF
quants: UD-Q4_K_XL
file_UD-Q4_K_XL: gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf
tensor_count: 658
generator: local-llm/generate-layer-cards.py
generated: 2026-08-18 01:59 UTC
---

# Layer names — unsloth/gemma-4-26B-A4B-it-qat-GGUF

Every tensor (layer) name read from the GGUF **tensor-info header** — no weights are loaded into memory. Layer names are architecture-level and identical across quants; per-tensor sizes are listed per quant.

## Summary

| field | value |
|---|---|
| architecture | `gemma4` |
| block count | 30 (`blk.0` … `blk.29`) |
| context length | 262144 |
| embedding length | 2816 |
| total tensors | 658 |
| non-layer tensors | 3 |
| attention blocks | 30 — 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29 |
| quants analyzed | UD-Q4_K_XL |

## Non-layer tensors

| tensor | shape | MiB (UD-Q4_K_XL) |
|---|---|---|
| `output_norm.weight` | [2816] | 0.0 |
| `rope_freqs.weight` | [256] | 0.0 |
| `token_embd.weight` | [2816 x 262144] | 396.0 |

## Block layout

### attention blocks — 30 (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29)

| tensor | shape | MiB (UD-Q4_K_XL) |
|---|---|---|
| `attn_k.weight` | [2816 x 2048] | 3.1 |
| `attn_k_norm.weight` | [256] | 0.0 |
| `attn_norm.weight` | [2816] | 0.0 |
| `attn_output.weight` | [4096 x 2816] | 6.2 |
| `attn_q.weight` | [2816 x 4096] | 6.2 |
| `attn_q_norm.weight` | [256] | 0.0 |
| `ffn_down.weight` | [2112 x 2816] | 3.2 |
| `ffn_down_exps.scale` | [128] | 0.0 |
| `ffn_down_exps.weight` | [704 x 2816 x 128] | 136.1 |
| `ffn_gate.weight` | [2816 x 2112] | 3.2 |
| `ffn_gate_inp.scale` | [2816] | 0.0 |
| `ffn_gate_inp.weight` | [2816 x 128] | 1.4 |
| `ffn_gate_up_exps.weight` | [2816 x 1408 x 128] | 272.2 |
| `ffn_norm.weight` | [2816] | 0.0 |
| `ffn_up.weight` | [2816 x 2112] | 3.2 |
| `layer_output_scale.weight` | [1] | 0.0 |
| `post_attention_norm.weight` | [2816] | 0.0 |
| `post_ffw_norm.weight` | [2816] | 0.0 |
| `post_ffw_norm_1.weight` | [2816] | 0.0 |
| `post_ffw_norm_2.weight` | [2816] | 0.0 |
| `pre_ffw_norm_2.weight` | [2816] | 0.0 |

Blocks with additional tensors on top of the canonical set:

- `blk.0`: `attn_v.weight`
- `blk.1`: `attn_v.weight`
- `blk.2`: `attn_v.weight`
- `blk.3`: `attn_v.weight`
- `blk.4`: `attn_v.weight`
- `blk.6`: `attn_v.weight`
- `blk.7`: `attn_v.weight`
- `blk.8`: `attn_v.weight`
- `blk.9`: `attn_v.weight`
- `blk.10`: `attn_v.weight`
- `blk.12`: `attn_v.weight`
- `blk.13`: `attn_v.weight`
- `blk.14`: `attn_v.weight`
- `blk.15`: `attn_v.weight`
- `blk.16`: `attn_v.weight`
- `blk.18`: `attn_v.weight`
- `blk.19`: `attn_v.weight`
- `blk.20`: `attn_v.weight`
- `blk.21`: `attn_v.weight`
- `blk.22`: `attn_v.weight`
- `blk.24`: `attn_v.weight`
- `blk.25`: `attn_v.weight`
- `blk.26`: `attn_v.weight`
- `blk.27`: `attn_v.weight`
- `blk.28`: `attn_v.weight`


## All tensors by block

- `output_norm.weight`
- `rope_freqs.weight`
- `token_embd.weight`

### blk.0 (attention)

```text
blk.0.attn_k.weight
blk.0.attn_k_norm.weight
blk.0.attn_norm.weight
blk.0.attn_output.weight
blk.0.attn_q.weight
blk.0.attn_q_norm.weight
blk.0.attn_v.weight
blk.0.ffn_down.weight
blk.0.ffn_down_exps.scale
blk.0.ffn_down_exps.weight
blk.0.ffn_gate.weight
blk.0.ffn_gate_inp.scale
blk.0.ffn_gate_inp.weight
blk.0.ffn_gate_up_exps.weight
blk.0.ffn_norm.weight
blk.0.ffn_up.weight
blk.0.layer_output_scale.weight
blk.0.post_attention_norm.weight
blk.0.post_ffw_norm.weight
blk.0.post_ffw_norm_1.weight
blk.0.post_ffw_norm_2.weight
blk.0.pre_ffw_norm_2.weight
```


### blk.1 (attention)

```text
blk.1.attn_k.weight
blk.1.attn_k_norm.weight
blk.1.attn_norm.weight
blk.1.attn_output.weight
blk.1.attn_q.weight
blk.1.attn_q_norm.weight
blk.1.attn_v.weight
blk.1.ffn_down.weight
blk.1.ffn_down_exps.scale
blk.1.ffn_down_exps.weight
blk.1.ffn_gate.weight
blk.1.ffn_gate_inp.scale
blk.1.ffn_gate_inp.weight
blk.1.ffn_gate_up_exps.weight
blk.1.ffn_norm.weight
blk.1.ffn_up.weight
blk.1.layer_output_scale.weight
blk.1.post_attention_norm.weight
blk.1.post_ffw_norm.weight
blk.1.post_ffw_norm_1.weight
blk.1.post_ffw_norm_2.weight
blk.1.pre_ffw_norm_2.weight
```


### blk.2 (attention)

```text
blk.2.attn_k.weight
blk.2.attn_k_norm.weight
blk.2.attn_norm.weight
blk.2.attn_output.weight
blk.2.attn_q.weight
blk.2.attn_q_norm.weight
blk.2.attn_v.weight
blk.2.ffn_down.weight
blk.2.ffn_down_exps.scale
blk.2.ffn_down_exps.weight
blk.2.ffn_gate.weight
blk.2.ffn_gate_inp.scale
blk.2.ffn_gate_inp.weight
blk.2.ffn_gate_up_exps.weight
blk.2.ffn_norm.weight
blk.2.ffn_up.weight
blk.2.layer_output_scale.weight
blk.2.post_attention_norm.weight
blk.2.post_ffw_norm.weight
blk.2.post_ffw_norm_1.weight
blk.2.post_ffw_norm_2.weight
blk.2.pre_ffw_norm_2.weight
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
blk.3.ffn_down_exps.scale
blk.3.ffn_down_exps.weight
blk.3.ffn_gate.weight
blk.3.ffn_gate_inp.scale
blk.3.ffn_gate_inp.weight
blk.3.ffn_gate_up_exps.weight
blk.3.ffn_norm.weight
blk.3.ffn_up.weight
blk.3.layer_output_scale.weight
blk.3.post_attention_norm.weight
blk.3.post_ffw_norm.weight
blk.3.post_ffw_norm_1.weight
blk.3.post_ffw_norm_2.weight
blk.3.pre_ffw_norm_2.weight
```


### blk.4 (attention)

```text
blk.4.attn_k.weight
blk.4.attn_k_norm.weight
blk.4.attn_norm.weight
blk.4.attn_output.weight
blk.4.attn_q.weight
blk.4.attn_q_norm.weight
blk.4.attn_v.weight
blk.4.ffn_down.weight
blk.4.ffn_down_exps.scale
blk.4.ffn_down_exps.weight
blk.4.ffn_gate.weight
blk.4.ffn_gate_inp.scale
blk.4.ffn_gate_inp.weight
blk.4.ffn_gate_up_exps.weight
blk.4.ffn_norm.weight
blk.4.ffn_up.weight
blk.4.layer_output_scale.weight
blk.4.post_attention_norm.weight
blk.4.post_ffw_norm.weight
blk.4.post_ffw_norm_1.weight
blk.4.post_ffw_norm_2.weight
blk.4.pre_ffw_norm_2.weight
```


### blk.5 (attention)

```text
blk.5.attn_k.weight
blk.5.attn_k_norm.weight
blk.5.attn_norm.weight
blk.5.attn_output.weight
blk.5.attn_q.weight
blk.5.attn_q_norm.weight
blk.5.ffn_down.weight
blk.5.ffn_down_exps.scale
blk.5.ffn_down_exps.weight
blk.5.ffn_gate.weight
blk.5.ffn_gate_inp.scale
blk.5.ffn_gate_inp.weight
blk.5.ffn_gate_up_exps.weight
blk.5.ffn_norm.weight
blk.5.ffn_up.weight
blk.5.layer_output_scale.weight
blk.5.post_attention_norm.weight
blk.5.post_ffw_norm.weight
blk.5.post_ffw_norm_1.weight
blk.5.post_ffw_norm_2.weight
blk.5.pre_ffw_norm_2.weight
```


### blk.6 (attention)

```text
blk.6.attn_k.weight
blk.6.attn_k_norm.weight
blk.6.attn_norm.weight
blk.6.attn_output.weight
blk.6.attn_q.weight
blk.6.attn_q_norm.weight
blk.6.attn_v.weight
blk.6.ffn_down.weight
blk.6.ffn_down_exps.scale
blk.6.ffn_down_exps.weight
blk.6.ffn_gate.weight
blk.6.ffn_gate_inp.scale
blk.6.ffn_gate_inp.weight
blk.6.ffn_gate_up_exps.weight
blk.6.ffn_norm.weight
blk.6.ffn_up.weight
blk.6.layer_output_scale.weight
blk.6.post_attention_norm.weight
blk.6.post_ffw_norm.weight
blk.6.post_ffw_norm_1.weight
blk.6.post_ffw_norm_2.weight
blk.6.pre_ffw_norm_2.weight
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
blk.7.ffn_down_exps.scale
blk.7.ffn_down_exps.weight
blk.7.ffn_gate.weight
blk.7.ffn_gate_inp.scale
blk.7.ffn_gate_inp.weight
blk.7.ffn_gate_up_exps.weight
blk.7.ffn_norm.weight
blk.7.ffn_up.weight
blk.7.layer_output_scale.weight
blk.7.post_attention_norm.weight
blk.7.post_ffw_norm.weight
blk.7.post_ffw_norm_1.weight
blk.7.post_ffw_norm_2.weight
blk.7.pre_ffw_norm_2.weight
```


### blk.8 (attention)

```text
blk.8.attn_k.weight
blk.8.attn_k_norm.weight
blk.8.attn_norm.weight
blk.8.attn_output.weight
blk.8.attn_q.weight
blk.8.attn_q_norm.weight
blk.8.attn_v.weight
blk.8.ffn_down.weight
blk.8.ffn_down_exps.scale
blk.8.ffn_down_exps.weight
blk.8.ffn_gate.weight
blk.8.ffn_gate_inp.scale
blk.8.ffn_gate_inp.weight
blk.8.ffn_gate_up_exps.weight
blk.8.ffn_norm.weight
blk.8.ffn_up.weight
blk.8.layer_output_scale.weight
blk.8.post_attention_norm.weight
blk.8.post_ffw_norm.weight
blk.8.post_ffw_norm_1.weight
blk.8.post_ffw_norm_2.weight
blk.8.pre_ffw_norm_2.weight
```


### blk.9 (attention)

```text
blk.9.attn_k.weight
blk.9.attn_k_norm.weight
blk.9.attn_norm.weight
blk.9.attn_output.weight
blk.9.attn_q.weight
blk.9.attn_q_norm.weight
blk.9.attn_v.weight
blk.9.ffn_down.weight
blk.9.ffn_down_exps.scale
blk.9.ffn_down_exps.weight
blk.9.ffn_gate.weight
blk.9.ffn_gate_inp.scale
blk.9.ffn_gate_inp.weight
blk.9.ffn_gate_up_exps.weight
blk.9.ffn_norm.weight
blk.9.ffn_up.weight
blk.9.layer_output_scale.weight
blk.9.post_attention_norm.weight
blk.9.post_ffw_norm.weight
blk.9.post_ffw_norm_1.weight
blk.9.post_ffw_norm_2.weight
blk.9.pre_ffw_norm_2.weight
```


### blk.10 (attention)

```text
blk.10.attn_k.weight
blk.10.attn_k_norm.weight
blk.10.attn_norm.weight
blk.10.attn_output.weight
blk.10.attn_q.weight
blk.10.attn_q_norm.weight
blk.10.attn_v.weight
blk.10.ffn_down.weight
blk.10.ffn_down_exps.scale
blk.10.ffn_down_exps.weight
blk.10.ffn_gate.weight
blk.10.ffn_gate_inp.scale
blk.10.ffn_gate_inp.weight
blk.10.ffn_gate_up_exps.weight
blk.10.ffn_norm.weight
blk.10.ffn_up.weight
blk.10.layer_output_scale.weight
blk.10.post_attention_norm.weight
blk.10.post_ffw_norm.weight
blk.10.post_ffw_norm_1.weight
blk.10.post_ffw_norm_2.weight
blk.10.pre_ffw_norm_2.weight
```


### blk.11 (attention)

```text
blk.11.attn_k.weight
blk.11.attn_k_norm.weight
blk.11.attn_norm.weight
blk.11.attn_output.weight
blk.11.attn_q.weight
blk.11.attn_q_norm.weight
blk.11.ffn_down.weight
blk.11.ffn_down_exps.scale
blk.11.ffn_down_exps.weight
blk.11.ffn_gate.weight
blk.11.ffn_gate_inp.scale
blk.11.ffn_gate_inp.weight
blk.11.ffn_gate_up_exps.weight
blk.11.ffn_norm.weight
blk.11.ffn_up.weight
blk.11.layer_output_scale.weight
blk.11.post_attention_norm.weight
blk.11.post_ffw_norm.weight
blk.11.post_ffw_norm_1.weight
blk.11.post_ffw_norm_2.weight
blk.11.pre_ffw_norm_2.weight
```


### blk.12 (attention)

```text
blk.12.attn_k.weight
blk.12.attn_k_norm.weight
blk.12.attn_norm.weight
blk.12.attn_output.weight
blk.12.attn_q.weight
blk.12.attn_q_norm.weight
blk.12.attn_v.weight
blk.12.ffn_down.weight
blk.12.ffn_down_exps.scale
blk.12.ffn_down_exps.weight
blk.12.ffn_gate.weight
blk.12.ffn_gate_inp.scale
blk.12.ffn_gate_inp.weight
blk.12.ffn_gate_up_exps.weight
blk.12.ffn_norm.weight
blk.12.ffn_up.weight
blk.12.layer_output_scale.weight
blk.12.post_attention_norm.weight
blk.12.post_ffw_norm.weight
blk.12.post_ffw_norm_1.weight
blk.12.post_ffw_norm_2.weight
blk.12.pre_ffw_norm_2.weight
```


### blk.13 (attention)

```text
blk.13.attn_k.weight
blk.13.attn_k_norm.weight
blk.13.attn_norm.weight
blk.13.attn_output.weight
blk.13.attn_q.weight
blk.13.attn_q_norm.weight
blk.13.attn_v.weight
blk.13.ffn_down.weight
blk.13.ffn_down_exps.scale
blk.13.ffn_down_exps.weight
blk.13.ffn_gate.weight
blk.13.ffn_gate_inp.scale
blk.13.ffn_gate_inp.weight
blk.13.ffn_gate_up_exps.weight
blk.13.ffn_norm.weight
blk.13.ffn_up.weight
blk.13.layer_output_scale.weight
blk.13.post_attention_norm.weight
blk.13.post_ffw_norm.weight
blk.13.post_ffw_norm_1.weight
blk.13.post_ffw_norm_2.weight
blk.13.pre_ffw_norm_2.weight
```


### blk.14 (attention)

```text
blk.14.attn_k.weight
blk.14.attn_k_norm.weight
blk.14.attn_norm.weight
blk.14.attn_output.weight
blk.14.attn_q.weight
blk.14.attn_q_norm.weight
blk.14.attn_v.weight
blk.14.ffn_down.weight
blk.14.ffn_down_exps.scale
blk.14.ffn_down_exps.weight
blk.14.ffn_gate.weight
blk.14.ffn_gate_inp.scale
blk.14.ffn_gate_inp.weight
blk.14.ffn_gate_up_exps.weight
blk.14.ffn_norm.weight
blk.14.ffn_up.weight
blk.14.layer_output_scale.weight
blk.14.post_attention_norm.weight
blk.14.post_ffw_norm.weight
blk.14.post_ffw_norm_1.weight
blk.14.post_ffw_norm_2.weight
blk.14.pre_ffw_norm_2.weight
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
blk.15.ffn_down_exps.scale
blk.15.ffn_down_exps.weight
blk.15.ffn_gate.weight
blk.15.ffn_gate_inp.scale
blk.15.ffn_gate_inp.weight
blk.15.ffn_gate_up_exps.weight
blk.15.ffn_norm.weight
blk.15.ffn_up.weight
blk.15.layer_output_scale.weight
blk.15.post_attention_norm.weight
blk.15.post_ffw_norm.weight
blk.15.post_ffw_norm_1.weight
blk.15.post_ffw_norm_2.weight
blk.15.pre_ffw_norm_2.weight
```


### blk.16 (attention)

```text
blk.16.attn_k.weight
blk.16.attn_k_norm.weight
blk.16.attn_norm.weight
blk.16.attn_output.weight
blk.16.attn_q.weight
blk.16.attn_q_norm.weight
blk.16.attn_v.weight
blk.16.ffn_down.weight
blk.16.ffn_down_exps.scale
blk.16.ffn_down_exps.weight
blk.16.ffn_gate.weight
blk.16.ffn_gate_inp.scale
blk.16.ffn_gate_inp.weight
blk.16.ffn_gate_up_exps.weight
blk.16.ffn_norm.weight
blk.16.ffn_up.weight
blk.16.layer_output_scale.weight
blk.16.post_attention_norm.weight
blk.16.post_ffw_norm.weight
blk.16.post_ffw_norm_1.weight
blk.16.post_ffw_norm_2.weight
blk.16.pre_ffw_norm_2.weight
```


### blk.17 (attention)

```text
blk.17.attn_k.weight
blk.17.attn_k_norm.weight
blk.17.attn_norm.weight
blk.17.attn_output.weight
blk.17.attn_q.weight
blk.17.attn_q_norm.weight
blk.17.ffn_down.weight
blk.17.ffn_down_exps.scale
blk.17.ffn_down_exps.weight
blk.17.ffn_gate.weight
blk.17.ffn_gate_inp.scale
blk.17.ffn_gate_inp.weight
blk.17.ffn_gate_up_exps.weight
blk.17.ffn_norm.weight
blk.17.ffn_up.weight
blk.17.layer_output_scale.weight
blk.17.post_attention_norm.weight
blk.17.post_ffw_norm.weight
blk.17.post_ffw_norm_1.weight
blk.17.post_ffw_norm_2.weight
blk.17.pre_ffw_norm_2.weight
```


### blk.18 (attention)

```text
blk.18.attn_k.weight
blk.18.attn_k_norm.weight
blk.18.attn_norm.weight
blk.18.attn_output.weight
blk.18.attn_q.weight
blk.18.attn_q_norm.weight
blk.18.attn_v.weight
blk.18.ffn_down.weight
blk.18.ffn_down_exps.scale
blk.18.ffn_down_exps.weight
blk.18.ffn_gate.weight
blk.18.ffn_gate_inp.scale
blk.18.ffn_gate_inp.weight
blk.18.ffn_gate_up_exps.weight
blk.18.ffn_norm.weight
blk.18.ffn_up.weight
blk.18.layer_output_scale.weight
blk.18.post_attention_norm.weight
blk.18.post_ffw_norm.weight
blk.18.post_ffw_norm_1.weight
blk.18.post_ffw_norm_2.weight
blk.18.pre_ffw_norm_2.weight
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
blk.19.ffn_down_exps.scale
blk.19.ffn_down_exps.weight
blk.19.ffn_gate.weight
blk.19.ffn_gate_inp.scale
blk.19.ffn_gate_inp.weight
blk.19.ffn_gate_up_exps.weight
blk.19.ffn_norm.weight
blk.19.ffn_up.weight
blk.19.layer_output_scale.weight
blk.19.post_attention_norm.weight
blk.19.post_ffw_norm.weight
blk.19.post_ffw_norm_1.weight
blk.19.post_ffw_norm_2.weight
blk.19.pre_ffw_norm_2.weight
```


### blk.20 (attention)

```text
blk.20.attn_k.weight
blk.20.attn_k_norm.weight
blk.20.attn_norm.weight
blk.20.attn_output.weight
blk.20.attn_q.weight
blk.20.attn_q_norm.weight
blk.20.attn_v.weight
blk.20.ffn_down.weight
blk.20.ffn_down_exps.scale
blk.20.ffn_down_exps.weight
blk.20.ffn_gate.weight
blk.20.ffn_gate_inp.scale
blk.20.ffn_gate_inp.weight
blk.20.ffn_gate_up_exps.weight
blk.20.ffn_norm.weight
blk.20.ffn_up.weight
blk.20.layer_output_scale.weight
blk.20.post_attention_norm.weight
blk.20.post_ffw_norm.weight
blk.20.post_ffw_norm_1.weight
blk.20.post_ffw_norm_2.weight
blk.20.pre_ffw_norm_2.weight
```


### blk.21 (attention)

```text
blk.21.attn_k.weight
blk.21.attn_k_norm.weight
blk.21.attn_norm.weight
blk.21.attn_output.weight
blk.21.attn_q.weight
blk.21.attn_q_norm.weight
blk.21.attn_v.weight
blk.21.ffn_down.weight
blk.21.ffn_down_exps.scale
blk.21.ffn_down_exps.weight
blk.21.ffn_gate.weight
blk.21.ffn_gate_inp.scale
blk.21.ffn_gate_inp.weight
blk.21.ffn_gate_up_exps.weight
blk.21.ffn_norm.weight
blk.21.ffn_up.weight
blk.21.layer_output_scale.weight
blk.21.post_attention_norm.weight
blk.21.post_ffw_norm.weight
blk.21.post_ffw_norm_1.weight
blk.21.post_ffw_norm_2.weight
blk.21.pre_ffw_norm_2.weight
```


### blk.22 (attention)

```text
blk.22.attn_k.weight
blk.22.attn_k_norm.weight
blk.22.attn_norm.weight
blk.22.attn_output.weight
blk.22.attn_q.weight
blk.22.attn_q_norm.weight
blk.22.attn_v.weight
blk.22.ffn_down.weight
blk.22.ffn_down_exps.scale
blk.22.ffn_down_exps.weight
blk.22.ffn_gate.weight
blk.22.ffn_gate_inp.scale
blk.22.ffn_gate_inp.weight
blk.22.ffn_gate_up_exps.weight
blk.22.ffn_norm.weight
blk.22.ffn_up.weight
blk.22.layer_output_scale.weight
blk.22.post_attention_norm.weight
blk.22.post_ffw_norm.weight
blk.22.post_ffw_norm_1.weight
blk.22.post_ffw_norm_2.weight
blk.22.pre_ffw_norm_2.weight
```


### blk.23 (attention)

```text
blk.23.attn_k.weight
blk.23.attn_k_norm.weight
blk.23.attn_norm.weight
blk.23.attn_output.weight
blk.23.attn_q.weight
blk.23.attn_q_norm.weight
blk.23.ffn_down.weight
blk.23.ffn_down_exps.scale
blk.23.ffn_down_exps.weight
blk.23.ffn_gate.weight
blk.23.ffn_gate_inp.scale
blk.23.ffn_gate_inp.weight
blk.23.ffn_gate_up_exps.weight
blk.23.ffn_norm.weight
blk.23.ffn_up.weight
blk.23.layer_output_scale.weight
blk.23.post_attention_norm.weight
blk.23.post_ffw_norm.weight
blk.23.post_ffw_norm_1.weight
blk.23.post_ffw_norm_2.weight
blk.23.pre_ffw_norm_2.weight
```


### blk.24 (attention)

```text
blk.24.attn_k.weight
blk.24.attn_k_norm.weight
blk.24.attn_norm.weight
blk.24.attn_output.weight
blk.24.attn_q.weight
blk.24.attn_q_norm.weight
blk.24.attn_v.weight
blk.24.ffn_down.weight
blk.24.ffn_down_exps.scale
blk.24.ffn_down_exps.weight
blk.24.ffn_gate.weight
blk.24.ffn_gate_inp.scale
blk.24.ffn_gate_inp.weight
blk.24.ffn_gate_up_exps.weight
blk.24.ffn_norm.weight
blk.24.ffn_up.weight
blk.24.layer_output_scale.weight
blk.24.post_attention_norm.weight
blk.24.post_ffw_norm.weight
blk.24.post_ffw_norm_1.weight
blk.24.post_ffw_norm_2.weight
blk.24.pre_ffw_norm_2.weight
```


### blk.25 (attention)

```text
blk.25.attn_k.weight
blk.25.attn_k_norm.weight
blk.25.attn_norm.weight
blk.25.attn_output.weight
blk.25.attn_q.weight
blk.25.attn_q_norm.weight
blk.25.attn_v.weight
blk.25.ffn_down.weight
blk.25.ffn_down_exps.scale
blk.25.ffn_down_exps.weight
blk.25.ffn_gate.weight
blk.25.ffn_gate_inp.scale
blk.25.ffn_gate_inp.weight
blk.25.ffn_gate_up_exps.weight
blk.25.ffn_norm.weight
blk.25.ffn_up.weight
blk.25.layer_output_scale.weight
blk.25.post_attention_norm.weight
blk.25.post_ffw_norm.weight
blk.25.post_ffw_norm_1.weight
blk.25.post_ffw_norm_2.weight
blk.25.pre_ffw_norm_2.weight
```


### blk.26 (attention)

```text
blk.26.attn_k.weight
blk.26.attn_k_norm.weight
blk.26.attn_norm.weight
blk.26.attn_output.weight
blk.26.attn_q.weight
blk.26.attn_q_norm.weight
blk.26.attn_v.weight
blk.26.ffn_down.weight
blk.26.ffn_down_exps.scale
blk.26.ffn_down_exps.weight
blk.26.ffn_gate.weight
blk.26.ffn_gate_inp.scale
blk.26.ffn_gate_inp.weight
blk.26.ffn_gate_up_exps.weight
blk.26.ffn_norm.weight
blk.26.ffn_up.weight
blk.26.layer_output_scale.weight
blk.26.post_attention_norm.weight
blk.26.post_ffw_norm.weight
blk.26.post_ffw_norm_1.weight
blk.26.post_ffw_norm_2.weight
blk.26.pre_ffw_norm_2.weight
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
blk.27.ffn_down_exps.scale
blk.27.ffn_down_exps.weight
blk.27.ffn_gate.weight
blk.27.ffn_gate_inp.scale
blk.27.ffn_gate_inp.weight
blk.27.ffn_gate_up_exps.weight
blk.27.ffn_norm.weight
blk.27.ffn_up.weight
blk.27.layer_output_scale.weight
blk.27.post_attention_norm.weight
blk.27.post_ffw_norm.weight
blk.27.post_ffw_norm_1.weight
blk.27.post_ffw_norm_2.weight
blk.27.pre_ffw_norm_2.weight
```


### blk.28 (attention)

```text
blk.28.attn_k.weight
blk.28.attn_k_norm.weight
blk.28.attn_norm.weight
blk.28.attn_output.weight
blk.28.attn_q.weight
blk.28.attn_q_norm.weight
blk.28.attn_v.weight
blk.28.ffn_down.weight
blk.28.ffn_down_exps.scale
blk.28.ffn_down_exps.weight
blk.28.ffn_gate.weight
blk.28.ffn_gate_inp.scale
blk.28.ffn_gate_inp.weight
blk.28.ffn_gate_up_exps.weight
blk.28.ffn_norm.weight
blk.28.ffn_up.weight
blk.28.layer_output_scale.weight
blk.28.post_attention_norm.weight
blk.28.post_ffw_norm.weight
blk.28.post_ffw_norm_1.weight
blk.28.post_ffw_norm_2.weight
blk.28.pre_ffw_norm_2.weight
```


### blk.29 (attention)

```text
blk.29.attn_k.weight
blk.29.attn_k_norm.weight
blk.29.attn_norm.weight
blk.29.attn_output.weight
blk.29.attn_q.weight
blk.29.attn_q_norm.weight
blk.29.ffn_down.weight
blk.29.ffn_down_exps.scale
blk.29.ffn_down_exps.weight
blk.29.ffn_gate.weight
blk.29.ffn_gate_inp.scale
blk.29.ffn_gate_inp.weight
blk.29.ffn_gate_up_exps.weight
blk.29.ffn_norm.weight
blk.29.ffn_up.weight
blk.29.layer_output_scale.weight
blk.29.post_attention_norm.weight
blk.29.post_ffw_norm.weight
blk.29.post_ffw_norm_1.weight
blk.29.post_ffw_norm_2.weight
blk.29.pre_ffw_norm_2.weight
```


