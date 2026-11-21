---
id: d226
type: architecture-design
status: active
title: "d226 — runtime tooling and development-only tooling are two lists"
parent: architecture
depends-on: [d139]
references: [d051, d107, d137, d138, d170]
tags: ["toolchain", "runtime", "gates", "maintainability"]
---

# d226 — runtime tooling and development-only tooling are two lists

This record separates two questions the tree has been answering with one list:
what a host installs to **run** a unit, and what a change installs to **check**
one. It records the distinction and the requirements; no acquisition mechanism
is adopted yet. The reader is whoever writes a host's setup, a gate, or a
tool's pin.

## Problem

`./dev-tools.sh` is the one pin table (d139), and its `DEV_TOOLS_ALL` is one
alphabet: `go golangci-lint shellcheck shfmt jq oxfmt pnpm ruff uv ty`. The
header already names a split — "the dev half of that split" — but nothing
enumerates the other half, and the pin table does not mark which name belongs to
which.

The two audiences then guess in opposite directions:

- **A runtime host** (an inference host, a serving VM) has to work out that
  `biome`, `oxlint`, `knip`, `oxfmt`, `shellcheck` and `golangci-lint` are
  not things it runs. Nothing says so, and `DEV_TOOLS_PROFILE=full` installs
  them all.
- **A development host** has no list of what a runtime needs, so a check can
  pass on a machine carrying tools a real host lacks — or a runtime dependency
  can hide inside a gate and surface only at deploy time.
- **The gate's own Python environment** is the same ambiguity in one unit: the
  repo `pyproject.toml` exists so `ruff`/`ty` resolve imports, while the tools
  it checks run as PEP 723 scripts with their own `uv run` environments. That
  file's comment says "gate infrastructure", not runtime — a distinction living
  in a comment rather than in the record that owns it.
- **A runtime dependency is acquired through the dev bootstrap.**
  `datalakehouse/atuin-warehouse-sync.sh` needs `duckdb` and `jq` to do its job,
  and its own "Needs" line tells the operator to run `./dev-tools.sh duckdb` —
  a dev script invoked to provision runtime tools. The acquisition path is not
  wrong (it is the one pin table); the naming and the role are.

## Decision

**R1 — Every acquired tool is classified: runtime, development-only, or both.**
A tool is _runtime_ when a host needs it to run a unit, or to build the artefact
that unit serves (a jar, a binary, an image). Everything needed only to lint,
format, type-check or test is _development-only_. A tool with any runtime
consumer is runtime (shared), and the dev-only set is what no runtime path
needs at all.

**R2 — Each unit states its runtime requirements.** "What does this host install
to run this unit" is answerable from the unit's own documentation, without the
development-only list. `docs/environments-and-variants.md` and the root README
are where host-level lists land.

**R3 — No runtime path depends on a development-only tool.** A launcher, service,
generator, script or image must not invoke or require one. d139's "mise lives
here and nowhere a unit runs" is this rule for one tool; it applies to every
one. A gate may depend on runtime tools (a test runs the unit); the reverse is
not allowed.

**R4 — The pin table stays one table; the classification is separate from the
version.** Reproducibility wants every pin in one place (d139, d137), and the
role of a tool is a different fact from its version. The pin table and the two
lists must not become three homes for a version, and a tool's role must not
depend on how it is delivered.

**R5 — Until a mechanism lands, the classification is documentation only.** The
open options are a per-unit runtime manifest, two acquisition entry points into
the one pin table, or a role column beside the pins. This record does not choose
between them, and a change that needs the answer uses the lists below.

## The lists today

| role                       | tools                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| runtime                    | `sh`; `node` (resolved by `./node-run.sh`, d138); `uv` + python (the PEP 723 tools, invoked as `uv run --script`); a container backend (`podman` or `docker`); `infisical` (the env chain); `go` (estige build/install); JDK + Maven (sbex jar); `git` (the `git/` unit and its mirrors); `duckdb` and `jq` (the datalakehouse warehouse script) |
| development-only           | `mise` (acquisition itself); the npm gate toolchain — `biome`, `oxlint`, `knip` (installed by `./npm-tools.sh`); `oxfmt`; `shellcheck`, `shfmt`; `golangci-lint`; `ruff`, `ty`; `pnpm` (extension devDependencies); the gate environment itself (`pyproject.toml`, `uv.lock`, `.venv`)                                                           |
| both (runtime and dev use) | `go` (builds the unit, runs the Go suite), `node` (runs the units, runs the node gates), `uv` (runs the tools, acquires the gate tools)                                                                                                                                                                                                          |

## First application: `py-run.sh` retired

The python tools are runtime tooling, and their invocation is treated as such:
`uv run --script <file>` directly, with the vault chain as
`./environment.sh uv run --script llm-local-inference/run.py`. The root wrapper
that used to do this (d170's "one root file owns the interpreter decision") was
not runtime tooling and was not a gate: it was invocation glue in a runtime path,
one more file to keep in step with every entry that named it. uv itself is the
interpreter decision; the wrapper's two checks (a `.py` argument, uv on PATH) are
uv's own errors. Records that describe the wrapper (d170) keep their text as
dated artefacts.

## Status

Documented. The classification above is the working answer, and no acquisition
mechanism has landed: `dev-tools.sh` still installs one profile, and R2's
per-unit lists are outstanding for the host docs.

## Alternatives rejected

- **Classify by delivery channel** (mise vs npm vs the host package manager).
  The channel says nothing about the role: `go` is mise-delivered and runtime,
  `biome` is npm and development-only.
- **One list, and each host installs what it needs.** That is the current state;
  it cannot answer the question because the list carries no roles.
