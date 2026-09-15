---
id: git-non-bare-issues
type: reference
status: active
title: "Non-bare reference clones: costs, migration, and pickaxe-fast mirrors"
parent: architecture
references:
  - architecture
  - d041
tags:
  - git
  - references
  - tooling
---

# Non-bare reference clones: costs, migration, and pickaxe-fast mirrors

The reference farm (`~/Downloads/references`) is a large collection of git
repositories used as read-only research material by the coding agent. It was
built as a set of ordinary full clones. This note records why that shape is
expensive, what the audit of the current farm actually found, and the tooling
in this folder that converts it to bare mirrors and keeps them useful for deep
history search.

## TL;DR

- A working tree is **pure overhead** for reference material: every history and
  pickaxe query works against a bare repo, but a checkout multiplies the file
  count and the disk.
- The concrete cost is not disk alone: podman's `z,U` mount options
  (`lib/workload-render.jq`) recursively relabel + idmap **every file** of the
  bind-mounted tree on **every** container launch. The farm measured
  **1,661,492 files / ~296 GB**, which is ~39 s of dead startup time.
- A bare mirror keeps the identical refs/history in a handful of packfiles and
  needs no checkout. Migrating 778 clones drops the file count by orders of
  magnitude and makes the farm directly servable.
- Deep search (`git log -S`/`-G`) works on bare repos and gets dramatically
  faster with a commit-graph written with `--changed-paths` (Bloom filters) —
  provided the search is path-limited.

## What a non-bare clone costs

### 1. File count is the container cost, not bytes

Podman binds the source tree with `:z,U`:

- `z` = shared SELinux relabel — walks the tree and `lsetxattr`s files;
- `U` = idmap/chown — walks the tree again (cheap only where idmapped mounts
  apply).

Both are O(#files), on **every** launch. A checkout of a repo with 100k files
costs 100k syscalls before the container even starts; a bare repo of the same
project costs one packfile + refs. This is why the reference mirror was the
single largest `coding-agent/run.sh` startup cost while the HF cache (823
files) and the repo itself were noise.

### 2. A checkout duplicates what the objects already contain

Git's object store is already zlib/delta compressed. The working tree is a
second, uncompressed copy of one revision. For reference material that is never
edited, that copy buys nothing.

### 3. History search does not need a checkout

Every question that matters for research runs on a bare repo:

```sh
git -C repo.git grep -n 'pattern' HEAD          # current tree
git -C repo.git log --all -S'literal' -p        # pickaxe (content change)
git -C repo.git log --all --pickaxe-regex -S're' -p
git -C repo.git log --all -G'diff-regex' -p     # pickaxe on diff text
```

### 4. Serving wants bare

`git daemon --export-all` and `git http-backend` are built around bare/mirror
repos; a checkout is the wrong primitive to serve read-only. Bare mirrors also
make on-demand working copies cheap via `git worktree add` (the object store is
shared, so it is local and instant).

### 5. Maintenance shape

A non-bare clone has a checked-out branch, remote-tracking refs, and a
`git fetch` that by default does **not** prune deleted upstream branches. A
mirror (`clone --mirror`, refspec `+refs/*:refs/*`, `remote.origin.mirror=true`)
is an exact replica by construction: fetch prunes refs upstream deleted. That
is the alignment model the maintenance script relies on.

## The observed farm (from `./git/audit.sh`)

At the time of writing: **778 repos**, **777 from github.com**, **1 with no
origin**. The tree is not a clean two-level layout — the audit surfaces five
classes of anomaly:

| Class | Count | Examples |
|---|---|---|
| Nested repos (a repo inside another repo's working tree) | 37 | `github/duckdb/duckdb`, … (the `duckdb` "owner" dir is itself a repo) |
| Nonstandard path (not `github/<owner>/<repo>`) | 2 | `github/duckdb`, `github/duckdb-web` |
| Path/origin mismatch | 2 | `github/empjustine/agentcontainerOLD/agentcontainer{2,3}` → both point at `empjustine/agentcontainer` |
| No upstream | 1 | `github/empjustine/temporary-previous-workspace` |
| Duplicate origins | 3 | `duckdb/duckdb`, `duckdb/duckdb-web`, `empjustine/agentcontainer` each present twice |

Consequences the tooling must respect:

- Discovery must **not** stop at the first `.git` it finds, or it misses the 37
  nested repos (`findCloneRoots` keeps descending).
- Mirrors must go to a **separate root** (`--dest`, default `<root>-bare`).
  A mirror placed beside `github/duckdb` would live inside that clone's working
  tree and be destroyed when the original is deleted.
- `--only`/`--exclude` globs let a known-bad entry be skipped without editing
  the farm. These anomalies look like mistakes, so they are good candidates to
  exclude (or fix by hand) before a mass migration.

## Tooling

All three are standalone: the copy unit is `git/` + `../lib`
(`docs/architecture.md`), they use the shared logger, and the `.sh` shims run
the repo-pinned node via `../lib/node-run.sh`.

### `./git/audit.sh` — report anomalies

```sh
./git/audit.sh [--root DIR] [--max-depth N] [--deep]
```

The JSON report goes to stdout, the summary/warnings to stderr. `--deep` adds
`git status --porcelain` and detached-HEAD checks per repo (slow; off by
default).

### `./git/migrate.sh` — convert clones to bare mirrors

```sh
./git/migrate.sh [--root DIR] [--dest DIR] [--jobs N] [--max-depth N] \
                 [--redownload] [--delete-originals] [--force] [--verify] \
                 [--only GLOB]... [--exclude GLOB]... [--dry-run]
```

- Default: **local** conversion, no network — `git clone --mirror --local`
  from the existing `.git` (hardlinking objects, so fast and near-space-free
  on the same filesystem), then `origin` is re-pointed at the real upstream
  captured from the old clone.
- `--redownload`: `git clone --mirror` from upstream instead.
- Shallow clones are **always** re-downloaded: a mirror of a shallow clone is
  still shallow, which defeats deep pickaxe.
- Originals are **kept** by default; `--delete-originals` removes each source
  clone after a successful convert. Because mirrors live in `--dest`, that
  delete cannot take a mirror with it (the reason for the parallel root).
- `--verify` runs `git fsck --connectivity-only` per mirror.

### `./git/maintain.sh` — align + optimize

```sh
./git/maintain.sh [--root DIR] [--jobs N] [--max-depth N] \
                  [--no-fetch] [--no-optimize] \
                  [--only GLOB]... [--exclude GLOB]... [--dry-run]
```

1. **Align**: `git remote update --prune` (mirror refspec ⇒ exact replica).
2. **Optimize**:
   ```sh
   git repack -adb --write-bitmap-index
   git commit-graph write --reachable --changed-paths
   ```
   plus `core.commitGraph`, `gc.writeCommitGraph`, `fetch.writeCommitGraph` so
   later fetches keep the graph current.

The default `--root` is the farm itself (`~/Downloads/references`), and
discovery is by shape, so every forge mirror under it is maintained whatever
its host (`github.com`, `codeberg.org`, `git.sr.ht`, GitLab subgroups, …).
`--only 'codeberg.org/**'` narrows a run to one host if wanted.

`git maintenance start` is deliberately not used — it installs a background
timer the operator cannot see; this script is the explicit replacement.

## Pickaxe: how to actually get the speedup

The Bloom filters written by `--changed-paths` answer *"did this commit touch
path P?"*. They accelerate a **path-limited** search:

```sh
git -C repo.git log --all -S'needle' -- path/to/file     # filters apply
git -C repo.git log --all -G'regex' -- 'src/**'          # filters apply
git -C repo.git log --all -S'needle'                     # no pathspec: filters cannot help
```

Other properties worth remembering:

- `-S` (pickaxe) needs the **blobs**, so a partial/blobless clone destroys it —
  keep full objects, or run the search server-side.
- Shallow clones lose deep history — never migrate them as-is.
- `repack -adb` + the commit graph also speed `git log`, `git blame` and
  `rev-list`, so the maintenance pass is not pickaxe-specific.

## Not handled

- **Submodule contents**: a submodule's `.git` is a file, so discovery ignores
  it. A `--redownload` restores the superproject refs but not submodule
  objects.
- **Git LFS**: LFS pointers are mirrored; LFS objects are a separate store.
- **Un-pushed work**: mirror mode prunes refs upstream does not have. This farm
  is read-only reference material; do not run the maintenance script against a
  clone holding un-pushed branches.
- **Non-git trees** under the root (`books-com.springer`, `kiwix`) are simply
  not discovered; the audit reports them only as absent from the repo count.

## Serving

[d043](../docs/d043-cross-repo-reference-search.md) owns the serving/search
layer this note deferred: a Zoekt index over the mirrors for fast cross-repo /
cross-branch regex search, and a blob-addressed embedding index for semantic
search. Both run as host-side services reached over the network (the runner
already uses `workload_network host`), so the farm does not come back as a
bind mount and the `z,U` startup cost does not return.

Indexing is **opt-in**: nothing is indexed until a repo looks interesting, at
which point `./git/search-references.sh index --only 'github.com/<o>/<r>.git'`
builds just that repo's shard. New mirrors are added with `./git/-forge-mirror.sh <url>` — any https forge
(GitHub, Codeberg, sr.ht, GitLab subgroups), keyed by host, trailing `.git`
optional (idempotent; re-runs align) — then optimized by `./git/maintain.sh`.
