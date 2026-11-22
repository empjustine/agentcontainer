---
id: d234
type: architecture-design
status: active
title: "d234 — prune the unused workload mutators"
parent: architecture
depends-on: [d113, d119, d233]
references: [workload-api]
tags: [verification, workload, api]
---

# d234 — prune the unused workload mutators

This record removes the workload mutators whose only callers were tests. It
changes no launch: the coding-agent launcher sets the same fields it set before.
Readers of `coding-agent/lib/workload-runtime.mjs` and the workload API spec
start here for the current surface; d119 remains the history of the port.

## Status

Verification complete. Eight mutators, five description fields and their render
branches are gone, together with the test cases and spec rows that named them.

## Verification

A call-site census over the whole JavaScript tree classified every workload
export by its importers. Eight mutators had no caller outside
`check-workload.test.mjs`: detach, restart, entrypoint, publish, ro,
hardening, devices and has. The launcher's own import list is the other half of
the finding: it sets name, image, interactive, init, network, user, workdir,
command, env, rw and optional read-only mounts, and nothing else.

## Decision

### The API stops at what launches

The eight mutators and their description fields are deleted. `render()`
no longer emits `--detach`, `--restart`, `--entrypoint`,
`--publish`, `--device` or the hardening pair. `workload_interactive`
keeps the mode field; `workload_rw` and `workload_ro_if` keep the two
mount shapes the launcher uses. A detached service keeps its restart policy in
the runner that owns it, not in an API with no caller here.

### Tests and spec shrink with the surface

The two backend render cases keep their byte-for-byte argv assertions, with
only the fields the launcher can set. The predicate and restart-order cases go
with the mutators they tested. The workload API document drops the same rows and
its bwrap comparison, which named mutators that no longer exist.

## Consequences

- The description type has no dead fields; a caller cannot set a flag this
  renderer will never emit.
- The differential fixture still covers argv order for the live fields,
  including a command word that starts with a dash.
- Records that name the retired mutators (d095, d119, d020) describe their own
  moment and keep their wording.

## Verification

`./check-types.sh`, `node --test coding-agent/tests/*.test.mjs`,
`./lint.sh` and `./test.sh` pass after the change.

## Alternatives rejected

- **Keeping the mutators as a published surface.** No runner calls them; a
  spec row is not a caller. d113's copy-unit rule kills unused surface rather
  than carrying it for a future consumer.
- **Keeping the tests with hand-built descriptions.** That moves the same
  setup into the test file and keeps renderer branches for fields nobody sets.
