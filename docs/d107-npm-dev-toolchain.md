---
id: d107
type: decision
status: implemented
title: "d107 — the JS dev toolchain is npm devDependencies, locked by package-lock.json"
parent: goal
depends-on: [d041, d051]
references: [d072]
tags: ["tooling", "termux", "npm", "biome", "typescript", "knip", "lockfile"]
---

# d107 — the JS dev toolchain is npm devDependencies

**Status: implemented.** `package.json` + `package-lock.json` own the JS/TS
gate versions; `lib/npm-tools.sh` installs them on demand.

## Problem

The JS/TS gates were installed ad hoc. `lint.sh` called
`mise exec biome@2.6.3` and `mise exec npm:knip@6.43.0`, while
`check-types.sh` installed TypeScript and `@types/node` into an XDG scratch
directory. That is a mise-shaped toolchain. Termux is the repo's other runtime
target and has no mise, so the gates did not exist there; the scratch install
also cannot produce a lockfile, leaving the versions as strings inside
scripts rather than as a reproducible dependency graph.

The facts that force the shape:

- Termux runs ordinary Node and npm (verified on the target host: node
  v24.22.1, npm 12.2.1); mise is what is absent.
- Biome publishes `@biomejs/cli-android-arm64`, and knip's oxc dependencies
  publish Android arm64 bindings. npm is therefore a shared delivery path,
  not a host-only convenience.
- TypeScript 7 is the native compiler and publishes no Android arm64
  binary (`@typescript/typescript-android-arm64` does not exist). Its npm
  launcher resolves a platform package and throws on Termux. TypeScript
  6.0.3 is the last stable pure-JavaScript release and runs wherever Node
  runs.

## Decision

- The root `package.json` carries `devDependencies` for exactly the JS/TS
  gates: `@biomejs/biome`, `knip`, `typescript`, and `@types/node`. The
  package stays private and has no runtime dependencies; it is not a
  published package.
- `package-lock.json` is tracked and is the single version source. `npm ci`
  is the only install path used by the gates.
- `lib/npm-tools.sh` installs the pinned tree on demand. Its stamp is
  `cksum(package-lock.json)` stored under `node_modules`, so a lock change
  reinstalls by construction and an unchanged lock is a no-op. It runs
  `npm ci --ignore-scripts --include=dev`: the gate executes no package
  lifecycle code, and a `NODE_ENV=production` environment cannot silently
  omit the tools.
- `lint.sh` and `check-types.sh` call the local `node_modules/.bin` tools.
  They no longer provision biome, knip, or tsc through mise.
- Shellcheck, jq, and shfmt are not npm packages. They keep the existing
  delivery split: `mise exec <tool>@latest` on hosts that have mise, or the
  host package manager on Termux/mise-less hosts (`pkg install shellcheck
  jq shfmt` on Termux). This record does not pretend those versions are
  locked.
- TypeScript is pinned to 6.0.3, not 7.x, until the native compiler ships
  an Android arm64 binary. `@types/node` tracks the Node 24 runtime.
- `node_modules/` is ignored; the tracked artifact is the lockfile.

## Consequences

- Termux gets the same JS gate versions as every other host from the same
  lockfile. The Android Biome/oxc optional packages are recorded even when
  the lock is generated on Linux, so `npm ci` selects them by `os`/`cpu`.
- `./lint.sh` and `./check-types.sh` still need network on first run (as
  `mise exec` did) and now create an in-tree `node_modules`; later runs are
  reproducible from the lock without network.
- The installed tree is roughly 136 MB on x86-64 (Biome about 84 MB,
  TypeScript about 24 MB). Termux pays a comparable native-binary cost;
  hosts that only type-check can reuse the same one-time install.
- TypeScript 7's missing Android binary is now a recorded reason, not a
  surprise when a Termux user runs `check-types.sh`. Revisit the pin when
  `@typescript/typescript-android-arm64` appears.
- The root package is no longer dependency-free. The old tsconfig comment
  claiming knip required that is removed; knip runs clean with the
  devDependencies declared because the npm scripts name the binaries.
- Shell tool versions remain floating (`@latest`/pkg). Locking those would
  need a different mechanism; npm cannot supply them.

## Alternatives rejected

- **Keep mise-only.** It leaves Termux unable to run the JS gates and keeps
  versions as script strings with no dependency graph.
- **Add a root `mise.toml` and lock that.** It would re-pin bare `node` for
  anyone entering the tree — the reason the pin lives in `lib/node-run.sh`
  rather than a root `mise.toml` (d051, `estige/CI.md`) — and mise is still
  absent on Termux.
- **Use `npm exec --package=...` ad hoc.** It resolves versions at run time
  and never consults a committed lockfile, which is the drift this record
  removes.
- **Pin TypeScript 7 and require a glibc/proot layer on Termux.** The
  native binary is not an Android/bionic build; adding a compatibility
  layer to run a type checker is a bigger dependency than the checker.
- **npm wrappers for shellcheck/shfmt.** They download or wrap host
  binaries and do not make the tools more native on Termux; `pkg` already
  supplies them.

## Verification status

- On x86-64 Linux with node 24.22.2 / npm 11.19.1: `npm ci`, local
  `biome lint . --error-on-warnings` (290 files), local `knip`, and local
  `tsc -p tsconfig.json` all exit 0.
- `npm ci --os=android --cpu=arm64 --ignore-scripts` on Linux selected
  `@biomejs/cli-android-arm64` (static aarch64 ELF),
  `@oxc-parser/binding-android-arm64`, and
  `@oxc-resolver/binding-android-arm64` (NDK-built `.node` files), with no
  `@typescript/*` platform package. That is the selection Termux needs;
  the packages are recorded in the lock, not rescued at install time.
- Termux itself was not executed in this change. The first Termux run must
  confirm the install on the target (node v24.22.1 / npm 12.2.1).
