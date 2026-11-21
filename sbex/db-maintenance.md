---
id: sbex-db-maintenance
type: submodule-design
status: draft
title: "Database maintenance without a DBA: traps, backups and routine work five engines still need"
parent: sbex
references:
  [
    sbex-persistence,
    sbex-persistence-engines,
    sbex-sqlite-replication,
    sbex-container-image,
    sbex-memory,
    sbex-observability,
    d193,
  ]
tags:
  [
    "persistence",
    "maintenance",
    "backup",
    "restore",
    "kubernetes",
    "containers",
    "sqlite",
    "duckdb",
    "postgresql",
    "clickhouse",
    "oracle",
  ]
---

# Database maintenance without a DBA: traps, backups and routine work across five engines

`sbex` runs PostgreSQL 16 and Oracle XE 21c from images with no volume and no backup, which is where every small deployment starts. This note records what that posture costs and what a team with no DBA still owns: the traps that turn a containerised database into an outage, the backup and restore shape each of five engines needs, and the routine maintenance the missing role used to do. It does not design the backup job for this example, and it leaves query tuning and capacity planning out; [sbex-persistence](persistence.md) owns the schema and [sbex-persistence-engines](persistence-engines.md) the engine matrix. The reader is the engineer who owns the deployment because nobody else does.

## Status

Draft: a checklist with its reasoning, not an implemented runbook. The two engines with running code are the ones whose container details this note can name from the tree — `postgres:16-alpine` and `gvenzl/oracle-xe:21-slim` — while SQLite, DuckDB and ClickHouse are the [sbex-persistence-engines](persistence-engines.md) targets. Each claim links the vendor document that owns it, and a version-dependent claim names the release it was checked against. Nothing in the tree takes, ships, verifies or restores a backup.

## Assumptions that hold on a laptop and fail in a cluster

A fire-and-forget deployment diagnoses a laptop correctly and a cluster wrongly. Four assumptions carry it, and each one has a cheap guard.

| The assumption                | What meets it first                                                                                                                        | The guard                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| The container keeps its files | The writable layer dies with the container; the [`gvenzl/oracle-xe` quick start](https://github.com/gvenzl/oci-oracle-xe) says so outright | A volume on the engine's data path, named in the deployment manifest  |
| One instance is one database  | A rolling update, a second replica, or a backup job that mounts the data volume opens a second writer                                      | One writer, enforced by the workload type and the strategy            |
| "Small" stays small           | A log, audit or event table grows with traffic rather than with the schema                                                                 | Retention from the first deploy, and an alarm on size                 |
| The image maintains itself    | An image tag is a build artifact; the server inside still has jobs, wraparound and a disk                                                  | The vendor's maintenance job switched on, and an alert on its failure |

The common failure is not corruption. It is the loss of the only copy together with a pod that restarts into a crashloop, and neither half shows up in the application's log.

## State must outlive the pod

Every engine here is a process over files, so the first decision is where the files live and the second is what may delete them.

- Mount the engine's data path from a volume, not from the image. `kubectl delete pod` and a node drain are routine events, and the writable layer is not evidence.
- Prefer a StatefulSet's `volumeClaimTemplates` to a hand-written claim: the claim follows the pod identity, and `kubectl delete -f` leaves the claims behind unless `persistentVolumeClaimRetentionPolicy` says otherwise ([StatefulSet](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)).
- Set `reclaimPolicy: Retain` on the StorageClass. A dynamically provisioned PV defaults to `Delete`, so removing the claim destroys the only copy ([reclaiming](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#reclaiming)).
- Expect no shrink. A claim grows and never shrinks, so a restore into a smaller volume is a new claim and not an edit.
- Give PostgreSQL a subdirectory. `initdb` refuses a non-empty directory and an ext4-formatted volume carries `lost+found`, so `PGDATA=/var/lib/postgresql/data/pgdata` makes the first boot independent of the filesystem ([image variables](https://hub.docker.com/_/postgres)).
- Match the volume's ownership to the image's user. The PostgreSQL image runs as its own `postgres` user, and an NFS export with root squash leaves a data directory the server cannot write.
- Keep temp off the memory-backed `emptyDir`. A spill directory on `medium: Memory` is charged to the pod's memory limit, and the engine spills exactly when memory is short ([emptyDir](https://kubernetes.io/docs/concepts/storage/volumes/#emptydir)).
- Accept that one replica means every drain, cluster upgrade and autoscaler decision is downtime. A PodDisruptionBudget cannot protect a one-replica StatefulSet: `minAvailable: 1` blocks the drain instead of tolerating it.

## One writer per engine, enforced by the workload

The engine's concurrency contract decides the Kubernetes object, and the wrong object produces two writers rather than an error.

| Engine     | Concurrency contract                                                                     | Kubernetes shape                                           |
| ---------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| SQLite     | One process per file; WAL needs a shared-memory index, so every process sits on one host | One pod, `Recreate`, `ReadWriteOnce`                       |
| DuckDB     | One writer process; other processes open the file read-only                              | Same as SQLite, and no shared claim at all                 |
| PostgreSQL | One primary and many connections; a standby is a read-only copy                          | One-replica StatefulSet, or an operator                    |
| ClickHouse | Many processes, one writer per part; replicated tables need Keeper's quorum              | StatefulSet plus Keeper, or the operator                   |
| Oracle     | One instance per set of data files; RAC is the only multi-instance form                  | One-replica StatefulSet; RAC has no single-container shape |

- `ReadWriteOnce` is a node-level rule, not a pod-level one: the volume "can be mounted as read-write by a single node" ([access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes)). Two pods on one node can mount one claim, so a Deployment with `strategy: RollingUpdate` gives a SQLite file two writers for the length of a rollout. `ReadWriteOncePod` is the pod-scoped mode where the driver supports it, and `Recreate` is the portable fix.
- WAL does not work over a network filesystem. SQLite's own documentation gives the reason — all processes must share a small amount of memory — so an RWX claim on NFS is a corruption path, not a scaling option ([WAL](https://sqlite.org/wal.html), [corruption](https://sqlite.org/howtocorrupt.html)).
- DuckDB allows one writer process and read-only readers; a second writer over a share fails on the lock or corrupts the file ([concurrency](https://duckdb.org/docs/2.0/connect/concurrency)).
- A ClickHouse replica is a coordinated copy of parts, not a second writer of one data directory. Two servers over one directory corrupt it, and only the replicated engine coordinates writers.
- PostgreSQL is the engine here that a second process is designed to join, and it still allows one primary. A hot standby adds availability and no write capacity.
- The application's pool is a writer too. Forty connections against a SQLite file pin the only lock; against PostgreSQL they compete with `max_connections` (100 by default) alongside the backup job and the migration.

## The image is not a maintained server

- `POSTGRES_PASSWORD` is read at `initdb` only, and it is the one required variable of the image ([image variables](https://hub.docker.com/_/postgres)). Rotating the Secret changes an environment variable and not the database's password, so a rotation also runs `ALTER ROLE`.
- A major-version tag over an existing `PGDATA` cannot start: the data directory carries `PG_VERSION`, and the entrypoint refuses to initialize over a non-empty directory. That is a `pg_upgrade` or a dump and restore, scheduled as work ([pg_upgrade](https://www.postgresql.org/docs/current/pgupgrade.html)).
- `latest` re-pulls on a pod restart, because that tag defaults to `imagePullPolicy: Always`. A crashloop then changes the engine under the data, and DuckDB makes that visible: its storage format is backward compatible only, so a newer file cannot be opened by an older engine ([storage versions](https://duckdb.org/docs/2.0/internals/storage)).
- Oracle's pluggable database does not return in the open state after a container restart unless it is saved with `ALTER PLUGGABLE DATABASE … SAVE STATE` ([SQL reference](https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-PLUGGABLE-DATABASE.html)). The listener answers and the application's service does not exist, which reads as an application failure.
- Oracle's SGA lives in shared memory, and `/dev/shm` is a fixed-size tmpfs the runtime sizes (`--shm-size` in [docker run](https://docs.docker.com/reference/cli/docker/container/run/)). A tmpfs smaller than the SGA fails the startup, and the pod-level fix is an `emptyDir` with `medium: Memory` on `/dev/shm`.
- Oracle Free caps the instance at 2 CPUs, 2 GB of RAM and 12 GB of user data ([Free](https://www.oracle.com/database/free/)). The cap is an edition term and not an error message, so the capacity alarm belongs below it.
- ClickHouse's `default` user has no password until one is set, and the HTTP port answers on `8123`. A `LoadBalancer` Service in front of a scratch cluster is an open database.
- Database logs land on the volume as well as on stdout: Oracle's ADR, ClickHouse's `system.query_log`, PostgreSQL's `log/` under an unrotated `log_destination`. Log retention is a disk-space decision.

## Memory, probes and shutdown

- A memory limit is the engine's hard ceiling, and the kernel kills the process that crosses it ([resource management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)). For PostgreSQL, `shared_buffers` is not that ceiling: every backend, `work_mem` per sort node, and the page cache are also charged to the cgroup.
- The OOM killer takes the largest process, which is the database. `restartPolicy: Always` then restarts the server into crash recovery, and a limit too small for recovery turns one kill into a loop.
- ClickHouse needs memory for merges and caches on top of queries, and DuckDB spills to `temp_directory` once `memory_limit` is reached ([limits](https://duckdb.org/docs/2.0/operations_manual/limits)). A limit sized for the average query is a limit that kills the merge.
- A CPU limit throttles checkpoints, WAL archiving and merges. We recommend a CPU request and no tight limit for an engine with background work.
- A liveness probe that queries the database restarts it during a slow recovery and lengthens the recovery. Probe readiness with a real query, liveness with the process, and give startup its own budget: `pg_isready` answers only once recovery finishes ([probes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#container-probes)).
- `terminationGracePeriodSeconds` must exceed a fast shutdown, because Kubernetes sends `SIGTERM` and then `SIGKILL` at the deadline. A PostgreSQL killed mid-checkpoint recovers, and an Oracle instance killed the same way runs crash recovery on the next start — slower than the shutdown it was denied.
- `emptyDir` survives a container restart and dies with the pod. The difference matters for a spill directory, and for anything the application treats as a cache.

## Disk is the limit that ends the run

Every engine writes more than the rows: redo, WAL, temp, undo, merge input and logs. A small table on a large volume still fills it.

| Engine     | What grows without new rows                                                                       | The number that predicts it                                          |
| ---------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| PostgreSQL | WAL pinned by a slot or a replica, `pg_wal` when `archive_command` fails, temp files, bloat, logs | `pg_wal` bytes, `pg_replication_slots.wal_status`, archiver failures |
| Oracle     | FRA (archived redo), datafiles with `AUTOEXTEND`, undo, temp, ADR traces                          | FRA percentage, tablespace percentage, ORA-19809 and ORA-01653       |
| ClickHouse | Parts, merges that rewrite before they delete, mutations, Keeper's log                            | Parts per partition, free bytes in `system.disks`                    |
| SQLite     | Freelist pages, the `-wal` file, the `-shm` file                                                  | File size plus WAL size against the volume                           |
| DuckDB     | The `.wal` file, the spill directory, a file that never shrinks                                   | File size plus temp usage against the volume                         |

- A full volume stops PostgreSQL writes, and a full `pg_wal` can force a shutdown. An `archive_command` that keeps failing keeps every segment it could not ship, so the archiver's failure count is also a disk alert ([continuous archiving](https://www.postgresql.org/docs/current/continuous-archiving.html)).
- An abandoned replication slot pins WAL indefinitely. A slot whose `wal_status` has left `reserved` and a `pg_wal` that grows with no replica attached are the same fault seen twice.
- Oracle's FRA has its own quota in `db_recovery_file_dest_size` ([reference](https://docs.oracle.com/en/database/oracle/oracle-database/21/refrn/DB_RECOVERY_FILE_DEST_SIZE.html)). ORA-19809 and ORA-00257 are the archiver stopping, and the database stops archiving with it.
- A ClickHouse part is rewritten before the old one is deleted, so a merge needs free space of the same order as the data it merges, and a mutation rewrites every part it touches.
- SQLite's `VACUUM` needs free space up to twice the database's size, and `VACUUM INTO` needs the size of the copy ([VACUUM](https://sqlite.org/lang_vacuum.html)). A backup written to the same volume is therefore a disk-space event.
- Kubernetes evicts a pod under node disk pressure, and the kubelet's own image and log usage is part of that budget ([eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)). A node-local volume shares the node's disk with everything else on it.

## Back up the engine, not the volume

Six rules hold for all five engines; the sections after them carry the mechanics.

1. The copy leaves the failure domain. A second file on the same volume, a snapshot in the same account and a copy on the same node share the fate they exist to survive.
2. The copy is engine-aware. A file copy of a running server is crash-consistent at best, and only WAL, archived redo or the backup command makes it recoverable.
3. The copy has a manifest: engine version and image tag, locale and encoding, extensions, roles, the application commit and the migration version. A restore that cannot reproduce the server changes behaviour silently.
4. The copy is verified by a restore into an empty target, on a schedule, with the numbers recorded.
5. The credential that takes the copy cannot delete it. Object lock or a separate account is the difference between a backup and a copy that the same intrusion encrypts.
6. Retention is a policy with a window, because a deleted row survives in every backup until that window passes. A deletion request must reach the backups, or the policy must say that it does not.

A `VolumeSnapshot` copies bytes at a moment and asks the database nothing ([snapshots](https://kubernetes.io/docs/concepts/storage/volume-snapshots/)). The result is recoverable the way a power cut is recoverable, and only when the engine's logs travel with it: a PostgreSQL volume snapshot is a base backup only if the WAL from that moment is archived, and a data directory without its archive is a copy of an unknown state. A snapshot is a good second line for a small database and a poor first one.

### PostgreSQL

- Logical: `pg_dump -Fc` writes one internally consistent snapshot of one database without blocking writers, and `pg_restore -j` loads it. A restore into a live database collides instead of merging ([dump](https://www.postgresql.org/docs/current/backup-dump.html), [pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html)).
- `pg_dump` carries neither roles nor tablespaces; `pg_dumpall --globals-only` is that half, and `pg_hba.conf` and `postgresql.conf` are the other ([pg_dumpall](https://www.postgresql.org/docs/current/app-pg-dumpall.html)).
- The dump's owner is the role that ran it, so a restore into another role pair needs `--no-owner` and a grant step.
- Physical: `pg_basebackup` plus continuous archiving — `wal_level = replica`, `archive_mode`, `archive_command` or `archive_library` — is the path to point-in-time recovery, `recovery_target` picks the moment, and `pg_verifybackup` checks the base copy before it is needed ([archiving](https://www.postgresql.org/docs/current/continuous-archiving.html), [pg_verifybackup](https://www.postgresql.org/docs/current/app-pgverifybackup.html)).
- A new cluster archives nothing, because `archive_mode` is off by default. The first decision is whether the recovery point is the last backup or the last second.
- A backup role needs read access to every table: `pg_read_all_data`, plus `pg_monitor` for the statistics views, and not superuser ([predefined roles](https://www.postgresql.org/docs/current/predefined-roles.html)).
- `pg_amcheck` and `pg_checksums` find corruption that a copy carries faithfully. Neither replaces the drill.
- A replica is not a backup: `DROP TABLE` and a bad `DELETE` reach the standby, so only a delayed replica survives the statement.

### Oracle

- RMAN is the backup tool: full, incremental and archived-log backups, a control-file autobackup, and `BACKUP VALIDATE` for the blocks it reads ([Backup and Recovery User's Guide](https://docs.oracle.com/en/database/oracle/oracle-database/21/bradv/index.html), [validating](https://docs.oracle.com/en/database/oracle/oracle-database/21/bradv/validating-database-files-backups.html)). The guide puts "user-managed" file copies in a separate part, and the separation is the point: only RMAN records which blocks it read.
- Archivelog mode is off in a new database, and point-in-time recovery needs it. Enabling it takes a mount and `ALTER DATABASE ARCHIVELOG`, so it belongs in the first deploy and not in the incident ([PITR](https://docs.oracle.com/en/database/oracle/oracle-database/21/bradv/rman-performing-flashback-dbpitr.html)).
- A control-file catalog forgets: `CONTROL_FILE_RECORD_KEEP_TIME` defaults to seven days, and a backup older than that loses its record ([reference](https://docs.oracle.com/en/database/oracle/oracle-database/21/refrn/CONTROL_FILE_RECORD_KEEP_TIME.html)). A recovery catalog, or a retention shorter than that window, is the choice.
- Data Pump (`expdp`/`impdp`) is an export, not a backup: it cannot recover to a point in time and cannot repair a block. It is the portable unit for a schema move and the restore of last resort.
- A PDB is backed up as part of its CDB. A PDB-level restore is a tablespace point-in-time recovery or a duplicate, and an `expdp` of the PDB is the unit a drill can test.
- The FRA is also the backup destination's quota. `db_recovery_file_dest_size` set from a small default stops the archiver, and the database stops writing with it.

### ClickHouse

- `BACKUP DATABASE … TO S3(...)`/`File(...)`/`Disk(...)` writes parts and metadata, and `ASYNC` returns an id that `system.backups` reports on ([backup](https://clickhouse.com/docs/operations/backup)). The job must poll a status rather than a shell exit code.
- A restore goes into empty tables. `RESTORE` is not a merge, so a table that already holds data fails the load.
- There is no point-in-time recovery: the newest backup is the recovery point, which makes the backup cadence an RPO decision.
- A replica is not a backup. `ReplicatedMergeTree` copies a `DROP TABLE`, a `TRUNCATE` and every mutation, so the second node holds the same mistake ([replication](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replication)).
- `clickhouse-backup` is a third-party tool with object storage and incremental shapes ([repository](https://github.com/Altinity/clickhouse-backup)). It is a separate credential, a separate release cadence and a separate thing to test.
- Keeper carries the replicated tables' metadata. Losing Keeper with the data intact leaves tables read-only, so Keeper's data directory is a backup target with its own quorum, and an odd number of Keeper replicas is the shape.

### DuckDB

- `EXPORT DATABASE 'dir' (FORMAT parquet)` writes the schema plus one file per table, and `IMPORT DATABASE 'dir'` reads it back ([EXPORT](https://duckdb.org/docs/2.0/sql/statements/export)). This is the portable copy, and an application that holds the writer can take it.
- A file copy is safe only with no writer and a completed `CHECKPOINT`, because the write-ahead log is a separate file. A copy without the log either loses the tail or fails to open ([CHECKPOINT](https://duckdb.org/docs/2.0/sql/statements/checkpoint)).
- The storage format is backward compatible in one direction only, so an image rollback is a compatibility event: pin the engine with the file, and take an export before an upgrade.
- An in-process engine has no server to schedule anything. The checkpoint, the export and the integrity re-read are the application's job or a cron's, and the WAL is replayed on the next open, so a kill costs time rather than the database.
- `memory_limit` and `temp_directory` decide whether a large aggregation spills or fails ([configuration](https://duckdb.org/docs/2.0/configuration/overview)), and the spill needs a volume with room.

### SQLite

- Four shapes cover it — `VACUUM INTO`, the driver's backup API, Litestream and `sqlite3_rsync` — and [sbex-sqlite-replication](sqlite-replication.md) compares them on cadence, second process and restore. This note adds only the container half.
- Never copy a live file with `cp`. A copy can catch a page mid-write, and the `-wal` sidecar is a separate file ([VACUUM INTO](https://sqlite.org/lang_vacuum.html), [backup API](https://sqlite.org/c3ref/backup_finish.html), [corruption](https://sqlite.org/howtocorrupt.html)).
- The `-wal` and `-shm` files are part of the database. A restore that brings the main file alone and leaves an old WAL beside it replays someone else's writes.
- Run `PRAGMA integrity_check` (or `quick_check`) on the copy, at the backup site, so a corrupt copy is found before the restore ([pragma](https://sqlite.org/pragma.html)).
- The directory must be writable for WAL, and the file's ownership is the entire grant model: a backup job in another image with another uid cannot read the file.
- `VACUUM` reclaims the freelist and needs up to twice the file's size in free space. `auto_vacuum=incremental` spreads that cost, and turning it on for an existing file needs a `VACUUM`.

## Restore is the part that gets tested

A backup that has never been restored is a hypothesis. The restore has its own traps, and each one is cheaper to find in a drill than in an incident.

- Restore into a new instance and a new namespace. A restore over the live database is an irreversible write.
- Reproduce the server, not only the data: the same engine version and image tag, the same locale and encoding (`CREATE DATABASE … TEMPLATE template0` when the template's locale is wrong), the same extensions installed in the image before the dump runs, and the same roles.
- Restore the cluster-global half: roles, `pg_hba.conf`, `postgresql.conf`, the deployment values and the image tag. A logical dump is one database, and the behaviour a backup must reproduce spans the server.
- Reconcile the schema history. A dump of yesterday's database under today's application re-runs the migration tool against a history that does not match, and a failed migration leaves a row that blocks every later one. `flyway repair` fixes the row and not the half-applied DDL, and Oracle commits each DDL, so there is no transaction to roll back.
- Reconcile sequences and identities after a partial restore. A restored table on a stale sequence collides on the first insert, and `setval` is the repair.
- Measure the restore. Index rebuilds, `maintenance_work_mem`, `pg_restore -j` and the pod's memory limit set the time, not the dump's size; an RTO measured on a laptop is a guess.
- Verify the result instead of opening it: `pg_verifybackup` or `pg_amcheck` on PostgreSQL, `RMAN VALIDATE` on Oracle, `RESTORE`'s own checksums on ClickHouse, `PRAGMA integrity_check` on SQLite, `IMPORT DATABASE` on DuckDB, and the application's smoke test last.

### Run the restore drill

1. Pick the newest backup of the production database, and write down its timestamp, size and manifest.
2. Create an empty namespace, and start the same image tag with the same configuration on a fresh volume.
3. Restore into the empty database under a new instance name, and time the command.
4. Run the verification for the restore shape: `pg_verifybackup`, `pg_amcheck`, `RMAN VALIDATE`, `PRAGMA integrity_check`, `RESTORE` or `IMPORT DATABASE`.
5. Run the migration tool in validate mode, then the application's smoke tests against the restored database.
6. Compare three numbers with production: row counts for the largest tables, the newest timestamp in the busiest table, and the migration version.
7. Record the duration, the failures and every step the runbook was missing, then delete the namespace.
8. Repeat on the cadence the owner named. A drill nobody ran is a missing backup.

## Routine maintenance the missing DBA did

Three jobs repeat in every engine: reclaim what deleted rows leave behind, keep the optimizer's statistics true, and watch the signals that precede failure. The engines differ in who runs them and in what "reclaim" means.

### PostgreSQL

- autovacuum is the routine and it is on. Per-table thresholds are the tuning that matters on a small, hot table: the default scale factor waits for 20% dead rows, which is 40 updates of a 200-row table and four million of a 20-million-row one ([vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)).
- `VACUUM` marks space reusable and does not return it to the filesystem, so a table that grows and shrinks keeps its high-water mark. That is normal; a file that grows without bound is bloat, and `pg_repack` or a rewrite is the fix.
- Wraparound is the one maintenance failure that stops writes. `age(datfrozenxid)` climbs, PostgreSQL 16 warns from forty million transactions before the limit, and the server refuses new transactions at three million. `autovacuum_freeze_max_age` defaults to 200 million, and `vacuum_failsafe_age` is the last resort.
- A long transaction, an old prepared transaction or an abandoned replication slot blocks the vacuum that would prevent wraparound. `idle_in_transaction_session_timeout` and `pg_prepared_xacts` remove the cause, and the `pg_stat_activity` rows with a large `backend_xmin` age are the symptom.
- Run `ANALYZE` after a bulk load. Autovacuum analyzes on its own schedule, and a bulk load changes the distribution a plan depends on.
- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, and a failure leaves an INVALID index that still costs every write ([CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html)). The migration must be marked non-transactional, and `pg_index.indisvalid` is the check after any failure.
- `REINDEX` is for a corrupted or badly bloated index, not a routine. `pg_stat_user_indexes.idx_scan` shows the indexes nothing reads.
- The small monitoring set: `pg_stat_activity` for long and idle-in-transaction sessions, `pg_stat_user_tables` for `n_dead_tup` and `last_autovacuum`, `pg_stat_database` for deadlocks, rollbacks and `temp_bytes`, `pg_stat_archiver` for `failed_count`, and `pg_stat_replication` for lag ([monitoring](https://www.postgresql.org/docs/current/monitoring-stats.html)).
- `pg_stat_statements` needs `shared_preload_libraries` and is worth the restart it costs. A dashboard without it answers "the database was slow" and not "this statement was".
- `max_connections` is 100 by default and each connection is a process. A pool of forty per replica, a backup job and a migration exhaust it, and a pooler is cheaper than 300 backends.

### Oracle

- There is no autovacuum; the routine is statistics. The automatic maintenance job gathers them, `DBMS_STATS` is the interface, and `ANALYZE` is not the tool for optimizer statistics ([ANALYZE](https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ANALYZE.html), [Administrator's Guide](https://docs.oracle.com/en/database/oracle/oracle-database/21/admin/index.html)).
- `AUTOEXTEND` on the datafiles means a full tablespace is a full volume. `DBA_FREE_SPACE`, `DBA_SEGMENTS` and the FRA percentage are the numbers that predict it.
- The archiver and its deletion policy are one job: RMAN deletes archived logs only under a policy, and a policy that was never set keeps everything until the FRA fills.
- `CROSSCHECK` and `DELETE EXPIRED` keep the catalog honest after a backup file is removed by hand — the state a container's `rm` leaves behind.
- Undo is a sized resource. `undo_retention` is a target, a long query against a busy undo tablespace ends in ORA-01555, and a large sort grows a temp tablespace that fills the volume.
- The alert log and the ADR trace files are maintenance: the diagnostic repository writes to the volume with no retention of its own.
- A container restart mounts the PDBs. `SAVE STATE` plus a health check on the PDB's service is the pair that turns a start into a usable database.
- The automatic maintenance window, the `DBMS_SCHEDULER` jobs and the unified audit trail are growth sources no application table explains.
- AWR belongs to the Diagnostics Pack licence. Statspack is the free substitute, and a retention nobody chose is either a licence question or a full `SYSAUX`.

### ClickHouse

- Merges are the maintenance, and the part count is the health signal: `system.parts` per partition, with the insert-side ceiling `parts_to_throw_insert` (300 by default) turning too many small inserts into an error ([MergeTree settings](https://clickhouse.com/docs/operations/settings/merge-tree-settings), [parts](https://clickhouse.com/docs/operations/system-tables/parts)).
- Batch inserts from the application, or `async_insert`, are the fix. A merge cannot keep up with one row per request by design.
- A mutation is asynchronous: `ALTER TABLE … DELETE`/`UPDATE` rewrites every part it touches, `system.mutations.is_done` reports progress, and `KILL MUTATION` is the escape. A stuck mutation grows the disk while it waits ([mutations](https://clickhouse.com/docs/guides/developer/mutations)).
- Use TTL and partition drops for retention. `DROP PARTITION` removes files, and a mutation that deletes rows rewrites them ([TTL](https://clickhouse.com/docs/guides/developer/ttl)).
- Replication has its own queue: `system.replication_queue`, `system.replicas.is_readonly` and `absolute_delay`, and Keeper's quorum ([replication queue](https://clickhouse.com/docs/operations/system-tables/replication_queue)). A read-only replica does not heal itself while Keeper is down.
- Deleted parts stay for `old_parts_lifetime` before the disk frees them, so a delete-and-insert loop needs headroom rather than accounting.
- `OPTIMIZE … FINAL` rewrites a partition and belongs in a migration or a repair, not a schedule ([OPTIMIZE](https://clickhouse.com/docs/sql-reference/statements/optimize)).
- The system tables grow: `system.query_log` and `system.trace_log` record every query, and their retention is a configuration decision on the data volume.

### SQLite and DuckDB

- There is no server, so there is no job: the application's lifecycle is the only scheduler, and a cron that opens the file read-write is a second process. SQLite tolerates that on one host; DuckDB does not.
- SQLite: `PRAGMA optimize` before a connection closes, `ANALYZE` for the statistics it leaves out, `PRAGMA integrity_check` on a schedule, and `PRAGMA wal_checkpoint(TRUNCATE)` to bound the WAL after a long reader ends ([pragma](https://sqlite.org/pragma.html), [ANALYZE](https://sqlite.org/lang_analyze.html)).
- SQLite's surprising defaults: `foreign_keys` is off per connection, `busy_timeout` is zero, and `synchronous=NORMAL` in WAL mode keeps the file intact across a power loss while losing the last commits ([WAL](https://sqlite.org/wal.html)).
- DuckDB: `CHECKPOINT` (or `FORCE CHECKPOINT`) bounds the WAL, `VACUUM` returns the space a delete left, and `memory_limit` with `temp_directory` decides whether a large aggregation spills or fails ([VACUUM](https://duckdb.org/docs/2.0/sql/statements/vacuum), [limits](https://duckdb.org/docs/2.0/operations_manual/limits)).
- The file is the whole database, so its permissions and the volume's free space are the entire access-control and capacity story. The image that reads it must be the version that wrote it.

## The minimum alert set

A successful backup job is not the signal. The age of the newest backup and the date of the last verified restore are, and the rest of the table catches the failures above before an application error does.

| Signal                                                          | Engine                         | What it precedes                                           |
| --------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| Restart count and start time of the database container          | all                            | a crashloop, and a recovery that never finished            |
| Free bytes on the data volume, with a growth rate               | all                            | the disk-full outage; a bare percentage fires at the end   |
| OOM kills and memory pressure on the node                       | all                            | the OOM loop during recovery                               |
| Connections in use against the limit                            | PostgreSQL, Oracle, ClickHouse | exhaustion by the pool, the backup job and a migration     |
| `pg_stat_archiver.failed_count` and the `pg_wal` size           | PostgreSQL                     | point-in-time recovery ending at the last good archive     |
| `age(datfrozenxid)` and the oldest `backend_xmin` age           | PostgreSQL                     | the wraparound refusal to write                            |
| Invalid indexes (`pg_index.indisvalid = false`)                 | PostgreSQL                     | a migration's half-built index                             |
| FRA percentage, tablespace percentage, archiver errors          | Oracle                         | ORA-19809, ORA-00257 and ORA-01653                         |
| `system.replication_queue` length, `is_readonly`, Keeper quorum | ClickHouse                     | a read-only replica and a queue that only grows            |
| Parts per partition and stuck mutations                         | ClickHouse                     | too many parts, and a delete that rewrites the disk        |
| Newest backup age, job failure, last drill date                 | all                            | the loss of the only copy                                  |
| Oldest long transaction, blocking session, running merge        | PostgreSQL, Oracle, ClickHouse | a vacuum that cannot finish, a lock chain, a merge backlog |

A CronJob whose absence nobody alerts on is a backup schedule that ends quietly. `startingDeadlineSeconds` unset means a missed run has no deadline, and more than 100 missed schedules run only the most recent one ([CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)). Alert on the age of the newest backup, not only on the job's exit code.

## Access, ownership and the second role

"my application only" is an ownership claim about the schema, not about the server. Three roles carry the split.

- The application's role owns its schema and nothing else: no `CREATEDB`, no `CREATEROLE`, no superuser, and never `SYS`/`SYSTEM` on Oracle or `default` on ClickHouse as the application's login.
- A maintenance role reads the whole database and writes only the engine's own structures: `pg_monitor` and `pg_read_all_data` for monitoring and backup on PostgreSQL, `SYSDBA` for RMAN on Oracle, `access_management` for the backup user on ClickHouse.
- A break-glass role is used only in an incident, and its use is logged. It is the account a restore drill needs and the account the application must not hold.
- An in-process engine has no roles at all: the file's uid and mode are the grant. The application, the backup job and the retention cron must share a uid, or a group with the right mode, and WAL needs write access to the directory as well as the file.
- The schema owner is not the cluster owner. `DROP DATABASE` and `DROP TABLESPACE` are cluster operations, and the application's credential must not reach one. PostgreSQL 15 also stopped granting `CREATE` on the `public` schema to `PUBLIC`, so an image bump from 14 to 15 changes what the application may create ([schemas](https://www.postgresql.org/docs/current/ddl-schemas.html)).

## Decisions to record before the first deploy

Six decisions make the rest cheap, and each one is a line in the deployment's own document.

- RPO and RTO as numbers: how much write loss is acceptable and how long a restore may take. The backup cadence and the engine follow from them, and nothing in this note substitutes for them.
- Retention per table class. The audit or event table needs its window before its first row, and the backup's window must cover the deletion promise.
- One writer shape: the workload type, the strategy, the claim mode and the pool size, written down once.
- The engine pin: image tag and digest, plus the upgrade path (dump and restore, `pg_upgrade`, `impdp`, an export) with the step that tests it.
- The drill's owner and cadence, and the alarm for a backup that stops. A missing owner is the root cause this note describes, and the rest is mechanics.
- The licence boundary: Oracle Free's 2 CPUs, 2 GB and 12 GB, and Oracle's [partitioning policy](https://www.oracle.com/corporate/contracts/partitioning-policy/), which decides what counts as hard partitioning. A container is soft partitioning, so the licence follows the node's cores rather than the pod's limits.
