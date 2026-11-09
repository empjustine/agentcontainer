---
id: d155
type: module-design
status: draft
title: "d155 — estige writes structured journald entries: detection by JOURNAL_STREAM, transport by the journal protocol"
parent: estige
depends-on: [d106, d151]
references: [d045, d081, d120, d134, d154]
tags: [estige, logging, journald, systemd, observability, packaging]
---

# d155 — estige writes structured journald entries

Under systemd, every line estige produces reaches the journal as text on the
error stream, and journald extracts no field from it. This record decides how
the binary detects that the journal is its consumer, what it sends there, and
what stays exactly as it is. Nothing implements it yet.

## Status

Accepted, pending implementation. The condition described below holds in the
tree as it stands: `main.go` writes a Combined Log Format access line and
`[estige] …` operational lines through the standard library's `log` package,
`log.SetFlags(0)` and no `log.SetOutput`, and neither unit in
`estige/packaging/ol/` sets `StandardOutput=` or `StandardError=`, so systemd's
default (`journal`) governs both streams.

## Problem

Three facts, each visible in the tree, compose into a journal nobody can query.

Go's `log` package writes to stderr, and estige never redirects it. Every line —
the access line and the operational lines alike — therefore arrives on the error
stream. journald derives `PRIORITY` from the stream a line arrived on (stdout as
info, stderr as error), not from anything the program said, so routine traffic
carries error priority and `journalctl -p err` reports a healthy node as broken.

journald also parses nothing out of a stream line. A structured line would
become the text of `MESSAGE`, so `journalctl -o json` would hand back a JSON
string inside a JSON field — the double decode d134 rejects for a JSON-in-one-
blob log design. Fields exist in the journal only when the process submits them
itself.

What the node does have is a vocabulary waiting for a transport: d106 fixes the
session fields (`role`, `event`, `id` as a 32-hex correlation id, `key`, `label`,
`via`, `transport`, `target`) and states that no `level=` field exists because
estige filters nothing (d045). The correlation id d106 defines is also what a
future flight recorder would key its rings by (d154).

## Decision

### Detection is `JOURNAL_STREAM`, not a flag

systemd sets `JOURNAL_STREAM=<device>:<inode>` in the environment of a service
whose output it attached to the journal. estige compares that value with the
`fstat` result for its own stdout and stderr once, at startup, and takes a match
as "the journal is the consumer". No environment knob selects the path (in the
spirit of d060: the environment describes the deployment, not the verbosity), and
no `LogExtraFields=` is required — that directive needs systemd 246, above the
floor of the oldest packaged target (d120).

### Transport is the journal protocol, because the build is cgo-free

`CGO_ENABLED=0` in `estige/lib/go-build.mjs` and in the `Containerfile` rules out
`sd_journal_send`, which arrives with libsystemd through cgo. The protocol itself
needs no library: the process writes `FIELD=value` lines as a Unix datagram to
`/run/systemd/journal/socket`, which is what `sd_journal_send` does underneath,
and which `net.DialUnix` reaches from a static binary.

The units' hardening does not obstruct it. `RestrictAddressFamilies` already
admits `AF_UNIX`, `ProtectSystem=strict` leaves `/run` writable, `PrivateTmp`
does not touch it, and the journal socket is writable by the unprivileged user
the unit runs as — that is how `systemd-cat` works without privilege.

### One line stays one entry, and `MESSAGE` carries the text

When the journal is detected, estige sends the entry to the socket and writes
nothing to stderr for that line, so no entry is duplicated. `MESSAGE` holds the
text the stream path would have written — the Combined Log Format line verbatim,
or the `[estige] …` sentence — and the fields hold the structure. A stock parser
reading `journalctl -o cat` therefore still parses the access log (d106, d134),
while `journalctl -o json` yields the fields without a second decode.

### Fields use d106's vocabulary in journal spelling

Custom journal fields are uppercase, so d106's names become `EVENT`, `ROLE`,
`KEY`, `LABEL`, `VIA`, `TRANSPORT`, `TARGET`, and the access line adds `STATUS`,
`BYTES` and `DURATION_MS`. `SYSLOG_IDENTIFIER` names the binary (`estige` or
`estige-relay` by role) and `TOOL` names the component, matching the value the
JSONL side carries.

`ts` is deliberately absent. journald stamps `__REALTIME_TIMESTAMP` on every
entry it accepts, and a second clock in the payload is a second truth; the CLF
timestamp inside `MESSAGE` belongs to the format rather than to the record.

### Two severities, one mapping table

The journal's severity vocabulary is syslog's (`PRIORITY` 0-7); the tree's is
OpenTelemetry's band floor (`SEVERITY_NUMBER`, d151). Both appear on every
entry: `PRIORITY` so `journalctl -p` filters, `SEVERITY_NUMBER` so the same `jq`
predicate works on the journal as on the JSONL stream. The mapping — info to 6,
warn to 4, error to 3, fatal to 2 — lives in one table, because a second table is
a second truth.

### The socket path is a package variable, so a test can own it

`/run/systemd/journal/socket` is a variable rather than a constant, and the tests
point it at a `net.ListenUnixgram` fixture. The suite must not require a running
journald, and no production code path reads the path from the environment.

### Absent journal means unchanged behaviour

No `JOURNAL_STREAM` — a terminal, `podman run`, a runit service, a test — keeps
the current path: text on stderr, one `log.Printf` per line, no journal
dependency at runtime. The runit half of d120 keeps text deliberately: `svlogd`
has no fields, and a JSONL file added only to look modern would be a second
format with no consumer.

### Rate limiting bounds the design

journald drops entries beyond its per-service burst limit (roughly 10 000 in 30
seconds by default) and records its own suppression notice. A busy exit node, or
a crash dump from the recorder d154 specifies, can reach that limit. The units
must not raise it — an unbounded journal is a disk-full outage on a node whose
job is forwarding traffic. A dump is a projection (d154) and `journalctl --since`
narrows a query; neither needs the limit moved.

## Requirements (pending implementation)

- **R1 — detect once.** Detection happens at startup, before the first line; a
  mismatch never falls back mid-run.
- **R2 — degrade, never die.** A missing, unreadable or unwritable socket falls
  back to the stderr path with one warn line. Logging cannot fail the daemon.
- **R3 — the text is the text.** `MESSAGE` is byte-identical to what the stream
  path would have written for that line.
- **R4 — both severities, always.** Every entry carries `PRIORITY` and
  `SEVERITY_NUMBER`.
- **R5 — no duplicate entries.** A run writes each line to the socket or to
  stderr, never both.
- **R6 — the CLF grammar is untouched.** The access line keeps its Combined Log
  Format shape (d106, d134).
- **R7 — the payload path stays clean.** `estige -version` and `estige
  proxy-env` keep writing their payload to stdout; nothing in this change adds a
  stdout write.
- **R8 — a fixture proves the fields.** A test receives the datagram on a real
  Unix socket and asserts the field set, without a journald on the host.
- **R9 — a dump would need `StateDirectory=`.** The units set
  `ProtectSystem=strict`, which makes `/var` read-only, so a future on-disk dump
  requires `StateDirectory=estige` (or an explicit `ReadWritePaths=`) rather than
  a write that fails at the moment it matters.

## Consequences

- Under systemd, `journalctl -p err` starts meaning what it says, and
  `journalctl -o json` yields fields. `journalctl -o cat` still yields the access
  log.
- estige acquires one protocol dependency, described here rather than imported as
  a library: no libsystemd, no cgo, no packaging change.
- The container path is unaffected. `podman run` gives estige no
  `JOURNAL_STREAM`, and conmon already supplies the container's own journal
  fields.
- Two severity spellings now exist per entry, and keeping their tables in one
  place is an implementation obligation, not a detail.
- The correlation id d106 defines becomes a journal field, which is what makes a
  per-session query (`journalctl ID=…`) possible for the first time.

## Alternatives rejected

- **Structured lines on stdout, read back with `journalctl -o cat | jq`.** Two
  decodes per line, fields still invisible to `journalctl -o json`, and the
  journal's own filters cannot see them.
- **A `systemd-cat` or `logger` wrapper in `ExecStart`.** An extra process per
  line and one hop of quoting, and neither adds a field.
- **`/dev/log` syslog.** Yields `PRIORITY` and `SYSLOG_IDENTIFIER` with an
  unstructured message; the fields are the requirement, so it buys the smaller
  half at the cost of a syslog client.
- **`LogExtraFields=` in the unit.** Static, per-unit only, and it needs systemd
  246, above the packaged floor.
- **`sd_journal_send`.** Needs cgo, and the binary is built `CGO_ENABLED=0`.
- **Always send to the socket, with no detection.** Fails on every host without
  journald, including `podman run` and the runit path of d120.
- **Set `StandardError=journal` and fix priority there.** systemd has no
  directive that stamps a priority on a stream, and a stream line carries no
  fields regardless.
- **Leave the journal untidy and rely on `-o cat | jq`.** The current state: one
  query costs a pipe, and `journalctl -p` cannot be used at all.
