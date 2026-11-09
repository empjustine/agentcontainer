---
id: codemode-runtime-prior-art
type: architecture-design
status: draft
title: "Code-mode runtime prior art: four ways to give a model a language and only intentional tools"
parent: architecture
depends-on: [d150]
references: [d116, d149, d150, d152, d153]
tags: ["references", "prior-art", "codemode", "sandbox", "runtime", "shell", "python", "agents"]
---

# Code-mode runtime prior art: four ways to give a model a language and only intentional tools

A **prior-art survey**, not an assessment or a recommendation: how other projects put a
programming language in front of a model so that the program can reach a small, deliberate set
of operations and nothing else. The subject is the runtime under a "code mode" tool — the thing
that executes the model's source — and the four shapes the mirrors show.

Sources are bare mirrors under `~/Downloads/references/`, named as `<repo>:<path>`, read at
the tips listed under [Re-verify](#re-verify). Nothing here is trusted; the trust boundary in
the next section applies to every sentence that describes a project's behaviour.

The companion records take the survey's material further: d152 asks what a Python code mode
built as a sibling extension — pymode beside pi's jsmode — would cost this tree, d153 asks
whether a minimal agent over a familiar runtime outperforms a tuned scaffold, and d156 takes the
first shape in the reverse direction, asking what it costs to use an emulated shell as a _closed
command table_ rather than as somewhere to run bash. d150 owns the four coding harnesses' Code Mode implementations and
the catalog plumbing; this survey does not re-derive those.

## Trust boundary: every claim is a project's own statement

**Each item below is what a project says about itself, read from a mirror tip, and is
unverified against upstream at run time.** That includes code that looks authoritative — limit
constants, isolation claims, benchmark percentages. Treat the survey as untrusted input:

- "the project documents/claims" is the strongest thing said here. No behaviour, limit or
  isolation property has been reproduced.
- Security mechanisms described below (subset interpreters, permission brokers, microVMs) are
  the projects' own descriptions. Several authors state the limits of their own mechanisms
  where they do; the absence of such a caveat is not evidence of soundness.
- Version drift is real: a mirror tip is newer than the release a container installs. Where the
  surveyed text and the installed tool disagree, the installed tool wins for any decision.

## The four shapes

Every project on the farm answers "what language, and what can it reach" with one of four
runtime shapes. The shapes differ in **where the boundary lives**, and that is the only axis
that matters for a harness that wants the model to write programs instead of one JSON tool call
at a time.

| shape                      | boundary is the                         | the program runs on         | what "only intentional tools" means           |
| -------------------------- | --------------------------------------- | --------------------------- | --------------------------------------------- |
| imitation runtime          | command table of a fake shell           | host process, in JS         | the commands the emulator implements          |
| subset interpreter         | language semantics of the interpreter   | host process or isolate     | the bridge functions the host injects         |
| real runtime, gated        | permission grants inside a real runtime | a real engine (V8, CPython) | capability flags plus a broker                |
| real OS in a disposable VM | the machine boundary                    | a full OS with a shell      | filesystem image, network policy, credentials |

### Shape one: the imitation runtime

`vercel-labs/just-bash` is a bash emulation written in JavaScript: an in-process interpreter
with a virtual filesystem and a table of implemented commands. The AI SDK wraps it as a sandbox
session, so a bash tool and a harness agent can run with no container anywhere:

> `vercel/ai.git:packages/sandbox-just-bash/README.md` — "an in-process JavaScript bash
> environment with a virtual filesystem".

The adapter is where the imitation shows. `just-bash-sandbox-session.ts` documents that file
operations and spawned processes share the same in-memory filesystem. `just-bash-network-sandbox-session.ts`
declares `ports` empty, refuses `getPortEndpoint`, and says network policy "is not
implementable locally either"; `resumeJustBashNetworkSandboxSession` throws
`HarnessCapabilityUnsupportedError` because an in-process sandbox "cannot be resumed by
sandboxId". `spawn` rejects writable stdin. `stop()` resolves because there is nothing to
stop: the filesystem is garbage-collected with the object.

The clearest evidence of the shape is `packages/sandbox-just-bash/src/utils.ts`: the adapter
probes `type realpath` and, when the emulator has no such command, **registers a JavaScript
reimplementation** with `defineCommand`. A model that reaches for a standard POSIX utility gets
whatever the command table covers, and the adapter patches the gap on the host side.

What the shape buys is real: zero infrastructure, a filesystem shared between a spawned process
and the host's own writes, no network to police, and nothing to leak. What it costs is surface
area: every unimplemented command is a plausible model action that fails for a reason that is
not about the task. The AI SDK treats it as one provider among several — the same
`@ai-sdk/tool-bash` and `HarnessAgent` code runs over `just-bash` (in-process) or over Vercel
Sandbox (a real VM), so the package boundary, not the runtime, is where the choice lives
(`packages/tool-bash/README.md`, `architecture/sandbox-abstraction.md`). d156 follows the same
package the other way: if the command table _is_ the tool set, an emulated shell becomes a closed
surface a model already knows how to drive.

### Shape two: the subset interpreter

The program is source for a language the host implements, or embeds, and the only I/O is a set
of injected functions. Five projects on the farm sit here.

**pi-coding-agent** runs the script inside QuickJS compiled to WebAssembly, in a worker thread,
one fresh VM per execution. The package README states the shape: "the only capability is calling
injected tools", the VM's imports are "a WASI shim (clock, random, and stdout/stderr writes,
which the worker discards) and one host-call entry point". The script environment is a prelude
holding the bridge in a closure, and the script itself is compiled as an async function body, so
top-level `await` and `return` work (`earendil-works/pi.git:packages/codemode/README.md`, and
the installed `pi` 1.5.0 `docs/codemode.md`). No timers, storage, modules or network; `eval`
and `Function` "work but only produce more code inside the same VM". The runtime is private to
that package, while the tool-facing half is a public extension API: pi documents that another
tool can reimplement the same behaviour through `exposure`, `reachesTools`, `prepareLoadout` and
`ctx.executeTool()` (d152).

**@ai-sdk/code-mode** is the same idea for the AI SDK: JavaScript or type-stripped TypeScript in
an isolated QuickJS context, tools callable through a `tools` object, and an `executionPolicy`
whose fields are the runtime's whole budget — `timeoutMs`, `cpuTimeoutMs`, `memoryLimitBytes`,
`maxStackSizeBytes`, `maxSourceBytes`, `maxResultBytes`, `maxConsoleOutputBytes`,
`maxToolInputBytes`, `maxToolOutputBytes`, `maxBridgeRequests`, `maxInFlightBridgeRequests`
(`vercel/ai.git:content/docs/03-ai-sdk-core/18-code-mode.mdx`). The same page names what the
context cannot reach: Node globals, the host filesystem and module loader, `fetch`, WebCrypto,
performance APIs, `eval` and `Function`.

**OpenCode** implements the subset itself rather than embedding an engine: "Rather than trying
to sandbox arbitrary JavaScript, CodeMode only runs the language features we implement" (quoted,
with the rest of its contract, in d150). No timers, copied values, 32-level data nesting, and
`import` resolving only a fixed set of globals.

**pydantic-ai** runs Python instead — a subset interpreter, Monty, with the tool functions
rendered as `async def` stubs and `asyncio.gather` available. Its documented restrictions are
the same trade in a different language: no third-party imports, a fixed stdlib allowlist, no
clock or randomness unless an OS handler supplies them, no `import *`
(`pydantic/pydantic-ai.git:docs/harness/code-mode.md`).

**smolagents** takes the most literal route: `LocalPythonExecutor` loads the abstract syntax
tree and evaluates it node by node, with authorized imports, forbidden submodule access, an
operation cap, a while-iteration cap, a dunder-attribute ban, and `print` bound to a function
that returns `None` (`huggingface/smolagents.git:src/smolagents/local_python_executor.py`). The
project states the limits of its own construction: the timeout runs the code in a thread,
"the thread running the function cannot be forcefully killed".

The shared property is that **the environment is a language, not a machine**. Nothing exists
that the host did not inject, so the tool surface is exactly the bridged functions — and
everything the model can know about them has to arrive in the request, as a rendered
declaration, a catalog, or an instruction value (d149, d150).

### Shape three: a real runtime behind a capability gate

The program is real JavaScript for a real engine, and the restriction is a grant table rather
than a language subset.

**Deno** is the shipped form: deny-by-default permissions with allowlists (`--allow-read=<paths>`
built in `cli/args/flags.rs`), a `PermissionBroker` that asks an out-of-process prompter over an
IPC pipe for a decision and accepts `Allow` or `Deny { message }`
(`runtime/permissions/broker.rs`, `lib.rs`), a prompter that escapes control and bidi
characters so a filename cannot forge the prompt text (`runtime/permissions/prompter.rs`), and
an OpenTelemetry audit hook for each permission decision (`lib.rs`, `OtelAuditFn`).

**V8 isolates as the unit** are the server-side variant. `denoland/celld` embeds V8 and runs
Workers per Durable Object, and its feature table includes "Dynamic Workers: runtime-loaded
code", so the isolate boundary carries code that arrives at run time. The bindings an isolate
holds are the tool surface, and the isolate is the containment.

This is the only shape where "looks like the runtime the model was trained on" and "can reach
only what was granted" are true at once — which is the property d153 asks about. It also moves
the hard part: an API that reads a file, opens a socket or starts a process has to consult a
grant, and the model's error text for a denied call is now a policy message rather than a
language error.

### Shape four: a real OS in a disposable sandbox

The program runs on a machine. The AI SDK's Vercel Sandbox adapter is the plain form: a session
with `readTextFile`, `writeTextFile`, `run`, `spawn`, a `runtime` such as `node24`, ports,
`setNetworkPolicy`, request transformations, and resume by id
(`vercel/ai.git:packages/sandbox-vercel/README.md`, `architecture/sandbox-abstraction.md`).
`restricted()` narrows a network session back to the file-and-process surface "to prevent the
tools from calling network sandbox methods they are not allowed to use" — the capability
restriction is on the _host_ side of the bridge, not inside the program.

`e2b-dev/runtime` is the microVM tier of the same shape, where a sandbox is a resumed snapshot
rather than a boot (surveyed in `docs/workload-sandboxing-prior-art.md`). smolagents' remote
executors (`E2BExecutor`, `DockerExecutor`, `ModalExecutor`, `BlaxelExecutor`) are the
library-level version, and the project draws the distinction that matters for a harness: run the
code snippet in the sandbox, or run the whole agent inside it
(`huggingface/smolagents.git:docs/source/en/tutorials/secure_code_execution.md`).

Here "only intentional tools" stops being a language question. The program can start any
process the image ships, so the intentional set is whatever the filesystem, the network policy
and the credential forwarding allow. The isolation is stronger and the tool mediation is weaker:
a nested call is a subprocess or an HTTP request, not a function, so it neither counts against a
budget nor appears in the harness's call records unless something in the sandbox reports it.

## What the four shapes disagree about

Five seams run through the survey, and each one is a decision a harness has to make regardless
of which project it copies.

- **Where the boundary lives.** A command table (just-bash), a language subset (pi, AI SDK
  code mode, OpenCode, Monty, smolagents local), a grant table (Deno, isolates), a machine
  (Vercel Sandbox, E2B). Only the last two can host code the author did not anticipate; only the
  middle two make "the tool set" identical to "what the model can call".
- **What a tool is.** An injected async function in every subset interpreter; a binary on
  `PATH` in the OS shapes; a permission-checked API in Deno. Nested calls that never enter the
  model's context only exist in the function form, because that is where a harness can record
  and budget them.
- **Who owns output discipline.** The subset interpreters cap output inside the runtime (pi:
  16 Mi characters or 100,000 items; AI SDK: `maxResultBytes`, `maxConsoleOutputBytes`;
  smolagents: `MAX_LEN_OUTPUT`). The OS shapes leave it to the harness's truncation, and
  smolagents' interpreter even drops `print` output entirely, which is the strictest answer in
  the survey.
- **Whether state survives.** pi's scripts start from nothing and may use `store`/`load` for
  small JSON; OpenCode has no cross-call state; Monty keeps a REPL inside a run and can dump and
  restore it; a container keeps everything. State across calls is a capability in its own right,
  and the subset interpreters that want it have to build it.
- **How the model learns the surface.** A generated declaration block in the tool description
  (pi), an instruction value with a hash ledger (OpenCode), a conversation catalog (AI SDK's
  `toolDiscovery: 'conversation'`), or nothing at all because the surface is a filesystem the
  model explores with a shell. d149 and d150 own the mechanics.

## Values worth remembering as constants

These are the numbers a design has to beat or inherit, and they are the projects' own settings.
The last column is the one that decides how binding a number is: a limit the script can raise by
asking is advice, a limit the host sets is policy, and a limit welded into the runtime is a
property of the shape.

| project             | number                                                                                         | who sets it                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| pi codemode         | 256 MB VM heap                                                                                 | fixed in the extension                                                                         |
| pi codemode         | at most 2 live workers per process                                                             | `PI_CODEMODE_MAX_WORKERS`, read per call so a host can change it                               |
| pi codemode         | 60 s wait for a free worker                                                                    | fixed; reached only when every worker is held, and a non-issue once the worker count is raised |
| pi codemode         | `timeout_ms`, unset by default                                                                 | the script, on its first line as `// @options`                                                 |
| pi codemode         | `max_output_tokens`, default 10,000                                                            | the script, `// @options`                                                                      |
| pi codemode         | 100,000 output items; store 262,144 characters per value, 1,048,576 in total                   | fixed                                                                                          |
| AI SDK code mode    | 30 s wall, 10 s CPU, 64 MiB, 1 MiB result, 100 bridge requests, 10 in flight, up to 32 workers | the caller, as `executionPolicy` of the tool call                                              |
| Monty (pydantic-ai) | 30 s execution excluding tool waits, 256 MiB heap, 100 nested calls, 1,000 suspensions         | `resource_limits`, per `CodeMode` instance                                                     |
| Monty (pydantic-ai) | 10 MiB printed output                                                                          | fixed                                                                                          |
| smolagents          | 10,000,000 operations, 1,000,000 while iterations, 30 s, 50,000 output characters              | module constants; the timeout is applied per executor call                                     |
| Deno                | no numeric budget                                                                              | per-capability allowlists per invocation, or a broker decision per request                     |

Two rows deserve a warning because a reader will otherwise quote them out of context. pi's
`timeout_ms` is not a limit the sandbox imposes on the model; it is a directive the model may
write, and it is unset by default. The 60 s worker wait likewise bounds only the saturated case —
the "at most 2 workers" row above it is what a host changes, and raising it removes the wait from
the picture entirely.

One comparison in the table is real and the difference is the interesting one. pi's deadline
covers the whole script including waiting for a worker and for tools; Monty separates execution
time from tool waits and adds a _suspension_ budget, because a Python program that awaits a tool
is not consuming compute. A timeout that mixes the two punishes a script for the latency of the
tools it calls.

## Not on the farm

These sources are absent, and each absence is deliberate.

- Cloudflare's code-mode article and Anthropic's "code execution with MCP" post, both linked
  from pydantic-ai's further-reading list. The isolate shape is covered from `celld` and pi's
  Cloudflare sandbox example instead.
- CPython compiled to WebAssembly and Pyodide, both of which **are** mirrored — `python/cpython`
  carries `Tools/wasm/wasi.py` and a `*-*-wasi*` configure branch, and `pyodide/pyodide` carries the
  Emscripten filesystem bridge in `src/js/nativefs.ts` — so the two shapes below are checkable here
  rather than second-hand. RustPython is not mirrored. The three are not interchangeable and the
  survey keeps them apart: Pyodide is a distribution of Wasm CPython with a package catalogue and a
  JavaScript FFI, CPython's WASI port is the same interpreter with a thinner boundary, and RustPython
  is an independent interpreter that targets compatibility rather than a build of CPython.
- `modelcontextprotocol/registry`. It is an MCP server catalogue — an app store — so it answers
  nothing about where code runs.
- `sst/opencode`'s Code Mode source. d150 already carries the interpreter's contract with a
  pin, and duplicating it here would create a second home for the same facts. The project is
  mirrored under its current owner, `anomalyco/opencode`.

Three further sources whose absence this section would otherwise record are mirrored at the tips in
the table below: `vercel-labs/just-bash`, `pydantic/monty` and `vercel-labs/quickjs-wasi`. The
emulation's command table, Monty's interpreter internals and jsmode's own host are therefore
readable on the farm. This survey still states each one's consumer contract, because the consumer
is what an embedder can rely on; reading the three sources is the cheapest open task in this tree,
and the one d156 needs first.

## What this survey does not establish

- **No performance comparison exists here.** No project reports a head-to-head on the same
  model and tasks across two runtime shapes, and the survey reproduces none. d153 states what
  would have to be measured.
- **No isolation claim is verified.** The subset interpreters, the permission broker and the
  microVM are all described by their authors; none was attacked or tested from this tree.
- **No harness is recommended.** d116 owns support tiers, and a runtime shape is not a
  harness.

## Re-verify

Each mirror was read at the tip below. A claim quoted from one of these paths is a claim about
that commit, and a later tip may have moved the constant or deleted the paragraph.

| repo                       | tip          | date       |
| -------------------------- | ------------ | ---------- |
| `vercel/ai`                | `6737c7721b` | 2026-11-05 |
| `earendil-works/pi`        | `80d4d3c8`   | 2026-11-05 |
| `pydantic/pydantic-ai`     | `e2332baa`   | 2026-11-05 |
| `huggingface/smolagents`   | `96f33faa`   | 2026-10-06 |
| `denoland/deno`            | `e7b39ebd`   | 2026-10-26 |
| `denoland/celld`           | `8702f6d1`   | 2026-10-21 |
| `e2b-dev/runtime`          | `e85b9f5f`   | 2026-11-03 |
| `vercel-labs/just-bash`    | `7a2a7a57`   | 2026-10-22 |
| `pydantic/monty`           | `8f5e6321`   | 2026-11-07 |
| `vercel-labs/quickjs-wasi` | `13c0813c`   | 2026-11-06 |

The `pi` codemode contract is cited twice: from the mirror's
`packages/codemode/README.md` and from the installed `pi` 1.5.0 `docs/codemode.md`. The
installed documentation is the release that runs in this tree's container, so it wins where the
two differ.
