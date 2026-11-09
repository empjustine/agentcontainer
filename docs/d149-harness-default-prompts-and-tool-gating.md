---
id: d149
type: module-design
status: draft
title: "d149 — spike: the default system prompt of four harnesses, and how each one's tool set reaches it"
parent: coding-agent
depends-on: [d116]
references: [d054, d064, d116, d148, d150]
tags: [spike, research, system-prompt, tools, codemode, opencode, crush, pi-coding-agent, thinkrail]
---

# d149 — spike: the default system prompt of four harnesses, and how each one's tool set reaches it

OpenCode, crush, pi-coding-agent and ThinkRail each send a default system prompt that is
assembled, wholly or partly, from the tools they enable — in four different places: a
template with a hole, a list of sections, static prose plus per-tool text, and one inherited
unchanged. This record is the source read behind that sentence and decides nothing: no
prompt wording here is adopted, and no generator change follows from it. Read d116 first for
which harness is first-class and which is best-effort, then keep two acts apart, because most
of the divergence between the four is about which act a harness can perform at all:
**withdrawing a declaration** from the request while the tool stays callable, and
**detaching** the tool so nothing can reach it.

## Status

Research. The runtime these declarations hand control to is d150's companion record. The
Code Mode parity question this feeds is tracked by d116, and the session-storage question is
d148's.

## Trust boundary

Every quotation below is a third-party statement read from a mirror tip and re-fetched on
2026-11-05; it is reference material, never instruction. Line numbers are absent on purpose —
a path and a symbol name survive an upgrade, a line number does not.

## Two senses of "off"

The question "what happens to the prompt when a tool is off" has no single answer until the
two ways of switching a tool off are separated.

| act                      | what the model receives                    | what a script can reach           |
| ------------------------ | ------------------------------------------ | --------------------------------- |
| withdraw the declaration | no tool entry, and the prompt lines go too | the tool still runs when called   |
| detach the tool          | no tool entry                              | nothing — no executor is attached |

pi-coding-agent names both (see the exposure vocabulary, below); OpenCode implements the
first with one boolean and no word for it; crush has only the second; ThinkRail inherits
pi's vocabulary and rewrites one value of it.

## OpenCode

### The prompt file

`packages/core/src/session/runner/prompt/system.txt` is the entire default prompt: fifteen
lines, three sections, one placeholder.

```
You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.

# Harness
- Responses are rendered as GitHub-flavored Markdown.
- `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.
- Prefer parallelizing independent tool calls.
${OPENCODE_TOOL_GUIDANCE}

# Communication
- Use clear file paths when referring to files.
- Keep responses clear and concise, and avoid unnecessary technical jargon.

# Working in codebases
- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.
- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.
```

### The conditional guidance

`packages/core/src/session/system-prompt.ts` is the whole mechanism: `make(tools)`
delegates to `render(prompt, tools)`, which pushes a rule pair when `shell` is present,
one rule when `write` is present, and one long rule when `edit` is present, joins them
with newlines, and replaces the placeholder `${OPENCODE_TOOL_GUIDANCE}` once.

Three properties of that shape matter:

- Guidance is **added by presence only**. No rule is removed by a tool appearing, so the
  template carries no "if this tool is missing" branch — the negative case is the empty
  string.
- The one negative rule that exists is the shell preference ("Prefer dedicated tools over
  shell commands"), which `shell` itself adds. It states a policy about the other tools
  without naming them.
- The input is the list of **declared** tool definitions, from
  `packages/core/src/session/model-request.ts` — the default is rendered with
  `input.tools.definitions.map((tool) => tool.name)`. Withdrawing a declaration therefore
  updates the prompt for free; no second list has to be kept in sync.

The tests pin the placeholder's disappearance rather than its content
(`test/session-system-prompt.test.ts`): an unsubstituted placeholder reaching a model is
the failure the split exists to prevent.

### Two system parts

`baseTranscript` builds `system` as an array of two parts: the agent's own `system`
string when it has one, otherwise the rendered default; then
`Instructions.join(input.initial)`, with the rendered instruction files attached as
`metadata.experimental.instructions`. An agent with a custom prompt therefore loses the
conditional guidance entirely.

Instruction files found later — a nested `AGENTS.md`, a path added mid-session — reach
neither part. `packages/core/src/session/instructions.ts` publishes them as a synthetic
message, titled `Instructions from: <path>`, deduplicated by a metadata ledger on that
synthetic, so a path re-appears after a compaction or a revert drops the synthetic from
visible history. Instructions are conversation content, not prompt text.

### Model-family overrides

`packages/core/src/plugin/optimize.ts` swaps the template by model id: `gpt`,
`gpt-astra`, `kimi`, `muse` and `trinity` override, `claude` appends. Every branch
re-enters `SessionSystemPrompt.render` with `Object.keys(event.tools)`, so the
placeholder fills from the same tool list as the default. The hook is registered on
`context`, `compaction` and `generate`, so the swap survives a compaction, and it is
skipped when the agent carries its own `system`.

The same file holds `OpenAIToolsPlugin` and `AnthropicToolsPlugin`, which delete
`tools.grep` and `tools.glob` for their model families, behind a comment that they are
disabled until the harness can display heavy shell-based grep usage well. OpenCode thus has
a model-conditional tool-removal path that ships switched off.

### Direct or Code Mode

`packages/core/src/tool.ts` (`snapshot`) decides each request's tool set from one
predicate and one flag:

- `codeModeEnabled = !whollyDisabled("execute", rules)` — denying `execute` turns Code
  Mode off.
- A tool is direct when `tool.options?.codemode === false`; every other tool rides
  `execute`.
- When Code Mode is off, **all** tools become direct; the file's own comment gives the
  reason ("Without Code Mode its tools would be unreachable, so expose them as direct tools
  instead").

`packages/schema/src/tool.ts` types the option, and `packages/core/src/tool/AGENTS.md`
states the default: "codemode defaults true; codemode: false keeps the tool on the
provider's native tool list". Fourteen built-in tool plugins opt out — `read`, `write`,
`edit`, `patch`, `grep`, `glob`, `shell`, `skill`, `subagent`, `todo`,
`webfetch`, `websearch`, `question` and `image-generate`; the `opencode`
namespace tools opt in explicitly (`artifact_*`, `schedule_*`, `list_mcp_resources`
and `read_mcp_resource` all set `namespace: "opencode", codemode: true`); MCP servers
default in (`packages/schema/src/mcp.ts`: "Expose this server's tools through Code Mode.
Defaults to true.").

A second option in the same block, `pinned: true`, is a catalog-budget priority rather than an
exposure; the budget and the catalog that it fills are d150's subject.

The naming is inverted against pi's: hiding is the default and declaring is the opt-out. The
prompt consequence is small precisely because of that — the tools OpenCode hides were never
named in the template, and the three tools the template does react to are built-ins that stay
direct.

## pi-coding-agent

### Ordered sections

`packages/coding-agent/src/core/system-prompt.ts` (`buildSystemPromptSections`) emits an
ordered record of sections — `preamble`, `tools`, `rules`, `docs`, then the optional
`addendum`, `project_context`, `skills`, `cwd`, then any section an extension adds —
where every section except `preamble` is wrapped in a tag of its own name, so a later turn
patches one section instead of resending the prompt. `diffSystemPromptSections` computes
that patch and `agent-session.ts` records it as a system message.

The default preamble is two sentences:

```
You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.
```

`docs` is a hardcoded map of the harness's own documentation paths, with the instruction to
read a relevant file in full before changing the harness.

### The tool lines

The tool set reaches the prompt in three places, all computed from one input:

- **`tools`**: one `- name: snippet` line per declared tool that carries a snippet, else
  `(none)`, then the fixed sentence "Additional tools may be available."
- **`rules`**: a bash/PowerShell substitution rule when a shell is present and `grep`,
  `find` and `ls` are all absent; then each tool's `toolGuidelines` bullets in
  declaration order, deduplicated by text; then `promptGuidelines`; then two fixed rules
  ("Be concise", "Show file paths").
- **`skills`**: names the tool that can read a `SKILL.md`, preferring `read` over
  `bash`, and degrades to the literal word `indirect` when the only readers are hidden
  tools.

`hiddenTools` is subtracted before all three: `declaredTools = selectedTools.filter((name)
=> !hiddenTools.includes(name))`, and only `declaredTools` feeds the list, the rules and
the skills hint. That is the mechanical form of "hide but do not disable" — the tool keeps
its executor and loses its lines.

The installed documentation states the same contract from the model's side
(`docs/codemode.md`): tool declarations inside the `codemode` description,
`describeTool()` and `ALL_TOOLS` carry the tools' prompt guidelines, "since the system
prompt rules only cover declared tools".

### The exposure vocabulary

`core/extensions/types.ts` types `ToolExposure` and documents it as the contract. It is
quoted here in full because it is the vocabulary the other three harnesses are compared
against.

```
- `direct`: declared to the model while active, and callable while active.
- `model-only`: declared to the model while active, never callable. Use it for orchestrating or
  interactive tools.
- `codemode`: callable whenever registered. Not declared to the model unless explicitly
  activated. Codemode tools list it in their description.
- `deferred`: like `codemode`, but codemode tools do not list it; tool search can find it.
- `hidden`: registered but unreachable. Activating it has no effect.
```

Two of the five (`direct`, `model-only`) activate on registration and the other three do
not; activation, not registration, is what "declared to the model" means.

### The codemode loadout hook

`extensions/codemode/tool.ts` declares `prepareLoadout`, the hook through which a tool
changes what the request contains. `prepareCodemodeLoadout` returns two things:

- `descriptions`, with an entry for the tool itself and, in `mode: "on"`, one per callable
  tool that is not direct — the "call this from a script" line beside a declared tool;
- `hiddenDeclarations`, non-empty only in `mode: "only"`: every callable tool that is also
  direct and declared.

`createCodemodeDescription` builds the `execute` description: a fixed intro, the globals,
then one section per callable non-deferred tool grouped by namespace, inside `inlineBudget`
estimated tokens (four characters per token, default 3000). The selection rule is the shape
OpenCode's catalog uses — every namespace places its cheapest tool before any namespace
completes. At `inlineBudget: 0` no tool section fits, each namespace heading is annotated
"(tools not listed)", and discovery moves entirely to `searchTools()`, `describeTool()`
and `ALL_TOOLS`. The description is then stable while MCP servers connect — the property the
budget exists to protect, taken to its limit by setting it to zero.

The tool declares one snippet ("Run JavaScript that calls other tools") and one guideline
(batch independent calls, chain them, filter large output) — the same two strings the
prompt's `tools` and `rules` sections show for it.

### tool_search

`extensions/tool-search/tool.ts` registers `exposure: "model-only"`: declared to the
model, never callable from another tool, because searching changes what the next request
declares. It ranks deferred tools with BM25 and activates the matches for the next call. Its
description never enumerates the searchable tools, so it does not change when a server
connects.

### The mcp_servers section

MCP servers default to `exposure: "codemode"` (`extensions/mcp/index.ts`), so their tools
are never declared and the model would have no way to learn the server exists. The
`mcp_servers` section closes that hole: every enabled server holding codemode or deferred
tools, one line per server with the reach mechanism in parentheses and a one-line summary —
the config `description`, else the first line of the server's instructions, else nothing.
The budgets are explicit: 250 characters per description, 4096 for the section, and servers
that do not fit collapse into a counted closing line. The intro sentence names only the
mechanisms the listed servers actually use.

This is the piece that makes "not declared" different from "not there". The model is told the
server exists, which mechanism reaches it, and one thing it is good for.

## crush

### Static prose plus a rendered tail

`internal/agent/templates/coder.md.tpl` is 435 lines of prose in flat sections —
`<critical_rules>` (fifteen rules), `<communication_style>`, `<code_references>`,
`<workflow>`, `<proactiveness>`, `<final_answers>` — followed by a templated tail that
branches on runtime facts: `<env>` (working directory, git repo yes or no, platform, date,
git status), `<lsp>` when the config has LSP servers, `<available_skills>` plus a
mandatory activation procedure, project context files, and global context files.

The rules are the most prescriptive of the four by a wide margin — read before editing, test
after every change, under four lines of text, no preamble or postamble, never commit, never
add comments — and they are the reason the prompt is long: 435 lines against pi's assembled
sections and OpenCode's fifteen.

### Per-tool descriptions

Nothing in the coder prompt lists the tools, and no section is conditioned on which tools are
attached. A tool is named only where a rule needs it (`view` to load a skill, `edit` and
`multiedit` for changes, `bash` for commands, `job_output` for background output), and
one rule forbids names outright: "Only use documented tools. Never attempt 'apply_patch' or
'apply_diff' — they don't exist."

Tool-specific guidance lives in the tool instead. `internal/agent/tools/bash.go` embeds
`bash.md.tpl` and renders it with `RgAvailable`, `GhAvailable`, `ModelID`, the
blocked-command list and the attribution, so the shell's instructions change per run and per
model. Twenty-nine of the tool files carry an embedded `go:embed <name>.md[.tpl]` of the
same shape. pi keeps per-tool
guidance in both places (a one-line snippet in the prompt, the full text beside the tool);
OpenCode keeps it in the description alone; crush keeps it in the description alone and never
mirrors it into the prompt.

### Plan mode announces absences

`plan.md.tpl` (55 lines) does the opposite of hiding: it enumerates the tools that are
physically absent — `edit`, `multiedit`, `write`, `bash` — states that calling them
"will fail immediately", renders `{{.ToolNames}}` for what remains, and tells the model to
refuse an implementation request in one sentence. `task.md.tpl` branches the same way on
`{{if .CanWrite}}` to tell a subagent whether it may edit or must report what it would
change instead.

Those characters are not a listing; they are a guard against a class of failed calls. pi and
OpenCode rely on the declaration set for the same information.

### Per-agent allowlists

`internal/config/config.go` (`SetupAgents`) derives each agent's tool set from one list:

- coder: every tool name minus `Options.DisabledTools`, a field whose description says it
  disables and hides the tool from the agent;
- task: the read-only set plus `bash`;
- plan: the read-only LSP lookups plus the delegation tools.

Both non-coder agents also get `AllowedMCP: {}` — no MCP tools by default. A tool outside
the allowlist is never attached, so there is nothing to declare and nothing to call: crush
implements the second act of the table and only that one. `codemode` appears in no
production file in the tree, and no deferral mechanism exists; the only reduction is
per-agent allowlists and `disabled_tools`.

## ThinkRail

### pi's prompt, assembled by the host

`packages/server/src/agent/extensions.ts` (`buildResourceLoader`) returns pi's
`ResourceLoader`, and `agentSessionManager.ts` passes it as the session's loader, so the
main path's system prompt is pi's `buildSystemPromptSections` running in-process. ThinkRail
ships no `SYSTEM.md` and no `APPEND_SYSTEM.md`; a project's own `.pi/SYSTEM.md` or
`.pi/APPEND_SYSTEM.md` is admitted through the project-trust list in `projectTrust.ts`.

### Host sections

The host adds prompt text through pi's section hook instead of replacing the prompt:
`titleTool.ts` writes a `pending-naming` section, `skillCarryover.ts` restores the
skills a resumed chat had recorded, and `headlessSearch.ts` defaults `web_search`'s
`workflow` to `none` because a desktop host has no browser curator to block on.

Built-in extensions are opt-in per factory, and ThinkRail opts into pi's `mcp` and
`tool-search` with pi's own descriptors, so a user-installed `/mcp` or a pi setting such as
`-builtin:mcp` still wins. It does not load `codemode`: the compiled binary and the
desktop bundle lack the QuickJS worker and wasm seam it needs
(`packages/server/src/agent/SPEC.md`).

### One exposure value rewritten

`packages/server/src/agent/mcp/config.ts` (`normalizeExposureForHost`) rewrites
`codemode` to `deferred`, for the server and for each `toolExposure` entry, because the
mechanism the value names is not loaded. Since `codemode` is pi's default, that rewrite is
what most servers get, and such a server lands on `tool_search` instead. The four values
are validated with a `codemode-deferred` alias for the older spelling.

The vocabulary is pi's, with one value unavailable to the host — the split the two-act table
predicts: a harness that cannot run scripts still reaches the tools, through the other
deferral mechanism.

### First-party subagent prompts

`packages/pi-subagents/src/builtins.ts` is the only first-party prompt text: `scout`,
`planner`, `worker` and `reviewer` as constants, each with an explicit tool list (scout
and reviewer get `bash`, planner does not), `extensions: true`, a shared `SPEC_FIRST`
paragraph that tells the agent to read specs before code and prefer `spec_*` tools, and a
report format with a length target. `worker` carries no tool list, so it inherits the
parent's.

## The four, side by side

|                 | prompt home                      | tool list in the prompt                  | what the tool set changes                          | hiding mechanism                                  |
| --------------- | -------------------------------- | ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| OpenCode        | one template, one placeholder    | no — three rules key on tool names       | three conditional rule sets, added by presence     | one boolean per tool, hidden by default, callable |
| pi-coding-agent | ordered, tagged sections         | yes — one snippet line per declared tool | snippet lines, guideline bullets, skills hint      | five-value exposure vocabulary                    |
| crush           | one 435-line template            | no                                       | nothing; guidance lives in each tool's description | per-agent allowlist, detach only                  |
| ThinkRail       | pi's, unchanged on the main path | inherited from pi                        | inherited, plus host sections                      | inherited, `codemode` remapped to `deferred`      |

Two smaller contrasts survive the table. OpenCode's prompt is the shortest and most generic —
fifteen lines, no tool guidance beyond three behaviours — while crush's is the longest and the
most opinionated. And where pi makes the tool description the fallback home for a hidden
tool's guidance, OpenCode makes it the only home: the `execute` catalog is the single place
a hidden tool explains itself.

## What the evidence supports

- **Guidance follows the declaration.** All four keep the two together, and each derives one
  from the other rather than maintaining two lists. pi derives the prompt from
  `hiddenTools`, OpenCode derives the template hole from the declared definitions, crush
  derives nothing because it has no derived section at all.
- **Hiding needs a second discovery path to be usable.** pi has two (the `codemode`
  description with its catalog, and `tool_search`); OpenCode has one (`execute` with
  `searchTools()` inside it); crush has none, which is why it detaches instead.
- **The OpenCode gap for pi-style hiding is a boolean per tool, not a prompt feature.** The
  built-ins that stay direct are the ones the prompt names, so a plugin setting
  `options.codemode = true` withdraws their declarations and leaves three rule sets pointing
  at tools the model cannot see directly — the state pi avoids by writing each
  guideline bullet only for declared tools.
- **Nothing in the survey argues for changing the generated surfaces.** The tiers in d116
  stand: OpenCode's default already matches the "hide MCP, keep it callable" posture with no
  configuration, which is the property the Code Mode overlay proposal relies on.

## Re-verify

Read on 2026-11-05 from bare mirrors under `~/Downloads/references/github.com/`:
`anomalyco/opencode.git` at `e3b0ca61`, `charmbracelet/crush.git` at `c98fc5459`,
`earendil-works/pi.git` at `80d4d3c86`, and `JetBrains/thinkrail.git` at `5e5409643`.

Two version caveats bind any reuse of this record. The pi mirror tip is not proven identical
to the release installed on the dev host, though the settings keys cited here
(`codemode.mode`, `codemode.inlineBudget`) appear in both trees' documentation. The
OpenCode mirror tip is a later generation than the `v2.2.6` that d148 measures, and its
config schema has moved (`providers` plural, `mcp.servers`, `type: "local" | "remote"`),
so a claim about how a setting is written must be re-checked against the version that runs.
