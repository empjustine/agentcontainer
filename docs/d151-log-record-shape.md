---
id: d151
type: architecture-design
status: active
title: "d151 — the log record leads with the event, stamps epoch milliseconds, and names its severity by number"
parent: architecture
depends-on: [d045, d060]
references: [d113, d134, d106]
tags: [logging, observability, jsonl, otel, contracts]
---

# d151 — the log record leads with the event

Every structured log line this tree emits changes shape: `msg` moves to the
front and the fields the kernel fills in move to the back, `ts` becomes Unix
epoch milliseconds as a number, the `level` word becomes OpenTelemetry's
`severityNumber`, a captured command line becomes the record's `msg`, and the
`stream` field becomes a file descriptor number. Everything else d045 decided —
static labels, no producer-side filtering, one stream selector, two formats —
stays in force, and this record does not restate it. A reader of a log stream
and a writer of one of the twelve emitters read this record to know which fields
exist.

## Status

Active. The shape landed in every emitter at once: the three full `log.mjs`
kernels, the four folder-root `pi-*` kernels, `log.sh` and
`llm-local-inference/lib/log.sh`, `log.py`, the inline kernel in
`estige/build.mjs`, and the inline python emitter in
`llm-local-inference/fetch-model-cards.sh`. It could not land unit by unit:
one reader's `jq` filter sees a merged stream, so half the tree in a number and
half in a word is a filter that silently drops records.

## Problem

A record cost more to read than it returned.

`ts` was an ISO-8601 string at second precision — `"2026-11-08T19:57:19Z"`.
Two records inside one second compared equal, so the field could not order the
stream it was there to order, and a consumer that wanted to sort or measure a
gap had to parse a formatted date where it wanted a number. The tree's own
neighbours had already settled this: Squid's `%ts.%03tu` is epoch seconds with
milliseconds (d106, d134).

`"level": "info"` is a lowercase word. It can be matched and it cannot be
compared, and it has no vocabulary behind it — nothing but convention stopped a
second kernel from spelling it `INFO`, which `== "info"` would miss. A
category with published numeric bands would make the field load-bearing
instead of decorative.

The command-output records were the worst of the three. Every line of a child
process arrived as `"msg": "command output"` with the actual line in a field
named `line`, so the constant repeated down the stream and the only specific
value sat one level down, under a name that said what it was rather than whose
it was. `cmd` was the bare executable, which made every podman subcommand's
lines indistinguishable, and `stream` was the word `"stdout"`.

`ts`, `severityNumber` and `tool` also led every line. Nothing in them varies
from record to record except the stamp, and the one field a reader cannot
guess — the message — was the last thing on the line, so a narrow terminal or
a `head -1` cut the event before the bookkeeping.

## Decision

### The event leads and the kernel's fields trail it

Every kernel emits `msg` first, then the fields its call site passed, then the
three it fills in itself: `ts`, `severityNumber`, `tool`. Object key order is
insertion order in both Node and python, and the shell kernels write the object
by hand, so the order belongs to the emitter and survives being written and
re-read. `logfmt` follows the same order: `msg="…" target=… stream=1 ts=…
severityNumber=9 tool=estige/build`.

The reason is crude inspection. A person in a terminal reads these streams far
more often than a program does, and whatever is first is what gets seen; what
gets seen should be the only part of the line that varies. The kernel's three
are the same shape on every line, so a reader that wants them is a reader that
is parsing the line anyway.

The order also settles precedence. The kernel's fields are last and nothing is
spread over them, so a call site that passes a field named `ts` or `tool`
cannot replace the kernel's value — before this change it could, silently.

### `ts` is Unix epoch milliseconds, as a number

`Date.now()` in the javascript kernels, `int(time.time() * 1000)` in python, and
`date +%s%3N` in shell. A number sorts numerically and needs no parser, and
milliseconds are the widest resolution that fits a JSON number and a JavaScript
integer — nothing here logs faster than a millisecond, so the extra digits of
microseconds would be zeros.

`date +%s%3N` is GNU coreutils only; BusyBox and toybox print the literal
`%3N` instead of a fraction. `log.sh` therefore validates the result and, when
it is not all digits, falls back to whole seconds widened to milliseconds. A
coarser clock is survivable. Two units in one stream are not.

### `level` is `severityNumber`, an OpenTelemetry SeverityNumber

| level function | `severityNumber` | band                     |
| -------------- | ---------------- | ------------------------ |
| `logTrace`     | 1                | TRACE, 1-4               |
| `logDebug`     | 5                | DEBUG, 5-8               |
| `logInfo`      | 9                | INFO, 9-12               |
| `logWarn`      | 13               | WARN, 13-16              |
| `logError`     | 17               | ERROR, 17-20             |
| `logFatal`     | 21               | FATAL, 21-24             |
| —              | 0                | unspecified, unreachable |

Each level sits on its band's floor, which is the unsuffixed name in the
specification: INFO is 9, ERROR is 17, FATAL is 21, and the `2`/`3`/`4`
variants climb from there. Nothing in this tree distinguishes a second severity
inside a band, so a caller picks a level function and the number follows. The
bands' floors double as thresholds, which is what a reader filters on: `>= 5`
keeps everything above trace, `>= 17` keeps the error band and above, and
neither threshold needs to know which spelling a kernel uses.

The level _functions_ keep their names. `severityNumber` is the wire value, not
a second vocabulary for call sites — a call site says which category it means,
and the table in the kernel is the one place that decides what that category is
worth.

A javascript kernel's `severityNumber(level)` throws on a name outside its
table instead of writing `undefined`, and `log.py` raises the same way: a record
with no severity is a record nobody can sort, so the call site that spelled the
level wrong is what has to change. Shell cannot raise out of a table lookup, so
`log.sh` answers `0` — the specification's "unspecified" — which is reachable
only if a level function names a level the table beside it lacks. Every kernel's
level set is closed by the level functions defined in the same file, so that
miss is a bug in one file, not a value a caller can produce.

### `stream` is a file descriptor number

`1` is stdout and `2` is stderr. Same reason the level became a number: it is
compared and filtered, and a descriptor generalizes — a traced shell script
writes its xtrace to `BASH_XTRACEFD`, and the number names that stream without
inventing a spelling for it. The kernels that capture a child now carry one
`[descriptor, name]` table, so the number and the node stream it reads from
cannot drift apart.

### A captured line is the message

This is the one deliberate deviation from d045's static-label rule. Where a
wrapped child's output becomes a record, the line IS `msg`, and the separate
`line` field is gone. The rule the change keeps is the one that mattered: no
call site interpolates its own values into a message. The bytes come from the
child verbatim; a message a wrapper assembles from a command, a target and a
status is still the label d045 forbids; and the attribution the constant used to
carry moved to fields that already existed (`target`, `cmd`, `stream`).

### `cmd` names the subcommand

`"podman"` becomes `"podman image build"`, `"go"` becomes `"go build"` or
`"go run ./packaging"`. In `coding-agent/build.mjs` and `estige/build.mjs` the
label is derived from the same array the build runs, so the name a line is filed
under cannot drift from the command that produced it; `estige/build.mjs`'s
`run()` takes `cmd` as a required option, so a new call site cannot omit it.

## Consequences

- Every reader-side filter changes with the shape. `jq 'select(.level !=
  "debug")'` is `jq 'select(.severityNumber >= 5)'`, and "just the errors" is
  `jq 'select(.severityNumber >= 17)'`. d045, d053, d058 and d060 carry the new
  form in their examples, as do the kernels' own headers.
- `logfmt` lines carry `severityNumber=` where they carried `level=`, and the
  `ts` value is bare digits, and the line starts with `msg=`.
- The shape lives in twelve files, not one. That is d113's copy rule working as
  designed — a folder is a copy unit and must stand alone — so a change to the
  record is a change to all twelve, and any one of them left behind is a stream
  that disagrees with itself.
- `fetch-model-cards.sh` keeps its own copy of the severity table: its python
  body runs without a shell, so it cannot call `log.sh` per line.
- `git`'s lock-status sidecar keeps its ISO `started` field
  (`writeLockStatus`). It is a human "held since" in a lock file, not a log
  record, and nothing filters it.
- Field order is part of the contract now. A consumer that splices a field
  into a record, or a wrapper that rebuilds one, keeps `msg` first and
  `ts`/`severityNumber`/`tool` last, or the next reader meets a different line
  to the one beside it.
- The change was verified on the shape itself, not only on the suites: one
  real package build (`node estige/build.mjs estige-packages`) emitted
  `{"msg":"…/estige_0.1.0_aarch64.deb","target":"estige-packages","cmd":"go run
  ./packaging","stream":1,"ts":1794170632448,"severityNumber":9,"tool":"estige/build"}`
  — the line as the message, the subcommand as `cmd`, the descriptor as
  `stream`, and the kernel's three at the end.
- Records written before this change are not migrated. The log is history and
  its old lines stay readable as what they were; a reader that has to span the
  boundary filters on both shapes or, better, ignores `ts`/`severityNumber`
  and matches the fields it actually wants.

## Alternatives rejected

- **Keep `level` and add `severityNumber` beside it.** Two fields for one fact,
  free to disagree, on every line — the pair costs more than the word it
  replaces and leaves a reader choosing which one is authoritative.
- **Add `severityText` companion.** The OpenTelemetry data model carries the
  number and a text spelling side by side, and this tree has no reader for the
  text: `tool` and `msg` already say what happened, and a consumer that wants
  the word maps the number back. A third spelling of the level is a field to
  keep in sync with no reader behind it.
- **Spend the band's range.** A record could carry INFO2 as 10 and reserve 9 for
  plain INFO. Nothing here has two kinds of info, so the finer value would be a
  choice every call site makes to say nothing, and its first real user would be
  a filter that accidentally stops matching.
- **Let the record lead with the OpenTelemetry data model's order.** The
  specification lists `Timestamp`, `SeverityNumber`, `SeverityText`, `Body`,
  then attributes, which is the order the records carried before this change.
  It is the order of the specification's table, not of a reader's attention:
  the mandatory-on-every-line fields come first and the event comes fourth.
  Field order is not part of the OpenTelemetry wire contract, so a tree that
  copies the table gains the reader's cost and nothing else.
- **Sort the keys alphabetically.** Name order puts `msg` somewhere different
  in every record — after `cmd`, before `severityNumber`, wherever the
  neighbours fall — which costs exactly the predictability this change is for,
  and any consumer that reformats anyway (`jq -S`, a pretty-printer) decides
  the order it shows regardless.
- **Keep `ts` a string and add `tsMs`.** The same two-fields-one-fact problem,
  and the string is the copy nobody could order.
- **Rename `level` only where it was read.** Nothing in the tree read `.level`
  except documentation and three tests, so the change had no consumer to break —
  but a partial rename would have split one stream into two shapes, which is the
  failure the whole record is about.
