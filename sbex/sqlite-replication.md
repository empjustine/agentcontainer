---
id: sbex-sqlite-replication
type: submodule-design
status: draft
title: "SQLite backup and replication: VACUUM INTO, the driver backup API, Litestream and sqlite3_rsync"
parent: sbex
references: [sbex-persistence-engines, sbex-persistence, sbex-container-image, sbex-memory]
tags: ["sqlite", "backup", "replication", "durability", "litestream"]
---

# SQLite backup and replication: four shapes, one file to keep alive

SQLite has no server, so an application that uses it owns a concern a client/server engine hands to the database. The file must survive its host, and a copy must exist off it. This note records the four shapes that do that from a Java application — `VACUUM INTO`, the driver's backup API, Litestream and `sqlite3_rsync` — with what each needs and what each cannot promise. It does not cover the engine portability work that precedes it: [sbex-persistence](persistence.md) owns the seam as it is, and [sbex-persistence-engines](persistence-engines.md) owns the four-engine matrix. The reader is an engineer planning the SQLite leg, and arrives knowing that SQLite has one writer and one file.

## Status

Draft: a proposal. Nothing in `sbex-core`, `sbex-servlet` or `sbex-reactive` takes a backup or replicates. The behaviour stated for `VACUUM INTO` was checked against SQLite 3.46.1, and the version-dependent claims name the release that changed them.

## Four shapes

| Shape                                       | Cadence                       | What moves                       | Second process         | Off-host           | Restore                 |
| ------------------------------------------- | ----------------------------- | -------------------------------- | ---------------------- | ------------------ | ----------------------- |
| `VACUUM INTO` (SQL, through the driver)     | periodic, from the app        | one compacted snapshot           | no                     | by the app or cron | put the file back       |
| Backup API (`DB#backup`, `sqlite3 .backup`) | periodic, from the app or CLI | page copy, restartable in steps  | no                     | by the app or cron | put the file back       |
| Litestream                                  | continuous, seconds           | WAL frames                       | yes, its own binary    | built in           | `litestream restore`    |
| `sqlite3_rsync`                             | periodic, operator-scheduled  | page diffs, one snapshot per run | yes, SQLite's own tool | over ssh           | the replica is the copy |

Two of the four need nothing but SQL and a scheduler, which is why the simple path comes first. A small database with a daily snapshot loses a day of writes, and that is a decision an owner can make deliberately.

## VACUUM INTO

`VACUUM INTO` arrived in 3.27.0 as a way to write a vacuumed copy of a live database to a new file ([VACUUM](https://sqlite.org/lang_vacuum.html)). SQLite describes it as the alternative to the backup API for live databases: the output is minimal in size and carries no deleted content, while the backup API uses fewer CPU cycles and can run incrementally.

The behaviours a Java implementation depends on are these.

- **The path binds as a parameter.** The argument is a scalar expression, so `VACUUM INTO ?` takes a bound value. The check against 3.46.1 accepted a bound path, which keeps the filename out of the SQL text. A bound value removes injection, not path choice: the application names the file, never the caller.
- **The target must not exist, or be empty.** An existing database file aborts the statement and stays untouched. The working shape is therefore a temporary name, an integrity check, then a rename.
- **The copy is compacted and plain.** In the same check, a 108-page source database whose even rows had been deleted produced a 55-page copy with `journal_mode=delete`, `integrity_check` clean and the surviving rows intact. A finished copy carries no `-wal` sidecar, which is what makes it safe to tar and upload.
- **It is a transaction snapshot, not a stream.** The copy is consistent as of the statement's start. An interrupted run leaves an incomplete file, and SQLite fsyncs the output only when `synchronous` is `NORMAL` or `FULL`; a discarded temporary file is the recovery plan, not resumption.
- **It refuses to run inside a transaction.** The statement failed with "cannot VACUUM from within a transaction" both inside an explicit `BEGIN` and while a read transaction was open on the same connection. In Spring terms it must run outside `@Transactional`, on a connection in autocommit.
- **It works from a read-only connection.** The changelog records that enhancement, and 3.46.1 accepted the statement on a `mode=ro` connection. A read replica can therefore snapshot itself without write access to the origin file.
- **Free space is the output size.** `VACUUM INTO` writes the new file instead of a temporary copy, so the volume needs room for the snapshot beside the live database.
- **ROWIDs can move.** `VACUUM` may renumber rows in tables without an explicit `INTEGER PRIMARY KEY`. A schema that treats the identity as durable must keep the explicit primary key, which is the SQLite identity choice in the engine matrix.

The Java shape needs one bind, so a `PreparedStatementCreator` carries it:

```java
// Outside any transaction: SQLite refuses VACUUM inside one, and the copy
// must be a whole file before anything uploads it.
jdbc.update(
	connection -> {
		PreparedStatement statement = connection.prepareStatement("VACUUM INTO ?");
		statement.setString(1, snapshot.toAbsolutePath().toString());
		return statement;
	});
```

Three placements decide where the schedule lives, and each has one cost:

- **An in-process scheduled task** reuses the pool, the pragmas and the configuration, and it stops when the application stops — the wrong dependency for a backup.
- **The `sqlite3` CLI in cron or a Kubernetes CronJob** keeps the schedule outside the application's lifetime, and it needs the CLI in the image and the database file mounted writable beside it.
- **A sidecar** shares the volume with the writer, which is the same topology Litestream needs; it keeps the binary out of the application image.

The recommendation is the external schedule with a small runner: a snapshot cadence the operator owns, and no request-path code. Whichever placement is chosen, the snapshot needs a verification step, because an unverified backup is a belief.

## The backup API

SQLite offers `sqlite3_backup` as the page-copy interface, and the CLI wraps it as `sqlite3 db '.backup file'`. The JDBC driver exposes the same API: `org.sqlite.core.DB#backup(dbName, destFileName, observer)`, plus an overload that sets `pagesPerStep`, a sleep interval and a busy-retry count, and a matching `restore` method ([xerial `DB`](https://github.com/xerial/sqlite-jdbc/blob/master/src/main/java/org/sqlite/core/DB.java)). A connection reaches it through `((SQLiteConnection) connection).getDatabase()`.

It is the right shape when the snapshot must be resumable or must not compete with writes for CPU: the copy advances a page batch per step instead of rewriting the file in one statement. It is the wrong shape for the example's teaching goal, because it is a driver-specific surface rather than SQL, and a plan that swaps the driver would lose it. `VACUUM INTO` is the portable half, and the backup API is the escape hatch worth naming in a comment.

## Litestream

- **Model.** A separate process that reads WAL frames, takes over checkpointing through a long-running read transaction, and ships the pages to object storage, SFTP or a local path ([How it works](https://litestream.io/how-it-works/)). v0.5 is the current line, published as Debian and scratch container images.
- **Supervision.** `litestream replicate -exec "java -jar sbex-servlet.jar"` runs the application as a child, and Litestream exits when the child does. Flags must precede the positional `DB_PATH REPLICA_URL` arguments, and `-once` cannot combine with `-exec` ([Command: replicate](https://litestream.io/reference/replicate/)).
- **Restore.** `litestream restore -if-replica-exists /data/sbex.db` runs as an init step or an entrypoint precondition, before the application opens the file; `-f` follows the replica continuously for a read-only copy ([Command: restore](https://litestream.io/reference/restore/)).
- **Topology.** One Litestream per replica destination, one node at a time — a StatefulSet with a single replica. A sidecar needs a shared volume, and the guide's constraint applies: the host and the container must run the same OS, because SQLite's locking is the same across them ([Docker guide](https://litestream.io/guides/docker/), [Kubernetes guide](https://litestream.io/guides/kubernetes/)).
- **Observability.** The `metrics` block (`addr: ":9090"`) publishes Prometheus metrics, off by default; a `socket` block feeds the `status`/`info` control commands, which is what a console reads ([Prometheus metrics](https://litestream.io/reference/metrics/)).
- **Read replicas.** v0.5 serves reads straight from replica storage through a VFS: a `litestream-vfs.so` extension that registers a VFS named `litestream`, loaded with `SELECT load_extension('litestream-vfs', 'sqlite3_litestreamvfs_init')` and opened as `file:prod.db?vfs=litestream`. It is read-only, network-bound and built with CGO; prebuilt binaries ship in the releases ([VFS read replicas](https://litestream.io/guides/vfs/)).
- **What the tree needs.** A Containerfile stage carries the Litestream binary, and an entrypoint wrapper restores before it replicates. `litestream.yml` takes its replica URL and credentials from the environment (`./environment.sh` is the one loader), the metrics address becomes a scrape target, and the pod count stays pinned to one in [sbex-container-image](container-image.md).
- **What it changes in the example.** A commit is durable on the local file and replicated asynchronously, so Litestream's data-loss window replaces "one database" with "one database and a replication lag". That sentence belongs in [sbex-persistence](persistence.md), and the pool arithmetic that keeps one writer belongs in [sbex-memory](memory.md).

Litestream's own caveats are the SQLite leg's requirements restated: WAL as the journal mode, `PRAGMA busy_timeout = 5000` on every connection, one writer, and no second process writing the file ([Tips & Caveats](https://litestream.io/tips/)). The engine work produces those settings, which is the pleasant part of this note: continuous replication adds packaging, not application code.

## sqlite3_rsync

- **What it is.** SQLite's own remote-copy tool: `sqlite3_rsync ORIGIN REPLICA`, one side optionally `USER@HOST:PATH` over ssh, page hashes exchanged so only differing pages travel ([Database Remote-Copy Tool](https://sqlite.org/rsync.html)).
- **One shot, not a stream.** The replica becomes a consistent snapshot of the origin as it existed when the command started; writes to the origin during the run are not transferred. Scheduling it is the operator's job, and the replica is read-only while it runs.
- **Install.** The binary must sit on `$PATH` for ssh on both ends, or `--exe` names its location. It ships in the `sqlite-tools-*` download bundles, not in the amalgamation and not in any Java artifact ([Download](https://sqlite.org/download.html)). One database per invocation, no wildcards, and at least one end local.
- **Requirements.** WAL mode on both sides and a matching page size were required before 3.50.0 (2025-05-29) and dropped since, so a pin at 3.50 or above relaxes the application-side constraint.
- **What the tree needs.** The tool in both images, an ssh identity or a shared volume for a local-to-local copy, a timer, and a verification step.

## Choosing between them

Litestream is the writer's story: continuous, off-host, restorable, and it needs packaging rather than code. `sqlite3_rsync` is the periodic copy to a second host: a reporting replica, no object storage, a cadence the operator picks. `VACUUM INTO` is the shape for an application that already has a scheduler and an uploader, or for the SQLite leg before any tooling lands: three lines of SQL, a rename, a compression step, and a restore test. The backup API is the answer when the snapshot must be incremental or restartable.

The example can show `VACUUM INTO` and Litestream without a Java dependency, and that is the reason to keep both out of `sbex-core`: one is a statement, the other a process beside the application.

## Verification

A backup is worth what its restore test proves. Run this after the first snapshot and then on a schedule of its own:

1. Write the snapshot to a temporary path with `VACUUM INTO ?`, outside any transaction.
2. Open the copy in a fresh connection and run `PRAGMA integrity_check`; a non-`ok` result fails the run and the file is deleted.
3. Rename the verified file into place, compress it, and upload it with the timestamp in its name.
4. Restore the newest artifact into a scratch directory, run the application's migrations against it, and compare one row count with the live database.

## Open questions

- **The Litestream VFS through the driver.** The driver enables `SQLITE_OPEN_URI` by default and exposes `enable_load_extension`, so a URI filename selecting `vfs=litestream` is plausible. `SQLiteConfig` has no VFS option, so the open path and the extension-load ordering on one connection are unproven ([SQLiteConfig](https://github.com/xerial/sqlite-jdbc/blob/master/src/main/java/org/sqlite/SQLiteConfig.java)).
- **The backup API's stability surface.** `DB#backup` is public on an abstract class the driver owns, not a JDBC interface, so a driver upgrade is the compatibility event to watch.
- **Concurrent-write behaviour of `VACUUM INTO` under load.** The check ran on an idle database; a soak test with the report endpoint streaming beside a snapshot is the measurement that decides the cadence.

## References

- SQLite: [VACUUM (including INTO)](https://sqlite.org/lang_vacuum.html), [backup API](https://sqlite.org/c3ref/backup_finish.html), [sqlite3_rsync](https://sqlite.org/rsync.html), [changes](https://sqlite.org/changes.html), [download bundles](https://sqlite.org/download.html)
- xerial sqlite-jdbc: [`DB` backup and restore](https://github.com/xerial/sqlite-jdbc/blob/master/src/main/java/org/sqlite/core/DB.java), [`SQLiteConfig`](https://github.com/xerial/sqlite-jdbc/blob/master/src/main/java/org/sqlite/SQLiteConfig.java)
- Litestream: [how it works](https://litestream.io/how-it-works/), [tips and caveats](https://litestream.io/tips/), [replicate](https://litestream.io/reference/replicate/), [restore](https://litestream.io/reference/restore/), [metrics](https://litestream.io/reference/metrics/), [VFS read replicas](https://litestream.io/guides/vfs/), [cron-based backup](https://litestream.io/alternatives/cron/), [Docker](https://litestream.io/guides/docker/), [Kubernetes](https://litestream.io/guides/kubernetes/)
- Engine context: [sbex-persistence](persistence.md), [sbex-persistence-engines](persistence-engines.md)
