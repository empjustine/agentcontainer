---
id: llm-local-inference-offload
type: module-design
status: draft
title: "Offload and MoE tuning — the sweep harness, and what to measure before an offload flag earns a place"
parent: llm-local-inference
references: [d206, d210, gguf-model-tooling, refresh-llm-local-inference-manifest]
tags: ["gguf", "offload", "moe", "speculation", "measurement"]
---

# Offload and MoE tuning

Three llama-server knobs change where weights live, and every one of them trades
VRAM against throughput in a way a committed config cannot guess. This document
is the measurement plan for them, not a rule: when one of them earns a default,
the rule moves into `llama-swap-core.json` or the table and this file loses the
paragraph.

It is written against build `61dbf49` (`llama-server --version` reports
`1.0.0-dev (build 1, commit 61dbf49)`), the image `ghcr.io/mostlygeek/llama-swap:unified-vulkan`
carries. Flag text below is that build's own.

## What the flags do

| flag                                                     | help text (61dbf49)                                                                                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--n-gpu-layers-draft N` (`-ngld`, `--gpu-layers-draft`) | "max. number of draft model layers to store in VRAM, either an exact number, 'auto', or 'all' (default: auto)"                                                       |
| `--moe-cache-mib N`                                      | "GPU cache size in MiB for the MoE experts kept in the CPU. with multiple GPUs, it is split among them like the layers (--tensor-split) (default: 0, disabled)"      |
| `--moe-cache-cpu-share F`                                | "share of the MoE cache misses that the CPU computes from the host experts instead of uploading them to the GPU once the cache is full, from 0 to 1 (default: 0.00)" |
| `--n-cpu-moe N`                                          | "keep the Mixture of Experts (MoE) weights of the first N layers in the CPU" — the prerequisite for both MoE cache knobs                                             |

Two consequences follow immediately. `--n-gpu-layers-draft` already defaults to
`auto`, so `all` is a PIN, not an upgrade: it says "the drafter never spills",
which is right only when the arithmetic below leaves headroom. And the MoE cache
does nothing unless experts are on the CPU, which no entry does today — the
config passes no `--n-cpu-moe`, so a cache size alone is inert.

## `--n-gpu-layers-draft all`: the arithmetic

The drafter is small enough that "all on GPU" looks free, and on the fleet card
it usually is — but not always, because the draft context takes the TARGET's
context length (`common/speculative.cpp`: `cparams.n_ctx = llama_n_ctx(ctx_tgt)`)
and our entries serve up to 262144 tokens.

```
pin "all" when
    drafter_weights + draft_kv(type_k, type_v, n_ctx) + target_resident + target_kv
  + activation headroom (≈1 GiB, see --fit-target 1024)
  ≤ FLEET_VRAM_GIB
```

Drafter weights are in the committed manifests, so that term needs no probing:

| drafter                  | rows | weights        |
| ------------------------ | ---- | -------------- |
| MTP `BF16` (gemma-4)     | 20   | 0.17 – 0.96 GB |
| MTP `Q4_0` (Qwen3.8-27B) | 25   | 1.37 GB        |
| dflash `Q4_K_M` (blend)  | 3    | 1.14 GB        |

The `draft_kv` term is the one worth measuring rather than trusting: at 262144
context it dominates the weights for a single MTP layer, and `--spec-draft-type-v`
(we set it to `q8_0` on the families that quantize values) is the knob that
shrinks it — again a throughput lever, never a quality one (d206).

**When the pin is worth it.** A drafter that spills to CPU costs host memory
bandwidth on every draft step, and the draft step is on the critical path of
every generated token. So `all` pays wherever it fits; it is _not_ worth
displacing target layers to get it, because the target evaluates every token and
the drafter only proposes.

**Test matrix** (each cell is one served row, fixed prompt and `--seed`):

| axis          | values                                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| drafter kind  | MTP-BF16 (gemma-4-E4B), MTP-Q4_0 (Qwen3.8-27B:Q4_K_M), dflash-Q4_K_M (blend) |
| draft offload | default (`auto`), `--n-gpu-layers-draft all`                                 |
| value cache   | the row's own (`q8_0`) vs `f16` (isolates the draft KV term)                 |

**What to record**, per cell, from one instrumented run:

- `timings.predicted_per_second` and `timings.prompt_per_second` from each
  response — the two numbers a caller feels;
- draft acceptance: `n_draft_accepted / n_draft_total` and `mean_acc_len` from
  the server log (`draft ratio = …` line) or the `/metrics` counters — this
  separates "the drafter got slower" from "the drafter got worse";
- VRAM in use (card total − free) at steady state, sampled from the host.

The decision is a single comparison: does `predicted_per_second` rise when the
drafter is pinned? If it does, the family earns a per-row key (or a macro) for
`all`; if it falls, `auto` was already right and the floating point of
"everything fits" was doing the work.

## `--moe-cache-mib` / `--moe-cache-cpu-share`: sizing the hot set

Neither knob exists to make a model fit; they exist to make a _CPU-offloaded_ MoE
fast. The cache holds recently used expert blocks on the GPU so a token's active
experts do not cross the bus on every step, and `cpu-share` decides what happens
on a miss once the cache is full: compute on the host (`1`) or upload and
compute on the GPU (`0`).

The hot set is therefore:

```
bytes_resident = n_layers_offloaded × experts_per_token × bytes_per_expert_block
```

and the cache wants to hold it with a margin. For the fleet's MoE rows
(`gemma-4-26B-A4B` ≈ 4B active, `Qwen3.6-35B-A3B` ≈ 3B active,
`LFM2.5-24B-A2B` ≈ 2B active) that is a few hundred MiB to ~2 GiB — but the
inputs (`n_experts`, bytes per expert) are header facts the manifests do not
carry today, which is why the plan is a sweep, not a formula.

**Sweep** (only after `--n-cpu-moe N` is set for the row, with `N` large enough
that experts actually sit on the CPU):

| knob                    | values                                                      |
| ----------------------- | ----------------------------------------------------------- |
| `--moe-cache-mib`       | 0 (off), 512, 1024, 2048, 4096                              |
| `--moe-cache-cpu-share` | 0.0, 0.25, 0.5 (only at the two largest cache sizes)        |
| fixed                   | the row's own ctx, `--parallel 1`, one prompt, one `--seed` |

Read `predicted_per_second` and the prompt-processing rate per cell. The
expected shape is a knee: throughput climbs while the hot set fits, then
flattens; the knee names the cache size, and the flat part names the CPU share
(0 stays best as long as the bus is not saturated). Any larger cache only steals
from the KV pool, so the knee is a _budget_, not a target.

**What makes the numbers trustworthy.** `--metrics` (Prometheus endpoint,
default off) exposes the same counters the log prints, so a script can scrape
instead of parsing prose; `--log-jsonl`, which the macro sets by default, makes
the per-request lines machine-readable. llama-swap itself derives readiness from
the health body and per-request speed from the response `timings`, so neither
depends on the log format. Hold the prompt, `--seed`, ctx and `--parallel` fixed
across cells or the comparison is noise.

### The verdict on the fleet's host: the cache loses to static placement

Measured on the inference host (`tlalocayotl`,
`tlalocayotl.coelacanth-barb.ts.net` on the tailnet): the MoE-cache cells came
out slower than the same row left to `--fit on` alone. The serving card reaches
its host through 8 PCIe 3.0 lanes, and the host memory behind them is
DDR4-2400 MT/s — the cache's whole mechanism is traffic across that bus: an
expert block uploaded on a miss, or computed on the host under
`--moe-cache-cpu-share`. Static placement pays that cost once, at load:
`--fit on` keeps what fits resident and leaves the rest on the CPU, and a token
then reads its expert where the expert already is instead of waiting for an
upload. A bus this narrow against memory this slow is the case the cache cannot
win.

So no row on this host carries `--n-cpu-moe` or `--moe-cache-*`, no layer
declares them — the empty `20-moe-cache.yaml` fragment the experiment left
behind is deleted — and the sweep above is the procedure for a host with a wider
link and faster memory rather than a pending measurement here. The finding also bounds the cache's advice: a
default committed from this host's numbers would be a pessimisation on a
PCIe 4/5 host, and one committed from a fast host would be wrong here.

## What would justify a default

- `--n-gpu-layers-draft all` on a family where the pin beats `auto` at the
  row's own context: one macro edit, and the "all" claim is then repeated by
  generation for every row of that family.
- `--moe-cache-mib` once an entry _has_ CPU-resident experts: a per-row key
  (the number depends on the row's size against the card, which is exactly what
  a row knows and a global macro does not), with the knee from the sweep as the
  starting value.
- Neither knob before its prerequisite exists. A cache size on a fully
  GPU-resident model is a no-op, and a pinned drafter that evicts target layers
  is a slower model with a faster drafter.

## The harness: two programs, one sandbox

The control plane must run where the GPU and the binary are, and the image
carries `python3.12` but no node (`ghcr.io/mostlygeek/llama-swap:unified-vulkan`
ships `llama-swap` + `llama-server`, not a JS runtime). So the harness is
Python on both sides, split by privilege:

**Host side — `llm-local-inference/sweep.py`** (entered as `uv run
llm-local-inference/sweep.py`, the usual uv/PEP 723 shape). It owns nothing but
the launch and the artifact:

1. refuse without `config.d/10-local-llm-inference.yaml` (the same 94 as `run.py`);
2. build the container argv, **imported from the runner rather than copied** —
   `pick_backend`, `collect_gpu_devs` and the security block move to
   `lib/container.py` and both `run.py` and `sweep.py` import it, because two
   copies of a sandbox contract drift into two different sandboxes;
3. mount `config.d` read-only at `/etc/llama-swap/config.d`, the HF cache
   read-only at `HUB_GUEST`, `/dev/kfd` + every `/dev/renderD*`, and ONE
   writable directory at `/out`; `--read-only`, `--tmpfs /tmp:rw,size=64m`,
   `--security-opt no-new-privileges`, `--cap-drop ALL`, `--userns=keep-id
   --group-add keep-groups` (podman) all stay exactly as the runner sets them;
4. publish NO port: the probe talks to `127.0.0.1` inside the container, so a
   sweep never exposes a serving surface;
5. `--entrypoint python3` runs the probe; the host prints the returned JSONL and
   writes `lib/offload-facts.json`.

**In-container — `llm-local-inference/lib/sweep_probe.py`** (stdlib only, because
the image has no `uv` and no node): it reads `config.d` as data —
`00-general.yaml` for the macros, `10-local-llm-inference.yaml` (JSON text) for
the per-id `cmd` — expands `${MACRO}` recursively, and for each candidate
spawns `llama-server` with **the production argv**, not a hand-built one. That
is the whole point of consuming `config.d`: the cell measured is the id served,
including the draft sidecar, the KV types and the ctx the generator baked.

Per cell: poll `/health` (its 503 body carries `{"progress": …}`, so a load is
visible), then N requests to `/v1/chat/completions` over `urllib` with a fixed
prompt pair, `temperature 0`, fixed `seed` and `max_tokens`, collect
`timings` and `/metrics`, kill, next cell.

### Preflight the image before believing a number

The probe starts with a fingerprint that goes into every result row: `python3
--version`, `llama-server --version` (must name the build the macro was written
against — `61dbf49` today), `ls /dev/dri`, `which llama-bench
llama-perplexity` (if either exists, the quality leg below can use it), and one
smoke completion. A sweep whose cells do not carry the build is a table of
numbers nobody can attribute.

### Sandbox facts that decide whether the harness can run at all

- **GPU access is two devices, not one**: `/dev/kfd` (ROCm) plus `/dev/renderD*`
  (Vulkan/DRI), and rootless podman needs `--group-add keep-groups` for the
  device cgroup to admit them.
- **VRAM is the one metric the image may not be able to read.** `amdgpu` exposes
  `/sys/class/drm/card*/device/mem_info_vram_{used,total}`; that path is bound
  read-only (`--volume /sys/class/drm:/sys/class/drm:ro`) or, failing that, the
  host samples it while the container runs. `rocm-smi`/`nvidia-smi` are not
  guaranteed inside a `--read-only` rootless container.
- **`--read-only` stays on.** A sweep needs exactly one writable mount
  (`/out`); everything else — weights, config, script — is read-only input.
- **Host memory is part of the answer** for anything with `--n-cpu-moe`: the
  probe records `/proc/meminfo`'s `MemAvailable` and the host records the
  process RSS, because a config that fits VRAM and thrashes RAM is not a Pareto
  point, it is a swap stall.

## What to sweep, in the order it pays

Axes are grouped by what they change; a cell that changes quality is never
compared with one that does not.

**Offload placement (the Pareto frontier this harness exists for):**

| axis                                      | values                                             | why it is first                                                                                                  |
| ----------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--n-cpu-moe N`                           | 0, 4, 8, …, layers (MoE rows only)                 | the one knob that trades VRAM for host bandwidth per expert; a step function, so bisect it                       |
| `--moe-cache-mib`                         | 0, 256, 512, 1024, 2048, 4096                      | the hot-set knee; only meaningful with `N > 0`                                                                   |
| `--moe-cache-cpu-share`                   | 0.0, 0.25, 0.5                                     | upload vs host-compute, at the knee only                                                                         |
| `--n-gpu-layers` / `--n-gpu-layers-draft` | default (auto), `all`, and the largest N that fits | dense rows and every drafter; the draft pin is cheap to test and easy to get wrong                               |
| `--ctx-size`                              | 32768, 65536, 131072, 262144                       | the largest single VRAM consumer, and the axis a caller actually feels; the ctx-vs-tok/s curve IS a Pareto front |

**Throughput-only (quality-neutral, safe to sweep without a guard):**
`--threads`/`--threads-batch` (the CPU side of `--n-cpu-moe` work),
`--batch-size`/`--ubatch-size` (sweep on two prompt shapes: prefill-heavy and
decode-only), `--cache-ram`, `--defrag-thold`, `--parallel 1` vs `2`
(aggregate tokens/s at the same KV budget), `--lazy-mode`, `--load-mode`.

**Quality-affecting (tag the cell; only comparable within its class):**
`--cache-type-v f16` vs `q8_0`, `--spec-draft-type-v`, `--flash-attn on` vs
`off`, `--no-kv-offload`, and the target quant itself. The guard is cheap:
with `temperature 0`, fixed seed and identical weights, greedy output must match
the reference config exactly; a diff means the knob moved numerics, and the cell
is its own class (that is how a `q8_0` value cache stops pretending to be a free
win).

**Speculation policy** (its own grid, because `n-max` interacts with the
drafter's block size): `--spec-draft-n-max` × `--spec-draft-p-min` per drafter
family, with the block clamp (dflash: `n-max + 1` is the block) as a hard bound.

### Search order (what keeps it from being a full cartesian product)

1. **Feasibility** — one request per extreme cell (ctx 262144 + `n-cpu-moe 0`,
   and ctx 8k + all on GPU). Cells that cannot load are pruned before costing
   anything.
2. **Coordinate descent from the shipped config**, highest-variance axis first
   (`--n-cpu-moe` for a MoE row, `--ctx-size`/layers for a dense one), bisecting
   the load/tok-s knee instead of walking the whole range.
3. **Pairwise refinement of the axes that actually interact**: `n-cpu-moe ×
   moe-cache-mib`, `ctx × n-gpu-layers`, `n-max × p-min`.
4. **Confirmation** — three runs of every surviving cell, median and MAD; drop
   any cell whose MAD exceeds 5 %, because a Pareto point built on noise is a
   coin flip with a table around it.

The output is a frontier, not a winner: for each row, the set of
`(tok/s, VRAM, ctx, quality class)` cells no other cell dominates, and the
recommended point is the cheapest configuration that holds the row's own ctx
inside `FLEET_VRAM_GIB` with `--fit-target` headroom.

## The artifact that makes it useful

A sweep nobody consumes is a blog post. The measured numbers belong in a
committed fact file beside `lib/gguf-facts.json`, written only by the probe and
normalized (sorted keys, integers, no timestamps) so a re-run diffs only moved
facts:

```json
{
  "unsloth/Qwen3.6-35B-A3B-GGUF": {
    "q4_k_m-3.80bpw": {
      "build": "61dbf49",
      "n-cpu-moe": 32,
      "moe-cache-mib": 1024,
      "moe-cache-cpu-share": 0.0,
      "ctx-size": 131072,
      "gpu-kv-type-v": "q8_0",
      "predicted-per-second": 21.4,
      "prompt-per-second": 184,
      "vram-gib": 14.9
    }
  }
}
```

`30-generate.mjs` then reads it the way it reads the other facts: three keys
(`n-cpu-moe`, `moe-cache-mib`, `moe-cache-cpu-share`) become emitted flags for a
row that has them, the table stays the intent, and a row that deviates says so
explicitly. A `sweep` leg joins `run_all.py` on the serving host — never in
