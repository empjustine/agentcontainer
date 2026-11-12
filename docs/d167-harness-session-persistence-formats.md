---
id: d167
type: module-design
status: draft
title: "d167 — harness session persistence formats: guaranteed columns plus a JSON catch-all, mistral-vibe pending"
parent: datalakehouse
depends-on: [coding-harness-persistence, d148]
references: [d046, d054, d116, d124, d179, d182, d183, d184]
tags:
  [
    "datalakehouse",
    "sessions",
    "persistence",
    "pi-coding-agent",
    "opencode",
    "thinkrail",
    "mistral-vibe",
    "motherduck",
  ]
---

# d167 — harness session persistence formats

This record captures how each coding harness the warehouse targets persists
its session data, and the storage shape the `datalakehouse` unit takes from
those formats: promote only each source's guaranteed fields into columns, and
keep every other field verbatim in a JSON payload column. It is not an
implementation — no session reader exists yet — and not a format
specification for any upstream harness; Verification names where every fact
was checked. Whoever writes a session reader for `datalakehouse/`, or
extends `coding-agent/run.mjs` staging, reads this first. Mistral-vibe
support is pending in both `coding-agent/run.mjs` and `datalakehouse/`.

## Status

Findings verified at the date of this record; the session readers are
unwritten, and mistral-vibe support is pending in both units named in the
opening block. How these formats match the warehouse's push-side flows is
[d179](d179-coding-agent-session-leg.md).

## Findings

### pi-coding-agent

pi persists one JSONL file per session under the session directory
(`PI_CODING_AGENT_SESSION_DIR`; staged per run by `coding-agent/run.mjs`,
see `coding-harness-persistence` and d054), with a cwd-derived folder per
project root. The first line is a header — `{type: "session", version, id,
timestamp, cwd}` and an optional `parentSession` — and is not part of the
tree.

Every other line extends pi's documented entry base
(`session-format.md`, "Entry Base"): `{type, id, parentId, timestamp}`.
That contract holds without exception in the corpus: all 3,738 rows of all
13 session files on the host match it, across ten observed entry types.
Type-specific extras beyond the base:

| type                    | extra fields                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `message`               | `message`                                                                                      |
| `usage`                 | `kind`, `model`, `note`, `provider`, `usage`                                                   |
| `model_change`          | `modelId`, `provider`                                                                          |
| `thinking_level_change` | `thinkingLevel`                                                                                |
| `compaction`            | `details`, `firstKeptEntryId`, `fromHook`, `summary`, `systemMessage`, `tokensBefore`, `usage` |
| `context_edit`          | `replacement`, `targetId`                                                                      |
| `session_info`          | `name`                                                                                         |
| `custom`                | `customType`, `data`                                                                           |
| `custom_message`        | `content`, `customType`, `details`, `display`                                                  |
| `session` (header)      | `cwd`, `version`; no `parentId`, not a tree entry                                              |

The extras are flat scalars or a single JSON object. All nesting depth lives
inside `message`: content parts form a closed set (`text`, `toolCall`,
`thinking`), scalar paths run three to four levels deep on ordinary rows,
and the six-to-thirteen-level outliers sit only inside `toolCall.arguments`
— the tool's own JSON schema, irregular by design — and inside system
`sections`. One naming wart exists: assistant messages and usage entries
say `model`, while `model_change` says `modelId`.

Two operational facts follow from the format. A live session appends while
the sync reads, so the last line can be torn; an incomplete line is skipped
and picked up by the next run. And the header carries `version` (files on
disk span versions 1 to 3, migrated at load time), which the payload column
absorbs without a schema change.

Lineage arrives as path, not as a column: worktree sessions are ordinary
session JSONL under cwd-derived directories, and subagent transcripts are
pi-format JSONL under `<agentDir>/delegation/<scope>/<parentSessionId>/`
(d124). One reader covers parents, worktrees, and subagents; a `store`
column records which a row came from.

### OpenCode

OpenCode persists a SQLite database — `~/.local/share/opencode/opencode.db`
with its `-wal`/`-shm` files, `OPENCODE_DB` override, and a
channel-suffixed filename — of flat relational tables. The guaranteed fields
are the columns of the installed build, and the store already uses the split
this record adopts: message bodies live in a `data` JSON column beside
key columns like `session_id`, `type`, and `seq`.

The database has two incompatible lineages. OpenCode's migration
`20260804233008_loose_psylocke.ts` renames `session` to `session_v2`
and drops and recreates `session_message` with a different column set
(ending in `data`, foreign-keyed to `session_v2`). Table names survive
the migration; columns do not. The installed build migrates a host's
database in place between runs, so the reader detects the lineage per run by
introspection — `session_v2` present means the v2 lineage — and never
hardcodes either shape. d148 records the export-versus-direct-read spike;
direct `ATTACH ... (TYPE sqlite, READ_ONLY)` is the path this warehouse
already proves against atuin, WAL included.

### ThinkRail

ThinkRail rewrites whole JSON documents into its data directory
(`THINKRAIL_DATA_DIR` default `~/.thinkrail`): `projects.json`,
`workspaces.json`, `turns.json`, `session-lifecycle.json`,
`session-receipts.json`, `terminals.json`, `chats.json`. There are no
per-entry keys to upsert by — the file is the natural key, and the reader
re-upserts the document it just read.

ThinkRail's own persistence layer refuses to store transcript content
(d124): transcripts are pi's JSONL, under the same session directories the
pi reader walks, worktree folders included. Subagent delegation transcripts
are pi-format too (see the pi section). Two files stay out by path:
`installation.json` and `environment.json`, which hold installation
metadata and environment secrets. The rest is management state: a worktree is
recoverable from a transcript header's `cwd`, a name from `session_info`, a
branch from git, so the decision stores no ThinkRail-specific field at all — the
pi JSONL is the only ThinkRail-origin payload
([d183](d183-thinkrail-and-delegated-loop-capture.md)).

### mistral-vibe

No host in scope carries `~/.vibe`, and d116 puts mistral-vibe in the
best-effort tier. The mirror shows why a reader must be written against a
format generation, not against a folder convention: vibe persists two
generations, and only one of them is JSONL.

The legacy generation is `<save_dir>/session_<id>/{meta.json,
messages.jsonl}` (`save_dir` is `SessionLoggingConfig.save_dir`, default
`~/.vibe/logs/session`). Each `messages.jsonl` line is an `LLMMessage`
(`vibe/core/types.py`, `extra="ignore"`). The legacy writer was removed
from the current checkout — the store is now read-only import material
(`_legacy_import.py`, ADR 0006, the CHANGELOG) — so the surviving contract
is the model's write-time validators, and they guarantee exactly three
fields:

- `role` — the `system`/`user`/`assistant`/`tool` enum, defaulted;
- `content` — defaulted to `""`, with content part lists coerced to a
  single string at write time;
- `message_id` — a UUID injected for every non-tool role, so it is
  nullable on `tool` rows.

There is no per-message timestamp: physical line order is the only timeline.
Everything else on the line is optional and belongs in the payload —
`images`, `reasoning_*`, `tool_calls`, `tool_call_id`,
`tool_result`, `resources`, `manual_shell`, `context_boundary`, and
the rest. `meta.json` is `SessionMetadata`: its fields are annotated
"absent from sessions written before this field existed", and
`SessionProject` sets `extra="ignore"` deliberately, so a field a newer
build adds cannot invalidate an older file. The one hard requirement is
`session_id` — the session index drops a session that lacks it.

The current generation is `<save_dir>/unified/<session_id>/`, a private
store: `STORE_FORMAT = "mistral.vibe.unified-session-store/v1"`, minor
10, with additive-only evolution ("an additive field needs no bump"). Each
session holds a generation `manifest.json` plus `checkpoint.json`,
`runtime-state.json`, and `projection-state.json`; transcript bodies sit
in content-addressed `chunks/<sha256>.json` files of about 64 KB, sealed
so that appending rewrites only the open tail. History is
`snapshot/history/entries`, mutated by append, replace, and remove
operations keyed on the entry's `id`, with `history_positions` mapping
entry id to the session's history index.

Two consequences for a reader: physical line numbers mean nothing across
runs — chunks are digested and generations rewritten — so the stable
identity is the entry `id` and the stable order is the envelope's history
index; and the reader must gate on the store format and its minor version,
because a newer minor is refused outright
(`HarnessStoreRequiresNewerReaderError`).

## Decision

**Promote only guaranteed fields; everything else lands verbatim in a JSON
payload column.** Guaranteed means a field every row of the source carries,
backed by that source's own contract — and the contract differs per source:

| source       | guaranteed per entry                                              | contract behind it                   |
| ------------ | ----------------------------------------------------------------- | ------------------------------------ |
| pi           | `type`, `id`, `parentId`, `timestamp` (+ header `cwd`, `version`) | documented entry base                |
| OpenCode     | table columns                                                     | SQLite schema of the installed build |
| ThinkRail    | none — the document is the unit                                   | wholesale atomic rewrite             |
| vibe legacy  | `role`, `content`, `message_id` (nullable); no timestamp          | pydantic write-time validators       |
| vibe unified | entry `id`; order from the history index                          | store's keyed mutation API           |

**Payloads land without shredding, sanitizing, or revision** (user decision):
the warehouse stores exactly what the source wrote, because a reader that
rewrites private data is a second, silent formatter. Secret files are
excluded by path only — opencode's `auth.json`, ThinkRail's
`installation.json`/`environment.json`, vibe's `.env` — never by
editing rows.

**OpenCode gets one MotherDuck database and two schemas** — `opencode_v1`
and `opencode_v2` beside `atuin` and the session sources. The shared
table names with incompatible columns rule out one unified schema, and a
second `md:` database would double the identity and attach pitfalls d046
and the atuin README document while splitting cross-source joins. The
per-run introspection from the Findings section routes each run to its
lineage; ALTER-to-match applies within a lineage only.

The row shapes that follow, for the readers this record anticipates:

```
pi_entry(session_file, line_no, id, parent_id, type, ts, store, payload json)
pi_session(session_file, session_id, cwd, version, parent_session, started_at)
vibe_entry(session_id, seq, role, message_id, payload json)
vibe_session(session_id, parent_session_id, cwd, started_at, ended_at,
             store_kind, payload json)
```

For pi, `store` distinguishes staged sessions, worktree sessions, and
delegation transcripts; the upsert key is `(session_file, id)`. For vibe,
`seq` is the line number in the legacy store and the history index in the
unified store, and `store_kind` names which generation was read. ThinkRail gets no
table: the decision stores none of its fields, because the worktree, the name and
the branch are derivable from the pi rows above
([d183](d183-thinkrail-and-delegated-loop-capture.md)).

## Deferred - splitting the message content array

A `message` entry is the largest thing the reader stores: its
`message.content[]` array can reach 100 KB or more (a pasted file, a base64
image, a long tool result), and v1 keeps it verbatim inside the entry's `payload`
column, so one row carries the whole array.

The v2 split is a part table keyed on the message:
`pi_content(session_id, message_id, content_index, part_type, payload)` with
`PRIMARY KEY (session_id, message_id, content_index)`, one row per element of the
closed `content[]` set (`text`, `toolCall`, `thinking`). The entry row keeps
its metadata and a part count, and a reader reassembles by `content_index` or
fetches one part alone.

Deferred, not rejected. It departs from the no-shredding decision above by
reshaping a private payload, so it needs its own decision and a migration of the
rows v1 already wrote. It must also pin the part-type set, the
`toolCall.arguments` irregularity, and a size policy before it can land.

## Consequences

- An upstream format change — a new entry type, an additive field, a version
  bump — costs no warehouse migration: the payload column absorbs it, and a
  promoted column changes only when the source's guarantee changes.
- The warehouse holds full prompts, tool output, and file contents. The only
  protection over them is MotherDuck authentication behind the token chain
  (d046); this is the privacy consequence of the no-shredding decision, stated
  where a reader of the schema meets it.
- One `md:` database keeps cross-source queries possible; the two opencode
  schemas are the one deliberate partition inside it.
- Every source's reader keys on that source's own natural key — file plus
  entry id for pi, document for ThinkRail, entry id for the unified vibe
  store — so prune and upsert semantics mirror the atuin pattern.

## Mistral-vibe support is pending

- `coding-agent/run.mjs` gives vibe no stage directory, no mount, and no
  env pin: the persistence table in `coding-harness-persistence` has no
  vibe row, and adding that row is the pending leg on that side.
- `datalakehouse/` reads no vibe data: atuin is the unit's only synced
  source, and no session reader exists yet on any side.
- The unblock condition is a host that actually carries `~/.vibe` data,
  plus the choice between the legacy JSONL reader — near the atuin and pi
  pattern — and the unified-store reader, which parses manifests and chunks;
  the installed build decides which generation a host holds.
- The tier terms stand (d116): vibe is best-effort, and this pending state
  never blocks a pi-first design.

## Alternatives rejected

- **Promoting nested fields now** — `role`, token metrics, tool names —
  into base columns. They are stable but sit inside the payload, and no
  aggregate asks for them yet; generated columns or ingest-time projections
  can lift them later without touching the base table.
- **One schema for both opencode lineages.** The migration recreates
  `session_message` with incompatible columns, so a unified schema would
  need per-run conditional columns — introspection in the DDL instead of in
  the reader.
- **A second `md:` database per source.** Two databases double the
  two-identities problem (each identity resolves its own empty `md:` copy)
  and forfeit the cross-source joins the one-database choice exists for.
- **Building the vibe reader ahead of the data.** No host in scope carries
  `~/.vibe`, the unified store is a private format under active version
  drift, and the tier is best-effort; a reader written against no corpus
  would be verified against nothing.

## Verification

- **pi**: every session file on the host was scanned (13 files, 3,738 rows):
  exact top-level key sets per type, zero deviations from the entry base,
  and the depth distribution were measured from the corpus itself. The
  contract text comes from pi's own `docs/session-format.md` (Entry Base
  and the per-type sections).
- **OpenCode**: the migration file
  `packages/core/src/database/migration/20260804233008_loose_psylocke.ts`
  was read from the reference mirror; d148 holds the export spike and the
  database path findings.
- **ThinkRail**: `packages/server/src/persistence/persistence.ts`
  (`dataDir()`) from the mirror; d124 holds the session and subagent
  boundary findings.
- **mistral-vibe**: `vibe/core/session/session_loader.py`,
  `session_index.py`, `vibe/core/types.py`, `vibe/core/config/models.py`,
  `harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/_storage.py`,
  `vibe/app_server/_legacy_import.py`, `docs/adr/0006-local-sessions.md`,
  and the CHANGELOG were read from the mirror; no live corpus exists on the
  hosts in scope.
- The reference mirrors under `~/Downloads/references/` are a convenience
  cache, not the canonical source — the same caveat
  `coding-harness-persistence` records.
