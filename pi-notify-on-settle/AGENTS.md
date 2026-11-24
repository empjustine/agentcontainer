# AGENTS.md — pi-notify-on-settle

Folder-local rules. Repo-wide rules are in `../AGENTS.md`; the standalone rule
(a folder is a copy unit) is in `../docs/architecture.md`. This package is not
a provider: it carries no catalog, no fetch and no refresh, so the pi-provider
folder rules do not apply.

## The hook is `agent_settled`, and the outcome is gathered

- **Never notify from `agent_end`.** It closes one low-level run; pi may still
  retry, compact or drain a queued message afterwards, so a notice there fires
  while the agent is still working. `agent_settled` is the final idle boundary.
- **`agent_settled` carries only `aborted`.** The outcome comes from
  `agent_before_settle`'s `outcome` field (the last value wins), and a
  provider failure has no lifecycle event at all: it is read at `message_end`
  from an assistant message with `stopReason: "error"` (`errorMessage`, else
  `rawStopReason`). Reset both on `agent_start`, so one run's failure cannot
  colour the next.
- **A cancel during the settle boundary is still a cancel**: `event.aborted`
  wins over the recorded outcome.

## Channels follow the mode, and `ctx.mode` is the guard

- `ctx.ui.notify()` only behind `ctx.hasUI` — TUI and RPC render it, json and
  print have no UI.
- BEL and OSC 777 only behind `ctx.mode === "tui"`. RPC carries notifications as
  protocol messages, so a raw escape sequence there corrupts the stream; json
  and print have no terminal.
- **Every OSC 777 field goes through `oscSafe`.** BEL terminates the sequence
  and `;` separates its fields, so both are stripped, and the length is capped
  so a provider's long error cannot fill a title bar.

## Scope

Two channels, no config. There is no palette and no per-terminal matrix: Kitty's
OSC 99 and the Windows toast are the upstream example's, not this package's, and
adding one means a channel with a test, not a branch nobody exercises. Nothing
here writes files, spawns processes or reads secrets.
