---
id: reader-gotchas
type: architecture-design
status: active
title: "Reader gotchas: offline ZIM corpora and sqlite sources"
parent: architecture
references: [d173, d177, d204, datalakehouse-elt]
tags: ["zim", "kiwix", "sqlite", "duckdb", "readers"]
---

# Reader gotchas: offline ZIM corpora and sqlite sources

The failures below each cost a day to diagnose and cost nothing to keep written
down. They are properties of the files this tree reads — an offline ZIM corpus, a
live browser or shell-history database — not proposals, and nothing here is a
design: the designs are [d173](d173-browsing-history-storage-tiers.md) for the
tiers, [d177](d177-cold-full-text-search.md) for cold search, and
[`datalakehouse/elt/README.md`](../datalakehouse/elt/README.md) for where a
resolved row lands.

## A ZIM needs no index of its own

- Entry paths and titles live in a sorted directory inside the file: a lookup is
  a binary search over an mmap, with no pre-processing, no sidecar and no index
  build.
- Full-text search is an embedded Xapian index built at scrape time, per book,
  with the book's language stemming. It is per-**book**: 172 devdocs ZIMs are 172
  indexes, and a cross-book search is a fan-out with a merge rather than one
  query.
- Not every ZIM carries it (`Archive.has_fulltext_index()`): `nopic` and `mini`
  flavours, and some scrapes, have every entry and no full-text index.
- What is missing for a bookmark check is only the web-URL-to-entry-path grammar
  per source. That is a mapping, not an index: one line for
  `*.wikipedia.org/wiki/T` to `A/T`, and the reason the devdocs mapping is
  hundreds of lines of reverse-engineered attribution links rather than a
  function.
- A ZIM's own metadata is authoritative over any catalog export. An OPDS export
  lists **books** (thousands of them, with a scrape date), not articles, so it
  answers "which corpus should be on disk", never "is this page offline".

## libzim writes to fd 1 from C

Some C extensions — libzim's xapian integration is one — print diagnostics with
`printf`, which bypasses `sys.stdout` and corrupts a JSONL stream mid-record. The
file descriptor is the seam, not the Python object:

```
saved = os.dup(1)
os.dup2(os.open(os.devnull, os.O_WRONLY), 1)
try:
    ...
finally:
    os.dup2(saved, 1)
```

## sqlite: reading and snapshotting

- `ATTACH '<path>' AS src (TYPE sqlite, READ_ONLY)` is the shape the atuin leg
  uses. A plain `sqlite_scan` opens the file for the duration of the query with
  no read-only guarantee.
- `SET GLOBAL sqlite_all_varchar = true` before scanning a live browser or
  shell-history database: sqlite is dynamically typed, one column can hold an
  integer in one row and text in the next, and inference without it fails or
  truncates.
- `VACUUM main INTO '<copy>'` writes a consistent snapshot while a writer keeps
  running — the cheap primitive before a destructive migration, and a better one
  than copying the file and hoping the WAL is quiet.
- A live database in WAL mode is not "a file": a copy without a checkpoint
  captures a torn state. Snapshot through sqlite or stop the writer.
- A ZIM has the same shape of hazard for a different reason: the reader holds the
  file open and maps it, so a corpus refresh under a running resolver must
  replace the file and reopen, never rewrite it in place.

## Why these are recorded here

Each one contradicts the intuitive move — build an index for the corpus, print
progress from inside the C library, copy the database file — and each is
invisible until it fails on production-shaped data. They live in `docs/` because
they bind every reader of these files; the code that consumes them stays in the
unit that owns it.
