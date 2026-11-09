---
id: d148
type: module-design
status: done
title: "d148 — spike: OpenCode session export to JSONL and the database-reading alternative"
parent: coding-agent
depends-on: [coding-harness-persistence]
references: [d054, d065]
tags: [spike, research, opencode, sessions, jsonl, export, sqlite, pi-coding-agent]
---

# d148 — spike: OpenCode session export to JSONL and the database-reading alternative

## What this record is

This record captures findings from a spike that asked two questions:

- What would be required to make OpenCode log sessions in a JSONL-per-session form similar to pi-coding-agent, instead of OpenCode's database-backed store?
- If native JSONL session logging is not a practical option, what tool or conversion path can produce session JSONL from OpenCode's existing data?

The findings are grounded in OpenCode `v2.2.6` behavior and local storage inspected on the host where this spike ran. OpenCode's internal schema and CLI surface can change across releases, so a converter built from this record must be re-verified after OpenCode upgrades.

## What this record is not

This record is not an implementation plan for changing OpenCode upstream, not a pi-replay compatibility specification, and not a claim that OpenCode and pi-coding-agent share a session model. "JSONL, similar in manner to pi-coding-agent" means an append-friendly, line-oriented JSON record stream per session; it does not imply byte-for-byte or semantic interoperability with pi session files.

## Comparison: pi-coding-agent sessions and OpenCode sessions

### pi-coding-agent

pi-coding-agent persists sessions as JSONL files. In this repository's runtime contract, the session directory is staged per run and exposed through `PI_CODING_AGENT_SESSION_DIR` (`coding-harness-persistence`, d054). A representative session file contains one JSON object per line, with a session header followed by append-only entries linked by `id` and `parentId`, for example:

```json
{"type":"session","version":3,"id":"…","timestamp":"…","cwd":"…"}
{"type":"model_change","id":"…","parentId":null,"timestamp":"…","provider":"…","modelId":"…"}
{"type":"thinking_level_change","id":"…","parentId":"…","timestamp":"…","thinkingLevel":"…"}
```

The format is naturally streamable and append-oriented: tooling can tail, grep, or transform entries incrementally.

### OpenCode

OpenCode `v2.2.6` persists session state in a SQLite database. The default location is `~/.local/share/opencode/opencode.db`, with SQLite WAL sidecars (`opencode.db-wal`, `opencode.db-shm`); `OPENCODE_DB` can override the database location. In this repository's harness persistence model, OpenCode's config directory is host-mounted while its data directory (`~/.local/share/opencode`, containing auth, logs, and session data) is staged per run (`coding-harness-persistence`, d065).

Read-only inspection of the local database showed tables including:

| Table                           | Role observed in this spike                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `session_v2`                    | Session metadata: id, project/workspace/parent/fork linkage, directory/title/agent/model, timestamps, token/cost summary fields |
| `session_message`               | Message rows: `id`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, `data` (JSON text)                             |
| `session_part`                  | Ordered message parts: `message_id`, `session_id`, `ordinal`, `type`, `call_id`, `time_*`, `data` (JSON text)                   |
| `blob` / `blob_ref`             | Binary/blob storage and references                                                                                              |
| `project` / `project_directory` | Project/worktree identity and directory mapping                                                                                 |
| `event` / `event_sequence`      | Event stream/state                                                                                                              |
| `session_inbox`                 | Session inbox records                                                                                                           |

OpenCode also exposes session export/import commands:

```text
opencode session export [<session>] [--sanitize]   # exports session data as JSON
opencode session import <json-file-or-url>         # imports session data from JSON
```

The export command produces a single JSON document, not JSONL. A local export sampled during this spike had top-level keys `info` and `messages`, with `info` carrying session metadata and `messages` carrying exported message records.

OpenCode's streaming automation output is separate from persistent session storage: `opencode run --format json` produces JSONL event output, but that stream is not the canonical on-disk session format.

## Native JSONL session logging in OpenCode

### Finding

OpenCode has no supported user-facing configuration or CLI flag in `v2.2.6` to replace its SQLite session store with JSONL session files. Making OpenCode log sessions natively as JSONL, in place of the database, is not a small toggle; it is a storage-backend change to OpenCode itself.

### Why this is substantial

OpenCode is a client-server system. The background service owns sessions, configuration, plugins, permissions, and tool execution, and clients interact through the service/API/SDK/TUI/desktop/web surfaces. The SQLite database is the canonical durable state for that model. A native JSONL-instead-of-database backend would need to preserve behavior that SQLite currently provides or makes straightforward:

- **Durability and consistency.** Session writes involve related records (session metadata, messages, ordered parts, blobs, events, inbox items, project/workspace linkage). SQLite provides atomic transactions and indexed reads; plain per-session JSONL append files do not provide atomic multi-record updates, efficient cross-session queries, or safe concurrent writers without additional locking/indexing machinery.
- **Concurrent access.** The service and multiple clients can observe or mutate state. A JSONL backend would need a clear concurrency model (file locks, append protocol, compaction, or a hybrid log plus index).
- **Feature parity.** `session list/delete/export/import`, resume/fork/parent/child sessions, sharing and unsharing, project/workspace/worktree mapping, blob/attachment handling, event sequencing, inbox/scheduling/jobs, permissions, migrations, and the HTTP/SSE API all depend on the current storage model.
- **Schema definition.** A JSONL backend needs a stable record schema: session header, message records, part records, tool-call/reasoning state, attachment/blob references, fork boundaries, and any metadata required for replay or import. "Similar to pi-coding-agent" is achievable only after choosing that schema explicitly.
- **Migration.** Existing `opencode.db` data would need an upgrade/import path, and `OPENCODE_DB`/service lifecycle behavior would need to remain coherent.

### Practical conclusion

Native JSONL session logging is feasible only by modifying OpenCode upstream (or maintaining a fork) with a deliberate storage redesign. An external process that mirrors exported sessions to JSONL is possible as an adjunct, but it does not make OpenCode itself use JSONL instead of its database.

## Conversion alternative A: transform `opencode session export` output

### Shape

Use OpenCode's own export path:

```bash
opencode session list
opencode session export <sessionID> > /tmp/session.json
opencode session export <sessionID> --sanitize > /tmp/session.sanitized.json
```

Convert the exported JSON document to JSONL by selecting a target record schema. A minimal, loss-preserving wrapper emits one header record and one record per exported message:

```bash
python3 - <<'PY'
import json
import sys

doc = json.load(open(sys.argv[1], "r", encoding="utf-8"))
info = doc.get("info") or {}
print(json.dumps({"type": "opencode_session_export", "info": info}, ensure_ascii=False))
for message in doc.get("messages") or []:
    print(
        json.dumps(
            {"type": "opencode_message", "session_id": info.get("id"), "message": message},
            ensure_ascii=False,
        )
    )
PY /tmp/session.json > /tmp/session.jsonl
```

### Properties

| Property         | Assessment                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Stability        | Better than reading internal tables directly, because it uses OpenCode's supported export surface.   |
| Fidelity         | Depends on what `session export` includes. The export shape is OpenCode-specific and may evolve.     |
| Privacy          | `--sanitize` can redact sensitive transcript/file data where OpenCode's exporter supports it.        |
| Operational cost | Requires running `opencode` per session (or in a loop); export may interact with service discovery.  |
| Pi similarity    | JSONL container format is easy; pi-semantic replay compatibility requires an explicit mapping layer. |

### When to choose it

Choose the export path for a low-maintenance converter, for sanitized sharing/archival workflows, or when compatibility across OpenCode internal schema changes matters more than access to every internal table.

## Conversion alternative B: read the SQLite database directly

### Shape

Open the database read-only and emit JSONL from the session/message/part tables. For `v2.2.6`, the useful read order observed in this spike is:

- `session_v2` rows for session metadata;
- `session_message` rows for a session, ordered by `seq`, then creation time/id;
- `session_part` rows for each message, ordered by `ordinal`, then creation time.

A read-only sketch:

```bash
python3 - <<'PY'
import json
import sqlite3
import sys

db = sys.argv[1]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()

def parse_json(value):
    if not isinstance(value, str) or not value:
        return value
    try:
        return json.loads(value)
    except Exception:
        return value

for session in cur.execute("SELECT * FROM session_v2 ORDER BY time_updated DESC"):
    info = {key: session[key] for key in session.keys()}
    for key in ("summary_diffs", "metadata", "revert", "permission"):
        info[key] = parse_json(info.get(key))
    sid = info["id"]
    print(json.dumps({"type": "session", "source": "opencode_db", "info": info}, ensure_ascii=False))

    messages = cur.execute(
        "SELECT * FROM session_message WHERE session_id = ? ORDER BY seq, time_created, id",
        (sid,),
    ).fetchall()
    for message in messages:
        row = {key: message[key] for key in message.keys()}
        row["data"] = parse_json(row.get("data"))
        parts = cur.execute(
            "SELECT * FROM session_part WHERE message_id = ? ORDER BY ordinal, time_created",
            (row["id"],),
        ).fetchall()
        row["parts"] = []
        for part in parts:
            part_row = {key: part[key] for key in part.keys()}
            part_row["data"] = parse_json(part_row.get("data"))
            row["parts"].append(part_row)
        print(json.dumps({"type": "message", "session_id": sid, "message": row}, ensure_ascii=False))

con.close()
PY ~/.local/share/opencode/opencode.db > /tmp/opencode-sessions.jsonl
```

### Consistency and safety

- Open the database read-only (`mode=ro`); do not write.
- Prefer a consistent snapshot for point-in-time conversion. OpenCode uses SQLite WAL; copying only `opencode.db` while the service is active can miss WAL state, and reading a live database can observe a moving target. A safer path is to stop the service or otherwise quiesce writes, then copy the database, or use SQLite's backup API.
- Stream output for large databases; do not load every session/message/part into memory.
- Treat `blob` and `blob_ref` as a separate fidelity decision. The sketch exports metadata/part payloads as stored; it does not inline blob bytes.

### Properties

| Property         | Assessment                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Stability        | Low across OpenCode upgrades. Table names, columns, and JSON payload shapes are internal and version-sensitive. |
| Fidelity         | Potentially higher than export, because it can include internal rows/fields the exporter omits or reshapes.     |
| Privacy          | No built-in sanitize pass; the converter must implement redaction if needed.                                    |
| Operational cost | Can run offline against a DB copy without invoking `opencode` per session.                                      |
| Risk             | Schema drift, WAL snapshot mistakes, and incomplete blob handling are the main failure modes.                   |

### When to choose it

Choose direct DB reading for offline bulk conversion, forensic completeness, or environments where invoking OpenCode is undesirable, and pin the converter to a tested OpenCode version/schema.

## Decision guidance

| Goal                                                             | Recommended path                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Produce JSONL with the least maintenance burden                  | Convert `opencode session export` output                                            |
| Produce sanitized JSONL for sharing/archival                     | `opencode session export --sanitize`, then convert                                  |
| Produce offline bulk JSONL from a known OpenCode version         | Read a consistent SQLite copy read-only, with schema checks                         |
| Make OpenCode itself persist sessions as JSONL instead of SQLite | Requires upstream/fork storage-backend redesign; not a config change                |
| Make OpenCode sessions replay as pi-coding-agent sessions        | Define an explicit OpenCode→pi semantic mapping after choosing the transport format |

## Verification performed in this spike

The findings above were checked on this host by:

- confirming `opencode v2.2.6` and its session/export/debug command surface;
- confirming the local store at `~/.local/share/opencode/opencode.db` with WAL sidecars;
- reading SQLite table names and schemas in read-only mode (`mode=ro`);
- sampling `session_v2`, `session_message`, and `session_part` rows to understand the stored shape;
- exporting a recent session with `opencode session export` and inspecting the resulting JSON structure (`info`, `messages`);
- comparing with pi-coding-agent JSONL session files under `~/.pi/agent/sessions/`.

External references consulted during the spike described OpenCode's SQLite-backed storage, `opencode export` as JSON (not JSONL), and `opencode run --format json` as streaming JSONL output. Those references agree with the local observations for the tested version, but the implementation details remain version-sensitive.
