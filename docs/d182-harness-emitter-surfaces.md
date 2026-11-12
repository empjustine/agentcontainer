---
id: d182
type: module-design
status: draft
title: "d182 — harness emitter surfaces for the session route: pi extensions, opencode plugins, and vibe hooks"
parent: datalakehouse
depends-on: [d181]
references: [d026, d167, d179, d180, d181, d183, d184]
tags:
  [
    "datalakehouse",
    "sessions",
    "emitters",
    "pi-coding-agent",
    "opencode",
    "mistral-vibe",
    "extensions",
    "plugins",
    "hooks",
    "near-real-time",
  ]
---

# d182 — harness emitter surfaces for the session route

This record verifies which per-harness extension points can push session events
to the [d181](d181-session-ingest-route.md) route in near-real-time. It covers the
three harnesses the warehouse targets and their emitter caveats, and it is not the
route itself. The reader is whoever writes the emitters. What it finds: all three
harnesses expose an extension point, by three different mechanisms, and none of
them forces emission.

## Status

Draft; read from the harness mirrors at pi `7072e20ec`, opencode `a11e5782354` and
mistral-vibe `b20313e0`, all 2026-11-10. No emitter is written.

## pi-coding-agent — extensions

Extensions are TypeScript modules auto-discovered in `~/.pi/agent/extensions/`
(global) and `.pi/extensions/` (project-local, after project trust), and they
hot-reload. An extension registers handlers with `pi.on("<event>", handler)` over a
rich lifecycle:

- turns: `turn_start`, `turn_end`;
- messages: `message_start`, `message_update`, `message_end`;
- tools: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`,
  `tool_call`, `tool_result`;
- sessions: `session_start`, `session_shutdown`, `session_compact`,
  `session_before_fork`, `session_before_switch`, `session_tree`;
- agent and model: `agent_start`, `agent_end`, `model_select`.

`pi.appendEntry()` also writes a session entry, so the same extension can persist
to the store as well as emit. Near-real-time granularity is `message_end` or
`turn_end`, with `tool_execution_end` for tool results.

The caveat is placement: an extension "runs inside the Pi process with the same
operating-system permissions", and the pi agent directory is a read-write host
mount (d054). An extension in the sandbox is therefore writable by the agent
under audit, which can disable or replace it.

## opencode — plugins

The V2 plugin API `@opencode/plugin` defines a plugin as
`Plugin.define({ id, setup })`, and `setup` installs behavior at extension
points with `ctx.<domain>.hook(…)`, plus an `event` hook and per-domain transform
hooks (`agent`, `command`, `integration`, `model`, `provider`, `tool`,
`session`). Discovery is from config plugin entries and local plugin files. It runs
in-process, so a plugin can subscribe to sessions, tools and messages and POST to
the route.

The caveat matches pi's, for the same reason: the plugin runs in-process, and its
location is agent-writable unless mounted read-only.

## mistral-vibe — hooks and plugins

Vibe exposes **both** a hook system and a plugin system, so the earlier record's
uncertainty resolves in the affirmative. The hook system
(`vibe/core/hooks/`) is declarative: TOML `HookConfig` entries carry a `command`
an external process, a `type`, a `match`, a `timeout` and a `strict` flag. The
types are `PRE_AGENT`, `POST_AGENT`, `PRE_TOOL`, `POST_TOOL`, `SESSION_START`,
`SESSION_END` and `NOTIFICATION`, and the protocols are `VIBE`, `CLAUDE_CODE`
and `KIMI_CODE`, so vibe can run Claude Code and Kimi Code hook formats too. A
separate plugin system lives in `vibe/core/plugins/` with foreign adapters.

Because a hook is an **external command**, vibe needs no in-harness code at all: a
`POST_TOOL` or `POST_AGENT` command posts to the route, and `SESSION_START` and
`SESSION_END` bracket the run. This is the cheapest emitter of the three.

The caveat is the same shape: hook and plugin config are files the agent can
reach unless they sit in a read-only or host-mounted location.

## Host curation and child reach

ThinkRail embeds pi as its engine, so the question is not which transcript format a
session has - both are pi JSONL - but which extensions the host loads. Two facts
decide it (ThinkRail's pi-delegation spec, decision 25, and its server agent spec):

- **A parent session gets pi's own discovery.** In the normal install the host lets
  pi discover extensions from settings, so a portable pi extension runs for a
  ThinkRail parent session as it does for a vanilla one. Compiled and packaged
  launchers are the exception: they register a value-imported factory set through
  the host's bundled-runtime seam, so only bundled or host-listed extensions load.
- **A child session never gets disk discovery.** The delegation engine's rule is a
  curated, embedder-bound set: `SessionOptions.extensions: true` loads exactly the
  embedder's `childExtensionFactories`, and every child loads
  `childBaseExtensionFactories` ahead of it. A disk-discovered pi extension is
  never inherited, and that is deliberate (the per-child heap cost).

So one portable `pi-datalakehouse-session` extension covers parent sessions in
both hosts, but it does **not** cover subagent transcripts live; child coverage
needs a ThinkRail-side registration (a `thinkrail-extensions/` package, or the
host's child-extension bindings). This is why the file sweep, not the emitter, is
the completeness guarantee: [d184](d184-postmortem-session-sweep.md) reads parent
and child JSONL from disk with the same parser, whatever loaded the extension.

## What this means for the route

- All three harnesses can feed the route in near-real-time, and none needs a
  harness patch. The pending work d181 names is per-harness glue: a pi extension,
  an opencode plugin, and a vibe hook command.
- **None forces emission.** A compromised agent can remove the extension, the
  plugin or the hook, or forge events. That is the non-goal d026 and d181 both
  state: the diode protects captured data, not emission.
- **The diode property is unaffected.** Whatever reaches the route is append-only
  and cannot be deleted or modified from the sandbox, whichever emitter sent it.
- **Emitter integrity is placement, not code.** The emitter belongs where the
  agent cannot rewrite it: a read-only mount, or a host-side config the sandbox
  never sees. Today the pi extension directory and the project `.pi/` and
  `.opencode/` trees are agent-writable.
- **The route must be up whenever a sandbox runs.** A sandbox that starts before
  the route loses emissions, because there is no trustworthy in-sandbox buffer.

## Consequences

- The three emitters send the source identity plus the event payload, and the
  route stores it verbatim (d167's no-shredding), so the reader and the warehouse
  parse it rather than the emitter.
- pi's extension is the richest (per-message events and a store write); vibe's
  hook is the cheapest (an external command, no harness code); opencode's plugin
  sits between them.
- The same emission covers ThinkRail, which runs pi in-process, through the pi
  extension; a dedicated ThinkRail emitter is not needed.

## Alternatives rejected

- **An in-sandbox tailer of the stage.** Killable by the adversary it audits
  (d181).
- **Harness patches.** None is needed; all three already expose a hook or plugin.
- **Trusting the in-sandbox emitter config.** It is agent-writable, so it sets
  the emission ceiling, not the diode property.
