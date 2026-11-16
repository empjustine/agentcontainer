---
id: d207
type: module-design
status: active
title: "d207 — an invisible HF hub root fails generation (exit 95); a missing entry stays a warning"
parent: llm-local-inference
depends-on: [llm-local-inference]
references: [d029, d197, d206, refresh-llm-local-inference-manifest]
tags: ["gguf", "generator", "cache", "failure-modes"]
---

# d207 — an invisible HF hub root fails generation (exit 95); a missing entry stays a warning

This record splits one warning into two cases. `generate.mjs` bakes every
entry's paths from the host HF hub cache, and until now it treated "this repo is
not pulled yet" and "the cache is not there at all" identically: both emitted a
warning per entry and baked a manifest-declared path anyway. Only the first is a
provisioning state a host recovers from by pulling.

## Problem

**An invisible hub root silently switches verification off for the whole
catalog.** The bake resolves every entry against `$HF_HUB_CACHE` (else
`$XDG_CACHE_HOME/huggingface/hub`, else `~/.cache/huggingface/hub`) and falls
back to the manifest's commit when no snapshot carries the entry's files. With
the root missing, unreadable, or pointing at a file instead of a directory, no
entry can resolve, so generation prints one warning per row and exits 0 with a
layer whose every path is unverified. The volume of warnings is the only signal,
and it is indistinguishable from a fresh host that has pulled nothing.

**A serving host is supposed to see the cache.** For an inference endpoint the
hub is a mount, so its absence is a host/configuration fault — the wrong
`HF_HUB_CACHE`, a container that did not bind the cache, a permission change —
not a state that pulling fixes. Degrading to unverified paths there hides exactly
the fault the bake exists to catch, and defers it to a llama-server 127 at swap
time, where nothing names the mount.

## Decision

- **The root is a precondition.** Before anything is baked, generation stats and
  lists `HUB_HOST`: absent, not a directory, or unreadable ⇒ `logError` naming
  the path and the reason (`ENOENT`, `EACCES`, "not a directory") and
  `exit 95`. The check sits inside the local-inference branch, after the
  capability gate, so a host that is not an endpoint still exits 94 with its own
  message.
- **A missing entry stays a warning.** A root that exists but lacks a repo, a
  snapshot, or one shard keeps d197's warn-and-bake: a host that has not pulled
  yet must still generate, and the miss surfaces as llama-server's 127 at swap
  time.
- **An empty hub is legal.** A present, readable, empty directory is a fresh
  host, not a fault: the guard proves visibility, not contents.
- **Failure artefacts inside an otherwise visible hub belong to the operator.**
  A half-pulled snapshot, an `.incomplete` blob, a lock left by a killed
  download — those are pruned by hand, and generation does not classify them. It
  reports what the bake cannot resolve, per entry (d197's warning, then
  llama-server's 127 at swap time), and says nothing about why the files it can
  see are shaped the way they are.

## Consequences

Generation from a host with no cache now fails loudly instead of emitting a layer
it could not verify, so regeneration needs the hub mounted (or, for a
docs-only/CI regeneration, an empty directory at the same path). The exit code
joins 94 as generator-level host state: 94 = not an inference endpoint, 95 = the
hub is not visible.

Nothing about the emitted layer changes: on the fleet host the hub is visible and
every entry resolves exactly as before, so `config.d` regenerates byte-identically
apart from the table edits a change carries.

`llm-local-inference/tests/prune-quant-display.test.mjs` pins the split: its
sandbox creates an empty hub (warn-and-bake) and one case points
`HF_HUB_CACHE` at a missing path, asserting exit 95 and the message.

## Alternatives rejected

- **Fail on every cache miss.** It breaks the first-pull bootstrap d197 protected:
  a host that has provisioned nothing yet could not generate its own layer.
- **Warn once and continue.** One extra line in a log that already carries a
  warning per entry; the layer would still ship unverified, and the operator would
  read it as provisioning state.
- **Verify at swap time instead.** llama-server's 127 names the file, not the
  mount, and arrives after the catalog is already stale.
- **Check for a plausible hub layout (any `models--*` directory).** An empty hub
  is legitimate, so the guard would fail a fresh host to catch a fault the
  visibility check already catches.
