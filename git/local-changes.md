---
id: git-local-changes
type: reference
status: active
title: "Local-changes viewer: what a repo holds that its remotes do not"
parent: architecture
references:
  - architecture
tags:
  - git
  - local-changes
  - viewer
---

# Local-changes viewer

`git/local-changes.mjs` (`./git/local-changes.sh`) answers one question about a
repository: **what is here that no remote has?** It is the read-only companion
to archiving or migrating a clone — before a clone becomes a bare mirror
(docs/d044) or is deleted, this is the check that nothing local is about to be
lost.

The name is literal: `.gitignore` hides files, it does not protect them, so the
viewer reports four distinct ways work goes missing.

| category | source | why it matters |
|----------|--------|----------------|
| uncommitted | `git status --porcelain=v1 -z --ignored` | staged, unstaged, untracked, and **ignored** files; a checkout can be "clean" and still lose `.env`, build outputs, or scratch data |
| stashes | `git stash list` + `git stash show --name-only` | stashes are invisible to `git log` and survive a checkout; they die with the directory |
| branches on no remote | `for-each-ref refs/heads` vs `refs/remotes` | a local branch with no remote-tracking counterpart is not on any remote |
| ahead of upstream | `%(upstream:track)` | commits the upstream does not have (and `[gone]` upstreams) |

## Usage

```sh
./git/local-changes.sh                     # the current repo
./git/local-changes.sh --repo DIR
./git/local-changes.sh --root DIR          # sweep every clone under DIR
./git/local-changes.sh --root DIR --all    # ... including clean repos
./git/local-changes.sh --json              # machine-readable
```

- `--json` emits `{ repos: [ { path, head, detached, upstream, ahead, behind,
  uncommitted:{staged,unstaged,untracked,ignored}, stashes, branches, localOnly,
  aheadBranches, goneBranches, findings } ] }`.
- `--root` reuses the structural clone discovery from git-lib.mjs
  (`git/non-bare-issues.md`) and by default shows only repos with `findings > 0`.
- `--only`/`--exclude GLOB` filter the swept repos by relative path.
- `--max-entries N` caps each list (default 200); `--no-ignored` drops the
  ignored-file category.

## Caveats

- **Remote-tracking refs are local.** The "on no remote" and "ahead" answers are
  only as fresh as the last `git fetch`; run one first when the answer matters.
- **Ignored entries are traditional, not exhaustive.** `git status --ignored`
  reports an ignored *directory* as one entry rather than walking every file
  inside it, which is what keeps a `node_modules/` from flooding the report.
- **Bare repos** (the mirror farm) have no working tree and no stash; only the
  branch categories apply.
- **Rename/copy entries** consume two `-z` tokens; the parser accounts for that.
