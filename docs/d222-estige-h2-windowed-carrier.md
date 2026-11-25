---
id: d222
type: module-design
status: active
title: "d222 — h2-post-windowed: a size-bounded window for a capped edge"
parent: estige
depends-on: [d077, d093, d105, d108, d188]
references: [d081, d131, d211]
tags: ["serving", "vpn", "tunnel", "h2", "cloudflare", "estige", "transports"]
---

# d222 — h2-post-windowed

## Status

Implemented. The carrier is [`h2windowed.go`](../estige/h2windowed.go), its
tests are [`h2windowed_test.go`](../estige/h2windowed_test.go), and the
deployment fact is the exit's second port (`PORT_CLOUDFLARE`). This record
supersedes d077's "one long-lived POST per connection" **only** for an edge
that caps a single request body; h2-post-unbounded remains the carrier
elsewhere.

Carriers are named by mechanism, never by letters (d105): this record uses
**h2-post-unbounded**, **websocket**, **h2-post-windowed** and
**h1.1-post-windowed** throughout. d239 retires h1.1-post-windowed with v5, so
the ladder this record ranks ends at h2-post-windowed.

## Problem

h2-post-unbounded is one POST whose request body is the local connection's
uplink. That is the lowest-overhead carrier, and it is structurally unable to
finish a session behind an edge that caps one request body: the edge accepts
the request, then rejects or resets the body once it crosses the limit —
after the session has opened, so no dial-time demotion can route around it.

Cloudflare Tunnel publishes such an edge. Its **Maximum Upload Size** is per
request (100 MB on Free/Pro, 200 MB on Business, up to 5 GB on Enterprise),
and it applies to streaming and chunked bodies as well as declared ones. The
same product is the natural replacement for the Tailscale Funnel front door
(one outbound connector, no inbound port), so the h2 family must survive it.

The cap cannot be discovered by either side at dial time: Cloudflare only
rejects at the limit, mid-body. An unbounded request looks identical to a
bounded one until bytes have moved, and a through-the-edge probe reaches no
code that knows the cap.

## Decision

**Two exit ports, one per edge, and one size-bounded window form of the h2
POST.** The port a request arrives on is the edge fact; no per-request header
and no per-edge env var carries it.

- The exit serves `PORT` (the Funnel-facing port) and, optionally,
  `PORT_CLOUDFLARE` (the port a capped edge's connector points at).
  Detection reads the request's own local address: requests on the second
  port have h2-post-unbounded refused **at request initiation**, before the
  body is read. No header can lie about which port it reached.
- The relay offers h2-post-unbounded first. A refusal is positive evidence
  for that edge port: the process remembers it and uses websocket →
  h2-post-windowed → h1.1-post-windowed for later CONNECTs. An uncapped port
  never refuses, so it keeps the lowest-overhead carrier first. One cheap
  request is the whole discovery cost.
- h2-post-windowed keeps the h2 POST's identity, session id and full-duplex
  behavior and adds a **window**: the request body is closed when the next
  frame would cross the window size, and the relay opens the next POST for
  the same session.

## The carrier

- **Identity and sequence.** The session id is the frame grammar the other
  carriers already use; the sequence rides `Traceparent` (trace-id = session,
  span-id = window), so this carrier shares the h1.1 windowed carrier's
  registry and replay discipline rather than inventing a second session
  scheme.
- **Discriminator.** `X-Estige-Window-Bytes` declares the window's budget.
  Its presence selects this carrier; `Traceparent` alone is
  h1.1-post-windowed; neither is h2-post-unbounded. The exit admits a
  declared bound up to a 32 MiB ceiling (bounding one session's queued
  uplink) and treats an over-ceiling declaration as a malformed tunnel
  request — the camouflage 404.
- **Window size.** The relay uses 8 MiB. That is a safe fraction of the
  smallest edge cap the fleet meets (Cloudflare's 100 MB) with headroom for
  headers and counting drift, and large enough that interactive traffic never
  reaches a boundary.
- **Full duplex inside a window.** The response headers are written before a
  body byte is read, so the handshake and the target's downlink overlap the
  uplink exactly as in h2-post-unbounded. `EnableFullDuplex` is required for
  the same reason the unbounded carrier needs it: without it the h1.1 server
  drains the open body before the headers, and the exchange deadlocks against
  a relay waiting for the 200. Every early response path (auth refusal,
  camouflage 404, carrier switch) enables it for the same reason.
- **Handoff at the bound.** When the body ends, the exit flushes what the
  outbound slot already holds and ends the response; the relay's read loop
  sees EOF, opens the next POST immediately, and the blocked writer resumes.
  One window is in flight at a time. A frame arriving after the emptiness
  check waits for the next window.
- **No retry.** A lost or rejected window may already have written uplink
  bytes to the target, so replay would duplicate them. The session fails
  closed; a retry needs a per-window acknowledgement first, which this
  record does not add.

## Deployment

- `PORT`: the Funnel-facing listener (d110); h2-post-unbounded is allowed.
- `PORT_CLOUDFLARE`: the capped-edge listener; h2-post-unbounded is refused
  at request initiation. The connector for that edge points here; a connector
  pointed at the wrong port defeats the refusal, so the two ports are a
  deployment invariant, not a suggestion.
- A second port repeating `PORT` refuses startup. Both are bare port
  numbers; neither is a credential and neither enters the vault chain.
- The relay needs no edge configuration. Its `VPN_TUNNEL_URL` names one
  public hostname; the exit's refusal teaches it the posture of the port
  behind that hostname, and the memory is per process.

## Ranking

- **Uncapped edge:** h2-post-unbounded, websocket, h2-post-windowed,
  h1.1-post-windowed. The unbounded carrier wins and is the whole session.
- **After a refusal:** websocket, h2-post-windowed, h1.1-post-windowed.
  The WebSocket is preferred because one upgrade and a full-duplex frame
  stream carry no per-window request; h2-post-windowed is the no-upgrade
  fallback; h1.1-post-windowed is the floor.

The windowed carrier is **not** a latency win over the WebSocket: interactive
traffic never crosses an 8 MiB window, so the two tie, and bulk uplink pays
one round trip per crossing where the WebSocket pays none. Its value is (1)
no upgrade dependency, (2) a cap-safe session, and (3) a drastically lower
request count than h1.1-post-windowed — 8 MiB windows against 64 KiB, which
matters on an edge that meters or rate-limits requests.

## Cloudflare edge facts

- **Named tunnels** carry the production shape: a hostname from the
  operator's zone, a Cloudflare-managed edge certificate (Universal SSL
  covers the apex and one subdomain level; deeper names need Total TLS or an
  advanced certificate), and no origin certificate while the exit serves
  plain `http://localhost`. The edge certificate is publicly trusted, so the
  relay's system-roots verification is unchanged. No ACME/Let's Encrypt step
  exists on either side.
- **Quick tunnels are not a deployment target.** Their published limits are
  heavier than a named tunnel's: no uptime guarantee, an ephemeral
  `*.trycloudflare.com` hostname, **200 in-flight requests** (further requests
  answer 429), and **no Server-Sent Events** (the edge buffers
  `text/event-stream`). The SSE limit does not apply to this tunnel's payload
  — the frames are opaque, and an inner SSE response rides inside them — but
  the 200-request ceiling bounds how many sessions one quick tunnel carries.
- **Timeouts remain provisional bounds.** The proxy read timeout is 125 s and
  the write timeout 30 s; the relay's keepalive (30 s) sits exactly on the
  write timeout and should come down before this carrier is called
  characterized.

## Consequences

- The exit binds two ports only when `PORT_CLOUDFLARE` is set; a
  Funnel-only deployment is unchanged.
- The exit's logs gain one CLF line per window, as the h1.1 windowed carrier
  does; the session record stays one per CONNECT and names the carrier.
- The relay's startup line names all four carriers; a refusal is logged once
  when the posture is learned, not per dial.
- h2-post-unbounded stays available on the Funnel port for sessions known to
  stay small, at the operator's risk of a mid-body rejection.

## Alternatives rejected

- **A per-edge cap variable.** It duplicated the port, made the relay's
  configuration authoritative about the exit's edge, and could disagree with
  the connector actually pointed at it.
- **Discovery through the edge.** Cloudflare cannot refuse at initiation, so
  no dial-time probe can see the cap; the exit's port is the only place the
  fact is knowable without moving bytes.
- **A mode-selection knob.** d093 retired the knob because carrier choice is
  a per-dial fact; a port role is a deployment fact and the relay's learned
  posture is not operator-selected.
- **Making h2-post-unbounded always windowed.** It would cost a request per
  window on every deployment, including edges that impose no limit.
- **Blind window retry.** Duplicates uplink bytes; an acknowledgement
  protocol is a larger change than this record.
- **Pipelining windows.** Multiple in-flight POSTs would restore more of
  h2's shape, but a single downlink stream then needs an ordering/reassembly
  rule; the stop-and-wait handoff is the smaller, provable step.
- **Path-based ingress for the Cloudflare route.** cloudflared matches on a
  path but forwards it unmodified, so a prefixed route would reach the exit
  as `/<prefix>/vpn` and 404; a dedicated hostname keeps the edge/strip
  contract d085 assumes.

## Other edges: NetBird (verified against its docs and source)

NetBird's reverse proxy (`netbird expose <port>` in HTTP L7 mode) is a
different edge with a different shape, and it does **not** need the windowed
carrier:

- It terminates TLS at the NetBird proxy cluster and forwards over the
  NetBird overlay to the **peer and port**, not to `127.0.0.1`; the exit must
  listen on an overlay-reachable address (it binds all interfaces today).
- The proxy is `httputil.ReverseProxy` with `FlushInterval: -1`: it streams
  request bodies (the middleware's capture is a bounded tee, not a rejection
  cap) and responses. No per-request body-size rejection is implemented in
  the paths inspected, so h2-post-unbounded should complete; WebSocket
  upgrades are tracked and pass through, and SSE/chunked streams are
  documented as passing. The only timeouts visible are a 30 s backend dial
  timeout and an optional per-target `request_timeout`; no HTTP session
  deadline is documented.
- It offers PIN/password/SSO authentication and generated or custom domains.
  The auth modes must stay off: they insert a browser login, which breaks
  non-browser clients and the camouflage 404.
- Free plan: 5 users / 100 machines. The CLI allows 10 active `expose`
  sessions per peer (dashboard services are separate); no request or byte
  quota is documented.

So NetBird wants its **own exit port with an unbounded-allowed policy**
(`PORT_NETBIRD`, or a generalized edge-port map), not the windowed-only
Cloudflare port. The two named ports are the two-edge instance of a port →
policy model; a third edge should turn that into the map rather than add a
third boolean.

## Findings and verification

- The mechanical rename landed (d105): code comments, logs, live docs and the
  lifecycle record use the four carrier names; no letter alias remains in a
  log line or a current spec.
- The capped-edge refusal is a request-initiation test (no body read), and the
  relay learns the edge's posture from it once; no per-edge env var is needed.
- An h1.1 server must `EnableFullDuplex` on **every** early response path
  (authentication refusal, camouflage 404, carrier switch), or its body drain
  deadlocks against a relay that waits for the response before writing.
- All four carriers' `readTimer` access is mutex-guarded; the suite passes
  under `-race`.
- Verified locally: `go test ./...`, `go test -race ./...`,
  `golangci-lint run ./...` (0 issues) and `docs/spec-check.mjs` (clean).
- The NetBird findings above are docs/source-derived, not a live-cluster
  measurement; they are why the port → policy map is the next step rather
  than a third boolean.

## Open items

- Measure the Cloudflare (and any other capped edge's) ALPN, upgrade
  pass-through, request-body streaming and concurrent h2 streams through the
  connector; the numbers here are the vendor's.
- Generalize the exit's port role to a port → policy map when NetBird (or
  another edge) is deployed, and confirm NetBird's HTTP session timeouts and
  request streaming on the real cluster.
- Characterize the windowed carrier's boundary cost against the WebSocket on
  the real leg, and decide whether pipelining earns its ordering rule.
- One shared h2 transport per relay (rather than one per CONNECT) would make
  multiplexing real; the carrier currently keeps the per-session transport.
