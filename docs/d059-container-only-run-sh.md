---
id: d059
type: architecture-design
status: implemented
title: "d059 — coding-agent/run.sh goes container-only; the sandbox-free run path is lib/environment.sh <command>"
parent: architecture
depends-on: [d041, d046, d054, d056]
references: [d018, d030, d041, d043, d046, d051, d054, d056]
tags: [runner, env-chain, termux, dx]
---

# d059 — `coding-agent/run.sh` goes container-only

**Status:** implemented

## Problem

`coding-agent/run.sh` claimed to serve two hosts — "container hosts AND
Termux" — but after d041/d043/d054/d056 the Termux branch had been reduced to
three lines of behaviour:

1. default `PI_CODING_AGENT_DIR` to `$HOME/.pi/agent` (pi's own documented
   default — docs/environment-variables, so the default was never load-bearing),
2. refuse when `models.json` is absent (the d041 "runners never generate"
   gate),
3. `cd` the workdir and `exec pi`.

Everything the two branches actually share — vault resolution, the plain-env
contract, pi's env vars — already lives in `lib/environment.sh` (d046), and
everything that differs between hosts already lives in the generator's
detection profile (`coding-agent/generate.mjs`), not in the runner. So the
branch bought very little and cost a great deal of surface:

- the header documented two launch models, two `$HOME` policies and a
  `DIRECTORY` list whose extra entries the Termux branch silently ignored;
- `generate.mjs`'s `@fileoverview` justified the container-only committed
  snapshot refresh by citing "run.sh's Termux branch" — a rationale that
  only existed because the runner was dual-mode;
- d056's decisions were written as "uniform across the container and Termux
  branches", a uniformity that would have to be re-proved on every change;
- a host with **no** podman/docker did not fail fast: it fell through to
  `workload_run`'s backend check, i.e. *after* the stage dir, launch chain and
  mount manifest had been assembled.

The blocker to dropping the branch was that `lib/environment.sh` could only
spawn a **file** ("target script not found", exit 91), so there was no
replacement path for "run pi unsandboxed, with the vault env".

## Decision

1. **`coding-agent/run.sh` is container-only.** The `PREFIX`/`_termux` case
   and the whole Termux block are deleted; the header now says so and points
   at the replacement. A guard directly after sourcing
   `lib/workload-runtime.sh` exits 91 when `_workload != 'workload'` — before
   any staging, instead of at `workload_run` — and names the sandbox-free
   path in its message.
2. **`lib/environment.sh` accepts a command, not just a script.** The target
   is resolved as a file relative to the caller's cwd; failing that, as a
   command on `PATH`. `./lib/environment.sh pi` is therefore the whole
   sandbox-free run path: same chain, same exit codes, same "consumers read
   plain env" contract, and no second copy of pi's launch logic in the repo.
3. **Two binary-resolution fixes found while enabling (2)** — both would have
   made the new path fail *after* target resolution, which is exactly where a
   regression here hides:
   - the mise fallback execs `infisical` **explicitly**
     (`mise x infisical@latest -- infisical "$@"`): `mise x tool -- cmd`
     execs `cmd` with the tool env, so the previous bare `run` subcommand was
     looked up as a *program* and died with "couldn't exec process";
   - a `PATH` hit counts as the CLI only if it **executes**
     (`infisical --version`): a mise shim answers `command -v` yet dies with
     "No version is set for shim" when the tool has no default version, so an
     unusable hit now falls through to the mise wrap instead of breaking the
     vault round-trip.

## Tradeoffs accepted

- **The `models.json` loud-failure gate no longer guards the direct path.**
  On a container host the runner still refuses a missing artifact and points
  at the generator (d041); `./lib/environment.sh pi` with an ungenerated
  agent dir now surfaces as pi's own failure. The rule "runners never
  generate" is unchanged — only who reports the violation.
- **`run.sh`'s `$HOME`-as-workdir refusal and multi-`DIRECTORY` handling are
  gone on Termux.** Direct pi takes the caller's cwd like any other command;
  there is no mount boundary to police and no extra directories to pass
  (pi's own config owns its context).
- **Backend-less hosts get the verdict earlier.** The failure is now exit 91
  at the top of `run.sh` with no workload description in the output, where
  `workload_run` used to fail later (after staging) with the backend detail.

## What was NOT removed

- **Generation keeps its Termux profile**: `coding-agent/generate.mjs` still
  branches on Termux (system node, vendored models.dev catalog, opencode
  skip), `lib/provision-termux.sh` and the Termux node policy are untouched.
  The *runner* is container-only, not the generator.
- **`llm-reverse-proxy/run.sh`'s native Termux branch** is a separate runner
  with its own record (`docs/environments-and-peer-variants.md`) and stays.
- **The container-native launcher itself**: no change to mounts, staging,
  `workload_env` forwarding, or the d054 `auth.json` gate.

## Mechanical changes

| File | Change |
|------|--------|
| `coding-agent/run.sh` | Termux case/block deleted; header rewritten (container-only + the `environment.sh pi` pointer); fail-fast `_workload` guard after sourcing `lib/workload-runtime.sh` |
| `lib/environment.sh` | target = file **or** `PATH` command; usage + exit-91 message updated; `_vault_exec` names `infisical` in the mise wrap; PATH hit gated on actually executing |
| `coding-agent/generate.mjs` | `@fileoverview` no longer cites run.sh's Termux branch for the container-only committed-snapshot refresh (the reason is now "no Termux runner consumes the committed copy") |
| `coding-agent/DESIGN.md` | `run.sh` paragraph states container-only; the runtime profile paragraph is labelled a *generation* profile |
| `README.md` | env-chain prose documents `./lib/environment.sh pi`; folder rows for `environment.sh`/`coding-agent/run.sh`; index rows for d058 (missed then) and d059 |
| `docs/container-tooling.md` | pre-existing staleness fixed while touching the runner story: `run.sh` no longer bind-mounts `lib/workload-*.jq` into `/opt/lib` — filters render host-side (`workload_JQDIR` = `$REPO_ROOT/lib`), and d056 removed those mounts |
| `docs/d046`, `docs/d056` | status-line forward pointers to this record |

## Superseded mentions

Living wording edited in place: the d056 "uniform across the container and
Termux branches" / "Termux has no mount boundary" decisions (covered by its
new status pointer), README's runner rows, `coding-agent/DESIGN.md`, and the
two `generate.mjs` rationale comments. Historical records — d018, d030's
branch description, `docs/termux-build-audit.md` — keep their bodies: they
record what was true when written.

## Verification

- `./coding-agent/run.sh` on a host with neither podman nor docker →
  `exit 91` with the backend message *and* `./lib/environment.sh pi`
  pointer, before any staging (no `~/…` workspace created).
- `./lib/environment.sh not-a-thing` → `exit 91` ("not a file and not on
  PATH"); `./lib/environment.sh pi --version` resolves the pi binary first
  (no vault round-trip is spent on a bad target) and then reaches
  `infisical run`, stopping only at "No valid login session found" on this
  machine — d046's known no-session gap, not a chain failure.
- `./lint.sh` (shellcheck `-x`, shfmt, jq compile gate), `./check-types.sh`,
  `node --test` (25/25) all green.
