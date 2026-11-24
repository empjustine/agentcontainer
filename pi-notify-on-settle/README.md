---
id: pi-notify-on-settle
type: module-design
status: active
title: "pi-notify-on-settle — one alert when a pi agent loop settles, on the events that actually know the outcome"
parent: architecture
references: [d096, d118]
tags: [pi, extensions, notifications]
---

# pi-notify-on-settle — one alert when a pi agent loop settles

The package alerts the operator when an agent loop reaches its final idle boundary: an in-app notice wherever the context has a UI, and the terminal bell plus an OSC 777 desktop notification in TUI mode. The notice carries the run's own outcome — completed, cancelled, or failed with the provider's message. `index.mjs` is the shipped extension; this file is its design record: the event table, the channel table, the mode guards, and the upstream example the code follows. The pi version measured here is 1.5.2.

## Findings

### Settlement boundary

`agent_end` closes one low-level agent run. Pi can still retry, compact, or drain a queued message after it, so `agent_end` is not a final-idle signal. `agent_settled` follows the final boundary and carries only `aborted`. Use `agent_settled` as the dispatch point for a notification.

`agent_before_settle` is the final actionable boundary before that dispatch. Its `outcome` field reports `"completed"`, `"aborted"`, or `"error"`. Capture that value in a handler and combine it with `event.aborted` in `agent_settled`.

A final API timeout has no dedicated lifecycle event. The failed assistant response carries `stopReason: "error"`, plus `errorMessage` and possibly `rawStopReason`. Track those fields at `message_end` and read the last value when the loop settles.

| Signal           | Source                                | Reading                                                                     |
| ---------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| Final idle       | `agent_settled`                       | Dispatch here; no automatic continuation follows.                           |
| Run outcome      | `agent_before_settle` `event.outcome` | `completed`, `aborted`, or `error` after retries and compaction.            |
| User cancel      | `agent_settled` `event.aborted`       | Escape during the run or during the settle boundary.                        |
| Provider failure | `message_end` assistant message       | `stopReason`, `errorMessage`, `rawStopReason`; a timeout reads as an error. |

### Alert channels

| Channel               | Mechanism                                                  | Constraint                                                                                                          |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| In-app notice         | `ctx.ui.notify()` with level `info`, `warning`, or `error` | TUI and RPC; guard with `ctx.hasUI`; no sound by itself.                                                            |
| Terminal bell         | `process.stdout.write("\x07")`                             | The terminal decides whether BEL sounds or flashes; TUI mode only.                                                  |
| Visual bell or blink  | Terminal setting for BEL, or terminal tab attention        | Pi exposes no cross-terminal blink API.                                                                             |
| Native desktop notice | OSC 777, Kitty OSC 99, Windows toast                       | Terminal and OS support varies; see the upstream example below.                                                     |
| Platform command      | `pi.exec()` or `child_process`                             | `notify-send`, `osascript`, `termux-vibrate` need the host tool and permission.                                     |
| Program status        | Pi's OSC 7501 reports                                      | Zero-code option: compatible terminals show `done` or `error`; `PI_PROGRAM_STATUS=1` sends without a support query. |

Terminal control sequences belong in TUI mode. RPC carries notifications as JSON-protocol messages, and JSON and print modes have no UI. Strip control characters and semicolons from strings placed in OSC payloads, since BEL terminates the sequence and a semicolon separates its fields.

### Mode guards

- Use `ctx.hasUI` before `ctx.ui.notify()`.
- Use `ctx.mode === "tui"` before writing escape sequences to `process.stdout`.
- Put the extension in `~/.pi/agent/extensions/` or `.pi/extensions/` for auto-discovery and `/reload`.

## Prior art

### Upstream notify example

`examples/extensions/notify.ts` in the installed pi package sends a native terminal notification on `agent_settled`. It selects OSC 777 for Ghostty, iTerm2, WezTerm and rxvt-unicode, OSC 99 for Kitty, and a PowerShell toast for Windows Terminal under WSL. Its selection and hook are the reference implementation:

```typescript
function notifyOSC777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notify(title: string, body: string): void {
  if (process.env.WT_SESSION) {
    notifyWindows(title, body);
  } else if (process.env.KITTY_WINDOW_ID) {
    notifyOSC99(title, body);
  } else {
    notifyOSC777(title, body);
  }
}

pi.on("agent_settled", async () => {
  notify("Pi", "Ready for input");
});
```

The file lives at `/home/deck/.local/share/mise/installs/pi/1.5.2/pi/examples/extensions/notify.ts` on this host.

### Verified surfaces

| Source                            | What it establishes                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `docs/extensions.md`              | `agent_end` is not final; `agent_settled` is final and notification-only; `ctx.ui.notify()` and the mode table. |
| `docs/terminal-setup.md`          | OSC 7501 program status and its `done` / `error` states.                                                        |
| `docs/message-types.md`           | Assistant `stopReason`, `errorMessage` and `rawStopReason`.                                                     |
| `dist/core/extensions/types.d.ts` | `AgentSettledEvent` carries `aborted`; `AgentBeforeSettleEvent` carries `outcome`.                              |

## What the shipped extension does

`index.mjs` rings BEL and sends an OSC 777 notification on settle, alongside an in-app notice. A failed run reports at `error` level with the provider's own message; a cancellation reports at `warning`; a completed run reports at `info`.

| File        | Role                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------- |
| `index.mjs` | the extension entry: the three event handlers, the outcome-to-notice rule, the OSC 777 writer |
| `tests/`    | the rules, driven through a fake `pi` and a patched stdout — no session, no terminal          |

The composite below is the shape `index.mjs` implements; the file is the authority when the two disagree.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function oscSafe(value: string): string {
  return value.replace(/[\x00-\x1f\x7f;]/g, " ").slice(0, 200);
}

export default function (pi: ExtensionAPI) {
  let outcome: "completed" | "aborted" | "error" = "completed";
  let failureDetail = "";

  pi.on("agent_start", () => {
    outcome = "completed";
    failureDetail = "";
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason === "error") {
      failureDetail = event.message.errorMessage ?? event.message.rawStopReason ?? "provider error";
    }
  });

  pi.on("agent_before_settle", (event) => {
    outcome = event.outcome;
  });

  pi.on("agent_settled", (event, ctx) => {
    const failed = event.aborted || outcome === "error";
    const title = failed ? "Pi needs attention" : "Pi is ready";
    const kind = outcome === "error" ? "Run failed" : "Run cancelled";
    const body = failed ? `${kind}: ${failureDetail || "see transcript"}` : "Ready for input";

    if (ctx.hasUI) ctx.ui.notify(body, failed ? "error" : "info");
    if (ctx.mode !== "tui") return;

    process.stdout.write("\x07");
    process.stdout.write(`\x1b]777;notify;${oscSafe(title)};${oscSafe(body)}\x07`);
  });
}
```

Vibration needs the host's command. On Termux, `termux-vibrate -d 500` from a settle handler requires the Termux:API app and its vibration permission.

## Install and verify

```sh
pi install ./pi-notify-on-settle -l    # local package from this repo
# or point pi straight at the entry:
pi -e ./pi-notify-on-settle/index.mjs
```

A copy into `~/.pi/agent/extensions/pi-notify-on-settle/` is picked up at
startup; `/reload` picks it up inside a running session.

1. Start an interactive session with the extension loaded.
2. Submit a prompt that completes and confirm the notice, the bell, and (on a
   terminal that implements OSC 777) the desktop notification.
3. Submit a prompt that ends in a provider error and confirm the error notice
   names the provider's message.
4. Press Escape during a run and confirm the cancellation notice.

Installing the package is the switch: there is no config surface, and removing
the entry (or `pi uninstall`) is how a host turns it off. `ctx.mode` decides
what a mode may open, so RPC sessions get the in-app notice and never a raw
control sequence.

## Tests

```sh
./npm-run.sh pi-notify-on-settle test    # from the repo root
```

Network-free and session-free: a fake `pi` records the handlers, the test drives
`agent_start` / `message_end` / `agent_before_settle` / `agent_settled` and
asserts the notice a mode produces, never the shape pi renders.

## Sources

- `/home/deck/.local/share/mise/installs/pi/1.5.2/pi/docs/extensions.md`
- `/home/deck/.local/share/mise/installs/pi/1.5.2/pi/docs/terminal-setup.md`
- `/home/deck/.local/share/mise/installs/pi/1.5.2/pi/docs/message-types.md`
- `/home/deck/.local/share/mise/installs/pi/1.5.2/pi/examples/extensions/notify.ts`
