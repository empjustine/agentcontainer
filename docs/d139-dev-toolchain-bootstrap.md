---
id: d139
type: architecture-design
status: active
title: "d139 — one dev-toolchain bootstrap: mise on a dev host, never at runtime"
parent: architecture
depends-on: [d051, d082, d107, d123, d137]
references: [d122, d045]
tags: [toolchain, mise, termux, gates, maintainability]
---

# d139 — one dev-toolchain bootstrap

## Problem

Three acquisition paths had grown for the same question — _where does a non-npm
gate tool come from?_

- `lint.sh` pinned versions inline (`mise exec golangci-lint@2.15.0`,
  `OXFMT_VERSION=0.75.0`) and called `mise exec` per leg, which auto-installs a
  missing tool. That behaviour was never written down: the script read as if it
  merely _ran_ the tools.
- `test.sh` carried its own three-step `go` probe (`mise where go`, the shims
  dir, `command -v`) and, by design (d123), **never** acquired anything: a dev
  host with no Go installed got a skip and a hint, so the Go suite silently did
  not run where it easily could have. The asymmetry was invisible unless you read
  both files side by side.
- the environment question kept landing on `mise.toml`, which this repo
  deliberately does not commit (d051/d082/d137), so every answer lived in prose.

A host that had mise but no Go therefore under-tested; a host that had neither
had to be told twice how to get the tools; and a version bump meant editing a
pin in a script whose own header said the pin was somewhere else.

## Decision

**One file decides, one file lists the pins: `./dev-tools.sh`.**

- **One pin table.** `dev_tool_pin` is the only place a mise-delivered tool's
  version is written. Pinned (golangci-lint, oxfmt, go) versus floated
  (`shellcheck`, `shfmt`, `jq`, `ruff`, `uv`, `ty` at `@latest`) keeps the
  posture d107/d137 set: a tool whose output _is_ the gate's meaning is pinned.
- **One acquisition path.** `dev_tool_run <tool> <command> [args]` runs the
  command with the pinned tool provided; `dev_tool_bin` hands back a real binary
  path for callers that must exec it directly (golangci-lint, whose child `go
  list` would otherwise hit the version-less mise shim); `dev_tool_ensure` is the
  installer. `./dev-tools.sh` with no arguments installs the whole profile, so
  the documented first step on a fresh dev host is one command.
- **The environment decides, not the config file.** `DEV_TOOLS_PROFILE` is
  `full` on a host with mise and `none` on Termux or a mise-less host — the two
  the repo actually has — and either can be forced. `none` means _acquire
  nothing_: the host's own binaries are used if present, and a missing one is a
  fatal, explained error rather than a silent skip.
- **The sweeps source it.** `lint.sh` and `test.sh` name a tool, never a way to
  obtain it. `test.sh`'s Go leg now acquires the pinned `go` exactly as the lint
  legs always did, which supersedes d123's "a sweep never downloads one": the
  sentence was correct for the probe it described and wrong for the sweep's job.
- **No committed `mise.toml`, and `.gitignore` now says so.** A root file would
  re-pin bare `node`/`go` for every process entering the tree (d051/d082/d137);
  a developer's harness that writes one into the checkout is now ignored instead
  of showing up as untracked dirt.

## Why mise cannot answer this, and a program must

mise's per-tool filters are `os` and `arch`. The distinction this repo needs is
different in kind: _is this a host I install toolchains on, or a runtime box
(Termux, a sandbox, a minimal VM) that must not be mutated by a dev
convenience?_ RAM and disk do not even enter it — a gate needs the same bytes on
a 32 GB workstation as on a small VM; what differs is whether installing them is
allowed at all. That is a fact only a running program can read (`PREFIX`, the
presence of `mise`), so `dev_tools_profile` reads it, and `mise.toml` stays out
of the tree.

## Alternatives rejected

- **A committed `mise.toml` with `os`/`arch` filters.** It re-pins bare
  `node`/`go` for anything entering the tree, it cannot express "dev host", and
  Termux has no mise to read it. The filters would encode the wrong axis.
- **`mise.toml` for the dev stack, `DEV_TOOLS_PROFILE` as an escape hatch.** Two
  sources of truth for a pin, and the file wins silently for anyone who runs a
  bare `go`/`node` in the checkout.
- **Keep the skip-and-hint in `test.sh`.** It is what let a dev host run a sweep
  that never touched `estige/`'s Go suite and call it green.
- **Install from inside each gate, with the version written there.** That is the
  state that produced the problem: two sweeps, two probes, version strings in
  three files.
- **Make `test.sh` require Go.** A laptop, a Termux box and a docs-only edit all
  deserve the sweep; the leg may skip, but it must skip _loudly_ and only where
  acquisition is genuinely unavailable.

## Consequences

- `test.sh` and `lint.sh` lose about 40 lines of duplicated probe and pin code.
- On a mise host the first sweep after a pin bump installs once (network), then
  is offline again — the d107 consequence, unchanged, now true for Go as well.
- `DEV_TOOLS_PROFILE=none` is the supported way to ask for "acquire nothing"
  (a locked-down CI box); it turns the Go leg into the loud skip rather than a
  failure.
- The pins moved out of `lint.sh`, which supersedes d137's _Pinning_ placement
  sentence by name; d137's reasoning (a linter's rule set **is** the gate) is
  unchanged and is what the pinned-versus-floated split still encodes.

## Verification status

- `./dev-tools.sh` on this host (mise, Linux x86_64): profile `full`, installs
  the nine tools, no-op when they are present.
- `DEV_TOOLS_PROFILE=none ./dev-tools.sh`: profile `none`, installs nothing,
  exits 0 — the Termux/restrictive behaviour.
- `./test.sh` with the toolchain present runs `ok estige`; `./lint.sh` runs
  golangci-lint to `0 issues.`
- `shellcheck -x dev-tools.sh lint.sh test.sh` clean; markdown gate clean.
