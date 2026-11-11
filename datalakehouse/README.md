---
id: datalakehouse
type: module-design
status: active
title: "datalakehouse — atuin history.db → MotherDuck via the duckdb CLI"
parent: architecture
references: [d046, d113, d139]
tags: [atuin, motherduck, duckdb, sync]
---

# datalakehouse

Syncs atuin's local `history.db` into the MotherDuck database `md:atuin`
(`main.history`) with the conventional duckdb CLI. The MotherDuck MCP server
stays what d046 scopes it to — connection info, one-off queries, docs — and the
scheduled path itself is a plain shell script plus a duckdb binary, delivered
through the repo's toolchain and vault chain (`./environment.sh`).

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
