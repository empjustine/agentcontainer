---
id: d243
type: architecture-design
status: active
title: "d243 — a dev-tool pin is the version the Termux host ships, or the newest mise can fetch"
parent: architecture
depends-on: [d139]
references: [d107, d137, d226, d244]
tags: ["toolchain", "pins", "termux", "mise", "npm", "reproducibility"]
---

# d243 — a dev-tool pin is the version the Termux host ships

A pin's value is a fact about the whole tree, not about the machine that ran the
install. This record sets how that value is chosen: from what the second target
host already runs.

## Problem

`./dev-tools.sh` (d139) is the one pin table, and on a mise-less host — Termux,
this repo's second runtime target (d051, d082) — its `none` profile installs
nothing: the host package that happens to be there is what runs. So a pin is
authoritative on dev hosts and advisory on Termux, and where the two disagree
the gate's verdict is a property of the machine:

| tool       | dev-host pin                 | Termux host package          |
| ---------- | ---------------------------- | ---------------------------- |
| oxfmt      | 0.75.0                       | 0.80.0                       |
| pnpm       | 12.21.0                      | 12.23.0                      |
| maven      | 3.9.16                       | 3.10.2                       |
| biome lock | 2.6.3 (what both hosts run)  | 2.6.9 (host package, unused) |
| oxlint     | 1.90.0 (+ tsgolint 7.0.2005) | 1.95.0 (Android fallback)    |

`oxfmt --check` is the sharpest case: the formatter that decides whether the
tree's markdown is canonical differed by five minor versions between the two
hosts, so "the tree is canonical" was true of one machine and false of the other
without an edit in between. The floats made it worse — `@latest` resolves to
whatever a host's install date offered, so two dev hosts diverge from each other
as well as from Termux.

## Decision

**R1 — A pin's value is what the Termux host package ships.** Both hosts run one
environment; a tool version that differs between them is a gate whose meaning
differs between them. Measured, not assumed (`pkg list-installed` / `--version`
on the target host).

**R2 — Where mise's registry lags that version, the pin is mise's newest, and
the skew is named beside the pin.** `mise exec` cannot install a version its
registry does not list, so the ceiling is a hard constraint; the comment records
both numbers and the date they were measured, so the next bump is a re-measure
rather than a guess. `uv` and `ty` sit one patch/minor behind Termux this way,
and `oxfmt` one minor (0.79.0 against 0.80.0).

**R3 — A tool whose output is a gate's verdict is pinned exactly; only a tool
that merely joins output may float.** This is d137's rule applied to the six
floats d139/d107 inherited: `shellcheck`, `shfmt`, `ruff`, `uv` and `ty` stop
floating, `jq` keeps `@latest` because it formats a pipe, not a verdict. Termux
reports its `shfmt` as a `(devel)` build with no version to match, so that pin
states what the dev hosts run and nothing more.

**R4 — The npm lockfile is a version source under the same rule.** `package.json`

- `package-lock.json` (d107) own the JS gates, and the host packages are only an
  Android fallback, so the lock moves when the host's version is what "unified"
  means: `@biomejs/biome` 2.6.9, `oxlint` 1.95.0, `oxlint-tsgolint` 7.0.2008 (1.95's
  peer floor; 7.0.2009 was inside the release-age window — see Consequences).

**R5 — The pin table stays one table.** d139's placement rule is untouched: a
version is written in `dev_tools_pin` or in the lockfile, never in a second
place. Callers that named a number inline now read the table instead —
`lint.sh`'s oxfmt fix hint and `docs/docs/refresh.sh`'s vendored-reformat version
both call `dev_tool_pin oxfmt`, because a second copy of a pin is the drift this
whole record is about.

## Consequences

- **The oxfmt bump cost no reformat.** 0.79.0 reports every tracked markdown
  file already canonical at the time of the bump, so the version moved without a
  tree-wide diff. The file count is not a fixture: the tree the measurement ran
  on held 1455 markdown files before these records landed.
- **The oxlint bump exposed a gate that was not gating.** `oxlint . -D warning`
  reads as a severity floor and is not one: `-D`/`--deny` names a _rule_, so the
  command asked for a rule called "warning" and gated nothing (a warning-level
  finding exits 0 under it on 1.95.0, and 1 under `--deny-warnings`). Both lint
  branches now use `--deny-warnings`, the old flag is deleted rather than kept
  beside the real one, and the negative control is part of the bump's
  verification.
- **The biome bump implemented a rule the config already enabled.**
  `lint/complexity/useWhile` is an explicit `error` in `biome.jsonc`; 2.6.3 did
  not flag `for (;;)`, 2.6.9 does. One loop in `git/lib/git-core.mjs` became
  `while (true)` — the config did not move, the implementation caught up.
- **The lock could not be bumped under a 3-day cooldown.** `@biomejs/biome`
  2.6.9 (published 2026-11-24) and `oxlint` 1.95.0 (2026-11-23) were younger
  than the host's `npm_config_min_release_age=3`, which refuses to resolve them.
  The window is a real supply-chain control (dotfiles DR-005, not this repo's
  decision), so the fix was to move the default to 1 day in the dotfiles tree and
  commit it there, not to bypass it for one command.
- **Two oxlint warnings exposed a gate-order defect, fixed here.** The
  `typescript/no-redundant-type-constituents` findings on the `pi-*` packages
  were the imported `ProviderConfig` resolving to `any` because `pnpm install`
  had not run, not code defects — absent once installed. With `--deny-warnings`
  gating for the first time, that made `./lint.sh` fail on a fresh checkout while
  passing on one where `./check-types.sh` had run, so the verdict was a fact
  about the checkout's history rather than the code. `lint.sh` now calls
  `pnpm_tools_ensure` before the type-aware oxlint leg: the leg acquires the
  types its rules read instead of reporting their absence.
- **Termux's own version remains whatever `pkg` ships.** The pin cannot bind it;
  what this record buys is that the next divergence is one measurable fact with
  a date instead of a silent difference in what the two hosts call canonical.

## Verification status

- `mise ls-remote` ceilings measured 2026-11-26: oxfmt 0.79.0, uv 0.13.9,
  ty 0.0.108, pnpm 12.23.0, maven 3.10.2, shellcheck 0.11.0, shfmt 3.14.1.
- `oxfmt@0.79.0 --check '**/*.md'` → every tracked markdown file canonical, 1457 at measurement (0.75.0: same).
- `npm ci` against the re-locked tree, then `biome lint . --error-on-warnings`
  and `oxlint . --deny-warnings` → clean; `oxlint probe -W <rule>
  --deny-warnings` → exit 1 (the negative control that `-D warning` failed).
- `./check-types.sh` → clean, with all eight `pi-*` folders installed by
  `pnpm 12.23.0 --frozen-lockfile`.
- Fresh-checkout gate order: `rm -rf pi-*/node_modules` then `./lint.sh` →
  exit 0, installing eight `pi-*` type trees first and reporting no
  `no-redundant-type-constituents` findings (the same command exited 1 before
  the `pnpm_tools_ensure` call was added).
- Full `./lint.sh` run recorded in the change; the Maven leg runs 3.10.2.

## Alternatives rejected

- **Lower the Termux packages to the pins.** There is no version to select
  there: the host's package manager owns them, which is the premise of d139's
  `none` profile.
- **Keep `@latest` and accept the drift.** The floats resolve at install time,
  so two dev hosts disagree after a week apart — the failure mode this record
  exists to remove, not a cheaper version of it.
- **Move oxfmt into the npm lockfile now.** It is installable that way
  (`@oxfmt/binding-android-arm64` exists) and would bind both hosts to one
  version; that is the toolchain path d244 investigates, and it is deliberately
  not part of a pin bump.
- **Keep the 3-day cooldown and land the lock later.** It leaves the two hosts
  disagreeing on every JS gate until an unrelated follow-up, which is worse than
  narrowing a host-level supply-chain window with the owner's consent.
