---
id: sbex-cold-tier-platforms
type: submodule-design
status: draft
title: "Cold-tier platforms: Oracle ADW hybrid columnar compression, DBMS_CLOUD external tables, and landing zones"
parent: sbex
references:
  [sbex-cold-persistence, sbex-datalakehouse-port, sbex-persistence-engines, d173, d203, d205]
tags:
  ["oracle", "adw", "hcc", "dbms-cloud", "external-tables", "landing-zone", "lsm", "partitioning"]
---

# Cold-tier platforms: Oracle ADW, external tables, and the write-side landing zone

The local archive has a shape — hot SQLite, warm Parquet, object storage — and a managed warehouse can take over the cold end of it. This note records what Oracle Autonomous Data Warehouse offers for that role. It covers Hybrid Columnar Compression, the `DBMS_CLOUD` external-table and load paths, hybrid partitions that mix compressed internal rows with Parquet files, and the staging pattern every engine needs before compressed storage can be filled cheaply. It is not the local tier's design: [sbex-cold-persistence](cold-persistence.md) owns Parquet generations, the host's block stack and the demotion pipeline.

## Status

Draft: research and decision scaffolding. Nothing in the tree connects to an Autonomous Database, and the platform claims were read from the 23ai documentation named under References.

## Why the platform decides the cold shape

Three remote options exist once the local archive works, and they answer different questions. MotherDuck keeps the DuckDB dialect and reads the Parquet files directly. Object storage keeps bytes and nothing else. An Oracle Autonomous Data Warehouse keeps rows in an Exadata-backed database where the cold end is a compressed table, and where the Parquet generations stay queryable as external partitions. The third option is the only one that makes the archive joinable with a relational schema and a managed service level, at the price of a second secret store and a PL/SQL API.

## Hybrid Columnar Compression

Hybrid Columnar Compression (HCC) stores a group of rows as a compression unit: values for each column are laid out together, compressed with the algorithm the database picks per column, then packed into the unit, which can span several blocks. It is a storage format inside a row-major database, so queries and DML work unchanged.

| Level                                      | What it is for                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `COLUMN STORE COMPRESS FOR QUERY LOW`      | optimised for DML, little compression                                     |
| `COLUMN STORE COMPRESS FOR QUERY HIGH`     | the default for warehousing; the plain `COLUMN STORE COMPRESS` means this |
| `COLUMN STORE COMPRESS FOR ARCHIVE LOW`    | higher ratios than QUERY, for historical data                             |
| `COLUMN STORE COMPRESS FOR ARCHIVE HIGH`   | the largest space saving, for data that does not change                   |
| `COLUMN STORE COMPRESS FOR MEMSPEED QUERY` | 23ai's on-disk columnar format borrowed from the in-memory store          |

The platform rule matters more than the level names. HCC is optimised for data warehousing on Exadata storage, where the storage servers do the scan work. Other storage systems keep the space saving without the scan performance, which the documentation frames as the in-database archiving case: old data, read rarely. That is exactly the cold tier's job description, and it settles the placement: HCC belongs on the partitions nobody writes.

Four load-path facts decide how the port fills those partitions.

- **Compression happens at load.** HCC compresses direct-path inserts, conventional inserts and array inserts; direct-path loads reach the better ratios, and the documentation's `PCTFREE` note betrays the mechanism: blocks from a conventional insert keep row format, while direct-path blocks get the columnar unit.
- **Direct path needs the right SQL.** The `APPEND` hint applies to `INSERT ... SELECT` only, and the `VALUES` clause needs `APPEND_VALUES` instead. A JDBC batch is an array insert, so the hint pair is `APPEND` for `SELECT` and `APPEND_VALUES` for bound rows.
- **DML is the enemy of the format.** The compression unit is not edited in place, and the documentation devotes a section to the locking consequences. A cold partition is write-once; the hot rows live in the staging table.
- **Repacking is an explicit operation.** `ALTER TABLE ... MOVE COMPRESS FOR ARCHIVE HIGH` rewrites a table, and `ALTER TABLE ... MODIFY PARTITION ... COMPRESS FOR ...` does it per partition; `DBMS_REDEFINITION` is the online route, and `DBMS_COMPRESSION.GET_COMPRESSION_RATIO` estimates the ratio before the choice. Partitioning is therefore the compression control: hot partitions stay `NOCOMPRESS` or row-store, cold partitions take `ARCHIVE`.

Two platform caveats belong here rather than in an operations wiki. The 23ai Memory Speed variant needs a BIGFILE tablespace with AUTOALLOCATE, 1 MB ASSM alignment, and is unsupported on 2K and 4K block sizes. And every HCC table carries the write-once constraint into the application: a reconciliation that edits old rows decompresses or bypasses the format, so the tombstone-then-rebuild pattern from the local tier applies unchanged.

## DBMS_CLOUD: external tables, hybrid partitions, and the load path

The package is the only door into object storage from SQL, and it covers both directions.

| Call                               | What it does                                                              |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `DBMS_CLOUD.CREATE_CREDENTIAL`     | stores object-store credentials in the database, encrypted                |
| `DBMS_CLOUD.CREATE_EXTERNAL_TABLE` | an external table over files, with text formats and Avro, ORC and Parquet |
| `DBMS_CLOUD.COPY_DATA`             | loads those files into an existing internal table, with an `operation_id` |
| `DBMS_CLOUD.EXPORT_DATA`           | writes a query's rows out as CSV, JSON, Parquet, XML or a Data Pump file  |

Details that shape a port:

- **Parquet is a first-class external format.** Both `CREATE_EXTERNAL_TABLE` and `COPY_DATA` take `parquet` (and `orc`, `avro`) as the `format.type`, with a deliberately small option set for those types. The local tier's generations are therefore readable by the warehouse without a conversion step.
- **The credential is a table-level property.** Every file in one external table must sit on the same object store, and the credential lives in the database, which is a second place a secret must be rotated beside the application's own vault.
- **External tables are read-only, and their partitions are too.** A hybrid partitioned table takes `EXTERNAL PARTITION ATTRIBUTES`, and the documentation is explicit: DML works only on internal partitions, external partitions are read-only, and table-level in-memory settings touch internal partitions only.
- **Loads are monitored operations.** `COPY_DATA` returns an `operation_id` that maps to `USER_LOAD_OPERATIONS`, so a Spring job can poll the load rather than guess at completion.
- **The external-vs-loaded choice is the query-frequency choice.** An external table always reads the object store, so it pays per query; a loaded table pays once and then scans HCC. The rule mirrors the DuckDB measurement in the local note: load what is queried often, expose what is queried rarely.

No `DBMS_CLOUD` call is a JDBC abstraction. From the proposed stack each one is a `CallableStatement` in a repository, PL/SQL-shaped, and none of them participates in the application's transaction.

## The landing zone, engine by engine

Compressed, read-optimised storage and high write throughput are opposites, and every engine either separates them itself or makes the application do it. The pattern is the same everywhere: a write-optimised landing area, a fold that rewrites rows into the read-optimised shape, and a retention rule that decides when the fold runs.

| Engine     | Landing area                                          | Read-optimised side                                        | Database-managed hot/cold                                                               | LSM?                           |
| ---------- | ----------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------ |
| PostgreSQL | `COPY` into a staging table, then `INSERT ... SELECT` | BRIN on the time column, partial indexes on the hot subset | declarative partitions, created and detached by the operator; no tiered storage         | no                             |
| MySQL      | `LOAD DATA` / batched inserts                         | InnoDB clustered index, covered indexes                    | partitioning, with restrictions such as no foreign keys on partitioned tables           | MyRocks in the MariaDB family  |
| SQLite     | the spool table the daemon already writes             | one index per read shape, partial indexes                  | none: file per tier, `VACUUM INTO` for the snapshot                                     | no                             |
| DuckDB     | a staging table, then `INSERT ... SELECT` + `DELETE`  | zonemaps and Parquet row-group statistics                  | none inside the database; hive-partitioned files instead                                | no                             |
| ClickHouse | `async_insert` or client batches                      | `MergeTree` parts, projections, codecs                     | TTL `TO DISK`/`TO VOLUME` moves plus `RECOMPRESS`, on a default four-hour merge cadence | MergeTree parts are LSM-shaped |
| Oracle ADW | a heap staging table, then `INSERT /*+ APPEND */`     | HCC partitions, indexes on the hot partitions only         | interval partitioning creates partitions; hybrid tables mix internal and external       | no                             |

Three readings of that table matter for the port.

- **Only ClickHouse and Oracle manage the move themselves.** ClickHouse moves parts between disks and volumes by TTL policy, and Oracle compresses per partition; every other engine leaves the cutover to a scheduled job. A Spring `@Scheduled` maintenance task is the portable answer, and it is the same job shape as the reconciliation pass.
- **LSM is a ClickHouse property, not a pattern to copy.** MergeTree's background merges give the write-optimised side for free; a hand-built LSM on SQLite or DuckDB would be a second storage engine maintained by hand.
- **Partial indexing is the cheap half of hot/cold.** A partial index over open rows keeps the hot query fast while the cold rows go unindexed, on PostgreSQL and SQLite alike; on Oracle the equivalent is a partition-level index decision, and on ClickHouse the primary key and skipping indexes.

## Support in the proposed Spring stack

| Concern                               | Support                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| schema, compression and partition DDL | Flyway `db/migration/{vendor}`, the example's existing pattern; `COMPRESS` and `PARTITION` clauses are ordinary migrations   |
| partition creation and cutover        | not a migration, because it recurs: a scheduled job, or the database's own interval partitioning and TTL policies            |
| direct-path and array loads           | SQL-level hints through `JdbcTemplate`/`PreparedStatement`; no Spring abstraction exists                                     |
| `DBMS_CLOUD` and external tables      | `CallableStatement` only; no JPA mapping, no transaction participation, credentials stored inside the database               |
| hybrid partitioned tables             | DDL only; the read paths see one table and the pruning is the database's                                                     |
| ADB connectivity                      | `ojdbc11` is already a runtime dependency; the wallet arrives through `TNS_ADMIN` and TLS, and the same vault chain feeds it |
| load observability                    | `USER_LOAD_OPERATIONS` on ADB, `system.parts` on ClickHouse, `pg_stat_progress_copy` on PostgreSQL                           |

The honest summary is that the stack supports all of this at the JDBC and migration level and none of it at the framework level. That is not a gap to fill with an abstraction: the features are engine-specific, and a thin repository per concern is the shape that survives an engine swap.

## Recommendation for the port

1. Keep the local tier as designed: SQLite hot, Parquet warm, and object storage as the first cool copy.
2. Add ADW as a second cool tier only if the archive must be joinable: external partitions over the existing Parquet generations first, since that needs no load and no HCC; HCC partitions for the windows that are queried regularly.
3. Treat the HCC partition as write-once, with the tombstone-and-rebuild reconciliation of the local tier as the only edit path.
4. Use ClickHouse for the browsing index if a column store is wanted, because it is the engine whose parts, TTL moves and compression are managed by the database rather than by a job.
5. Keep every staging fold idempotent and observable, because the landing zone is where a crash leaves half a window.

## Open decisions

1. **Whether ADW is in scope at all.** The archive is single-user and local; a managed warehouse earns its place only if the rows must be queried relationally, or if the host's slow tier is not trusted.
2. **External or loaded, per window.** The answer is a query-frequency measurement, and it changes per table.
3. **The HCC level and the repack cadence.** `DBMS_COMPRESSION.GET_COMPRESSION_RATIO` on a real window, not a vendor figure.
4. **ADO and ILM on ADB.** Oracle's heat-driven compression and tiering is the database-managed version of this whole note, and its availability on an Autonomous instance needs a check in that instance's feature list before it is planned on.
5. **Where the object-store credential lives.** `DBMS_CLOUD` keeps its own copy inside the database; the vault chain that feeds `./environment.sh` remains the source of truth, and the rotation path between the two needs an owner.

## References

- Oracle AI Database 23ai: [table compression concepts](https://docs.oracle.com/en/database/oracle/oracle-database/23/cncpt/tables-and-table-clusters.html), [CREATE TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/CREATE-TABLE.html), [APPEND and APPEND_VALUES hints](https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/Comments.html)
- Autonomous AI Database: [Query External Data](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/query-external-data.html), [DBMS_CLOUD subprograms](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/dbms-cloud-subprograms.html)
- PostgreSQL: [BRIN indexes](https://www.postgresql.org/docs/current/brin-intro.html), [table partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html), [partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html)
- MySQL: [partitioning restrictions](https://dev.mysql.com/doc/refman/8.4/en/partitioning-limitations.html)
- SQLite: [partial indexes](https://sqlite.org/partialindex.html)
- DuckDB: [indexes](https://duckdb.org/docs/2.0/sql/indexes)
- ClickHouse: [TTL and tiered moves](https://clickhouse.com/docs/guides/developer/ttl), [asynchronous inserts](https://clickhouse.com/docs/optimize/asynchronous-inserts)
- Sibling notes: [sbex-cold-persistence](cold-persistence.md), [sbex-datalakehouse-port](datalakehouse-port.md), [sbex-persistence-engines](persistence-engines.md)
