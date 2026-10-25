---
id: d083
type: decision
status: implemented
title: "d083 — per-unit build entries return as shims, and the coding-agent image gets a free-disk gate"
parent: d041
tags: ["builders", "entrypoints", "spike-validation"]
---

# d083 — per-unit build entries return as shims, and the coding-agent image gets a free-disk gate

## Problem

Spike validation runs the generic `./build.sh` on cloud VMs. On one of the
two, the coding-agent image's layer churn exhausted the disk mid-write:

```
{"tool":"build","target":"coding-agent-image","cmd":"podman",
 "line":"exhausting input failed (error: write
 /home/opc/.local/share/containers/storage/overlay-layers/tmp/...:
 no space left on device)"}
```

and the crash took the WHOLE build down with it: the proxy image and native
targets never ran, so neither the new proxy infrastructure nor the
new-generation coding agent environment could be validated on that host.
Two structural gaps made it fatal:

1. d041 left exactly one build entry (the root `./build.sh`), so there was
   no way to ask for one unit's targets and leave the rest alone.
2. Capability gates keyed on hardware/network facts (render devices, cloud
   reachability) but not on the resource the coding-agent image actually
   consumes: disk.

## Decisions

### (a) argv target selection in the root builder

`./build.sh <target>…` builds just the named artifact targets; no names
builds every registered target. An unknown name is exit 94 with the target
catalog attached; a requested name that does not register on THIS host logs
the capability gate and is left out. `termux-provisioning` is not
selectable — it is environment provisioning (d041), not an artifact, and
every Termux go build needs what it installs, so it runs first regardless
of selection.

### (b) Per-folder `build.sh` shims return — as shims, not shells

`coding-agent/build.sh`, `llm-local-inference/build.sh` and
`llm-reverse-proxy/build.sh` are 3-line entries selecting their unit's
targets in the ROOT builder — the same shape d041(b) kept for the
`generate.sh` shims. What d041 deleted was the duplicated build LOGIC in
four shells; that logic stays deleted, in `build.mjs`'s one target table.
Entry ≠ implementation: a per-unit entry that only selects targets cannot
drift from the builder because it contains nothing to drift.

### (c) A free-disk registration gate for the coding-agent image

`lib/host-capabilities.mjs` gains `freeDiskGiB()`; the coding-agent image
registers only with headroom to spare (floor 20 GiB,
`CODING_AGENT_IMAGE_MIN_FREE_GIB` tunable). The gate keys on a hardware
fact per the module's contract — never on artifact presence, so the
d041/d058 staleness rule is untouched. Below the floor the target skips
with a loud log and the rest of the build proceeds: a skipped target costs
one artifact; the mid-build crash costs the entire build.

**Accepted cost:** the new-generation coding agent environment is not
validated on hosts below the floor. The guard deliberately trades that
coverage for the build's survival; that environment is validated where the
image fits.

## Consequences

- Spike runbooks build the proxy with `./llm-reverse-proxy/build.sh` (or
  `./build.sh llm-reverse-proxy-image llm-reverse-proxy-native`) on the
  VMs; the generic `./build.sh` no longer dies on the constrained one —
  coding-agent-image skips loudly and the rest builds.
- d041's "the per-folder build.sh files are deleted" is superseded in part
  by (b); its one-builder core (single target table, cache-based
  idempotence, no presence-based skips) is unchanged. d082's build seam
  moves one step toward the split: the proxy's entry is already its own
  file.
- The selection contract is documented where builders are documented
  (README, architecture.md, the build.mjs module header).

## Verification record

- `node --check` on `build.mjs` + `lib/host-capabilities.mjs`; `./lint.sh`
  clean (shellcheck covers the three new shims).
- Selection semantics exercised on a bare host: `./build.sh bogus-target`
  → exit 94 with the full catalog (all five names); `./build.sh
  coding-agent-image` → "requested target did not register" + exit 91;
  `./llm-reverse-proxy/build.sh` runs exactly `llm-reverse-proxy-native`
  (the image names report as gated); `./llm-local-inference/build.sh` →
  exit 91 on the gated pull.
- The disk gate cannot fire on a host without a container tool (image
  targets never register there); its first real exercise is the next
  spike-VM build.
