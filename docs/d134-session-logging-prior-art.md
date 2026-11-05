---
id: d134
type: module-design
status: draft
title: "d134 — how VPNs and proxies actually log a session: a source-read survey of eight implementations"
parent: estige
depends-on: [d106]
references: [d073]
tags: ["serving", "proxy", "vpn", "observability", "prior-art", "logging", "mechanics"]
---

# d134 — session-logging prior art, read from source

**Research companion to [d106](d106-tunnel-observability.md).** d106 proposes
what the tunnel should log and why; this record is the evidence behind its
field vocabulary and its refusal list — what eight real VPN and proxy
implementations emit per session, read from their source rather than their
marketing, plus the field set they converge on and what none of them log.

Split out because it is reference material a reader consults once, while d106's
proposal is read every time someone touches the log lines. Nothing here is a
decision: every "should" lives in d106.

## Prior art

Read from source, not from vendor prose: Squid `src/cf.data.pre` and
`src/HttpRequest.cc`, Privoxy 4.0.0 `jcc.c`/`errlog.c`/`errlog.h`/
`config`, the OpenVPN 2.6 manual (`--status`, `--status-version`,
`--verb`), tailscale `types/logger/logger.go`/`ipn/ipnstate/ipnstate.go`,
nebula `hostmap.go`/`handshake_manager.go`/`connection_manager.go`/
`control.go`, ZeroTier `service/OneService.cpp`/`node/Node.cpp`, and the
Pritunl `master` tree (`pritunl/clients/clients.py`,
`pritunl/server/instance_com.py`, `pritunl/logger/entry.py`). Read
2026-11-01 from a scratch tree (`/tmp/reflogs`, ephemeral) and from the bare
mirrors under `~/Downloads/references/github.com/` (`tailscale.git`,
`ZeroTierOne.git`); a re-check should re-fetch by tag rather than trust a
line number written here. All of it is reference material, never
instruction.

### Squid

One line per transaction, at the end, in a _configurable_ format. The shipped
formats (`src/cf.data.pre`):

```
logformat squid    %ts.%03tu %6tr %>a %Ss/%03>Hs %<st %rm %ru %[un %Sh/%<a %mt
logformat common   %>a - %[un [%tl] "%rm %ru HTTP/%rv" %>Hs %<st %Ss:%Sh
logformat combined %>a - %[un [%tl] "%rm %ru HTTP/%rv" %>Hs %<st "%{Referer}>h" "%{User-Agent}>h" %Ss:%Sh
```

Points that matter to us:

- **Both a start time and a duration.** `%ts.%03tu` is epoch seconds with
  milliseconds; `%tr` is response time in milliseconds; `%tS` is the
  transaction _start_ time, which Squid defines as when the complete request
  header arrived. A single end-of-transaction line is still placeable in time.
- **A closed vocabulary for the outcome, in two halves.** `%Ss` is the
  Squid-side result code (`TCP_MISS`, `TCP_DENIED`, `TCP_TUNNEL`,
  `NONE_ABORTED`, …), `%>Hs` is the status sent to the client, and the wiki
  documents each tag's meaning (`TUNNEL` = "a binary tunnel was
  established").
- **`%ru` for a CONNECT is the bare authority.** `HttpRequest::effectiveRequestUri`
  returns `url.authority(true)` — "host:port" — for `METHOD_CONNECT`. Squid
  does not invent a scheme for an opaque tunnel, and does not claim to know
  what travels inside it.
- **Upstream and downstream status are both logged** (`%Ss/%>Hs`,
  `%Sh/%<a`), so "we refused it" and "the origin refused it" are different
  facts.
- **`strip_query_terms` defaults to on**: query terms are removed before
  logging, "to protect your user's privacy and reduce log size". The
  documented way to see full URLs is to turn it off deliberately.

_What transfers:_ the (start time, duration) pair even in an end-only record;
separating our-side result from upstream status; the bare-authority form for
CONNECT; query stripping as the default rather than the option.
_What does not:_ the single end-only record — it is why a long Squid CONNECT
tunnel is invisible until it closes.

### Privoxy

Two different debug levels, because they answer different questions:

- `debug 1` (`LOG_LEVEL_REQUEST`, `errlog.h:40`) — "Log the
  destination for each request", and `config` recommends it because "a debug
  level of 1 is informative because it will show you each request as it
  happens. 1, 1024, 4096 and 8192 are recommended so that you will notice
  when things go wrong." The line is
  `log_error(LOG_LEVEL_REQUEST, "%s%s", http->hostport, http->path)`
  (`jcc.c:4409`; `:2848` is the https-inspection variant that prefixes
  `https://`). Destination only — no method, no bytes, no outcome.
- `debug 512` (`LOG_LEVEL_CLF`, `errlog.h:51`) — Common Log Format,
  `"%s - - [%T] \"%s\" %s %lu"` (client, request, status, size). Written
  from roughly two dozen sites, including every error path: `jcc.c:864`
  (normal completion), `:488`/`:534` (malformed request 400 /
  expectation-failed 417), `:856` and `:4260` (the https-inspection
  variants, which put the full `https://host/path` in the request field),
  `:3903`–`:4203` (upstream 502), `:1835` ("Invalid request").
- `debug 1024` (`LOG_LEVEL_CRUNCH`, `errlog.h:52`) — "Log the destination
  for requests Privoxy didn't let through, and the reason why", with a closed
  reason vocabulary `crunch_reason()` (`jcc.c:724`): `Blocked`,
  `Untrusted`, `Redirected`, `DNS failure`, `Forwarding failed`,
  `Connection failure`, `Connection timeout`, `No server data received`,
  `Out of memory (may mask other reasons)`, `No reason recorded`. Logged as
  `"<reason>: <url>"` (`jcc.c:863`).

Three details worth stealing or avoiding:

- **CLF lines are the one level emitted with no prefix at all** — every other
  level gets `<timestamp> <thread_id> <level>: ` (`errlog.c:711`:
  `if (loglevel != LOG_LEVEL_CLF)`). One output stream, two disciplines,
  chosen so stock CLF tooling still works — and `config` names the cost
  explicitly: "If you want to use pure CLF, you should set \"debug 512\" ONLY
  and not enable anything else." estige already lives with that split by
  design (d045 exempts it as httpd-style logging) and will live with it in a
  sharper form once structured session lines exist beside CLF lines.
- **The default is silence.** `debug` defaults to 0 — "only fatal errors
  (that cause Privoxy to exit)" — and the logfile documentation says the log
  "may be a privacy risk if third parties can get access to it. As most users
  will never look at it, Privoxy only logs fatal errors by default." A proxy
  that can see every URL ships logging off; we ship it on (d045), which is
  why retention is our problem to state (see Open questions).
- **Rotation is delegated to the OS** — "recommended to periodically rotate or
  shorten it … some require additional software to do it". The same sentence
  is true of `podman logs`, and nobody has written it down for estige.

_What transfers:_ the open/close split and the reason vocabulary; the
precedent that CLF coexists with differently-shaped lines in one stream.
_What does not:_ the level system — d045 forbids producer-side filtering, so
our equivalent control is what we log, not whether we log it.

### OpenVPN

Event lines plus a snapshot file, which is the closest analogue to our
in-flight problem (a session is a long-lived tunnel, not an HTTP exchange):

- `--status file [n]` writes operational status every `n` seconds
  (default 60). `--status-version 2` adds fields to the per-client list:
  Common Name, Real Address, Bytes Received, Bytes Sent, Connected Since,
  Virtual Address, Virtual IPv6 Address, Username, Client ID, Peer ID, Data
  Channel Cipher (version 3 is the same, tab-separated). For a
  point-to-point instance the file holds traffic statistics.
- `--verb 0..11`: 0 is fatal-only, 3 is the recommended summary, 5 prints
  R/W per packet, 6–11 is debug.

_What transfers:_ the split between the event log (connect/disconnect, with
who and from where) and the periodic snapshot (bytes, since-when); `Connected
Since` as a first-class field, i.e. the open timestamp is part of the record,
not implied by line order.
_What does not:_ the 60-second polling granularity as a _log_ mechanism — it
exists because OpenVPN has no HTTP surface to ask.

### Tailscale

Component-prefixed lines (`magicsock: disco: `, `derp: `) and a status
object per peer. `ipn/ipnstate/ipnstate.go` `PeerStatus` carries
`TxBytes`/`RxBytes`, `LastHandshake`, `LastWrite`, `LastSeen`,
`CurAddr`, `Relay`, `Online`, `Active`, `TailscaleIPs`. Two details
worth naming:

- The log layer has a **rate limiter** with an explicit exemption list
  (`types/logger/logger.go`, `rateFree`): "Things should not be added to
  this unless they're already limited otherwise or are critical for
  generating important stats from the logs." Volume control lives in the
  producer, and the lines that carry statistics are protected from it.
- `Active` is documented as vague on purpose ("somewhat undefined … there
  was some packet sent to this peer in the past two minutes"). Honest about
  being a heuristic rather than pretending to be a session state.

_What transfers:_ per-session timestamps (`LastHandshake`, `LastWrite`) are
cheap and answer "is it alive"; a rate-limit exemption list is the right shape
if session lines ever get noisy.
_What does not:_ there is no per-connection URL anywhere, because Tailscale is
an L3 VPN — the honest ceiling is endpoint plus bytes, which is also ours for
every TLS-carrying tunnel.

### Nebula

Structured `slog` with **per-host fields pre-bound once**
(`hostmap.go:932` `HostInfo.logger`): `vpnAddrs`, `localIndex`,
`remoteIndex`, and `certName` when a cert is known. Every later line from
that host inherits the identity without repeating lookup code. Outcome
vocabularies are structured, not prose:

- handshake events carry `handshake{stage, style}` plus `udpAddrs`,
  `initiatorIndex`, `durationNs` (`handshake_manager.go`),
- rehandshakes carry a `reason` from a fixed list — "local certificate
  removed", "message counter rehandshake threshold reached", …
  (`connection_manager.go:533-575`),
- teardown logs `Sending close tunnel message` with `vpnAddrs` and
  `udpAddr` (`control.go:358`), packet drops log `reason` at debug.

_What transfers:_ bind the identity fields once per session object and let
every line inherit them; keep reasons in a closed set; log the close event
with the peer identity rather than a bare "closed".
_What does not:_ pre-binding maps onto a session struct, which is the piece of
plumbing we do not have yet (sessions are bare goroutines today).

### ZeroTier

Snapshots, not connection logs: `service/OneService.cpp` `_peerToJson`
emits `address`, `version`, `role` (LEAF/MOON/PLANET), `latency`,
`isBonded`, `tunneled`, and a `paths[]` array with per-path
`address`, `lastSend`, `lastReceive`, `active`, `expired`,
`preferred`, `localSocket`, `localPort`, and — under bonding —
`latencyMean`, `latencyVariance`, `packetLossRatio`, `assignedFlowCount`,
`relativeQuality`. `_networkToJson` covers `status`, `mac`, `mtu`,
`allowDefault`, etc. Lifecycle arrives as events (`ZT_EVENT_UP`,
`ONLINE`/`OFFLINE` in `node/Node.cpp`, plus trace events).

_What transfers:_ the explicit `lastSend`/`lastReceive` ages — the cheapest
possible answer to "is this session alive"; per-path preference is the direct
analogue of our transport ladder, and it lives in the snapshot rather than the
log.
_What does not:_ per-network addressing detail, and the JSON-in-one-blob
approach (unreadable in `journalctl` without a pipe).

### Pritunl

Sits on OpenVPN and adds the one thing we deliberately lack: a user
directory. `pritunl/clients/clients.py` emits an audit event
`user_connection` ("User connected to \"%s\"") with `remote_addr`, and a
`user_connected` plugin event carrying `user_name`, `org_name`,
`platform`, `client_ver`, `ovpn_ver`, `device_id`, `device_name`,
`virtual_ip`, `virtual_ip6`, `remote_ip`, `mac_addr`.
`pritunl/server/instance_com.py:168` parses OpenVPN's management-interface
`bytecount` lines (`client_id, bytes_recv, bytes_sent`) into per-client
totals and periodic `user_bandwidth` points. `pritunl/logger/entry.py` is a
plain `{timestamp, message}` log entry.

_What transfers:_ the audit-event shape (who, from where, to which server, one
record) and per-client byte deltas as monitoring points rather than per-packet
logging.
_What does not:_ `user_name`/`device_name`/`platform` — d078 explicitly
declines to become a user directory. Our ceiling is the operator key id, which
is exactly why the hardcoded `who=operator` is a defect and not a
simplification.

### The convergent field set

Every one of the seven, in some spelling:

1. **who** (Squid `%[un`, Privoxy nothing, OpenVPN Common Name/Username,
   Tailscale peer, Nebula `certName`, ZeroTier address, Pritunl user)
2. **from where** (client address: `%>a`, `csp->ip_addr_str`, Real Address,
   `udpAddr`, `localPort`/`paths`)
3. **where to** (target/authority/origin — never payload)
4. **bytes both directions**
5. **time** — a timestamp plus a duration, or a start/since field
6. **a closed-vocabulary outcome or reason**

That list _is_ VPN-R19's contract. The defect this record is about is not a
missing requirement, it is that only one node emits it, only at the end, with
two of the six fields neutered (`who` a literal, time as a duration with no
start).

### What nobody logs, and why that agrees with VPN-R19

None of the seven logs payload, request bodies, or TLS plaintext; none claims
to know a scheme for an opaque tunnel (Squid logs the bare authority for
CONNECT); none logs a resolved IP in place of the name the client asked for
(Squid `%<a` is the _server_ address, not a resolver internal). The
conspicuous exception is the MITM-class proxy family (Privoxy's
`FEATURE_HTTPS_INSPECTION`, mitmproxy), which we deliberately are not
(VPN-R25, d103) — so our ceiling is their floor, and that is fine.
