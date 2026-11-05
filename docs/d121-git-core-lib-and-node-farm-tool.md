---
id: d121
type: decision
status: implemented
title: "d121 — git/ takes the copy-unit fold last: a core lib, shim entries, and the farm tool in node"
parent: git
depends-on: [d043, d044, d062, d075, d076, d089, d099, d113]
references: [d039, d041, d045, d060, d118, d119, d120]
tags: ["git", "fold", "node-port", "shell-retirement", "search"]
---

# d121 — git/ takes the copy-unit fold last

## Problem

Every other unit took the docs/d113 pass — its kernels in its own `lib/`, its
top-level files the entries a caller invokes. `git/` did not, and it was the
one folder where the miss cost the most:

- **The floor sat at the folder root.** `git-lib.mjs` (491 lines) was the
  shared kernel with no `lib/` around it, so its two sibling modules
  (`log.mjs`, `canonical-json.mjs`, both already in `lib/`) were read by
  climbing out and back in, and a `pathToFileURL` dance existed to make a
  `join()`-built path importable — a workaround for a Windows constraint
  (docs/d062: the drive letter parses as a URL scheme) whose real cause was
  building a specifier instead of writing one.
- **Seven hand-rolled `parseArgs` loops.** The same unknown-flag error, the
  same `-h/--help` branch, the same `main().catch` tail, copied per entry.
- **1,507 lines of shell logic on top of it** — `farm-tool.sh` (638) plus
  `farm-tool-lib.sh` (389) and `-vbs-mirror-all.sh` (480) — a _second_ home
  for facts the folder's node half already owned. `farm-tool-lib.sh`'s
  `fg_repo_ids` restated the mirror-discovery rule `findBareMirrors`
  implements, with a comment admitting the two walks must agree. The
  non-interactive git environment (docs/d075) had three spellings. Pacing and
  backoff existed twice, once per language, and only the node one was
  testable.
- **`jq` was a `git/` runtime prerequisite** for exactly one reason: the VBS
  manifest extractor in `-vbs-mirror-all.sh`. A host-side folder about git
  mirrors needed a JSON processor to read a JSON file.

The folder also had no shell-free read path: the d099 tool surface — the
thing a future MCP façade wraps — was a POSIX program.

## Decision

**`git/lib/` is the folder's core library, and every top-level entry is a
shim.** The fold is d113's, applied to the last unit:

- `git-lib.mjs` → `git/lib/git-core.mjs`, `software-forge-remotes.mjs` →
  `git/lib/forge-remotes.mjs`. Exports unchanged. Sibling imports became plain
  relative specifiers (`./log.mjs`), and the `pathToFileURL` dance went with
  them: the Windows constraint was the drive-letter specifier, never relative
  specifiers.
- `git/lib/cli.mjs` — one flag parser (`string`/`number`/`bool`/`list`, the
  one `unknown flag (try --help)` error, positional policies `reject` / `last`
  / `list` / `join`) and `runEntry(label, body, { report })` for the
  `main().catch` tail. Every entry keeps its own flag table.
- `git/lib/retry.mjs` — `classifyFailure`, `backoffSeconds`,
  `createFailureStreak`, with `sleep`/`random` injected, because a policy an
  operator can argue about (10 retries, 60s pacing, a 300s backoff ceiling)
  is otherwise only testable by waiting.
- `git/lib/farm-lock.mjs` — the mutation lock's _path_ and a probe, never the
  lock. It reports `held` / `free` / `unknown` by asking `flock -n`, not by
  looking at whether a file exists.
- `git/lib/farm-posture.mjs` — d099's safety posture for the node side: the
  caps, the one scrubbed `git` choke point with its per-call deadline, the
  allowlist validators, farm discovery, the cursor/collect model, and the byte
  window `read_file` cuts.

Bodies stay bodies: each tool's own logic is still its own top-level `.mjs`.
Only plumbing moved — spawn, discovery, globs, pacing, argv, envelopes.

### The two ports

`-vbs-mirror-all.sh` became `vbs-mirror-all.mjs` behind a nine-line shim. The
`jq` program became `extractRepos`, reproducing its field fallbacks
(`projectId|projectGuid`, `projectSlug|project|slug`, `repo|name`,
`httpsUrl|httpUrl`, `sshUrl`), and the retry/rate-limit/cooldown state machine
moved into `lib/retry.mjs`. `--list` still writes TSV to stdout and logs to
stderr, so `… --list > repos.tsv` stays unambiguous (docs/d045).

`farm-tool.sh` + `farm-tool-lib.sh` became `farm-tool.mjs` behind the same
kind of shim (twelve lines: shebang, header, `node_run`). The split is
deliberate: the posture module holds every rule, and the entry holds only argv
shapes, envelopes and exit codes — so the MCP façade docs/d099 reserves can
wrap the same entry without re-deciding the posture.

Three shapes changed because the shell version does not survive the move:

- **A refusal throws** (`FarmError`, codes 2/3/4/5). The shell's `fg_error`
  could exit from any depth; in node that means printing half an envelope
  first.
- **Byte caps are measured after control-stripping**, as the shell did with
  `tr` before `head -c`, so `stripControlBytes` sits beside `stripControl` and
  `read_file`/`diff` truncation flags agree with what the caller receives.
- **An unmatched `diff` path glob yields an EMPTY patch.** Zero pathspecs
  after `--` means "no restriction" to git, so the empty case has to
  short-circuit or the whole repository comes back.

Discovery folds (R6): the farm tool lists mirrors through `git-core.mjs`'s
shared walk, restricted to `*.git` directories, instead of restating a `find`
rule. The shell's `-mindepth 2` is re-expressed as "the id contains a
separator", so a stray top-level `x.git` is not a farm member.

### Four answers that differ from the shell, on purpose

- **`list_repos` is sorted.** The shell inherited `find`'s readdir order, which
  a cursor can promise nothing about. The envelope matches field for field;
  which rows a given window covers does not.
- **A `*.git` directory is a member only if it is a structural mirror**
  (HEAD + objects + refs). The shell accepted any directory with a HEAD, which
  an interrupted clone leaves behind and `list_refs` can say nothing about.
- **An unparsable lock status file reports no holder** (`null`) rather than a
  holder whose every field is `null`. The file is written by this tool family
  under a tmp+rename, so an unparsable one is hand-editing, and "no readable
  description" is the honest answer.
- **The failure envelope's field values stay strings** (`"cap":"262144"`), as
  the shell emitted them. That envelope's shape is what a caller parses; typed
  numbers are the façade's decision to make, with a schema, in one place.

One interface improvement was accepted: `search-references` gained a `USAGE`
block and a `--help` answer (its three subparsers each had a help branch and
no text). And one bug died in the shared parser: a `bool` flag used to consume
the next token, so `--deep-optimize --no-optimize` silently became
`deep="--no-optimize"`.

### What stays shell

`farm-lock.sh` stays because `flock` has no node equivalent — and it uses flock
in _fd_ mode, not `flock LOCKFILE CMD…`, because the command it guarded was
`node_run`, a shell **function** no exec can see (d138 turned that command into
an executable, so exec mode would now work; fd mode is kept because it holds
the lock in the caller's own process and releases it when the holder dies). The two mutation verbs therefore still spawn the two
existing shell entries (`-forge-mirror.sh`, `maintain.sh`), so the lock is
taken by the same process that takes it today: no double-lock, no deadlock.

That leaves `git/` with nine interpreter shims, `farm-lock.sh`,
the repo-root `node-run.sh` and `node-run.ps1` (the Windows port, docs/d062) as its
only shell. `lib/log.sh` was deleted with its last consumer — the shell farm
tool — on docs/d120's rule for `estige/lib/`.

### jq leaves the folder

The manifest extractor was the only `jq` call in `git/`, and it is gone:
`grep -r jq git/` now finds prose only — the logger's `2>&1 | jq` filter
examples, and the comments where a ported helper reproduces a jq operator
(`tostring`, `//`). The `jq not found` guard, the `default_manifest_jq`
program and the `MANIFEST_JQ` plumbing went with it.

## Invariants

- **The usage text names the shim**, never the `.mjs` behind it: a ported
  tool's `--help` still says `./git/farm-tool.sh`, so an operator's hands do
  not change.
- **A read verb pins its commit.** `search_code`/`search_paths`/`read_file`
  resolve HEAD once and search that sha; `diff` reports both pins. HEAD drift
  cannot re-page a result set under a consumer.
- **Every cap is announced** in the envelope (`matches`, `total`,
  `repos_matched`, `truncated`), and the caps live in one frozen object.
- **A repo id, rev, path, glob and date are allowlisted**, not escaped: farm
  data includes repository names nobody in this repo chose (d099).
- **Two glob matchers, two questions.** `caseGlob` (identity filters, `*`
  crosses `/`) is deliberately separate from `globMatcher` (path globs, `*`
  stops at `/`); a test pins their disagreement so a future "unification"
  fails loudly.
- **Node never takes the mutation lock.** It names it, probes it, and
  describes the holder; taking it is the shell's job.
- **An unreachable shell branch is not ported**, and its removal is recorded
  (the bare-array manifest shape).

## Alternatives rejected

- **Keep the farm tool in shell and port only the VBS mirror.** Half the work,
  and it leaves the d099 surface — the piece an MCP façade must wrap —
  unreachable from node.
- **Port the verbs but keep `farm-tool-lib.sh` as the posture.** The posture is
  the part everything must share; leaving it in the other language guarantees
  the copy in node eventually disagrees with the copy in shell.
- **One file, no posture split.** Fewest files, but then the façade would have
  to reach into verb bodies to reuse a rule, which is how two postures happen.
- **Preserve readdir order** so the port is byte-identical on every cursor
  case. A cursor over an order nobody promises is a bug waiting for a
  filesystem change.
- **Stringify nothing and type the failure fields.** Breaks a caller's parse
  for cosmetic reasons, in the one record that is not about the façade.
- **Unify `caseGlob` with `globMatcher`.** They answer different questions;
  one matcher would make a repo filter match fewer rows or a path glob cross
  directory boundaries.

## Consequences

- `git/` has no logic in shell. The folder's shell is interpreter shims plus
  the one thing node cannot express (flock).
- `jq` is no longer a `git/` prerequisite. `./lint.sh`'s jq compile gate now
  guards exactly one unit's filters (`llm-local-inference/`).
- The repo's sweep grew from 212 to 264 tests: the two new suites are the
  parity evidence for ports whose shell was deleted, and the posture suite
  asserts discovery against the `find` rule it replaced.
- docs/d099's CLI stage is node, so the façade it reserves wraps
  `git/farm-tool.mjs`; its usage, exit codes and envelopes are unchanged.
- Parity was proven before deletion, and the exception list is written down:
  a 111-case harness over a 78-mirror fixture compares exit code, canonical
  stdout and stderr log shape — 106 cases byte-identical, the five exceptions
  being the usage prose and the three sorted-window cases above. The same
  harness on the real farm (1,162 `github.com` mirrors) agrees on matches,
  total, truncated and every shared row, differing only in which 120 of 1,162
  fill the window.
- Left open here: the MCP façade (docs/d099), the typed error-envelope schema
  it should own, and any Windows-side verification of `node-run.ps1`'s shims
  (docs/d062) — unchanged by this record.
