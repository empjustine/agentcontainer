---
id: d216
type: module-design
status: active
title: "d216 — harness state dirs mount at the container's own default path: the ~/workspace stage and the launch script are retired"
parent: coding-agent
depends-on: [coding-agent]
references: [d026, d052, d054, d065, d067, d068, coding-harness-persistence, d180, d181, d184, d203]
tags: [coding-agent, mounts, persistence, sessions, credentials, workspace]
---

# d216 — harness state dirs mount where the harness looks

**Status: landed.** `coding-agent/run.mjs` mounts each harness's own host state
dir at the container's default path for that harness. `~/workspace/<container>`
and the generated launch script are gone.

## Problem

Three harness dirs were still staged per run under
`~/workspace/agentcontainer-<stamp>/` and pinned into the container with an
env override (d026's audit stages): pi's session store, opencode's data dir,
Cline's `~/.cline`, ThinkRail's `~/.thinkrail`. Docs/d054 and d065 had already
removed that arrangement for pi's agent dir and opencode's config dir, for two
reasons that apply to the rest verbatim:

- **The host harness and the sandboxed one never share state.** A per-run copy
  means the host's own sessions, logs and auth never meet the sandbox's, and
  the host's real directories stay invisible to every reader.
- **The stage is garbage plus a drift seam.** Every launch leaves a throwaway
  directory whose only durable content is session JSONL, and the env pins that
  name it exist only to make the stage reachable — they duplicate the harness's
  own default.

The launch script existed for those pins alone. With no pins it was a heredoc
whose entire body was `export ...` plus `exec bash`.

## Decision

**One path per harness: the host dir stays the host dir, the container sees its
own default.** No env pin names a state dir except where the harness has no
other way to find it (opencode's data dir has no knob, so the mount at its XDG
default is the pin).

| harness         | host dir (override honored)                                   | container path               |
| --------------- | ------------------------------------------------------------- | ---------------------------- |
| pi config       | `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`)                | `~/.pi/agent`                |
| pi sessions     | `<agentDir>/sessions` — inside the mount above                | same, by the agent-dir mount |
| opencode config | `$OPENCODE_CONFIG_DIR` (default XDG config's `opencode/`)     | `~/.config/opencode`         |
| opencode data   | `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`) | `~/.local/share/opencode`    |
| Cline           | `$CLINE_DIR` (default `~/.cline`)                             | `~/.cline`                   |
| ThinkRail       | `$THINKRAIL_DATA_DIR` (default `~/.thinkrail`)                | `~/.thinkrail`               |

- **Host overrides move only the HOST side.** A host whose XDG or harness dir
  lives elsewhere still hands the container the container's own default path,
  which is the path the harness reads inside.
- **pi's sessions need no second mount.** `<agentDir>/sessions` is pi's
  default store and sits inside the agent dir the launcher already mounts, so
  `$PI_CODING_AGENT_SESSION_DIR` is deliberately not read: one mount, not two.
  Cross-run `/resume` follows, and the host's own session store is the one the
  sandbox writes.
- **The launch script is retired** (docs/d067 holds the no-repo-file rule). The
  command is the image's own default shell, `/usr/bin/bash`; `--init` still
  supplies the reaping init.
- **The credential gate widens to opencode.** Docs/d065 needed no gate because its
  data dir was never host-mounted; it is now, so a populated auth.json in
  `<opencodeDataDir>` refuses the launch (exit 93) on the same content test
  pi's agent dir uses (d052). Cline's `data/settings/providers.json` and
  ThinkRail's `installation.json`/`environment.json` have no empty form to
  test against, so they are reported by a warning, not an abort.
- **The DIRECTORY manifest is untouched** (d056, d068): only the harness-dir
  mounts change.

## Consequences

- **`~/workspace` is never created.** There is no stage name, no per-run
  cleanup, and no dir whose only content is a generated shell file.
- **State is shared across runs and across concurrent launches**, for every
  harness, exactly as d054/d065 already accepted for pi config and opencode
  config. A sandbox can rewrite every session in the host store, not just its
  own — the tamperable window d180 records is now one durable store rather than
  a per-run one. The host remains the trusted side (d026).
- **The audit-stage model of d026/d179 no longer describes these dirs.** The
  host's real pi session root is where pi writes inside the sandbox, so the
  sweep (d184) and the emitter (d182) read the ordinary default paths with no
  stage enumeration.
- **Relabel cost moves to durable dirs.** Each launch pays podman's recursive
  `z,U` walk on `~/.local/share/opencode` too, which can hold logs and
  project storage; a big store slows every launch. It is the same trade d054
  accepted for the agent dir.
- **Host credential-shaped files become sandbox-readable** where the gate
  cannot decide emptiness (Cline providers, ThinkRail installation/env). The
  warning is the signal; a host that keeps keys there should remove them, as
  d052 asks of pi's auth.json.
- **The image's own defaults are now load-bearing.** If a harness changes its
  default path, the mount lands where the harness no longer looks and the
  launch has no pin to compensate; the harness's own docs are the tripwire.

## Alternatives rejected

- **Keep the per-run stage for sessions only.** Preserves d026's isolation while
  the rest moves; the split is then a permanent special case with its own env
  pin, which is the complexity this record removes.
- **Keep the launch script for the env pins.** It would export paths the
  harness already defaults to, and its only other job was the script mount
  docs/d067 retired.
- **Gate Cline and ThinkRail credentials by existence.** Both files exist on
  every install and carry non-credential fields; an existence gate would abort
  every launch, and a content gate has no documented empty form to key on.
- **Mount the host data dirs read-only.** The harness has to write its own
  state; a read-only mount is a broken harness, not a safer one.

## References

- `coding-agent/coding-harness-persistence.md` — the table this record
  rewrites (every row becomes a host dir).
- docs/d054 and docs/d065 — the two earlier moves this generalizes.
- docs/d052 — no credential file rides a mount; the gate enforces it.
- docs/d067 — no repo file in the launch chain, which the retired script was
  the last of.
- docs/d026, docs/d180 — the per-run audit stage and its residual window.
- The mechanics live in `coding-agent/run.mjs` and its argv test.
