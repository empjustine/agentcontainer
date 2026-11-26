---
id: d242
type: architecture-design
status: draft
title: "d242 — an npx-shaped runner for the node units: what uv run provides, what node gives, and the pnpm path"
parent: architecture
depends-on: [d138, d139]
references: [d107, d113, d118, d137, d226, d241]
tags: ["research", "toolchain", "node", "pnpm", "dependencies", "spike"]
---

# d242 — an `npx`-shaped runner for the node units

A research spike, not a decision: it records the question, what was measured, and
the path this tree would most likely take. Nothing here is in force, and no code,
gate or pin changed because of it — the pin work that ran beside it is d241.

## Status

Draft, deliberately unadopted. The likely path is **pnpm, acquired the way the
tree already acquires its tools** (mise on a dev host, the host package on
Termux), with the entry runner staying a thin `exec` wrapper. The sections below
say what that path still lacks.

## The question

`./node-run.sh <unit>/<entry>.mjs …` is the only way to start a node entry
(d138), and it is a root-relative spelling a developer has to memorise: it does
not work from inside a unit, it does not resolve an entry by name, and it does
not touch dependencies. The python half of the tree does not have this problem,
because `uv run` reads a file's own declaration, resolves an environment for it
and runs it in one command. What would it take to give the node half the same
ergonomics — and, with it, the ability to let a vetted package replace code the
tree writes by hand?

## What `uv run` is made of

Four capabilities, not one. Node supplies each from a different place, which is
why no single tool is its analogue.

| capability                           | `uv run`                                                   | node's supply                                                           |
| ------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| an interpreter, pinned in the tree   | `requires-python` + `.python-version`, and uv downloads it | `engines` / `devEngines` — an assertion only; nothing downloads node    |
| dependencies declared with the entry | PEP 723 header, `pyproject.toml`                           | `package.json` (per unit)                                               |
| a locked, reproducible environment   | `uv.lock`, content-addressed cache                         | `package-lock.json` / `pnpm-lock.yaml` + `node_modules`                 |
| one command, no install step         | `uv run x.py`                                              | `node --run`, `npm exec`, `pnpm dlx` each cover one-and-a-half of these |

Node has no PEP 723 equivalent: nothing reads a dependency declaration out of a
script file. The closest complete surface is a package manager's own runner, and
this tree already carries one (pnpm, for the `pi-*` folders).

## Measured

On node 24.22.3 / npm 11.19.1, on this tree:

- **`node --run <script>`** is `npm run` minus the fidelity. Stable since 22.10.0;
  it walks up to the nearest `package.json`, runs with that directory as cwd,
  puts `node_modules/.bin` on `PATH`, and executes through a shell. But it skips
  `pre`/`post` scripts, sets no `npm_*` variables, **maps every non-zero exit to
  1** (`node -e 'process.exit(7)'` → 1, where `npm run` → 7), does not forward
  signals, and drops arguments unless they follow `--`. Two open node issues
  describe the cause (nodejs/node#63978, #65712: the shell in the middle).
  For a tree whose exit codes carry meaning (64 usage, 91 missing target, 96
  gate), it cannot be the outer command; d138 chose `exec` for exactly that.
- **`npm exec -- <bin>`** and **`npx --no-install`** use the installed tree and
  work offline. **`npm exec --package=<pkg>`** does not: it resolves from the
  registry and fails offline with `ENOTCACHED` — the drift d107 already rejected.
- **`devEngines.runtime` with `onFail: "error"`** is enforced by npm 11 (and 12):
  a mismatched node fails with `EBADDEVENGINES`. That is the interpreter
  assertion `node-run.sh` documents it does not make today.
- **corepack** (`packageManager: "pnpm@…"`) pins the manager as data, but it
  ships only with node ≤ 24 and is gone from 25 onward — a pin with a removal
  date, and the reason the path below does not lean on it.
- **`pnpm`** gives `pnpm exec <bin>` (local tree), `pnpm install
  --frozen-lockfile` (reproducible), and `pnpm dlx <pkg>` (fetch-on-demand,
  lockfile-blind). Only the first two keep a committed version source.

## What the tree does today

- `node-run.sh` is named **232 times across 101 files** (docs, README, tests,
  entries) — the cost of changing the spelling is a documentation sweep, not a
  code refactor.
- **9 of the 17 node-bearing folders carry a `package.json`**: `coding-agent` and
  the eight `pi-*` packages. The other eight (`git`, `datalakehouse`,
  `llm-local-bench`, `llm-local-inference`, `estige`, `codemode2`, `sbex`,
  `docs`) have none, so `node --run` cannot reach them at all.
- `npm-run.sh` reads a script body out of `package.json` and `exec`s it under the
  pinned node, but does **not** put `node_modules/.bin` on `PATH` — so the root
  `package.json` script table (`lint:js`, `lint:oxlint`, `knip`, `check-types`)
  is unreachable through the documented runner, and `lint.sh` calls the binaries
  by path instead.
- The root `package.json` declares the JS gate toolchain only (d107); no unit
  code imports a package. Every unit runs on the standard library, including the
  eight that would benefit most from one.

## The likely path: pnpm, mise/Termux-managed

What it means concretely:

- **pnpm is the developer-facing surface.** `pnpm exec <bin>` from anywhere in a
  unit's tree, `pnpm install --frozen-lockfile` for the environment,
  `pnpm --dir <unit>` for a specific folder. `pnpm dlx` is not used for anything
  a gate or a runtime path depends on, for the same reason `npm exec --package`
  is not (d107).
- **pnpm itself is acquired by the tree's existing split** (d139, d241): the pin
  table on a dev host, the host package on Termux. That is what keeps it clear of
  corepack's removal and of a fourth install mechanism.
- **The entry runner stays.** A `uv run` shape does not remove the need for a
  pinned interpreter with `exec`-clean status and signals (d138); it adds a name
  map and a dependency environment around it. The likeliest form is one root
  command that resolves `<unit>:<script>` through the unit's own `package.json`
  scripts (the data `node --run` would read, without `node --run`'s exit bug) and
  execs it under the pinned node with the unit's `node_modules/.bin` on `PATH`.
- **Each unit that wants a dependency gets its own `package.json` + lock.** This
  keeps d113 intact in the strongest sense: a folder copied out currently ships
  code that runs on the standard library and nothing else; with its own manifest
  and lock it ships a reproducible way to obtain what it imports.

## What it would take

- **Declaration.** `engines` + `devEngines.runtime` (`onFail: "error"`) in the
  root and per-unit `package.json`, so the interpreter pin becomes a fact npm and
  pnpm can check on any host, Termux included.
- **A name map.** Per-unit `scripts` entries (or one root table) for every entry
  the docs spell as `./node-run.sh …`.
- **One runner.** `exec`-clean, `PATH` carrying the run's `node_modules/.bin`,
  `NODE_USE_ENV_PROXY=1` (d074) and the pinned interpreter; the Termux/mise
  acquisition branch unchanged.
- **Per-unit installs.** Generalize `npm-tools.sh`'s stamped `cksum` install to
  `<unit>` (`pnpm install --frozen-lockfile --ignore-scripts`), which the `pi-*`
  folders already do.
- **A vetting gate — the genuinely new work.** Nothing mechanical admits a node
  package today: biome/knip/tsc entered by record. A gate needs an allowlist of
  names, a lock-diff review (transitives included), `--ignore-scripts`
  everywhere, integrity from the lock, a license check, and the Termux criterion
  d107 learned the hard way — **pure JS or a published `android-arm64` binding,
  never a glibc native** (TypeScript 7 is why the tree still pins 6.x).
- **The classification falls out for free.** `dependencies` vs `devDependencies`
  is d226's runtime/development split, which its R5 left looking for a mechanism;
  a unit's runtime dependencies then belong in that unit's host documentation
  (d226 R2).
- **The sweep.** `lint.sh`'s runner-copy gate and `.bin` calls, `npm-tools.sh`,
  `dev-tools.sh`'s pnpm entry, `cleanup/clean-node-modules.sh`,
  `coding-agent/tests/check-run-dirs.test.mjs`, and the docs that spell the
  runner: README (16 mentions), `docs/architecture.md` (12),
  `docs/container-tooling.md`, the unit READMEs.

## What it buys

The eight folders with no `package.json` total roughly 28k lines of
standard-library code (`git` 11.4k, `datalakehouse` 5.4k, `llm-local-bench`
5.1k, `llm-local-inference` 3.5k, `docs` 0.9k, `estige` 0.8k, `codemode2` 0.7k,
`sbex` 0.1k). The python side shows the shape of the win: `huggingface_hub`,
`gguf`, `pypdf` and `duckdb` do there what hand-written parsers do on the node
side. A vetted-package posture is what lets that trade happen at all — and the
vetting gate, not the runner, is the part that has to land first.

## Open questions

- **One lock or many.** A pnpm workspace at the root gives one lock and one
  install; a lock per unit keeps the copy-unit promise but multiplies installs.
  The `pi-*` folders already chose per-folder locks.
- **What the name map is.** Root table versus per-unit `scripts` keys versus
  `node --run` once nodejs/node#63978 lands and the exit code survives.
- **Whether the entry runner absorbs `npm-run.sh`.** Its JSON read is 40 correct
  lines; `node --run` would delete them and reintroduce the exit-status bug.
- **Which dependency first.** A candidate needs a runtime consumer, an
  `android-arm64` build, and enough size removed to pay for the gate.

## Not done

No runner change, no per-unit manifest, no dependency, no vetting gate, no
`corepack`, and no `npm exec --package` adoption. This record exists so the next
change reads measurements instead of repeating them.
