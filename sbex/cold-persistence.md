---
id: sbex-cold-persistence
type: submodule-design
status: draft
title: "Cold persistence: MotherDuck, Parquet generations, object storage, SMR and erasure coding"
parent: sbex
references:
  [
    sbex-datalakehouse-port,
    sbex-persistence-engines,
    sbex-sqlite-replication,
    sbex-cold-tier-platforms,
    sbex-optimisation-findings,
    d173,
    d203,
    d205,
  ]
tags:
  ["cold-storage", "parquet", "motherduck", "object-storage", "smr", "erasure-coding", "retention"]
---

# Cold persistence: what the archive needs before it needs code

The lakehouse port gives the example an archive instead of a toy table, and an archive has a second half: the rows that must survive but must not stay hot. This note is the thinking that precedes that tier — the storage shapes, the engine and version constraints, the integrity and erasure questions, and the decisions to settle before a single generation is written. It is not a design of the demotion job: [sbex-datalakehouse-port](datalakehouse-port.md) owns the port's hot side, and the unit's records own the retention requirements.

## Status

Draft: research and decision scaffolding. Nothing in the tree writes Parquet, uploads an object, or attaches a `md:` database. The host the archive would land on is a drive-managed SMR disk under LUKS2 and a two-copy btrfs RAID1, and the shape below assumes that stack rather than an ideal one.

## The four tiers

| Tier | Medium                                                          | What lives there                                                         | What it must answer                                     |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| hot  | SQLite, one writer                                              | presence, recent visits, documents, rules, tombstones, the dedupe ledger | `/visited` in milliseconds, ingest without backpressure |
| warm | local Parquet generations                                       | closed windows of visits and session entries                             | exports, rebuilds, the slow `/search` fallback          |
| cool | object storage, or MotherDuck                                   | the same generations, copied off the host                                | durability and disaster recovery                        |
| cold | drive-managed SMR behind LUKS2 and btrfs RAID1, removable media | sealed generations nobody queries                                        | survival, verifiability, low cost                       |

The split is driven by one latency budget and one growth rate: `/visited` answers from the presence row and never from a file, while sessions and visits grow without bound. Everything else — postings, statistics, documents — is derived or mutable and belongs hot until a measurement says otherwise.

## MotherDuck: a managed DuckDB with a version window

MotherDuck is a serverless warehouse built on DuckDB, with hypertenancy (one Duckling per user or service account) and Dual Execution splitting a query between local and cloud compute.

Three constraints decide how a local archive talks to it.

- **The DuckDB version window is narrow.** The published compatibility file puts the global region at DuckDB 1.4.0 to 1.5.6, pins `duckdb_jdbc` at 1.5.6.0, and floors the CLI at 1.5.5. The engine note's local DuckDB pin is 2.0.0.1, which sits outside that window, so the archive either pins 1.5.6.0 everywhere, isolates the `md:` fold in its own process, or reaches MotherDuck through its Postgres endpoint with the already-pinned `postgresql` driver. Two DuckDB versions in one classpath is the failure this decision avoids.
- **Snapshots are a service feature, not a backup plan.** MotherDuck snapshots a changed database roughly once a minute when no write is running, retains them as historical bytes under `SNAPSHOT_RETENTION_DAYS` on the Business plan, exposes them in `md_information_schema.database_snapshots`, and offers restore and undrop. That is cloud-side history; it does not replace an off-host copy of the same data in a format a local process can read.
- **Credentials live in the service.** Secrets for S3, GCS, Azure and R2 are stored encrypted and scoped to the account, so a Duckling can read external Parquet directly. That moves the object-storage credentials out of the artefact, and leaves the Parquet encryption key as the client's own secret to hold.

## Parquet: the generation format

DuckDB writes Parquet from a query, which makes the demotion job a `COPY` statement rather than a library integration:

```sql
COPY (SELECT * FROM visits WHERE dt < '2024-01-01')
TO 'archive/visits/year=2023/part-0.parquet'
(FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 3, ROW_GROUP_SIZE 122880);
```

The knobs that matter, and the reasons they matter:

| Knob                | Default and constraint                                                   | Why the archive cares                                                                      |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `COMPRESSION`       | Snappy by default; zstd, lz4 and uncompressed are options                | compression is applied per row group, and zstd trades CPU for size on cold data            |
| `ROW_GROUP_SIZE`    | 122,880 rows, minimum 2,048, rounded up to a multiple of 2,048           | larger groups compress better and flush later; smaller groups raise read parallelism       |
| `PARQUET_VERSION`   | V1 unless asked                                                          | V2 buys newer encodings at slightly higher compatibility risk                              |
| `PER_THREAD_OUTPUT` | off                                                                      | one file per thread when the file count is not the contract                                |
| file count and size | at least as many row groups across files as threads; keep files moderate | too few groups serialises a scan; many small files tax the filesystem and the object store |

Two verified limits shape the integrity story. DuckDB's writer exposes compression, row-group and version options, and no page-checksum option, so file-level integrity has to come from object storage checksums and a manifest of digests. And Parquet queries run slower than a loaded DuckDB table: roughly 1.1 to 4.1 times on TPC-H scale factor 30 at default settings, 2.8 times at the median. That gap is the price of immutability, and the reason repeated queries reload.

**Encryption is defence in depth, not the deletion mechanism.** DuckDB reads and writes Parquet Modular Encryption since 0.10.0: a named 128, 192 or 256-bit key is registered per session with `PRAGMA add_parquet_key`, and a write takes `ENCRYPTION_CONFIG {footer_key: 'name'}`. On a volume that is already LUKS2-encrypted this buys little in at-rest terms, and a per-generation key destroyed to erase rows would be a partial act on a shared volume. It earns its place for a generation that leaves the host, where the key can travel separately from the bytes. Keys belong in the vault the repository already routes through `./environment.sh`, recorded in the manifest by id rather than by value.

## Object storage

DuckDB reaches S3 and compatible stores through the `httpfs` and `aws` extensions, with `CREATE SECRET (TYPE s3, PROVIDER credential_chain)` leaning on the AWS SDK's own chain, and `s3_endpoint` pointing at any compatible service. Three properties decide the layout:

- **Integrity is the store's job, and it is good at it.** S3 accepts and returns checksums — CRC-64/NVME, CRC32C, SHA-1, SHA-256 — and verifies them on upload and download. That is what a manifest can record per object, and what a verification job compares.
- **Immutability is a feature.** Object lock and versioning make a generation unchangeable, which matches the SMR constraint below: generations are sealed, never edited.
- **Costs move with requests, not only bytes.** Listing and small-object churn are the usual surprise, so a generation is a few large objects under a content-addressed prefix, not a file per day per table.
- **Java reaches all three.** Oracle's object storage has an official SDK (`com.oracle.oci.sdk:oci-java-sdk-objectstorage`) beside its S3-compatible endpoint, which any S3 client reaches; MotherDuck is reached through `org.duckdb:duckdb_jdbc` with an `md:` database (subject to the version window above) or its Postgres endpoint with the already-pinned `postgresql` driver. The lakehouse service uses none of them directly: its only warehouse egress is the shell sender it spawns, so a Java demotion job is a new decision rather than a rewrite of an existing client.

## The host's block stack

The cold device is **drive-managed SMR**: the firmware hides the shingled zones, so the kernel and every userland tool see one conventional block device. There is no write pointer to observe and no zone-aware placement to make, which retires the host-managed shape `dm-zoned` exists for. What survives the abstraction is the physics. Sustained sequential writes are noticeably slower than a CMR drive, and a single small write can trigger a cascade of internal rewrites. The drive's own DRAM, flash or CMR-region cache absorbs bursts, so measured latency describes the cache state rather than the medium.

Above the drive sit two more layers, and both change the arithmetic.

- **LUKS2/dm-crypt** encrypts the block device, with a 4 KiB sector default on devices that report themselves as 4Kn or 512e. Every write is padded, encrypted and re-issued, which is cheap per megabyte and unkind to small scattered writes.
- **btrfs two-copy RAID1** stores each block twice, with per-extent checksums. btrfs spells the two-copy profile `raid1`; the numbered variants start at `raid1c3` (three copies) and `raid1c4` (four). Its copy-on-write allocation writes new extents rather than editing live ones, and metadata is written separately from data.

Three amplification sources therefore stack: dm-crypt padding, btrfs writing both copies plus metadata, and the drive's internal relocation. The consequence is a measurement rule, not an optimisation: the only trustworthy number on this host is sustained sequential throughput at the file size a generation actually carries. Small-block random-I/O benchmarks here measure the cache stack, not the disk.

The archive rules that follow are simple and absolute.

- Write generations as few large sequential files, and never rewrite a file in place.
- Batch compaction by size, in streams worth hundreds of megabytes or more.
- Pick one compression layer. btrfs `zstd` over already-zstd Parquet burns CPU for nothing, so either mark the archive directory `+C` (no copy-on-write, hence no btrfs compression) and compress in Parquet, or write Parquet uncompressed and let btrfs compress.
- Verify with `btrfs scrub` (checksums, repaired from the second copy) and with the manifest digests; the two answer different questions and neither replaces the other.
- Keep the generation index outside the archive directory, because listing a slow tier is slower than reading a small table.

## Redundancy is forward error correction; deletion is reconciliation

Two problems share the word erasure, and they need different machinery.

**Redundancy, as forward error correction.** Reed–Solomon k+m splits an object into k data and m parity fragments, so any m fragment losses remain recoverable. Ten plus four costs 1.4 times the storage for four losses, paid in CPU at encode and decode. On this host the local volume already has two copies from btrfs RAID1, so FEC belongs to the tier btrfs cannot reach. That means sealed generations written to removable media, or spread across cheap drives with no checksumming filesystem and no RAID beneath them. Nothing in the Boot BOM covers Reed–Solomon, and the repository's dependency rule makes the library a deliberate, vetted choice rather than an import. A pure-Java implementation, a native codec through JNI, and a parity command-line tool are the three candidate shapes, and each needs a spike before it is named in a pom.

**Deletion, as a batch reconciliation.** A synchronized delete is not a volume operation and not something a sealed generation can serve: the unit's records already treat removal as a mark rather than an excision. The fit is the tombstone pattern with an offline batch reconciliation. A tombstone ledger is authoritative, each generation carries a manifest of the rows it holds, and the compaction pass reconciles the two: it drops what a live tombstone names, or supersedes the generation, on a cadence the batch job owns. No reader waits for a delete, because no reader sees a sealed generation it did not ask for.

Encryption stays a defence-in-depth layer rather than a deletion mechanism. The volume is already LUKS2-encrypted, so per-generation Parquet keys buy little on this host, and destroying one would be a partial act on a shared volume rather than a row-level erase.

## The demotion pipeline, in the order the guarantees arrive

1. Choose the window: rows older than a cutoff, or a row-count ceiling, never a best-guess mix of both.
2. Read them from the writer at a consistent point — inside one transaction, or from the snapshot the backup already takes.
3. Write a generation to a temporary name as one large sequential file, with zstd Parquet and the row-group size the read pattern wants.
4. Read the file back and compare row counts and key ranges; record per-object digests, any encryption key id and the SQL that produced it in the manifest.
5. Rename into place, then upload as a few large objects under an immutable prefix, verifying the store's checksum on completion.
6. Only after verification, reconcile the generation against the tombstone ledger, prune the hot rows and record the generation as authoritative.
7. Verify on a schedule by restoring a generation into a scratch DuckDB, running the archive's own queries, comparing a sample against the manifest, and letting `btrfs scrub` cover the block layer's own copies.

The manifest is the source of truth. A file the manifest does not name does not exist; a file whose digest disagrees with the manifest is quarantined, not repaired.

## What to settle before the first generation

1. **One DuckDB version or two.** Pin 1.5.6.0 everywhere, isolate the remote fold, or read MotherDuck over its Postgres endpoint.
2. **Where the cool copy lives.** Object storage, MotherDuck, Oracle ADW, or both — and whether the local warm tier is the only readable copy; [sbex-cold-tier-platforms](cold-tier-platforms.md) compares the platform options.
3. **Which layer compresses.** Parquet zstd with the archive directory marked `+C`, or uncompressed Parquet under btrfs zstd, and never both.
4. **Whether the offline export carries FEC.** The local volume already has two copies from btrfs RAID1, so Reed–Solomon is a question about removable media and remote copies, with a measured encode cost.
5. **The hot window.** Its size is the `/visited` budget's guarantee, so it is chosen from a measurement, not an aesthetic.
6. **The reconciliation cadence.** Tombstones accumulate until a batch pass reconciles them against generation manifests, and the cadence decides how long a deleted row can still be read from a sealed generation.
7. **The verification cadence and its budget.** A restore test that never runs is a belief.

## References

- MotherDuck: [compatibility window](https://motherduck.com/docs/duckdb-versions.json), [concepts](https://motherduck.com/docs/concepts/), [snapshots](https://motherduck.com/docs/concepts/database-and-storage/snapshots), [security and secrets](https://motherduck.com/docs/concepts/security-and-access/)
- Parquet: [overview and write options](https://duckdb.org/docs/2.0/data/parquet/overview), [tips](https://duckdb.org/docs/2.0/data/parquet/tips), [metadata](https://duckdb.org/docs/2.0/data/parquet/metadata), [encryption](https://duckdb.org/docs/2.0/data/parquet/encryption), [file-format performance guide](https://duckdb.org/docs/2.0/guides/performance/file_formats)
- Object storage: [DuckDB S3 API](https://duckdb.org/docs/2.0/core_extensions/httpfs/s3api), [S3 object integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html)
- Block stack: [btrfs profiles](https://btrfs.readthedocs.io/en/latest/mkfs.btrfs.html), [btrfs scrub](https://btrfs.readthedocs.io/en/latest/btrfs-scrub.html), [btrfs compression](https://btrfs.readthedocs.io/en/latest/Compression.html), [dm-crypt sector size](https://wiki.archlinux.org/title/Dm-crypt/Device_encryption), [drive-managed SMR](https://en.wikipedia.org/wiki/Shingled_magnetic_recording)
- Unit records: [d173](../docs/d173-browsing-history-storage-tiers.md), [d203](../docs/d203-session-payload-storage-cost.md), [d205](../docs/d205-hister-shaped-backend-requirements.md)
- Sibling notes: [sbex-datalakehouse-port](datalakehouse-port.md), [sbex-persistence-engines](persistence-engines.md), [sbex-sqlite-replication](sqlite-replication.md), [sbex-cold-tier-platforms](cold-tier-platforms.md)
