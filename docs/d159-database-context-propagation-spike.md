---
id: d159
type: architecture-design
status: done
title: "d159 — spike: getting trace context and verbose SQL into the database without a plan-cache bomb"
parent: architecture
depends-on: [d045, d151, d157]
references: [d106, d134, d158]
tags: [database, sql, otel, tracing, plan-cache, pii, spike]
---

# d159 — spike: context and verbose SQL without a plan-cache bomb

Two needs point at the same place and pull in opposite directions: a trace id
wants to be inside every statement the database runs, and a statement wants to be
identical on every execution so the engine can cache its parse and its plan. The
standard answer, a per-request `/*traceparent=...*/` comment, satisfies the first
and destroys the second wherever the statement text is the cache key. This spike
works out what to carry instead — a static statement identifier baked at build,
session state for the context, and a reference for anything verbose.

## Status

Investigation finished, nothing implemented; the requirements at the end are not in
force. Nothing in this tree speaks SQL, so this record is deployment-wide rather
than repo-specific: the findings are the engines' own caching and introspection
contracts, and the two mechanisms it recommends are the ones each engine ships for
exactly this purpose. Open: the round-trip budget for session state on a
high-frequency connection pool, and whether a connection-constant join is accurate
enough to replace it.

## The trap, stated exactly

Comment propagation appends or prepends a comment to the statement text. Where the
engine keys its parse and plan cache on that text, one logical query becomes as
many cached statements as it has distinct trace ids.

- **Oracle** computes `SQL_ID` from the text, and a comment is part of the text. A
  per-request comment forces a hard parse and a new library-cache entry per
  execution; on a hot path this is the most expensive thing an application can do
  to the database.
- **MySQL 8**'s prepared-statement cache matches on the text as sent, so the same
  applies.
- **PostgreSQL** discards comments in the lexer before computing `queryid`, so
  `pg_stat_statements` still aggregates.

The third bullet is why the trap is dangerous rather than merely bad: a team that
validated comment propagation on PostgreSQL sees no regression, and the same
instrumentation is a cache bomb on the Oracle or MySQL deployment beside it. The
finding is that the carrier's safety is an engine property, so a carrier that
relies on text identity must be assumed unsafe on every engine.

## Static identifiers, baked at build

The part that makes the rest cheap: statement text is _static data_ in a modern
application. Generated accessors (sqlc, sqlx, a migration tree, ORM models) hold
every statement the application can run, and a build step can extract them.

- Normalize each statement to a template — literals replaced by placeholders,
  whitespace collapsed — and hash it. The hash is the template id.
- Publish `template_id → text` from the build, not from the request path.
- Ship `template_id` on the span as `db.query.template.id`, and the canonical
  template as `db.query.summary`.

Three consequences make this the load-bearing decision of the record. The runtime
cost is zero, because a hash of a constant is itself a constant and can be
generated once into the query's Go/Java/TypeScript binding. Cardinality collapses,
because a template groups every execution of the same logical query. And the text
becomes resolvable offline, months later, by joining the span to the build
artifact — which is exactly the reference-instead-of-payload rule d157 applies to
records and d158 applies to personal data.

The corollary matters more than the technique: **a per-request carrier cannot be
part of the business statement**, because the statement text is the cache key. So
the carrier must ride beside the statement, not in it.

## Carriers, costed

| carrier                                         | per-statement cost              | text unchanged | visible to the engine's own views  | plan risk         | verdict             |
| ----------------------------------------------- | ------------------------------- | -------------- | ---------------------------------- | ----------------- | ------------------- |
| SQL comment in the business statement           | one text variant per request    | no             | `V$SQL`, slow-query logs           | breaks the cache  | never on a hot path |
| bind parameter of the business statement        | one placeholder, fixed at build | no             | bind capture, statement logs       | perturbs the plan | no                  |
| bind parameter of a dedicated context statement | one round trip per change       | yes            | session context, GUCs, `V$SESSION` | none              | **yes**             |
| session state set out of band                   | one round trip per change       | yes            | `V$SESSION`, `pg_stat_activity`    | none              | **yes**             |
| connection constant plus an offline join        | none                            | yes            | nothing on the DB side             | none              | **cheapest**        |
| sidecar reading the engine's own logs           | none                            | yes            | everything the engine records      | none              | **yes**             |

The bind-parameter column is the answer to the natural follow-up question, and it
is a yes with a precise shape. A bind parameter is safe **as the argument of a
purpose-built context statement**, which is how every engine that has no session
API exposes one:

```sql
-- PostgreSQL: a function, so the value is a bind and `is_local` scopes it
SELECT set_config('app.trace_id', $1, true);
-- MySQL: no session-context API, so a user variable is the closest thing
SET @trace_id = ?;
-- SQL Server: a stored procedure whose arguments are binds
EXEC sys.sp_set_session_context @key = N'trace_id', @value = @p1;
-- Oracle: a PL/SQL call with a bind, not a text edit
BEGIN DBMS_SESSION.SET_IDENTIFIER(:1); END;
```

Both statements are static, both take a bind, and neither touches a business
statement. The cost is one round trip whenever the value changes — per request on
a pooled connection, per transaction with `is_local`, per connection if the
carrier is a constant.

What does _not_ work is the bind parameter inside the business statement, for
three reasons that each stand alone:

- **There is no semantic-free slot.** A placeholder in the `WHERE` clause
  participates in selectivity estimation and can change the plan it was added to
  protect; a placeholder in the projection list changes the row shape the
  application decodes.
- **It cannot be conditional.** Omitting the parameter on some executions changes
  the text, which returns the cache bomb by another route — so every statement
  must carry it forever, in every query, including the ones written before the
  trace id existed.
- **The engines do not record it where it would help.** PostgreSQL's
  `pg_stat_statements` stores no parameter values at all; parameter values reach
  logs only through `log_parameter_max_length` and the error path. Oracle's bind
  capture is a per-cursor diagnostic, not an execution log.

## Session state, engine by engine

Each engine ships a mechanism for exactly this, and they are all small and
fixed-width:

| engine     | mechanism                                                                         | width               | read from                                                        |
| ---------- | --------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| PostgreSQL | `set_config('app.trace_id', …, true)` / `application_name`                        | GUC, unbounded / 64 | `current_setting`, `pg_stat_activity`, `log_line_prefix %a`      |
| Oracle     | `DBMS_SESSION.SET_IDENTIFIER`, `DBMS_APPLICATION_INFO.SET_ACTION/SET_CLIENT_INFO` | 64                  | `V$SESSION.CLIENT_IDENTIFIER`, `MODULE`, `ACTION`, `CLIENT_INFO` |
| SQL Server | `sys.sp_set_session_context`                                                      | 128 per key         | `SESSION_CONTEXT()`, RLS predicates                              |
| MySQL      | `SET @trace_id` (user variable)                                                   | 64-ish              | session only; not in `performance_schema`                        |

MySQL's row is the weak one, and it is the reason the sidecar row exists: a user
variable is visible to the session only, so a DBA with `performance_schema` cannot
see it without the application having logged it elsewhere.

Two hazards belong in the deployment plan rather than in the code:

- **Pool leakage.** A pooled connection keeps the last value, so a missing reset
  attributes the next request's slow query to the wrong trace — a silent
  mis-attribution, which is worse than no attribution. Reset on release, and set
  it on checkout; a reset to a constant is enough (`DISCARD ALL` is too heavy to
  put in a hot path).
- **Authorization adjacency.** SQL Server's row-level security reads
  `SESSION_CONTEXT`, so a key that carries trace data sits in the same namespace
  as a key that grants access. Separate the names, and mark authorization keys
  read-only so no code path can rewrite them.

## The connection-constant join

The cheapest carrier carries nothing per statement. Resolve once per pooled
connection the engine's own session identifier — `pg_backend_pid()`, Oracle's
`SID`/`SERIAL#`, MySQL's `CONNECTION_ID()` — and put _that_ in the trace. The
engine's logs carry the same identifier and a timestamp, so a record joins to an
execution offline.

It buys a whole class of questions at zero per-statement cost: which session ran
this, what else that session ran in the window, and whether a slow query was the
session's or the server's problem. It costs clock discipline (both sides need a
synchronized clock and a margin wider than the skew) and it gives no per-statement
correlation at all inside a busy session.

The recommendation that follows is a split: session state for a live operator
looking at `V$SESSION` or `pg_stat_activity` now, and the connection-constant join
for everything that is read after the fact. The expensive habit to break is
believing one carrier must serve both.

## Verbose payloads by reference

Statement text is cheap to carry because it repeats. Bind parameters do not, and
they are the personal data; a 4 KiB statement-plus-bindings attribute at two
thousand operations per second is roughly 8 MB/s of telemetry describing a few
hundred distinct queries.

- **Template, never text, on the span.** `db.query.template.id` plus
  `db.query.summary`; the text lives in the build artifact.
- **Bindings are off by default** and on **only when the operation is
  interesting**: duration above a threshold, non-OK status, a retry, a deadlock,
  or a trace already flagged by a fault. The span is always recorded; the payload
  appears when somebody will read it.
- **Shape before values.** Parameter metadata is already in the driver and
  answers most plan questions: `uuid` where the index expects one, `varchar(3)`
  for a country code, a numeric amount, a missing or null parameter. A wrong type
  is a more common cause of a bad plan than a particular value.
- **A value that is truly needed is a handle**, per d158: `db.query.param.1`
  carries a TTL'd reference into the PII vault, never the value.
- **A hash of a value is that value's fingerprint.** An unkeyed `sha256` of an
  email is brute-forceable and is a permanent join key across every trace; if a
  fingerprint is genuinely wanted, `HMAC` it under a per-template key.
- **Truncate and declare.** A capped `db.query.text` (a few KiB) with its full
  length beside it, and never a whole anonymous PL/SQL block.
- **Never in a span name and never in a metric attribute.** A statement in either
  is a cardinality bomb in every derived aggregate.

## Borrow the engine's own digest, and its own logs

The database already computed what the trace wants: `sql_id` and
`plan_hash_value`, `pg_stat_statements.queryid`, MySQL's `DIGEST`, SQL Server's
`query_hash` and `query_plan_hash`. These are small, stable, and — the point — they
are the keys the engine's own views and logs are indexed by.

So the span carries the digest and the plan hash, and a slow span leads to
`V$SQL`/`V$SQL_BIND_CAPTURE`, to `pg_stat_statements`, or to a
`log_min_duration_statement` entry with the bindings, resolved on a replica or in a
log file rather than on the request path. The plan is usually the real answer to a
"why slow" question, and it is a hash rather than a payload.

That also settles the verbosity question the app keeps asking: the engine's own
logging (`log_min_duration_statement`, `log_parameter_max_length`, the Oracle
error and audit trails) already records statements and bindings more reliably than
an application-side copy can, and it records them for the failures that matter.
Capture in the application only what the engine does not have — the span's
correlation and the classification — and let a slow-query reader (or a local
flight recorder, d157) supply the rest.

## What a span carries

```
db.system=postgresql   db.namespace=orders   db.operation.name=SELECT   db.collection.name=orders
db.query.template.id=9f31c0   db.query.summary=SELECT … FROM orders WHERE tenant = $1 …
db.query.param.count=2   db.query.param.shapes=uuid,varchar(3)
db.query.text.length=412   db.query.text.truncated=true
db.query.plan.hash=1234567890   db.query.digest=987654321   db.connection.id=48213
```

Every field is small, greppable and PII-free; the statement behind `9f31c0` is a
build artifact, the execution behind `987654321` is a row in a view, and any value
a person needs to see is a handle that expires.

## Requirements

- **R1 — no carrier in a business statement.** Neither a comment nor a bind
  parameter may be added to a statement the application runs.
- **R2 — identifiers are build artifacts.** `template_id` is produced by the build
  step from the static statement set, and the runtime never hashes a statement
  again.
- **R3 — context rides beside the statement.** Session state or a connection
  constant, set through the engine's own mechanism.
- **R4 — a pooled connection is reset on release.** A stale carrier is a silent
  misattribution.
- **R5 — authorization keys never share a namespace with trace keys**, and are
  read-only where the engine allows it.
- **R6 — bindings are off by default**, and captured only under a declared
  condition.
- **R7 — parameter shape is preferred to parameter value.**
- **R8 — a captured value is a handle (d158), not a value.**
- **R9 — a fingerprint is keyed.** No unkeyed hash of personal data reaches a
  trace.
- **R10 — the engine's digest and plan hash are carried**, so the server's own
  views are one lookup away.
- **R11 — statement text is capped and its truncation declared.**
- **R12 — no statement text in a span name or a metric attribute.**
- **R13 — the after-the-fact path is a join, not a capture.** The connection
  identifier is what makes a server log joinable; nothing else is added to the
  request path for it.

## Open questions

- One round trip per request for session state is affordable only if the driver
  pipelines it with the query; libpq pipeline mode is recent, and JDBC and MySQL
  connectors differ. Unmeasured.
- `is_local` scoping is transaction-scoped, so a connection in autocommit mode
  needs the set inside the transaction itself, which changes the app's transaction
  shape.
- Clock skew and timezone settings decide whether a connection-constant join is
  exact or merely suggestive, and no deployment currently asserts either.
- Oracle's bind capture has changed availability across versions; whether it can be
  relied on as the source of truth for a slow statement is untested here.
- Whether a static statement set can be extracted completely from an ORM that
  builds SQL at runtime — the one case where the build artifact has holes.

## Alternatives rejected

- **Comment propagation everywhere.** Correct on PostgreSQL, a plan-cache bomb on
  Oracle and MySQL, and unverifiable per engine at deploy time.
- **A bind parameter in the business statement.** No semantic-free slot, no
  conditional presence, and no engine records it where it would be useful.
- **Full statement text on every span.** Tens of megabytes a second for a few
  hundred distinct strings.
- **Bindings always.** The most expensive telemetry an application can emit, and
  the most sensitive.
- **Relying on `log_statement=all`.** Correct at low volume, a disk-filling
  liability at high volume, and it is the engine's decision rather than the
  deployment's.
- **An application-side capture of what the engine already logs.** Paying twice for
  the same text, with the less reliable copy.

## Prior art carried in this record

SQLCommenter's propagation (and its engine-dependent footprint), the engines'
session-context and application-info APIs, PostgreSQL's `set_config` with
`is_local`, `pg_stat_statements`, `V$SQL`/`V$SQL_BIND_CAPTURE`, MySQL's
`performance_schema`, SQL Server's `SESSION_CONTEXT`, and OTel's database semantic
conventions for `db.query.*` and `db.namespace`.
