---
id: d228
type: architecture-design
status: active
title: "d228 — a path check is not a decision: the act reports its own ENOENT"
parent: architecture
depends-on: [d023, d050, d113, d121, d166, d225]
references: [d063, d070, d207, d227]
tags: [filesystem, errors, races, artifacts, guards, inventory]
---

# d228 — a path check is not a decision

**Status: landed for the sites the inventory names.** Every guard whose only
job was to authorize a later act is gone from the Node, Python, shell and Java
code of this tree. The probes that remain are listed under "What still probes"
with the reason each stays.

## Problem

A guard of the shape `if (exists(p)) act(p)` costs two things, and the race is
the smaller one.

**It describes a moment, then acts on it.** The test and the act are separate
syscalls; a rotation, a tmp cleaner, a concurrent generation or an operator's
`rm` between them makes the answer false. Nothing the second syscall can do
recovers the first — the window is in the contract, not in the length of the
code between the two lines.

**It throws away the errno.** `existsSync` answers one bit, so a file that is
present but unreadable (EACCES, EISDIR, ELOOP, ENOTDIR) reads as ABSENT. The
caller's "absent" branch is a fallback — keep the stale copy, log one line,
continue — so the guard turns a failure the operator must fix into a report that
the run succeeded:

- `coding-agent/generate.mjs` installed `settings.json`/`mcp.json` only when
  the committed source "existed", and kept the agent dir's stale copy when it
  could not be read, at the same error level as a genuinely missing input.
- `llm-local-inference/30-generate.mjs` reported an unreadable
  `lib/cache-scope.json` as "missing", pointing at the commit rather than at
  permissions.
- `llm-local-inference/40-download-models.py` globbed the curated dir: a
  directory that is gone yields the empty list, so "every manifest was pruned"
  and "nothing is here" provisioned nothing and reported success.

Four guards were dead as well as racy — they repeated what the act already
reports. `git/lib/farm-lock.mjs` tested the status file before a read whose
`catch` already answered "no description"; `clearLockStatus` tested before
`rmSync(..., { force: true })`, whose `force` answers ENOENT by definition;
`git/migrate-to-bare.mjs` tested the target before the same force-remove;
`datalakehouse` tested a pid file before a substitution written to tolerate its
absence.

## Decision

**R1 — An existence test never authorizes a later act.** The act is asked, and
its own errno is the answer: a read answers ENOENT, a copy answers ENOENT, an
`rm` with `force` answers nothing, an open answers NoSuchFileException.

**R2 — "Absent" is a classification, not a boolean.** The caller that must branch
distinguishes ENOENT from every other errno, because "not there" and "not
readable" lead to different reports and only one of them means "keep what you
have". A helper that collapses them is a guard under another name.

**R3 — A query that cannot distinguish absence from emptiness is not an answer.**
A glob or `readdir` over a path that is gone yields the empty set; the same call
reports ENOENT when it is asked in the form that raises (`os.listdir`,
`readdirSync`, `Files.list`). The query is chosen for the answer it can give,
not for its brevity.

**R4 — A check whose ANSWER is the data stays.** "Which mirror is held?",
"which snapshot is complete?", "which backend does this host have?" are results,
not permissions: they are reported, and the act that consumes them is elsewhere
and reports its own failure. The farm's lock probe is this shape by
construction (d121: probe the truth, not a file's existence).

**R5 — An irreversible act keeps exactly ONE refusal immediately before it.**
EAFP has no undo. Where the act is `rm -rf`, a clone over an existing mirror or
a truncate, the refusal is the only place the decision can live — so it stays,
and a second check of the same path later in the same function is deleted (it
answers a question whose answer has already been promised to the operator).

**R6 — One handle, one answer.** Where an act needs both a measurement and a
write to the same file, one open handle supplies both. Sizing a path and then
appending to it by path is two files as soon as a rotation renames one.

**R7 — A behaviour change from a removed guard is reported, not absorbed.** R2
makes an unreadable input abort the step that owns it where the guard kept a
stale copy; the record and the commit message name the change.

The same reasoning reaches past paths, and past one syscall. A step that changes
live state in several acts has a window between them exactly like the guard has
between its test and its act — and where the guard could at least be argued
about, a half-applied change cannot. Four rules follow (d023 is the artifact half
of them; these are the step-level half).

**R8 — Prepare off to the side; commit by rename.** A step that can still fail
produces nothing a later run would read as current. Build in a per-run
directory, a scratch path or a sibling, and let the publish — one `rename` per
artifact — be the act that makes the result official. `writeArtifact` is the
mechanism the committed artifacts already share; what R8 adds is where the CALL
sits: after every prerequisite has succeeded, not at the top of the step.

**R9 — A commit sequence has an order, and each element is atomic.**
Interrupted between two installs, the tree keeps the previous state usable.
Nothing is installed before the last step that can abort, and the artifact that
makes the new state coherent is the last rename: a half-committed set reports a
failure the operator cannot act on, because which half is live is not visible in
the log.

**R10 — Never destroy the only copy before its replacement exists.** Replace is:
build the successor beside the original, swap, drop the old copy last. `rm`
before `clone` has a window in which the failure is total — the mirror that was
there is gone and the new one never arrives — while the same failure against a
sibling build costs one directory to delete.

**R11 — A rerun is the recovery path.** A crash may leave a `.tmp`, a `.bak-`,
a `.new-<pid>`, an `.old-<pid>` or a `.rm.<pid>` behind; it must not leave
state that the next run reads as history. The litter is a leftover, not a
decision the operator has to make before running again — and litter next to a
farm walk is named with a leading dot, so the walk cannot count it as a mirror.

## What landed

- **`coding-agent/lib/artifact.mjs`** — `readArtifactOrNull` (ENOENT answers
  null, every other errno propagates) and `backupArtifact` (the copy's own
  ENOENT means "nothing to keep") replace the existence tests and three
  hand-rolled `.bak-<stamp>` blocks.
- **`coding-agent/generate.mjs`** — `installSettings`, `installMcp` (source and
  target), `installModels`, the opencode overlay and the committed
  `opencode.json` copy read first; `installModels` takes the text and
  `providersOf` the parsed document, which drops two file re-reads; invalid
  generated JSON reports itself instead of "0 providers".
- **`git/lib/farm-lock.mjs`** — two guards that repeated the act (R1).
- **`git/farm-lock.sh`** — `[ -r "$1.status" ] && cat` becomes the
  substitution's own failure.
- **`git/vbs-mirror-all.mjs`** — "manifest not found" and "manifest unreadable"
  were one answer.
- **`git/forge-mirror.mjs`** — the batch dedupe re-statted a target the same
  run was about to create; a set of planned targets answers it as data.
- **`git/lib/git-core.mjs`** — `requireReadableRoot` is the walk's premise
  proved by the syscall the walk itself needs: `readdir` on the root. The walk
  below it tolerates an unreadable LEVEL, so a root that vanished or was
  unreadable scanned as an empty farm and reported zero clones; both refuse now,
  each caller in its own words. The five root refusals (`audit`,
  `maintain-mirrors`, `local-changes`, `search-references`,
  `migrate-to-bare`) and `local-changes --repo` call it.
- **`git/migrate-to-bare.mjs`** — the `existsSync(target)` in front of the
  `--force` removal skipped a no-op remove (R5's "exactly one"); the removal
  itself is gone, see the transaction list below.
- **`estige/lib/go-build.mjs`** — the mise-shims probe answered the same
  question as the spawn it guarded.
- **`llm-local-inference/30-generate.mjs`** — `refs/main` and the snapshots dir
  scan with try/catch ENOENT; `readScope` separates "missing" from
  "unreadable".
- **`llm-local-inference/20-propose-entries.mjs`** — the repo-manifest read.
- **`llm-local-inference/40-download-models.py`** — `repo_manifest` reads
  first; `curated()` lists with `os.listdir` instead of globbing (R3).
- **`llm-local-inference/_serving_set.py`** — `repo_manifest` reads first.
- **`llm-local-inference/gguf_context_length.py`** — `refs/main` reads first and
  a missing one means "no ref yet"; the snapshot walk below it stays a lookup.
- **`llm-local-bench/bench.mjs`** — `maybeRead` classifies ENOENT instead of
  testing first, so an unreadable step artifact is no longer reported as one the
  step never wrote.
- **`datalakehouse/agent-warehouse-daemon.mjs`** — `seedSeen` takes the
  stream's own ENOENT for a frozen tail rotation already removed.
- **`datalakehouse/agent-warehouse-spool-send.sh`,
  `agent-warehouse-sync.sh`** — the pid read, the tail-freeze `mv` in both
  senders and the dead-letter `grep` ask the act instead of a test in front of
  it: `cat … || true`, `mv … || :`, `grep … 2>/dev/null`.
- **`sbex/.../SessionSpool.java`** — `Append` sized the spool by path and
  truncated it by path, two files whenever rotation renamed one; one channel
  supplies `start` and the truncate (R6). The frozen-tail seed classifies
  NoSuchFileException, and `repairPartialTail` takes size and position from the
  channel it opened.

Four further changes answer R8–R11 rather than R1–R7:

- **`coding-agent/lib/artifact.mjs`** — `copyArtifact` gives a whole-file copy
  the guarantee `writeArtifact` gives a written one: copy to `<to>.tmp`, then
  rename. Its absence behaviour belongs to the copy (R1), so a source that will
  not read leaves the target untouched.
- **`coding-agent/generate.mjs`** — the agent dir is untouched until one commit
  block that runs after every stage that can abort. The settings file is staged
  under the run dir because the pi generator reads a path rather than an
  install, the default-model overlay merges into that stage, and the opencode
  overlay is generated before anything is installed. The commit order is models
  → mcp → opencode → settings, settings last because it names the default
  provider the models install just made current (R9). `refreshCommittedSnapshot`
  copies through `copyArtifact`, so the snapshot a later run seeds from is never
  a torn file.
- **`git/migrate-to-bare.mjs`** — `--force` no longer removes the target before
  cloning. The successor is built as `.<name>.new-<pid>` beside it, verified
  there (bare, HEAD, `fsck`), and published by rename; an occupied target moves
  to `.<name>.old-<pid>` first and is dropped only once the new mirror stands.
  A failed clone or a failed `fsck` leaves the previous mirror in place, and a
  rerun restores an aside a crash left between the two renames instead of
  building over a gap (R10, R11). The leading dot keeps the walk from counting
  either name as a mirror.
- **`codemode2/enumerate.mjs`** — the canonical taxonomy is written through
  tmp+rename. It was the tree's only writer of live state that bypassed the
  artifact helpers; the other raw `writeFileSync` calls are inside the artifact
  writers themselves or inside fixture text.

## What still probes

Each line is a reason, not an oversight.

**The check is the answer (R4).** `git/forge-mirror.mjs`'s fresh/existing
split, which decides clone-versus-align for the whole batch before the first
clone; `git/lib/farm-posture.mjs`'s and
`git/farm-aliases.mjs`'s `statSync`-`isDirectory`/`isFile`/`isSymbolicLink`
classifiers; `git/vbs-mirror-all.mjs`'s `isDirectory`; `git/audit.mjs`'s shallow
probe; `llm-local-inference/30-generate.mjs`'s snapshot-completeness filter,
which decides which container path to bake; `coding-agent/lib/workload-runtime.mjs`'s
`findOnPath` (X_OK) and its injected `Host.exists` port, whose callers in
`run.mjs` report what they found; the `/usr/bin/podman`, `/usr/bin/docker` and
`/dev/kfd` device probes in the three `host-capabilities.mjs` copies and
`llm-local-inference/run.py`; `llm-local-inference/gguf_context_length.py`'s
cached-file lookup, whose answer is the path to hand back;
`coding-agent/run.mjs`'s credential-warning filter;
`datalakehouse/atuin-warehouse-sync.sh`'s `atuin_config_file`,
`atuin_data_dir` and `resolve_source`, which compute the db atuin itself would
use; `agent-warehouse-sync.sh`'s worktree-versus-session classifier;
`environment.sh`'s file-or-PATH target resolution and its `-x` binary search;
the `[ -f x ] || continue` loops over a discovered list in `test.sh`,
`lint.sh`, `freshness.sh` and the datalakehouse senders.

**A message, not an act.** `git/forge-mirror.mjs`'s `--align` target,
`git/search-references.mjs`'s index dir, `llm-local-inference/50-verify-cache.py`,
`60-audit-snapshots.py` and `70-prune-cache.py`'s root,
`llm-local-inference/run.py`'s config dir and layer, `provision-termux.sh`'s
source, `npm-run.sh` and `npm-tools.sh`'s package and lockfile checks: each
names the fix ("clone it, do not align it", "run index first") and the act below
already handles its own failure.

**An irreversible act (R5).** `git/migrate-to-bare.mjs`'s
`existsSync(target) && !o.force` refusal stays as the one check in front of the
removal.

**The act cannot report absence.** `coding-agent/generate.mjs` probes for
`generate-opencode.mjs` before spawning it: node answers "Cannot find module"
with exit 1 for a missing script, indistinguishable from the stage failing, so
the probe is the only non-string-matching way to keep "a partial copy of this
folder skips the stage" apart from "the stage broke" (d113). It moves when a
spawn can be classified without reading the child's message.

## Verification status

- `coding-agent`: 83 tests pass, including the new
  `tests/artifact.test.mjs` (absent → null, present → text, a directory →
  EISDIR, backup beside a file, backup of nothing → null, a copy published by
  rename with no `.tmp` left, a copy whose source will not read leaving its
  target alone).
- `codemode2`: 11 tests pass.
- `git/migrate-to-bare.mjs` was exercised against a scratch farm built from real
  repositories (`git clone` of a local upstream, its origin rewritten to a
  `file://` URL so the download path runs): a fresh conversion publishes
  `a.git`; a rerun without `--force` skips it; a `--force` rerun swaps it with
  no `.new-` or `.old-` left; a `--force` rerun whose clone fails leaves the
  existing mirror readable at its own name; a hand-made crash state (mirror moved
  aside, empty `.new-` left, nothing at the target) is repaired by the next run.
- `git`: 104 of 106 pass. Both failures are this host's, not this record's:
  `the path rule agrees with farm-lock.sh — /tmp fallback carries the uid`
  (`sh` here does not carry the expected uid through `farm_mutation_lock_path`)
  and `a free lock probes free, and a held one probes held` (the probe reads
  free after a `SIGTERM` this Android kernel delivers differently). Both fail
  identically with these changes stashed.
- `llm-local-inference`: 31 tests pass, `serving-set.test.sh` passes.
- `datalakehouse`: `spool-send.sh` (36 assertions), `spool-self-send.sh`,
  `sync-roots.sh` and `resolve-source.sh` pass; `browse-daemon.sh` fails
  identically with these changes stashed (it needs a browser daemon this host
  does not run).
- `sbex` was **not compiled**: this host has no JDK. The `SessionSpool` change
  uses only `FileChannel`, `Channels.newWriter` and `NoSuchFileException`.
- The Python changes are AST-checked only; `40-download-models.py` needs the HF
  hub and a model cache to run.
- `./test.sh` (the whole sweep, 467 tests): 462 pass. The five failures are the
  two host cases above plus three that are load-sensitive and pass on their own:
  `llm-local-bench`'s "a dead session leaves the rest of the journey
  unreached" (which fails with these changes stashed as well) and
  `git/tests/git-stop-signal.test.mjs`'s two signal-timing cases, which the
  sweep's parallel load flips in one direction or the other.
- Lint legs, run individually because `./lint.sh` cannot complete on this host
  (the toolchain is present: `node_modules` with biome 2.6.3 and tsc 6.0.3, and
  the `dev-tools.sh` pins for shellcheck, jq, ruff, uv, ty, oxfmt):
  - biome `lint . --error-on-warnings`: **0 errors**, 27 infos, none of them
    above the gate's line.
  - oxfmt `--check '**/*.md'`: 1418 files canonical, this record included.
  - shellcheck `-x` on every changed shell file and on `lint.sh`: clean.
  - ruff on the three changed Python files: clean.
  - tsc `-p tsconfig.json`: 27 diagnostics, all `TS2307` in the `pi-*` entries —
    `pnpm` is not installed here, so the extensions' host types cannot resolve.
    One real diagnostic in the changed code was found and fixed:
    `agent-warehouse-daemon.mjs` read `error?.code` off `unknown`, now a typed
    cast on the caught value.
  - oxlint: the pinned pair cannot load on an Android host at all — the
    npm binding `@oxlint/binding-android-arm64` dies with SIGILL (132) inside
    `dlopen`, before any config is read — and `@oxlint-tsgolint` publishes no
    android-arm64 build, so a type-aware run is `MODULE_NOT_FOUND`. The leg
    therefore asks the pinned binary first and, when it cannot load, runs the
    HOST's oxlint (1.94.0) against a temporary root config with
    `typeAware: false`, gated by `--deny-warnings` (with `--config`,
    `-D warning` alone no longer sets the exit status — measured), and logs a
    warn naming the three typed rules it cannot run. In that mode the tree scans
    clean. The typed half stays unproven on this host.
  - `knip` (the resolver fails) and `ty` / `uv sync --frozen` (`.venv` was never
    created) remain unproven for this change.
  - Both new gate legs were proved by leak test: an `existsSync` import in a
    scratch source file produces one biome error and none inside `git/tests/`;
    an `fs.existsSync` line appended to a tracked source file trips the
    `lint.sh` leg and the same line in a tracked test file does not. Note for the
    next edit of that leg: `\b` matches nothing in git grep's ERE — measured, and
    the leg spells the leading class out instead.

## Consequences

- **An unreadable input stops the step that owns it.** Generation aborts where
  the guard installed a stale copy silently (R7): `settings.json`/`mcp.json`
  with a present-but-unreadable committed source, `models.json` with invalid
  JSON, `cache-scope.json` with wrong permissions. That is the trade — a
  reported failure over a silent fallback.
- **Fewer syscalls and fewer code paths.** The deleted guards were each a branch
  plus a log line; the helpers that replace them are one read and one copy, so
  the install paths lost their duplicated backup code.
- **The rule is mechanically enforced, in two legs that already existed.**
  `biome.jsonc` now gives `noRestrictedImports` its options: importing
  `existsSync` from `node:fs` is an error everywhere, and the files above that
  keep it are named in the config's `overrides` with the reason for their group
  (capability probe, classifier, a partial copy's missing generator) plus the
  test exemption — a test asserting on the state a run left behind is an answer,
  not a permission. The namespace form the rule cannot see
  (`fs.existsSync`) is a `git grep` leg in `lint.sh`, which also exempts tests.
  The allow-list therefore has two homes on purpose: this record owns the
  reasoning, `biome.jsonc` owns the file list the linter reads, and adding a name
  there is a decision that starts here.
- **Deleted guards do not come back as "hardening".** A future patch that adds
  `existsSync` before an act re-opens this record's Problem section, and the
  fix is the act's errno, not the check.

## Alternatives rejected

- **Keep the guards for portability.** Every platform this tree runs on reports
  ENOENT from the act: Node, Python, POSIX shell, Java and Go alike. The guard
  bought no portability, only a second syscall.
- **Replace existence tests with `access(2)`.** Same race, same lost errno, one
  more name for the window.
- **Convert the destructive sites too.** A clone-over or an `rm -rf` has no undo,
  so its refusal is not a TOCTOU to remove but the decision itself (R5).
- **One sweep for the whole tree.** The four units are verified separately
  (d113): a batch per unit is what kept `sbex`'s uncompiled change and the
  shell scripts' untested ones visible instead of buried in one diff.
