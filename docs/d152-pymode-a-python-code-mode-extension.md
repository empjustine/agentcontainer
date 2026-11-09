---
id: d152
type: module-design
status: draft
title: "d152 — spike: pymode, a Python code mode as a pi extension beside jsmode"
parent: coding-agent
depends-on: [d150, codemode-runtime-prior-art]
references:
  [
    d116,
    d139,
    d149,
    d150,
    d153,
    codemode-runtime-prior-art,
    mini-swe-agent,
    workload-sandboxing-prior-art,
  ]
tags: ["agent", "codemode", "python", "extension", "sandbox", "runtime", "spike"]
---

# d152 — spike: pymode, a Python code mode as a pi extension beside jsmode

**Two names the rest of this record uses.** **jsmode** is what `pi` ships today: the `codemode`
extension, where the model's free-form source is JavaScript run in QuickJS and tool calls go
through a bridge. **pymode** is the proposal: its own `pi` extension, registering a `pymode` tool
that takes free-form Python source and runs it, with tool calls going through the same host
bridge. pymode is a **sibling** of jsmode, not a runtime swap inside it — it does not touch
`@earendil-works/pi-codemode`, and pi needs no change to host it.

The spike asks what that extension has to implement, which part of it pi already publishes as an
extension API, and which interpreter it should drive. No prototype was built. The cost estimate
in [Where the cost lands](#where-the-cost-lands) is the deliverable, and it replaces the wrong
answer this record carried in an earlier draft: that a Python code mode needed an upstream
runtime interface in pi-codemode. It does not, because jsmode's runtime is not the only way to
reach the tool bridge.

Scope is the tool surface and the runtime. Out of scope: which harness to run (d116), how tools
are declared to the model (d149, d150), and whether a familiar runtime beats jsmode on
performance (d153).

Sources are bare mirrors under `~/Downloads/references/` at the tips in the survey's Re-verify
table, plus the installed `pi` 1.5.0 documentation, which is the release that runs in this
tree's container. **Every claim about another project is that project's own statement, unverified
here** — including Monty's restrictions and pydantic-ai's limits.

## Status

Draft spike. It records the design, the API surface that supports it, the interpreter options and
their costs. It changes no file outside this record and commits the tree to no runtime.

## The premise: a sibling tool, not a runtime swap

The design premise is that pymode is an ordinary pi extension whose one job is a `pymode` tool:
free-form Python source in, program output out. That is not a workaround; pi documents the whole
surface it needs, because jsmode is itself built only on that surface:

> "A tool can run other tools with `ctx.executeTool(name, args, { signal, onUpdate })`.
> `ctx.tools` lists the tools it can call. … A tool that orchestrates other tools … `codemode`
> uses only this hook, `exposure`, `reachesTools`, and `ctx.executeTool()`, so another tool can
> implement the same behavior under a different name."
> — `pi` 1.5.0 `docs/extensions.md`, Tool Exposure and Calling Other Tools

So the half of jsmode that touches the agent is public, and the half that runs source is private
to the codemode package. pymode replaces the private half and inherits the public one.

| pi API                                               | what pymode gets from it                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi.registerTool({ name, description, parameters })` | the tool itself; a free-form string parameter is an ordinary schema field                                                                                                                                                                                            |
| `promptSnippet`, `promptGuidelines`                  | where the language's usage rules go, per the rule that each bullet names its tool                                                                                                                                                                                    |
| `execute(id, params, signal, onUpdate, ctx)`         | the source, a cancellation signal, a streaming channel, and the context                                                                                                                                                                                              |
| `ctx.executeTool(name, args, { signal, onUpdate })`  | one nested call; never rejects for tool failure, returns `isError`                                                                                                                                                                                                   |
| nested-call bookkeeping                              | ids of the form `<parent id>/<n>`, `parentToolCallId` on the tool events, and a bounded `nestedCalls` record (name, arguments, status, duration, error; no results; 256 calls, 8 KiB per arguments, 32 KiB per result, `complete: false` when something was dropped) |
| `usage` on the result                                | nested usage is added to the calling tool's total                                                                                                                                                                                                                    |
| `exposure` / `reachesTools` / `prepareLoadout`       | the jsmode-like presentation: list tools in the description, hide declared tools, declare which calls a script may reach                                                                                                                                             |
| `pi.exec(command, args, { signal, timeout })`        | the interpreter process without a shell; SIGKILL after 5 s if SIGTERM is ignored, `maxBuffer` default 256 MiB                                                                                                                                                        |
| `truncateHead` / `truncateTail` / `formatSize`       | the output contract tools are required to keep (50 KB or 2,000 lines, whichever comes first)                                                                                                                                                                         |
| `constrainedSampling`                                | an optional Python grammar for the source argument, the way jsmode passes a Lark grammar for JS                                                                                                                                                                      |
| Node built-ins, `onUpdate`, `terminate`              | process management, progress streaming, and stopping the turn after a final call                                                                                                                                                                                     |

What pymode does **not** inherit, because it lives in the codemode package: the QuickJS VM and
its prelude, the worker pool and its admission, the `store`/`load` session state, the declaration
renderer, the output item protocol, and the grammar. Those are the work.

Two consequences follow, and they are the reason this design is worth the record. First, pymode
can be built and measured without an upstream release. Second, the two code modes can run
**side by side in one session** — jsmode's catalog and pymode's catalog are separate tools, so
the comparison in d153 does not require swapping binaries.

## What pymode has to implement

The jsmode contract is language-independent, so it is the checklist. Each row is either inherited
from pi (above) or owned by the extension.

| capability                           | jsmode today                                                                       | pymode's own work                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| the tool                             | `codemode` with a raw-JS string parameter                                          | `pymode` with a raw-Python string parameter; a directive comment for per-call limits            |
| declarations                         | TypeScript declarations rendered from each tool's JSON schema into the description | a Python stub renderer: schema to `async def` signatures, plus a `TypedDict` per object result  |
| identifiers                          | tool names mangled to valid JS identifiers                                         | mangled to valid Python identifiers, keywords escaped, `-`/`.` folded to `_`                    |
| the bridge                           | a prelude closure plus one host-call entry into the wasm VM                        | a Python prelude that writes a request and reads a response, over the process's own pipes       |
| concurrency                          | promises; several calls may be in flight                                           | `asyncio` in the prelude, with the extension serving requests as they arrive                    |
| state across calls                   | none, except `store`/`load` JSON                                                   | the same choice, made again: nothing, or a session entry holding JSON or a pickled namespace    |
| output to the model                  | text items, console lines, images, capped by `max_output_tokens`                   | printed output and the last expression, truncated by pi's helpers                               |
| compute limits                       | `timeout_ms` on the whole script, an interrupt budget, 256 MB heap                 | a wall deadline with SIGTERM then SIGKILL, a memory cap via `resource.setrlimit`, an output cap |
| ambient authority                    | none: no modules, no clock, no FS, no network                                      | the interpreter's own reach, bounded by whatever wrapper the process runs under                 |
| placement                            | worker thread, Durable Object, or calling thread                                   | a child process, locally or in a sandbox wrapper                                                |
| approvals and nested-call visibility | recorded by the shared codemode machinery                                          | recorded by pi, since `ctx.executeTool` is the same path                                        |

Nine rows of that table are engineering with known answers. The tenth — ambient authority — is
the one that decides how much of jsmode's guarantee pymode keeps, and it is not a language
question at all.

## The interpreter question

Four candidates, in ascending order of work and isolation.

**CPython as a child process, unwrapped.** `pi.exec` starts `python3` with the script written to
a temp file and a prelude on `-c`, or the script piped on stdin. The prelude defines the tool
stubs, writes a JSON request, blocks on the response, and continues. This is days of work, not
weeks, and it is the only candidate that is fully understood before it starts. Its cost is the
guarantee: the program can `import os`, read any file the agent can read, and start any process.
"Only intentional tools" becomes "tools plus everything the container allows" — the shape
`docs/d153` calls arm 4, and the shape mini-swe-agent argues is sufficient.

**CPython inside a wrapper process.** The same bridge, with the interpreter behind `bwrap` or
`landlock`: a read-only root, a writable scratch directory bound at a fixed path, an empty
network namespace, and the pipes as the only channel back. The repo's own survey of those
mechanisms is `docs/workload-sandboxing-prior-art.md`, and it is the only place in this design
where the guarantee is restored without writing an interpreter. The cost is that the sandbox's
policy, not the language, defines the surface: the model can still `import os` and touch the
scratch directory, and the file tools it calls are the ones bound into it.

**Monty.** `pydantic-monty` is the interpreter behind pydantic-ai's code mode, and its consumer
contract is the most complete Python code-mode statement on the farm: a 24-module stdlib
allowlist, `asyncio.gather` with positional awaitables only, no `import *`, no clock or unseeded
randomness without an `os_access` handler, JSON-shaped tool results with `Decimal`, `UUID` and
`datetime` arriving as strings and mapping keys stringified, tool waits excluded from the
execution budget, and 1,000 suspensions per session
(`pydantic/pydantic-ai.git:docs/harness/code-mode.md`). If the package ships a usable local
sandbox or worker, pymode is a driver around it and the restriction list comes for free. **The
package is not mirrored, so this record does not claim it ships one** — checking that is the
first task of the spike, and the answer changes the effort by an order of magnitude.

**CPython compiled to WebAssembly.** The target and its best-known distribution are different
things, and the difference matters for an extension that has to embed one. CPython's own WASI
port runs with the host supplying the imports. **Pyodide** is a distribution on top of that idea:
CPython built with Emscripten, a large precompiled package catalogue, and a JavaScript FFI layer.
Pyodide is therefore CPython-in-Wasm, while CPython-in-Wasm is not necessarily Pyodide.
**RustPython** belongs in a third place: an independent interpreter that targets CPython
compatibility, so it is a runtime of its own rather than a build of CPython — closer to Monty in
kind, with the difference that Monty restricts deliberately and RustPython aims at the whole
language. None of the three is mirrored, nor is CPython itself, so this record claims nothing
about which one embeds cleanly in a pi extension. The shape is nonetheless the only candidate
that is both real Python and genuinely closed, which is why it is worth a look before Monty's
restrictions are accepted.

## The sandbox jsmode actually uses, and what would fit pymode

The mechanism is confirmed in the package source, because it decides which interpreter is even
plausible. jsmode compiles `quickjs-wasi/quickjs.wasm` once per process with
`WebAssembly.compile`, then calls `QuickJS.create({ wasm, memoryLimit, maxStackSize,
interruptHandler, wasi })` inside a worker thread (`packages/codemode/src/wasm.ts`,
`runtime/vm.ts`, `runtime/host.ts`). The module receives only the imports the host supplies: a
WASI shim that discards the module's stdout and stderr and, when determinism is asked for,
replaces the clock and the randomness (`discardOutput` / `deterministicWasi(clock)`), plus
QuickJS's host-call entry, which is how `tools.x()` reaches the prelude. Anything else the
module asks for is simply not implemented, so "no Node, no filesystem, no network" is not a
policy check — it is a missing import. The worker exists because QuickJS runs synchronously, and
the interrupt flag in a `SharedArrayBuffer` is how a spinning script is stopped.

That mechanism is bound to QuickJS in a way that matters: `QuickJS.create`, the value
marshalling, the prelude and the interrupt polling all come from `quickjs-wasi`'s JavaScript
API. **pymode cannot swap the `.wasm` file and get a Python code mode.** Reusing the harness
means writing a second host — module, import object, host-call protocol, prelude — which is a
runtime, not a configuration.

Where a Wasm CPython sits, then. Pyodide is not a module with WASI imports; it is a distribution
of CPython built with Emscripten, shipped with a JavaScript loader, an in-memory filesystem, and
a JS↔Python FFI layer. That changes the integration route, and it leaves the _shape_ closer to
jsmode than a child process is:

| route                                                     | what it is                                                                        | what "only intentional tools" means                                   | isolation is               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------- |
| a WASI CPython build in a jsmode-style host               | CPython compiled to `wasm32-wasi`, instantiated with a hand-written import object | the import object: a host-call entry and nothing else                 | the module's imports       |
| Pyodide driven from a Node worker, with its own JS loader | CPython plus Emscripten's in-memory filesystem plus the FFI layer                 | the prelude, plus whatever the host mounts or exposes through the FFI | the worker and the process |
| a child `python3` process (the variants above)            | the image's own CPython                                                           | the container, or the sandbox wrapper                                 | the process boundary       |

Two rows are worth naming precisely, because a spike would test them first. The WASI row is the
only route that keeps jsmode's guarantee _and_ real Python, and it exists only once someone
builds and pins a WASI CPython module. The Pyodide row is the pragmatic one: its filesystem is
in-memory, so Python code cannot open a host path that was not mounted, which is a jsmode-like
property that costs no wrapper — but the isolation is the worker and the process rather than the
module, and the FFI layer is a real authority unless the prelude is written not to expose it. The
third row is the cheap one, and its isolation story is already written in this repo.

The farm carries all five, so the routes above are checkable here rather than asserted.
`python/cpython` is mirrored with the WASI target in it: `Tools/wasm/wasi.py` and its `wasi-env`
sibling build the interpreter, `configure.ac` recognizes `*-*-wasi*` and lists
`wasm32-unknown-wasip1/clang` as a support tier. `pyodide/pyodide` is mirrored, and its
`src/js/nativefs.ts` mounts a host directory onto the in-memory filesystem (`MEMFS` plus
`FS.syncfs` in both directions), so the question of whether a Node host can hand Pyodide real
files has an affirmative answer in the source. Monty's own interpreter source is at `pydantic/monty`,
and jsmode's host is at `vercel-labs/quickjs-wasi` rather than only through its consumer,
`earendil-works/pi`.

## Where the cost lands

Ordered by how much of the schedule it takes, with the source of the difficulty.

1. **The prelude and the request protocol.** A Python program has to await a tool call and
   receive a JSON value; that is a small library, not a few lines, because it must survive
   exceptions both sides, a cancelled signal, and output interleaved with requests.
2. **The declaration renderer.** Schemas become `async def` signatures and result types. The
   awkward cases are visible in Monty's own documentation: a `dict[int, str]` arrives with
   string keys, a tool without a return schema generates `-> Any`, and `bytes` is the one type
   that crosses natively. Getting this right for the eight built-in tools is most of the work.
3. **Limits and cancellation.** SIGTERM, then SIGKILL after a grace period (`pi.exec` already
   does this for a command it started); `resource.setrlimit` for address space; a printed-output
   cap in the prelude so a `print` loop cannot build a megabyte before the truncation helper
   sees it.
4. **State.** The cheap answer is "none", matching jsmode. The interesting answer is a session
   entry holding a pickled namespace, and it is interesting mostly because it exposes what the
   pickle boundary cannot carry — a real trade, not a feature.
5. **Presentation.** `prepareLoadout` and `reachesTools` if pymode should hide the declared
   tools the way jsmode does in `mode: "only"`. Without them, pymode is a `direct` tool that
   lists its catalog in its own description, which is a fine first version.
6. **The grammar.** Optional. jsmode hands providers a Lark grammar for its source; a Python
   grammar is harder to write and buys less, since a Python script's shape is not fixed.

Two things are explicitly _not_ on this list because pi already pays for them: nested-call
recording and usage accounting. A pymode script that calls `read` fifty times produces the same
bounded `nestedCalls` record a jsmode script does, with the same 8 KiB / 32 KiB omission rules
and `complete: false` when the record loses something.

## What pymode should copy from the surveyed Python code mode

Three choices in pydantic-ai's implementation are cheap to adopt and expensive to discover:

- **Execution time excludes tool waits**, and sleeping has its own allowance. jsmode's
  `timeout_ms` is "a hard deadline for the whole script, including any wait for a free worker"
  and, when set, includes tool latency. A pymode that copies jsmode's deadline will time out
  scripts that were waiting on slow tools, and the model will read that as its own error.
- **A timeout has a recovery path.** Monty stops the snippet, resets the session, and tells the
  model what it lost and which nested calls already ran. pymode can do the same from
  `details`: report the calls made before the kill.
- **Multimodal content never enters the sandbox.** A tool's content goes to the model beside the
  result; the script only gets the return value. This is also what pi's `outputSchema` /
  `structuredContent` split gives programs, so pymode should declare stubs against
  `structuredContent` and leave images to a helper that the extension resolves.

## What this tree already has

- `coding-agent/config.toml` pins `uv`, `fd`, `jq`, `ripgrep` and `pi`; the `python` and `pipx`
  entries are commented out. `uv` supplies a CPython without a new image layer, and
  `uv run --python <version>` pins it per invocation.
- `coding-agent/Containerfile` builds from `node:24-trixie`, a slim Debian derivative, so Node is
  the only interpreter the image is built to guarantee. A pymode that assumes `python3` exists
  is assuming something about a base image it does not control.
- `coding-agent/settings.json` runs `+read +bash +edit +write +grep +find +ls +codemode` with
  `codemode.mode = "only"` and `inlineBudget: 0`. Adding pymode is one more `+` entry and one
  more description budget to think about, not a replacement.
- The extension surface pymode needs is documented in the installed release
  (`pi` 1.5.0 `docs/extensions.md`, and `docs/tui.md` for rendering), which matters because a
  feature that only exists in the mirror cannot be relied on by this image.

## Feasibility, option by option

| variant                                      | what it needs                                           | effort                                      | keeps "only intentional tools"          | main risk                                               |
| -------------------------------------------- | ------------------------------------------------------- | ------------------------------------------- | --------------------------------------- | ------------------------------------------------------- |
| A. pymode over plain CPython                 | the extension, a prelude, a stub renderer               | days                                        | no: the program can reach the container | the tool is a shell by another name                     |
| B. pymode over CPython in `bwrap`/`landlock` | A plus a policy file and a scratch-directory convention | days to a week                              | yes, at the process boundary            | policy drift: the wrapper and the tool list disagree    |
| C. pymode over Monty                         | C first, then a driver around `pydantic-monty`          | days if a local worker exists, weeks if not | yes, inside the interpreter             | the dialect's restrictions become pymode's restrictions |
| D. pymode over a remote CPython sandbox      | a sandbox provider, a transport, credential forwarding  | a week, plus infrastructure                 | yes, at the machine boundary            | latency on every nested call                            |

A and B are the same extension with a different spawn line, which is why the spike's first
deliverable is the extension and not a decision about isolation. C is the only variant whose
guarantee is stronger than a wrapper's and its cost is entirely outside this repository: it is
a question of what `pydantic-monty` exposes, not of what pi can host.

## The cheapest credible spike

1. Register `pymode` with a raw-Python string parameter, a prompt snippet, and a hard-coded
   catalog of the eight built-in tools rendered as `async def` stubs.
2. Spawn `python3` with a prelude that defines those stubs, satisfies calls over stdin/stdout,
   and reports the final expression and printed text.
3. Serve each request with `ctx.executeTool(name, args, { signal })`, stream progress with
   `onUpdate`, truncate with `truncateHead`, and return `details` naming the calls made.
4. Put the spawn behind `bwrap` once the bridge is stable, and compare the two runs of the same
   task with and without the wrapper.
5. Run the arm comparison in `docs/d153`, where pymode is now arm 5 and the only arm that changes
   the language without changing the tool surface.

Steps 1 to 3 answer the only question that matters for feasibility: whether a JSON bridge between
a Python child process and the tool registry is fast and robust enough that the model does not
spend its turns recovering from the bridge.

## What pymode cannot fix

- **The catalog.** `inlineBudget: 0` makes every signature a `searchTools()` step in jsmode. A
  pymode with a rendered catalog in its description does not have that problem, and a pymode with
  the same budget would. That is a settings question, not a language one, and d153's arm 2 exists
  to keep it from being mistaken for one.
- **Truncation.** The output contract is pi's, not the interpreter's. A Python program that prints
  40 KB still produces a 50 KB-capped tool result.
- **Ambient authority, when unwrapped.** Variant A's guarantee is whatever the container already
  is. Saying "pymode is sandboxed" without the wrapper would be false.
- **The dialect's cost, in variant C.** Every restriction Monty publishes is a Python habit that
  fails: `from os import *`, `datetime.now()`, keyword arguments to `gather`, integer dict keys.

## Alternatives rejected

- **A `python` tool that runs one script per call, with tools reachable only through the shell.**
  That is variant A without the bridge, and it is not a code mode: nothing composes a tool call
  into a loop, and no nested call is recorded. It is recorded in d153 as the bash/minimal arm,
  which is where it belongs.
- **Starlark, CEL, Lua, Rhai.** Embeddable and easy to bound, and no model writes them at scale.
  A pymode built on one would pay the unfamiliarity cost twice. See the survey.
- **Attaching to `@earendil-works/pi-codemode`.** There is no runtime-registration surface in the
  package, and none is needed: the extension API already carries the tool-facing half. This was
  the earlier draft's wrong turn, recorded here so it is not repeated.

## What this record does not decide

It does not choose between variants A, B, C and D, does not add an extension to the tree, and
does not claim pymode would perform better than jsmode. The performance question is d153's, and
its answer is not measured anywhere on the farm.
