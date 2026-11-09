---
id: d156
type: module-design
status: draft
title: "d156 — spike: shmode, a closed shell over just-bash, with tools spelled as commands"
parent: coding-agent
depends-on: [codemode-runtime-prior-art, d152]
references: [d116, d150, d152, d153, codemode-runtime-prior-art, mini-swe-agent]
tags: ["agent", "codemode", "shell", "just-bash", "extension", "sandbox", "spike"]
---

# d156 — spike: shmode, a closed shell over just-bash, with tools spelled as commands

**shmode** is the proposal this record verifies: a pi extension registering one `shmode` tool
that takes free-form shell source, executes it in a `just-bash` sandbox, and presents the tool
set as ordinary commands. Reading a file is `cat notes.txt`, or `cat notes.txt | head -20`, or
`cat notes.txt | awk '{print $2}'`; anything that is not a command-shaped capability is reached
through one multiplexer, `ssh prd <tool> <args…>`. The model writes a shell program instead of
a JSON call, and the surface stays closed because the command table _is_ the surface.

The record answers one question — **what would it take to build that?** — in the only order that
was honest when it was drafted, with no copy of `just-bash` on the farm. Every claim below about
its behaviour came from the AI SDK adapter that wraps it, from the bash tool's own description, or
from the one place the adapter patches it; `vercel-labs/just-bash` is mirrored at `7a2a7a57`, so
those claims are now checkable against the emulator itself and the six open items below are the
first place to look.

Sources are bare mirrors under `~/Downloads/references/` at the tips in
`docs/codemode-runtime-prior-art.md`'s Re-verify table, plus the installed `pi` 1.5.0 docs.
**Claims about `just-bash` are second-hand and marked as such.** No prototype was built.

## Status

Draft spike. It records the verified API surface, a design, the verification list that decides
the effort, and the one structural finding that changes the design. It adds no extension to the
tree.

## The premise: disguise, not a new runtime

d153 states the hypothesis that a familiar runtime beats a bespoke one, and it also names the
counterweight: a familiar runtime is an _open_ surface. shmode is the attempt to have both — the
model writes shell, and the shell has a command table, so "familiar language" and "closed surface"
stop being a trade. The cell it occupies in d153's grid is a third one:

|                          | closed catalog                 | open surface |
| ------------------------ | ------------------------------ | ------------ |
| language the model knows | pymode, **shmode** (imitation) | bash         |
| language it does not     | jsmode                         | —            |

The difference between shmode and the bash arm is not the language. It is that in shmode the
shell is an emulation whose commands are the tool set, while the bash arm runs the container's
real shell and inherits everything in it.

Two implementations are possible under that heading, and the choice between them is the whole
design:

- **the filesystem holds the truth**, and `cat`, `head`, `tail`, `grep` and `awk` are the
  emulator's own commands reading a virtual filesystem seeded from the container;
- **the tools hold the truth**, and `cat` is a command whose handler calls the `read` tool.

They behave differently the moment a pipeline has a second stage, and the difference decides the
design (see [The pipeline finding](#the-pipeline-finding)).

## What is verified about just-bash

Everything here is read from `vercel/ai.git:packages/sandbox-just-bash/src/` and
`packages/tool-bash/src/bash-tool.ts`. The adapter is the only on-farm view of the library, so
the API below is the API its author used, not necessarily the whole one.

| what                          | how it appears                                                                                                                                    | source                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| create a sandbox              | `await Sandbox.create(params)`, then `sandbox.stop()`                                                                                             | `just-bash-sandbox.ts`                                                 |
| run a script string           | `sandbox.runCommand({ cmd: 'bash', args, cwd, signal, detached })` returns `{ stdout(), stderr(), exitCode }`                                     | `just-bash-sandbox-session.ts`                                         |
| inspect a command             | `sandbox.bashEnvInstance.exec('type realpath')` returns an exit code                                                                              | `utils.ts`                                                             |
| register a command            | `sandbox.bashEnvInstance.registerCommand(defineCommand(name, handler))`                                                                           | `utils.ts`                                                             |
| a handler's shape             | `(args: string[], context) => Promise<{ stdout, stderr, exitCode }>`                                                                              | `utils.ts`                                                             |
| what a handler sees           | `context.cwd` and `context.fs` (`lstat`, `readlink`; the adapter also uses `readFileBuffer`, `writeFile`, `stat` on the same `fs`)                | `utils.ts`, `just-bash-sandbox-session.ts`                             |
| the filesystem                | in-memory, shared between spawned processes and the host's own file operations                                                                    | `just-bash-sandbox-session.ts` doc comment                             |
| current directory             | `sandbox.bashEnvInstance.getCwd()`                                                                                                                | `just-bash-sandbox-session.ts`                                         |
| what the model is told        | "Use ls to discover files and commands such as cat, grep, sort, awk, and jq to inspect and transform them. Pipes and redirections are supported." | `tool-bash/src/bash-tool.ts` description                               |
| what it cannot do             | writable stdin, ports, network policy, resume by id                                                                                               | `just-bash-sandbox-session.ts`, `just-bash-network-sandbox-session.ts` |
| its builtin set is incomplete | the adapter probes `type realpath` and registers a JavaScript `realpath` when it is missing                                                       | `utils.ts`                                                             |

Three of those rows are the whole feasibility argument. A command handler **is allowed to be
async and can await**, because the `realpath` shim awaits `context.fs.lstat`. A handler gets
**the cwd and the filesystem**, so a command can read files without a tool call. And
**`registerCommand` is the supported patch point**, so a new command needs no fork of the
library.

The last row is the warning: the builtin set is not POSIX-complete, and every gap shows up as a
model action that fails for a reason unrelated to the task. That is exactly what d153's mismatch
table describes for jsmode, one layer out.

## What a shmode extension has to implement

| capability          | mechanism                                                                                                  | status                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------- |
| the tool            | `pi.registerTool` with a raw-shell string parameter; `execute(id, params, signal, onUpdate, ctx)`          | pi: verified                      |
| the sandbox         | one `Sandbox` per pi session, created on first use and stopped on `session_shutdown`                       | pi: verified, just-bash: inferred |
| tool calls          | `ctx.executeTool(name, args, { signal })` from inside a command handler                                    | pi: verified                      |
| the multiplexer     | a `ssh` command: parse argv, map to a tool and its arguments, print the tool's result on stdout            | design below                      |
| read commands       | the emulator's `cat`, `head`, `tail`, `grep`, `awk`, `sort` over the virtual filesystem                    | just-bash: unverified coverage    |
| write commands      | either synced back to the container, or `ssh prd write/…` with the content in argv                         | design below                      |
| output discipline   | `truncateHead`/`truncateTail` around the captured stdout and stderr, the way the built-in `bash` tool does | pi: verified                      |
| errors              | exit code and stderr text; `isError` on the tool result when the script exits non-zero                     | pi: verified                      |
| cancellation        | the tool's `signal` forwarded to `runCommand({ signal })`                                                  | pi: verified, just-bash: inferred |
| nested-call records | automatic: nested calls get `<parent id>/<n>`, `parentToolCallId` events and the bounded record            | pi: verified                      |
| presentation        | `reachesTools` and `prepareLoadout` if the fronted tools should be hidden the way jsmode hides them        | pi: verified                      |

Nothing in that table is a research problem. The open items are all in the command table and the
filesystem policy, which is where the effort actually goes.

## The multiplexer: `ssh prd <tool> <args…>`

The choice of `ssh` is a choice about what the model already knows: a remote host with a policy,
reached by a command whose arguments are the remote command. That is what a tool call is, so the
disguise is honest rather than cute — and it keeps composition, because the tool's output is on
stdout and can feed the next stage:

```sh
ssh prd read --path=docs/architecture.md | head -40
ssh prd grep --pattern='TODO' --path=docs | wc -l
```

Four decisions go into it.

- **argument grammar.** Flags derived from the JSON schema (`--path=`, `--limit=`) are readable but
  lose nested objects and arrays; a JSON escape hatch (`--json '{"edits":[…] }'`) covers what flags
  cannot. The alternative — argv is always JSON — is total but ugly enough that the model will
  avoid the command.
- **discovery.** `ssh prd --help` prints the tool list and `ssh prd <tool> --help` prints a usage
  line generated from that tool's schema. This is the catalog, delivered as a man page rather than
  as a declaration block, and it is the closest thing to jsmode's `searchTools()` that a shell
  can offer.
- **refusal.** Unknown names get `ssh: no such tool: <name>` and exit 127; a tool outside the
  allowlist gets the same. The surface stays closed only if this command is the _only_ way out,
  which means no command handler anywhere may spawn a host process.
- **exit codes.** 0 for success, 1 for a tool that reported failure (its message on stderr), 2 for a
  usage error, 127 for an unknown tool. The tool result is marked `isError` when the script exits
  non-zero, so the model sees a shell failure and the harness sees a failed call.

## The pipeline finding

The two designs differ in one observable way, and it is not a detail.

A pipeline stage cannot ask an earlier stage for a different slice of a file. If `cat` is a
handler that calls the `read` tool, then `cat notes.txt | tail -5` runs `tail` over whatever
`read` returned — which, for a file longer than the read limit, is the head of the file, so the
"tail" is the tail of the head. The same applies to `awk`, to `sed -n '200,240p'`, and to every
second stage. Command-as-tool is therefore **incompatible with pipeline composition** for
anything but short files.

The consequence is that **the virtual filesystem has to hold the truth for reads**, and the tool
bridge is for actions: `ssh prd edit`, `ssh prd write`, and anything that is not expressible as a
file operation. `cat` is not the `read` tool wearing a name; it is the emulator reading a copy,
and the copy's freshness is the design question:

- a **read-only seed** (bind the working tree into the virtual filesystem once, re-seed on
  demand) keeps the rules simple and makes `cat` truthful for the files that exist at seed time;
- a **bidirectional sync** (writes through `ssh prd edit`, or through the emulator, mirrored back)
  is more capable and has the classic two-truths problem: the same file has a real copy in the
  container and a virtual copy in the sandbox, and they drift whenever something writes outside
  the tool set.

The read-only seed is the version that matches jsmode's spirit: the model can read everything,
and nothing changes unless a tool does it.

## What is not verified, and what each answer costs

These are ordered by how much the answer changes the design. Each is hours of work, not weeks.

1. **Builtin coverage.** `type awk`, `type sed`, `type jq`, `type xargs`, `type sort` inside a
   fresh sandbox. The bash tool's description promises `cat`, `grep`, `sort`, `awk` and `jq`; a
   description is not a census, and `sed`, `xargs` and `find` are unnamed.
2. **Does a custom command compose?** `realpath` is registered but never appears in a pipeline, so
   the adapter proves registration and not composition. If a custom command's output cannot feed
   `head`, the `ssh` design loses its main selling point and the multiplexer has to emit whole
   results only.
3. **Can `registerCommand` shadow a builtin of the same name?** If not, `cat` and `grep` keep their
   emulator behaviour and the read path is settled by construction.
4. **Output buffering.** A handler returns whole strings, so `cat big.log | head` builds the entire
   output before `head` sees it. That is fine for correctness and relevant for limits: the
   truncation has to happen on the way into the tool result, not inside the pipeline.
5. **Filesystem seeding.** Whether `Sandbox.create` accepts an initial tree, or the seed is a loop
   of writes, and whether directories must be created first. The adapter writes files but never
   creates a directory tree, which suggests either a permissive `writeFile` or an untested path.
6. **Size and packaging.** Virtual filesystem limits, whether the package runs in Node only, and its
   licence and dependency weight. The 550-repository sweep that preceded this record found no copy
   of `just-bash`, so none of it was checkable then; `vercel-labs/just-bash` is mirrored at
   `7a2a7a57`, which makes these six the first things a prototype confirms rather than assumes.

## Feasibility

| variant                                                          | what it needs                                  | effort | keeps the surface closed            | main risk                                           |
| ---------------------------------------------------------------- | ---------------------------------------------- | ------ | ----------------------------------- | --------------------------------------------------- |
| A. `ssh` only, read-only seed, emulator's own `cat`/`grep`/`awk` | the extension, the multiplexer, a seeding loop | days   | yes, if no handler spawns a process | the model reaches for a builtin that does not exist |
| B. `ssh` plus `cat` routed to the `read` tool                    | the same plus a handler override               | days   | yes                                 | pipelines silently read only the head of a file     |
| C. bidirectional filesystem sync                                 | A plus write-through and conflict handling     | weeks  | yes, with drift                     | two truths for the same file                        |
| D. a real shell in the container                                 | nothing to build                               | none   | no                                  | it is the bash arm, not shmode                      |

A is the version worth building, and B is the version to build _only long enough to demonstrate
the pipeline finding_ — which is a measurement, since the failure is silent.

## The cheapest credible spike

1. Install `just-bash` in a scratch directory and run the census: the exported surface, `type` for
   the commands the model is likely to use, and one pipeline through a registered command.
2. Seed a virtual filesystem from `ctx.cwd` and verify that `cat`, `head -n`, `tail -n`,
   `grep -c` and `awk '{print $1}'` behave, in a pipeline, on a file larger than the output limit.
3. Register `ssh` with a schema-derived `--help` over three tools (`read`, `grep`, `edit`) and a
   JSON escape hatch.
4. Wrap it as a pi tool: raw-source parameter, `signal` forwarding, `truncateHead`, `details`
   carrying the nested calls, `isError` on a non-zero exit.
5. Run it as arm 6 in d153's comparison, beside pymode.

Steps 1 to 3 answer the structural question — whether a fake shell can be both familiar and
closed — and they need no pi integration at all.

## What shmode cannot do

- **Be a security boundary by itself.** The disguise is a catalog device. What keeps the surface
  closed is that no command handler calls into the host, and that is a property of the extension's
  code, reviewable but not enforced by `just-bash`.
- **Hide the copy.** A seeded filesystem contains copies of the files the agent can read. That is
  the same information the `read` tool would have handed over, so it is not a new exposure, but it
  is a new _place_ for it: a model can now `cat` a path it never asked a tool about, if the seed
  included it.
- **Keep `awk` semantics exactly.** Whatever the emulator implements is what the model gets, and
  a script that works in the container's `awk` may not work here. That is jsmode's "not the
  JavaScript I know" one layer out — the risk is the same, the language is different.
- **Stream.** Output arrives as whole strings, so a long-running command's partial output is not
  visible until it returns.

## What this record does not decide

It does not add the extension, does not choose between A and C, and does not claim shmode beats
jsmode. It records what is verified, what is not, and which unanswered question changes the
design — so that the next step is a directory with `npm i just-bash` in it rather than a
debate.
