---
id: d160
type: module-design
status: active
title: "d160 — a retired mirror name is a relative symlink beside the mirror, not a ledger"
parent: git
depends-on: [d099, d121]
references: [d060, d062, d113, d161]
tags: ["git", "mirror", "alias", "rename", "symlink", "farm"]
---

# d160 — a retired mirror name is a relative symlink beside the mirror

## Problem

Upstreams rename. When one does, the objects do not move, but the path a reader knows does:
documents, commit messages and habit still cite the old owner/repository, and the mirror sits under
the new one. The farm has three such pairs, found by a canonicality sweep of a 66-mirror sample:

| cited path         | canonical path            | repository id |
| ------------------ | ------------------------- | ------------- |
| `sst/opencode`     | `anomalyco/opencode`      | 975734319     |
| `rivet-dev/agents` | `rivet-dev/sandbox-agent` | 1141720197    |
| `dais-labo/flock`  | `dais-polymtl/flock`      | 848527519     |

A request for the retired path currently answers `no such mirror in the farm` (exit 3), which is
correct and useless: the mirror is one directory away.

Three fixes look obvious and each fails for its own reason.

- **A ledger read at call time** buys a table every caller has to consult on every operation, and a
  rule ("read the table first") that one forgotten read silently violates.
- **A second mirror cloned under the old name** stores the same objects twice, drifts the moment
  only one side is fetched, and multiplies the storage the farm exists to bound.
- **`objects/info/alternates`** shares object storage but ties two repositories to one `objects`
  directory, which breaks the copy-unit rule (docs/d113): copying either unit leaves the other
  unreadable.

## Decision

A retired name is a **relative symlink next to the mirror it names**, recorded in
`git/aliases.json` and applied by `git/farm-aliases.mjs`:

```
references/github.com/sst/opencode.git -> ../anomalyco/opencode.git
```

The link is the whole mechanism — there is nothing to read first, because the old path and the
canonical path are the same inode. The record in `git/aliases.json` exists for the one thing a
symlink cannot do for itself: be rebuilt after it is damaged, and remember the repository id that
proved the rename (see d161's probed verdict table).

The link is **relative**, resolved from the alias directory, so the farm can be moved or copied as
a unit. An absolute link survives neither.

The mirror's own `remote.origin.url` is updated to the canonical url at the same time. The alias
records history; the origin records where objects come from, and a fetch against a retired name
would have to follow a redirect nobody sees.

## Consequences

### Discovery counts one mirror, once

`findBareMirrors` walks with `readdirSync(dir, { withFileTypes: true })` and keeps entries whose
`isDirectory()` is true. A symlink reports false there, so discovery never yields an alias id and
`list_repos` reports the farm's real size. `resolveRepo` builds `<root>/<id>.git` and stats
`HEAD`, which **follows** the link, so every read verb reaches the mirror.

The mismatch between those two postures is a silent false negative: a fan-out verb given the
retired id matched zero repositories and answered `repos_matched: 0` with `ok: true`. `selectRepos`
therefore resolves an **exact** id that discovery did not list, when `<root>/<id>.git` holds a
`HEAD`. A wildcard is never resolved that way: `*` must keep meaning "what the farm lists", or the
result set would depend on whichever links happen to exist.

### The read surface says which it is

`repo_info` reports `entry` (`mirror` or `alias`) and `alias_target` (the canonical id, or null).
A reader that needs the canonical path gets it from the answer, not from a table beside the tool.

### A symlink is fragile in exactly one way

`rm -rf <root>/<owner>/<alias>.git/` — with a trailing slash — **dereferences the link and empties
the target**. Measured on a scratch farm: after `rm -rf alias/` the target directory still existed
and held zero files; after `rm -rf alias` (no slash) only the link was gone. Filesystem
permissions cannot help, because deleting through a link needs write permission on the _target's_
directory, which the owner has by definition.

The same asymmetry governs copying: `cp -r` materialises the target inside every alias (a full
second copy of 344 GB per alias on this farm), while `rsync -a` preserves the links.

So the rebuild path is a command, not a memory:

```
./node-run.sh git/farm-aliases.mjs --check   # ok · missing · not-alias · wrong-target · target-missing
./node-run.sh git/farm-aliases.mjs --apply   # create missing, re-point wrong, idempotent
```

`--check` exits 1 when any alias is not `ok`, which is what a restore from a copy, or an `rsync`
without `-a`, leaves behind. `--apply` refuses to replace a real mirror at the alias path: at that
point the mirror there is the only copy of those objects, and trading it for a link destroys them.

### Windows and network roots

Symlink creation on Windows needs privilege or developer mode, and the ps1 entry that used to
carry a junction fallback for it is deleted (docs/d162); a Windows-side run adopted again would need
one. A junction is directory-only and absolute, so it resolves for
reads and loses the move-with-the-unit property — acceptable where the root never moves, and worth
recording rather than discovering.

On a case-insensitive filesystem an alias and its target must not differ only by case: the link
would resolve to itself, and the swap could delete the mirror. `--check`'s `not-alias` state is the
guard that sees a same-path collision before `--apply` acts on it.

An SMB root that cannot hold symlinks is a farm without aliases, not a broken farm: the table is
data, the mirrors are intact, and every read works under the canonical name.

### What an alias is not

Not a fork, not a rename of the mirror, not an index entry, and not a second source of truth. The
objects stay in one place; only the name is doubled.

### Keeping this working after the forge changes

Nothing here depends on the second-generation, object-storage forge. The alias is a filesystem
fact plus a JSON table, so it works on the stopgap farm, on a work mirror that will never run the
new store, and inside a single copied unit. A forge that serves mirrors from object storage has to
reproduce the two envelope fields (`entry`, `alias_target`) from its own metadata; the callers do
not change, and the table remains the portable record of which name maps where.

## Verification status

The three aliases exist on `~/Downloads/references`; `--check` reports all three `ok`, and
`--apply` restores a deleted link in one run (exercised by deleting the link without a trailing
slash and re-checking). `git/tests/git-farm-tool.test.mjs` pins the read path: an alias id answers
`read_file`, `repo_info` reports `entry: "alias"` with the canonical target, `search_code` finds the
mirror once, and `list_repos` still reports the farm's real size.
`git/tests/git-farm-posture.test.mjs` pins the selection rule: an exact alias id is selectable, a
wildcard is not resolved through links, and an unknown id stays empty.

Not exercised: the Windows junction fallback, a case-insensitive collision, and an SMB root without
symlink support. Those are the three items under "Windows and network roots".

## Alternatives rejected

- **A ledger consumed by the tool** — one forgotten read and the retired name is a 404 again; a
  symlink cannot be forgotten.
- **A second mirror under the old name** — duplicate objects and drift.
- **`objects/info/alternates`** — breaks the copy-unit rule (docs/d113).
- **`url.<base>.insteadOf` in git config** — per-machine state invisible to the tool surface, and it
  rewrites a _url_, not a path on disk, so a read verb still cannot open the retired id.
