---
id: d138
type: architecture-design
status: active
title: "d138 — the node pin and the npm runner are one repo-root command each, and units ship no shell shims"
parent: architecture
depends-on: [d041, d113, d121]
references: [d023, d051, d062, d074, d099, d119]
tags: ["entrypoints", "interpreter-pin", "shell", "trampoline", "exec"]
---

# d138 — one command each, at the repo root; no per-entry shims

## Problem

docs/d041 split the interpreter pin out of `workload-runtime.sh` into
`lib/node-run.sh` and left it defining a shell **function** that every shim
sources:

```sh
. "$(dirname "$0")/lib/node-run.sh"
node_run "$(dirname "$0")/app.mjs" "$@"
```

That shape is invisible to `exec`, and everything downstream paid for it:

- **No shim could replace itself.** `coding-agent/run.sh` had to stay resident
  under `set -e` purely to carry node's status back, because
  `exec node_run …` cannot resolve a function.
- **The farm lock carried a workaround.** `git/farm-lock.sh` used flock's *fd*
  mode, not `flock LOCKFILE CMD`, because the guarded command was
  `node_run` — a function `flock` could not execvp (`failed to execute
  node_run`). docs/d121 records the workaround as if it were a property of
  flock.
- **`lib/npm-run.sh` could not locate its own sibling.** POSIX sh cannot
  self-locate a *sourced* file, so it recovered the caller's folder from
  `dirname "$0"` — a convention every shim had to honour, and the reason
  `workload-runtime.sh` needs its `WORKLOAD_LIB_DIR` seam.
- **Nothing outside a shell could use the pin.** `flock`, an IDE task, a future
  MCP server wrapping `./git/farm-tool.sh` — all of them get a file, and a file
  that is only a function definition is not a command.
- **`estige/build.sh` forked a private copy** of the function (`estige/lib/`
  carried no `node-run.sh`), the exact duplication d041 deleted elsewhere.

## Decision

`node-run.sh`, `npm-run.sh` and `node-run.ps1` are **programs with a shebang, an
exec bit and argv** — trampolines — they exist **once**, at the repo root, and
they are **the way a unit's node entry is started**. There are no per-entry
`.sh` shims left in the tree:

```sh
./node-run.sh ./coding-agent/run.mjs ~/Downloads/references
./node-run.sh git/audit.mjs --root /mnt/farm
./npm-run.sh coding-agent generate --check
./npm-run.sh pi-hyper generate
```

Their contracts:

- **`node-run.sh SCRIPT|FLAG… [ARGS…]`** — the pinned interpreter
  (`node` on Termux, `mise exec node@24 -- node` elsewhere) with
  `NODE_USE_ENV_PROXY=1` exported (docs/d074). Zero arguments is a usage error
  (exit 64), not a REPL.
- **`npm-run.sh UNIT_DIR SCRIPT [ARGS…]`** — reads the command line out of
  `UNIT_DIR/package.json` and runs it with the pinned interpreter's directory
  leading `PATH`, so `npm` is never on an entrypoint's path (d118). The unit
  folder is an **argv**, not a `dirname "$0"` guess: the runner is executed, so
  it knows only itself.
- **`node-run.ps1`** — the Windows counterpart (d062), at the root for the same
  reason, executed by `git/maintain.ps1`.

What survives as shell, and why:

- **`git/maintain.sh` and `git/-forge-mirror.sh`** — they hold the farm
  `flock` (d099/d121). That is behavior node cannot express, not indirection:
  the lock is taken before the node process exists and released when the holder
  dies. They call `with_farm_mutation_lock "$repo/node-run.sh" …`.
- **`llm-local-inference/run.sh`** — the llama-swap launcher: it *uses* the
  workload API (`lib/workload-runtime.sh`) to render a container argv. Real
  logic, unchanged by this record.
- **`./environment.sh`** — the one credentials chain step, and deliberately a
  spawner rather than a runner: `infisical run` fetches the vault and starts the
  target with the result as plain environment (docs/d046). Its argument is a
  command, so the chain reads `./environment.sh ./node-run.sh coding-agent/run.mjs`.
- **`lib/log.sh`, `lib/npm-tools.sh`, `lib/workload-runtime.sh`,
  `git/farm-lock.sh`** — libraries: sets of functions a *sourcing* script calls
  repeatedly, which is what sourcing is for.

**Two rounds, one conclusion.** The first pass kept a per-entry shim whose whole
body was `exec "$repo/node-run.sh" "$unit/entry.mjs" "$@"`; that is three lines
of indirection per entry for the privilege of typing a shorter name, and it
leaves two places that must agree about what the entry is. The shims are gone,
so the invoker's argv IS the interface — one spelling, no file to keep in step,
and `./node-run.sh <unit>/<entry>.mjs --help` works for an entry nobody
remembered to shim.

### Why the copies went, and what that narrows in d113

docs/d113 made a folder a **copy unit** that survives being copied out of the
tree, and that is why the pin was a byte-copy per unit (`coding-agent/lib/`,
`git/lib/`, `llm-local-inference/lib/`, `estige/lib/`). One file per unit buys
nothing the other kernels do not: those are *pruned* copies (a unit carries the
exports it calls), while this one is the same 40 lines in every folder — a
transcription of a single fact. The bill arrived as drift, not as theory:
`estige/build.sh` had stopped copying and inlined its own variant of the
function, and `llm-local-inference/lib/node-run.sh`'s header had already
diverged from the other copies.

So the copy-unit promise is **narrowed to code**: a folder copied out of this
tree ships the modules it needs; it does not ship a way to start them. The
spelling that used to be a per-folder shim is now an argv, and the operator (or
the record documenting the run) names the entry explicitly.

## Consequences

- **Exit statuses and signals are node's own** (`exec` replaces the runner), and
  nothing sits between the operator and the program.
- **A pin bump is one edit**, which is what the copies made impossible to
  guarantee; and an entry rename is one edit in the docs, not two files.
- **The documented chain spelling moved** — `./environment.sh
  ./coding-agent/run.sh` is now `./environment.sh ./node-run.sh
  coding-agent/run.mjs`, and `./coding-agent/generate.sh` is
  `./npm-run.sh coding-agent generate`. Operator muscle memory is the real cost
  of this record; the README's quick-start block, `docs/architecture.md`,
  `docs/container-tooling.md` and the unit docs were rewritten to match (see
  below).
- **`lint.sh` carries a `runner-copy gate`**: `*/lib/node-run.sh`,
  `*/lib/npm-run.sh`, `*/node-run.ps1` in tracked files fails the sweep, so a
  re-forked pin is caught the day it lands.
- **The exec bit is load-bearing** on the three runners; `100755` each.
- **`coding-agent/tests/check-run-dirs.test.mjs` spawns the real chain** now
  (`node-run.sh`, then `run.mjs`) instead of a shim, so the test covers what an
  operator actually runs.
- **The PowerShell half follows**: `node-run.ps1` is run, not dot-sourced, and
  sets no `exit` so `$LASTEXITCODE` stays the caller's (d062's branch logic is
  untouched).

## Verification status

- `shellcheck -x -s sh` clean over every remaining `.sh` (the `source-path`
  directives that existed only to satisfy `-x` are gone with the sources).
- Entries run from a foreign working directory, in the documented spelling:
  `./node-run.sh git/audit.mjs`, `git/local-changes.mjs`, `git/farm-tool.mjs`,
  `git/vbs-mirror-all.mjs`, `coding-agent/run.mjs`, `estige/build.mjs`;
  `./npm-run.sh coding-agent build`, `pi-hyper test`;
  `./git/maintain.sh --help` (flock + runner).
- `./test.sh` (264 unit tests, including the retargeted launcher test) and
  `./lint.sh` (with the runner-copy gate) green.
- `node-run.ps1` / `git/maintain.ps1` are **not executed here**: this host has
  no PowerShell (`mise` has no `pwsh`), so the ps1 half is reasoned and
  reviewed, not observed. The first sweep on the work machine is the outstanding
  check — the standing d062 already carries for that file.

## The other languages, surveyed

The question "does this duplication exist elsewhere?" was answered by hashing
every tracked file and grouping by content and by basename:

- **Python** — no runner to duplicate. `run-all.sh` calls `uv run` per step and
  the `.py` tools carry their own PEP 723 metadata; there is no `python-run`
  wrapper and no copy of one.
- **Go** — no runner either. `estige/lib/go-build.mjs` is a *module* (toolchain
  probe + build presets), not a bootstrap command, and it has one copy. Its
  probe logic is re-spelled in `test.sh` and `lint.sh` (each needs the probe
  without a unit's module) — logic duplication, not a same-named file, and
  d123 owns that shape.
- **Node** — `artifact.mjs` (3 copies) and `log.mjs` (2 byte-identical, more
  pruned variants) are genuine hand copies, but they are libraries a unit
  *imports* and prunes (d113), not runners; nothing to collapse here.
- **Shell** — `log.sh` has exactly two copies (root for the sweep,
  `llm-local-inference/lib/` for its run scripts). It is a logger a script
  *sources*, so the d113 rule applies unchanged.

Only the interpreter runners were same-content duplicates of a *command*; only
they were pruned. And only shell entries that were pure indirection were
deleted — the flock pair, the llama-swap launcher and the QA sweep carry
behavior and stay.

## Alternatives rejected

- **Per-entry `.sh` shims that `exec` the runner** (the first pass of this
  record). Three lines of indirection to shorten a command, and a second place
  that has to agree about what the entry is.
- **Keep the function and add an executable wrapper beside it.** Two files that
  must agree on the pin, in every copy unit — the drift class d041 deleted.
- **Dual-mode file (execute when run, define when sourced).** A `basename $0`
  sniff decides the mode; it works, but every reader then has to reason about
  which mode is live, and the call sites it would save are two lines each.
- **Keep the per-unit copies and only add the runner-copy gate.** The copies
  *are* the drift; gating them would forbid the shape the tree shipped with.
- **Leave the shims sourcing and only fix the docs.** The flock workaround, the
  resident shim and the `dirname` conventions would all stay, and the tree would
  still have no way to reach the pin from a non-shell caller.
