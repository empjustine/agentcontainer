---
id: sbex-persistence-engines
type: submodule-design
status: draft
title: "sbex persistence engines: SQLite, PostgreSQL, DuckDB and ClickHouse across JDBC, R2DBC, streaming and replication"
parent: sbex
references:
  [
    sbex-persistence,
    sbex-servlet-vs-reactive,
    sbex-container-image,
    sbex-memory,
    sbex-sqlite-replication,
    d193,
  ]
tags:
  [
    "persistence",
    "jdbc",
    "r2dbc",
    "streaming",
    "sqlite",
    "postgresql",
    "duckdb",
    "clickhouse",
    "replication",
  ]
---

# Persistence engine coverage: four engines, two access modes, one replication question

This note records what adding SQLite, DuckDB and ClickHouse beside the example's PostgreSQL and Oracle requires. It covers both access modes (JDBC and R2DBC) and both read shapes (materialise and stream), and leaves SQLite's backup and replication half to [sbex-sqlite-replication](sqlite-replication.md). It is research and a plan, not a description of code: [sbex-persistence](persistence.md) owns the tree as it is. The reader is an engineer weighing the change, and arrives knowing the transaction boundary, the `SqlDialect` seam and why the reactive application offloads the blocking core.

## Status

Draft: a proposal. No class in `sbex-core`, `sbex-servlet` or `sbex-reactive` implements any engine below. Landing it writes its own decision record, the precedent [d193](../docs/d193-spring-boot-4-1-migration.md) set for a version pin in this unit.

## What the seam assumes

Seven assumptions in the current code decide the size of the change, and each one names the engine that breaks it.

| Assumption                                                    | Where it lives                              | Broken by                                                             |
| ------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| Vendor syntax sits behind one four-method interface           | `SqlDialect`, chosen in `PersistenceConfig` | SQLite, DuckDB and ClickHouse: two of the four methods are procedural |
| Boot's `DatabaseDriver` names the engine                      | `SqlDialect.fromJdbcUrl`                    | DuckDB: no enum entry                                                 |
| An insert returns the identity the database assigned          | `OrderRepository.insert`                    | ClickHouse: no identity, no generated key                             |
| An upsert reports "one row written" as the idempotency signal | `ProcessedEventRepository.markProcessed`    | ClickHouse: no unique constraint, no conflict to detect               |
| `Instant` binds as `java.sql.Timestamp`                       | `Timestamps`                                | SQLite: no date type                                                  |
| `classpath:db/migration/{vendor}` covers every engine         | both `application.yml` files                | DuckDB: `{vendor}` does not resolve, and Flyway has no module         |
| One `DataSource` and one transaction manager per context      | both applications                           | a real R2DBC path: two autoconfigurations, one silent winner          |

## Engine matrix

The inference column was read off the pinned `spring-boot-jdbc-4.1.2` jar by running `DatabaseDriver.fromJdbcUrl` for each URL form: `jdbc:duckdb:` answers `UNKNOWN`, the other three resolve to `sqlite`, `postgresql` and `clickhouse`.

| Concern               | PostgreSQL                            | SQLite                                       | DuckDB                                      | ClickHouse                                     |
| --------------------- | ------------------------------------- | -------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| JDBC driver           | `postgresql` 42.7.14, BOM-managed     | `sqlite-jdbc` 3.53.4.0, BOM-managed          | `duckdb_jdbc` 2.0.0.1, unmanaged            | `clickhouse-jdbc` 0.11.2, unmanaged            |
| Boot inference        | `postgresql`                          | `sqlite`                                     | `UNKNOWN`                                   | `clickhouse`                                   |
| R2DBC driver          | `r2dbc-postgresql` 1.1.3, BOM-managed | none published                               | none published                              | `clickhouse-r2dbc` 0.11.2, unmanaged           |
| Transactions          | yes                                   | yes, one writer                              | yes, one writing process                    | no: `supportsTransactions()` is false          |
| Identity              | `GENERATED ALWAYS AS IDENTITY`        | `INTEGER PRIMARY KEY` (rowid alias)          | sequence default, read back via `RETURNING` | none: the client assigns the id                |
| Do-nothing upsert     | `ON CONFLICT DO NOTHING`              | `ON CONFLICT DO NOTHING`                     | `INSERT OR IGNORE`                          | no equivalent: `ReplacingMergeTree` + `FINAL`  |
| Procedures and blocks | `DO` block, `CALL … OUT`, function    | none                                         | none                                        | none                                           |
| Streaming read        | cursor, needs `autocommit=false`      | native cursor, `setFetchSize` is a row limit | opt-in: `jdbc_stream_results=true`          | server streams rows                            |
| Flyway at 12.4.0      | `flyway-database-postgresql`          | built into `flyway-core`                     | none published                              | none published                                 |
| Test harness          | `testcontainers-postgresql`           | `@TempDir` file                              | `@TempDir` file                             | `testcontainers-clickhouse` 2.0.5, BOM-managed |

## Per-engine necessities

### PostgreSQL

The JDBC leg needs nothing beyond the existing dialect. The reactive leg adds `spring-boot-starter-r2dbc`, `io.r2dbc:r2dbc-pool` and `org.postgresql:r2dbc-postgresql`, and sets `fetchSize`, because the driver's default of `0` fetches the whole result ([r2dbc-postgresql README](https://github.com/pgjdbc/r2dbc-postgresql#readme)). Cursored fetching activates from a non-zero `fetchSize`, the cursor lives for the transaction's duration, and in auto-commit the driver holds one open per statement.

### SQLite

- **Dependency and inference.** `org.xerial:sqlite-jdbc` 3.53.4.0, managed by the Boot BOM. `DatabaseDriver` knows the engine, so Hikari infers `org.sqlite.JDBC` and Flyway's `{vendor}` resolves to `sqlite`.
- **Identity.** `INTEGER PRIMARY KEY` is the rowid alias, and the driver answers `getGeneratedKeys` with `last_insert_rowid()`. `INSERT … RETURNING` exists since 3.35 for the multi-row case ([RETURNING](https://sqlite.org/lang_returning.html), [sqlite-jdbc](https://github.com/xerial/sqlite-jdbc)).
- **Upsert.** `ON CONFLICT … DO NOTHING` (3.24, [UPSERT](https://sqlite.org/lang_upsert.html)) is the PostgreSQL statement unchanged, so the dedup ledger and the totals table keep one formulation.
- **Procedures replaced.** `reconcileTotals` becomes an `INSERT … ON CONFLICT DO UPDATE`, and the archive becomes `UPDATE … WHERE id IN (SELECT … LIMIT n)` whose update count is the return value.
- **Timestamps.** No date type: store epoch milliseconds and read with `getLong`, or store ISO text. The dialect owns the bind and the column read, which is why `Timestamps` becomes a per-engine helper rather than one static method.
- **Concurrency.** One writer at a time; WAL lets readers proceed during a write ([WAL](https://sqlite.org/wal.html)). A writer application pins `maximum-pool-size: 1`, and the URL carries `journal_mode=WAL` and `busy_timeout=5000` (both are driver pragmas, [sqlite-jdbc docs](https://github.com/xerial/sqlite-jdbc)).
- **Streaming.** `setFetchSize` sets a row limit, not a transfer buffer; the driver steps the statement's native cursor. The `RowCallbackHandler` in `streamCompleted` therefore stays the bounded shape, at the cost of holding a read transaction open for the response.
- **Migrations and tests.** Flyway core drives the schema; the contract test runs against a `@TempDir` file and resets with `DELETE FROM`, because `TRUNCATE` does not exist.

### DuckDB

- **Dependency.** `org.duckdb:duckdb_jdbc` 2.0.0.1, absent from the BOM, so the parent's `dependencyManagement` gains an entry and no child carries a version.
- **Inference fails.** `spring.datasource.driver-class-name` must name `org.duckdb.DuckDBDriver`, `{vendor}` cannot resolve, and the dialect lookup becomes a URL-prefix table instead of `DatabaseDriver`.
- **Identity.** A sequence default, and the driver answers generated-key requests by rewriting eligible inserts onto `RETURNING` ([duckdb-java](https://github.com/duckdb/duckdb-java)).
- **Upsert.** `INSERT OR IGNORE` ([INSERT](https://duckdb.org/docs/2.0/sql/statements/insert)).
- **Streaming is opt-in.** Without `jdbc_stream_results=true` the driver materialises the whole result, which turns the report endpoint's heap guarantee into an incident. `DuckDBChunkedResult` and Arrow export are the columnar alternatives ([Handle Results](https://duckdb.org/docs/2.0/clients/java/result_handling)).
- **Concurrency and deployment.** Several threads write in one process under optimistic control; another process reaches the file read-only, or through the Quack protocol ([Concurrency](https://duckdb.org/docs/2.0/connect/concurrency)). One writer pod, therefore, and a pool that does not multiply writers.
- **Migrations and tests.** No Flyway module at the pinned version, so the schema script runs through `ResourceDatabasePopulator`; the contract test uses a `@TempDir` file and no container.

### ClickHouse

- **Dependencies.** `com.clickhouse:clickhouse-jdbc` 0.11.2 for blocking, `com.clickhouse:clickhouse-r2dbc` 0.11.2 for reactive, both unmanaged. Boot recognizes the URL and the driver class `com.clickhouse.jdbc.ClickHouseDriver`.
- **No transactions.** The JDBC v2 implementation reports `supportsTransactions()` as false and documents transaction support as absent; `jdbc_ignore_unsupported_values` can swallow the resulting `SQLFeatureNotSupportedException`, which hides the failure rather than removing it ([JDBC driver](https://clickhouse.com/docs/integrations/language-clients/java/jdbc), [ACID support](https://clickhouse.com/docs/guides/developer/transactional)).
- **What that cascades into.** `@Transactional` boundaries stop meaning anything, `@TransactionalEventListener(AFTER_COMMIT)` never fires, and the post-commit publish becomes an explicit call after a successful write. `cancel` and `archiveCompleted`, both row-level updates, become asynchronous `ALTER TABLE … UPDATE`/`DELETE` mutations with no row count ([ALTER UPDATE](https://clickhouse.com/docs/sql-reference/statements/alter/update)).
- **Identity.** No identity column and no generated key: `Order.id` becomes client-assigned, which is a domain change and cannot hide in a dialect.
- **Dedup.** `processed_events` becomes a `ReplacingMergeTree` keyed by `event_id` and read with `FINAL`, or the insert carries a deduplication token whose window is bounded ([deduplicating inserts](https://clickhouse.com/docs/guides/developer/deduplicating-inserts-on-retries)). Neither reproduces `written > 0`, so `markProcessed` changes contract.
- **Streaming and inserts.** `SELECT` streams from the server. A `PreparedStatement` payload does not stream in v2, so writes batch through `addBatch`/`executeBatch`.
- **Migrations and tests.** No Flyway module at the pinned version; `org.testcontainers.clickhouse.ClickHouseContainer` and its R2DBC counterpart drive the tests.

## The dialect interface splits

The procedural half is the obstacle: SQLite, DuckDB and ClickHouse have no stored procedures, so a four-method interface cannot have five implementations.

| Interface           | Methods                                                              | Implemented by        |
| ------------------- | -------------------------------------------------------------------- | --------------------- |
| `SqlDialect`        | upsert, insert-and-return-identity, bounded archive, streaming query | every engine          |
| `ProceduralDialect` | `reconcileTotals`, `archiveProcedureSql`, `score`                    | PostgreSQL and Oracle |

The split keeps the example's lesson intact: the anonymous block, the prepared `CALL` and the metadata-backed function stay as PostgreSQL and Oracle's demonstration, and no engine is asked to fake a procedure.

## Access modes

### Blocking JDBC

The blocking path is the current shape: `JdbcTemplate`, one transaction per service method, and the vendor SQL behind the split interface. Only the identity, timestamp and upsert fragments move into the dialect; the repositories keep their SQL.

### Reactive R2DBC

`spring-boot-starter-r2dbc` brings `spring-r2dbc` (hence `DatabaseClient`) and the autoconfiguration for `R2dbcTransactionManager`, the pool, the health contributor and observation. `io.r2dbc:r2dbc-pool` is a separate declaration, and `spring.r2dbc.pool.*` mirrors the Hikari knobs one for one: `max-size`, `max-acquire-time`, `max-idle-time`, `validation-query`.

Two findings decide the module layout.

1. **The transaction manager is whichever autoconfiguration runs first.** `R2dbcTransactionManagerAutoConfiguration` and `DataSourceTransactionManagerAutoConfiguration` both declare `@ConditionalOnMissingBean(TransactionManager)`. A context holding `spring.datasource.*` and `spring.r2dbc.*` therefore gets one manager, silently, and `@Transactional` on a blocking service can end up with the reactive manager.
2. **Reactive transactions need reactive return types.** The declarative model applies to `Mono`/`Flux` methods under a `ReactiveTransactionManager`, not to blocking ones ([Spring Framework, transaction annotations](https://docs.spring.io/spring-framework/reference/7.0/data-access/transaction/declarative/annotations.html)).

Three layouts follow. Keep the blocking core and offload it to `Schedulers.boundedElastic()` as [sbex-servlet-vs-reactive](servlet-vs-reactive.md) does, and the reactive stack stays a web-stack story. Split the persistence into a JDBC module and an R2DBC module behind the shared domain, and each application carries exactly one stack and one manager. Exclude the JDBC autoconfiguration in the reactive application and wire a `DataSource` by hand, and the ambiguity is hidden rather than removed. The first is the smallest change; the second is the one an example about "which stack, and what optimising each one means" can defend.

Reactive engines: PostgreSQL and ClickHouse have drivers; SQLite and DuckDB do not, and the only published bridge is `party.iroiro:r2dbc-jdbc`, which runs JDBC on a worker pool inside an R2DBC SPI shell. That is an unvetted dependency by this tree's standard, and it buys nothing over `boundedElastic`. Oracle's driver covers the procedural gap those four leave: a PL/SQL call registers `OUT` and `IN OUT` parameters with `Parameters.out(...)` and reads them from a `Result` emitted after any cursors.

## Streaming reads

| Engine     | What bounds heap in a blocking read                                     | What the reactive read needs                          |
| ---------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| PostgreSQL | cursor, only inside a transaction (`autocommit=false`)                  | `fetchSize` above zero, cursor inside the transaction |
| SQLite     | the statement's native cursor; `setFetchSize` limits rows, not transfer | no driver: offload the blocking stream                |
| DuckDB     | `jdbc_stream_results=true`, else the result is materialised             | no driver: offload the blocking stream                |
| ClickHouse | server-side row streaming                                               | `clickhouse-r2dbc`, flux of rows                      |

The reactive report endpoint does not exist yet. It returns `Flux<String>` (or `Flux<DataBuffer>`) from `DatabaseClient.sql(…).map(…).all()`, with `produces = "text/csv"`. A `@Transactional` method that returns a `Flux` holds its connection for the whole response, so `spring.r2dbc.pool.max-size` becomes the cap on concurrent downloads, and that belongs beside the pool arithmetic in [sbex-memory](memory.md).

## Migrations

| Engine     | Flyway 12.4.0 (the Boot 4.1.2 pin)                            | Alternative                                                         |
| ---------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| PostgreSQL | `flyway-database-postgresql`                                  | —                                                                   |
| SQLite     | inside `flyway-core` (the `SQLiteDatabaseType` service entry) | —                                                                   |
| DuckDB     | no module published above 10.26.3                             | schema script, or a Flyway 10 profile (rejected: it fights the BOM) |
| ClickHouse | no module published above 10.26.3                             | schema script                                                       |

The last two rows are the version-skew trap: `flyway-database-duckdb` and `flyway-database-clickhouse` stop at 10.26.3, and `flyway-community-db-support` stops at the same release, while the pinned `flyway-core` is 12.4.0. Downgrading Flyway to reach them breaks the Boot-pinned Oracle and PostgreSQL modules, so the honest path is a per-engine schema script for those two engines.

## Configuration per engine

```yaml
# SQLite: one writer, WAL, no container
spring.datasource.url: ${SBEX_DB_URL:jdbc:sqlite:/data/sbex.db?journal_mode=WAL&busy_timeout=5000}
spring.datasource.hikari.maximum-pool-size: 1
spring.flyway.locations: classpath:db/migration/sqlite

# DuckDB: the driver cannot be inferred, and the result stream is opt-in
spring.datasource.url: ${SBEX_DB_URL:jdbc:duckdb:/data/sbex.duckdb}
spring.datasource.driver-class-name: org.duckdb.DuckDBDriver
spring.datasource.hikari.data-source-properties.jdbc_stream_results: true

# ClickHouse: no transaction manager, no Flyway location
spring.datasource.url: ${SBEX_DB_URL:jdbc:clickhouse:http://localhost:8123/sbex}
spring.datasource.driver-class-name: com.clickhouse.jdbc.ClickHouseDriver

# Reactive, PostgreSQL
spring.r2dbc.url: ${SBEX_R2DBC_URL:r2dbc:postgresql://localhost:5432/sbex}
spring.r2dbc.pool.max-size: 6
spring.r2dbc.properties.fetchSize: 500
```

## Test harness

The contract class splits with the interface: a portable contract over insert, dedup, archive, list and stream, and a procedural contract implemented by PostgreSQL and Oracle alone. PostgreSQL keeps its container, ClickHouse adds `ClickHouseContainer`, and the two embedded engines share a `@TempDir` fixture. `SqlDialectTest` grows one URL per engine and keeps a refusal case for an engine the example does not ship.

## SQLite backup and replication

Backup and replication are a second concern for SQLite rather than a dialect one: `VACUUM INTO`, the driver's backup API, Litestream and `sqlite3_rsync` each keep one file alive in a different way. [sbex-sqlite-replication](sqlite-replication.md) owns that comparison, its packaging and its verification procedure.

## Verification spikes

Each item below changes a decision if it fails, so it precedes the implementation.

1. ClickHouse JDBC v2: what `setAutoCommit(false)` actually does, with and without `jdbc_ignore_unsupported_values`.
2. DuckDB: generated keys against a sequence default, and whether `jdbc_stream_results` survives Hikari's connection properties.
3. SQLite: `SQLITE_BUSY` behaviour at pool size above one, with WAL and `busy_timeout`.
4. Flyway 12.4.0 with `flyway-database-duckdb` 10.26.3, to record the failure rather than assume it.
5. The two transaction managers in one context, to confirm which one `@Transactional` receives.

## Sequencing

| Step | Work                                                                                                             | Estimate    |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ----------- |
| 1    | Split the dialect, add the URL-prefix lookup, split the contract tests, extend the parent `dependencyManagement` | 1 day       |
| 2    | SQLite: identity, epoch-millis bind, set-based reconcile, bounded update, schema script, temp-file test          | 1 day       |
| 3    | DuckDB: explicit driver, stream flag, sequence identity, schema script, temp-file test                           | 2 days      |
| 4    | Reactive PostgreSQL: starter, pool, `DatabaseClient` repositories, CSV stream, `fetchSize`, R2DBC container test | 2 days      |
| 5    | Reactive ClickHouse: driver, client-assigned ids, no-transaction path, streaming, container test                 | 2 days      |
| 6    | Blocking ClickHouse: append-only model, dedup, mutation archive, publish-after-write                             | 3 to 5 days |
| 7    | Litestream packaging plus `sqlite3_rsync` timer, and the docs pass                                               | 2 days      |

The PostgreSQL reactive leg and the SQLite leg together are the cheap proof: they exercise the split interface, the generated-key question, the stream flag and the migration gap without touching the domain model. ClickHouse is the expensive leg for a reason that no estimate hides: it asks the example to keep a transactional order model and a non-transactional one, or to give up the first.

## References

- Spring Boot 4.1: [SQL databases](https://docs.spring.io/spring-boot/4.1/reference/data/sql.html), [database initialization](https://docs.spring.io/spring-boot/4.1/how-to/data-initialization.html), [transaction annotations](https://docs.spring.io/spring-framework/reference/7.0/data-access/transaction/declarative/annotations.html)
- PostgreSQL JDBC and R2DBC: [r2dbc-postgresql](https://github.com/pgjdbc/r2dbc-postgresql)
- SQLite: [UPSERT](https://sqlite.org/lang_upsert.html), [RETURNING](https://sqlite.org/lang_returning.html), [WAL](https://sqlite.org/wal.html), [sqlite-jdbc](https://github.com/xerial/sqlite-jdbc)
- DuckDB: [Java client](https://duckdb.org/docs/2.0/clients/java/overview), [result handling](https://duckdb.org/docs/2.0/clients/java/result_handling), [concurrency](https://duckdb.org/docs/2.0/connect/concurrency), [INSERT](https://duckdb.org/docs/2.0/sql/statements/insert), [duckdb-java](https://github.com/duckdb/duckdb-java)
- ClickHouse: [JDBC driver](https://clickhouse.com/docs/integrations/language-clients/java/jdbc), [R2DBC driver](https://clickhouse.com/docs/integrations/language-clients/java/r2dbc), [ACID support](https://clickhouse.com/docs/guides/developer/transactional), [deduplicating inserts](https://clickhouse.com/docs/guides/developer/deduplicating-inserts-on-retries), [ALTER UPDATE](https://clickhouse.com/docs/sql-reference/statements/alter/update)
- Testcontainers: [ClickHouse module](https://java.testcontainers.org/modules/databases/clickhouse/)
- Flyway: [database driver reference](https://documentation.red-gate.com/flyway/reference/database-driver-reference)
