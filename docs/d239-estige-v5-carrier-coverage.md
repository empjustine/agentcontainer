---
id: d239
type: module-design
status: active
title: "d239 — estige v5's carrier coverage: h1.1-post-windowed retires, the channel ships on the three carriers that can carry it"
parent: estige
depends-on: [d169, d236, d077, d108]
references: [d093, d171, d222, d238]
tags: ["estige", "v5", "mtls", "carriers", "decisions"]
---

# d239 — estige v5's carrier coverage

This record closes the question d236 left open for the two windowed carriers:
how the inner TLS session is placed on them. It reverses d236's per-window
sentence for `h1.1-post-windowed`, retires that carrier, and keeps the
per-window session on `h2-post-windowed`. d236 stays the v5 record; where this
one contradicts it, this one binds.

## Status

Accepted. The implementation lands with it; docs/d236's amendment map points
here.

## Problem

d236 said: "Each window therefore carries its own proof and its own TLS
handshake. A TLS session does not span windows." The implementer of that
sentence met a carrier-physics wall, not an aesthetic one.

A TLS handshake is bidirectional: the client's `ClientHello` needs the
server's flight back before the client can send `Finished` and application
data. `h2-post-windowed` has a bidirectional window — h2 is full duplex, and
the exit may answer while the request body is still open — so one window can
carry one complete handshake. `h1.1-post-windowed` does not: its whole shape is
"drain the request body to EOF, then answer", which is why the carrier exists
for edges that buffer. In that window the server cannot write anything before
the body ends, so a handshake cannot complete inside it.

Measured, not reasoned: an implementation that forced `h1.1-post-windowed`
full duplex (respond before the body is read) and primed the response with an
empty frame passed only while the exit handler was called in-process. Behind a
real reverse-proxying gateway — the deployment the carrier exists for — the
inner handshake timed out and every session died with `502`. The earlier
test suite had hidden this by deleting the gateway hop and calling the handler
directly.

Three continuations exist, and two of them were rejected:

- **Serve `h1.1-post-windowed` without the channel.** A silent downgrade: the
  one carrier most likely to cross a hostile middlebox would be the one whose
  bytes are unprotected, and no client could tell.
- **One inner session spanning the windows for both carriers.** Sound — the
  frame layer already delivers ordered, exactly-once bytes, so a TLS record
  layer over it needs no per-window state — but it contradicts d236's
  requirement for the carrier that CAN honour it, giving up per-window
  freshness where it is free.
- **Retire the carrier.** The floor loses its last rung, and the fix is a
  stated fail-closed refusal instead of a silently unprotected session.

## Decision

**v5 serves three carriers**, each with the inner session d169 designed:

| carrier           | channel placement                          |
| ----------------- | ------------------------------------------ |
| h2-post-unbounded | one session per admitted tunnel            |
| websocket         | one session per admitted tunnel            |
| h2-post-windowed  | one session per window, handshake included |

**`h1.1-post-windowed` retires from v5.** The relay no longer offers it, and an
exit that receives its shape (a POST with `Traceparent` and no
`h2-post-windowed` window header) answers the camouflage 404 after admission
and logs the retirement, exactly like any other refusal a peer cannot
distinguish (VPN-R34). There is no fallback, no downgrade and no
environment-free re-enable.

The h1.1 plane is not left without a tunnel: the **websocket** carrier is an
h1.1 `GET` upgrade, so any edge that passes upgrades still has a carrier. What
retires is the upgrade-_stripping_ floor.

### Why each window carries a full handshake on h2-post-windowed

The window is the carrier's unit of loss: an edge may end a window, and the
relay opens the next one. Tying record-layer state to the window means a lost
window can never strand the next one on a session whose sequence state the
peer no longer holds. The price — one handshake per window instead of one per
tunnel — is bounded by the window budget (the same budget that already pays a
request round trip), and the handshake never leaves the window: a window's
`ClientHello` and the exit's flight are framed bytes in that one exchange.

### What the retirement costs

- An edge that strips upgrades **and** offers no h2 has no carrier. That
  combination is d093-era folklore's "hostile gateway"; d238 records that the
  fleet's real edges speak h2 or pass upgrades, and d222's capped-edge port
  covers the body-capping case.
- The demotion ladder ends at `h2-post-windowed`. An endpoint that refuses all
  three rungs fails closed (VPN-R26) instead of falling through to an
  unprotected carrier.
- `d171`'s degraded postures are unchanged in kind: `-insecure-exit` skips the
  _outer_ leg's verification and accepts a cleartext `ws://` endpoint; the
  inner session, whose trust anchor is the pinned certificate, never degrades.

## Requirement deltas

- **VPN-R26 (fail closed)** — the retired carrier's refusal is the camouflage
  404, and the relay's ladder has no rung below the three channel-bearing
  carriers.
- **VPN-R34 (camouflage)** — unchanged: the retirement is invisible to a peer
  that cannot present an admitted proof, because admission runs first.
- **d169's "every rung of the ladder (modes C, D and E)"** — the ladder is
  now C, websocket and D. E's identity is retired, not its requirement: no
  carrier serves unprotected bytes.

## Amendment map

- **d236** — its "Channel placement and liveness" paragraph loses "each window
  … its own TLS handshake" as a rule for every windowed carrier; the rule is
  h2-post-windowed's, and the h1.1 carrier retires. Its container "Open
  details" are resolved in the same implementation change and recorded there.
- **d169** — its "on every rung of the ladder" sentence is bounded by this
  record; its Status moves to implemented-with-d239.
- **d108** — v5's generation row states what shipped: three carriers, one
  retired.
- **d105** — the carrier vocabulary loses `h1.1-post-windowed`; a retired name
  is not a carrier.
- **The living deployment surfaces** that list the transports move with it:
  `docs/environments-and-variants.md`'s estige row, `estige/README.md`, and
  `docs/architecture.md` name the three carriers and say the floor retired.

## Verification

`go test ./...` in `estige/` covers: the per-window handshake across three
windows of a 17 MiB upload through a real h2 reverse proxy; the retired
carrier's camouflage refusal; the relay's ladder ending at
`h2-post-windowed`; the exit proof on every carrier and window; replayed
proofs refused on both ends; a wrong exit pin stopping the ladder; expired and
not-yet-valid channel certificates failing the handshake; and a tampered
record ending the session.

## Alternatives rejected

- **Serve the floor unprotected** — the silent downgrade the whole channel
  exists to prevent.
- **Force full duplex on the h1.1 window** — works only without a gateway in
  the path, which is the one place the carrier is used; the measurement above.
- **Keep the carrier behind an environment switch** — a switch that turns off
  the channel for a carrier is exactly the downgrade d236 forbids, and there is
  no honest way to label the session as protected.
