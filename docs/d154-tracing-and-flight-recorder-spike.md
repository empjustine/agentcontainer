---
id: d154
type: architecture-design
status: done
title: "d154 — spike: free tracing per runtime, and a flight recorder this tree could own"
parent: architecture
depends-on: [d045, d060, d151]
references: [d102, d106, d113, d120, d134]
tags: [logging, tracing, observability, spike, ring-buffer, journald, otel]
---

# d154 — spike: free tracing per runtime, and a flight recorder this tree could own

The tree logs one structured record per line and filters nothing (d045, d060),
and d151 gave the record a sortable shape. The question this spike asks is what
a `trace everything` surface would cost on top of that: whether the shell's
`set -x` has an equivalent in the other runtimes here, where a
silence-on-success recorder sits, and where the line against OpenTelemetry
falls. The requirements it ends with are not in force — no recorder exists in
the tree.

## Status

Investigation finished; nothing implemented. The findings are readings of each
runtime's own contract plus this tree's call-graph arithmetic, not measurements.
Open: the durable dump target for a serviced process (d155 owns estige's), the
POSIX `sh` trace path, and the projection numbers a dump would need.

## What this record decides

- The shell's free tracing is a property of the shell. The nearest equivalent in
  a program is a profiler, so the seam that covers every language here is the
  process boundary, not the runtime.
- The recorder's home is the exec chain, because that is where the failure
  decision is made, and d060's no-producer-filtering rule is what makes it
  possible at all.
- The buffer is a fixed-slot table keyed by an interned correlation id — not K
  hashed buckets, and not a one-ring-per-id map.
- It is not OpenTelemetry, and the line between them is context propagation.

## The shell's tracing is a property of the interpreter

`set -x` costs one `printf` per command because the shell already walks every
command as a node and the trace rides a path it takes anyway. `BASH_XTRACEFD`
sends that trace to a descriptor of the script's choosing, so the detail never
touches the log stream:

```sh
exec {fd}>>"$trace"; BASH_XTRACEFD=$fd; set -x
```

No other runtime here has that seam, because the enumerable unit in a program
is a call, and enumerating calls is a profiler. The nearest seam per runtime:

| runtime    | nearest seam                                           | cost                           | what it names                                        |
| ---------- | ------------------------------------------------------ | ------------------------------ | ---------------------------------------------------- |
| Go         | `runtime/trace` (stdlib flight recorder into a buffer) | ~1-2% CPU, no call-site change | goroutines, syscalls, GC — never what the code meant |
| Go         | `GODEBUG`, `runtime/metrics`                           | negligible                     | runtime counters, not events                         |
| Node       | `node:diagnostics_channel`                             | near-zero                      | only what somebody instrumented                      |
| Node       | `async_hooks`                                          | large, per async resource      | promise and async boundaries                         |
| Node       | `--cpu-prof`, `--heap-prof`, `process.report`          | out-of-process snapshot        | samples, and a report on a fatal signal only         |
| Python     | `sys.monitoring` (3.12+, PEP 669)                      | modest                         | calls, lines, branches                               |
| Python     | `sys.settrace`                                         | 50-100x                        | the same calls, at a cost nothing can carry          |
| Python     | `logging.handlers.MemoryHandler(capacity, flushLevel)` | writes only                    | _is_ the dump-on-failure recorder                    |
| any binary | `strace -f -ttt -e trace=…`, eBPF                      | high syscall volume, no names  | sockets, files, processes                            |
| any binary | `podman events`, journald container fields             | none                           | container lifecycle                                  |

`BASH_XTRACEFD` also has a narrow reach here: twenty shell scripts, one of them
bash (`vm-bench.sh`). POSIX `sh` can only trace to stderr, which is where the
logs are — and an xtrace write prefixes each JSONL line with `+ `, so tracing a
logging script on stderr destroys the records it was meant to explain. Nineteen
of twenty scripts therefore have no free trace while they log.

## The boundary is the free seam, and the tree has three of them

`chronic` is the shape: run the command, buffer its output, say nothing on exit
0, print everything on failure. It works because only a parent sees `waitpid`. A
pipeline filter sees EOF, which cannot tell success from failure from `SIGKILL`
from a closed descriptor.

`run()` in `coding-agent/build.mjs`, `llm-local-inference/build.mjs` and
`estige/build.mjs` is already that parent: it captures a child's stdout and
stderr line by line with `cmd` and the descriptor attached (d151). What it lacks
is the decision — it relays every line as it arrives, so nothing is quiet and
nothing is held back for a dump.

d060 is the precondition rather than a neighbour. A parent can only record what
a child emits, and a producer that pruned its own `debug` lines behind
`--verbose` would leave the parent blind exactly when the run goes wrong. The
rule that forbids producer-side filtering is what makes an always-on recorder
possible; a tree of `--verbose` tools cannot have one.

## Silence on success, everything on failure

Three triggers, and no others: a non-zero exit, death by signal, and the first
record at `severityNumber >= 13`. The third is `MemoryHandler`'s `flushLevel`
under another name, and d151's numeric bands are what make it a comparison
rather than a word match. A run that exits 0 without a warning writes nothing.

That is d060's no-filtering rule moved in time: retain everything, emit on need.
No flag, no `--verbose` (retired), no `LOG_LEVEL`.

The consequence to accept with it: a successful run that warns is verbose, so
`quiet` means `clean`, not `routine`.

## Where the recorder sits

Placement follows the failure decision, and the three placements do not
collapse into one:

- **Batch and build.** The parent records (the `run()` family). Language
  independent, needs no kernel change, and covers the shell scripts, python
  scripts and every child they spawn at once.
- **Serviced process.** estige under systemd has no parent of this tree's:
  systemd is the exec chain, and `Restart=on-failure` hides the exit status in
  the journal. The buffer must live in the process, and the dump must be durable
  before the process dies.
- **Nested chains.** `build.mjs` spawns `podman image build`, which runs `go`.
  Every level sees the failure, so either only the outermost dumps, or a child
  marks its ring dumped and the parent relays rather than re-prints. Without
  that, output amplifies by nesting depth.

## The buffer shape

- **K hashed buckets are unworkable.** A shared bucket has no owner, so no event
  marks the moment to clear it; recovering ownership inside the bucket needs
  refcounts, which is a map arrived at the hard way.
- **One ring of records carrying an interned smallint** is the right memory
  layout and loses fair share: a verbose id evicts the quiet ones, and the
  masking this was meant to prevent comes back.
- **Fixed slots keyed by an interned id, each with its own quota ring, gives
  both.** Flat `K×N` array, fair share by construction, and reset defined as slot
  _reuse_ — a round-robin hand clears a slot when a new id arrives at a full
  table. The slot is the id, so the hot path stores no id string and no index.
- **One plain global ring** for records that carry no id: startup, configuration,
  and the warning that fires before a session exists.
- **Truncation is per slot, and belongs in the dump header once.** `id ab12 kept
  64, dropped 1200` is the difference between a sample and a lie; a global
  `dropped 12000` is noise, and the count is worth nothing beyond `> 0`.
- **Where the process owns the lifecycle, reset is a protocol event.** estige's
  per-trace-id registry is capped at 1024 entries (`maxExchangeSessions`,
  `modee.go`, d081's TTL'd registry), so slots sized to it and cleared on close
  or expiry need no heuristic. A batch tool has no such event, so the hand is
  the reset.
- **Capture is bounded, and so is the dump.** 1024 slots times 64 records is
  65 000 lines: unreadable, and past journald's rate limit (d155). The dump is a
  projection — live at failure, warned, or the last M slots touched — never the
  whole table.
- **The dump is not a third format.** It is the same d151 record, held back, so
  there is no decoder to write, and d151's `ts` is what lets a dump be sorted
  after the fact.

## What a text recorder cannot inherit from JFR

The Java Flight Recorder survives its own crash because a native recorder thread
lives outside the failing runtime, a preallocated per-thread ring writes without
allocating, an event is a typed struct copied into the ring, and the dump is a
binary file decoded offline. The text version keeps the ring and the dump; it
loses the crash survival, because `SIGKILL` and the OOM killer take the buffer
with the process, and it loses the zero-allocation path, because an array of
objects is still a heap and still a GC.

The honest ceiling: a failure that exits gets a dump, a hard kill gets nothing.
That is the right ceiling for a short-lived build tool and the wrong one for a
long-lived service, which is why the serviced case also needs an artefact on
disk rather than only a ring in memory.

## The line against OpenTelemetry

What costs in OpenTelemetry is not spans. It is propagation: a `traceparent`
carried into a child's environment, sampling decisions, exporters and a
collector, semantic conventions, and a context object threaded through every
call. A one-shot build tool has no cross-process trace to stitch, because the
JSONL stream already is the trace — ordered by `ts`, keyed by `tool` and `cmd`.
Nested timing inside one process is a stack, not a format.

The threshold, recorded so it is not crossed by accident: **putting a
`traceparent` into a child's environment.** Past that point the tree needs
OpenTelemetry's problem set solved, and the right move is the standard rather
than a homebrew of it; the recorder would then be the sampling decision point,
not the replacement. No consumer in this tree joins two processes' records into
one trace, so the recommendation is no propagation.

## Requirements

- **R1 — the decision is the exit status.** A recorder decides from the child's
  exit code or terminating signal, never from stream content alone.
- **R2 — the child does not know.** A recorded child emits every level
  unconditionally (d060) and never learns that a recorder exists.
- **R3 — clean means silent.** A run that exits 0 with no warning writes nothing.
- **R4 — three triggers.** Dump on non-zero exit, on a terminating signal, and on
  the first record at `severityNumber >= 13`.
- **R5 — fair share is structural.** Retention is per correlation id in fixed
  slots; no id can evict another id below its slot quota.
- **R6 — the ring keeps its tail.** What survives is the most recent records per
  slot, because a post-mortem reads the end of the story.
- **R7 — truncation is stated once.** Each truncated slot is named in the dump
  header; the count appears nowhere else.
- **R8 — the dump is the record.** Output uses the d151 shape and introduces no
  field the stream does not already carry.
- **R9 — a serviced dump outlives the process.** Where no parent holds a buffer,
  the dump lands on a durable target before exit.
- **R10 — batch recording lives outside the kernels.** The twelve emitters are
  wrapped, not extended, so a recorder is one implementation rather than twelve.

## Open questions

- Nineteen of twenty shell scripts are POSIX `sh`, where tracing and logging
  share stderr. Porting one script to bash for the trace is a per-script
  judgement this spike does not make.
- A recorder on `PATH` is a shared thing every unit would reach for, which is what
  d113's copy-unit rule forbids. Whether it is one repo-root script or one per
  unit is unsettled.
- Interning costs one small-map probe per request in three languages, in three
  copies.
- The projection numbers (slots, records per slot, slots dumped) are unmeasured.

## Alternatives rejected

- **K hashed buckets.** No owner, therefore no reset event, therefore a map-
  shaped recovery inside the bucket.
- **One ring with interned ids and no slots.** Simplest layout, and the verbose
  id masks the quiet one — the failure the slots exist to prevent.
- **A buffer inside each of the twelve kernels.** Twelve copies of a buffer
  (d113), no fair share, and shell has no memory to hold one.
- **Adopt the OpenTelemetry SDK now.** It solves propagation, sampling and
  export, and this tree has none of those problems; the cost is a runtime
  dependency, a collector to operate and a semantic convention to police,
  answering a question nobody here asks.
- **A binary JFR clone.** A file format, a schema and a decoder, for a tree whose
  consumers are `jq` filters and a terminal.
- **`set -x` on stderr as the trace.** It prefixes every JSONL line and destroys
  the stream it was meant to explain.

## Prior art carried in this record

`chronic` (silence on success), python's `MemoryHandler` (capacity ring with a
flush level), the Java Flight Recorder (ring buffer, dump, offline decode), and
`runtime/trace` (a real flight recorder that ships in a standard library). The
tree already carries the correlated-identifier vocabulary that keys the slots in
d106, and the journal framing a service's dump lands in is d155's.
