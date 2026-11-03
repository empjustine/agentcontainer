---
id: d106
type: module-design
status: draft
title: "d106 — tunnel observability: two session records, one correlation id, and a snapshot surface"
parent: estige
depends-on: [d073, d077, d103, d105]
references: [d045, d078, d080, d081, d085, d088, d093, d094, d104, d134]
tags: ["serving", "proxy", "vpn", "ssl-vpn", "tunnel", "observability", "logging"]
---

# d106 — tunnel observability

**Status: draft.** Nothing below is implemented and this record decides
nothing yet. It is written first because the *vocabulary* (field names, event
names, what a "session" is) is cheap to agree on now and expensive to
reconcile once log lines exist in two deployments' histories — and because
seven independent upstream tools converge on the same field set, which is
evidence that the scope is real rather than invented.

## Problem

VPN-R19 asks the tunnel to log the shallow metadata a blind byte pipe can
still see — who, where, how much, how long, how it ended — and the exit node
does emit exactly that, once, at session end. It answers "what happened" and
never answers "what is happening", which is the question an operator actually
asks while watching an agent's request hang:

- **Nothing appears while a session is alive.** An LLM streaming response is
  a minutes-long session; until it closes, the log is silent. The one signal
  available in flight is the app's own hang.
- **The relay node — the node the operator is sitting at — logs nothing per
  session.** No target, no bytes, no duration, no outcome. Its
  `relay()` statistics are discarded at both call sites.
- **There is no way to tie the lines that do exist together.** One tunnel
  produces a Combined Log Format line, an authenticated-key line, and a
  lifecycle line, on two hosts, with no shared token and — in the structured
  lines — no timestamp at all.
- **Refusals are invisible at the relay**, and the transport-demotion ladder
  (the interesting event on a censoring network) is logged as three unrelated
  lines.
- **The one live surface is wrong.** `/healthz` reports a field named
  `sessions` that is an increment-only counter: a lifetime total presented
  as state.

Terminology, because the prose in the code and the issue gets this wrong:
the loopback `http://` branch is **not** a MITM and nothing is decrypted.
The relay terminates no TLS for any target (VPN-R25); the client chose to
speak cleartext, and d103's party-visibility invariant is what makes parsing
it acceptable. "Unencrypted MITM forward proxying" is a description of a
different design.

## What the code emits today

Exit node:

| call site | when | what |
|---|---|---|
| `tunnelserver.go:374` `logTunnelLifecycle` | session end (`defer`), refusals included | `[vpn] who=operator label=%q target=%q transport=%s bytes_in=%d bytes_out=%d duration_ms=%d outcome=%s` |
| `tunnelserver.go:144`, `:184` | after auth, before session work | `[estige] tunnel session: authenticated key=%s` |
| `main.go:379` `logCombinedRequestURI` | per request | CLF, including **one line per mode E window** |
| `tunnelserver.go:199`, `modee.go:523`, `:689` | error paths | mode C full-duplex unavailable, registry full, window drain failed |

Relay node:

| call site | when | what |
|---|---|---|
| `relaynode.go:201`, `:206`, `:211` | startup | listeners, chain, cleartext-chain warning |
| `relaynode.go:292`, `:315`, `:322` | per tunnel dial | `[vpn-relay] tunnel transport=%s` — transport only |
| `relaynode.go:309`, `:319` | per demotion | mode C/D failed, falling back |
| `relaynode.go:494`, `:634` | session end | nothing: `relay()`'s `relayStats` is discarded |
| `forward.go:39` | per cleartext exchange | nothing; no byte counters are kept |
| `relaynode.go:431` `handleHealth` | on request | tunnel endpoint, `sessions`, `last_error` |

Transport labels in use (`transport()`): `h2` (`modec.go:183`), `wss`
(`websocket.go:409`), `post` (`modee.go:461`, `:763`,
`tunnelserver.go:263`) — per d105's naming-by-mechanism rule, and asserted
at eight sites in four test files.

## Issues found

Each is a defect or an omission in the emission side; none weakens VPN-R19, and
none requires reading payload.

- **Attribution is a literal.** `logTunnelLifecycle` prints `who=operator`
  as a constant. The authenticated principal exists — `keyID` is in hand at
  both session-open sites and has its own log line — but never reaches the
  lifecycle line, so a multi-key deployment (d078) cannot tell its keys
  apart. The `[estige] tunnel session: authenticated key=` line is the only
  place the principal appears, and it is a second line per session saying
  almost nothing.
- **The relay is blind per session.** `relay()` returns `relayStats`
  (sent/received/outcome) and both relay-side call sites throw it away; the
  cleartext branch keeps no counters at all. Target, bytes, duration, outcome
  never appear on the node the operator can see.
- **Four uncorrelated lines per tunnel, on two hosts.** CLF (handshake or
  window), authenticated key, lifecycle, plus the relay's dial lines. Nothing
  joins them: no id, and the structured lines carry no timestamp because
  `main.go:532` sets `log.SetFlags(0)` — the CLF line's bracketed local
  time is the only clock in the output, and it is a different format.
- **`/healthz` state is a counter.** `relaynode.go:160` declares
  `sessions atomic.Int64 // established tunnels (diagnostic, VPN-R27)`;
  `:397` increments it and nothing in the module decrements it. VPN-R27 asks
  for "tunnel state"; the surface reports lifetime opens. In-flight bytes and
  duration exist nowhere, on either node; the exit node has no health surface
  at all (`healthPath` is declared only in `relaynode.go`).
- **Byte counters are viewpoint-relative.** `relay.go:52` defines
  `sent`/`received` from the exit node's seat. Copying the field names to
  the relay inverts their meaning with no visible change at the call site.
- **Refusals at the relay leave no trace.** A policy denial, a dial failure
  or a `CONNECT_ERR` reaches only `noteError`, i.e. `/healthz`'s
  last-wins `last_error` — not a timestamped, attributable line. Squid
  writes `TCP_DENIED`; Privoxy logs blocked destinations at its own debug
  level.
- **The demotion ladder is not grouped.** Three lines per app connection when
  the edge strips transports; d081 deliberately treats that as the
  censorship signal, which makes "which attempts belonged to this request"
  the most valuable question of the three the log can answer.
- **Mode E's correlation id is already on the wire and unlogged.**
  `modee.go:142` `newTraceID` mints a 32-hex W3C trace-id per session
  (call site `:213`), `buildTraceparent`
  puts it in every window's `traceparent` header, and the exit parses it
  back out (`modee.go:668`). Neither end logs it, so even the per-window CLF
  lines of a single mode E session cannot be stitched together.
- **Query strings are a privacy question the allowlist relay never had.**
  `main.go:379`'s "nothing request-shaped is credential-class" rests on d085,
  which is about the allowlist relay where keys ride headers. d103's
  cleartext branch can address any `http://` origin, where presigned URLs and
  session tokens routinely live in the query. Squid's default is the opposite
  of what a naive `url=` field would do.
## Prior art

**Moved to [d134](d134-session-logging-prior-art.md)** — the eight-implementation
source-read survey (Squid, Privoxy, OpenVPN, Tailscale, Nebula, ZeroTier,
Pritunl) with the field set they converge on and what none of them log. It is the
evidence behind this record's field vocabulary and its refusal list; it was
split out because it is read once, while the proposal below is read on every
change to a log line.

## Decision (draft proposal)

### Two records per session, one id

Per session, per node:

- `event=open` — written the moment the session reaches the streaming state.
  Answers "did it connect, to what, over which carrier". No bytes, no outcome.
- `event=close` — written at teardown, always, from the existing `defer`.
  Answers "how much, how long, how did it end".
- `event=refused` — a single record for a session that never opened, with a
  `reason=`. Squid's `TCP_DENIED`, Privoxy's `debug 1024`.

Shape (relay node, CONNECT session):

```
ts=1756741234.123 role=relay event=open  id=6f1c0a… key=-       label="deck" via=connect transport=h2   target="api.anthropic.com:443" url="connect://api.anthropic.com:443"
ts=1756741234.190 role=exit  event=open  id=6f1c0a… key=default label="deck" via=connect transport=post target="api.anthropic.com:443"
ts=1756741238.291 role=exit  event=close id=6f1c0a… key=default label="deck" via=connect transport=post target="api.anthropic.com:443" bytes_up=812 bytes_down=10477 duration_ms=4101 outcome=closed
ts=1756741238.334 role=relay event=close id=6f1c0a… key=-       label="deck" via=connect transport=h2   target="api.anthropic.com:443" bytes_up=812 bytes_down=10477 duration_ms=4211 outcome=closed
```

The 67 ms between the two `open` records and the 110 ms between the two
`close` records are the handshake and teardown the relay paid and the exit
did not — one session seen twice, not two sessions.

Rules that come with the shapes:

- **One open has exactly one close**, by construction: both go through one
  session struct whose `Close` is `defer`ed where `runSession`'s is today.
  A process killed mid-session leaves an unpaired open record — that is the
  intended signal, not a leak.
- **The close record repeats every identity field** (`target`,
  `transport`, `label`, `key`). Log rotation splitting a pair must not
  cost the reading of a close line.
- **Fields that legitimately differ between nodes:** `via`, `transport`,
  `url` vs `target`, and the byte counts on the parsed cleartext branch
  (rewrites change lengths; on `via=connect` they should be equal). A
  consumer must never assert equality of `transport` across the two nodes —
  the relay dialed `h2`, the exit received `post`, and both are correct
  (d077 records this asymmetry as deliberate).
- **Fields that must match:** `id`, `target`, `label`, `key`.
- **Derived metric for free:** the relay's duration includes the transport
  dial and HELLO, the exit's starts after the stream is handed over, so
  `relay.duration_ms − exit.duration_ms` estimates handshake latency.

### Field vocabulary

| field | values | notes |
|---|---|---|
| `ts` | epoch seconds, milliseconds | matches Squid's `%ts.%03tu`; per line, because `log.SetFlags(0)` is deliberate — turning flags on would prefix CLF lines and break stock parsers |
| `role` | `relay`, `exit` | replaces the need for a consumer to know `[vpn]` and `[vpn-relay]` as two vocabularies |
| `event` | `open`, `close`, `refused` | the discriminator; no `level=`, since estige has no producer-side filtering (d045) |
| `id` | 32 lowercase hex | correlation id, see below |
| `key` | operator key id or `-` | replaces the literal `who=operator`; the rationale is already written in code for the line this one subsumes — "the matched id is a label, so a success may say it out loud — as a side line, not inside the CLF, so the standard access log stays parseable by stock tools" (`tunnelserver.go:130`, d078's *Attribution lives beside the CLF, not in it*) |
| `label` | client label from HELLO | unchanged |
| `via` | `connect`, `socks5`, `http` | the local surface the app used; `socks5` is relay-side only, the exit cannot see it (the wire carries `host:port` alone) |
| `transport` | `h2`, `wss`, `post` | unchanged names (d105); what *that node* ran on |
| `target` | `host:port` | the CONNECT authority; never the resolved address (VPN-R19, as the code comment already states) |
| `url` | `connect://host:port`, `http://host:port/path`, `ws://…` | only where a URL was spoken — relay-side; the exit has no scheme |
| `bytes_up`, `bytes_down` | integers | client→origin and origin→client, unambiguous at both ends |
| `duration_ms` | integer | unchanged |
| `outcome` | `closed`, `idle-timeout`, `peer-disconnected`, `local-error`, `protocol-error` | unchanged (`relay.go:42`) |
| `reason` | `port-denied`, `egress-denied`, `target-ip-literal`, `resolve-failed`, `dial-failed`, `invalid-target`, `hijack-failed`, … | the existing `errReason*` set (`tunnelproto.go:65`) plus relay-local admission failures |

Two open sub-questions in the vocabulary are listed under Open questions:
whether to keep the bracketed prefixes, and whether `url` on `connect`
should carry a synthesized scheme at all (Squid's bare authority is the
faithful alternative).

### Refusals

Relay-side admission failures get a `refused` record with the local reason,
mapped from the same classifier that picks the HTTP status
(`httpStatusForTunnelErr`), so the log line and the app's error body agree.
The exit already emits its lifecycle line for refused CONNECTs (the `defer`
runs); with `event=` it becomes `event=refused reason=port-denied` instead
of a close record with zero bytes, which is what it says today.

### In-flight numbers: the status surface, not the log

- Fix the gauge: `defer c.sessions.Add(-1)` at the relay, so `/healthz`
  reports live sessions (VPN-R27's "tunnel state").
- Extend `/healthz` with the live set (`id`, `target`, `via`,
  `transport`, `bytes_up`, `bytes_down`, `age_ms`) from the same registry
  the id needs. Pull-based: OpenVPN's status file, ZeroTier's peer JSON.
- No periodic per-session log lines. A mode E session at 100 ms windows would
  emit thousands; the endpoint answers the same question at zero log volume.
- The exit node has no health surface. Not required by VPN-R27 (which binds
  the client-facing proxy) and not proposed here; the exit's open record plus
  `duration_ms` at close brackets the session from the log alone.

### The correlation id, and how it travels

- **Mode E already has one**, wire-shared: `newTraceID()` →
  `traceparent` → `parseTraceparent`. Both ends hold the same 32-hex value
  today; the only change is to log it. This is free and it is also what makes
  mode E's per-window CLF lines attributable (by hand, from the header, or
  later by a field if the CLF is ever given an extension).
- **Modes C and D have none.** Proposal: the relay mints the id per app
  connection and sends it on the session request as an additive header
  (`X-Estige-Session: <32 hex>`). Old exits ignore an unknown header; a new
  exit logs it; an old relay means the exit mints locally (open/close still
  pair within the node — the primary need — only the cross-node join is lost).
- Constraints on that header, all of which are cheap but none optional: it is
  **metadata only** — never an authorization input, never echoed into a
  response or an error body (the camouflage 404 must stay generic), validated
  as `[0-9a-f]{32}` before logging, and `%q`-quoted so no value can inject a
  log line. It rides under the Funnel terminator in cleartext, so the edge can
  read or alter it: it is a hint, not a fact.
- It is *not* in d104's credential scope: the id is per-session diagnostic data, not
  a credential, and signing it would imply it can be trusted — the opposite of
  what a tamperable field should mean.

### What this does not change

- **CLF stays byte-for-byte compatible.** No field is appended; `id` does not
  appear in access lines. Stock GoAccess/ELK parsing survives.
- **No payload inspection.** Nothing here reads stream bytes; the parsed
  cleartext branch reads HTTP metadata, which d103 already permits.
- **No wire-format version bump.** The frame format and `tunnelVersion` stay
  at 1; the only wire addition is one optional header, and it is used for
  logging alone. The demotion ladder and mode selection are untouched
  (d081/d093).
- **VPN-R19's no-payload rule is unchanged**, and VPN-R25's no-TLS-termination
  posture is unchanged: an opaque tunnel is still logged as an authority, not
  as a URL.

## Consequences

- Per tunnel, line count goes from three (CLF + authenticated key + lifecycle)
  to three (CLF + open + close) at the exit and from three dial lines to a
  pair plus the existing dial lines at the relay. The
  `[estige] tunnel session: authenticated key=` line is deleted, so the
  principal appears in the records that need it rather than in a line of its
  own.
- A reader gains: liveness at open, totals at close, refusals as first-class
  records, the demotion ladder grouped by `id`, and (mode E) window lines
  attributable to a session.
- The invariant "every open has a close" is structural, hence testable; the
  kill-mid-session case is visible as an unpaired open rather than silence.
- Eight test assertions on `transport=` and two on exact `label="…"` values
  need review — but not necessarily change, since the field names and values
  survive. The new assertions are: line counts per session, `id` matching
  between open and close, no token and no query string in any line, CLF lines
  unchanged.
- d073's Verification section, `estige/README.md`'s operational section, and
  `DESIGN.md`'s "debug from the proxy log" line all describe the old
  emission; they would need the new record shape.

## Discarded points

Recorded so they are not re-litigated, and so "why not X" is answerable
without reconstructing this analysis.

- **Only the end-of-session record (today's shape).** Squid's model. Rejected:
  a minutes-long LLM stream is invisible until it ends, which is the exact
  scenario the tunnel exists for.
- **Only the open record.** Cheapest possible change and the most tempting.
  Rejected: it cannot carry bytes, duration or outcome, so the useful half of
  VPN-R19 goes unlogged.
- **Periodic log snapshots while the session lives** (OpenVPN `--status`
  semantics, written to the log). Rejected on volume — hundreds to thousands
  of lines per streamed session — and because the same numbers are available
  pull-style from `/healthz` at zero cost.
- **An `overlay=` field for the transport.** Rejected: duplicates
  `transport=`, contradicts d105's naming-by-mechanism decision, breaks eight
  existing assertions, and re-introduces a second vocabulary for the same
  fact.
- **`ws` for the WebSocket transport.** Rejected: the deployed value is
  `wss` (`websocket.go:409`), the session really is TLS, and `ws` would
  describe the loopback surface rather than the tunnel. Anyone reading
  `transport=wss` today would see a rename for no gain.
- **`ts` via `log.SetFlags(log.LstdFlags)`** so every line is stamped.
  Rejected: it prefixes CLF lines with a `2006/01/02 15:04:05` field and
  breaks the format's compatibility promise, which is the reason
  `SetFlags(0)` exists. Per-line `ts=` on structured records only.
- **Appending `id` (or anything) to the CLF line.** Rejected: stock parsers
  are positional; the CLF line stays stock. Costs mode E window-level
  correlation, accepted in exchange.
- **`tunnelVersion = 2` with a scheme/kind byte in the CONNECT payload.**
  The "correct" wire answer, and the only one that lets the exit log `url=`
  honestly. Rejected for now on cost: `decodeHello` is strict, so a version
  bump means a negotiated transition and a deployment-order outage risk on a
  two-node system; the additive header buys the same join for a fraction of
  it. Revisit if the CONNECT payload ever has to carry something that must be
  framed (a second kind, per-request metadata, a mux).
- **Carrying the id in the HELLO label.** Zero wire change — the label is
  max 64 bytes (`tunnelproto.go:33`) and non-secret by decision. Rejected:
  it overloads operator identity with per-session data, breaks exact
  `label="…"` filtering (prefix matching leaks into every consumer), and makes
  a join depend on string parsing. A field that means two things is how
  vocabularies rot.
- **Exit-side inference of the scheme** from the target port (80 ⇒ http) or
  from the first bytes on the wire (TLS ClientHello ⇒ https). Rejected:
  inspecting stream bytes is exactly what VPN-R19 forbids, and the inference
  is wrong anyway (port 80 carries TLS routinely; h2 cleartext is neither).
- **Logging the exit node's pinned/resolved address** for correlation.
  Rejected: VPN-R19 admits "where the operator asked for", not resolver
  internals, and the code comment at the dial site already says so. It would
  also hand out a DNS-rebinding side channel through the log.
- **Full query strings in `url=` on `via=http`.** Rejected as a default.
  d085's "nothing credential-class is left to scrub" is scoped to the
  allowlist relay; a generic cleartext client can address presigned URLs. If
  it is ever wanted, make it an opt-in the way Squid does.
- **`bytes_in`/`bytes_out` reused on both nodes.** Rejected: the existing
  pair is defined from the exit's seat, so the relay's numbers would mean the
  opposite of the exit's under identical names. `bytes_up`/`bytes_down`
  (client→origin, origin→client) are unambiguous; if the existing pair is
  kept, it may only be read together with `role=`.
- **Per-window structured records for mode E.** Rejected: every window is
  already a CLF line; doubling that for a floor transport is volume without a
  question it answers.
- **Adopting `lib/log.sh`/`lib/log.py` logfmt wholesale**
  (`ts= level= tool= msg= …`). Rejected for now: estige is exempt from d045
  as httpd-style logging, CLF cannot join that shape, and `level=`/`msg=`
  would be decorative in a component with no producer-side filtering — a
  fixed `event=` discriminator is the honest equivalent. The field syntax
  stays logfmt-compatible so a consumer can still parse key=value.
- **Keeping `who=operator` because the tunnel has one operator.** Rejected:
  d078 defines a bounded key set with stable ids precisely so attribution
  exists; a literal in the log throws away a field the code already computed.
- **Prometheus/metrics endpoint.** Real prior art (Nebula and ZeroTier both
  have metrics as well as logs) and the right long-term home for counters, but
  out of scope here: there is no scrape target in this deployment, and
  `/healthz` is already the loopback surface VPN-R27 asks for.
- **Calling the cleartext branch a MITM / "unencrypted MITM HTTP forward
  proxy".** Rejected as terminology: nothing is decrypted, no certificate is
  minted (VPN-R25), and the name would suggest a capability the design
  explicitly refuses.

## Verification status

Not implemented; no end-to-end check exists yet. What this draft *did* verify,
because the issues above are claims about code and about other projects:

- Every code fact above was read from the tree at `estige/` on 2026-11-01,
  with line numbers as cited. The `/healthz` counter claim was checked by
  grepping every `sessions` use in the module: one `Add(1)`, no
  decrement.
- Every upstream claim was read from source at the cited path: Squid
  `src/cf.data.pre` and `src/HttpRequest.cc` (`effectiveRequestUri`,
  `strip_query_terms`, the shipped logformats), Privoxy 4.0.0 `jcc.c`,
  `errlog.c`, `config` and `ssl_common.c`, the OpenVPN 2.6 manual's
  `--status`/`--status-version`/`--verb` entries, tailscale
  `types/logger/logger.go` and `ipn/ipnstate/ipnstate.go`, nebula
  `hostmap.go`, `handshake_manager.go`, `connection_manager.go`,
  `control.go`, ZeroTier `service/OneService.cpp`'s
  `_peerToJson` and `node/Node.cpp`'s events,
  Pritunl `clients/clients.py`, `server/instance_com.py`,
  `logger/entry.py`.
- Verified 2026-11-01 against a **`tailscale serve` front reached over the
  tailnet** — tsnet-to-tsnet, so the flow exercised was serve, not funnel:
  an undeclared request header passes **intact** — the proposed
  `X-Estige-Session: <32 hex>` arrived with name and value unchanged. A Go
  hop canonicalized sibling header names to MIME title case
  (`X-Zzz-CaseTest` → `X-Zzz-Casetest`), so consumers compare names
  case-insensitively, as HTTP already requires; the proposed spelling is
  already canonical and survives verbatim. The front also **injects**
  headers of its own: `X-Forwarded-For`/`-Host`/`-Proto` plus, because the
  visitor was tailnet-authenticated, `Tailscale-Headers-Info` and
  `Tailscale-User-Login`/`-Name`/`-Profile-Pic`. That identity set is a
  serve-flow artifact and does not transfer: d073's production topology is
  the funnel flow with a public-internet visitor, which carries no tailnet
  identity to attest. The pass-through and the name canonicalization come
  from the serve proxy the two flows share, so they do transfer. Whatever
  the flow, the tunnel server ignores every injected header (VPN-R12
  authenticates; edge courtesy headers are not an input, not even a logged
  one) and none joins this proposal's field vocabulary.
- Still not verified: anything about a real deployment's log volume or
  rotation, and the header set of the **funnel flow itself** — the test
  visitor arrived over the tailnet carrying a tailnet identity, so the
  public-internet leg remains untested.

Implementation would have to show: two records per session with matching
`id`, one record per refusal with a reason, no credential and no query string
in any line, `/healthz` reporting a live gauge and a live set, CLF output
byte-identical to today's for the same exchange, and the relay's totals equal
to the exit's on `via=connect`.

## Open questions

- **Prefixes vs fields.** Keep `[vpn]`/`[vpn-relay]` and add `role=`, or
  drop the prefixes for a uniform logfmt line? Keeping them is friendlier to
  `grep` and to muscle memory; `role=` is what a consumer needs. Both
  together is slightly redundant and slightly harmless.
- **`url=connect://…`** or Squid's bare authority in `url=`? The scheme
  makes `url=` uniform across `via` values; the authority is what a
  third-party log reader would expect from a CONNECT line. Leaning: keep the
  scheme, and say in the record why the field is not a URL the client sent.
- **Is an undeclared request header an acceptable wire surface?** If the
  header is adopted it becomes part of the tunnel's contract and belongs in
  d077's wire description, not only in the code. The alternative is the
  CONNECT-payload version bump this record defers. Pass-through is now
  verified (see Verification status) — what remains is the adoption
  decision itself, which also makes it d077's wire surface to describe.
- **Does the exit need its own health surface?** Not for VPN-R27's letter;
  possibly for symmetry with the relay.
- **Retention and rotation.** Privoxy ships logging off because a URL log is a
  privacy risk; estige logs unconditionally (d045) to `podman logs`. Two more
  records per session are cheap in bytes and expensive in a journal that is
  never rotated — worth one sentence in the operational docs.
