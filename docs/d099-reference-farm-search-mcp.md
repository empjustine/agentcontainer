---
id: d099
type: decision
status: proposed · amended: the strictly-read-only posture narrowed to two serialized maintenance verbs (upsert/compact)
title: "d099 — reference-farm code search as an MCP server: capped read surface, two serialized maintenance verbs, host-side"
parent: architecture
depends-on: [d043, d075]
references: [git-non-bare-issues, d044, d046b, d061, d076]
tags: ["git", "references", "search", "mcp", "tooling", "safety"]
---

# d099 — reference-farm code search as an MCP server

**Status: proposed — nothing is built yet.** This record is the plan for the
agent-facing search surface over the reference farm
(`~/Downloads/references`): an MCP server that exposes a **safe, capped**
API for code search over the bare mirrors plus exactly **two maintenance
verbs** — `upsert_repo` and `compact_repo`, serialized by one shared mutex
(the maintenance surface). The first draft of this plan was strictly read-only; it is
**amended**: the safety posture narrows from "no writes at all" to
"no writes outside the two verbs, never more than one mutation in flight".
`git/non-bare-issues.md`
owns why the farm is bare mirrors,
[d043](d043-cross-repo-reference-search.md) owns the search *engines*
(Zoekt lexical, planned embeddings); this record owns the *tool surface* an
agent actually calls.

A precondition landed alongside this plan: the farm is now **uniformly bare
mirrors**. The four legacy non-bare checkouts (`github/webrecorder/*`, the
`-github-clone.sh` era layout) were re-acquired with `./git/-forge-mirror.sh`
into `github.com/webrecorder/*.git` and deleted, so discovery never meets a
working tree again. (The old clones remembered a handful of upstream-*deleted*
branches — merged PR, dependabot and a rewritten `gh-pages` — which the
mirror prunes by design; nothing un-pushed was lost.)

## Problem

The agent's recurring research question is *"where is X implemented / named /
shaped, anywhere in my references?"* — over ~1,174 bare mirrors spanning a
dozen forges (`github.com`, `codeberg.org`, `git.sr.ht`, GitLab subgroups,
Savannah, …), offline. None of the available answers is acceptable:

- **Bind-mounting the farm is dead**: the mirrors have no working tree to
  point `rg` at, and the mount itself was dropped for the podman `z,U`
  relabel walk (`git/non-bare-issues.md` measured ~39 s per launch).
- **Live `git grep` farm-wide does not finish**: d043 measured a
  16-way-parallel all-ref-tip grep not completing in 300 s against this farm
  (intellij-community alone is 6.2 GB). Single-repo greps are fast (0.4 s);
  the *scope* is the problem, not the tool.
- **Raw Zoekt HTTP is not an agent API**: its JSON is index-shaped, uncapped,
  and only covers repos somebody bothered to index (indexing is opt-in by
  design — d043's scope ladder). An LLM hand-building query strings against
  it gets unbounded result sets into its context and no file-reading
  follow-up.
- **Handing the agent raw `git`** (a generic bash tool) pushes every
  injection, config-execution and resource question to be re-solved ad hoc on
  every call, by the least trustworthy party in the loop.

What is missing is one query surface, safe **by construction**, that works
for indexed and unindexed repos alike and returns results shaped for an agent
to act on.

## Decision

A small MCP server, `git/search-mcp.mjs` behind a `git/search-mcp.sh` shim
(node via `../lib/node-run.sh`, `@modelcontextprotocol/sdk`), speaking
**streamable HTTP on loopback only** (`127.0.0.1:6071` — beside Zoekt's
6070). Host-side for the same reason d043's servers are:
`coding-agent/run.sh` runs the agent with `workload_network host`, so a
host-side loopback server is reachable with **no bind mount and no `z,U`
walk**, and the farm never re-enters the sandbox.

**Placement in `git/`** rather than a new folder: the server needs exactly
the discovery and filter language `git-lib.mjs` already owns
(`findCloneRoots`, `--only`/`--exclude` glob semantics). A sibling folder
may not reach into another (docs/architecture.md's standalone rule), so a new
folder would force a copy of `git-lib.mjs` — the copy idiom exists for
genuinely standalone units, and this is farm tooling like the rest of `git/`.

The server is **started explicitly and runs in the foreground** —
`./git/search-mcp.sh` — like every operator-visible service here. No
background timer installs itself (the `git maintenance start` rejection,
non-bare-issues.md). One program, two fronts is a later option: a stdio
transport for the bare-host `pi` path (`./lib/environment.sh pi`) shares
everything but the transport.

### Tool surface

Seven read tools — read-only and capped — plus the maintenance surface
(the next section). Identifiers are farm-relative mirror paths with the `.git`
stripped — `github.com/webrecorder/browsertrix` — the namespace
`-forge-mirror.sh` already keys the farm by.

| tool | answers | backed by |
|---|---|---|
| `list_repos(filter?)` | what exists: repo id, upstream URL (`remote.origin.url`), default branch, ref count | farm scan (`git-lib.mjs` discovery) + process-lifetime cache |
| `list_refs(repo)` | which branches/tags to pin | `git for-each-ref` |
| `search_code(query, repos?, path_glob?, fixed_string?, max_matches?)` | where is this text/regex | `git grep` (scoped) → Zoekt (wide, indexed) |
| `search_paths(glob, repos?)` | which files exist by name | `git ls-tree -r` |
| `read_file(repo, rev, path, offset?, limit?)` | what the code says | `git cat-file` |
| `search_history(query, repos?, path_glob?, since?)` | when/where did this change | `git log -S/-G` (phase 3) |
| `diff(repo, rev_a, rev_b, path_glob?)` | what changed between | `git diff` (phase 3) |

**Result contract** — what makes the output agent-shaped rather than
index-shaped:

- every hit carries `repo`, `commit_sha`, `path`, `line`, and a few lines
  of context; results are **pinned to a SHA**, so a mirror updating
  mid-session cannot make a citation lie.
- every list/match response carries `truncated: true` plus a **cursor** when
  caps cut it off — capping must be visible, never silent.
- `read_file` is chunked (offset/limit, byte-capped) — reading one file must
  not drag a vendored bundle into context.
- `search_code` prefers `fixed_string: true` semantics unless the caller
  opts into regex.

### Maintenance surface — two verbs, one at a time

The two mutation verbs **wrap the existing operator scripts** instead of
constructing git maintenance argv themselves. Acquisition and maintenance
mechanics stay in one home each — the scripts' URL validation, cleanup
traps, fetch pacing and d089's deep sequence are not worth a second
implementation that can drift:

| tool | runs | notes |
|---|---|---|
| `upsert_repo(url)` | `./git/-forge-mirror.sh <url>` | add OR align: a new mirror is cloned, an existing one gets `remote update --prune` — the script is already idempotent, https-only, path-safe and non-interactive (d075) |
| `compact_repo(repo, mode?)` | `./git/maintain.sh --only '<repo>.git' --no-fetch` + `--deep-optimize` when mode is `deep` | exactly one repo per call; `optimize` = repack `-adb --write-bitmap-index` + commit-graph write, `deep` = d089's `gc --aggressive` then the optimize re-run |
| `maintenance_status()` | — | observability for the queue: what holds the mutex, since when, what is queued behind it |

Three properties carry the weight:

- **One shared mutex, mutation-vs-mutation only.** An exclusive in-process
  mutex is held for the whole child run; a second mutation call queues
  (`maintenance_status()` makes the queue visible) instead of stacking a
  second disk-filling repack or a competing fetch beside the first. Reads do
  **not** take the mutex — git's own locking keeps readers safe during
  repack/gc, and search is the hot path. Letting the farm's heaviest I/O
  primitives overlap is exactly the clown-car failure this design refuses.
- **The mutex has a cross-process half.** The operator can still run
  `./git/maintain.sh` by hand while the server lives, so both script entries
  take a farm-level advisory lock (`flock(1)`) for the run's duration —
  one mutation on the farm no matter which entry point started it. This is
  the one change to existing tooling the plan requires (and it must reach
  the native-Windows entry too, d062 — mechanism open).
- **`upsert_repo` is the only network egress**, and only toward the URL the
  call itself named: the script's https-only, domain-host, owner/repo-shape,
  no-traversal checks are the validation (the safety posture), and the fetch queue honors
  maintain-mirrors.mjs's per-host pace — one home for the number, d044's
  rate-limit lesson, d076.

Mutation calls deliberately diverge from the read deadline (the safety posture): a deep
repack of a 6 GB mirror is hours-scale *by nature*, so they carry a separate
generous budget and stay cancellable — killing the child process group is
safe because git's mutation primitives are crash-safe: a killed repack or
fetch leaves the mirror valid and the next run redoes the work.

### Backends — one surface, a rung ladder

The tool names are stable; which engine answers is a scope decision:

1. **Live `git grep`** when the repo filter narrows to a bounded set
   (dozens of mirrors): correct, current, needs no index. This is the normal
   call — the agent usually knows roughly which corner of the farm it wants.
2. **Zoekt** (d043's layer 1, `git/search-references.mjs`) for wide or
   cross-branch queries over indexed repos — the only rung that survives a
   farm-wide scope. A query that would fan out past the live-grep bound and
   has no `wide: true` opt-in is refused with the count, not attempted.
3. **Pickaxe** (`git log -S/-G`, phase 3) for history questions, defaulting
   to path-limited so the commit-graph Bloom filters apply
   (non-bare-issues.md's pickaxe notes).

### Safety posture — the reason this record exists

"Safe" means: **nothing executed, nothing sent except the one sanctioned
fetch, no write outside two serialized verbs, bounded on every axis.** Each
rule below exists because the opposite has a concrete failure mode against a
farm of *mirrored third-party code*.

**Read-only *search*; mutation is exactly two verbs.** The argv builder
allowlists read-only plumbing verbs — `grep`, `ls-tree`, `cat-file`, `log`,
`diff`, `for-each-ref`, `rev-parse` — for everything the seven read tools
touch. The mutating verbs (`clone`, `remote update`, `repack`, `gc`,
`commit-graph`) are reachable from **no tool handler at all**: they run
inside the two wrapped scripts (the maintenance surface), which the server invokes as plain
child processes and never composes argv for. No checkout, config or
update-ref exists anywhere, not even "helpful" ones. A test enumerates every
git verb reachable from tool handlers and pins the split: reads hit the
allowlist, mutation exists only behind `upsert_repo`/`compact_repo`.

**Git is spawned as argv arrays, never a shell string**, and user input
cannot become an option: revs are validated (reject anything `-`-leading or
not refspec-shaped — `git check-ref-format`), patterns go through `grep -e`,
pathspecs come after `--` with `--literal-pathspecs`, and `--end-of-options`
separates operands. The classic injection payloads (`--upload-pack=…` as a
rev, `-c` as a path) are inert by construction — and fuzzed (see Verification).

**Git config cannot execute anything.** Repo configs are third-party
artifacts; git will happily run `core.pager`, `diff.external`, textconv
drivers, or an alias named in one. Every command runs with a scrubbed
environment on top of d075's non-interactive posture
(`GIT_TERMINAL_PROMPT=0` & co.): `HOME` pointed at an empty scratch dir,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_OPTIONAL_LOCKS=0`, `-c core.fsmonitor=false`, and `--no-textconv`
where the verb has it. The load-bearing idea: the server must be unable to
run code named inside the data it searches.

**Every axis is bounded.** Per-call deadline with process-group kill (a hung
`git` must not wedge the server); a fixed worker pool over mirrors (fan-out
is never one process per repo); per-repo and global match caps; byte caps on
reads; a concurrent-call limit per client. Regex DoS is the one axis a cap
cannot catch *after* the fact, hence fixed-strings as the default and
vetted-regex as the opt-in. The one deliberate exception is the mutation
budget (the maintenance surface): bounded but generous, cancellable, and never concurrent.

**Transport: loopback, unauthenticated — and why that is the line.**
Streamable HTTP bound to `127.0.0.1` only. There is no auth because there is
nothing to authorize: the surface is read-only over local reference
material, and any client already on this machine can `git grep` the farm
directly. The decision reverses the moment the listener is not loopback —
that requires an authenticated front (the d091 pattern) or staying inside
the tailnet ACL model, and is explicitly not designed here.

**No network except `upsert_repo`.** The read surface makes no outbound
connections — "a query cannot cause a fetch" stays a product goal and a
safety property. The one egress is the forge fetch inside `upsert_repo`'s
wrapped script, and only toward the validated https URL the call itself
named: the script's checks (https-only, domain host, `owner/repo` shape, no
`..`/fragment/query) are what kill `ext::`, `ssh://`, `file://` and option-shaped
payloads before git ever sees them.

**Tool descriptions are static; results are data.** Per the d046b posture:
descriptions are operator-authored constants (never derived from repo
content), and tool output never contains instructions — mirrored READMEs and
commit messages arriving via `read_file` are untrusted third-party text, the
same posture d061 stamps on remote MCP entries.

## Consequences

- **Wide search without Zoekt is refused, not slow.** Once the live-grep
  bound trips, the answer is "narrow the filter or index the repos"
  (`./git/search-references.sh index --only …`). The alternative — silently
  minutes-long fan-outs — is what d043 measured and rejected.
- **Caps make pagination the normal path.** Agents must handle cursors and
  `truncated` flags; that is deliberate (a capped answer beats a context
  flood).
- **Registration is staged.** The first `coding-agent/mcp.json` entry
  (d061) stays manual; a committed default row follows only once the surface
  is stable — a dead loopback entry erroring in every session is worse than
  one line of operator setup.
- **The farm's uniform bare shape is now load-bearing for discovery** —
  guaranteed by the webrecorder migration this plan shipped beside. If a
  non-bare clone is ever added again (the legacy `-github-clone.sh` path),
  `list_repos` must classify it rather than assume; today it can assume.
- **Freshness is now self-serve — and the farm lock is the arbiter.**
  `upsert_repo`/`compact_repo` mean a session can acquire and optimize what
  it finds missing without the operator leaving the terminal; the farm-level
  advisory lock (the maintenance surface) keeps that self-service from ever colliding with a
  hand-run `./git/maintain.sh` sweep. d076's by-host scheduling is unaffected —
  the sweeps remain the bulk path, the verbs are the single-repo path — and
  SHA pinning still makes staleness visible instead of racy.
- **One home for each mechanic.** The MCP verbs wrap
  `-forge-mirror.sh`/`maintain.sh` rather than reimplement them, so acquisition
  validation, cleanup traps and d089's deep sequence change in exactly one
  place — and a behavior difference between "operator runs the script" and
  "agent runs the tool" is a bug by construction.

## Not decided here

- **The non-git corpora** (Springer PDF/EPUB, Kiwix ZIM): different formats,
  different failure modes, and keeping v1 to one file format is itself a
  safety property. Separate tools if ever.
- **The semantic layer** (d043's layer 2 embeddings): stays its own plan;
  its tools would slot into this surface later.
- **A third mutation verb.** The mutation surface is closed at two: another
  write/fetch verb amends this record first. The obvious candidate is Zoekt
  shard indexing (`search-references.sh index`) — it shares the disk-filling
  I/O profile and would join the same mutex — but d043's opt-in indexing
  posture keeps it out for now.
- **A job/poll split for mutations.** Blocking with a generous budget is the
  simple model (the maintenance surface) and crash-safe to interrupt; if harness-side tool
  timeouts make it untenable in practice, start/poll job handles are the
  escape hatch — not designed here.
- **Non-loopback exposure and its auth story** (the safety posture states the reversal
  condition).
- **A persistent repo manifest** (SQLite): the on-demand scan with a
  process-lifetime cache is enough for 1,174 configs; a manifest earns its
  complexity only if discovery ever costs real time.

## Verification (when implemented)

- **Injection fuzz**: `-`-leading revs/patterns/paths, embedded `--`,
  option-shaped blobs at every parameter position — all inert or rejected.
- **Cap enforcement**: a runaway query returns `truncated` + cursor within
  the deadline; the deadline kill reaps the whole process group; concurrent
  calls queue, not pile up.
- **Verb-surface assertion**: a test enumerates every git verb reachable
  from tool handlers — the read allowlist everywhere, the mutating verbs
  only inside the two wrapped scripts — and a read-only session leaves the
  farm byte-identical (and lock-free — `GIT_OPTIONAL_LOCKS` doing its job).
- **URL fuzz on `upsert_repo`**: `ext::`, `ssh://`, `file://`, `..` segments,
  option-shaped first arguments — all rejected before git runs.
- **Mutex serialization**: N concurrent mutation calls (and a hand-run
  `maintain.sh` beside the server) produce strictly one mutation in flight;
  `maintenance_status()` reflects the queue; a cancelled mutation leaves a
  valid mirror.
- **No-network check**: a read-only test session with networking
  unconfigured fails nothing, because nothing on the read surface dials out.
- **SHA pinning**: a hit cited from `search_code` is readable via
  `read_file` at the same `commit_sha` even after the mirror moves.
