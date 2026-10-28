---
id: atuin-litestream-study
type: research
status: current
title: "Study: benbjohnson/litestream backup + best-effort sync for atuinsh/atuin (incl. OCI MySQL / Oracle 19c verdict)"
parent: architecture
tags: ["atuin", "litestream", "sqlite", "backup", "sync", "oci"]
---

# Study — litestream backup & best-effort sync for atuinsh/atuin

One-off investigation, unrelated to the runner infrastructure that owns this
repo. Question asked: what is necessary to (a) back up atuinsh/atuin databases
with benbjohnson/litestream, and (b) keep them synchronized on a best-effort
basis (no HA, no realtime). Follow-up: can a self-hosted `atuin-server` use
the two free Oracle OCI RDBM types (Oracle MySQL, Oracle Database 19c) as its
target database.

Sources: DeepWiki codebase Q&A on `benbjohnson/litestream` and
`atuinsh/atuin` (third-party generated docs — verified for internal
consistency, not against a local build).

## Verdict summary

| Goal | Feasible | How |
|------|----------|-----|
| Litestream backup of atuin client DBs | **Yes** | All six client DBs are SQLite/WAL; one `dbs:` entry each |
| Litestream backup of self-hosted `atuin-server` DB | **Yes, if SQLite** | `db_uri = sqlite://…`; single-file, single-writer — ideal Litestream workload |
| Best-effort multi-machine sync via Litestream | **Marginal** | One-way only: primary replicates, followers `restore -f`; follower writes are lost on next restore |
| Multi-machine sync done right | **Yes** | Atuin's native sync (Sync v2) — hosted or self-hosted server; Litestream then only backs up the server DB |
| Oracle MySQL as atuin-server DB | **Yes (tier-two)** | Supported since v18.21.0 via sqlx-mysql; issues deprioritized |
| Oracle Database 19c as atuin-server DB | **No** | sqlx has no Oracle backend; `DbUrl` enum = {Sqlite, Postgres, Mysql} only |
| Litestream with MySQL/Oracle | **No** | Litestream is SQLite-only by design (source: SQLite WAL; targets: object/file storage) |

## Litestream facts (verified against the codebase)

- **Model**: strictly one-way primary→replica. A `DB` monitors the SQLite
  WAL, emits LTX (Litestream Transaction) files; a `Replica` uploads them.
  Experimental VFS write mode is still single-writer with conflict detection —
  not multi-master sync.
- **Targets**: `s3://` (AWS + R2/B2/MinIO/Spaces auto-detected), `gs://`,
  `abs://`, `oss://`, `file://`, `sftp://`, `webdav://`,
  `nats://` (JetStream object store). Notably *not* any SQL RDBMS.
- **Cadence defaults**: 24h snapshots; L1/L2/L3 compaction at 30s/5min/1h; L0
  retention 5min (checked every 15s). All configurable in `litestream.yml`.
- **Daemon**: `litestream replicate` (server mode; `-once` for one-shot
  sync). Restore: `litestream restore [-o PATH] [-timestamp T | -txid X]`;
  `-f` follow mode keeps applying new LTX files after the initial restore
  (`--follow-interval`, default 1s) — the closest thing to a "sync follower".
- **Concurrency contract**: sets `journal_mode=wal` and
  `wal_autocheckpoint=0`; holds a long-running read transaction to block
  foreign TRUNCATE checkpoints; creates internal `_litestream_seq` /
  `_litestream_lock` tables. External apps may write concurrently in WAL
  mode. If another process nevertheless truncates the WAL (salt mismatch),
  Litestream re-syncs via a full snapshot — self-healing, with churn.

## Atuin client — what needs backing up

Six SQLite databases, all WAL mode (`sqlx` + WAL everywhere), under
`~/.local/share/atuin/` (path overrides: `ATUIN_DB_PATH`,
`ATUIN_KV__DB_PATH`, `ATUIN_SCRIPTS__DB_PATH`, `ATUIN_AI__DB_PATH`,
`ATUIN_META__DB_PATH`, plus `db_path` in `config.toml`):

`history.db` (shell history) · `records.db` (encrypted record store, the
sync substrate) · `kv.db` · `scripts.db` · `ai_sessions.db` ·
`meta.db`.

Backup config shape — one entry per file:

```yaml
dbs:
  - path: /home/me/.local/share/atuin/history.db
    replicas: [{ url: s3://bucket/atuin/history }]
  # …records.db, kv.db, scripts.db, ai_sessions.db, meta.db
```

**Known interaction**: Atuin's `Sqlite` wrapper bounds WAL growth via
`journal_size_limit` + a periodic compactor that calls
`PRAGMA wal_checkpoint(TRUNCATE)` with retries. While Litestream holds its
read lock those checkpoints come back busy (harmless); one slipping through
during Litestream's own checkpoint window triggers a full snapshot. Works,
expect occasional churn. Avoid NFS for both DB and replica staging.

## Atuin native sync (the "keep in sync" answer)

Sync v2, client-server, end-to-end encrypted; the server is a ciphertext relay.

- **Data model**: everything (history, kv, scripts) is a *record* in
  `records.db`, belonging to a series keyed by `(HostId, RecordTag)` with a
  monotonically increasing `RecordIdx` (sync version).
- **Flow**: client reads its local `RecordStatus` (highest `RecordIdx` per
  series), fetches the server's, and diffs per series into
  `Upload`/`Download`/`Noop`. Bulk transfers use compressed *packfiles*.
  Key endpoint: `/api/v0/record/next` (+ `/api/v0/me`, `/api/v0/store`).
- **Encryption**: `paseto_v4`; root key (BIP39 mnemonic or raw entropy, at
  `key_path`) wraps a random per-record content-encryption key; record
  metadata is authenticated as PASETO implicit assertions. The server stores
  ciphertext + index coordinates only. Client verifies its key against the
  remote index before syncing (`SyncError::WrongKey` otherwise).
- **Cadence**: automatic per `sync_frequency`; daemon worker skips when
  logged out; `atuin sync` forces it.

## Accounts on a self-hosted server

- **Registration**: `atuin register -u -e -p` → `/register`, gated by
  `open_registration` in `server.toml` (**default `false`**). Pattern:
  enable, register, disable. Optional `register_webhook_url` notifies on
  signups.
- **Passwords**: Argon2 hashes (`hash_secret`/`verify_str`). The password
  only guards server access — the client-side key protects the data, so a
  server compromise leaks nothing.
- **Sessions**: server-issued token, sent as `Authorization: Token <token>`,
  validated against the sessions table in the server DB.
- **Self-service**: `atuin account change-password` (needs current password),
  `atuin account delete` (wipes server-side records).
- **Admin gap**: no admin CLI for listing users or password resets; fix in the
  server DB directly or delete/re-register. A re-registered account cannot
  read old history unless the original client key is reused (E2E encryption).

Self-hosting shape: Docker `ghcr.io/atuinsh/atuin` (pin tagged releases) or
systemd; no built-in TLS — terminate at a reverse proxy (passwords transit the
wire); optional metrics on `127.0.0.1:9001`.

## Litestream against the server DB

With `db_uri = sqlite:///data/atuin-server.db` (`ATUIN_DB_URI` also works;
file auto-created): single file, single writer, WAL mode,
`retry_while_locked` backoff for `SQLITE_BUSY` — the ideal Litestream
workload. Same TRUNCATE-checkpoint caveat as the client (the server runs the
same `Sqlite` compactor). Restores also restore the sessions table — old
tokens stay valid post-restore; clear sessions if that matters. Litestream
must run on the same host as the DB file (mounted data dir for containers).

## OCI RDBM verdict (final verification)

- **Oracle MySQL — usable.** `atuin-server` grew a MySQL backend in v18.21.0
  (`sqlx-mysql` 0.9.0, `DbUrl::Mysql`; `db_uri = mysql://…` or
  `ATUIN_DB_URI`). It is **tier-two**: supported, but bugs are deprioritized
  vs Postgres/SQLite. No code-level statement pins a version; no `RETURNING`
  support — inserts fall back to `last_insert_id()` (transaction-wrapped
  where atomicity matters). Works with Oracle's MySQL; MariaDB untested
  upstream. **But**: MySQL disqualifies Litestream (SQLite-only), and an OCI
  MySQL Database Service instance already ships managed automatic backups —
  Litestream's role disappears.
- **Oracle Database 19c — not usable.** Not in Atuin's `DbUrl` enum and not
  a sqlx backend at all (sqlx supports Postgres/MySQL/SQLite only); no
  `sqlx-oracle` anywhere in the dependency tree. `db_uri` cannot point at
  it without writing a new backend. Also irrelevant to Litestream for the same
  SQLite-only reason.

## Recommendation matrix

| Deployment | Sync | Backup |
|-----------|------|--------|
| Multi-machine, minimal effort | Atuin native sync (hosted api.atuin.sh) | none needed (server-side copies exist) |
| Self-hosted server, small scale | Atuin native sync | **Litestream** → object store (`sqlite://` backend) |
| Self-hosted server, larger scale | Atuin native sync | PostgreSQL + pgBackRest/WAL-g (Litestream N/A) |
| Server forced onto OCI MySQL | Atuin native sync | managed MySQL backups (Litestream N/A) |
| Single machine, no server, sync "via Litestream" | best-effort only: primary replicates, followers `restore -f`, **follower writes lost on restore** | Litestream over all six client DBs |
