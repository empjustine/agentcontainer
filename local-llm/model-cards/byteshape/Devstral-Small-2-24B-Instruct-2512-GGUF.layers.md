---
model: byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF
quants: IQ4_XS
file_IQ4_XS: Devstral-Small-2-24B-Instruct-2512-IQ4_XS-4.04bpw.gguf
tensor_count: 363
generator: local-llm/generate-layer-cards.py
generated: 2026-08-18 01:59 UTC
---

# Layer names — byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF

Every tensor (layer) name read from the GGUF **tensor-info header** — no weights are loaded into memory. Layer names are architecture-level and identical across quants; per-tensor sizes are listed per quant.

## Summary

| field | value |
|---|---|
| architecture | `mistral3` |
| block count | 40 (`blk.0` … `blk.39`) |
| context length | 393216 |
| embedding length | 5120 |
| total tensors | 363 |
| non-layer tensors | 3 |
| attention blocks | 40 — 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39 |
| quants analyzed | IQ4_XS |

## Non-layer tensors

| tensor | shape | MiB (IQ4_XS) |
|---|---|---|
| `output.weight` | [5120 x 131072] | 225.0 |
| `output_norm.weight` | [5120] | 0.0 |
| `token_embd.weight` | [5120 x 131072] | 275.0 |

## Block layout

### attention blocks — 40 (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39)

| tensor | shape | MiB (IQ4_XS) |
|---|---|---|
| `attn_k.weight` | [5120 x 1024] | 1.3 |
| `attn_norm.weight` | [5120] | 0.0 |
| `attn_output.weight` | [4096 x 5120] | 7.0 |
| `attn_q.weight` | [5120 x 4096] | 5.3 |
| `attn_v.weight` | [5120 x 1024] | 5.3 |
| `ffn_down.weight` | [32768 x 5120] | 110.0 |
| `ffn_gate.weight` | [5120 x 32768] | 68.8 |
| `ffn_norm.weight` | [5120] | 0.0 |
| `ffn_up.weight` | [5120 x 32768] | 56.2 |


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
```


### blk.1 (attention)

```text
blk.1.attn_k.weight
blk.1.attn_norm.weight
blk.1.attn_output.weight
blk.1.attn_q.weight
blk.1.attn_v.weight
blk.1.ffn_down.weight
blk.1.ffn_gate.weight
blk.1.ffn_norm.weight
blk.1.ffn_up.weight
```


### blk.2 (attention)

```text
blk.2.attn_k.weight
blk.2.attn_norm.weight
blk.2.attn_output.weight
blk.2.attn_q.weight
blk.2.attn_v.weight
blk.2.ffn_down.weight
blk.2.ffn_gate.weight
blk.2.ffn_norm.weight
blk.2.ffn_up.weight
```


### blk.3 (attention)

```text
blk.3.attn_k.weight
blk.3.attn_norm.weight
blk.3.attn_output.weight
blk.3.attn_q.weight
blk.3.attn_v.weight
blk.3.ffn_down.weight
blk.3.ffn_gate.weight
blk.3.ffn_norm.weight
blk.3.ffn_up.weight
```


### blk.4 (attention)

```text
blk.4.attn_k.weight
blk.4.attn_norm.weight
blk.4.attn_output.weight
blk.4.attn_q.weight
blk.4.attn_v.weight
blk.4.ffn_down.weight
blk.4.ffn_gate.weight
blk.4.ffn_norm.weight
blk.4.ffn_up.weight
```


### blk.5 (attention)

```text
blk.5.attn_k.weight
blk.5.attn_norm.weight
blk.5.attn_output.weight
blk.5.attn_q.weight
blk.5.attn_v.weight
blk.5.ffn_down.weight
blk.5.ffn_gate.weight
blk.5.ffn_norm.weight
blk.5.ffn_up.weight
```


### blk.6 (attention)

```text
blk.6.attn_k.weight
blk.6.attn_norm.weight
blk.6.attn_output.weight
blk.6.attn_q.weight
blk.6.attn_v.weight
blk.6.ffn_down.weight
blk.6.ffn_gate.weight
blk.6.ffn_norm.weight
blk.6.ffn_up.weight
```


### blk.7 (attention)

```text
blk.7.attn_k.weight
blk.7.attn_norm.weight
blk.7.attn_output.weight
blk.7.attn_q.weight
blk.7.attn_v.weight
blk.7.ffn_down.weight
blk.7.ffn_gate.weight
blk.7.ffn_norm.weight
blk.7.ffn_up.weight
```


### blk.8 (attention)

```text
blk.8.attn_k.weight
blk.8.attn_norm.weight
blk.8.attn_output.weight
blk.8.attn_q.weight
blk.8.attn_v.weight
blk.8.ffn_down.weight
blk.8.ffn_gate.weight
blk.8.ffn_norm.weight
blk.8.ffn_up.weight
```


### blk.9 (attention)

```text
blk.9.attn_k.weight
blk.9.attn_norm.weight
blk.9.attn_output.weight
blk.9.attn_q.weight
blk.9.attn_v.weight
blk.9.ffn_down.weight
blk.9.ffn_gate.weight
blk.9.ffn_norm.weight
blk.9.ffn_up.weight
```


### blk.10 (attention)

```text
blk.10.attn_k.weight
blk.10.attn_norm.weight
blk.10.attn_output.weight
blk.10.attn_q.weight
blk.10.attn_v.weight
blk.10.ffn_down.weight
blk.10.ffn_gate.weight
blk.10.ffn_norm.weight
blk.10.ffn_up.weight
```


### blk.11 (attention)

```text
blk.11.attn_k.weight
blk.11.attn_norm.weight
blk.11.attn_output.weight
blk.11.attn_q.weight
blk.11.attn_v.weight
blk.11.ffn_down.weight
blk.11.ffn_gate.weight
blk.11.ffn_norm.weight
blk.11.ffn_up.weight
```


### blk.12 (attention)

```text
blk.12.attn_k.weight
blk.12.attn_norm.weight
blk.12.attn_output.weight
blk.12.attn_q.weight
blk.12.attn_v.weight
blk.12.ffn_down.weight
blk.12.ffn_gate.weight
blk.12.ffn_norm.weight
blk.12.ffn_up.weight
```


### blk.13 (attention)

```text
blk.13.attn_k.weight
blk.13.attn_norm.weight
blk.13.attn_output.weight
blk.13.attn_q.weight
blk.13.attn_v.weight
blk.13.ffn_down.weight
blk.13.ffn_gate.weight
blk.13.ffn_norm.weight
blk.13.ffn_up.weight
```


### blk.14 (attention)

```text
blk.14.attn_k.weight
blk.14.attn_norm.weight
blk.14.attn_output.weight
blk.14.attn_q.weight
blk.14.attn_v.weight
blk.14.ffn_down.weight
blk.14.ffn_gate.weight
blk.14.ffn_norm.weight
blk.14.ffn_up.weight
```


### blk.15 (attention)

```text
blk.15.attn_k.weight
blk.15.attn_norm.weight
blk.15.attn_output.weight
blk.15.attn_q.weight
blk.15.attn_v.weight
blk.15.ffn_down.weight
blk.15.ffn_gate.weight
blk.15.ffn_norm.weight
blk.15.ffn_up.weight
```


### blk.16 (attention)

```text
blk.16.attn_k.weight
blk.16.attn_norm.weight
blk.16.attn_output.weight
blk.16.attn_q.weight
blk.16.attn_v.weight
blk.16.ffn_down.weight
blk.16.ffn_gate.weight
blk.16.ffn_norm.weight
blk.16.ffn_up.weight
```


### blk.17 (attention)

```text
blk.17.attn_k.weight
blk.17.attn_norm.weight
blk.17.attn_output.weight
blk.17.attn_q.weight
blk.17.attn_v.weight
blk.17.ffn_down.weight
blk.17.ffn_gate.weight
blk.17.ffn_norm.weight
blk.17.ffn_up.weight
```


### blk.18 (attention)

```text
blk.18.attn_k.weight
blk.18.attn_norm.weight
blk.18.attn_output.weight
blk.18.attn_q.weight
blk.18.attn_v.weight
blk.18.ffn_down.weight
blk.18.ffn_gate.weight
blk.18.ffn_norm.weight
blk.18.ffn_up.weight
```


### blk.19 (attention)

```text
blk.19.attn_k.weight
blk.19.attn_norm.weight
blk.19.attn_output.weight
blk.19.attn_q.weight
blk.19.attn_v.weight
blk.19.ffn_down.weight
blk.19.ffn_gate.weight
blk.19.ffn_norm.weight
blk.19.ffn_up.weight
```


### blk.20 (attention)

```text
blk.20.attn_k.weight
blk.20.attn_norm.weight
blk.20.attn_output.weight
blk.20.attn_q.weight
blk.20.attn_v.weight
blk.20.ffn_down.weight
blk.20.ffn_gate.weight
blk.20.ffn_norm.weight
blk.20.ffn_up.weight
```


### blk.21 (attention)

```text
blk.21.attn_k.weight
blk.21.attn_norm.weight
blk.21.attn_output.weight
blk.21.attn_q.weight
blk.21.attn_v.weight
blk.21.ffn_down.weight
blk.21.ffn_gate.weight
blk.21.ffn_norm.weight
blk.21.ffn_up.weight
```


### blk.22 (attention)

```text
blk.22.attn_k.weight
blk.22.attn_norm.weight
blk.22.attn_output.weight
blk.22.attn_q.weight
blk.22.attn_v.weight
blk.22.ffn_down.weight
blk.22.ffn_gate.weight
blk.22.ffn_norm.weight
blk.22.ffn_up.weight
```


### blk.23 (attention)

```text
blk.23.attn_k.weight
blk.23.attn_norm.weight
blk.23.attn_output.weight
blk.23.attn_q.weight
blk.23.attn_v.weight
blk.23.ffn_down.weight
blk.23.ffn_gate.weight
blk.23.ffn_norm.weight
blk.23.ffn_up.weight
```


### blk.24 (attention)

```text
blk.24.attn_k.weight
blk.24.attn_norm.weight
blk.24.attn_output.weight
blk.24.attn_q.weight
blk.24.attn_v.weight
blk.24.ffn_down.weight
blk.24.ffn_gate.weight
blk.24.ffn_norm.weight
blk.24.ffn_up.weight
```


### blk.25 (attention)

```text
blk.25.attn_k.weight
blk.25.attn_norm.weight
blk.25.attn_output.weight
blk.25.attn_q.weight
blk.25.attn_v.weight
blk.25.ffn_down.weight
blk.25.ffn_gate.weight
blk.25.ffn_norm.weight
blk.25.ffn_up.weight
```


### blk.26 (attention)

```text
blk.26.attn_k.weight
blk.26.attn_norm.weight
blk.26.attn_output.weight
blk.26.attn_q.weight
blk.26.attn_v.weight
blk.26.ffn_down.weight
blk.26.ffn_gate.weight
blk.26.ffn_norm.weight
blk.26.ffn_up.weight
```


### blk.27 (attention)

```text
blk.27.attn_k.weight
blk.27.attn_norm.weight
blk.27.attn_output.weight
blk.27.attn_q.weight
blk.27.attn_v.weight
blk.27.ffn_down.weight
blk.27.ffn_gate.weight
blk.27.ffn_norm.weight
blk.27.ffn_up.weight
```


### blk.28 (attention)

```text
blk.28.attn_k.weight
blk.28.attn_norm.weight
blk.28.attn_output.weight
blk.28.attn_q.weight
blk.28.attn_v.weight
blk.28.ffn_down.weight
blk.28.ffn_gate.weight
blk.28.ffn_norm.weight
blk.28.ffn_up.weight
```


### blk.29 (attention)

```text
blk.29.attn_k.weight
blk.29.attn_norm.weight
blk.29.attn_output.weight
blk.29.attn_q.weight
blk.29.attn_v.weight
blk.29.ffn_down.weight
blk.29.ffn_gate.weight
blk.29.ffn_norm.weight
blk.29.ffn_up.weight
```


### blk.30 (attention)

```text
blk.30.attn_k.weight
blk.30.attn_norm.weight
blk.30.attn_output.weight
blk.30.attn_q.weight
blk.30.attn_v.weight
blk.30.ffn_down.weight
blk.30.ffn_gate.weight
blk.30.ffn_norm.weight
blk.30.ffn_up.weight
```


### blk.31 (attention)

```text
blk.31.attn_k.weight
blk.31.attn_norm.weight
blk.31.attn_output.weight
blk.31.attn_q.weight
blk.31.attn_v.weight
blk.31.ffn_down.weight
blk.31.ffn_gate.weight
blk.31.ffn_norm.weight
blk.31.ffn_up.weight
```


### blk.32 (attention)

```text
blk.32.attn_k.weight
blk.32.attn_norm.weight
blk.32.attn_output.weight
blk.32.attn_q.weight
blk.32.attn_v.weight
blk.32.ffn_down.weight
blk.32.ffn_gate.weight
blk.32.ffn_norm.weight
blk.32.ffn_up.weight
```


### blk.33 (attention)

```text
blk.33.attn_k.weight
blk.33.attn_norm.weight
blk.33.attn_output.weight
blk.33.attn_q.weight
blk.33.attn_v.weight
blk.33.ffn_down.weight
blk.33.ffn_gate.weight
blk.33.ffn_norm.weight
blk.33.ffn_up.weight
```


### blk.34 (attention)

```text
blk.34.attn_k.weight
blk.34.attn_norm.weight
blk.34.attn_output.weight
blk.34.attn_q.weight
blk.34.attn_v.weight
blk.34.ffn_down.weight
blk.34.ffn_gate.weight
blk.34.ffn_norm.weight
blk.34.ffn_up.weight
```


### blk.35 (attention)

```text
blk.35.attn_k.weight
blk.35.attn_norm.weight
blk.35.attn_output.weight
blk.35.attn_q.weight
blk.35.attn_v.weight
blk.35.ffn_down.weight
blk.35.ffn_gate.weight
blk.35.ffn_norm.weight
blk.35.ffn_up.weight
```


### blk.36 (attention)

```text
blk.36.attn_k.weight
blk.36.attn_norm.weight
blk.36.attn_output.weight
blk.36.attn_q.weight
blk.36.attn_v.weight
blk.36.ffn_down.weight
blk.36.ffn_gate.weight
blk.36.ffn_norm.weight
blk.36.ffn_up.weight
```


### blk.37 (attention)

```text
blk.37.attn_k.weight
blk.37.attn_norm.weight
blk.37.attn_output.weight
blk.37.attn_q.weight
blk.37.attn_v.weight
blk.37.ffn_down.weight
blk.37.ffn_gate.weight
blk.37.ffn_norm.weight
blk.37.ffn_up.weight
```


### blk.38 (attention)

```text
blk.38.attn_k.weight
blk.38.attn_norm.weight
blk.38.attn_output.weight
blk.38.attn_q.weight
blk.38.attn_v.weight
blk.38.ffn_down.weight
blk.38.ffn_gate.weight
blk.38.ffn_norm.weight
blk.38.ffn_up.weight
```


### blk.39 (attention)

```text
blk.39.attn_k.weight
blk.39.attn_norm.weight
blk.39.attn_output.weight
blk.39.attn_q.weight
blk.39.attn_v.weight
blk.39.ffn_down.weight
blk.39.ffn_gate.weight
blk.39.ffn_norm.weight
blk.39.ffn_up.weight
```


