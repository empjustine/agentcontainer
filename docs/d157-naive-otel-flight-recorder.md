---
id: d157
type: architecture-design
status: draft
title: "d157 — the flight recorder is the supervisor: a standard OTLP front end that dumps its ring on fault"
parent: architecture
depends-on: [d151, d154]
references: [d045, d060, d106, d113, d134, d155]
tags: [observability, otel, flight-recorder, logging, supervisor, portability, draft]
---

# d157 — the flight recorder is the supervisor

A naive deployment has a log stream and nothing else: no collector, no backend,
no time-series store, no sampler. The ideal OpenTelemetry stack answers what is
happening now, and none of its pieces answers what happened in the five minutes
before this failed — the pieces that could are the ones a budget cannot carry.
This record specifies one binary that closes that gap: it accepts standard OTLP,
forwards it when an upstream exists, keeps a bounded tail of everything it saw,
and writes that tail only when something goes wrong. It is written for a generic
host, not for this tree's Linux units.

## Status

Design accepted, unimplemented (`draft`). Nothing here exists: no OTLP producer,
no recorder binary, no ring. The record shape the dump complements is d151's, the
spike it extends is d154's, and the systemd slice of the same problem is d155's —
that slice is one adapter here, not a dependency. The trigger projection table and
the pruning rules are new to this record.

## The gap

Three facts describe the budget deployment. A collector without a backend is a
router. A backend without a per-host agent needs an agent on every host anyway.
A sampler drops exactly the traces a post-mortem asks for. What remains after
those three is a ring buffer with a trigger.

The requirement is not observability. It is **naivety**: one binary, one flag,
`jq`-readable output, no schema to learn, no query language, and no data flow that
a host's operator must reason about. The recorder must be boring enough to start
on a machine nobody administers, and its cost must be stated in one number (the
memory budget) rather than in a topology.

## Scope

It is: an OTLP receiver for traces and logs, an optional OTLP exporter in front of
it, a bounded ring keyed by correlation id, a projection written on fault, and a
supervisor for one child process.

It is not: a backend (no index, no retention policy, no query), a metrics store
(metrics forward and are never retained), a sampling decision point, a context
propagating agent, or a per-language SDK.

## Standard, defined

The wire is OTLP and the configuration is an `otelcol` config file. The binary is
a dist assembled with `otelcol-builder`, because the ring is a component and no
upstream distribution ships one. `standard` therefore means _any SDK exports to
it unchanged and any collector accepts what it forwards_, never _byte-identical to
`otelcol-contrib`_. The degraded answer stays available and is worth documenting
as such: stock contrib with a `filter` processor and a `file` exporter gives
structured output on warnings and errors, and no history at all.

## The recorder is the supervisor, because a crash has no OTLP field

No OTLP record carries an exit code, a terminating signal, or a statement that the
process ended. A collector that did not spawn the process cannot tell a crash from
a clean shutdown, and cannot tell either from a network partition. Every design
that appears to solve this without being the parent polls a supervisor's API or
reads silence as evidence; both are guesses, and a guess in the one place the
output must be trusted.

The primary topology is therefore the exec chain:

```sh
otel-flightrecorder --exec --dump-dir /var/tmp/dumps -- ./service --flags
```

The recorder binds an OTLP receiver on a per-run Unix socket, exports the endpoint
in the child's environment, and reaps the child itself. It is then the only process
that holds three things at once: the exit status, the terminating signal, and the
ring that must be written before either is acted on.

Nothing in the design assumes a supervisor. The adapters, each optional and each
about ten lines of shell:

| environment         | who knows the exit           | adapter                                        |
| ------------------- | ---------------------------- | ---------------------------------------------- |
| recorder as parent  | the recorder                 | none — the primary topology                    |
| runit               | `./finish` (status in argv)  | `finish` pokes `USR1` then `TERM`              |
| s6                  | `s6-supervise` notification  | a notification listener on the `finish` script |
| systemd             | the unit, not the child      | `OnFailure=`, `ExecStopPost=` (d155)           |
| container (PID 1)   | the recorder as entrypoint   | none — the primary topology again              |
| container (sidecar) | nobody                       | degraded: severity-scoped dumps only           |
| a bare shell        | `$?` of the foreground child | `cmd                                           |     | otel-flightrecorder --dump-last` |

The sidecar row is the honest failure: a sibling container in a shared pod has no
fork hook and no exit status, so it keeps the ring and the severity triggers and
loses the crash mirror. The design degrades rather than pretends.

## A signal into the recorder is a dump trigger

`SIGINT`, `SIGTERM`, `SIGQUIT` and `SIGHUP` all mean the same thing to the
recorder: write everything, then forward the signal to the child, then run the
ordinary exit path. The dump precedes the forward, because a shutdown that stops
the recorder first makes the ring unrepresentable.

The write is bounded (two seconds by default) so an operator's `Ctrl-C` stays
responsive. A dump that hits the bound closes its file and records `truncated:
true` in the header, and the remainder is lost — a stated loss beats a hung
process.

`SIGUSR1` dumps without stopping. That is the operator knob without a knob: the
ring can be observed on a healthy process by sending one signal, and no
configuration file is needed to allow it.

A trigger arriving during a dump coalesces into one dump per generation. A second
trigger after a dump has begun requests the _next_ generation, so a crash during a
dump does not re-print the tail it already wrote.

The recorder's own death is best-effort: a Go `defer` covers a returned `main` and
a `SIGSEGV` handler covers a fault in the recorder, while `SIGKILL` and the OOM
killer cover nothing. That is the same ceiling d154 recorded.

## The dump is a projection, and the trigger chooses it

Dumping the whole ring is the naive answer and it fails twice: a thousand slots
times a per-slot quota is unreadable, and the projection is the only place where
"which records are evidence" can be decided cheaper than in a query language. So
each trigger declares a **scope** (one correlation id, or the whole table) and a
**severity band** (`keep_min` .. `keep_max`), in one table that is data rather than
a branch per case.

| trigger                                          | scope               | band (default) | prunes         |
| ------------------------------------------------ | ------------------- | -------------- | -------------- |
| child exited non-zero, or died by signal         | every slot + global | `0..24`        | yes            |
| recorder received `INT`, `TERM`, `QUIT`, `HUP`   | every slot + global | `0..24`        | yes            |
| recorder received `USR1`                         | every slot + global | `0..24`        | no             |
| record at `severityNumber >= 13`, carrying an id | that id's slot      | `0..24`        | yes            |
| record at `severityNumber >= 13`, no id          | global ring         | `5..24`        | yes            |
| app-declared fault, scope `id`                   | that id's slot      | `0..13`        | yes            |
| app-declared fault, scope `all`                  | every slot + global | `0..13`        | yes            |
| clean exit, no warning                           | none                | —              | ring discarded |

The band is where "flush everything up to a severity" gets its exact meaning. An
app-wide fault — a correlation id that arrives without its context, say — makes
the quiet records _the_ evidence, and its own warning line is only the reason to
look, so its band keeps everything up to and including that warning (`0..13`). A
bare global warning keeps `5..24`, because trace-level chatter in a global ring is
noise with no id to attribute it to. `keep_max` exists so that a fault late in a
run does not spill a whole error storm into the same file.

A band can only narrow what the ring retains; it never widens a trigger into a
larger scope, and it never selects records the trigger did not scope.

### The app declares its own faults

The recorder must invent no heuristics for "this was serious in a way no severity
number expresses". A log record or span event may carry `recorder.dump` as `all`,
`id` or `none`, and optionally `recorder.keep_min`/`recorder.keep_max`. The
knowledge exists at the call site; the recorder only needs to read it. This is the
same reasoning that makes `severityNumber` a number (d151): the vocabulary belongs
to the producer, and the recorder holds it to one table.

## Pruning: a dumped record is not printed twice

The ring feeds two outputs, the stream and the dump, and the rules that keep that
honest are five:

1. While a record is retained, the dump is the only path that writes it a second
   time.
2. After a dump, its records leave the ring, so a later dump of the same slot does
   not re-print them. Reclaiming quota is the side effect that matters on a
   long-lived process, and not repeating the tail is the one that matters on a
   short one.
3. Pruning happens after the dump is durable and never before. A failed write that
   pruned first destroyed the evidence twice.
4. The stream is a separate question. A record already relayed live is duplicated
   by the dump, so the default is to prune its stream copy too, and the ordinary
   log stays as short as the dump made it.
5. Rate-limiting transports are the exception: where the environment already
   prunes bursts (`journald`'s per-service limit, d155), the record stays in the
   stream. There the dump may be partially suppressed by the same limiter, and the
   stream line is already the copy that survived.

The stream prune belongs to the environment adapter, not to the trigger, because
whether a second copy is a duplicate or a safety net is a property of the
transport.

Pruning is not filtering. d045 and d060 forbid a producer that discards a record
because of its level; a prune discards a record because the same record appears
elsewhere, and a dump never omits a severity that its trigger's band includes.
The one deliberate loss is elsewhere and is stated plainly below.

## Stream live, or hold and vanish

Two emission modes, one config value:

- **`live`** relays every record as it arrives and keeps the ring as a copy. The
  ordinary log stays complete, a dump duplicates part of it, and pruning applies
  to the ring and (per rule 4) to the stream. This is the default where a human
  may be watching.
- **`quiet`** holds everything and writes only on a trigger: the `chronic` shape
  at the size of a whole application. This is the default for a batch tool whose
  successful runs should say nothing.

`quiet` contains the recorder's one real drop, and the record states it rather
than hiding it behind a level name: **a clean run's quiet records are never
written.** That is the trade the mode exists to make — hold everything, spend
attention only on a failure — and it is not a severity filter, because the
severity never decides; the outcome does.

## Retention mechanics

The parts that are not obvious, each a finding rather than an implementation note:

- **Retain serialized OTLP, never pdata.** `ptrace.Traces` and `plogs.Logs` belong
  to the caller and are pooled once `Consume*` returns; a ring holding those
  objects holds freed memory. The ring element is the marshalled export request, and
  a dump decodes it back.
- **Key slots by `trace_id`, interned to a slot index.** It is already a sixteen-
  byte correlation id, so d154's fixed-slot table transfers with no adapter, the
  clock hand resets a slot on reuse, and the hot path stores no id string.
- **One global ring** holds what has no id: startup, configuration, and the warning
  that fires before any session exists.
- **Two budgets, in bytes.** `total_bytes` is the soft ring budget and the
  collector's `memory_limiter` is the hard process budget; a span costs roughly a
  few hundred bytes serialized, so a 32 MiB default is a few tens of thousands of
  spans and must be stated in the documentation rather than discovered.
- **Chain position is load-bearing.** The recorder sits after `memory_limiter`, and
  before `batch` and before any processor that drops — `tail_sampling` in
  particular holds spans for its decision window and then deletes whole traces, and
  a deleted trace is exactly what a post-mortem wants.
- **The recorder never fails a `Consume`.** A recorder on the OTLP path that can
  reject data is a new outage mode in front of the collector it was meant to
  observe; a full ring evicts, and only a byte budget stops it.

## Where a dump lands, with no supervisor assumed

`--dump-dir` writes one file per event, named for its wall clock, its reason and
its generation, with a header record carrying the trigger, the band, and the
per-slot `kept N, dropped M`. Rotation keeps the most recent files and deletes the
rest, so the disk cost is a number again.

The environment decides only where the directory is: `StateDirectory=` under
systemd, a volume under a container, a plain path under runit, `--dump-to stderr`
on a terminal. When no directory is writable the dump goes to stderr and the
header says so; a recorder that fails to record must still say that it failed.

## What is OTel-shaped and what is not

Logs already carry OpenTelemetry's `severity_number`, so `13` is the same
threshold here as in a d151 record and the same `jq` predicate filters both.
Spans carry no severity, so the span-side predicate is `status.code = ERROR` or an
`exception` event; both are in the trigger table.

Time is the one conversion point: OTLP counts nanoseconds, a d151 record counts
epoch milliseconds. A dump that mixes them reads as correct and is not.

An upstream is optional. With `otlp/upstream` configured, the recorder fronts a
collector and the pass-through is never gated or delayed by the ring. Without it,
the recorder is the whole stack: point `OTEL_EXPORTER_OTLP_ENDPOINT` at it, run
nothing else, and the pre-crash tail still exists. That zero-infrastructure
configuration is the point of the exercise.

## Requirements

- **R1 — no supervisor assumed.** The exec chain is the primary topology; every
  other environment is an adapter, and none is required for the ring, the
  triggers or the dump.
- **R2 — every terminating signal dumps.** `INT`, `TERM`, `QUIT` and `HUP` dump
  before the signal is forwarded.
- **R3 — `USR1` dumps without stopping.**
- **R4 — one dump per generation.** Overlapping triggers coalesce, and a trigger
  during a dump requests the next generation.
- **R5 — a foreign failure dumps everything.** Non-zero exit and death by signal
  reach every slot and the global ring.
- **R6 — clean means silent.** Exit 0 with no warning writes nothing and discards
  the ring.
- **R7 — scoped triggers stay scoped.** An id-scoped trigger dumps one slot and
  never the table.
- **R8 — the projection is data.** Triggers, scopes and bands live in one table;
  a producer declares its own fault through attributes, and the recorder invents
  no heuristic.
- **R9 — a band narrows only.** `keep_min`/`keep_max` select within a trigger's
  scope and can never widen retention.
- **R10 — prune after durability.** A dumped record leaves the ring after its
  write completed, and a failed write leaves the ring intact.
- **R11 — the stream prune is an adapter property.** A rate-limiting transport
  keeps the record.
- **R12 — the ring holds bytes.** Serialized OTLP, never pooled pdata.
- **R13 — pass-through is never gated.** The upstream exporter never waits on the
  ring, and the ring never waits on the upstream.
- **R14 — a bounded write.** The dump has a time budget, and a hit budget is
  recorded in the header rather than extending the shutdown.
- **R15 — the dump is OTLP.** A dump is decodable by OTel tooling and readable by
  `jq`; no bespoke format is introduced.

## Alternatives rejected

- **systemd and journald as the trigger.** The assumption this record was revised
  to drop: most hosts, containers and shells have neither, and the exec chain
  answers the same question on all of them.
- **Inferring a crash from silence.** A quiet failure and a quiet success are the
  same absence.
- **An in-process SDK per language.** Fifteen copies of a ring, in the languages
  the hosts happen to use, and the record is not the SDK's.
- **Dumping the whole ring on every trigger.** Unreadable, and the noise is the
  wrong kind: it hides the tail it was meant to show.
- **Pruning before the write completes.** Deletes the evidence on the one path
  where the disk is full.
- **Prune nowhere, duplicate everywhere.** The cheap version, and it makes the
  dump worthless on the run that matters, where the log already carried the same
  lines.
- **Stock contrib with `filter` + `file` as the answer.** Structure on error, no
  history before the error; useful as a fallback, not as the design.
- **Metrics retention.** A retained timeseries is a database, and a flight
  recorder is a file.

## Open questions

- Windows has console control events rather than signals; the mapping is untested
  and the design must not claim it by analogy.
- The sidecar case has no exit status at all, so its crash mirror is a `USR1` from
  a wrapper that does have one.
- A ring in the Go heap dies with `SIGKILL` and the OOM killer. Whether the
  service case needs an fd-backed ring in `tmpfs` (d154's ceiling) is unsettled.
- The default budgets — ring bytes, per-slot bytes, dump files kept — are
  unmeasured, and the numbers above are placeholders chosen to be stated rather
  than discovered.
- Feeding a tree's existing hand-rolled JSONL into the recorder needs a `filelog`
  receiver with a `json` operator; whether that is a supported mode or a
  documented workaround is open.
