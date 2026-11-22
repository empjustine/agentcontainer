---
id: d225
type: architecture-design
status: active
title: "d225 — a failing entry point throws an error carrying its exit code"
parent: architecture
depends-on: [d045, d151]
references: [d059, d070]
tags: ["cli", "exit-codes", "errors", "entry-points", "cleanup"]
---

# d225 — a failing entry point throws an error carrying its exit code

This record fixes one shape for every Node and Python entry point in this tree:
a failure is a thrown error with an `exitCode` property, and only the top-level
handler turns it into a process status. The reader is anyone writing a launcher,
a generator or a verifier that has a failure path.

## Problem

`coding-agent/run.mjs` carried a `die(refusal)` helper that logged a line and
called `process.exit(code)` from deep inside the launch flow. The same shape
appeared as bare `process.exit(n)` at every refusal in the generators and
builders. It reads like structured refusal handling, and it is a GOTO: the
process tears down wherever the call sits, so everything between that point and
the top of the program is skipped.

Three costs follow, and none of them is visible at the call site:

- **Cleanup does not run.** A `finally` that removes a run's temporary output
  dir, restores a file, or stops a backend is unreachable on exactly the paths
  that need it. Adding cleanup later silently fails the first time a refusal
  fires above it.
- **Refusals are untestable as values.** A refusal could not be asserted by
  catching it; the only way to observe one was to run the whole process against
  a stub and read its status. The exit code — part of the CLI contract wrappers
  and docs quote — was therefore only checkable from outside.
- **The log-then-exit pair was copied per site.** Each `die` call had to
  remember to log exactly once with the right fields, and the top-level catch had
  to special-case the same type anyway.

## Decision

**R1 — A failure that must stop an entry point is a thrown `Error` carrying its
exit code under `Symbol.for("process.exitCode")`, thrown by the step that
decided it.** A gate or check that generates its own refusal throws it; it does
not hand it back for a caller to throw, which would split one decision — what
failed and whether to stop — across two places (the launcher's `credentialGate`
and `requireMountSources` are the worked example; the `artifactGate` this
record also named is retired by docs/d227). A predicate that answers a question
still returns data — `credentialWarnings` lists the files its reporter warns
about, `canonicalViolations` lists what the verifier prints — and the guard that
decides to stop generates the failure (`requireMountSources` in the launcher).
Construct it with
`Object.assign(new Error(message), { [Symbol.for("process.exitCode")]: code })`
— `failure(message, code, fields)` in each unit's `lib/` (plus any structured
fields the log line needs). The code travels on the value; the value travels up
the ordinary call stack. The key is a **global-registry symbol**, not the string
`"exitCode"`: a string collides with any error that happens to carry that word
(a `child_process` error, a library's field), and the per-folder `lib/` copies
(docs/d113) still resolve one key through `Symbol.for` without sharing an
import.

**R2 — No helper calls `process.exit`.** Not a `die`, not a local `fail`
that returns the error for its caller to throw — a helper that owns a stop
throws its failure (`refresh-models-dev.mjs`'s `fail`). `process.exit` exists
nowhere below the top-level handler, and the handler does not call it either: it
sets `process.exitCode` and returns, so the runtime tears the process down
normally.

**R3 — The top-level handler of a `main` logs once and sets the status.** In
Node that is the `import.meta.main` block, in Python the
`if __name__ == "__main__":` block. It reads the code with `exitCodeOf(error)`,
logs `error.message` with the error's fields (docs/d045), sets
`process.exitCode` (or `sys.exit(code)` after the handler returns), and never
rethrows. An error that carries no code is an unexpected throw and is logged
with its stack at status 1.

**R4 — Cleanup is a `finally`, and therefore covers every refusal.** A temporary
output dir, a staged file, a started backend: each is released in the `finally`
of the block that created it. This rule is what R2 buys; a program that sets
`exitCode` but keeps its cleanup after the last refusal point has the syntax
without the property.

**R5 — A successful run's non-zero child status is also `exitCode`.** When the
job of an entry point is to run a child or a service and hand back its status
(the launcher's container exit code), assign it to `process.exitCode` rather
than exiting, so the caller still unwinds.

**R6 — Exit numbers stay contract.** The codes themselves (90–94 in the agent
launcher, 64 for usage, 91 for a missing backend, and so on) do not move in
this change; they move from the `exit` argument into the error property.

**Scope.** Node entry points (`main` behind `import.meta.main`) in this tree.
Two neighbours are already compliant in mechanism and are not converted by this
record:

- **Shell tools** keep their `log_die`: `sh` has no unwinding, so the helper is
  the language's own stop rather than a GOTO past a cleanup path.
- **Python** `sys.exit`/`raise SystemExit(code)` raises an exception, which
  unwinds through `finally` exactly like the required throw; a Python `die`
  helper is therefore R1's equivalent, not the Node anti-pattern. The binding
  there is the mechanism, not the spelling: the code rides an exception and the
  `__main__` block sets the status — never `os._exit`.

## Consequences

- `coding-agent/lib/failure.mjs` and `llm-local-inference/lib/failure.mjs` hold
  the symbol, the one-line constructor (`failure(message, exitCode, fields)`)
  and the reader (`exitCodeOf(error)`); an entry point that needs a refusal
  reads as `throw failure("...", 91, { backend })`.
- The launcher's refusal checks become plain `throw`s in `main` and the gates
  they call; the whole launch is one ordinary call stack again, and a test can
  assert `exitCode` by catching the value.
- `coding-agent/generate.mjs` moves its per-run `rmSync(outDir)` into a
  `finally`, so a failed generator no longer leaves its staging directory
  behind — the first cleanup this rule protects.
- The launcher's refusal guards (`resolveDirectories`, `requireBackend`,
  `credentialGate`, `requireMountSources`; the retired `artifactGate` was one
  of them until docs/d227) throw the failure they
  generated, so `main` reads as a sequence of statements instead of a chain of
  `if (refusal) throw refusal`; a test asserts the code by catching the value.
  The same pass moved the report-shaped steps out of `main` too
  (`ensureHostState`, `warnCredentialFiles`, `warnMissingOpencodeConfig`) and
  the run-and-map step into `launchWorkload`. A guard that a caller must
  remember to turn into a stop has a weaker contract than one that stops:
  `lib/workload-runtime.mjs` no longer exports a "missing mounts" predicate for
  the launcher to interpret.
- Guard-owned stops pay for themselves three times, which is why this is a
  requirement and not a style note. The contract lives beside the predicate
  (`@throws` on the guard, not prose at the call site explaining that this
  `if` interrupts the flow); a refusal's stack trace names the guard that
  stopped instead of a `throw` line in `main`; and comments that narrated the
  interruption have nothing left to say, so they are promoted to the guard's
  JSDoc or deleted (AGENTS.md's WHY-not-HOW test). The caller-side comments
  that remain in `main` describe sequencing, not control flow.
- A verdict that is not an internal failure stays a status value:
  `check-canonical-artifacts.mjs` prints its violations and sets
  `process.exitCode = 1` (R5), because the violations are the output and the
  code is what a spawner reads.

## Alternatives rejected

- **Keep `die` and add a `process.on("exit")` cleanup.** The exit handler runs
  too late to see intermediate state and cannot await anything; it also makes
  the cleanup invisible at the place that owns the resource.
- **Catch the refusal at every call site instead of the top.** That re-creates
  the per-site log-and-transfer repetition the helper existed to hide, in a
  larger form.
- **Return a status from every function instead of throwing.** It works for a
  pure pipeline, but the refusal checkers here already return their refusal and
  are composed into a launch that cannot proceed — a return value threaded
  through every caller says less than a throw and costs more code.
- **Shell parity.** `sh` has no `finally`; a `log_die` there is the only way to
  stop, so requiring the same shape would mean a separate record and no
  unwinding to gain.
