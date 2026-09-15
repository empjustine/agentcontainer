---
id: d043
type: decision
status: proposed
title: "d043 — cross-repo / cross-branch reference search: Zoekt for regex, blob-addressed embeddings for semantics"
parent: architecture
tags: ["git", "references", "search", "zoekt", "embeddings", "tooling"]
---

# d043 — cross-repo / cross-branch reference search

Follow-up to `git/non-bare-issues.md` (the reference-farm mirror work). The
farm is now **775 bare mirrors** under
`~/Downloads/references/github.com/<owner>/<repo>.git`, ~73 GB of git objects.
That note ended with a "Serving (future)" paragraph naming a `git daemon` and
"a Zoekt index for fast cross-repo regex search" as the next steps. This record
is that design, plus the semantic layer it did not name.

## Problem

The agent needs to answer "where is X implemented / named / shaped, anywhere in
my references, on any branch?". Today the only option is to bind-mount the
whole farm into the container (`CODING_AGENT_REFERENCES=1`), which is off by
default because podman's `z,U` relabel walks all ~1.6 M files on every launch
(~39 s) — see `git/non-bare-issues.md`. And once mounted, the farm is a pile of
**bare** repos: there is no working tree to point `rg` at.

The naive answer — shell out to `git grep` across every ref tip of every repo —
is measurably not viable. On this farm:

```sh
# 775 repos, 16-way parallel, ALL ref tips, rare literal, count only
ls -d */*.git | xargs -P16 -I{} sh -c \
  'git -C "{}" grep -I -l zoekt $(git -C "{}" for-each-ref --format="%(objectname)" | sort -u)'
# → did not finish in 300 s
```

Single-repo tip-grep is fast (ripgrep's 273 refs: 0.4 s), but the farm includes
`JetBrains/intellij-community` (6.2 GB), `JetBrains/kotlin` (4.3 GB),
`gokrazy/kernel` (4.1 GB), `microsoft/TypeScript` (3.0 GB). "Fast" requires a
real index, not a smarter loop.

## Decision

Two layers, two different index shapes, one query surface. Both run **on the
host**, over the bare mirrors, and are reached by the agent over the network
(`coding-agent/run.sh` already uses `workload_network host`, so a host-side
server is reachable at `127.0.0.1:<port>` with **no bind mount and no `z,U`
walk**).

| layer | engine | answers | index shape |
|---|---|---|---|
| lexical | **Zoekt** | regex / literal / symbol, `repo:` `branch:` `file:` filters | trigram + positional index, per-repo shards |
| semantic | **blob-addressed chunk embeddings** | "code shaped like this", natural-language intent | vector index keyed by git blob SHA, deduped across refs |

The lexical layer is the priority and is implemented (`git/search-references.*`);
the semantic layer is specified here but not yet built — its frontmatter
`status: proposed` tracks that gap.

**Indexing is opt-in.** Nothing is indexed by default: the farm is a long tail
and only a repo that actually looks interesting is worth the branch-scaled
index build. `index` refuses to run without an explicit `--only GLOB` (or the
`--all` escape hatch), so the default posture is "search nothing, index on
demand" — see the scope ladder under Layer 1.

Implementation status: **Layer 1 (lexical/Zoekt) built** — `git/search-references.mjs`
+ shim (opt-in indexing), plus `git/-forge-mirror.sh` for acquiring a bare
mirror from any https forge; dry-run-verified and type/lint-clean. **Layer 2
(semantic) designed only**.

## Layer 1 — lexical: Zoekt

[Zoekt](https://github.com/sourcegraph/zoekt) is Sourcegraph's search engine:
a trigram index plus regex verification, with first-class git support. It reads
**bare** repos directly (`zoekt-git-index`), indexes each requested ref as a
separate *branch*, and exposes filters (`repo:`, `branch:`, `file:`,
`lang:`, `sym:`) that map exactly onto cross-repo / cross-branch search.

### Engine source: the official image, not a host Go install

Zoekt has no prebuilt GitHub release binaries. Rather than require a host Go
toolchain plus a ~minutes-long `go install`, the tooling runs the official
multi-arch image `ghcr.io/sourcegraph/zoekt:latest` (verified: OCI index with
`amd64`+`arm64`, built 2026-09-11, `Entrypoint /sbin/tini --`,
`Cmd zoekt-webserver -index /data/index`). This matches the repo's
podman/docker-first posture (`build.mjs`, `lib/workload-runtime.sh`) and needs
nothing installed beyond the container tool the repo already requires.

```sh
# index (one invocation per mirror, see git/search-references.mjs)
podman run --rm \
  -v "$HOME/Downloads/references":/refs:ro \
  -v "$INDEX_DIR":/data/index \
  ghcr.io/sourcegraph/zoekt:latest \
  zoekt-git-index -index /data/index -repo_cache /refs \
    -submodules=false -branches 'HEAD' /refs/github.com/owner/repo.git

# serve (host network namespace ⇒ the agent container reaches it directly)
podman run --rm -p 6070:6070 \
  -v "$INDEX_DIR":/data/index \
  ghcr.io/sourcegraph/zoekt:latest
```

### Branch scope is the whole cross-branch story — and the cost dial

`zoekt-git-index` defaults to `-branches HEAD`, i.e. **the default branch
only**. Cross-branch requires naming the refs:

```sh
-branches 'HEAD,refs/heads/*'      # every local branch (mirrors have all upstream heads)
```

An indexed branch is stored, so index size scales with *sum of indexed branch
trees*, not repo size. Indexing all heads of all 775 mirrors — including the
kernel and IntelliJ — is neither the default nor normally wanted. The posture
is **opt-in, per repo**: pick a repo that looks interesting, then choose its
branch scope. The `--only`/`--exclude` globs (the same filter language as
`migrate`/`maintain`, via `git-lib.mjs`) are the selection mechanism:

- no selector — **nothing is indexed** (the tool refuses and says so).
- `--only 'github.com/duckdb/**'` (repeatable) — index exactly the interesting
  repos; this is the normal path, often with `--branches 'HEAD,refs/heads/*'`
  for the one repo being investigated.
- `--branches HEAD` (per-repo default) — baseline, one tree.
- `--branches 'HEAD,refs/heads/*'` — full cross-branch for a selected repo.
- `--all` — the explicit, deliberate whole-farm build; never the default.

`-submodules=false` is forced: the mirrors have no submodule object stores
(`non-bare-issues.md`, "Not handled"), so recursion would just warn per repo.

### Incremental updates fall out of the mirror lifecycle

`zoekt-git-index -incremental` (its default) only reindexes repos whose refs
moved. So the maintenance order is: `./git/maintain.sh` (fetch + repack +
commit-graph) → `./git/search-references.sh index` (reindex changed shards).
The two scripts stay separate because `maintain` must also work with no
container runtime available.

### Why not the alternatives

- **`git grep` / `rg` over worktrees** — no index, and `git worktree add` per
  ref materializes the whole tree (the 1.6 M-file problem, again).
- **Hound** — trigram index, but indexes one checkout/ref; no branch model.
- **livegrep** — fast, but a service you configure per-repo and it has no
  branch-aware shard model as clean as Zoekt's.
- **`git log -S`/`-G` pickaxe** — this is *history* search, not branch-tree
  search; it is the right tool for "when did this string change", accelerated
  by the commit-graph Bloom filters `maintain` writes, and is complementary.
  Zoekt holds one *snapshot per indexed ref*; pickaxe holds every commit.

## Layer 2 — semantic: blob-addressed chunk embeddings

Cross-branch semantic search naively means "embed every file on every branch",
which multiplies by branch count. Git already gives the deduplication primitive:
**a blob SHA identifies content, once**. The same file unchanged across 50
branches and 3 paths is one blob. So the index is built over the set of unique
reachable blobs, not over (path × ref):

```
unique_blobs = ⋃ over repos ⋃ over refs reachable blobs, deduped by SHA
```

Per repo, reachable blobs come from `git rev-list --all --objects` filtered to
type `blob` via `git cat-file --batch-check`. This is also exactly what makes
the index **incrementally maintainable**: after a fetch, only blobs whose SHA
is new need embedding, and a blob that merely moved branch or path does not.

### Pipeline

1. **Enumerate** unique blobs per mirror; skip binary by extension + a NUL-byte
   sniff; skip generated/vendored/minified paths by a denylist.
2. **Chunk** each blob language-aware (tree-sitter) with a line-window fallback;
   chunk identity is `(blob_sha, start_line, end_line)`.
3. **Embed** each chunk with a code-capable model served by llama.cpp
   (`/v1/embeddings`) — reusing the local inference stack
   (`llm-local-inference/`), so no API key and no data leaves the host. A small
   GGUF embedding model (e.g. `Qwen3-Embedding-0.6B` or
   `jina-embeddings-v2-base-code`) is enough for retrieval.
4. **Store** in one SQLite file via Node's built-in `node:sqlite` (verified:
   SQLite 3.53.4, FTS5 and `loadExtension` available on the repo-pinned
   Node 24) with the [`sqlite-vec`](https://github.com/asg017/sqlite-vec)
   extension:
   - `blob(repo, sha, size)`
   - `chunk(blob_sha, start_line, end_line, text, embedding)` — `vec0` virtual
     table for ANN + a plain `chunks_fts` FTS5 table for BM25
   - `occurrence(blob_sha, repo, ref, path)` — where a blob shows up
   A single file, no server, and BM25 + vectors + metadata in one query.

### Query flow (hybrid)

1. Lexical candidates from FTS5 (and/or Zoekt) — recall.
2. Vector kNN over chunk embeddings — intent recall.
3. Fuse (reciprocal-rank fusion), then map `chunk → blob_sha → occurrence` to
   report every `(repo, ref, path)` the hit appears on. That mapping is what
   makes a single embedded blob answer across all branches that contain it.

### Why not a general code-search service

Sourcegraph/Zoekt "semantic" at scale needs a hosted embedding farm; here the
whole point is a local, offline, single-file index over an existing bare farm.
Blob addressing is what makes that tractable — it removes the branch
multiplier before any GPU/CPU time is spent.

## Serving and agent integration

- Index dir: `$REFERENCES_INDEX` (default `~/Downloads/references-index/`),
  a sibling tree, never inside the farm (same reason mirrors live in their own
  root — `non-bare-issues.md`).
- The server binds a host port; the agent queries it over `workload_network
  host` (already set). **The farm is not mounted**, so the container-startup
  `z,U` cost does not come back.
- A future step is a thin in-container CLI/stdio shim that forwards to the host
  endpoint, so the agent can call it like a local tool.

## Tooling in this repo

### Acquiring a repo

`git/-forge-mirror.sh` is the bare-repo counterpart of the older, GitHub-only
`git/-github-clone.sh`: it mirrors ANY https git-forge URL straight into the
farm as `references/<host>/<path>.git`, keyed by host rather than a hardcoded
`github.com`, with the full path preserved (subgroups included) and a trailing
`.git` made optional:

```sh
./git/-forge-mirror.sh https://github.com/owner/repo.git
./git/-forge-mirror.sh https://codeberg.org/q3k/crowbar.git
./git/-forge-mirror.sh https://git.sr.ht/~whynothugo/pimsync          # no .git
./git/-forge-mirror.sh https://gitlab.com/group/subgroup/repo.git     # subgroups
```

It is idempotent — re-running aligns an existing mirror with
`remote update --prune` — and it only acquires; the pickaxe optimization stays
with `git/maintain.sh`, and indexing stays opt-in:

```sh
./git/-forge-mirror.sh https://codeberg.org/q3k/crowbar.git   # acquire
./git/maintain.sh --only 'codeberg.org/q3k/crowbar.git'       # optimize (commit-graph)
./git/search-references.sh index --only 'codeberg.org/q3k/crowbar.git'  # opt-in search
```

### Searching

`git/search-references.mjs` (+ `git/search-references.sh`), one script, three
subcommands:

```sh
./git/search-references.sh index [--only GLOB]... [--all] [--root DIR] [--index DIR]
                                 [--jobs N] [--branches REFS] [--max-depth N]
                                 [--exclude GLOB]... [--dry-run]
./git/search-references.sh serve [--index DIR] [--port N]
./git/search-references.sh query 'pattern repo:duckdb branch:main' [--server URL] [--json]
```

- `index` discovers bare mirrors with `findBareMirrors` (`git-lib.mjs`), then
  runs one `zoekt-git-index` container per SELECTED mirror, `--jobs` wide.
  Without `--only` (or explicit `--all`) it refuses — opt-in. `--dry-run`
  prints the exact `podman`/`docker` argv without touching anything, so the
  command shape is reviewable (and testable) on a host with no container tool.
- `serve` runs `zoekt-webserver` on `--port` (default 6070) over the index dir.
- `query` queries `<server>/api/search` (GET) when a server is up, else runs a
  one-shot `zoekt` CLI container, and prints JSON or the `repo:path:line:`
  stream.

## Non-goals

- Replacing `git log -S`/`-G` history pickaxe; that stays git's job and is
  already optimized by `maintain`.
- Indexing the non-git trees (`books-com.springer` 20 GB, `kiwix` 174 GB).
- Submodules / LFS object stores — absent from the mirrors by construction.
- Authentication/tenancy on the search server; it is a single-user local
  reference service.

## Open questions

- **Semantic storage currency**: whether to re-embed on every `maintain`, or
  only on demand per repo (embedding is the expensive step, unlike Zoekt's
  trigram build). Leaning: lazy — embed blobs the first time a repo is
  semantically queried.
- **Chunk granularity**: tree-sitter function-level vs fixed ~64-line windows.
  Function-level retrieves better but adds a grammar build per language; start
  with windows + language detection, revisit.
- **Promotion signal**: when does a repo "look interesting" enough to index?
  Today it is a human decision passed via `--only`. A later option is a
  content-addressed shard cache keyed by `(repo, ref-tip)` so re-indexing a
  previously-seen repo is a cache hit rather than a rebuild.

## Verification record

- Farm shape re-audited during this design: 775 bare mirrors discovered by
  `findBareMirrors` under `~/Downloads/references`; `git rev-parse
  --is-bare-repository` = true; `remote.origin.url` present. Note the mirrors
  land *in place* with a `.git` suffix, not at `maintain`'s default
  `references-bare` root — discovery by shape (`HEAD`+`objects/`+`refs/`) is
  layout-agnostic, which is why it already works.
- Measured: single-repo cross-tip `git grep` 0.4 s (ripgrep, 273 refs);
  farm-wide parallel `git grep` did not finish in 300 s → index required.
- Measured the semantic dedup premise directly (unique reachable blobs vs blob
  occurrences summed over each ref tip → the naive per-branch index size):
  `BurntSushi/ripgrep` 5,023 unique blobs vs 41,760 occurrences over 273 refs
  = **8.31×**; `duckdb/duckdb` 291,537 vs 574,657 over 65 refs = **1.97×**.
  Blob addressing removes that multiplier before any embedding runs.
- Verified upstream facts against source, not memory: `zoekt-git-index`
  defaults to `-branches HEAD`, has `-incremental` on by default, `-delta`,
  `-repo_cache`, `-submodules`; `zoekt-webserver` defaults `-listen :6070`,
  `-index`, `-rpc`, `-pprof`, serves `/api/search`; `ghcr.io/sourcegraph/zoekt`
  is a live multi-arch OCI image.
- Verified the semantic stack's dependencies exist on the repo-pinned Node 24:
  `node:sqlite` with FTS5 and `loadExtension`; `sqlite-vec` and
  `@lancedb/lancedb` published (sqlite-vec chosen for the single-file model).
