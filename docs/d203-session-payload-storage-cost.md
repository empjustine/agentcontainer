---
id: d203
type: module-design
status: draft
title: "d203 — session payload storage: failsafe churn, not JSON shape, owns the 5.6 GB, and zstd Parquet is the compression lever"
parent: datalakehouse
depends-on: [d167, d184]
references: [d046, d179, d180, d181]
tags:
  [
    "datalakehouse",
    "sessions",
    "motherduck",
    "storage",
    "failsafe",
    "parquet",
    "zstd",
    "json",
    "compression",
  ]
---

# d203 — session payload storage

This record measures where the `md:agent` warehouse spends its bytes and tests the two storage changes the session leg could make: split `message.content[]` into typed columns, or move the payload to zstd Parquet. It covers the measured byte breakdown, MotherDuck's billing unit, the first-write-wins upsert that is now in force, and the pending cold Parquet archive; it does not migrate rows. The reader is whoever owns the session sync or the warehouse budget. The finding is that most of the 5.6 GB is failsafe from repeated upserts, splitting the JSON does not reduce MotherDuck's native storage, and zstd Parquet is roughly five to eight times smaller than the live table.

## Status

Active — the entry and session upserts now use first-write-wins (`ON CONFLICT DO NOTHING`), so the failsafe growth described here stops. The cold Parquet archive is a pending task; no migration or export has run. The measured snapshot is `md:agent` on 2026-11-15.

## The measured shape

| fact                                    | value                  |
| --------------------------------------- | ---------------------- |
| rows in `mdw.pi.entry`                  | 153,893                |
| sessions in `mdw.pi.session`            | 849                    |
| payload text, summed                    | 511,144,106 characters |
| MotherDuck `active_bytes`               | 577,515,520            |
| MotherDuck `failsafe_bytes`             | 5,007,577,088          |
| historical and retained-for-clone bytes | 0                      |
| total managed bytes                     | 5,585,092,608          |
| failsafe / active                       | 8.67                   |

The payload is the active table: `payload::VARCHAR` sums to 511 MB and `active_bytes` is 577 MB. The 5.6 GB figure is not the payload's live size. Failsafe is 89.6% of it.

The message rows carry almost all of the payload: 149,534 `message` rows hold 495,475,605 of the 511,144,106 characters. Inside those rows, `message.content` is 375,200,979 characters across 245,239 parts:

| content part | parts   | characters  | largest   |
| ------------ | ------- | ----------- | --------- |
| `text`       | 112,671 | 176,891,968 | 183,445   |
| `thinking`   | 55,157  | 129,413,021 | 797,464   |
| `toolCall`   | 77,400  | 63,957,344  | 188,471   |
| `image`      | 11      | 4,543,025   | 1,071,561 |

The `thinking` parts alone carry 97.3 MB in the `thinking` field. The tool-call arguments carry 57.2 MB. Both are larger than the payload's JSON punctuation, so a compression choice matters more than a field-count choice.

## The billing unit

MotherDuck bills average daily managed storage, compressed on disk. The billed total includes active, historical, retained-for-clone, and failsafe bytes. Failsafe is system-managed recovery data retained after a version is no longer referenced; the standard retention is seven days, and a transient database holds one day. The plan's storage allowance is measured against that total.

The billing answer is therefore: **compressed managed bytes, not the uncompressed logical size**. The current 5.6 GB is already the compressed managed total, and 5.0 GB of it is old versions.

## Why failsafe dominates

Both sync paths write the entry table with `INSERT ... ON CONFLICT DO UPDATE`, and the conflict target is the whole row. The sync re-posts every parsed row on every run, and the daemon re-reads its spool. A run that changes nothing still writes a new row version, because the verb is an update, not a comparison. DuckDB stores the new version and moves the old one to failsafe.

The arithmetic matches that shape. `failsafe_bytes` is 8.67 times `active_bytes`; the live table is one generation, so the total is about 9.7 active-sized generations: the live one plus 8.7 old copies. A seven-day failsafe window and roughly nine sync runs in that window are enough to produce the 5.6 GB total without any payload growth.

`session_file` makes the churn worse than a pure no-op. The same session has a different path inside a sandbox and on the host, and the path is a column on the entry row. An entry that is byte-identical in every other field still differs in `session_file`, so even a value-comparing update would rewrite it.

## The JSON column is not compressed natively

`PRAGMA storage_info('pi.entry')` reports the `payload` column as `Uncompressed`, with 1,629 overflow string blocks. DuckDB stores a long JSON value as an overflow string, and the overflow blocks are not dictionary-, FSST-, or zstd-compressed. The local copy of the same rows is 584 MiB for 511 MB of payload text, which is the expected one-to-one shape.

The JSON nesting is therefore not the reason the active table is 577 MB. It is the reason native compression is unavailable: one long string per row gives the codecs nothing to work with.

## Splitting the content array

The split was measured on a local DuckDB 1.5.6 copy of the whole table:

- `entry_meta` — every row, with `message.content` removed from the payload;
- `content` — one row per content part, with `part_type`, `text`, `thinking`, `thinking_signature`, `tool_call_id`, `tool_name`, `arguments`, `image_data`, and `image_mime` as typed columns.

| shape                                | bytes       |
| ------------------------------------ | ----------- |
| current table, native DuckDB         | 584 MiB     |
| split tables, native DuckDB          | 589 MiB     |
| current table, Parquet zstd level 3  | 118,109,553 |
| split tables, Parquet zstd level 3   | 113,314,362 |
| current table, Parquet zstd level 9  | 91,296,262  |
| current table, Parquet zstd level 19 | 72,844,932  |

The split does not claw back native storage. It is 1% larger there, because the text and thinking fields are still long strings and the part table adds row and validity overhead. The split is 4% smaller in Parquet, where zstd already removes the repeated JSON keys, and it enables column pruning: a text-only query does not read `thinking` or `arguments`.

The compression lever is zstd, not shredding. Parquet at level 9 is 6.3 times smaller than the active table; level 19 is 7.9 times smaller. The writer pays for that: one 500 MB corpus took 6.4 seconds at level 9 and 140 seconds at level 19 on the measurement host.

## Offline zstd Parquet

Parquet keeps the cold archive outside MotherDuck's managed storage, so its bytes are billed by the object store or the local disk, not by MotherDuck. MotherDuck can query S3 Parquet in place with `read_parquet`, and DuckLake's bring-your-own-bucket mode keeps the catalog in MotherDuck while the Parquet data stays in the bucket. OCI compatibility is not documented in the sources read for this record, so an OCI archive is read by a local DuckDB rather than by MotherDuck unless that is verified.

For this table, a full Parquet export at level 3 is 118 MB, and a split export is 113 MB. At level 19 the whole table is 73 MB. The session leg has no hot read (d179), so a cold archive that takes seconds to open is a legitimate fit. The tier split is d173's; the search-shaped use of the same media is d177's.

## The change the numbers support

1. **Applied** — stop rewriting unchanged rows. `agent-warehouse-sync.sh` and `agent-warehouse-spool-send.sh` use `INSERT ... ON CONFLICT DO NOTHING` for `mdw.pi.session` and `mdw.pi.entry`; the entry key is `(session_id, id)` and d167's no-revision rule makes first-write-wins the correct audit semantics. A repair is an explicit delete plus insert, not an every-run update.
2. Remove `session_file` from the entry row, or accept the first-seen path. The README already states that the path is a location attribute, never the key; leaving it on every entry makes the row differ across hosts.
3. Let failsafe decay. The 5.0 GB of old versions expires after seven days once the churn stops. A transient database shortens that to one day. Recreating the database sheds it immediately, but loses the archive.
4. Archive cold rows to zstd Parquet if active storage still matters. Level 9 is the practical middle ground; level 19 is an offline export, not a per-run step. Keep the hot/recent window in MotherDuck, or query the archive through DuckLake and the external-file path.
5. Treat the content-array split as a query decision, not a storage decision. It needs its own record because it departs from d167's no-shredding decision, and it must pin the part-type set and the `toolCall.arguments` irregularity before it lands.

## Open questions

- Is `pi.entry` append-only for every source the table will hold? pi entries are immutable by id; a source that mutates an entry needs a version key before `DO NOTHING` is safe.
- Is the first-seen `session_file` acceptable, or does the location need an update path that does not rewrite the payload?
- Is a transient `md:agent` acceptable? It shortens failsafe recovery to one day and conflicts with an archive that is meant to be recoverable.
- Does the migration rewrite the table once more? That creates one more failsafe generation, so it belongs in a maintenance window with the churn stopped first.

## Pending task: cold Parquet archive

Owner: `datalakehouse`. Status: pending. The trigger is a hot window that keeps the live table small; the archive is the cold half.

Scope: export session rows outside the hot window to zstd Parquet, partition by month and session, keep the hot window in MotherDuck, and verify the archive before pruning anything. The archive is queried by the local DuckDB CLI, or by MotherDuck through `read_parquet`/DuckLake when the bucket is reachable.

Acceptance criteria:

- a Parquet export of a stated cold range, at a stated zstd level, with a row count and payload checksum that match the source;
- a manifest that names the export, its time range, row count, checksum, and creation time;
- a documented hot window and a prune step that runs only after the export verifies;
- a measured archive size and a restore test that reads the range back through DuckDB;
- a documented failure path when the archive is absent or corrupt.

Open inputs: hot-window size, medium (local SMR, OCI, or an S3-compatible bucket), zstd level, partition key, deletion and retention policy, and whether MotherDuck or only the local DuckDB CLI queries the archive.

## Verification

- `md:agent` was read through the MotherDuck MCP on 2026-11-15: `md_information_schema.storage_info`, `PRAGMA storage_info('pi.entry')`, `PRAGMA database_size`, and the JSON-length aggregates.
- The split and Parquet measurements used a local DuckDB 1.5.6 copy of all 153,893 rows, then `COPY ... (FORMAT PARQUET, COMPRESSION ZSTD)`.
- The MotherDuck billing and failsafe statements come from the vendor's storage-pricing, storage-lifecycle, and monitoring-usage documentation.
- The storage snapshot is daily, so the active/failsafe split is a dated observation rather than a live counter.
