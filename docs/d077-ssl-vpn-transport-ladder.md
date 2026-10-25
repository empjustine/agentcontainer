---
id: d077
type: architecture-design
status: adopted-in-part (mode D deployed; mode C built default-off; mode E unbuilt pending spike L4)
title: "d077 — tunnel modes C/D/E (h2 POST → wss → h1.1 POST) trusting external TLS, with SSE-carrier and inner-TLS studies"
parent: llm-reverse-proxy
depends-on: [d073, d031]
references: [d027, d047, d070, d071, d072]
tags: ["serving", "proxy", "vpn", "ssl-vpn", "http2", "websocket", "sse", "tailscale", "middlebox", "proposed"]
---

# d077 — Tunnel modes C/D/E, trusting external TLS

**Status:** proposed. This record refines d073 §5.1's single-transport choice
(`wss://` only) into three sibling tunnel **modes selected by protocol
negotiation** — **C** h2 POST streaming, **D** h1 WebSocket (the deployed v2),
**E** h1.1 POST stop-and-wait — with the letters running in preference order
C → D → E. It also re-letters d073's tunnel mode C to mode D (§9 — applied
across d073, the BRD note, README, and the tunnel code). Two studies
(SSE response carrier, TLS-inside-TLS) are analyzed but **not adopted**. No
code is decided here; adoption of Modes C/E is gated on §8's spikes.

## 1. Why three ordered modes

d073 solved feasibility against one middlebox posture: Tailscale Funnel, TLS
terminated at the edge, WebSocket upgrade passing through (its Verdict, §13's
S3). The actual deployment surface is wider, and hostile in different ways per
environment:

- **Upgrade-stripping API gateways** — `Connection`/`Upgrade` removal on
  `CONNECT`-alike traffic is common default policy. That kills Mode D (v2) at
  the handshake, before any byte moves.
- **h1-only ALPN** — older ingress offers only `http/1.1`; HTTP/2 clients must
  degrade, and the mux/full-duplex properties come with h2, not with us.
- **Response-buffering proxies** — anonymous `chunked` responses get held; a
  streaming tunnel direction dies of latency or of a flush that never comes.
- One transport assumption per client means a support call per environment;
  an ordered family makes the fallback a code path.

The order C → D → E makes *compatibility probability and performance agree*:
the mechanism modern gateways pass is also the fastest, and the floor
degrades last.

## 2. Evidence base (measured vs. synthesized vs. repo-verified)

Claims in §3–§5 cite E-numbers here; items without evidence are §8 spikes.

- **E1 — measured (2026-10-24, this deployment's Funnel edge).** The edge
  negotiates h2:

  ```
  $ openssl s_client -connect bazzite.coelacanth-barb.ts.net:443 \
        -servername bazzite.coelacanth-barb.ts.net -alpn h2,http/1.1
  ALPN protocol: h2
  $ curl --http2 https://bazzite.coelacanth-barb.ts.net/
  * ALPN: server accepted h2   * using HTTP/2   [HTTP/2] stream OPENED
  ```

- **E2 — synthesized from `tailscale/tailscale` source by DeepWiki
  (THIRD-PARTY; verify against the deployed tailscale version).** Verifiable
  anchors named by the synthesis: `serveTLSNextProtos()` offers `h2` +
  `http/1.1`; `serveWebHandler` proxies via `httputil.ReverseProxy`
  (`TestServeWebHandlerHTTP2PreservesContentType`,
  `TestServeProxyHTTP2PreservesContentType` — chunked bodies tested);
  WebSocket `Connection: Upgrade` passes the same proxy; **the Funnel
  edge→localhost hop is HTTP/1.1** (`shouldProxyViaH2C` gates h2c to gRPC
  content only); Funnel serves TCP ports 443/8443/10000.
- **E3 — repo-verified.** d073 spike S3's verdict: the `101` passes
  `ReverseProxy` + `loggingResponseWriter` (CLF records 101); Go stdlib
  `ReverseProxy` upgrade/hijack behavior on the pinned Go version.

Unverified by anything above: SSE media type through Funnel (L1), concurrent
h2 streams through Funnel's proxy (L3), and any property of the work
environment's gateways (L2, L4).

## 3. The three modes

All three trust the external TLS: d073 §7's certificate table, VPN-R28/R29/R55
apply unchanged, and there is no inner cryptographic layer — see §3.0.

### 3.0 Trust posture (read before the modes)

The family inherits d073's trust model exactly: TLS terminates at the Funnel
edge; the client validates the edge certificate against **system roots** with
no skip knob; between client and edge, anything that terminates TLS sees the
bearer credential and the capability path in plaintext. That exposure is
accepted for v2 today and remains accepted here; the countermeasures are
VPN-R44 (credential lives only in the environment, prefix never logged —
digest only) and the camouflage 404 (VPN-R34). What would change this posture
— and why it is deliberately not changed — is §7 (Study B, inner TLS).

### Mode C — HTTP/2 POST streaming (preferred when ALPN offers h2)

- **Shape.** One long-lived `POST` per local TCP connection on the same
  capability path: streaming request body (client→target bytes) and streaming
  response body (target→client bytes) open concurrently — legal and full-duplex
  within an h2 stream. h2's stream id is the demuxer; no `Upgrade` header ever
  appears on the wire, which sidesteps the most-filtered mechanism entirely
  (§1).
- **Server-side reality (E2).** Funnel's edge→localhost hop delivers h1.1
  requests regardless of what the public leg negotiated. The server therefore
  implements Mode C as *concurrent streaming HTTP handlers* — one goroutine per
  request, bodies forwarded unbuffered — and the h2 benefit (multiplexing, no
  head-of-line blocking, no upgrade) lives purely on the public leg. Direct-h2
  serving (no Funnel) would need no server change: `net/http` negotiates h2
  only when it terminates TLS itself, which the server never does (VPN-R25).
- **Framing.** `tunnelproto` frames ride in the bodies (§5). Half-close is
  the existing `CLOSE` frame (VPN-R18) — no HTTP-level trailer/EOF tricks,
  because h1.1 trailers across Funnel's proxy hop are unproven.
- **traceparent.** `trace-id` = local-connection identity for cross-hop
  logging (designed-to-be-logged, the mirror image of the scrubbed prefix);
  `span-id` changes per request hop, per W3C semantics. `tracestate`: unused
  initially (every propagated header is another mangle/log surface — YAGNI).
- **Status:** built and tested (mode C suite: a full session through an h2
  front to an h1.1 backend — E2's shape — plus six concurrent sessions and
  the camouflage 404s), but **off by default**: the client offers it only
  when `-modes` includes `c` (the flag defaults to `d`), so spikes gate
  adoption — L3 decides when Mode C takes traffic (§8).

### Mode D — HTTP/1.1 WebSocket (the deployed v2, unchanged)

- Exactly d073 §5.1–§5.3 as implemented: `tunnelproto` over an RFC 6455
  subset, one `wss` per CONNECT (VPN-R17), handshake-header auth (VPN-R12),
  keepalive/idle (VPN-R14), reverse-proxy upgrade (VPN-R13, E3). **Zero
  changes**; it is the middle mode, not a rewrite.
- Reached when ALPN yields `http/1.1` and the upgrade probe answers `101`.
  WS-over-h2 (RFC 8441) is **not** assumed to exist anywhere on the path.
- **Status:** built and tested (v2 suite).

### Mode E — HTTP/1.1 POST, stop-and-wait (the floor)

- **Shape.** No upgrade, no h2, no long-lived single connection: sequential
  `POST` transactions carry the tunnel. `traceparent` changes meaning
  versus Mode C — here it is the **real demux**: `trace-id` groups the sequential
  POSTs belonging to one local connection, `span-id` is the sequence position,
  and the first (bearer-authed) POST mints per-`trace-id` server state (the
  target connection) under the same bounded-idle discipline as v2 (VPN-R39:
  reap, never leak). Unknown `trace-id` → camouflage 404.
- **Response direction** is streamed; media type `text/event-stream` is the
  *preferred* framing for the anti-buffering and resume reasons in §6 —
  pending L1/L4, so the mode is specified media-type-neutral today.
- **Cost (accepted).** One round trip per exchange on a latency-accumulating
  path (Funnel edge + gateway buffer policy). This mode exists for
  correctness-through-hostile-h1 environments, not speed.
- **Failure.** A gateway that buffers until completion or drops the stream
  trips the mode timeout → the client answers locally (502/400) — VPN-R26
  fail-closed, never a direct dial.
- **Open detail:** the exact exchange mechanics (long-lived request body with
  streamed response vs. per-exchange request/response windowing) are settled
  by L4 measurements, not by this record.
- **Status:** not built.

## 4. Negotiation — protocol, not path

The mode is set by **protocol negotiation**, never by path: one Funnel path
serves the whole family, and ALPN/`Upgrade`/method are what separate C, D,
and E (§9 restates what this claims against VPN-R42). Per tunnel session,
decided once, **sticky**:

```
dial TLS ── ALPN ─┬─ h2        → Mode C (upgrade never attempted on this conn)
                  └─ http/1.1  → probe upgrade once ─┬─ 101 → Mode D
                                                     └─ refusal/failure → Mode E
```

- **Unbuilt modes are blocked modes.** Routing around an implementation we
  have not built is the same code path as routing around a path that refuses
  it: the ALPN offer set — the client's `-modes` flag is that offer, in
  letters — and the upgrade probe include only built modes, so
  an unbuilt Mode C never surfaces as a failed h2 session and an unbuilt
  Mode E never surfaces as a failed exchange — the client demotes to the next
  built mode exactly as it would for a censored mechanism. Built modes stay
  available throughout; fail-closed (VPN-R26) applies only when no built mode
  remains. The default offer is Mode D only (`-modes` defaults to `d`), so
  today this is the normal path, not an edge case.
- Demotion never reverses within a client session; the chosen mode is logged
  as a `transport` outcome field (h2 | wss | post) — transport choice is
  operational debugging data, not a secret.
- **Re-probe policy on network change** is open (a laptop crossing networks
  should not latch a demotion from a bad network for the process's life; the
  cheap version is restart-latched, the good version is per-gateway-identity).
- **Why not one path per mode.** A distinct path per mode would turn the
  transport choice into a route the edge config must expose and a filterable
  handle, and would split the camouflage namespace. Funnel keeps mapping
  **one path** to the tunnel (VPN-R42 intact); the handler branches on
  ALPN/method/`Upgrade`/`traceparent` presence. R42 constrains *Funnel
  configuration*, not handler-internal dispatch.

## 5. What every mode shares (the non-transport contract)

Modes are byte-pipes; everything above the pipe is identical:

- **Auth:** per-request constant-time bearer on every HTTP request of every
  mode (VPN-R12's *intent* — R12's handshake-header wording applies to Mode D);
  camouflage 404 before anything is hijacked or opened (VPN-R31–R34).
- **Framing:** `tunnelproto` frames in request/response bodies (Modes C/E) or
  in the WS message stream (Mode D). Frame vocabulary, `CLOSE` half-close,
  keepalive and idle reap semantics carry across modes unchanged
  (VPN-R17–R19).
- **Egress:** resolve-once-pin-dial, IP-literal refusal, port/deny tables —
  `dialValidated` and friends are mode-independent (VPN-R20/21/22/35–R38).
- **Client surface:** HTTP CONNECT + SOCKS5 listeners, `/healthz`, fail-closed
  refusal (VPN-R23/26/27) — never sees which mode is live.
- **One carrier implementation per mode** of the session's `tunnelStream`
  interface — read/write exactly one framed message, a read deadline, a
  violation signal, a transport tag — feeding the same handshake and relay
  pump. The interface is message-shaped, not byte-shaped, because a mode's
  message boundary *is* its transport fact: WS messages arrive framed, body
  carriers delimit with the length prefix (§3), and `protocolViolation` /
  `transport()` hold vocabulary the relay must not know (close frame vs.
  body end; `h2` | `wss` | `post`). That is the whole implementation surface
  delta between modes.

## 6. Study A — `text/event-stream` as the Mode E response carrier (recorded; partially adopted)

**Thesis:** Mode E's response direction should *declare* SSE rather than
anonymous `chunked`.

- **Gain 1 — the anti-buffering norm.** SSE is the one streaming content type
  gateways are *expected* to pass unbuffered (`Cache-Control: no-cache`,
  `X-Accel-Buffering: no` are conventions, not hacks; dashboards/chats/tickers
  run on it). Gateways that buffer anonymous chunked bodies often have an
  explicit SSE passthrough mode. This may decide whether Mode E works at all.
- **Gain 2 — boredom as camouflage.** The surface reads as a live-feed
  subscription on a legitimate LE-certified `*.ts.net` endpoint — the 404
  policy's "nothing distinctive" extended to the streaming direction
  (llm-reverse-proxy/DESIGN.md).
- **Gain 3 — a standardized resume contract.** `id:`/`Last-Event-ID` is SSE's
  built-in reconnect semantics; mapping `trace-id` → stream, `span-id` →
  event id gives Mode E's stateful continuation for free, with bearer re-auth
  on every request as today.
- **Costs:** `data:` framing forces base64 (~33% — acceptable, Mode E is the
  slow mode); the stream must be *conformant* (a malformed SSE stream is its
  own signature); and SSE is framing, not concealment — under a
  TLS-terminating interceptor the content is plaintext regardless (§3.0).
- **Evidence status:** E2 establishes Funnel's ReverseProxy streams bodies;
  it cites no SSE-specific test. Funnel-carrier SSE is spike **L1**.
- **Verdict:** preferred response media type for Mode E, adopted in *intent*
  only; Mode C/D framing is untouched (h2 DATA frames and WS frames need no
  media-type norm).

## 7. Study B — TLS inside the family's TLS (recorded; NOT adopted)

**Thesis:** splice an inner TLS session across the family's byte-pipe, so a
middlebox that terminates the *outer* TLS still cannot read the tunnel —
and, because the inner session authenticates the real server, cannot
transparently substitute itself either.

**Layering:** outer = any mode as carrier (SSE/POST byte-pipe); inner = a TLS
session carried as payload bytes, exposed locally as a `net.Conn`; tunnel
protocols (even Mode D's WebSocket upgrade) then negotiate *inside* the inner
session where no gateway parses them. The capability path and bearer travel
only inside inner TLS.

**Adversary matrix** (the framing question: "if outer TLS is broken, the
traffic is suspect anyway — should it just be broken?"):

| interceptor posture | family (§3) alone | + inner TLS |
|---|---|---|
| arbitrary rule-blocks (path/token/keyword matching — the named threat) | **exposed** — plaintext post-MITM, rule-matchable | **defeats it** — zero inspectable content |
| active DPI (payload fingerprinting) | classifiable | TLS-in-TLS fingerprint → classify-and-block |
| destination-layer (SNI/DNS of `*.ts.net`) | dead | dead |

**The non-negotiable condition:** inner TLS must validate against a **pinned
trust anchor** (the Funnel chain — e.g. ISRG Root X1 only), **never system
roots**. If the corporate CA is in the trust set the interceptor re-signs the
inner handshake and the layer buys nothing — a false sense of the protection
just added. Pinned anchor means: no MITM → inner validates (redundant,
harmless); MITM → inner fails → fail-closed (VPN-R26), unless the interceptor
forwards blindly, in which case it works and reads nothing.

**Costs:** (a) an inner ClientHello inside POST/SSE payloads is a known
fingerprint an *active* DPI drops — but that adversary could equally drop the
capability path today, so the trade is "readable + rule-matchable" →
"opaque + classifiable", which is the right direction for arbitrary blocks;
(b) +1 RTT per tunnel setup (resumption amortizes); (c) the carrier's physics
do not improve — inner TLS carries records over stop-and-wait as-is;
(d) under a corp-CA MITM the inner handshake *fails closed*, turning today's
transparent-but-readable tunnel into a blocked one — a deliberate policy
choice, consistent with the framing question above.

**Verdict: not adopted.** This would be a deliberate change of §3.0's trust
posture, justified only by evidence that content rules at the interceptor
actually read the capability path/token. Trigger to re-open: a gateway log or
policy showing path/token-based blocking of this tunnel (L5).

## 8. Spikes (each gates a mode or study item)

- **L1 — Funnel SSE.** `text/event-stream` streamed through Funnel
  end-to-end (gap in E2). **Pass bar:** a chunk written by the server arrives
  at the client within **33 ms** of the write — one 30 fps frame interval;
  added delay below that is indistinguishable from network jitter, so 33 ms
  is the line between "streaming" and "buffering". Sustained ≥33 ms means
  Funnel's leg buffers regardless of media type: Study A's anti-buffering
  gain (§6) then rests on the gateway legs alone, and Mode E stays
  media-type-neutral for this path.
- **L2 — gateway posture.** Three measurements against the work ingress:
  (1) ALPN offer — `openssl s_client -connect "$INGRESS" -servername
  "$INGRESS" -alpn h2,http/1.1`, expecting `h2`; (2) `Upgrade`
  pass-through — an RFC 6455 handshake `curl` with the capability path and
  bearer, expecting `101` (unauthenticated control: expecting camouflage
  404, VPN-R34); (3) streaming flush — a timed two-chunk stream, arrival gap
  judged by L1's 33 ms bar. **Working expectation: all three pass.** The
  restricted work environment is expected to offer h2 and pass the upgrade,
  so Modes C and D are both reachable there and L2 confirms rather than
  discovers; a deviation reorders §9's build order. L2 decides which mode the
  work environment will *use* (and therefore which to build first), not which
  mode is preferred.
- **L3 — Mode C concurrency.** N ≥ 6 concurrent streaming POSTs through
  Funnel → N concurrent h1.1 backend requests with bodies streamed and
  overlapping in time (verifies E2's key claim live). N = 6: a browser's
  parallel-connection count — the load this environment's clients actually
  generate.
- **L4 — Mode E timing.** Measured round-trip cost incl. gateway buffering
  (buffering judged against L1's 33 ms bar); sets Mode E's exchange mechanics
  and chunk size.
- **L5 — inner-handshake tolerance** (Study B only; fires on §7's trigger).

## 9. Relationship to d073 and delivery

- d073 is `proposed`, and its §5.1 VPN-R11 already carries a "Transport
  revision (proposed)" pointer here. This record does not lean on that
  pointer alone: every claim it makes that goes beyond d073 as written is
  restated below with its citation, so the deltas are checkable without
  re-reading the family:
  - **Re-lettering** — d073's tunnel mode (CONNECT-over-WSS) becomes
    **Mode D**; **Mode C** is the new h2-POST mode and **Mode E** the h1-POST
    floor, so the letters run in preference order C → D → E (d073 §2 table,
    §5/§6 headings, VPN-R11). Delivery phrasing changes from "v2 = mode A +
    mode C" to "v2 = mode A + mode D" (d073 §2, §16). The re-letter has been
    applied: d073, the BRD note, README, and the tunnel code (comments,
    identifiers, and the config key, now `tunnel`) read Mode D for the
    `wss://` shape.
  - **Transport exclusivity** — VPN-R11's "MUST be `wss://`" becomes "Mode D
    MUST be `wss://`; the tunnel transport MUST be one of the negotiated
    modes C/D/E", with Mode D binding v2 as built (d073 §5.1, VPN-R11).
  - **Scope of d073's Mode C requirement block** — R11–R30, written as
    "Mode C MUST …", scope the whole family C/D/E from here; the
    transport-shaped ones (R11's wss shape, R12's handshake auth, R13's
    upgrade hijack, R14's upgrade keepalive) bind Mode D as written and bind
    Modes C/E through §5's analogues (d073 §5–§7).
  - **Auth placement** — VPN-R12 puts the credential on the WebSocket
    handshake; Modes C/E carry the same credential as a per-request
    constant-time `Authorization` on every HTTP request (d073 §5.1,
    VPN-R12). The rule itself is unchanged: authenticate before relaying
    anything, camouflage 404 otherwise (VPN-R12, VPN-R34).
  - **Dispatch** — VPN-R42's "mode dispatch is by PATH only" keeps its
    meaning for *namespace* selection (A vs B vs the tunnel path); the C/D/E
    split inside that path is protocol negotiation, not path (§4). R42
    constrains Funnel configuration, not handler-internal branching (d073
    §10, VPN-R42).
  All other requirements stand as written.
- Delivery: Mode D shipped with v2; Mode C is now built but opt-in
  (`-modes` default `d` — L3 gates the default, §8); Mode E still builds
  when a deployment environment needs it, L4 first. L2 decides which mode
  the work environment *uses*, not all three (§8).
- Spikes S1/S2 (d073 §13) remain the Funnel-lifetime/streaming baseline for
  Mode D; L1–L4 are additive and do not replace them.