---
id: pi-session-logs-dw
type: module-design
status: draft
title: "pi-session-logs-dw — the LLM session upload as a pi extension: what implementing it takes"
parent: architecture
references: [d026, d167, d179, d180, d181, d182, d183, d184, d192, d203, d216, d217]
tags: [pi, extensions, datalakehouse, sessions, ingest, assessment]
---

# pi-session-logs-dw — the session upload as a pi extension

**Status: assessment only — no code in this folder.** This note records what a
pi extension that pushes session entries to the host's ingest route (d181) needs,
verified against pi 1.5.2's shipped docs (`extensions.md`, `session-format.md`)
and the existing emitter analysis (d182). It is the folder's spec node, so the
implementation lands beside this file as `index.mjs` per d192.

## What the extension is

A package extension pi loads in-process, subscribing to the session lifecycle and
POSTing each persisted entry — with the session header — to
`POST /ingest/session` on the host route (default `http://127.0.0.1:8787`).
The daemon spools it (d181) and the daemon now folds the spool itself (d217);
the postmortem sweep (d184) stays the completeness guarantee.

This is the "push" half of d179: near-real-time capture for a live session, not a
replacement for the file sweep.

## Verified surfaces (pi 1.5.2)

- **Discovery.** `~/.pi/agent/extensions/*/package.json` with a `pi.extensions`
  array, or a bare `*.mjs`, auto-loaded after project trust; project-local
  `.pi/extensions/`; `pi -e <path>` for a one-off. Hot reload via `/reload`.
- **Lifecycle.** `session_start` carries `reason` and, on replacement, a new
  runtime; `session_shutdown` is where session-scoped resources close. The
  factory must NOT start timers, sockets or processes — defer to
  `session_start` (the docs say this explicitly).
- **Entries.** `ctx.sessionManager` is read-only and exposes `getSessionId()`,
  `getSessionFile()`, `getHeader()`, `getEntries()`, `getBranch()` and
  `getLeafId()`. `turn_end` runs after the assistant and tool-result entries are
  persisted and carries `event.entries`; `message_end` fires per finalized
  message (including user/tool/custom).
- **Session file.** JSONL: line 1 is the header (`{"type":"session", version, id,
  timestamp, cwd, parentSession?}`), every later line an entry with `id`,
  `parentId`, `timestamp` and `type`. The extension can therefore emit the
  same rows the sync computes, without guessing.

## What the rows must be

The daemon dedupes on the row's own identity; the warehouse keys are
`(session_id)` for the header and `(session_id, id)` for entries (d203). Mirror
the sync's shapes (`datalakehouse/agent-warehouse-sync.sh`):

- header: `{session_file, store:"session", session_id, cwd, version,
  parent_session, started_at}`
- entry: `{session_id, session_file, store, id, parent_id, type, ts, payload}` —
  `payload` is the whole entry object, verbatim (d167's no-shredding rule).

`line_no` is the one field the live emitter cannot know from an event: the sync
counts physical lines. The extension can derive it from the header plus
`getEntries()` order on its first implementation and prove it against the file;
until then it sends the row without `line_no` and accepts that first-write-wins
keeps the emitter's spelling.

`session_file` is a location attribute, not a key: inside the sandbox and on
the host it is the same path only because the host agent dir is mounted at its
own path (d216).

## Transport and credentials

- **Route.** `127.0.0.1:8787` by default; the launcher runs `--network=host`,
  so the sandbox's loopback is the host's. `AGENT_WAREHOUSE_ROUTE` overrides it.
- **Token.** `AGENT_INGEST_TOKEN`, sent as `x-ingest-token`. The daemon accepts
  an empty token (loopback only), so the extension works either way; a token is
  the d181 contract. It reaches the sandbox only through the vault chain, so
  `AGENT_INGEST_TOKEN` must join `run.mjs`'s `vaultEnv` allowlist — an
  outside-the-folder change.
- **Batching.** The daemon caps a body at `AGENT_INGEST_MAX_BODY` (default 8 MiB)
  and one message entry can exceed 100 KB, so batch by BYTES, not count. The
  sync's 4 MiB budget is the proven shape.
- **Retry.** No durable buffer inside the sandbox is trustworthy (d181); keep a
  bounded in-memory queue, retry on the next turn, flush on `session_shutdown`
  with a short timeout, and let the sweep cover what was lost. Backoff on a
  connection refusal so a route-down host does not spin.
- **Ordering/idempotence.** The warehouse insert is `ON CONFLICT DO NOTHING`, so
  re-posting a row is free; a replay after a partial batch is safe.

## Placement (the integrity question d182 leaves open)

The agent dir is a RW host mount (d054, d216), so an extension under
`~/.pi/agent/extensions/` is writable by the sandbox it audits — it can be
removed or replaced. The extension works, but its integrity is placement:

- install it with `pi install ./pi-session-logs-dw -l` (the d096/d192 package
  path), or copy the folder into the host agent dir; both are agent-writable;
- a non-writable emitter needs the launcher to `workload_ro` a dedicated
  extensions dir over the writable one (a launcher change) or the image to bake
  the package in (a Containerfile change). Neither exists today.

## What it cannot cover

- **ThinkRail children.** A parent session gets pi's disk discovery; a
  delegated child session loads only the embedder's curated set, so a
  disk-discovered extension never reaches it (d182). The sweep (d184) reads the
  delegation root, so child coverage is the file path's job.
- **A removed or compromised extension.** The route cannot compel emission
  (d026/d181's non-goal).
- **The archive.** The extension only POSTs; the host receiver remains the
  archive's only writer (d180).

## What must change outside this folder

1. `coding-agent/run.mjs`: add `AGENT_INGEST_TOKEN` (and, if it is a vault key,
   `AGENT_WAREHOUSE_ROUTE`) to `vaultEnv`, or the sandbox has no token.
2. The host route must be running whenever a sandbox runs; a sandbox that starts
   first loses emissions it cannot buffer (d181).
3. An install step or a read-only mount, per Placement above.
4. `datalakehouse/README.md`'s usage list and d182's "pending emitter" line, once
   the folder holds code.

## Folder contract (when code lands)

Per d192 and the existing `pi-*` packages: `package.json` with `pi.extensions`
and `@earendil-works/pi-coding-agent` as an exact devDependency (pnpm,
`pnpm-lock.yaml`), the entry as `index.mjs` with the host's types via JSDoc,
`tests/*.test.mjs` importing the entry by literal specifier (a stub HTTP server,
fixture entries), and `./npm-tools.sh pnpm_tools_ensure` already covers the
install. `knip.jsonc` gains the entry when the file exists.

## Open questions

- Emit on `turn_end` (persisted, batched) or `message_end` (earlier, more
  granularity): the turn boundary is the safer ordering guarantee.
- Whether to send the header on `session_start` or lazily with the first entry;
  a fork's header carries `parentSession`, which the first POST must not lose.
- Whether `pi.appendEntry` is useful at all — it writes a session entry, but
  emitting that entry would need the daemon, not the store, to see it; the
  extension can observe entries without writing any.
- Whether the package installs into the agent dir (writable) or ships read-only
  (launcher/image change); the answer decides whether the emitter is
  tamper-evident or merely present.
