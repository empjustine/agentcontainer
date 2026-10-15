---
id: d062
type: decision
status: implemented
title: "d062 — native Windows mirror maintenance: git/maintain.ps1 + a Windows-portable maintain-mirrors.mjs"
parent: d044
depends-on: [d041, d044]
references: [d044, d060]
tags: [git, references, work, windows, powershell, wsl2, mirrors]
---

# d062 — native Windows mirror maintenance (maintain.ps1)

**Status:** implemented

## Problem

[d044](d044-work-machine-bare-mirrors.md) put the work farm on the Windows
NTFS profile and reached it *through* WSL2 (`/mnt/c/Users/<you>/…`). That
works for exactly one storage class: a **local NTFS** volume. The work
machine's mirror roots also live elsewhere — non-NTFS filesystems, and
non-local UNC paths (`\\server\share\…`: SMB shares and non-disk targets
alike). Against those, WSL2 access misbehaves badly enough that a sweep is not
trustworthy (operator observation on the work machine; the failure mode is
backend-dependent — DrvFS/9p against a target that is not a local NTFS file —
and is deliberately not root-caused here: which layer misbehaves does not
change where maintenance must run).

The consequence is the decision: **maintenance for those roots must run
natively on Windows** — Git for Windows and a Windows node, talking to the
share directly, with no WSL2 in the path.

Two things stood in the way:

1. **The entrypoint is sh.** `git/maintain.sh` is a three-line shim sourcing
   `lib/node-run.sh` (d041); neither half has a PowerShell spelling.
2. **The program carried two POSIX assumptions**, both invisible from Linux:
   - `git-lib.mjs` loaded the shared logger with
     ``import(`${LIB_DIR}/log.mjs`)``. On Windows `LIB_DIR` is
     `C:\…\lib`, a drive letter parses as a URL scheme, and the ESM loader
     rejects the specifier — *every* `git/` tool importing git-lib would die
     at startup.
   - `--only`/`--exclude` globs were matched against `path.relative()`
     output, which spells separators `\` on Windows. No glob would match
     anything: an unmatched `--only` keeps the whole fleet (harmless), an
     unmatched `--exclude` spares nothing — and
     `migrate-to-bare.mjs --delete-originals` acts on that answer.

## Decision

### 1. `git/maintain.ps1` — the native Windows entry

maintain.sh's shim in PowerShell: fail-fast, dot-source
`../lib/node-run.ps1`, `node_run maintain-mirrors.mjs`, propagate
`$LASTEXITCODE`. Paths inside it are spelled with `/` — every PowerShell
host accepts those — so the shim itself runs (and is checked) off Windows.
Execution-policy note: the repo ships unsigned scripts, so Windows PowerShell
5.1 needs `-ExecutionPolicy Bypass` (or an Unrestricted session); pwsh 7's
RemoteSigned accepts local files as-is.

### 2. `lib/node-run.ps1` — d041's contract, Windows' branch signal

Same contract as the sh lib: repo-pinned node, sourcing sets no globals, no
secrets. The BRANCH differs because the signal does: sh keys on the Termux
profile — the one place the mise manager is absent — and Windows carries no
profile signal, so the PowerShell arm asks the capability itself: `mise` on
PATH → `mise x node@24 -- node`, otherwise bare `node` (same standing as
sh's Termux arm). It is the interpreter-selection lib for *any* future
Windows shim, not a maintain-private helper — it lives in `lib/` for the same
reason node-run.sh does (d041).

### 3. One program, two shims — no fork of maintain-mirrors.mjs

A `maintain-windows.mjs` copy was rejected before it existed: the pacing and
policy content (d044's 60 s software-forge gate, d060's flag-only config)
lives in the one file, and two copies of a policy program drift silently. The
program was already platform-neutral JavaScript — exactly two assumptions were
POSIX-shaped, and both belong in the shared file:

- the logger import goes through `pathToFileURL()` (a `file:` URL is the one
  spelling the ESM loader accepts on every platform);
- `globMatcher` reads both the glob and its subject in `/` spelling
  (normalization is for the match test only — returned paths keep their
  original separators, because callers match them back against their own
  `relative()` output).

`tests/git-glob.test.mjs` pins the separator contract with literal Windows
subjects, so the guard runs on any host — the failure it protects against
cannot be observed from Linux by running the tool.

### 4. File ownership per farm: WSL2 git XOR Windows git

d044 lists Windows-side access to the mirrors as *not handled* ("WSL `git`
owns the files"). That stays true for the local-NTFS farm. For UNC/non-NTFS
roots the ownership flips: the Windows-native run is the maintainer of record.
The rule is per farm root, and it is exclusive — two gits (one from WSL2, one
from Git for Windows) contending over the same refs/objects across the DrvFs
boundary is the one arrangement neither side of this record supports.

### 5. Only `maintain` gets the Windows entry, for now

`audit`, `migrate`, `search` and `local-changes` keep their sh shims: the
observed problem is upkeep of an existing farm, and a port that no one runs is
a port that rots (d041's lesson about unexercised branches). When one of them
needs a Windows entry, its shim is three lines over the same
`lib/node-run.ps1`.

## Consequences

- **Flags and pacing are identical** on both entrypoints: same
  `--root`/`--jobs`/`--only`/`--exclude` surface, software-forge fetches
  paced 60 s by the shared gate, `--min-interval` still the only knob (d060).
  The Windows run changes *where git executes*, never *what maintenance does*.
- **`--root` is a Windows path** (`\\server\share\refs`); `--only`/
  `--exclude` globs keep their documented `/` spelling, now with `\` also
  accepted from a Windows command line.
- **`git` must be Git for Windows on PATH** (the shim runs `git` through
  `execFile`, resolved by the Windows PATH search), and node comes from mise
  when present.
- **Discovery depth vs MAX_PATH**: a tree deeper than Windows' 260-char limit
  makes `readdirSync` fail, and `findBareMirrors` treats an unreadable
  directory as a skip — so the symptom would be "fewer mirrors found", not a
  crash. Point `--root` at the farm (or its nearest stable ancestor) rather
  than at `\\servershare`; git itself gets `core.longpaths` from the
  operator if the repo paths are long.
- **d044's storage caveats still apply** to the new targets where relevant
  (case-insensitivity is a non-issue for bare object stores, repack is the slow
  step, the mirror refspec prunes) — they just now run against a share instead
  of C:.
- **The fix is scoped to the Windows path.** The remaining
  `${LIB_DIR}/log.mjs` template importers (the generators) are
  Linux/Termux/container hosts only and stay as they are; `git-lib.mjs` is
  the one lib on the Windows chain.

## Verification

- `node --test` — the new `tests/git-glob.test.mjs` (4 cases: `/` glob vs
  `\` subject, `\` glob spelling, `*`/`**` segment semantics on both
  spellings, original-spelling preservation in `filterByGlobs`); the suite's
  other failure (`lib-staging.test.mjs`) reproduces unchanged at HEAD and is
  pre-existing.
- `./check-types.sh` (tsc strict, new test in `tsconfig.json`) reports nothing
  in the touched files — its one error (`gen-lib.mjs(251)`) reproduces
  unchanged at HEAD; `./lint.sh` shellcheck is clean; `biome check` on every
  touched `.mjs`/`.json` is green.
- pwsh 7.6.6 (via mise) executes the real chain on this Linux host:
  `pwsh -File git/maintain.ps1 --help` prints the usage with the ps1 line, and
  a `--no-fetch` sweep over a synthetic bare mirror discovers, optimizes and
  exits 0 — exercising the shim, `node_run`, the `pathToFileURL` import and
  `$LASTEXITCODE` propagation. The shims are written 5.1-compatible (no `??`,
  no ternary, no `-AdditionalChildPath`), but **Windows PowerShell itself has
  not run them**: the drive-letter import and UNC discovery are reasoned plus
  unit-guarded, not observed. The first sweep on the work machine against the
  real UNC root is the outstanding check.

## Alternatives rejected

- **Fix WSL2's access instead** (mount options, DrvFS `metadata`, re-export
  the share): the misbehavior is not root-caused and is not this repo's to
  fix; maintenance must not depend on a particular host/share combination's
  9p behavior.
- **Fork `maintain-windows.mjs`**: buys nothing — the program was portable
  but for two lines — and costs a second copy of the pacing/policy logic that
  d044/d060 keep in one place.
- **Git Bash / MSYS2 as the Windows entry**: keeps `.sh` sourceable but adds
  a third path-spelling layer (POSIX-ified `/c/…`, MSYS path translation)
  exactly where path spelling is the bug being fixed, and the work operator's
  shell is PowerShell anyway.
- **Port every `git/` shim to PowerShell now**: rejected with d041's own
  reasoning — an entry nobody exercises rots; only `maintain` has a Windows
  job today.
