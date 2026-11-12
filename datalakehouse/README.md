---
id: datalakehouse
type: module-design
status: active
title: "datalakehouse — atuin history.db → MotherDuck via the duckdb CLI"
parent: architecture
references: [d046, d113, d139, d167, d179, d180, d181]
tags: [atuin, motherduck, duckdb, sync]
---

# datalakehouse

Syncs atuin's local `history.db` into the MotherDuck database `md:atuin`
(`main.history`) with the conventional duckdb CLI. The MotherDuck MCP server
stays what d046 scopes it to — connection info, one-off queries, docs — and the
scheduled path itself is a plain shell script plus a duckdb binary, delivered
through the repo's toolchain and vault chain (`./environment.sh`).
The coding-harness session sources (pi, OpenCode, ThinkRail, mistral-vibe)
are not synced; d167 records their persistence formats and the
guaranteed-fields storage shape their readers will land in. The session
collection leg, its read side, its ingest route and its postmortem sweep span
d179 to d184.
Mistral-vibe support is pending in both this unit and `coding-agent/run.mjs`.

## Usage

```sh
./dev-tools.sh duckdb                          # once per host: pin the MotherDuck-compatible duckdb
./environment.sh ./datalakehouse/atuin-warehouse-sync.sh [--prune] [--print-source] [path]
```

- `path` — a `history.db` file, or a directory containing one. Optional: with
  no argument the script resolves the source itself (order below).
- `--print-source` — resolve and print the source path, then exit; needs no
  token, so it is also the debugging entry point.
- `--prune` — mirror source deletions into the warehouse. Default runs are
  upsert-only.
- Environment: `motherduck_token` (canonical; `MOTHERDUCK_TOKEN` is accepted
  too), `ATUIN_WAREHOUSE_DB` (target `md:` database, default `atuin`), and the
  atuin/XDG variables below for source discovery only.
- Exit codes: `64` usage, `66` no source found, `69` duckdb outside the
  supported range, `3` source has no `history` table.

### Source resolution

The resolution mirrors atuin's own precedence so an unattended run needs no
argv; the first existing file wins:

1. the explicit argv — which never falls back, because naming a path that is
   not a file must fail rather than silently mirror a different host's history;
2. `$PWD/history.db`;
3. `config.toml`'s `db_path`, else `data_dir/history.db`, with the config file
   found in atuin's own order (`ATUIN_CONFIG_DIR`, `ATUIN_HOME`,
   `~/.atuin/config.toml`, the legacy XDG config dir);
4. atuin's `unconfigured_data_dir` rules: `ATUIN_HOME/data` when `ATUIN_HOME`
   is set, else `~/.atuin/data` when that directory exists, else the first
   existing legacy directory (`$XDG_DATA_HOME/atuin`, `~/.local/share/atuin`),
   else `~/.atuin/data`.

**Deviations:** the mirror reproduces precedence, not toml semantics. A value
inside `config.toml` receives no shell or environment expansion (a leading
`~` is expanded), and a relative path is used as given. A host whose config
relies on those must pass the path explicitly.

### Coding-harness sessions

```sh
./environment.sh ./datalakehouse/agent-warehouse-sync.sh \
  [--session-dir DIR] [--agent-dir DIR] [--spool FILE] [--dry] [--print-rows] [--report-orphans]
./environment.sh ./datalakehouse/agent-warehouse-daemon.sh   # the write-only ingest route
```

The sync is the postmortem sweep of d184: it walks the pi session root and the
agent dir's delegation/ directory, promotes each transcript's guaranteed fields
and keeps every entry verbatim in a JSON payload column, and upserts into
`md:agent` (`mdw.pi.session`, `mdw.pi.entry`). No ThinkRail field is stored
(d183). The resolver, `--print-roots`, `--dry`, `--print-rows` and
`--report-orphans` need no token, and resolution precedes the vault round-trip
exactly as the atuin sibling's does.

The daemon is the host-side, write-only `POST /ingest/session` sink of d181: no
read-back and no delete, appending to the same spool the sync already reads, so a
sandbox hands over events without holding write access to the archive.

The daemon runs in the foreground and does not fork itself; backgrounding is the
orchestration layer's job. Its dedupe is a conditional insert (`INSERT OR IGNORE`
against a SQLite primary key), so a re-posted row is skipped durably and the sync
re-posting every run appends nothing new. Identity is the transcript's own **session id** (pi's header id) and, per entry,
the entry id; the file path is stored as a location attribute, never as the key,
because the same session has a different path inside a sandbox and on the host.
A pi header is recognized by its `type`, not its line position, so a file that
concatenates two sessions splits back into two by their own ids.

**The route is the sync's default
transport** — `http://127.0.0.1:8787` or `AGENT_WAREHOUSE_ROUTE` — needing no
token and no duckdb; `--direct` is the alternative that uploads straight to
MotherDuck.
`--rm` removes a processed file only after the transport ack, and only when the
file is older than `AGENT_WAREHOUSE_RM_GRACE` seconds (default 300); it is meant for
postmortem runs and the historical pile, never for a live session, and a
just-modified file is kept and reported as possibly live.
**A direct run clears the consumed spool**: it rotates the tail before reading it
and deletes the frozen copy after the ack, independent of `--rm` (which governs the
session files). A **route** run never touches the spool, because it has folded
nothing into the warehouse, and a `--dry` or report run has no side effect.
The roots are searched **recursively** for `*.jsonl`, so `--session-dir` may
point at any tree: pi's `--<cwd>--/` shape is not assumed, and a historic pile with
sessions at mixed depths (or several `agentcontainer-<ts>` revisions) is read as-is.
A `.jsonl` whose first line is not a pi session header is **skipped** (another
tool's stream, such as mistral-vibe's `messages.jsonl`, or a fragment), so it
contributes no rows and is never a `--rm` candidate.
The route post is batched under `AGENT_WAREHOUSE_BATCH_BYTES` (default 4 MiB) so a
row's large content array cannot overflow the daemon's `AGENT_INGEST_MAX_BODY`
(default 8 MiB) in a single request.

## What gets synced

`main.history` in `md:atuin` carries the source's columns — the base eight plus
`deleted_at`, `author`, `intent`, `shell`, `author_kind` as the installed atuin
build provides them. Timestamps become real `TIMESTAMP`s (the source stores
epoch nanoseconds; `duration` becomes seconds), `exit`/`author_kind` become
`BIGINT`. Rows upsert by `id`; a source column the warehouse lacks is added by
`ALTER TABLE` before the insert, so an atuin upgrade widens the target instead
of failing the run.

## The rest of the atuin data dir

Worth assessing before claiming "complete sync" — the files that sit beside
`history.db` in the atuin data directory:

| file                     | contents                                                                  | warehouse verdict                                                                    |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `history.db`             | command history — the queryable payload                                   | synced (this tool)                                                                   |
| `kv.db`                  | plain-text sync key/value metadata (`namespace`, `key`, `value`)          | cheap to add as text; low analytic value — atuin bookkeeping, not history            |
| `meta.db`                | plain-text server/URL bookkeeping                                         | same — tiny, optional                                                                |
| `records.db` (+`store`)  | sync records; `data`/`cek` are paseto-encrypted blobs, metadata plaintext | metadata-only value; bulk is unqueryable without atuin's keys — skip by default      |
| `threads.db`             | AI threads table (newer builds)                                           | revisit when the local build ships it                                                |
| `octavo.db`              | AI embedding blobs                                                        | blob bytes — same reasoning as `records`                                             |
| `key`, `output-capture/` | identity key material, captured output attachments                        | never synced: key material must not travel to the warehouse; captures are file blobs |

Verdict: `history.db` is the file with queryable columns and the reason for
the warehouse. `kv`/`meta` are a five-minute addition if provenance matters;
`records`/`threads`/`octavo` earn nothing analytic until decryption happens
somewhere, and `key`/`output-capture` stay out by design.

## Verified findings

- MotherDuck's extension accepts duckdb **v1.4–v1.5** (docs give
  1.4.1–1.5.6); a v2.x client is refused at load. The script checks
  `duckdb --version` first and points at `./dev-tools.sh duckdb`, because the
  extension's own error names no fix.
- `ATTACH '<path>' (TYPE sqlite, READ_ONLY)` reads a **live** atuin
  `history.db` without blocking its WAL — a full sync runs against a working
  shell.
- The `history` table grew columns across atuin releases (`deleted_at` 2023,
  `author`/`intent` 2026, `shell` 2026, `author_kind` 2026), so the target
  schema is derived at runtime from `duckdb_columns()`, never hardcoded.
- Two MotherDuck identities that both resolve `md:<name>` hold **different**
  databases: a vault token and an MCP login must be one account (or the
  databases must be named apart), or each side reads its own empty copy while
  both report success.
- MCP `query({database})` reads a database created moments earlier only after
  `list_databases` refreshes the session's list; without it the query falls
  back to the default database and reports a missing table.
- An MCP query after account or database surgery can hit a stale catalog —
  the immediate retry succeeds; treat a `schema does not exist` on a
  just-written table as that staleness, not as data loss.
- End-to-end: fixture runs cover create, re-run upsert, an atuin-style
  `ALTER`-add-column drift, and prune; the resolution order has its own
  `tests/resolve-source.sh` (no token, no network).

## Assumptions

- The source is a single host's local `history.db`; atuin's remote sync
  (`records`) is out of scope.
- `id` is the warehouse primary key — atuin's own history id.
- The warehouse `main.history` outlives any one host, which is why deletion
  mirroring is opt-in: a partial or stale source must not silently erase
  history that exists nowhere else.

## Gotchas

- The coding-agent container bind-mounts the repo and the reference store
  only — the host's `~/.local/share/atuin` is invisible there. Run the sync
  on the host, or pass a path the container can see; `--print-source` shows
  what each environment resolves.
- `--prune` against a partial source erases everything the source does not
  cover; state "this source is authoritative" before using it.
- Token delivery is the one vault round-trip (`./environment.sh`); the script
  reads plain env and never loads secrets itself (d046).
