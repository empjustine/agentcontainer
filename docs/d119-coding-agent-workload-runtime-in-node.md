---
id: d119
type: module-design
status: active
title: "d119 — coding-agent's workload runtime is a node module: the unit needs no jq and no shell but a shim"
parent: coding-agent
depends-on: [d041, d045, d046, d056, d059, d068, d083, d113, d118]
references: [d023, d024, d030, d060, d070, d074, d091, d095]
tags: [coding-agent, workload-api, node, jq, entrypoints]
---

# d119 — coding-agent's workload runtime is a node module

## Problem

`coding-agent/` was the last unit whose launcher was shell-first: a 391-line
`run.sh` that built a declarative workload description out of `workload_*` shell
calls, rendered it into a `container run` argv through six jq filters
(`workload-{append,cmd,has,mount,port,render}.jq`), and then exec'd the runtime.
Generation was shell too (`generate.sh` → `node_run generate.mjs`), and the
unit's own checks were shell scripts.

The consequence was a **host prerequisite nobody could see in the code**: `jq`.
Every path through the launcher hit it, so a host without jq could not run the
coding agent at all, and the failure surfaced as `log_die 92 "jq not found —
required by the workload_* API"` in a `_sb_jq` gate. The unit already required
node (`generate.sh` runs it, the `Containerfile` is a node image) — so the
shell + jq pair was an extra language and an extra binary to express what a
module in the language the unit already needs can express.

## Decision

**The workload API is implemented in node inside the unit, and `jq` leaves
`coding-agent/` entirely.**

- `lib/workload-runtime.mjs` replaces `lib/workload-runtime.sh` and the six
  `.jq` filters: backend detection (podman vs docker), the `workload_*`
  mutator surface over an in-memory description, `render()` emitting the exact
  argv the filters emitted (same flag order), and the runtime helpers
  (`containerRunArgv`, `workload_run/rm/logs`, `missingMountHosts`,
  `detectGpuDevs`). The in-memory step is why the templates disappear: a
  description is a value, not a document to be filtered.
- `run.mjs` replaces the launcher body. `buildLaunch(argv, env, host, cwd)` is
  **pure** — no spawn, no filesystem read — and returns the argv or throws a
  `LaunchRefusal(code, fields)`; `main()` spawns and propagates the status. The
  exit map is unchanged: 90 DIRECTORY refusal, 91 no backend / missing tool,
  92 `WorkloadDescriptionError`, 93 `auth.json`, 94 missing or stale artifact.
- `run.sh` survives as a **~20-line compat shim** over `lib/node-run.sh` +
  `run.mjs`. The documented chain (`./environment.sh ./coding-agent/run.sh`),
  operator habit and `docs/d046`'s chain step all name it. `exec` was
  impossible when this was written (a shell function cannot be exec'd, so
  `set -e` carried the status); d138 made the pin a command, so the shim now
  execs and the status is node's own.
- **`package.json` is the unit's entrypoint table** (`build`, `generate`,
  `run`, `test`), and `build.sh`/`generate.sh` became shims over
  `lib/npm-run.sh` (they sourced it when this was written; since d138 each is
  one `exec` of the repo-root `npm-run.sh` with the unit folder and the script
  name as argv). The same helper is the repo-root `npm-run.sh` for units that ship no
  shell at all (d118).
- **The tests that were shell scripts are `*.test.mjs`**: the retired renderer's
  captured argv is the differential fixture (`tests/expect-run-dirs.txt`, one
  word per line), and a static `jq-free` guard proves the unit carries no `.jq`
  and invokes no `jq`.

## Invariants this keeps

- **The sandbox sees no change.** The one argv difference is
  `--env NODE_USE_ENV_PROXY=1`: the runner (`node-run.sh`) sets it per invocation, the
  launcher's allowlist already listed the name, and the image's own `ENV` has
  the same value — so forwarding it is a no-op inside the container and is
  recorded in the fixture with that reason.
- **`config.toml` keeps its `jq` entry.** That file describes the _in-image_
  mise configuration (`Containerfile` copies it); jq stops being a **host**
  prerequisite, it does not stop existing in the image.
- **Refusal stays late.** Required mounts are recorded when the description is
  built and refused once in the launcher (`missingMountHosts`), so a description
  can be assembled with no filesystem.
- **The pin is unchanged.** `lib/node-run.sh` still picks system node on Termux
  and `mise exec node@24` elsewhere; `./npm-run.sh` never lets PATH pick npm's own
  interpreter, because `npm` is itself a node program (measured: `mise exec`
  rewrites PATH, so a stubbed `node` earlier in PATH loses).
- **`jq`-freedom is proven, not asserted.** The static scan catches an
  invocation anywhere in the unit's non-test shell and JS; the runtime half
  launches under a PATH with every jq-providing directory _filtered out_
  (filtered, not prefixed — `mise exec` prepends its own tool directories).
  Both halves were mutation-tested by injecting a `jq` call.

## Consequences

- A host that runs the coding agent needs node and a container runtime — the
  same two things the image already assumes — instead of node, a runtime and
  jq.
- `docs/container-tooling.md` (`workload-api`) now has two implementations of one
  contract: the node module here, the shell + jq pair in `estige/` and
  `llm-local-inference/` (`docs/d113`). The contract is the doc; the copies
  diverge deliberately.
- `run.sh` no longer contains launcher logic, so `docs/d056`'s argv contract and
  `docs/d068`'s two-sided DIRECTORY spelling are asserted where they now live —
  in `run.mjs` through the pure function, with the manifest as the fixture.
- The launcher is now unit-testable without a backend: `buildLaunch` is a
  function from inputs to argv, which is what let the differential test exist
  at all.

## Alternatives rejected

- **Keep the shell launcher and only drop the jq filters** (render in node from
  a shell-built description). It removes the binary but keeps the process
  boundary and two languages for one value.
- **Port to Go**, matching `estige/`. Go would add a toolchain to a node unit's
  copy unit, and the launcher is a thin argv builder over `podman`/`docker` —
  node is already there.
- **Delete `run.sh` outright** (operators call `run.mjs`). It would break the
  `./environment.sh ./coding-agent/run.sh` chain step, the README, and every
  habit built since `docs/d046` — for a saving of 20 lines.
- **Keep `run.sh` and inline the launcher as a heredoc node script.** One file,
  but an untestable one: no import, no fixture, no pure function.
