---
id: llm-local-bench-roofline
type: submodule-design
status: draft
title: "roofline: what tlalocayotl allows per served GGUF, per context, per turn"
parent: llm-local-bench
depends-on: [d206]
references: [d113, d087, d201]
tags: ["roofline", "local-inference", "moe", "speculation", "bandwidth", "duckdb"]
---

# roofline

A decode-and-prefill calculator for the rows llm-local-inference serves on
tlalocayotl. The unit of an answer is a **scenario**, not a model: the cartesian
of a context level, a placement, a choice about the MoE expert cache, and a
choice about speculation — each priced in the two phases a request has.

The use it is built for is an agentic loop nobody watches: a task is fired off
and the agent spends many turns filling a context that starts small, calling
tools, and coming back with more. So the headline number is not a token's
latency and not a first-token delay — it is **the wall clock of a turn**
(--growth new prompt tokens, whose prefix the server already holds, then --gen
tokens back), and the rate of that turn. First-token latency survives as the
**cold** cost: what a new session, a fresh branch or a cache miss pays once,
which on this host ranges from half a minute to most of a day depending on the
row.

The frame is the memory roofline. At batch 1 a pass reads its own weights once,
so decode time is max(FLOPs/rate, bytes/bandwidth) per device and the sum over
passes is one token. Prefill reads the same bytes once for the whole prompt, so
its time is max(tokens x FLOPs / prefill rate, bytes/bandwidth) — and its
attention term grows with the square of the context. The two phases disagree
about which rows are good, which is why the grid carries both.

## The hardware

| component   | limit           | what it decides                               |
| ----------- | --------------- | --------------------------------------------- |
| RX 6900 XT  | 16 GB, 512 GB/s | which layers are resident, and at what rate   |
| DDR4-2400   | 38.4 GB/s       | the price of every layer the card cannot hold |
| 5800X3D     | 1.6 TFLOPs      | the host half's compute floor                 |
| PCIe 3.0 x8 | 3.9 GB/s        | expert uploads and boundary activations       |

Usable VRAM is the card's 16 GB less a display/driver reserve and the
--fit-target 1024 the deployed macro passes, so a scenario starts from about
14.5 GiB. Efficiencies are 0.85 of bandwidth, 0.50 of decode compute and 0.15 of
prefill MFU (with the flash-attention boost on top), the reference calculators'
calibration; all live in the HOST export of estimate.mjs and are the only
numbers to retune against measurement.

## The arithmetic

Each pass, on the device that holds its layer:

    decode   t = max(2 x activeParams / decodeRate, (weights + kv) / bw)
    prefill  t = max(2 x activeParams x tokens / prefillRate
                     + attn x tokens x min(tokens, window) / prefillRate,
                     (weights + kv) / bw)
    turn     t = prefill(growth) + decode x gen

A token, a prompt or a turn is the sum over passes, plus the activation round
trips a split layer owes the bus, plus the router's dispatch cost. Prefill's
attention term is the reason a 256k prompt costs minutes: quadratic in the
context for a global-attention layer, capped at ctx x window for a
sliding-window one.

**KV cells.** A layer holds its row per token, capped by its sliding window:
pad(min(ctx, window + ubatch), 256) cells — 1536 for a 1024-token window, not
the 262144 the row advertises. A hybrid-attention layer (qwen35's SSM blocks,
nemotron_h's recurrent ones) holds a constant state instead and contributes no
per-token columns, nor any attention FLOPs.

**Placement.** --fit on fills back to front, counting a MoE layer as its dense
part only, then upgrades those hybrids front to back while VRAM lasts —
huggingface-estimate's algorithm, which mirrors llama.cpp's. --n-cpu-moe N is
the other placement: every attention stays on the card and the leading N layers'
experts read from host memory.

**The expert cache.** A --moe-cache-mib hit costs one VRAM read; a miss uploads
over the bus (1/3.9 GB/s) to read at 1/512 GB/s, or computes on the host
(1/38.4 GB/s). Break-even is the hit rate where those average to the static
price:

    h* = (1/DDR4 - miss) / (1/VRAM - miss),   miss = 1/PCIe + 1/VRAM

On this host h* is 0.89, and the grid reports it per row. The cache is a decode
mechanism only, by construction: a prefill chunk touches nearly every expert in
the pool, so a cache that fits beside the weights cannot hold a chunk's working
set, and its prefill column is the static one.

**MTP.** A round drafts K tokens, each a pass over the drafter's own weights,
then verifies them in ONE target pass whose weight reads are unchanged. Expected
accepted tokens are 1 + sum(alpha^i) over i = 1..K, so the gain is
(1 + sum alpha^i) / (K x draftCost + targetCost). The drafter inherits the
TARGET's context, which is what makes its KV the deciding term: a head that fits
beside the target multiplies throughput, one that spills pays DDR4 per draft
token. The spill is priced as a blend (what fits is read from VRAM, the rest from
host memory) because llama.cpp can leave part of a drafter on the host, and a
head that misses by 5 MiB should not read as five times slower than one that
fits.

## What a bottleneck names

Each phase credits its time to the RESOURCE that produced it, so the grid says
which bus is the wall instead of calling all of them "bandwidth". Every scenario
carries decode_bottleneck (and prefill_bottleneck) as one of:

| label       | what it means                                                  |
| ----------- | -------------------------------------------------------------- |
| vram        | card reads: resident weights and their KV                      |
| dram        | host reads: every layer, expert or KV row the card cannot hold |
| pcie        | activations over the link, and expert uploads on a cache miss  |
| gpu-compute | the card's FLOPs, which prefill's attention term can exhaust   |
| cpu-compute | the host's FLOPs, the wall for a spilled row's prompt          |
| dispatch    | router and dispatch overhead                                   |

The label is per phase and per arm, because the arms move time between buses:
the expert cache turns DRAM reads into VRAM reads and link uploads, and MTP
prices a whole round — the verify pass scaled by the tokens it carries, plus the
drafter's own reads on whichever device the drafter landed. So a fully resident
target with a spilled drafter reports dram for that arm even though its own token
never left the card. The share columns (decode_vram_share, decode_dram_share,
decode_pcie_share, decode_compute_share, prefill_compute_share) are there so a
reader can disagree with the label.

Across the 347 scenarios at these settings, **no prompt is ever bus-bound**
(96 gpu-compute, 251 cpu-compute) while decode is bus-bound in 347 of 347 —
which is the one-sentence version of why a prefill number and a decode number
cannot be traded against each other.

## The arms

A scenario is the product of four dimensions; the grid prunes an arm where it
would repeat its neighbour, so every row differs in a dimension the request
asked about.

| dimension | arms                                                      | pruned when                    |
| --------- | --------------------------------------------------------- | ------------------------------ |
| context   | 32k, 64k, 100k, 128k, 256k                                | above the row's served context |
| placement | --fit on, --n-cpu-moe with the attention resident         | the dense trunk does not fit   |
| cache     | off, --moe-cache-mib 2048 (--cache changes the size)      | no expert lives in host memory |
| MTP       | off, on (alpha 0.8, depth 3; --alpha/--depth change both) | the row carries no drafter     |

The context levels are the agentic ones on purpose: nothing below 32k is useful
for a tool-calling session, ~100k is the working range, and every level is priced
because the KV read and the attention term both bite there. Each turn is
--growth 1024 new prompt tokens and --gen 512 returned tokens by default. 31
served rows produce 347 scenarios at these settings.

## Reading the grid

Ranked by turn wall clock, the fleet splits into usable and not — and the split
is not the one a decode leaderboard gives. Best arm per context, seconds per
1536-token turn:

| row (best arm)           | 32k   | 128k       | 256k       | cold 256k     |
| ------------------------ | ----- | ---------- | ---------- | ------------- |
| gemma-4-26B-A4B-qat      | 4 s   | 7 s        | 14 s       | 17 min        |
| gemma-4-E4B-qat + MTP    | 5 s   | 6 s        | not served | -             |
| Qwen3.6-35B-A3B          | 7 s   | 11 s       | 17 s       | 21 min        |
| gemma-4-12B-qat + MTP    | 8 s   | 9 s        | 9 s        | 13 min        |
| Qwen3.8-27B (12 GB)      | 25 s  | 124 s      | 275 s      | 8 h           |
| Qwen3.8-27B Q6_K (22 GB) | 148 s | 203 s      | 263 s      | 10 h          |
| gemma-4-31B-qat + MTP    | 109 s | 200 s      | 306 s      | 12 h          |
| Muse-Glimmer-30B Q6_K_XL | 260 s | not served | -          | 97 min at 64k |

- **A turn is cheap; a cold start is not, and the gap is the design
  constraint.** Qwen3.6-35B-A3B runs a turn in 7 s at 32k and 17 s at 256k, but a
  cold 256k prompt costs 21 minutes. A session that extends its prefix is fast; a
  branch, a new task or a server restart pays the cold column. So the cold number
  decides whether a NEW task can start at that context, and the turn number
  decides what it costs once it has.
- **Quantisation is a throughput lever through residency, not only a quality
  one.** The same Qwen3.8-27B is 25 s/turn at 12 GB and 148 s at 22.5 GB Q6_K:
  the larger file leaves 24 of 65 layers in host memory, and every one of them is
  on the critical path twice — once for the delta's prefill, once per generated
  token. A quant that fits changes the row more than any flag.
- **Muse-Glimmer cannot be an agentic target here, and the cause is placement.**
  25 of 52 layers on the host give a 260 s turn at 32k and a 97-minute cold start
  at 64k, on the fleet's smallest KV. Nothing in its configuration fixes that;
  the card is 11 GB short of it.
- **The cache is a per-row flag, not a host-wide verdict.** Break-even stays at
  0.89, so 2 GiB of cache beside 25 GB of experts prices at 0.25x — but at 128k
  gemma-4-26B-A4B-qat holds only 51 MiB of host experts, the cache covers that
  pool, the hit rate reaches 1.0, and the arm gains 1.16x. The answer depends on
  how much spilled, which is why both arms sit in the grid for every row.
- **Decode is almost always a bus, and which bus changes with the context.**
  The bus column reads vram for Qwen3.6-35B-A3B at every level (63% VRAM, 37%
  DRAM, 0.2% PCIe at 32k), dram for Muse-Glimmer (25 of 52 layers on the host),
  and it flips vram to dram for Qwen3.8-27B between 64k and 100k as the growing
  KV pushes layers off the card. The prompt side is a different answer again:
  Qwen3.6-35B-A3B's cold 32k prefill is 99% cpu-compute, because that delta runs
  on 7 host layers whose FLOPs, not bytes, are the wall there. And where the
  cache misses enough (hit 0.30 on Qwen3.6-35B-A3B Q8_K_XL) the link becomes the
  wall outright — 93.6% pcie at 0.21x — which is the break-even arithmetic seen
  from the losing side.
- **MTP pays about 2x, and loses exactly where the drafter outgrows the card.**
  Across the 92 speculative arms the median gain is 2.16x; the 14 losing arms are
  the ones whose head plus draft KV no longer fits beside the target —
  26B-A4B-qat at 64k (816 MiB head, 224 MiB draft KV, a full card) runs at 0.30x.
  The draft KV grows with the context, so a head resident at 32k is not
  necessarily resident at 128k; the grid carries drafter_kv_mib to show which.

## The grid for DuckDB

--format ndjson (one flat object per line) and --format csv both load without a
schema; every column is a scalar for that reason.

    ./node-run.sh llm-local-bench/roofline/report.mjs --format ndjson --out /tmp/roofline.ndjson

    CREATE VIEW r AS SELECT * FROM read_json_auto('/tmp/roofline.ndjson');

    -- the best arm per row and context: the serving decision
    SELECT model, ctx, placement, cache_mib, mtp, round(turn_s, 1) AS turn_s,
           round(turn_tps) AS turn_tps, round(decode_tps, 1) AS decode_tps,
           round(cold_ttft_s) AS cold_s
    FROM r
    QUALIFY row_number() OVER (PARTITION BY model, ctx ORDER BY turn_s) = 1
    ORDER BY model, ctx;

    -- what a 100-turn task costs: 40 turns at 32k, 40 at 64k, 20 at 100k
    WITH best AS (
      SELECT * FROM r QUALIFY row_number() OVER (PARTITION BY model, ctx ORDER BY turn_s) = 1
    ), plan(ctx, turns) AS (VALUES (32768, 40), (65536, 40), (102400, 20))
    SELECT b.model, round(sum(b.turn_s * p.turns) / 60, 1) AS session_min
    FROM best b JOIN plan p USING (ctx)
    GROUP BY b.model ORDER BY session_min;

    -- where speculation earns its flag, and where it does not
    SELECT model, ctx, round(mtp_gain, 2) AS gain, drafter_mib, drafter_kv_mib,
           drafter_resident
    FROM r WHERE mtp ORDER BY gain;

    -- where the decode second goes, by bus (no cache, no MTP, --fit on)
    SELECT model, ctx, decode_bottleneck,
           round(decode_vram_share, 2) AS vram, round(decode_dram_share, 2) AS dram,
           round(decode_pcie_share, 2) AS pcie,
           round(decode_compute_share, 2) AS compute
    FROM r
    WHERE cache_mib = 0 AND NOT mtp AND placement = 'layer-pipelining'
    ORDER BY model, ctx;

    -- where the expert cache is worth a flag
    SELECT model, ctx, cache_mib, round(cache_gain, 2) AS gain,
           round(cache_hit_rate, 2) AS hit, round(cache_break_even, 2) AS break_even,
           cpu_expert_mib
    FROM r WHERE cache_mib > 0 ORDER BY gain DESC;

## Looped models

The pass list is data, not a loop counter, so a model whose physical blocks are
read more than once fits the same arithmetic. The planned Thinking Machines
Inkling 2 Mini — 26.4B total over 24 physical blocks read as 48 passes, 8 global
and 40 sliding-window-1024 — is a passes array on the model entry:

    { layers: 24, passes: [ { layer: 0, ctxWindow: 0 }, ..., { layer: 23, ctxWindow: 1024 } ] }

Weight residency follows the physical layer (24 of them), while every read, every
KV row and every attention term follows the pass (48) — which is the distinction
the roofline makes and a layer count cannot. No such GGUF is served yet, so the
extractor emits the identity list and the entry needs its passes written by hand
when one lands.

## Running it

    ./node-run.sh llm-local-bench/roofline/extract.mjs   # on the host with the model cache
    ./node-run.sh llm-local-bench/roofline/report.mjs    # the table
    ./node-run.sh llm-local-bench/roofline/report.mjs --format ndjson --out /tmp/roofline.ndjson

extract.mjs reads each row's GGUF header (layer bytes, expert bytes, KV geometry,
expert count, the drafter's own layers) and the hub manifest's byte count, and
writes model-facts.json. That artifact is committed, so the estimator reads only
its own folder and a checkout without the model cache still reports — docs/d113's
copy-unit rule is why the two programs are split. The facts are as current as
their last extraction; re-running the extractor is the update.

Flags: --format table|ndjson|csv, --out, --model <substr>, --contexts
32768,65536,..., --cache <MiB>, --cpu-share, --locality, --alpha, --depth,
--growth and --gen (the turn's shape).

The tests are property tests, not snapshots: they pin that time scales with the
bytes a token reads, that the sliding window caps the KV, that a split is bounded
by DDR4, that a looped pass list costs two reads for one residency, that a turn
costs its delta rather than the whole context, and that the facts file sums to
each file's own byte count.

    ./node-run.sh --test llm-local-bench/roofline/tests/*.test.mjs

## What is not modelled

- **KV spill to host RAM.** A row whose KV exceeds the card is reported with its
  KV following its layer to host memory. The deployed --cache-ram 8192 crosses
  the bus for it instead, which is slower, so those rows read optimistically.
- **Prefix reuse itself.** The turn arm assumes the server still holds the
  prefix, which is what a multi-turn session against one slot looks like with
  --cache-idle-slots and --cache-ram. A prefix that does not extend — a branch, a
  parallel task, an evicted slot — pays the cold column instead. Both are in the
  row so the comparison is available rather than assumed.
- **mmproj.** A vision projector is a separate file and a separate pass; its
  bytes are not in the sums, which matters by about a gigabyte on the multimodal
  rows.
- **Kernel efficiency by shape.** One bandwidth number stands for GEMV of any
  width: a 2048-wide layer and a 5120-wide one are assumed to reach the same
  fraction of peak, and prefill assumes one MFU for every prompt length.

## Calibration

The two reference calculators are the source of the constants, cited rather than
re-derived: ai-leaderboard's HW Roofline for the utilization factors, the
arithmetic-intensity check, the prefill MFU and flash boost, and the MTP shape;
[gabriel.devenyi.ca/huggingface-estimate](https://gabriel.devenyi.ca/huggingface-estimate/)
for the KV sizing and the --fit placement. A constant is replaced by a measured
coefficient when one exists; until then the grid says what the hardware permits,
which is the question a serving decision asks first.
