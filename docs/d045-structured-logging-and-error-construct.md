---
id: d045
type: architecture-design
status: implemented
title: "d045 — structured logging and error construction: no interpolation, no level filtering, full cause chains"
parent: architecture
depends-on:
  - lib
  - coding-agent
references:
  - d024
  - d034
---

# d045 — Structured logging and error construction

**Status:** implemented
**Date:** 2026-09-16
**Owner:** pi-coding-agent fleet

## Summary

Four principles governing logging and error construction across the entire
repository (excluding `llm-reverse-proxy/`, which uses httpd-style logging by
design):

1. **No string interpolation in log messages or error messages.** Log messages
   are static strings; all dynamic values are structured fields. Error messages
   are static strings; all dynamic values are attached properties or `cause`
   pointers.
2. **Everything uses structured logs.** Every script and module in the
   repository (besides `llm-reverse-proxy/`) emits structured JSON logs via
   `lib/log.mjs` / `lib/log.sh` / `lib/log.py`.
3. **No log-level filtering.** Every level — `error`, `warn`, `info`,
   `debug`, `trace` — goes to the stream; `LOG_LEVEL` no longer exists. The
   consumer filters via jsonlines tooling if desired; the producer never
   drops a line.
4. **Full error cause chains.** Errors carry a `cause` pointer to their
   upstream cause (per the `Error` constructor spec). `Object.assign` attaches
   extra meaning. `AggregateError` and `SuppressedError` are used where
   appropriate. Logging serializes the entire cause/suppressed chain — the
   full available stack is preserved.

## Motivation

### Interpolated log messages lose metadata

Interpolating a dynamic value into a message string embeds it in prose, where
structured tooling (jq, jsonlines grep) cannot extract it — you must parse the
prose to recover what happened. The message is the stable label; the fields
are the metadata:

```js
// BAD — the value is buried in prose
logInfo(`${spec.id} model IDs from catwalk fallback`, { models: cids.length });

// GOOD — the label is static, the value is a field
logInfo("model IDs from catwalk fallback", { provider: spec.id, models: cids.length });
```

The triggering case: a generator logged
"default endpoint reachable but answered unexpectedly — keeping built-in
routing" with no visible cause. The fix keeps the static label and puts the
whole failure in the `error` field — as a structured Error object, not a
pre-flattened string (see Log serialization below).

### Error messages: same principle

Error messages are the same: static string, dynamic values as attached
properties (and `cause` when there is an upstream error):

```js
// BAD — interpolated
throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);

// GOOD — static label, attached properties, cause pointer
throw Object.assign(
  new Error("models listing answered non-2xx", { cause: fetchErr }),
  { status: res.status, statusText: res.statusText, url },
);
```

A consumer reads `err.message` for the label and `err.status`/`err.url` for
the detail without parsing prose — and the logger serializes both.

### `cause` pointer preserves the upstream chain

When an error wraps a previous one, the `cause` option (per the `Error`
constructor spec, ES2022) points at it:

```js
throw Object.assign(new Error("models.dev catalog unreadable", { cause: parseErr }), { path: API_JSON });
```

Without the pointer, the wrapper's message is all that survives; with it, the
entire chain (`err.cause.cause…`) is walkable and serializable.

### `AggregateError` and `SuppressedError`

- **`AggregateError`** — several parallel failures are one failure: the
  aggregate's `message` is the label, its `errors` array the structured
  detail.
- **`SuppressedError`** — a subsequent (e.g. cleanup) failure must not mask
  the original: `error`/`suppressed` point at what was lost.

Both are standard Error subtypes; their chain properties are non-enumerable
on node 24, so a serializer must walk them explicitly (verified).

### Log-level filtering is the consumer's job

The producer emits every level to the stream. The consumer (operator, CI
gate, jsonlines tooling) filters. A debug or trace line is never dropped by
the producer, so the consumer can always reconstruct the full picture. The
`llm-reverse-proxy/` is the exception: it uses httpd-style logging (a
different convention, not structured JSON).

## Scope

### Files affected

| file | change |
|------|--------|
| `lib/log.mjs` | stream → stdout default + `setLogStream`; `LOG_LEVEL` threshold removed; full error serialization (cause/errors/error/suppressed + stack + attached props, depth-capped) |
| `lib/log.sh` | stream → stdout default + `LOG_STREAM=stderr`; `LOG_LEVEL` filter removed |
| `lib/log.py` | stream → stdout default + `set_stream(sys.stderr)`; `LOG_LEVEL` filter removed; exception fields serialize with `__cause__` chain + traceback |
| `coding-agent/generate-pi-coding-agent.mjs` | interpolated catwalk log message fixed; `loadProvider`/`readJson` errors → static label + `{ path, provider, cause }`; error fields carry the Error object |
| `coding-agent/peer-probe.mjs` | `fetchModelEntries` errors → static label + `{ status, statusText, url }`; `ProbeResult.error`/`PeerRouteResult.error` carry the HttpError object; probe `failures` arrays are `{ url, result, error }` objects; `suppressedProbe()` composes the demotion records (below) |
| `coding-agent/catwalk-facts.mjs` | fetch errors → static label + `{ status, statusText, url }`; catch handlers log the Error object |
| `coding-agent/hyper-facts.mjs` | catch handlers log the Error object |
| `coding-agent/refresh-models-dev.mjs` | `status`/`statusText` split into two fields; `fail()` takes static label + fields; catch handlers log the Error object |
| `coding-agent/generate-opencode.mjs` | probe rejection handlers log the Error object |
| `git/git-lib.mjs` | `setLogStream("stderr")` — every tool in the folder prints a payload on stdout |
| `git/*.mjs` | ~20 interpolated `throw new Error(\`…${x}…\`)` arg-validation errors → static label + attached property (`{ flag }`, `{ root }`, `{ status, statusText }`, …); error fields carry the Error object |
| `git/-vbs-mirror-all.sh` | printf-based `die`/`warn` → `lib/log.sh` (`log_die`/`log_warn`/`log_info`/`log_error`) with static messages + fields; `LOG_STREAM=stderr` (`--list`'s TSV owns stdout); mirrored/aligned lines are log_info |
| `local-llm/*.py` | `set_stream(sys.stderr)` (tables/lists/reports own stdout); `error=str(e)` fields → the exception object |

### What is NOT changed

- `llm-reverse-proxy/` — uses httpd-style logging, exempt from this principle.
- Static log messages that are already correct (no interpolation) — left as-is.
- Human reports on stdout that are NOT logs (audit's JSON report, search
  results, the GGUF context tables) — they are payloads, not log lines; their
  scripts route logs to stderr so the two never mix.

## Design

### Error construction pattern

```js
// Wrap a fetch failure: static label, attached properties, cause pointer
throw Object.assign(
  new Error("models listing answered non-2xx", { cause: fetchErr }),
  { status: res.status, statusText: res.statusText, url },
);

// Wrap a parse failure: static label, attached property, cause pointer
throw Object.assign(new Error("models.dev catalog unreadable", { cause: parseErr }), { path: API_JSON });

// Aggregate multiple probe failures: static label, errors array
throw new AggregateError("all provider probes failed", { errors: failures });
```

### Log serialization pattern

`lib/log.mjs` `emit()` serializes every Error field as a structured object:
`name`, `message`, `stack`, own enumerable properties (e.g. `status`, `url`,
`path` from `Object.assign`), plus the explicitly walked NON-enumerable
`cause` (Error constructor), `errors` (AggregateError), and
`error`/`suppressed` (SuppressedError — each walked recursively, depth-capped
against cycles):

```json
{
  "ts": "2026-09-16T16:06:33Z",
  "level": "warn",
  "tool": "generate-pi",
  "msg": "default endpoint reachable but answered unexpectedly — keeping built-in routing",
  "provider": "opencode-go",
  "error": {
    "name": "Error",
    "message": "models listing answered non-2xx",
    "stack": "Error: models listing answered non-2xx\n    at fetchModelEntries …",
    "status": 500,
    "statusText": "Internal Server Error",
    "url": "https://opencode.ai/zen/go/v1/models",
    "cause": { "name": "Error", "message": "fetch failed", "code": "ECONNREFUSED" }
  }
}
```

The error stays a NESTED object — not flattened to dotted keys — so
`jq '.error.status'` selects the detail directly.

### Demotion records are SuppressedErrors, not bare labels

A record of the form "expected X, got Y, did Z instead" (the generator's
"answered unexpectedly — keeping built-in routing" family) composes
`suppressedProbe(probe, expectation)` (peer-probe.mjs): a `SuppressedError`
whose message is the static expectation label, whose `error` property chains
the probe's HttpError (status/statusText/url), and which carries the probe
classification as an attached `result` property. The log message stays a
generic label; the useful error value lives in the field:

```json
"error": {
  "name": "SuppressedError",
  "message": "expected a usable /models listing from the default endpoint",
  "result": "reachable",
  "error": { "status": 503, "statusText": "Service Unavailable", "url": "…" }
}
```

Two guarantees make the error-less generic record impossible: `probeDirect`
and `probePeerRoute` normalize ANY throw into an HttpError-shaped Error
(`normalizedProbeError` — a non-Error throw becomes `{ thrown: String(err) }`),
and `suppressedProbe` synthesizes a fallback error when a probe somehow ends
up error-less. `SuppressedError` is aliased through `globalThis`
(`SuppressedErrorCtor`) because the pinned `@types/node` does not declare the
global; runtime behavior is untouched.

### No interpolation rule

- Log messages: static strings only. All dynamic values are structured fields.
- Error messages: static strings only. All dynamic values are attached
  properties or `cause` pointers.
- Third-party tool output (git's stderr tail, a response body) rides as a
  field value (`output`), not as the message.

### No level-filtering rule

- `lib/log.mjs` / `lib/log.sh` / `lib/log.py` emit every level to the stream.
  `LOG_LEVEL` no longer exists — the producer never drops a line.
- The consumer filters via jsonlines tooling
  (e.g. `jq 'select(.level != "debug")'`).

### Stream policy

- Default stream: **stdout** — the jsonlines-filter workflow (`tool | jq`)
  reads stdout.
- Exception: a script whose stdout IS the machine-consumed payload routes its
  logs to **stderr** via one explicit call (`setLogStream("stderr")` in
  `git-lib.mjs`, `log.set_stream(sys.stderr)` in the local-llm python tools,
  `LOG_STREAM=stderr` in `-vbs-mirror-all.sh`) — its payload stays clean and
  `2>&1 | jq` still yields one merged jsonlines stream for filtering. The
  payload contract wins; the no-filtering rule is untouched.
- `llm-reverse-proxy/` is exempt from this whole record (httpd-style logging).

### Shell scripts: structured logs, same rules

`lib/log.sh` is the shell face of the same contract: static message labels,
`key=value` fields, every level emitted. `git/-vbs-mirror-all.sh` is the
worked conversion: its printf `die`/`warn` helpers are gone, every retry,
backoff, and summary line is a structured record, and git's own output rides
as the `output` field instead of an indented stderr dump.

## Consequences

- Log messages are stable labels; dynamic values are structured fields.
- Error messages are stable labels; dynamic values are attached properties or
  `cause` pointers.
- The entire cause/suppressed chain is serialized in structured output —
  the full available stack is preserved.
- Every log level is emitted; the consumer filters.
- Default stream is stdout; payload-bearing scripts opt to stderr explicitly.
- `llm-reverse-proxy/` is exempt (httpd-style logging).

## Verification record

- Serializer unit-checked live on node 24: cause chain + attached props
  (`status`/`statusText`/`url`/`code`) serialize; `AggregateError.errors` and
  `SuppressedError.error`/`suppressed` are walked despite being
  non-enumerable; a cyclic cause chain truncates at the depth cap without
  hanging; `LOG_LEVEL` env no longer consulted (debug lines emit).
- Stream policy verified: default emits on stdout (stderr sentinel absent);
  `setLogStream("stderr")` / `LOG_STREAM=stderr` / `log.set_stream` route to
  stderr.
- End-to-end probe path reproduced live (local 500 server): `probeDirect`
  returns `{ result: "reachable", error: <HttpError with
  status/statusText/url> }` and the generator's "answered unexpectedly" warn
  line carries the full structured error object — message label + stack +
  status + url. This is the fix for the original observation that the log
  line said nothing about what went wrong.
- Demotion records verified live (local 503 server, the reported mistral
  shape): the pi generator's "answered unexpectedly" record now emits a
  SuppressedError field — expectation message, `result` classification, and
  the chained probe failure with status/url — and the error-less-probe
  fallback synthesizes a structured error instead of emitting nothing.
- `git/-vbs-mirror-all.sh` exercised against a fixture manifest: `--list`
  prints the identity/clone-URL TSV on stdout with zero log lines on stdout;
  run-config, repository-count, per-repo failure (`step failed` with
  `phase`/`url`/`output` fields), and summary lines are structured JSON on
  stderr; `sh -n` clean.
- `./tests/check-workload.sh` — all 4 cases pass after the log.sh stream
  change.
- `python3 -m py_compile` clean on all touched py files; log.py error-chain
  serialization verified live (traceback + `__cause__` recursion).
- `node --check` clean on every touched mjs (lib, coding-agent, git).
- Repo-wide grep: zero remaining `` new Error(`…${…}`) `` interpolations and
  zero interpolated log-message template literals in `lib/`, `coding-agent/`,
  `git/`.
