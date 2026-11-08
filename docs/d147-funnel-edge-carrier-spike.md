---
id: d147
type: module-design
status: active
title: "d147 — spike: bidirectional h1.1 and h2 carriers through the funnel/serve edge, measured"
parent: estige
depends-on: [d077, d145]
references: [d073]
tags: [estige, tunnel, spike, transport, funnel, v4]
---

# d147 — spike: bidirectional h1.1 and h2 carriers through the funnel/serve edge, measured

This record is a spike in the d073 tradition: a measurement that blocks a
decision, with the numbers carried in the record so the decision does not
rest on a rerun. It answers the carrier question
[d145](d145-relay-remote-port-forwarding.md) leaves open — which ladder
rung carries the ACCEPT's event pipe, and whether the h1.1 held-open
variant proposed alongside it is feasible — by measuring a bidirectional
byte exchange through the live funnel/serve edge with the relay's own
client shape. The decision it informs: no held-open h1.1 rung for funnel
paths; the h2 rung is measured sufficient, including for exit-originated
push.

## Status

**Spike executed and recorded.** All measurements below ran on the
peer/serve path of a deployed funnel mount (the caller's identity headers
were present and `Tailscale-Funnel-Request` was absent, so the requests
took the serve codepath, not the public funnel ingress); the reverse-proxy
shape under test is the same code the funnel ingress runs. What remains
open is the public-ingress wrapper only: DERP-leg latency and idle
reaping (d073's S1 method), the public ingress's ALPN, and throughput
numbers — none of them structural after this spike's findings.

## What the edge's source already settled

Before measuring, the funnel edge's serving source
(tailscale `ipn/ipnlocal/serve.go`) answers the structural questions:

- The serve/funnel reverse proxy calls
  `http.NewResponseController(w).EnableFullDuplex()` on every proxied
  request, with a comment citing golang/go#40747 — the edge deliberately
  keeps reading the request body after the response starts. The request
  direction of a bidirectional exchange is designed for.
- The reverse proxy sets no `FlushInterval` (Go's zero value: no periodic
  response flush on the h1 leg) and adds no buffering wrappers or
  request-size limits; the ingress `http.Server` sets no read or idle
  timeouts.
- The HTTPS serve listener advertises `h2` and `http/1.1` via ALPN
  (measured live: both select).

estige's own ends already speak the shape: the mode C server handler
enables full duplex unconditionally and accepts an h1 carrier, and the
mode C client (`openPOST`) already streams an `io.Pipe` chunked body that
outlives the exchange.

## Method

A full-duplex echo-and-push server bound at the funnel mount's backend
port: it enables server-side full duplex, answers the response header
immediately, echoes every request-body chunk as it arrives with a flush
per chunk (so the server is never the bottleneck), and additionally
pushes an unprompted line every 2 s from a per-session timer — the
d145 `EVENT` shape, exit-originated data while the relay may be silent.
Both directions are logged with timestamps.

Three client shapes drove it: `curl --http1.1 -T -` (chunked upload,
h1.1 forced), and a Go client in the relay's exact mode C shape
(`io.Pipe` body held open past the exchange) once with the default
h2-first ALPN offer and once with `http/1.1` only. Each run fed
timestamped lines seconds apart and recorded receive timestamps, with a
body-held-open grace period after the last feed so "streams while the
body is open" and "arrives only after the body closes" are
distinguishable. The backend log gives the second vantage point; curl's
`--trace-time` wire trace gives a third for the client-edge leg.

## Findings

- **h2, relay's shape: fully streaming, both directions.** Response
  headers arrived in ~27 ms; every echoed chunk returned in ~1–27 ms
  while the body stayed open; the session ended cleanly. The request
  body's life is the session's life, exactly as mode C needs.
- **h2, exit-originated push: delivered with the client silent.** With
  the client feeding one line and then staying silent for 12 s, all five
  unprompted 2 s pushes arrived in the same millisecond the server wrote
  them. Exit-originated push needs no relay activity to flush through
  this edge — the ACCEPT's `EVENT` latency on the h2 carrier is not
  gated by keepalive cadence or relay traffic.
- **h1.1, held-open: not viable, three reproducible failures.** The
  response is request-locked — the Go client's `RoundTrip` blocked for
  the whole body-open period and returned only milliseconds after the
  body closed, so a `HELLO`/`HELLO_OK` handshake over a session-lived
  body would deadlock. The request pump drops chunks after roughly the
  first two: the third fed chunk never reached the backend (curl wire
  trace shows it sent; backend log shows it never arrived), reproduced
  across curl and Go clients. And the exchange ends truncated: the
  backend's body read ends `unexpected EOF`, the client's response ends
  short (curl error 18). The edge's full-duplex intent does not survive
  the h1.1 relay path for this shape.
- **curl's h2 delivery is an instrument artifact.** The first h2 run
  through curl showed a ~2 s staircase (each echo arriving with the next
  request write); the Go client on the identical path sees millisecond
  streaming. Re-testing this shape with curl will mislead; use a Go
  client.

## Consequences

- **No held-open h1.1 rung for funnel paths.** The edge cannot be made
  to flush an h1.1 response incrementally from our side, and a
  session-lived h1.1 body cannot even complete its handshake through it.
  The held-open h1.1 shape stays viable only behind intermediaries that
  flush response writes incrementally — a plain reverse proxy configured
  with `FlushInterval`, a streaming gateway — and a rung for those
  environments, if ever wanted, belongs to a ladder record in
  [d077](d077-ssl-vpn-transport-ladder.md)'s family, scoped to
  non-funnel paths.
- **The stop-and-wait floor is the measured adaptation.** The h1.1
  response behavior (nothing flushes until the handler returns, i.e.
  until each exchange completes) is exactly the discipline mode E is
  built on; the spike explains why the ladder looks the way it does
  rather than exposing a gap in it.
- **d145's carrier question narrows.** The ACCEPT rides the duplex
  carriers; through the funnel the h2 rung is measured sufficient
  end-to-end, including exit-originated `EVENT` push to a silent relay.
  What remains open in d145 is the actuation behind a bridge hit — the
  carrier is no longer part of that open item.
- Remaining funnel-ingress checks (DERP latency and reaping, public
  ALPN, throughput) are measurements on a transport this spike did not
  exercise, not questions about the reverse-proxy shape; they can land
  as an amendment here when run.
