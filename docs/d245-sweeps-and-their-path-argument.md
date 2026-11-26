---
id: d245
type: architecture-design
status: active
title: "d245 — the repo-wide sweeps are POSIX entries, and only two of them take a path"
parent: architecture
depends-on: [d113, d139]
references: [d107, d122, d226, d243, d244]
tags: ["gates", "entrypoints", "shell", "paths", "toolchain"]
---

# d245 — the repo-wide sweeps are POSIX entries, and only two take a path

An audit of the three repo-wide sweeps and the type-check entry, and of what a
`[path]` argument could mean for each. It settles how a sweep is scoped, and
records the two alternatives this tree does not take: inlining the shared
helpers, and folding the gates into a `uv run` python orchestrator.

## Problem

The gate entries each take an optional directory, and each used `cd "$root"`
before its legs. A leg whose input is a _repo-level_ fact then breaks: `tsc -p
tsconfig.json` after `cd`ing to a swept folder aborts with
`TS5058: The specified path does not exist`, and the type-aware lint leg's
install and the spec-graph leg had the same shape (d243 records the two already
fixed). Review kept finding the next instance, because the invariant rather than
any one file was wrong.

The audit, measured rather than assumed:

| entry                          | takes         | self-locating?              | repo-relative work after the `cd`        |
| ------------------------------ | ------------- | --------------------------- | ---------------------------------------- |
| `lint.sh`                      | `[path]`      | no — cds to the argument    | yes, fixed in d243                       |
| `check-types.sh`               | `[path]`      | no — cds to the argument    | `tsc -p tsconfig.json` (the last break)  |
| `test.sh`                      | nothing       | yes — cds to its own folder | none                                     |
| `freshness.sh`                 | `[--quiet]`   | yes — cds to its own folder | none                                     |
| `re-chown.sh`, `re-selinux.sh` | a target path | not applicable              | the path is what gets chowned/relabelled |

## Decision

**R1 — A sweep's scope is its own folder, not a caller's directory.** `test.sh`
and `freshness.sh` already work this way and need no change: they `cd` to the
directory that holds them, so no argument can move them. Their contract is "run
from anywhere", and that is the contract every entry here shares.

**R2 — An entry with no meaning beyond the repo root does not accept a path.**
`check-types.sh` is that entry: `tsc -p` checks the program `tsconfig.json`
lists, so a swept directory could only ever have changed the cwd — it never
scoped a check. The argument is deleted, the project is named absolutely
(`-p "$repo_root/tsconfig.json"`), and an argument is now a usage error with the
reason, not a silent no-op. Install-and-probe stay: that is d107's one install
path, and it is why the file exists at all.

**R3 — An entry whose `[path]` really scopes work keeps it, and anchors the
repo-level inputs itself.** `lint.sh`'s `[path]` runs the per-file legs over a
subtree, which is genuinely useful, so it stays — with the python legs anchored
at `$repo_root`, the spec-graph leg naming its script absolutely and passing the
tree root, and the npm/pnpm installers resolving their own directory at source
time (d243).

**R4 — The shared helpers are not inlined.** `log.sh`, `npm-tools.sh` and
`dev-tools.sh` are the one logger, the one install path and the one pin table
(d107, d139). Copying their contents into each sweep would put a second copy of
a version pin in three files — the drift class d138/d139 exist to prevent — to
save a `source` line whose path is now resolved at source time.

**R5 — A count that tracks a growing family is written as a rule.** "Six",
"seven" and "eight" had already disagreed across `check-types.sh`,
`dev-tools.sh` and `.gitignore` while the real number was eight. Those three
sites now state the rule (`one store, one lockfile per folder`, "each folder's
node_modules") and name no total, so adding a provider cannot make them wrong.

## Consequences

- **`check-types.sh` can no longer be scoped, and no caller wanted that.**
  Every documented invocation is argument-free; the only thing the argument ever
  did was break the config lookup.
- **Two entries are path-taking (`lint.sh`) or target-taking (`re-chown.sh`,
  `re-selinux.sh`); the rest are "from any directory".** The distinction is now
  written down rather than rediscovered per review.
- **The python gate's environment stays a repo-root fact.** `uv sync` runs there
  and `ty` is handed an absolute interpreter and search paths, which is also
  what makes the sweeps reasonable to run from a foreign cwd.
- **The counts stopped moving.** Deleting a provider no longer implies editing
  three comments that were already out of step.

## Alternatives rejected

- **Inline the helpers into each sweep.** Three copies of the install logic and
  the pin table, in files that already had to be kept in step by hand — the
  duplication d107 and d139 were written to end.
- **Fold the sweeps into one `uv run` python orchestrator.** uv is the neatest
  runtime story this tree has (d226 lists it as runtime-and-dev), and a python
  entry would remove the shell sourcing entirely. It was rejected on three
  measured facts: every leg is a process invocation across four toolchains, so
  the orchestrator would add a runtime edge without deleting a leg; the gates are
  offline by contract (d122) and a resolver on the gate's path is one more thing
  that can want the network; and the shell entries are what a host without the
  repo's python toolchain can still run. The option is the fallback if the entry
  count or the per-leg glue grows past what sh names clearly, not a win today.
- **Keep `[path]` on `check-types.sh` and anchor `tsconfig.json`.** It would
  "work" while meaning nothing — a flag that silently checks the whole program
  no matter what it is handed is worse than no flag.
- **Drop `[path]` from `lint.sh` for symmetry.** The per-file legs do scope
  correctly, and losing that would make a one-folder sweep impossible for the
  sake of a uniform signature.

## Verification status

- `./check-types.sh` from the repo root and from a subdirectory → exit 0 both
  ways, one `tsc` run over the program `tsconfig.json` lists.
- `./check-types.sh docs` → exit 2 with the usage error and its reason (before:
  exit 1, `TS5058`).
- `./lint.sh` and `./lint.sh docs` → exit 0; `./test.sh` and `./freshness.sh
  --help` behave as before.
- `grep -rn 'cd "\$' --include='*.sh'` → the only caller-path `cd`s are
  `lint.sh:37`; `test.sh`, `freshness.sh` and the unit scripts cd to their own
  folder.
- `ls pi-*/pnpm-lock.yaml | wc -l` → 8; no non-doc file states a total any more.
