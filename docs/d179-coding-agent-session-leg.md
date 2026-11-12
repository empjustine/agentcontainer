---
id: d179
type: module-design
status: draft
title: "d179 — coding-agent session history in the datalakehouse: how the pull leg matches the push flows"
parent: datalakehouse
depends-on: [d167, d178]
references: [d026, d148, d172, d173, d175, d176, d177, coding-harness-persistence, d180, d181]
tags:
  [
    "datalakehouse",
    "coding-agent",
    "sessions",
    "persistence",
    "pull",
    "push",
    "audit",
    "motherduck",
    "diode",
  ]
---

# d179 — coding-agent session history in the datalakehouse

This record verifies how the coding-agent session datalakehouse ([d167](d167-harness-session-persistence-formats.md),
[d148](d148-opencode-session-jsonl-export-spike.md)) matches the planned personal datalakehouse flows of
[d172](d172-push-based-browsing-index.md) to [d178](d178-datalakehouse-workload.md), and where
the two legs differ. It covers the ingestion mode, the hot path, the append-only
claim, the collection leg and the privacy stance, and it proposes no reader. The
reader is whoever wires the session sources into the warehouse. What it finds:
the storage half already matches, the transport half does not, and append-only is
a property the warehouse imposes rather than one every harness source has.

## Status

Draft verification; no session reader exists on either leg. d167 and d148 remain
the source findings, d026 remains a design note, and the `datalakehouse/` unit
syncs only atuin.

## The two legs

- **Session leg, pull.** `coding-agent/run.mjs` stages each harness's state per
  run — pi's session JSONL, OpenCode's SQLite database, ThinkRail's JSON
  documents, vibe's JSONL or unified store — and d026 designs a versioned FUSE
  diode to replace today's read-write mount. d167 defines the warehouse rows. It
  is host-side, read-only `ATTACH`, scheduled, and targeted at MotherDuck.
- **Browsing leg, push.** d172's extension pushes visits and bookmarks to a
  listener, which stages in SQLite, compacts to DuckDB, serves a hot presence
  index and a cold search, and speaks the Promnesia protocol.

## What matches

- **The warehouse and its toolchain.** Both legs target MotherDuck through the
  vault token chain (`./environment.sh`, d046) and the pinned duckdb CLI.
- **The schema shape.** d167's "guaranteed columns plus a JSON payload catch-all"
  is the same promotion rule the listener applies to visits: keep only what a
  query needs in columns, and the rest verbatim.
- **The upsert key.** Each source's own natural key — file plus entry id for pi,
  the document for ThinkRail, the entry id for the unified vibe store — mirrors
  the listener's `(src, kind, key)` dedupe key.
- **The read mechanism.** `ATTACH ... (TYPE sqlite, READ_ONLY)` against a live WAL
  database is proven on atuin and proposed for OpenCode; the same scanner would
  read the browsing leg's SQLite staging.
- **The append-only shape.** d026's version chain ("writes become new immutable
  versions, never in-place") is the security form of d177's SMR rule (write-once
  generations, tombstones, no in-place rewrite). Two motives, one shape.
- **The media fit.** The session leg is already cloud-cold in MotherDuck, which
  d177 names as the default cold query surface, so it needs no local SMR tier.

## What diverges

- **Ingestion mode.** The session leg pulls from host files and databases; the
  browsing leg is pushed to a listener. A reader that assumes one cannot consume
  the other.
- **The hot path.** The session leg has none: it is pure cold analysis and recall,
  so it needs no always-on component and can run entirely scheduled or
  scale-to-zero. d178's one hot read belongs to the browsing leg alone.
- **Source mutability.** pi appends JSONL entries; OpenCode mutates keyed rows;
  **ThinkRail rewrites whole documents** with no per-entry key; the unified vibe
  store is keyed append, replace and remove behind a version gate. Only pi and
  the legacy vibe store are literally append-only.
- **The privacy stance.** d167 stores full prompts, tool output and file contents
  by decision, which is the opposite of d173's Datensparsamkeit. The policy is
  per source, not global.
- **The media.** The session leg targets MotherDuck directly, so it touches the
  local SMR archive only if a local copy is deliberately kept.

## Append-only is a warehouse property, not a source property

ThinkRail rewrites a whole document, so the run's stage directory holds only the
latest state and the intermediate history is gone before any reader sees it. The
unified vibe store keeps history by keyed mutation, but a remove is still a
remove. d026's versioned diode is what supplies the missing history: every write
becomes a new immutable version, and deletes and renames affect only the
container's view. So the diode is not only a security control; it is the
mechanism that makes the session leg append-only for the rewrite-style sources.
The warehouse rule then holds for every source while each source's own write
pattern stays what it is.

## The missing collection leg

The per-run stage directory is named `agentcontainer-<timestamp>`, so a reader
must either enumerate runs or read d026's stable backing store
(`~/workspace/$container_name/audit/…`). Neither is wired: d167 names the formats
and the rows, d026 is design-only, and the `datalakehouse/` unit reads no
sessions. The transport from the stage directory or the diode store into the
warehouse is the one unimplemented joint, and it is the leg that decides whether
the naive moving mountpoints survive. [d180](d180-session-collection-leg.md)
defines it as a host-written, sandbox-read-only archive.

## Consequences

- d178's workload gains a **fourth producer family**: coding-agent sessions.
  They are trickle-bursty like atuin but carry no hot read, so they are a pure
  scheduled or scale-to-zero consumer.
- The two legs share a warehouse but not a transport. The listener design of d172
  does not consume the session leg, and the pull reader of d167 does not consume
  the push leg.
- The no-shredding decision of d167 and the Datensparsamkeit of d173 are both
  kept, applied to different sources. A single global retention rule would
  violate one of them.
- If the diode lands, every session source becomes append-only at the warehouse
  boundary, which is the property d177's generations assume.

## Alternatives rejected

- **Treat the session leg as another push source.** It is a pull leg; the stage
  directories and the read-only `ATTACH` are its transport, and a listener has
  nothing to receive.
- **Store only the latest harness state.** ThinkRail's rewrite and vibe's keyed
  mutation would lose the history the audit trail exists for.
- **Apply Datensparsamkeit to sessions.** The audit trail's purpose is
  completeness; minimisation belongs to the browsing index, not to the trail.
