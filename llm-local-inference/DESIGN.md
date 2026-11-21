---
id: llm-local-inference
type: module-design
status: draft
title: llm-local-inference — one llama-swap instance per GPU host, local GGUFs only (deprecated for now, d108)
parent: architecture
depends-on:
  - workload-api
references:
  - environments
tags:
  - serving
  - llama-swap
---

## Responsibility

> **Deprecated for now (docs/d108).** No new clients or features; existing
> deployments keep working. This document stays as the description of the
> paused shape.

Charter: the GPU host's single llama-swap instance for **local GGUF
inference** — generate the capability-gated `config.d/` layers for _this_
host, then launch llama-swap against whatever was generated. The normative
requirement statement lives in the BRD
([../docs/requirements.md](../docs/requirements.md), FR-S1–FR-S4); this doc
owns the shape and the non-obvious mechanics. Serving models _this_ host
cannot run itself is OUT of scope — relaying moved to
`../estige` (the raw passthrough proxy), taking the former relay
layers and the route to a remote host's GPU with it; llama-swap's own
relay/proxy machinery is no longer exercised from here.

## Shape

`30-generate.mjs` (generation — the former gen-lib.mjs + both emitters folded
into one file, docs/d041; `./node-run.sh llm-local-inference/30-generate.mjs`
runs it) and `run.py`
(serve) are strictly separated;
`run.py` mounts the generated `config.d/` read-only into the
`llama-swap:unified-vulkan` image with GPU passthrough + HF-cache mounts and
publishes LAN **9292** (`HOST_PORT` overrides; in-container 8080) — upstream
llama-swap's own example shape, `-p 9292:8080` over the image's default
`-listen 0.0.0.0:8080` (docs/d224). Host port 8080 belongs to ../estige, the
funnel front, which serves the tunnel namespace only (docs/d108). The world
reaches the catalog through the tsnet `tailscale serve` endpoint in front of
this instance, whose host root maps onto that LAN port — a `HOST_PORT`
override means re-pointing the serve endpoint too. The legacy :18080 and :8101
ports are dead and never probed.

**Backend ports are llama-swap's own.** Every model's `cmd` starts from the
`LLAMA_SERVER` macro, which always passes `--port ${PORT}`, and llama-swap
assigns `${PORT}` from `startPort` (`llama-swap-core.json`). llama.cpp's
own default is therefore never in play — no client, user or outside host names
a llama-server port, and llama.cpp moving that default (to 9931) changes
nothing visible here (docs/d224).

**config.d layers** (layer-merge rules in `docs/d018-split-config-d.md` —
not pi's layered-cake merge; d072 names the two apart):
`00-general.yaml` (globals/macros; always) · `10-local-llm-inference.yaml`
(only when a container backend **and** GPU devices are detected; the sibling
`.paths` staleness manifest was retired with its preflight, d170). There is no mode where this instance serves another
host's models: a host without the container backend + GPU cannot serve local
inference and generation fails hard
(`LOCAL_INFERENCE=1` forces generation for debug only). No shell lives in
`config.d/` anymore — the former in-container `launch-gguf.sh` resolver was
replaced by generation-time path baking (`docs/d029` option B).

**Termux leaf**: removed. Termux can neither serve local inference (no
container backend, no GPU) nor reach anything through this module once
relaying left, so it has no role here — there is no `run-native.sh`,
no android cross-build — this folder's own `build.mjs` (docs/d083/d113) only
pre-pulls the container image, and only on a host that is an inference
endpoint.

## Decisions & invariants

- **Generation-time, not runtime**: context windows are embedded into each
  model's `cmd` as `--ctx-size/--n-predict` at generation time from
  `lib/llamacpp-model-data.json` — this folder's own copy, which it also owns
  the _content_ of (`docs/d025`, `CACHE-DESIGN.md`); model ids are just the hf-repo
  (quant lives in it; the active-b and ctx slug prefixes were retired with
  their tables, d170 — a second id spelling of the same entry only invites
  callers to pin a stale one).
- **Generation-time path baking** (`docs/d029` option B): each model is
  resolved to ONE HF snapshot dir (refs/main first, the revision
  `40-download-models.py` pins) and `--model/--mmproj/--model-draft`
  are emitted as plain absolute args inside the `cmd`. llama-swap splits `cmd`
  with posix shlex and execs argv directly — no shell runs, so the retired
  `launch-gguf.sh` in-container resolver (binary lookup, download fallback,
  positional interface) is gone. A cache miss is a generation error; model
  provisioning belongs to `40-download-models.py` and is never
  duplicated as a launch-time download. A cache changed since generation
  surfaces as a llama-server 127 at swap time — the `.paths` preflight that
  used to catch it at launch is retired (d170), and its offline re-verify is
  an open follow-up on `upkeep.py`.
- **Speculation is baked per row, tuned per fleet** (d206): the row owns the
  spec type (`draft-mtp` by default, `draft-dflash` for a dflash sidecar, and a
  model with built-in nextn heads names a type and passes no sidecar at all),
  while the macro owns the span policy — `${SPEC_MTP}` (`--spec-draft-n-max 16`,
  one token at a time) and `${SPEC_DFLASH}` (`--spec-draft-n-max 3`, a
  four-token block per forward pass), both with `--spec-draft-p-min 0.8`: draft
  while the drafter stays confident, stop when it does not, with the ceiling only
  bounding a run that never loses confidence. The KV cache follows the same
  split: values may be quantized and the drafter's cache quantizes with them,
  keys never are (KLD).
- **The hub must be visible** (d207): generation verifies every baked path
  against `$HF_HUB_CACHE` (else `$XDG_CACHE_HOME`/`~`), so an absent, non-directory
  or unreadable root stops it with exit 95 instead of emitting a layer whose
  paths nothing checked. A root that exists but lacks an entry stays the
  warn-and-bake rule (d197); an empty root is a fresh host, not a fault.
- **Offline generation**: the local layer is built from vendored tables
  (`llamacpp-model-data.json`, `llama-swap-core.json`) plus a
  read of the host HF hub cache directory (no network) — the models.dev
  refresh and every HTTP probe went with that handoff and are gone. Quant
  display is pruned here too (d170): BF16/F16/F32 hidden where the row itself
  would claim more than half the fleet card (d199, d202 — never the last row a
  repo publishes), up to three of the cheapest quants dropped where the served
  weights claim less than a quarter of it (never below three rows) — the flat
  table stays the full record. A row's projector decides its one serving mode
  (d220): a repo that ships one serves vision (`--mmproj`, image modality), one
  that ships none serves text-only (`--no-mmproj`), and both carry the same
  `--ubatch-size 2048`/`--no-mmproj-offload` from `LLAMA_SERVER`. Thresholds are
  shares of `FLEET_VRAM_GIB` (16 GiB), never parameter counts, so each one
  states how much of the card it is talking about (d199); the 4B/8B equivalents
  are ~25%/50%. Context comes from the model's own GGUF header via
  `lib/gguf-facts.json` for every entry, capped at 262144 (d197), and
  `--fit on` reconciles a host too small for the window. The parameter count
  excludes the drafter/side builds some repos ship beside the main quants
  (mmproj, MTP, dflash/dspark) — a dflash bf16 once read a 27B blend as 1.9B —
  and reads a repo's full-precision upload as its LARGEST main GGUF, so an
  untagged auxiliary (an `imatrix` blob, a projector name the prefix filter
  misses) can never size the repo (d202).
- **Inbound bearer auth stays**: `apiKeys: ${env.TLALOCAYOTL_API_KEY}` in
  `00-general.yaml` is llama-swap's _own_ client-facing key (PEER_API_KEY →
  REVERSE_PROXY_API_KEY under d071, → TLALOCAYOTL_API_KEY with the hostname
  change; `docs/d001` covers the key-naming contract). It is the only
  secret this module needs — `HF_TOKEN` is NOT forwarded into the container
  anymore (nothing in-container downloads). Only **run.py** needs the vault
  (via the repo-root `./environment.sh`) — generation is offline and key-free: llama-swap
  resolves the `${env.*}` reference from its own environment at load time.

## Boundary

Copy unit = this folder alone (`docs/architecture.md`, docs/d113): it carries
its own `lib/` copy — `log.mjs`/`log.py`, `artifact.mjs` +
`canonical-json.mjs`, `host-capabilities.mjs`, and the data tables it reads
(`llamacpp-model-data.json`, `hf-manifests/`). The HF-cache provisioning and
audit tooling that used to be the sibling `local-llm/` folder now lives FLAT in
this folder too (`CACHE-DESIGN.md` is its sub-spec), so there is no separate
cache unit to reach into. It does NOT carry `cloud-providers.mjs`,
`models.dev.api.json` or `route-probe.mjs` — the modules this unit no longer
uses; they live only in the folders that still consume them
(`../coding-agent` took the probe/facts modules in d039, the JSON fact table in
d113). Must not import from a sibling runner folder.
