---
id: d237
type: architecture-design
status: done
title: "d237 — spike: controlling pi-coding-agent rendering and stream cadence"
parent: architecture
references: [d179, d192]
tags: ["spike", "research", "pi", "rpc", "json", "tui", "streaming"]
---

# d237 — spike: controlling pi-coding-agent rendering and stream cadence

This record captures findings about suppressing animation, padding and partial rendering in pi-coding-agent 1.5.2, and about throttling streamed output to one update in fifteen. It covers extension hooks, settings, the limits of both, and the alternative of a separate RPC client or an inference proxy. It does not propose a patch to pi upstream and does not define a client implementation. Its reader is an agent choosing where to put a rendering change.

## Status

Investigation finished; nothing in this repository was changed to implement it. The findings come from the pi-coding-agent 1.5.2 documentation and its unbundled `dist` sources, which every install carries: the host's own `pi` package tree (the directory holding the `pi` executable and `docs/`), and — for a checkout instead of a host install — any `@earendil-works/pi-coding-agent` pinned at 1.5.2 inside a package's `node_modules`. The record names no repository folder on purpose: the source it reads is the release's, not any one unit's copy. The bundled `pi` executable carries the same version, so a change to pi itself needs re-verification against the source of the release being patched.

## Extension-only control

Four supported surfaces cover part of the goal.

| Surface                                      | Controls                                                                                                                                            | Limit                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ctx.ui.setWorkingVisible(false)`            | The built-in working row during streaming                                                                                                           | `resetExtensionUI()` restores visibility on reload and session switch, so the call belongs in a `session_start` handler |
| `ctx.ui.setWorkingIndicator({ frames: [] })` | The working spinner; one frame gives a static dot because `Loader` stops its interval at `frames.length <= 1`                                       | Applies to the working indicator, not to other loaders                                                                  |
| Settings                                     | `outputPad`, `editorPaddingX`, `markdown.codeBlockIndent`, `markdown.mermaid`, `hideThinkingBlock`, `quietStartup`, `terminal.showTerminalProgress` | `pi.getSettings()` is read-only; values live in `settings.json` or `/settings`                                          |
| `pi.registerMarkdownTransformer()`           | Display-only rewriting of user, assistant, thinking, custom, summary and changelog Markdown                                                         | Interactive TUI only; receives `isStreaming` and `availableWidth`; one transformer per extension                        |

The working row can be silenced from an extension factory:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingVisible(false);
    ctx.ui.setWorkingIndicator({ frames: [] });
  });
}
```

Terminal progress is OSC 9;4 output, not Markdown, and `terminal.showTerminalProgress` already defaults to `false`. Mermaid diagrams are rendered before extension transformers run, so `markdown.mermaid: "off"` or `"final"` is the only supported way to avoid diagram churn from a partial stream.

### Buffer the final paragraph

Pi trims assistant text before it reaches the Markdown component. A trailing double newline is therefore absent from the transformer input. The completion marker available to a transformer is a `\n\n` inside the text: the segment after the last marker is the unfinished paragraph. Its visible width, measured against `availableWidth`, is the other release condition.

```typescript
import { visibleWidth } from "@earendil-works/pi-tui";

pi.registerMarkdownTransformer(
  (md, { isStreaming, availableWidth }) => {
    if (!isStreaming) return md;

    const split = md.lastIndexOf("\n\n");
    const tail = split < 0 ? md : md.slice(split + 2);
    if (visibleWidth(tail) >= availableWidth) return md;
    return split < 0 ? "" : md.slice(0, split);
  },
  { messageTypes: ["assistant"] },
);
```

A fence-aware variant is needed for code blocks, tables and lists; a blind split can cut inside those constructs. The hook is synchronous and runs on each streaming update, restored session render and resize. The original message stays unchanged in the session and model context.

### Tool updates

`pi.registerToolRenderer()` overlays extension renderers on any tool, including built-ins, because `resolveToolRenderers()` runs extension resolvers before `withBuiltInRenderers()`. A `renderResult` handler can return an empty component while `options.isPartial` is true. `renderShell: "self"` removes the default `Box` around tool output, but the tool row keeps its own leading spacer.

## What remains outside extension control

The built-in TUI creates several animations without consulting the working-indicator options.

| Source                                 | Component                                                          | Extension control            |
| -------------------------------------- | ------------------------------------------------------------------ | ---------------------------- |
| Retry, compaction and branch summary   | `status-indicator.js`, each extending `Loader` with default frames | None                         |
| `!` commands                           | `bash-execution.js` creates a `Loader`                             | None                         |
| `/share`, `/bug` and extension dialogs | `bordered-loader.js`                                               | None                         |
| Embedded editor spinner                | `CustomEditor` with `embedWorkingStatus`                           | Replace the editor component |

Vertical spacing is hardcoded as `Spacer(1)` and `paddingY: 1` across `assistant-message.js`, `user-message.js`, `tool-execution.js`, `bash-execution.js`, summary components and widget containers. The Markdown renderer also inserts blank lines around headings, paragraphs, code blocks, lists, blockquotes and rules. Returning an empty string from a transformer suppresses that block's lines but not the assistant component's leading spacer.

Horizontal padding has one global knob, `outputPad: 0 | 1`. Renderers must pass `Text(..., 0, 0)` themselves, and widget string arrays are wrapped with `Text(line, 1, 0)`, so a zero-padding widget needs the component factory form.

Pi maps extension imports to its own copies of `pi-tui` classes. Prototype patching `Text`, `Box`, `Spacer`, `Markdown` or `Loader` is technically possible but unsupported; it risks mouse hit-testing, cursor placement and future upgrades. Removing every spacer through a supported API requires replacing the built-in message and tool renderers with custom types, which changes what participates in model context. A core patch remains the reliable route to globally zero padding.

## Alternative client

RPC mode runs pi as a long-lived child process controlled by JSONL records and draws no TUI. Extension UI methods such as `setWorkingIndicator`, `setFooter` and `setHeader` are no-ops in that mode. A client that owns the terminal therefore starts with no spinner, no padding and no partial Markdown from pi.

The exported `RpcClient` handles process startup and response correlation. A minimal Python example exists in `docs/rpc.md`. A client must subscribe before prompting, split stdout on LF only, keep reading to avoid stdout backpressure, and wait for `agent_settled` rather than `agent_end`. Extensions that ask for input emit `extension_ui_request` records for `select`, `confirm`, `input` and `editor`; fire-and-forget requests such as `setWidget` can be ignored.

JSON mode is simpler for one-shot runs but exits after one invocation. The SDK is the smallest option in TypeScript because it stays in-process and exposes cumulative `partial` snapshots on `message_update`; RPC and JSON strip those snapshots and send delta-only events.

A client-side throttle accumulates deltas without rendering most of them:

```typescript
let pending = "";
let updates = 0;

function flush() {
  if (!pending) return;
  render(pending);
  pending = "";
}

client.onEvent((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    pending += event.assistantMessageEvent.delta;
    if (++updates % 15 === 0) flush();
  }
  if (event.type === "message_end") {
    flush();
    updates = 0;
  }
});
```

The same rule can apply to `tool_execution_update.partialResult`. The tail must flush on `message_end` so no text is lost. This reduces terminal writes and visual motion but not RPC bandwidth; all events still cross the process boundary. A delta is not necessarily one token, so one update in fifteen batches a variable amount of text.

## Inference proxy

A transparent HTTPS MITM is unnecessary for the providers pi already supports. `models.json` can redirect a built-in provider with only its `baseUrl`:

```json
{
  "providers": {
    "anthropic": { "baseUrl": "http://127.0.0.1:PORT/v1" }
  }
}
```

Models and authentication stay unchanged. A provider extension can do the same with `pi.registerProvider()`. `transport: "sse"` selects SSE when a proxy does not implement the websocket transport.

The proxy forwards the request, buffers provider deltas and emits one combined frame per fifteen events. Lifecycle frames, usage, stop reasons and tool-call argument deltas must pass through with valid framing. Anthropic SSE coalesces `content_block_delta.text_delta`; OpenAI-compatible SSE coalesces `delta.content`. Buffering after reading the upstream body saves no upstream bandwidth or inference cost, only frames delivered to pi. Real backpressure requires delaying reads, which risks provider idle timeouts.

A provider extension whose `streamSimple()` delegates to `anthropicMessagesApi().streamSimple()` or `openAIResponsesApi().streamSimple()` is a middle path. `examples/extensions/custom-provider-gitlab-duo/index.ts` shows the delegation shape. That path keeps pi's authentication, cancellation and normalization, but the extension must update each message's `partial` content before pushing throttled deltas, honour `onPayload`, `onResponse`, `onProviderStreamEvent` and the abort signal, and emit exactly one terminal `done` or `error`. The `provider_stream_event` extension hook is notification-only and cannot rewrite the stream.

## Recommendation

The RPC client is the simpler path for the full goal. It removes animation and padding by construction, makes paragraph buffering a local rendering decision, and turns one-in-fifteen throttling into a short accumulator. An SDK host gives the same control with less process plumbing when TypeScript in-process is acceptable.

Use a proxy or a delegating provider extension only when the goal is to slow the stream inside pi's existing TUI and the remaining animations and padding are acceptable. A true HTTPS MITM adds certificate trust and per-provider protocol parsing without helping the rendering problem.
