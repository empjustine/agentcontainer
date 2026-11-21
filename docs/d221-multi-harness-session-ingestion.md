---
id: d221
type: module-design
status: draft
title: "d221 — multi-harness session ingestion: the source contract, the one sender, and the three readers still to write"
parent: datalakehouse
depends-on: [d167, d181, d217]
references: [d116, d148, d179, d182, d184, d203]
tags: ["datalakehouse", "sessions", "ingest", "spool", "opencode", "mistral-vibe", "motherduck"]
---

# d221 — multi-harness session ingestion

This record states what the session leg must satisfy to carry harnesses other
than pi, what the transport already does, and what each remaining reader has to
be. It is not the storage shape of one harness — d167 owns the per-source
formats and the promoted columns — and not the route contract, which d181 owns.
The reader is whoever writes the OpenCode or mistral-vibe reader, and whoever
next touches the sender, the sync's `--direct` leg or the ingest daemon.

## Status

The transport prerequisites are landed: the orchestration rows carry a `source`,
the sender routes by it, `--direct` delegates to the sender, and the daemon keys
a foreign row on its source. The readers are unwritten. Mistral-vibe still has no
launcher row in `coding-harness-persistence` (d167's pending leg).

## What is pi-shaped today

The route is not. A row reaching `POST /ingest/session` is stored verbatim in one
NDJSON spool (d181), and the daemon folds that spool at a byte ceiling (d217).

| layer         | pi-shaped part                                                   | why it binds                                                                                                             |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| sender        | `mdw.pi.session`/`mdw.pi.entry` DDL and two fixed staging shapes | it could only land pi's columns anywhere                                                                                 |
| sender + sync | `id: "spool-<line_no>"` for a row without an id                  | a rotated spool restarts the counter, so two unrelated rows collide on the upsert key and the second is silently dropped |
| sync          | a `.jsonl` whose first line is not a pi header is skipped        | deliberate: a foreign stream must not become junk rows (d184) — but it also means a vibe legacy session is invisible     |
| sync          | the sweep reads files, never a database or a store               | OpenCode is SQLite, the vibe unified store is JSON chunks                                                                |
| daemon        | `rowKey()` knew pi's identities only                             | two harnesses mint ids independently, so `(session_id, id)` alone collides across them                                   |

## The wire contract

A row posted to the route, or folded from the spool, is self-describing. Absent
`source` means `pi`, which keeps every row written before this contract valid.

| field        | who sets it    | rule                                                                                 |
| ------------ | -------------- | ------------------------------------------------------------------------------------ |
| `source`     | the producer   | `pi`, `opencode_v1`, `opencode_v2`, `vibe_legacy`, `vibe_unified`; absent means `pi` |
| `kind`       | the producer   | `session` or `entry`; omitted, the normaliser infers it (see below)                  |
| `session_id` | the producer   | the source's own session identity                                                    |
| `id`         | the producer   | the source's own entry identity; `message_id` is accepted as its stand-in            |
| `seq`        | the producer   | the source's order within the session, when the source has one                       |
| `payload`    | the normaliser | the row exactly as the source wrote it                                               |

Session detection is a disjunction, because three shapes already exist in the
wild: `kind == "session"`, `type == "session"` (pi's header, and d181's route
contract), or the canonical session row the sweep emits (`session_id` with no
`id` and no `payload`). Anything else is an entry.

## Decision

**One normaliser, one writer.** The sender owns every schema and every insert.
The sync's `--direct` leg concatenates what it parsed and hands it to the
sender instead of carrying a second copy of the DDL, the duckdb version gate and
the `ensure_db` retry. The gain is not line count: a foreign row folded through
`--direct` used to be forced into pi's shape, and one of the two writers had to
learn every new harness. d217 already says the sender is the only code that
writes to MotherDuck; this makes that true.

**A foreign row lands in a generic envelope; a reader's promoted shape comes
later.** d167 decides per-source tables (`vibe_entry`, `opencode_v1.*`) built
from fields each source guarantees. A reader that lands before its envelope would
either drop rows or force them into pi's columns, so the sender lands them in
`mdw.harness.session` / `mdw.harness.entry` — `source`, the identity, the order,
the source's own `type`/`ts`/`store`, and the row verbatim as `payload`. The
promoted shape d167 names is defined over those rows when its reader lands
(a view or a materialised table; the reader's landing decides, the names stay
d167's vocabulary). The envelope is the no-loss floor, never a second copy of a
promoted row: a promotion reads these rows rather than re-ingesting the source.

**Identity is generation-scoped, never line-scoped.** A row the producer did not
identify gets `spool-<spool-file-basename>-<line>`. The basename is what makes it
stable: the sender folds a frozen `spool.ndjson.rm.<pid>` under that name, so two
generations cannot mint the same key, while re-reading an interrupted run
reproduces it. A collision here is a silent drop (`ON CONFLICT DO NOTHING`,
d203), which is why the fix matters more than the duplicate a better-supported
fallback would cost.

**A foreign row is keyed with its source.** `rowKey()` in the daemon prepends
`source` for anything that is not `pi`, and accepts `message_id` as an entry id
(vibe legacy's tool rows carry none). The pi key format is unchanged on purpose:
a daemon upgrading in place must not re-accept a row its `seen.sqlite` already
holds.

## Requirements the readers must meet

- **Loss-free.** Every row the source holds becomes exactly one row of the
  envelope, with the source's own object verbatim in `payload` (d167's
  no-shredding). A field the reader does not understand is payload, not a drop.
- **Idempotent.** A re-run, an interrupted run and a run against a moved or
  rewritten store produce no duplicate and no silently dropped row, under the
  source's own identity.
- **Order is the source's, not the filesystem's.** Physical line numbers are
  meaningless for a chunked store; use the store's history index. For the legacy
  JSONL format, line order is the only timeline there is.
- **Version-gated.** A store that declares a format and a minor version is read
  only at a version this reader knows; a newer minor is refused loudly rather
  than parsed on a guess.
- **No secret files.** OpenCode's `auth.json`, ThinkRail's `installation.json`
  and `environment.json`, vibe's `.env` are excluded by path, never by editing
  rows (d167).
- **One transport.** A reader posts canonical rows to the route (no token, no
  duckdb, works inside a sandbox) or hands them to the sender for `--direct`.
  It owns no schema and no uploader.
- **A dry mode and a row dump.** `--print-rows`/`--dry` need no token, so a
  reader is testable against a fixture with no server.

## Work to be done

### OpenCode (`datalakehouse/opencode-warehouse-sync.sh`)

- **Input.** `OPENCODE_DB`, else `~/.local/share/opencode/opencode.db` plus its
  `-wal`/`-shm` sidecars and the channel-suffixed filename (d148). The data dir
  is already mounted at its container default (d216).
- **Lineage per run, never hardcoded.** `session_v2` present means the v2
  lineage; the migration recreates `session_message` with a different column set
  (d167). The reader introspects and tags rows `opencode_v1`/`opencode_v2`.
- **Read.** `INSTALL sqlite; LOAD sqlite; ATTACH ... (TYPE sqlite, READ_ONLY)`,
  the pattern `atuin-warehouse-sync.sh` proves over WAL. A live writer makes it a
  moving target (d148), so a consistent snapshot (a copy, or SQLite's backup API)
  is the safe default when OpenCode is running.
- **Rows.** Session rows from the session table's columns; message rows from the
  message table with its `data` JSON column as `payload`, `seq` from the message
  order column.
- **Unresolved: mutable rows.** OpenCode mutates keyed rows (title, token
  counters), and d203's first-write-wins would keep the first spelling forever.
  Choose a last-write-wins key (`updated_at`/`updated_seq`) or an append-only
  history, and record it before the reader lands.
- **Test.** A fixture database built in both lineages, asserting lineage routing,
  identity, and that no row is lost or doubled on a re-read.

### Mistral-vibe, unified store (`datalakehouse/vibe-warehouse-sync.sh`)

- **Input.** `SessionLoggingConfig.save_dir` (default `~/.vibe/logs/session`),
  `unified/<session_id>/`.
- **Gate.** `STORE_FORMAT = "mistral.vibe.unified-session-store/v1"` plus its
  minor; a newer minor is refused, as the harness itself does.
- **Read.** `manifest.json`, `checkpoint.json`, `runtime-state.json`,
  `projection-state.json`, content-addressed `chunks/<sha256>.json`, and
  `snapshot/history/entries` with `history_positions`.
- **Identity and order.** The entry `id`; the history index for `seq`. Never a
  file position: appending rewrites the open tail, so chunks and lines move.
- **Removals.** The history is mutated by append, replace and remove. A removal
  the warehouse has already stored needs an explicit decision (tombstone or last
  state), not a silent resurrection on the next sweep.
- **Verification gap.** No host in scope carries `~/.vibe` (d167), so the gate is
  a fixture built from the mirror and the first real host is the true check.
- **Test.** A fixture store: manifest + two sealed chunks + a history index, with
  the version gate covered by a rejected newer-minor case.

### Mistral-vibe, legacy JSONL (`messages.jsonl`)

- **Input.** `<save_dir>/session_<id>/{meta.json,messages.jsonl}`. The sweep skips
  these today (they have no pi header); the legacy reader recognises the path
  shape instead of the first line, so the pi rule and the vibe rule stay
  disjoint.
- **Fields.** `role`, `content`, and `message_id` (nullable on `tool` rows) are
  the only guaranteed ones. There is no per-message timestamp: `seq` is the line
  order and `ts` stays null.
- **Session identity.** `meta.json`'s `session_id`; vibe's own index drops a
  session without one, and the reader mirrors that.
- **Removal.** `--rm` treats the directory as the unit: `meta.json` is never
  removed alone, and the grace window still protects a live session.
- **Test.** A fixture directory with `meta.json` and three lines, including a
  `tool` row without `message_id`.

### Launcher (the pending leg outside this unit)

`coding-agent/run.mjs` mounts no `.vibe` directory and pins no vibe env, and
`coding-harness-persistence` has no row for it (d167, d216). A host-side sweep
needs none of that — it reads the host's own directory — but a sandbox path does,
so the row is a prerequisite for reading vibe from inside a sandbox, not for the
host archive.

## Explicitly not needed

- **No daemon protocol change.** The route already carries any JSON object and
  the fold ceiling is per row size, not per harness.
- **No second database.** OpenCode's lineages split by schema inside `md:agent`
  (d167); a second `md:` database would double the identity and attach pitfalls.
- **No per-source spool.** One self-describing NDJSON tail, one fold, one
  rotation.
- **No harness patch.** d182 makes the file and database read the completeness
  guarantee; the emitters (pi extension, OpenCode plugin, vibe hook) stay
  optional and agent-writable.
- **No new credential.** The readers post to the route without a token; the
  sender keeps the single MotherDuck token path (d046).

## Landed prerequisites

- **The wire contract** above, with `source` absent meaning `pi` (sender's
  `normalise`).
- **The sender's source routing**: `mdw.pi.*` for pi rows, `mdw.harness.*` for a
  foreign `source`, both first-write-wins, in one SQL batch per fold.
- **Generation-scoped synthetic ids** in the sender.
- **`--direct` delegates to the sender**, so the sync carries no DDL, no version
  gate and no uploader; the gate lives in the sender and therefore protects the
  daemon's folds too.
- **The sweep stops re-parsing the spool.** Rows there are already the daemon's;
  `--dry` counts them, `--direct` hands the raw tails to the sender, and route
  mode no longer re-posts them.
- **The daemon keys foreign rows by source** and accepts `message_id`.

## Verification

- `datalakehouse/tests/spool-send.sh` pins the foreign envelope, the session
  detection for all three shapes, the generation-scoped synthetic id, and the pi
  pass-through.
- `datalakehouse/tests/sync-roots.sh` pins the spool accounting change and the
  daemon's source-aware dedupe (same id under two sources is two rows).
- `datalakehouse/tests/spool-self-send.sh` pins the fold path the delegation
  reuses.
- The readers have no corpus on this host: OpenCode's fixture is written by the
  test, and the vibe readers stay fixture-only until a host carries `~/.vibe`
  (d167).
- The warehouse statements were applied to a local duckdb v1.5.6 over the four
  stagings, and a second application left every count unchanged; MotherDuck is the
  only place the full path runs, as before.

## Consequences

- Adding a harness is one reader plus its fixture; the transport, the schema
  owner and the fold are shared, so a new source cannot diverge from the upload
  contract.
- `mdw.harness.entry` accumulates rows whose promoted shape arrives later. That
  is the cost of landing them loss-free; the payload is verbatim, so nothing is
  lost by waiting.
- A row with no producer identity is deduped by generation, not by content: the
  same logical row posted in two spool generations can appear twice. Producers
  are expected to send ids, and every reader above does.
- The direct leg's JSON summary reports the parsed counts; the warehouse totals
  print per batch from the sender.

## Alternatives rejected

- **Per-source tables in the sender ahead of the readers.** The shapes are not
  knowable from the row, and a wrong guess is a migration; the envelope is.
- **Keep the sync's own DDL and add the new tables there too.** Two schemas to
  rename in two places, and the row from a foreign source folded by `--direct`
  would still be forced into pi's columns.
- **A content hash as the fallback id.** It reads better in a query and costs a
  `sha256` dependency the unit does not otherwise have; the spool basename plus
  the line is deterministic, dependency-free, and generation-scoped.
- **Let the daemon stamp the source.** It would have to infer what only the
  producer knows, and the route's job is to store the row, not describe it.
