---
id: d077
type: architecture-design
status: proposed
title: "d077 — Mode C transport ladder (h2 POST → h1+WSS → h1 POST) trusting external TLS, with SSE-carrier and inner-TLS studies"
parent: llm-reverse-proxy
depends-on: [d073, d031]
references: [d027, d047, d070, d071, d072]
tags: ["serving", "proxy", "vpn", "ssl-vpn", "http2", "websocket", "sse", "tailscale", "middlebox", "proposed"]
---

# d077 — Mode C transport ladder, trusting external TLS

**Status:** proposed. This record refines d073 §5.1's single-transport choice
(`wss://` only) into a three-tier transport ladder for Mode C, and records two
studies (SSE response carrier, TLS-inside-TLS) that are analyzed but **not
adopted**. No code is decided here; adoption of T1/T3 is gated on §8's spikes.

## 1. Why a ladder

d073 solved feasibility against one middlebox posture: Tailscale Funnel, TLS
terminated at the edge, WebSocket upgrade passing through (its Verdict, §13's
S3). The actual deployment surface is wider, and hostile in different ways per
environment:

- **Upgrade-stripping API gateways** — `Connection`/`Upgrade` removal on
  `CONNECT`-alike traffic is common default policy. That kills T2 (v2) at the
  handshake, before any byte moves.
- **h1-only ALPN** — older ingress offers only `http/1.1`; HTTP/2 clients must
  degrade, and the mux/full-duplex properties come with h2, not with us.
- **Response-buffering proxies** — anonymous `chunked` responses get held; a
  streaming tunnel direction dies of latency or of a flush that never comes.
- One transport assumption per client means a support call per environment;
  a ladder makes the fallback a code path.

The ladder is ordered so that *compatibility probability and performance
agree*: the mechanism modern gateways pass is also the fastest, and the floor
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

## 3. The three tiers

All three trust the external TLS: d073 §7's certificate table, VPN-R28/R29/R55
apply unchanged, and there is no inner cryptographic layer — see §3.0.

### 3.0 Trust posture (read before the tiers)

The ladder inherits d073's trust model exactly: TLS terminates at the Funnel
edge; the client validates the edge certificate against **system roots** with
no skip knob; between client and edge, anything that terminates TLS sees the
bearer credential and the capability path in plaintext. That exposure is
accepted for v2 today and remains accepted here; the countermeasures are
VPN-R44 (credential lives only in the environment, prefix never logged —
digest only) and the camouflage 404 (VPN-R34). What would change this posture
— and why it is deliberately not changed — is §7 (Study B, inner TLS).

### T1 — HTTP/2 POST streaming (preferred when ALPN offers h2)

- **Shape.** One long-lived `POST` per local TCP connection on the same
  capability path: streaming request body (client→target bytes) and streaming
  response body (target→client bytes) open concurrently — legal and full-duplex
  within an h2 stream. h2's stream id is the demuxer; no `Upgrade` header ever
  appears on the wire, which sidesteps the most-filtered mechanism entirely
  (§1).
- **Server-side reality (E2).** Funnel's edge→localhost hop delivers h1.1
  requests regardless of what the public leg negotiated. The server therefore
  implements T1 as *concurrent streaming HTTP handlers* — one goroutine per
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
- **Status:** not built.

### T2 — HTTP/1.1 WebSocket (the deployed v2, unchanged)

- Exactly d073 §5.1–§5.3 as implemented: `tunnelproto` over an RFC 6455
  subset, one `wss` per CONNECT (VPN-R17), handshake-header auth (VPN-R12),
  keepalive/idle (VPN-R14), reverse-proxy upgrade (VPN-R13, E3). **Zero
  changes**; it is the second tier, not a rewrite.
- Reached when ALPN yields `http/1.1`. WS-over-h2 (RFC 8441) is **not**
  assumed to exist anywhere on the path.
- **Status:** built and tested (v2 suite).

### T3 — HTTP/1.1 POST, stop-and-wait (the floor)

- **Shape.** No upgrade, no h2, no long-lived single connection: sequential
  `POST` transactions carry the tunnel. `traceparent` changes meaning
  versus T1 — here it is the **real demux**: `trace-id` groups the sequential
  POSTs belonging to one local connection, `span-id` is the sequence position,
  and the first (bearer-authed) POST mints per-`trace-id` server state (the
  target connection) under the same bounded-idle discipline as v2 (VPN-R39:
  reap, never leak). Unknown `trace-id` → camouflage 404.
- **Response direction** is streamed; media type `text/event-stream` is the
  *preferred* framing for the anti-buffering and resume reasons in §6 —
  pending L1/L4, so the tier is specified media-type-neutral today.
- **Cost (accepted).** One round trip per exchange on a latency-accumulating
  path (Funnel edge + gateway buffer policy). This tier exists for
  correctness-through-hostile-h1 environments, not speed.
- **Failure.** A gateway that buffers until completion or drops the stream
  trips the tier timeout → the client answers locally (502/400) — VPN-R26
  fail-closed, never a direct dial.
- **Open detail:** the exact exchange mechanics (long-lived request body with
  streamed response vs. per-exchange request/response windowing) are settled
  by L4 measurements, not by this record.
- **Status:** not built.

## 4. Negotiation — a decision tree, not a flat list

Per tunnel session, decided once, **sticky**:

```
dial TLS ── ALPN ─┬─ h2        → T1 (upgrade never attempted on this conn)
                  └─ http/1.1  → probe upgrade once ─┬─ 101 → T2
                                                     └─ refusal/failure → T3
```

- Demotion never reverses within a client session; the chosen tier is logged
  as a `transport` outcome field (h2 | wss | post) — transport choice is
  operational debugging data, not a secret.
- **Re-probe policy on network change** is open (a laptop crossing networks
  should not latch a demotion from a bad network for the process's life; the
  cheap version is restart-latched, the good version is per-gateway-identity).
- Dispatch stays inside the tunnel handler: Funnel maps **one path** to the
  tunnel (VPN-R42 intact); the handler branches on method/`Upgrade`/`traceparent`
  presence. R42 constrains *Funnel configuration*, not internal dispatch.

## 5. What every tier shares (the non-transport contract)

Tiers are byte-pipes; everything above the pipe is identical:

- **Auth:** per-request constant-time bearer on every HTTP request of every
  tier (VPN-R12's *intent* — R12's handshake-header wording applies to T2);
  camouflage 404 before anything is hijacked or opened (VPN-R31–R34).
- **Framing:** `tunnelproto` frames in request/response bodies (T1/T3) or in
  the WS message stream (T2). Frame vocabulary, `CLOSE` half-close, keepalive
  and idle reap semantics carry across tiers unchanged (VPN-R17–R19).
- **Egress:** resolve-once-pin-dial, IP-literal refusal, port/deny tables —
  `dialValidated` and friends are tier-independent (VPN-R20/21/22/35–R38).
- **Client surface:** HTTP CONNECT + SOCKS5 listeners, `/healthz`, fail-closed
  refusal (VPN-R23/26/27) — never sees which tier is live.
- **One `io.ReadWriteCloser` implementation per tier** feeding the same relay
  pump; that is the whole implementation surface delta between tiers.

## 6. Study A — `text/event-stream` as the T3 response carrier (recorded; partially adopted)

**Thesis:** T3's response direction should *declare* SSE rather than anonymous
`chunked`.

- **Gain 1 — the anti-buffering norm.** SSE is the one streaming content type
  gateways are *expected* to pass unbuffered (`Cache-Control: no-cache`,
  `X-Accel-Buffering: no` are conventions, not hacks; dashboards/chats/tickers
  run on it). Gateways that buffer anonymous chunked bodies often have an
  explicit SSE passthrough mode. This may decide whether T3 works at all.
- **Gain 2 — boredom as camouflage.** The surface reads as a live-feed
  subscription on a legitimate LE-certified `*.ts.net` endpoint — the 404
  policy's "nothing distinctive" extended to the streaming direction
  (llm-reverse-proxy/DESIGN.md).
- **Gain 3 — a standardized resume contract.** `id:`/`Last-Event-ID` is SSE's
  built-in reconnect semantics; mapping `trace-id` → stream, `span-id` →
  event id gives T3's stateful continuation for free, with bearer re-auth on
  every request as today.
- **Costs:** `data:` framing forces base64 (~33% — acceptable, T3 is the slow
  tier); the stream must be *conformant* (a malformed SSE stream is its own
  signature); and SSE is framing, not concealment — under a
  TLS-terminating interceptor the content is plaintext regardless (§3.0).
- **Evidence status:** E2 establishes Funnel's ReverseProxy streams bodies;
  it cites no SSE-specific test. Funnel-carrier SSE is spike **L1**.
- **Verdict:** preferred response media type for T3, adopted in *intent*
  only; T1/T2 framing is untouched (h2 DATA frames and WS frames need no
  media-type norm).

## 7. Study B — TLS inside the ladder's TLS (recorded; NOT adopted)

**Thesis:** splice an inner TLS session across the ladder's byte-pipe, so a
middlebox that terminates the *outer* TLS still cannot read the tunnel —
and, because the inner session authenticates the real server, cannot
transparently substitute itself either.

**Layering:** outer = any tier as carrier (SSE/POST byte-pipe); inner = a TLS
session carried as payload bytes, exposed locally as a `net.Conn`; tunnel
protocols (even T2's WebSocket upgrade) then negotiate *inside* the inner
session where no gateway parses them. The capability path and bearer travel
only inside inner TLS.

**Adversary matrix** (the framing question: "if outer TLS is broken, the
traffic is suspect anyway — should it just be broken?"):

| interceptor posture | ladder (§3) alone | + inner TLS |
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

## 8. Spikes (each gates a tier or study item)

- **L1 — Funnel SSE.** `text/event-stream` streamed through Funnel unbuffered
  end-to-end (gap in E2).
- **L2 — gateway posture.** Three commands against the work ingress: ALPN
  offer, `Upgrade` pass-through, streaming flush behavior. Decides which tier
  the work environment lands on.
- **L3 — T1 concurrency.** N concurrent streaming POSTs through Funnel →
  N concurrent h1.1 backend requests with bodies streamed (verifies E2's key
  claim live).
- **L4 — T3 timing.** Measured round-trip cost incl. gateway buffering; sets
  T3's exchange mechanics and chunk size.
- **L5 — inner-handshake tolerance** (Study B only; fires on §7's trigger).

## 9. Relationship to d073 and delivery

- d073 is `proposed`; **this record proposes amending VPN-R11's exclusive
  MUST** ("MUST be `wss://`") to "MUST be one of T1/T2/T3", with T2 binding
  for v2 as built. All other Mode C requirements stand as written.
- Delivery order is not decided here: T2 exists; T1 and T3 build when a
  deployment environment needs them (L2 first — build the tier the real
  gateway forces, not all three).
- Spikes S1/S2 (d073 §13) remain the Funnel-lifetime/streaming baseline for
  T2; L1–L4 are additive and do not replace them.
