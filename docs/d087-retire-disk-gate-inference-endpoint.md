---
id: d087
type: decision
status: implemented
title: "d087 — retire the coding-agent free-disk gate; the disk budget lives at the inference pull"
parent: d083
depends-on: [d041, d083]
tags: ["builders", "capability-gates", "spike-validation"]
---

# d087 — retire the coding-agent free-disk gate; the disk budget lives at the inference pull

## Problem

d083(c) put a 20 GiB free-disk floor on the coding-agent image after its
layer churn exhausted a spike-validation VM mid-build and took the whole
generic build down. Two things changed since:

1. **The image got small.** The Containerfile now starts FROM
   `node:24-trixie` — the node runtime ships in the base — instead of
   `debian:13-slim` + a mise-installed toolchain. The layer churn that
   exhausted the VM is gone with it, so the floor guards an artifact that no
   longer strains the disk.
2. **The gate keyed on the wrong consumer.** The multi-GB disk event on a
   build host is the llama-swap `unified-vulkan` pull (llama.cpp inside),
   not the coding-agent image. A free-disk floor downstream of the real
   consumer both misattributes the pressure and spends its skip on the cheap
   target: the expensive pull still ran on hosts where it was pure waste —
   any host got it as long as a render device node existed, RAM aside.

## Decision

- **The coding-agent image registers ungated on container hosts.**
   `lib/host-capabilities.mjs` loses `freeDiskGiB()` (its only consumer)
   and `CODING_AGENT_IMAGE_MIN_FREE_GIB` is retired with it. d083(a)/(b)
   — argv target selection, per-unit shims — are untouched.
- **"Render device exists" becomes "this host is an inference endpoint."**
   The llama-swap pull gate (and, keeping the no-drift invariant, the
   `llm-local-inference/generate.mjs` serving-layer gate) now requires
   render devices **and** total RAM ≥ `INFERENCE_MIN_RAM_GIB` (16 GiB,
   exported from lib/host-capabilities.mjs beside `totalMemGiB()` so
   builder and generator share one definition). llama.cpp serving holds
   weights plus KV cache in memory; a low-RAM host cannot serve no matter
   what accelerators it has, and pulling multi-GB there is the exact waste
   d083's floor was papering over — now stopped at the source.
- **The gates stay hardware-fact keyed** (device nodes, installed RAM),
   never artifact presence — d041/d058's staleness rule untouched. A
   skipped target still logs loudly with the failing facts attached.

Deliberately NOT done: probing whether an accelerator is a GPU vs TPU/NPU,
or whether its driver works. The device-node check is the honest boundary
(a present-but-broken driver is a run-time failure for the serving
container to surface); a host whose only "accelerator" a unified-vulkan
image cannot use still fails at launch, and refining the probe would certify
nothing more at build time.

## Consequences

- Spike-VM runbooks no longer need the disk headroom just to validate the
  coding-agent environment; the generic `./build.sh` builds it anywhere a
  container tool exists.
- A new host profile skips the llama-swap pull that d083's era would have
  allowed: render devices + ≥16 GiB RAM (e.g. a 32 GiB GPU workstation)
  pulls; an 8 GiB RAM box with a discrete GPU skips loudly. That host can
  still generate/proxy to cloud — only local GGUF serving is out.
- `docs/d083` §(c) is superseded by this record; its accepted-cost note
  ("the coding-agent env is not validated below the floor") is withdrawn.

## Verification record

- `node --check` on build.mjs, lib/host-capabilities.mjs,
  llm-local-inference/generate.mjs; `./lint.sh` clean.
- No-VM host: `freeDiskGiB` has no remaining references (rg);
  `CODING_AGENT_IMAGE_MIN_FREE_GIB` gone from code and docs.
- The RAM gate cannot be exercised without a host at the boundary; its
  first real exercises are a low-RAM spike VM (pull must skip) and the
  inference workstation (pull must run).
