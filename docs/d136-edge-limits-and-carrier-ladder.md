---
id: d136
type: module-design
status: draft
title: "d136 — the edge's real limits and the carrier ladder: what each rung of the HTTP-ssh substitute survives"
parent: estige
depends-on: [d128]
references: [d073, d077]
tags: ["http", "ssh", "edge", "funnel", "carrier-ladder", "prior-art", "mechanics"]
---

# d136 — the edge's limits, and the carrier ladder built on them

**Evidence companion to [d128](d128-http-ssh-substitute.md).** d128 defines an
HTTP-native `ssh` substitute whose semantics are fixed while its wire form is
negotiated. This record is the per-row provenance that negotiation rests on:
what a Funnel-class edge actually does (no native `CONNECT`, no RFC 8441, query
strings stripped on upgrade, h2c gated to gRPC, no PROXY protocol, capped
bandwidth) — each row marked **M**easured, **D**ocumented, or **I**nferred — and
the carrier ladder that follows (h2 streaming POST → WebSocket pinned to
`http/1.1` → h1.1 windowed stop-and-wait → encapsulated poll), with what each
rung survives and what it costs.

Split out because it is a measurements-and-documentation table consulted when
choosing or revisiting a carrier, while d128 is the capability contract.

## What the deployment edge actually does

Provenance is per row: **M** measured on a Funnel edge by estige's spikes
(d073, d077), **S** derived from upstream source, **U** unverified — a spike
before the format freezes.

| property                                              | status | detail / consequence                                                                                     |
| ----------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| public ports `443`, `8443`, `10000` only; `*.ts.net` names only | M | not configurable; the design must not assume any other origin shape                                       |
| edge offers ALPN `h2` and `http/1.1`                  | M      | `openssl s_client -alpn h2,http/1.1` → `h2`; h2 is the default public leg                                 |
| edge → backend hop is **HTTP/1.1**; h2c only for gRPC content types | S | so public h2 buys mux/no-HOL, not backend h2; the server writes ordinary streaming h1.1 handlers         |
| arbitrary methods forwarded (`PUT`/`DELETE`/`PATCH`)   | S + U  | Go `httputil.ReverseProxy` forwards any method; verify on the deployed edge                               |
| WebDAV verbs (`MOVE`/`COPY`/`PROPFIND`)                | U      | assume fragile; namespace operations therefore live in `POST /op/<name>`                                  |
| `101` WebSocket upgrade passes                        | S + M  | estige's deployed WebSocket transport works this way (d073 spike S3)                                      |
| RFC 8441 (WebSocket over h2)                          | **absent** | upgrade never reaches the backend when the client negotiates h2 → `426`; **a WSS carrier must pin ALPN to `http/1.1`** |
| WebSocket query string preserved                      | **no** | query strings are stripped on the upgrade request → auth must be a handshake header or an in-band first frame |
| streaming request body (chunked, h1.1)                | S + U  | supported by the proxy; concurrent write+read is the claim that needs the spike                           |
| response streaming / flush, idle timeouts             | S + U  | `FlushInterval` behavior on the backend side; **idle timeout is unknown** and decides long-poll viability  |
| `Range`, `ETag`, `If-Match` pass through              | S      | ordinary headers, no special handling                                                                     |
| request trailers                                      | U      | assume absent; half-close must be a frame, not an HTTP trailer                                            |
| client IP at the backend                              | **no** | PROXY protocol is unsupported on the HTTP path (upstream issue, still open) → logs identify the credential, not the peer |
| bandwidth                                             | M      | "non-configurable bandwidth limits", no published number → the clients need resumability and progress    |

Upstream evidence: Tailscale Funnel docs (ports, names, bandwidth); tailscale
issue #20882 (h2 WebSocket upgrade not proxied); #18651 (query stripped on
upgrade); #18483 / `shouldProxyViaH2C` (h2c gated to gRPC content types); #7747
(PROXY protocol absent).

## The carrier ladder, and what each rung survives

One carrier at a time, chosen per dial, degrading downward automatically and
never changing semantics:

| rung | carrier | duplex | survives |
| ---- | ------- | ------ | -------- |
| 1 | **h2 streaming `POST`** — one long-lived POST per channel, body and response both streamed | yes | upgrade-stripping gateways (no `Upgrade` header ever appears); h2 midboxes |
| 2 | **`WSS` on a pinned `http/1.1`** — binary frames | yes | h2 buffering on the public leg, gRPC-only h2c backends, path where upgrades pass but h2 streaming does not |
| 3 | **h1.1 windowed `POST`** — stop-and-wait exchanges, each standing alone | half, windowed | buffering proxies, flaky links, no upgrade, no h2: a dropped window is retried, nothing to resurrect |
| 4 | **encapsulated poll** — small `POST`s plus `text/event-stream` (or long-poll) downlink | half, high latency | DPI/gateways that pass only ordinary API traffic |

Rules:

- **Everything multiplexes over the carrier** — file operations, exec streams,
  TCP tunnels — because one dial per channel would be a connection storm and a
  fingerprint. Frame types: `open`, `data`, `close`, `half-close`, `error`,
  `exit`, `window`, and an `auth` frame.
- **Rung 3 is stop-and-wait by design, not by laziness.** A long-lived request
  body dies with its TCP connection, and resurrecting it needs cross-reconnect
  session state exactly where the link is least trustworthy. Windowed exchanges
  each stand alone. The cost is one round trip per exchange; correctness, not
  speed.
- **Rung 1 must not depend on backend h2**, since the edge terminates it: the
  server's handlers are ordinary streaming h1.1 handlers either way.
- **Rung 2 must pin ALPN to `http/1.1`** — otherwise a modern client negotiates
  h2 and the upgrade silently fails (measured upstream behavior above).
- **Downgrade is automatic and observable**: the client records the rung in use
  and reports it; a silent fee-free downgrade that halves throughput and is
  discovered a week later is a support incident.

DPI-specific hardening, beyond the ladder: no `X-` custom headers (strip-prone);
no behavior changes keyed off a header's presence; identical response shape for
authenticated failures and non-existent paths (uniform 404 — an unauthenticated
prober learns nothing); no distinctive `User-Agent` requirement; body framing
that is valid JSON/binary for a plausible API; and no expectation of
`Transfer-Encoding` retention — always length-delimit frames inside the body.

One near-miss worth recording: `tailscale funnel --tls-terminated-tcp=` can
publish a raw TCP forwarder, which would let an `sshd` sit on port 443 behind the
edge's TLS. That is a legitimate *deployment* fallback (see alternatives), but it
is not this design: it is not HTTP, so it dies exactly where HTTP-level policy is
enforced, and it cannot carry the file API.

Two protocol shapes were considered for the carrier and rejected, permanently
rather than provisionally:

- **gRPC as the tunnel protocol.** It genuinely works through the edge — the
  ingress proxy special-cases gRPC content types to switch its backend hop to
  h2c, precisely so gRPC services can be published — so this is a rejection on
  merit, not on feasibility. It buys nothing here: the public leg is HTTP/2
  either way, backend h2c is irrelevant to a handler that never needs backend
  h2, and gRPC's assets (typed framing, code generation) do not apply to an
  opaque byte pump. It costs three things that do matter:
  `content-type: application/grpc` is one of the most recognizable signatures a
  DPI box can key on, the opposite of what a hostile-path carrier wants; it
  depends on request *trailers*, unverified across the edge's proxy hop, where a
  frame-level half-close is known to work; and it drags a protobuf toolchain into
  a protocol that otherwise needs none. One detail from that gate is worth
  watching anyway: broadening it from "gRPC only" to "any HTTP/2 request to a
  plaintext backend" is an open upstream change, and if it lands a deployment
  gets real h2 on the *backend* leg too — an optimization for a server that
  cannot terminate TLS itself, and a thing to characterize, not to build on.
- **WebSocket-over-h2 (RFC 8441).** Structurally cannot beat h2 streaming POST
  for a byte pump: both are HTTP/2 streams, so multiplexing is identical, while
  the WebSocket form adds a handshake, adds a framing layer on top of h2's own,
  and depends on extended-`CONNECT` support on every hop — which plain h2 POST
  does not. The measured upstream behavior (the upgrade is not proxied once the
  client negotiates h2) points the same way. Dropped; the WebSocket rung is
  HTTP/1.1 WebSocket, the shape that actually passes.
