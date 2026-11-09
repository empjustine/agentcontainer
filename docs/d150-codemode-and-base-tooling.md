---
id: d150
type: module-design
status: draft
title: "d150 — spike: Code Mode and base tooling across four harnesses"
parent: coding-agent
depends-on: [d116]
references: [d116, d148, d149]
tags: [spike, research, codemode, tools, opencode, crush, pi-coding-agent, thinkrail]
---

# d150 — spike: Code Mode and base tooling across four harnesses

This record surveys what each harness puts in front of the model as its tool set, and what a
Code Mode runtime costs on top of that. Its companion is d149, which follows the same
question as far as the system prompt and stops at the gating rule; the runtime those
declarations and hidden declarations hand control to is this record's subject.

## Status

Draft, read as a spike. Every claim cites a file in one of the four mirrors listed under
"Re-verify", at the commit named there. Nothing below decides anything: d116 owns the
support tiers, and no generated surface changes because of this record.

## Trust boundary

The mirrors are third-party source trees. The evidence here is what they contain, read
against the shape the container expects; where a mirror and the version a container installs
differ, the mirror loses. The two version gaps that bite are named in "Re-verify".

## Two ways to reach a tool

A harness offers its tools in one of two shapes.

- **A declaration.** Each tool is an entry in the request's tool array with a name, an input
  schema and a description, and the model answers with a call to one of them.
- **A program.** The request offers one tool that takes source code. Inside the source every
  other tool is a host function the program awaits, and only the program's output returns to
  the model.

Code Mode does not remove the first question, it moves it: the model must still learn what
it can call, and must learn when that set changes. The four harnesses answer with four
different transports.

- **crush** has no runtime. Its tools are a declaration list filtered per agent, and a tool
  that is not attached cannot be reached by any means.
- **ThinkRail** does not load a runtime either. It inherits pi's vocabulary and rewrites the
  one value that names the runtime it lacks to `deferred`, so the reach-through becomes
  the tool search (d149).
- **pi-coding-agent** writes the catalog into the `codemode` tool's **description**, rebuilt
  from the request's loadout each time, and offers `tool_search` as a second discovery
  path for tools kept out of the catalog by the budget.
- **OpenCode** keeps the `execute` description **invariant** and delivers the catalog as an
  **instruction value** with its own key and hash ledger, so a change is a rendered delta in
  the transcript rather than a new description.

That split — description or instruction — is the load-bearing difference between the two
runtimes, and the reason the rest of this record is about where the bytes live.

## Base tool inventory

| harness   | core tools | everything else                                 |
| --------- | ---------- | ----------------------------------------------- |
| OpenCode  | 14         | four namespaced groups and `execute`            |
| pi        | 8          | extensions and MCP, all declared the same way   |
| crush     | 30         | per-agent allowlists over the same 30           |
| ThinkRail | 8 + 17     | the pi extensions it opts into, plus host tools |

### OpenCode

Fourteen plugin modules export a `name` and register one tool each: `read`, `edit`,
`write`, `patch`, `grep`, `glob`, `shell`, `todowrite`, `webfetch`,
`websearch`, `question`, `skill`, `subagent` and `experimental_image_generate`.
Four more plugin modules register many tools under a namespace and ride Code Mode instead:
`artifact_*`, `schedule_*`, the MCP resource pair, and the `opencode` namespace with
`session_rename`, `session_move`, `models` and `worktree_*`.
`packages/core/src/tool/plugin/file-diff.ts` registers nothing; it is the diff renderer the
editing tools share.

Two naming choices matter downstream. The shell is `shell`, not `bash`, and the prompt's
shell rule keys on that name (d149). There is no `ls` and no `find`: `glob` covers
both. Two tools keep a long description in a `.txt` file beside the plugin (`patch`,
`todowrite`); the rest describe themselves inline.

### pi-coding-agent

Eight modules in `packages/coding-agent/src/core/tools/`: `read`, `write`, `edit`,
`bash`, `grep`, `find`, `ls` and `powershell` (Windows only, so a Linux run declares
seven). That is the whole core.

Everything else arrives through the extension registry: MCP tools as
`mcp__<server>__<tool>`, then whichever of `codemode`, `tool-search` and the rest the
settings enable. A harness built on pi adds tools without touching the core, which keeps the
base surface small and turns the session's tool list into a settings question rather than a
source question.

### crush

Thirty names, each a constant in its own file under `internal/agent/tools/`:

- editing: `view`, `write`, `edit`, `multiedit`
- search: `grep`, `glob`, `ls`
- shell and jobs: `bash`, `job_output`, `job_kill`
- network: `fetch`, `agentic_fetch`, `web_fetch`, `web_search`, `download`
- language server: `lsp_diagnostics`, `lsp_definition`, `lsp_references`,
  `lsp_symbols`, `lsp_rename`, `lsp_replace_symbol`, `lsp_call_hierarchy`
- session and MCP: `todos`, `question`, `list_mcp_resources`, `read_mcp_resource`,
  `crush_info`, `crush_logs`, `sourcegraph`

The breadth is the comparison's point. crush is the only harness shipping a language-server
suite, a document downloader and four web tools in the default binary, and the only one whose
subagents reach the same tool struct through an access-level field rather than a name list.
It has no runtime of any kind: no scripts, no deferral, no second discovery path.

### ThinkRail

The desktop host runs pi in-process, so the eight core tools arrive unchanged, and the host
adds:

- `todo_*` — `add`, `list`, `update`, `promote`, `remove`, `write`,
  `plan_summary` (`packages/pi-todos/tools/`)
- `spec_*` — `get`, `grep`, `graph`, `create`, `update`, `delete`, `validate`
  (`packages/spec-graph/tools/`)
- `Agent` and `get_subagent_result` (`packages/pi-subagents`), with a delegation
  package and a DAG package beside it
- `background_command` (`packages/pi-background-commands`)
- host-only tools that never reach a script: the review request and the chat title

Workflow lives in skills rather than tools (`pi-thinkrail-workflow/skills/`), which keeps
the tool list close to pi's while the procedure — brainstorm, plan, spec, ship — stays text
the model reads on demand.

## OpenCode's Code Mode

### The interpreter

`packages/codemode/README.md` states the design: "Rather than trying to sandbox arbitrary
JavaScript, CodeMode only runs the language features we implement." A program cannot reach
the network, the filesystem, a process or an application API directly; the outside world is
the tool set the host supplies, plus globals the host adds through an `Extension`.

The properties the catalog and the description both have to respect:

- no timers, so no `setTimeout` and no sleep inside a script;
- work still running when the program ends is interrupted, and an un-awaited promise's
  rejection comes back as a warning;
- REPL-style results — an omitted `return` makes the final top-level expression the value,
  and `undefined` becomes `null`;
- every value crossing the boundary is copied, never shared, and data nests at most 32
  levels;
- `import` and `require` resolve a **global** by Node module name (`fs`, `url`,
  `util`, `buffer`). There are no packages, so anything else throws.

An extension global is not a tool: it is absent from the catalog, not counted against
`maxToolCalls`, and never described to the model. OpenCode's own runtimes supply exactly
one — `fetch`.

### The invariant description

`packages/core/src/codemode/tool.ts` builds the `execute` tool with a description that
names no tool, under the comment "Invariant model-facing guidance; the changing tool catalog
is delivered through Instructions":

```
Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.
`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable: there is no `setTimeout` or sleep. All other external access goes through `tools`.
Within `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.
Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.
Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.
Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.
```

Three of the six lines exist only because the model also sees declared tools: it is told
which list wins, that paths are exact, and that the tools visible outside the runtime are
unavailable inside it. pi reaches the same place from the other direction — its description
is rewritten per request and therefore needs no "ignore what it sees elsewhere" clause.

### The budget

`packages/core/src/codemode/catalog.ts` turns the callable inventory into the summary the
instructions render. Three constants set the size: `INLINE_BUDGET = 2_000` tokens,
`CHARACTERS_PER_TOKEN = 4`, and `DESCRIPTION_LIMIT = 120` characters for the one-line
summary beside a listing.

The selection rule keeps every namespace visible and then fills one listing per namespace per
round, shortest first, until the budget is spent:

```
// Keep every namespace visible, then select full listings one per namespace per round,
// considering shorter listings first until the inline budget is exhausted.
```

A namespace line carries its own arithmetic — "- name (12 tools, 3 shown)" — so a truncated
catalog still tells the model how much it is missing, and a namespace with nothing selected
reads "12 tools, none shown" rather than disappearing. Listings marked `pinned` are chosen
before the rounds start, which is how `session_move`, `worktree_create`, `worktree_list`
and `worktree_remove` stay visible in a crowded catalog.

### The catalog as an instruction value

This is the mechanism with no pi counterpart. `packages/core/src/codemode/instructions.ts`
declares a keyed source:

```
const key = Instructions.Key.make("core/codemode")
const codec = Schema.toCodecJson(CodeModeCatalog.Summary)
```

with three renderers — `initial` (the full catalog), `changed` (a delta against the
previous summary) and `removed` ("Code Mode tools are no longer available. Do not use any
previously listed Code Mode tools."). The delta is built with `Instructions.diffByKey` over
namespaces and entries, and it wins only when it is shorter than the full replacement, so a
server connecting mid-session produces one paragraph instead of a second catalog.

The ledger underneath it is `packages/core/src/instructions/index.ts`: a source's value is
hashed on read, an admission carries `{ delta, blobs }`, and `renderUpdate` asks each
source's `changed` renderer for the text of the entries that actually moved. The initial
render joins the system part of the transcript (`session/model-request.ts`). A later change
is committed by `session/instruction-state.ts` as a durable `session.instructions.updated`
event whose `text` is the rendered delta, frozen at emit time because re-rendering it later
would need the original location-scoped sources; the initial baseline records the hashes and
no text.

The wording tracks completeness, not just content: a partial catalog gets the
"before calling a tool that is not listed below, find it with the global `search(...)`
function" paragraph and the search signature, while a complete one gets "The catalog is
complete. Do not guess tool names." The empty case has its own text, and it tells the model
not to call `execute` at all.

### Limits

The model-driven runtime is configured without limits — `CodeMode.make({ tools, extensions,
hooks })` and no `limits` argument — and the runtime's documentation is explicit that
"Execution limits have no default values". Timeout, tool-call count and output size are
therefore unbounded for a script the model writes.

The machine-driven path is the opposite. `packages/core/src/schedule/check.ts` reuses the
same runtime to evaluate a schedule's `{ code }` gate, with a fixed envelope:

| limit            | value  |
| ---------------- | ------ |
| `timeoutMs`      | 30 s   |
| `maxToolCalls`   | 20     |
| `maxOutputBytes` | 32 KiB |

and an eight-name denial list for the tools that would recurse — the schedule tools,
`session_move`, `session_rename`, `worktree_create` and `worktree_remove`. That path
also gets no `fetch` extension and no model step.

`fetch` itself carries its own envelope: 30 s per request, the `webfetch` permission rules
matched against the URL, a re-check on every redirect hop, no `file:` URL, no credentials in
the URL, and the fragment stripped before matching so an exact-URL rule cannot be bypassed.
A user's rejection reaches the program as the error message it typed, because the feedback is
a message to the model.

### What the model gets back

The tool's output schema is `{ output, toolCalls, error?, files? }` — a text part, one part
per collected file as a `data:` URI, and `metadata.toolCalls` for the transcript. Rows are
published at most every 100 ms, each call updating its own row in place, and progress is
suppressed inside nested tools so an inner tool's updates cannot hide the rows. A failing call
reaches the program with the same message the model would have got from a direct call, which
is what keeps a script's error text and a direct call's error text interchangeable.

### Discovery

The `execute` description names one discovery tool because the catalog may be partial: the
synchronous `search(...)` built-in, which takes an exact path, a namespace scope, an empty
query or a page, and returns callable paths with full signatures. It counts against
`maxToolCalls` like any other call, and it is not in the catalog and not described to the
model apart from its signature line in the instructions header.

pi splits that role in two: `searchTools()` ranks by BM25 and returns names and
descriptions, `describeTool()` fetches one declaration, and `tool_search` exposes the same
ranking to the model as a declared tool with `model-only` exposure (d149).

## pi's Code Mode, for contrast

pi runs the script in a QuickJS worker, not in an interpreter of its own, and the
documentation ships the envelope as settings (`docs/codemode.md`):

| property         | OpenCode                             | pi                                               |
| ---------------- | ------------------------------------ | ------------------------------------------------ |
| runtime          | interpreter over a JavaScript subset | QuickJS worker (256 MB VM)                       |
| workers          | no worker slot; in-process           | 2 per process, `PI_CODEMODE_MAX_WORKERS`         |
| catalog home     | instruction value, keyed and hashed  | `codemode` tool description, rebuilt per request |
| change signal    | rendered delta against the last hash | a new description in the next request            |
| budget           | `INLINE_BUDGET = 2_000`, a constant  | `codemode.inlineBudget`, 3000 by default         |
| model knob       | a boolean per tool                   | `codemode.mode`: `on` or `only`                  |
| discovery        | `search(...)`, counts as a tool call | `searchTools()`, `describeTool()`, `ALL_TOOLS`   |
| output cap       | none                                 | 16,777,216 characters or 100,000 items           |
| timeout          | none                                 | `timeout_ms`, unset by default                   |
| network          | `fetch` under `webfetch` rules       | none                                             |
| cross-call state | none                                 | `store`/`load`, persisted per session branch     |
| non-LLM models   | none                                 | `models.classify`, `models.generateImages`       |

Three of those rows are worth more than a table.

**Output.** pi keeps the head and the tail of an oversized output and writes the full text to
a temp file, whose path it reports; the cap is what makes a runaway script fail instead of
hanging the harness. OpenCode has no cap on the model path, so a long script is bounded only
by the user cancelling it.

**State.** `store(key, value)` writes are kept only when a script succeeds, as a
`codemode-store` custom entry on the session, so a resumed session keeps them and each branch
sees only its own writes. OpenCode has no equivalent and needs none for its own tools: the
tools that would carry state between scripts are the `opencode` namespace tools, which read
the session store directly.

**Errors.** Both make a failed call reject with the message a direct call would have returned,
and both recommend `Promise.allSettled` over `Promise.all` so the successful calls survive.
OpenCode's reasoning is explicit in the code: the program must see the same failure text the
model gets. Nothing in either runtime rolls back calls already made.

## The same problem, four answers

| harness   | runtime                  | catalog reaches the model as   | hiding                      |
| --------- | ------------------------ | ------------------------------ | --------------------------- |
| OpenCode  | interpreter, per call    | a keyed instruction value      | `codemode` boolean per tool |
| pi        | QuickJS worker, per call | the tool's own description     | `hiddenTools` + exposure    |
| crush     | none                     | nowhere                        | detach                      |
| ThinkRail | none (pi's, not loaded)  | pi's path, `codemode` remapped | inherited                   |

## What the evidence supports

- **The description-or-instruction split is a prompt-cache bet.** pi pays bytes on every
  request and keeps no state: the catalog is rebuilt into the description each time, so a
  server that connects changes one array entry. OpenCode pays a state machine — a keyed
  source, a hash ledger, a delta renderer and a synthetic message — and keeps the
  `execute` description byte-identical for the life of the harness. Both are defensible;
  the cost lands in different places and neither is configurable into the other.

- **Hiding is not authorization in either runtime.** OpenCode routes every hidden call
  through `Permission.assert`, with the sandbox reusing the `webfetch` rules hop by hop;
  pi routes it through the tool executor. Withdrawing a declaration removes the model's
  knowledge of a tool and never the harness's gate.

- **Network access is the capability that splits them.** OpenCode's `fetch` gives scripts
  HTTP under the `webfetch` rules. pi's sandbox has no network at all, and the harness
  reaches the web through declared tools (in ThinkRail, through a skill). A policy that
  assumes a script cannot leave the machine holds for pi only.

- **Limits are inverted against the configuration surface.** pi ships caps as settings
  (`max_output_tokens` defaults to 10,000, `timeout_ms` is unset) and reports the
  overflow; OpenCode ships no knob for the model path and hard-caps the machine path
  (30 s, 20 calls, 32 KiB for a schedule gate). A runaway OpenCode script has no ceiling; a
  runaway pi script stops at 16 MB.

- **Both catalogs answer "how does the model learn a hidden tool" with a budget plus a
  search, and the budget is where they differ.** pi's `inlineBudget: 0` removes the catalog
  entirely and leans on `searchTools`; OpenCode's constant keeps every namespace visible and
  lists a few entries per namespace, so a truncated catalog still names what it is missing. A
  zero budget on OpenCode's side would leave headers with no signatures and one path left:
  `search`.

- **Base inventories converge on the same eight capabilities and diverge at the edges.** The
  shell's name, a patch tool, and web access are the differences. The harness with no runtime
  is also the one with the widest base surface — LSP, jobs, downloads — so crush buys breadth
  in the binary where the other two buy it in a script.

- **Nothing here argues for changing a generated surface.** d116's tiers stand: OpenCode's
  base tools are all direct, which is the set the prompt describes, and pi's configuration is
  a settings file.

## Re-verify

Read on 2026-11-05 from bare mirrors under `~/Downloads/references/github.com/`:
`anomalyco/opencode.git` at `e3b0ca61`, `charmbracelet/crush.git` at `c98fc5459`,
`earendil-works/pi.git` at `80d4d3c86`, and `JetBrains/thinkrail.git` at
`5e5409643`.

Two caveats bind any reuse.

- The pi mirror tip is not proven identical to the 1.5.0 release installed on the dev host.
  The limits table quotes the installed documentation (`docs/codemode.md`), not the mirror,
  because those numbers are the ones a run will meet.
- The OpenCode mirror tip is a later generation than the `v2.2.6` d148 measures, and its
  config schema has moved (`providers` plural, `mcp.servers`, `type: "local" |
  "remote"`). The Code Mode constants cited here live in source rather than config, so a new
  release can change them without a migration; re-read the three constants before trusting
  the budget or the description.
