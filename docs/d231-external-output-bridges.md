---
id: d231
type: architecture-design
status: active
title: "d231 — external output is bridged at the unit boundary"
parent: architecture
depends-on: [d045, d230]
references: [d072, d212]
tags: ["logging", "dependencies", "progress", "cross-language"]
---

# d231 — external output is bridged at the unit boundary

**Status: landed.** Every language now has one place that owns third-party
output, and each tool opts into it at startup.

## Problem

A library or child process that writes to a team's stream breaks the contract
for every consumer at once. `huggingface_hub`'s tqdm bars and plain
`StreamHandler` lines landed beside `lib/log.py`'s JSON on stderr;
fixing only the downloader left the audit and pruner free to do the same. The
same shape exists in the other languages — a child process's redraw frames,
SLF4J's own appenders, a Go dependency writing through the standard logger.

## Decision

Each language bridges external output at the unit boundary, and a tool that
imports a logging dependency opts in once:

- **Python:** `llm-local-inference/lib/dep_log.py` installs a structured
  handler on the root loggers of the vetted dependencies
  (`huggingface_hub`, `gguf`, `pypdf`) and captures
  `warnings.warn` through `py.warnings`. The downloaders also
  disable tqdm at source; the `hf` CLI invoked by
  `50-verify-cache.py` gets `HF_HUB_DISABLE_PROGRESS_BARS=1` in
  its environment.
- **Node:** `lib/log.mjs` is the only emitter. Child stdout/stderr is
  captured line by line and re-emitted as records, with redraw frames collapsed
  at capture (`coding-agent/build.mjs`,
  `llm-local-inference/build.mjs`, `git/lib/git-core.mjs`).
- **Java:** each Spring web module ships a Logback root console appender whose
  `json` profile uses `LogstashEncoder`, so dependency loggers
  follow the same records as application ones (sbex).
- **Go:** `estige/logging.go` owns the standard logger through one sink;
  dependencies writing through it need no per-tool handler.

Progress frames are not log records. They are disabled at the source when the
library exposes a switch, and collapsed when a child process is captured.

## Consequences

- A new logging dependency costs one entry in `dep_log.LOGGERS`, not a
  handler in every tool; a new child process uses the repository's capture
  helper rather than inheriting the terminal.
- Third-party prose remains the event label because it cannot follow d045's
  static-message rule; its level, logger name and exception are fields.
- Where a dependency already runs in an isolated process with captured stderr
  (pypdf in `datalakehouse/browse-daemon.py`), the capture is the bridge
  and no further handler is added.
- The payload stream of each tool stays machine-consumable; d045's stream
  contract is unchanged.

## Alternatives rejected

**Per-tool handler copies.** The same logger list and level map would drift
between the six tools that import Hub alone.

**Suppressing whole libraries' output.** A Hub warning about auth or a corrupt
cache is the one thing the operator must see; it is routed, not dropped.
