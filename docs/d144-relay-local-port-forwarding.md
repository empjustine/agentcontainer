---
id: d144
type: module-design
status: draft
title: "d144 — local port forwarding: ssh-style argv on the relay, loopback listeners, one fresh tunnel per connection"
parent: estige
depends-on: [d073, d104, d110, d131, d132]
references: [d080, d106, d120, d123, d127, d128, d145, d146]
tags: ["estige", "tunnel", "forwarding", "ports", "v4", "ssh"]
---

# d144 — local port forwarding

This record proposes estige's local port forwarding: a loopback TCP listener
per ssh-style `-L` argument, where every accepted connection reaches an
argument-named target through its own authenticated tunnel. It does not cover
the exit-side listener ([d145](d145-relay-remote-port-forwarding.md)), dynamic
targets (the CONNECT and SOCKS5 surfaces already serve those), or
[d128](d128-http-ssh-substitute.md)'s ssh-shaped product. It is read by
whoever implements the relay's listener set, and by whoever reviews what a
proxy-unaware local client can reach through the exit. The decision: `-L`
arguments at establishment define the listeners, and each accept follows the
existing CONNECT path — no new frame, no new credential rule, no store entry,
no egress change.

## Status

**Draft.** Nothing is implemented, and forwarding scope comes from the
relay's argv at establishment (Decision), so the store takes no delta and
the feature does not wait for it. The implementing change extends the
relay's flag surface with ssh-style `-L`: parse-time refusals carrying
the argument's position, no interim env spelling (the
`VPN_TUNNEL_EGRESS` interim home exists only because egress predates any
store), and the packaged service unit's `ExecStart` carrying the
operator's arguments through ([d120](d120-estige-ships-as-packages.md)
retired the launcher script that pass-through used to live in).

## Problem

Every local surface estige offers speaks a proxy protocol. HTTP `CONNECT`
names its target in the request line; SOCKS5 names it in its request; d103's
absolute-form branch names it in the URL. A client that speaks none of these —
ssh, a database CLI, anything whose only server field is a host and a port —
needs a helper line (an `nc`-based `ProxyCommand`) in its own configuration,
or it cannot use the tunnel at all.

The missing shape is a static endpoint: a fixed loopback port on the relay
host whose far side is chosen by the operator's arguments instead of by the
client's request. That is ssh's `-L` direction, and it is the one
forwarding direction the relay can express without touching the wire. The
target travels as an ordinary `CONNECT`, the credential is bought per
connection exactly as it is bought now, and the exit's egress table gates the
dial exactly as it gates any other.

## Decision

### `-L` keeps ssh's argv shape, bind half included

At establishment the relay takes ssh-style forwarding arguments, one per
listener — `-L [<bind>:]<port>:<host>:<port>`:

```
-L 2222:git.example.com:22 -L 5432:relay2:5432 -L 127.0.0.2:5432:relay3:5432
```

The rules on an argument, all enforced at startup, all refusals loud with
the argument's position (d132's grammar law: disruptive, never insecure):

- The first field is the listener's port; the bind half before it is
  optional — ssh's own spelling — and the default stays `127.0.0.1`. An
  explicit bind half may name a loopback address only, an IPv4 address
  inside `127.0.0.0/8` or `::1`, refused at parse otherwise, so
  VPN-R23's loopback-only rule stays structural: the grammar carries the
  refusal, not a value an edit can widen, and an all-interfaces bind
  remains a future record's widening. The same listener port may be bound
  on different loopback addresses (ssh's trick), which is also the
  sanctioned way to name a specific address out of `127.0.0.0/8` now that
  route claims refuse that space ([d146](d146-subnet-routes-over-socks5.md)).
- The target half is `host:port` with a non-empty hostname. The check there
  is grammar only: resolution, pinning, IP-literal refusal (VPN-R22) and port
  policy (VPN-R37) stay at the exit, the one enforcement point that exists
  today. A bracketed IPv6 literal is the target's spelling when the target
  is one (`:` is already the field separator), and it reaches the exit like
  any target — refused there unless a claimed route covers it
  ([d146](d146-subnet-routes-over-socks5.md)).
- The target half may also name an admitted principal — `relay2:5432` — which
  the rendezvous matches structurally instead of through resolution: every
  principal in the exit's `relays` table shadows the name in a target,
  and reachability is decided by that principal's live ACCEPT session and
  its current claims ([d145](d145-relay-remote-port-forwarding.md)).
  Ordinary names take the resolution path above unchanged.
- Arguments are unique by (bind address, listener port), capped at 32 like
  every other list, and absent by default — an invocation with no `-L`
  opens no listener.
- A malformed argument, a missing or non-numeric field, an empty target
  half, or a duplicate (bind, port) pair refuse startup. A broken forward
  never becomes a listening socket.

The argument is the only spelling: no config field, no env var. d132's store
keeps exactly its two helpers, d110's multi-knob exemption already covers the
relay's argv surface, and ssh's own forwarding flags are per-invocation by
nature — the invocation is the statement, and nothing outlives it to drift.

### Each accept buys its own tunnel

The listener binds at boot, like the proxy listeners beside it. Each accepted
connection runs the path that exists: `openTunnel(target)` with a fresh v4
proof ([d104](d104-mutual-exit-relay-credential.md)), `CONNECT`, then the
byte pump. Three properties fall out for free, and they are the point:

- One authentication admits one connection and one `CONNECT` —
  [d131](d131-estige-v4-proof-mechanics.md)'s session bound holds with no
  amendment, because nothing here chains operations onto an authenticated
  carrier.
- No tunnel means the accepted connection is closed. There is no direct dial
  and no local name lookup anywhere in the path (VPN-R26's kill switch,
  VPN-R22's exit-side resolution).
- The relay stays a blind byte pipe: no TLS, no parsing, no payload in any
  log (VPN-R25, VPN-R19), with the existing backpressure and half-close
  behaviour (VPN-R18) inherited from that path.

### Refusals and state are visible

A forward whose tunnel cannot open reports through the surfaces that already
exist: `/healthz` gains a per-forward state and the last error, and refusals
get a lifecycle record in [d106](d106-tunnel-observability.md)'s vocabulary
with `via=forward` added. Target host, port, bytes, duration and outcome
appear; the target's resolved address, the proof and the nonce do not
(VPN-R19, VPN-R33).

## Consequences

- The relay gains a third listener class (beside the CONNECT and SOCKS5
  doors it binds today; `/healthz` rides the proxy listener, it binds no
  socket of its own). d110 already exempts multi-port
  binds with the relay as its example, so no port law changes, and the new
  listeners add no knob.
- A target port outside the exit's egress grant fails per connection with the
  existing `port-denied` reason. An operator who wants a forward to ssh:22
  grants 22 in the exit's egress table ([d080](d080-forward-proxy-no-host-allowlist.md),
  VPN-R37), exactly as a proxy client would need.
- A containerized relay's loopback binds and loopback dials never leave the
  netns, so the feature adds no egress for
  [d127](d127-proxy-only-container-egress.md)'s rule to see. Publishing a
  listener past the container is the launcher's job and stays outside estige
  ([d120](d120-estige-ships-as-packages.md)'s units).
- [d106](d106-tunnel-observability.md)'s vocabulary gains `via=forward` and
  any forward-specific `reason` values; d132's schema gains nothing —
  forwarding scope is argv, not store. The d106 delta is named on that
  record by the implementing change.
- A lone SIGINT drains per [d145](d145-relay-remote-port-forwarding.md)'s
  stop semantics: these listeners close to new accepts, established
  forwards keep pumping until they end, and a second SIGINT tears
  everything down immediately.
- Verification is the Go suite ([d123](d123-go-suite-in-the-sweep.md)):
  argv refusals (a malformed spec, a missing field, duplicate (bind,
  port) pairs, an out-of-range port), an assertion that every listener
  binds a loopback address and nothing else, an end-to-end forward through
  a test exit, the kill-switch
  assertion (tunnel down → connection closed, no direct dial), an IP-literal
  target and a denied port refused at the exit with their reasons visible at
  the relay, and `/healthz` state transitions.

## Alternatives rejected

- **Leave it to `ProxyCommand`.** A helper line per client config is exactly
  the per-client work this shape removes, and it serves only clients that
  accept a `ProxyCommand`. Both can coexist; the ask is the zero-helper
  endpoint for proxy-unaware clients.
- **A UDS listener instead of TCP.** ssh cannot address a unix socket as a
  server, so the motivating client gains nothing, and a socket file adds a
  permissions story the loopback bind does not need. An `-L` spelling that
  is a socket path is a possible future extension, not this record.
- **A dynamic target on the forward's port.** That is SOCKS5, which the relay
  already offers; a second dynamic surface adds no capability and a second
  request grammar to audit.
- **An IP-literal target shortcut.** Rejected by VPN-R22's shape, not by
  taste: resolution and pinning exist at the exit so that no second path can
  dial an unchecked address, and a local dial path — however its target is
  spelled — would be that path. The argument's target meets the exit's
  policy like every other target; d146's live claims are the only address
  that reaches.
- **Many forwards over one tunnel or one authenticated session.** Contradicts
  d131's bound and imports the mux (VPN-R17) into a feature that needs it
  only to save a handshake it never pays for twice.
