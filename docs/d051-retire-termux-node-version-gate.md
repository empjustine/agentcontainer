---
id: d051
type: bugfix
status: implemented
title: "d051 — retire the Termux node floor gate (check-node-version.mjs)"
parent: d023
depends-on: [coding-agent, lib]
references: [d023, d041]
tags: ["coding-agent", "node", "termux", "gate", "maintainability"]
---

# d051 — retire the Termux node floor gate

**Status:** implemented — `coding-agent/check-node-version.mjs` deleted, its
Termux call site removed from `coding-agent/generate.mjs`. Supersedes d023's
b3 ("kept: it is the only home of the 22.19 rationale").

## What triggered it

The gate at `generate.mjs`'s Termux pre-stage was written to fail fast when
the system node was missing or below pi-coding-agent's `engines` floor
(≥ 22.19). Its presence probe was inverted:

```js
if (!spawnSync("node", ["--version"], { stdio: "ignore" }).status) { … }
```

`spawnSync(...).status` is the **exit code** (`0` on success), so `!status`
was `true` whenever node *worked* — every Termux run with a healthy node
exited 93 with "node not found". It only distinguished a binary that ran and
exited non-zero (near-impossible for `node --version`), never the missing
case it was meant to catch.

Fixing the probe exposed that the branch is logically dead: `generate.mjs`
is already running under node, so `process.execPath` is the interpreter to
check, and every stage spawns `process.execPath` too (`runStage`) — nothing
invokes a `node` by name. The separate `node`-on-PATH probe guarded nothing.

## Decision

Retire the gate rather than repair it; the floor is structurally satisfied
everywhere it can run:

- **Termux** — node is Termux's `nodejs` package, a bionic-prefix build
  that tracks the current major (24 today). A sub-22.19 node there would
  mean a stale `pkg upgrade`, not a hand-built libc-specific binary.
- **Everywhere else** — node is pinned by `mise.toml` (`node@24`) through
  `lib/node-run.sh`, so the floor is structural and the gate was already
  documented as "never called" there.
- **pi itself** enforces `>= 22.19` in its `engines` at launch. The gate
  only moved the failure earlier; it did not add a guarantee.

The 22.19 rationale moves into the living docs (`coding-agent/DESIGN.md`'s
profile + invariant notes, `lib/node-run.sh`'s interpreter note) so d023's
"only home of the rationale" concern is preserved without a single-consumer
file.

## Files touched

- `coding-agent/check-node-version.mjs` — deleted (the gate).
- `coding-agent/generate.mjs` — Termux pre-stage gate removed; header
  profile bullet now states pi enforces its own floor.
- `coding-agent/run.sh` — mount comment no longer lists the unmounted gate.
- `coding-agent/DESIGN.md` — profile / invariant / boundary notes updated.
- `lib/node-run.sh` — floor note records that pi self-enforces.
- `tsconfig.json` — `check-node-version.mjs` dropped from the checkJs set.

## Verification

- `./check-types.sh` (tsc `checkJs`, strict) green after the deletion.
- `node --check coding-agent/generate.mjs` green.
- Repo-wide sweep for `check-node-version` / `22.19`: remaining hits are
  d023's immutable body (historical) and this record.
