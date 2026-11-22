---
id: d233
type: architecture-design
status: active
title: "d233 — remove import indirection and unused surface"
parent: architecture
depends-on: [d072, d113, d119, d232]
references: [d020, workload-api, d118]
tags: [verification, maintainability, imports]
---

# d233 — remove import indirection and unused surface

This record reports a verification pass over import indirection and unused
surface in the code and the documents that describe it. It changes no runtime
behavior. Readers of the generator, workload and git helper code start here for
the current ownership rule; d072 stays the history of the review that kept the
barrel.

## Status

Verification complete. The generator barrel is gone, four exports with no
importer are private, two single-use helpers were inlined or removed, and the
workload API no longer declares an unused GPU probe. This supersedes d072's
verdict on the `gen-lib.mjs` barrel and d119's GPU-probe surface.

## Verification scope

A census of exported names across 136 JavaScript modules, tests included,
found four exports with no importer outside their own file. A manual read of
the candidate list and of the import blocks in both generators found three more
single-use or unused helpers. The comment audit checked the touched modules for
narration of what the next lines do; none was found.

## Decision

### Imports name their owner

Each generator imports logging, artifact writing, provider facts, catalog reads
and route probes from the module that owns them. `gen-lib.mjs` holds the pi
shaping helpers and two path strings; it re-exports nothing. The import block is
the index of where behavior lives, and a reader no longer follows a symbol
through one module to find its implementation.

### Private surface stays private

`DEFAULT_INDEX`, `DEFAULT_IMAGE`, `PROVIDER_MAP` and
`OPENCODE_PROVIDER_FACT_IDS` drop `export`. Their JSDoc and their values stay:
each is a protocol fact consumed by its own module. A test that needs one reads
the module's behavior instead of reaching for the constant.

### Single-use helpers fold into their callers

`softwareForgeUserEmail` folds into `softwareForgeHttpsUrl`, with the IDCS
identity rule moved into that method's JSDoc. `workload_gpu` and
`detectGpuDevs` leave the workload API: the runner declares GPU devices
explicitly through `workload_devices`, and the inference unit probes its own
host devices (`llm-local-inference/lib/host-capabilities.mjs`). The workload
API document drops the two rows that named the removed mutator.

### Comments keep their place

WHY comments and method JSDoc stay under AGENTS.md. Where a helper was deleted,
its rationale moved into the JSDoc of the caller that carries the behavior;
no plain comment narrates the mechanics of the adjacent lines.

## Consequences

- No generated artifact changes. Each import names the module that owns the
  symbol, so a moved helper is a local edit in one generator.
- `gen-lib.mjs` is pure: it reads no file, imports no runtime module and runs
  nothing on load (docs/d049's gate and projection remain its contract).
- A consumer outside this tree that imported the removed exports imports the
  owning module instead; each copy unit still carries its own `lib/` copy
  (d113).
- d072's kept verdict on the barrel and d119's surface list are historical.
  This record carries the current rule.

## Verification

- Baseline `./check-types.sh` and `./test.sh` passed before the edits.
- After the edits: `./check-types.sh`, `node --test coding-agent/tests/*.test.mjs
  git/tests/*.test.mjs` and `./lint.sh` passed. `knip` reports no unused export.
- The generator imports were compared symbol by symbol with the removed export
  block, so every former barrel symbol has a direct owner in its consumer.

## Alternatives rejected

- **Keeping the barrel for compatibility.** Its only consumers are the two
  generators and two tests in the same folder; direct imports are a single
  edit per consumer and remove the extra stop on every lookup.
- **A shared GPU probe.** The inference unit's host-capability vocabulary has
  its own schema; the workload description takes explicit device paths. A
  shared probe would couple two copy units for one unused call.
- **Deleting WHY comments in the same pass.** AGENTS.md owns the comment rule.
  The audited modules had no HOW narration to delete; the rationale of a
  deleted helper belongs in its caller's JSDoc.
