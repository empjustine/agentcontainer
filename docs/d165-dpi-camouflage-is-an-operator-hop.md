---
id: d165
type: module-design
status: draft
title: "d165 — packet-level DPI camouflage is an operator hop, never an estige code path"
parent: estige
depends-on: [d073, d088, d094, d136]
references: [d077, d090, d091, d128]
tags: ["estige", "funnel", "dpi", "egress", "chain", "assessment"]
---

# d165 — packet-level DPI camouflage is an operator hop, never an estige code path

## Status

Assessment, measured where a container can measure it. Two tools were read from
the farm and one of them was built and run against estige's chain shape. The
verdict is a placement decision, not a feature: nothing is proposed for the
binary.

## Problem

Two anti-DPI tools, `bol-van/zapret` and `hufrea/byedpi`, are the standard
answers to a censored path. estige already assumes a hostile path on its public
leg (d136's carrier ladder, "DPI/gateways that pass only ordinary API traffic").
The question this record answers is which of those tools can change anything for
an estige deployment, and where it would have to sit.

## What the mirrors carry

Both mirrors are bare, canonical, and current as of the date named:

| repo                        | head       | date       | what it is                                                                                                            |
| --------------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `github.com/bol-van/zapret` | `73ee2aa0` | 2026-11-04 | a Netfilter-queue packet modifier (`nfqws`) plus a stream-level proxy (`tpws`), config generator, and `blockcheck.sh` |
| `github.com/hufrea/byedpi`  | `e2684772` | 2026-11-03 | one userspace binary, `ciadpi`: a local SOCKS4/5 and HTTP-CONNECT proxy that re-segments the connections it forwards  |

`zapret` at that head is version 1, and its own `docs/readme.en.md` opens by
saying version 1 is end-of-life and that `bol-van/zapret2` is current. The farm
mirrors both: `github.com/bol-van/zapret2` at `9b9b929` (2026-11-07), MIT
licensed like its predecessor, and read here as far as its Russian readme and
English manual go.

The difference that matters for placement is not the option list. In zapret2 the
packet modifier is `nfqws2` and a **strategy is a Lua program** rather than C
compiled into the binary: the stated goal is that somebody who understands DPI
can write a strategy without writing C. A strategy is therefore operator data
with an embedded interpreter behind it, which is the right shape for a host
facility and the wrong shape for a process that ships
`CapabilityBoundingSet=` empty.

### Trust boundary

Everything in this record about those two repositories is third-party material,
read from bare mirrors in the farm and never verified against upstream. The two
DeepWiki summaries consulted are model-generated prose about those trees — a
reading aid, not an authority. Where a claim comes from a README it is cited by
path; where it comes from execution it says so.

## Where each tool sits in the stack

Both work by making a passive DPI unable to recognise a request, and both leave
the real peer's stream intact — that is the whole trick. Neither can decrypt
anything, and neither changes what the endpoints say to each other.

- **`nfqws` (packet level).** Netfilter sends matching packets to an NFQUEUE;
  `nfqws` rewrites or duplicates them and reinjects through raw sockets. Its
  levers are fake segments (`badsum`, `badseq`, an expired `autottl`, missing
  ACK), segment splitting in disordered order, IP fragmentation, and server
  window games (`--wssize`). It needs root to install the queue, and can drop
  privileges afterwards (`--user`).
- **`tpws` (stream level).** A transparent proxy or SOCKS server that splits a
  stream at a byte position, sends it out of order or with an out-of-band byte,
  splits a ClientHello into two TLS records (`--tlsrec`), and case-folds or pads
  HTTP headers.
- **`ciadpi` (stream level, userspace, no root).** The same class of tricks —
  `--split`, `--disorder`, `--oob`, `--tlsrec`, `--fake` with `--ttl` — applied
  to connections it forwards as a SOCKS5 or CONNECT proxy. Privileged extras
  exist (`--md5sig`, `--drop-sack`) and are optional; the core tricks are plain
  `send`/`splice` work on an established socket.

zapret's own "When it will not work" section names the cases that matter here:
DNS that lies, blocking by IP address, and "a filter capable of reconstructing a
TCP connection, and which follows all standards" — a full proxy is not
something these tricks fool, because it reassembles and re-emits the stream.

## The four legs of one estige request

The placement question collapses once each leg is named with its TCP owner.

| leg                                            | who owns the TCP flow | what a passive DPI can see                                             | can a tool on our side change it                        |
| ---------------------------------------------- | --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| app → relay node (loopback CONNECT/SOCKS5)     | the relay node        | nothing (loopback)                                                     | no need                                                 |
| relay node → Funnel edge (`wss` to `*.ts.net`) | the relay node        | TLS ClientHello with the funnel hostname, and the outer stream's shape | **yes** — this is the one leg a desync tool can work on |
| Funnel edge → tsnet                            | Tailscale             | WireGuard/DERP                                                         | no — not our sockets                                    |
| exit node → target (pinned egress TLS)         | the exit node         | TLS ClientHello the client wrote, and the response stream              | yes in principle, with consequences below               |

The Funnel edge terminates the client's TLS (d073's trust table), so the
"camouflage" available on the public leg is entirely about the relay node's own
outbound TCP toward `*.ts.net`. The edge is a standard-conforming TLS
terminator: re-segmentation is invisible to it, which is exactly why the chain
hop can carry the tunnel at all, and a middlebox that reassembles a full TCP
stream the way the edge does is the case zapret's readme files under "when it
will not work".

The only signature that matters on this leg is the funnel hostname in the
ClientHello. A filter that matches it inside one packet is what a split at byte
one defeats. A filter that reassembles the stream before matching is not
defeated by anything in this class, and which of the two the path has is the
measurement that would settle adoption.

## The one drop-in: byedpi as the relay node's chain hop

The relay node already has exactly one optional outbound hop, and it is declared
in the conventional proxy variables (d094): `SOCKS_SERVER` first, then the
scheme-matched `{http,https}_proxy`, then `ALL_PROXY`; SOCKS5 only; the chain
never resolves locally, so the hostname crosses to the proxy verbatim; TLS stays
end to end over the hop.

`ciadpi` is a SOCKS5 server. Nothing in estige has to change:

```
SOCKS_SERVER=127.0.0.1:1080      # ciadpi --split 1 --disorder 1
```

Constraints that come with it, all already enforced or already true:
the chain is one hop (d094), it must be reachable before the relay node binds
(VPN-R26), and a chain that fails its handshake refuses startup rather than
degrading silently.

**Measured** (`ciadpi` built from the mirror at `e2684772`, run non-root, SOCKS5
reached with `socks5h` so the hostname was resolved proxy-side):

| strategy                 | `https://example.com`    | `https://api.github.com`        |
| ------------------------ | ------------------------ | ------------------------------- |
| none (proxy only)        | 200, 0.041 s             | 200, `CN=*.github.com` verified |
| `--split 1`              | 200, 0.044 s             | 200, certificate verified       |
| `--disorder 1`           | 200, 0.054 s             | 200, certificate verified       |
| `--split 1 --disorder 1` | 200, 0.052 s             | 200, certificate verified       |
| `--oob 1 --disorder 1`   | 200, 0.051 s             | 200, certificate verified       |
| `--tlsrec 1+s`           | 200, 0.054 s             | 200, certificate verified       |
| `--fake -1 --ttl 8`      | **TLS `unexpected eof`** | connection failed               |

Two readings from that table. The re-segmentation strategies are transparent to
a correct TLS stack — the certificate still verified end to end, which is
d094's invariant holding under a desync proxy. And a fake segment with a TTL
that does not expire before the destination **breaks the connection**: in this
container the peer is eight hops or fewer away, so the "fake" arrived at the
real server and confused its stack. That is the failure mode a desync deployment
lives with, and its shape inside estige is a tunnel handshake that fails at
startup with no way to tell a strategy error from a blocked path.

## What is not applicable, and why

- **Camouflaging the Funnel itself.** The Funnel edge is Tailscale's TCP
  endpoint, on Tailscale's machines, reached over DERP or WireGuard. No process
  estige ships or supervises is on that path. A tool on the relay node changes
  what a DPI _between the relay node and the edge_ sees; it cannot change what
  the edge's own ingress sees, and it cannot be the edge.
- **zapret inside the binary.** `nfqws` needs Netfilter queue ownership and raw
  sockets. Both estige units ship an empty `CapabilityBoundingSet=` (d090), so
  this is a host facility in a separate unit with its own grant, never an
  estige feature. The same holds for `tpws`'s firewall redirect.
- **zapret on a Termux relay node.** NFQUEUE and `iptables`/nftables need root,
  and the Termux deployment is the unprivileged one. `ciadpi` is the tool that
  fits there, because it needs no kernel hooks.
- **byedpi on the exit node's egress, today.** `dialValidated` dials the
  validated address directly with a `net.Dialer`, so there is no chain hook on
  that leg; adding one is a code path, not a configuration. It would also have
  to preserve VPN-R36's pinning rule — resolve once, validate, dial a validated
  address — which a SOCKS proxy breaks by resolving the name itself. `ciadpi`'s
  `-N` (reject domain targets) is what makes that composable: the exit node
  hands a literal pinned IP and the proxy never resolves.
- **Any of this replacing d136's ladder.** The ladder answers a _content and
  shape_ classifier at the application layer — ordinary API traffic, no custom
  headers, a uniform 404, no gRPC signature. Packet re-segmentation answers a
  _packet-level_ signature. They are orthogonal; neither substitutes for the
  other, and a path that drops `wss` entirely is fixed by neither.

## What would justify adopting the chain hop

A measured blocked path: a relay node that resets or blackholes the
`wss` to `*.ts.net` **after** a valid ClientHello, and not one that blocks by
IP, lies in DNS, or refuses anything that is not allowlisted (zapret's own list
of defeats). Even then the strategy would be chosen by `ciadpi`'s
`--auto`/`--auto-mode` escalation or by zapret's `blockcheck`, because a
strategy that is wrong on this path is a broken tunnel rather than a slow one,
and estige's error taxonomy cannot tell the difference from the inside (d091).

## Alternatives rejected

- **Ship a desync implementation inside estige.** It is a packet-stack
  privilege, a per-path tuning problem, and an unverifiable failure mode, in a
  process whose whole shape is "one binary, env-only config, no ambient
  authority".
- **Hide the funnel hostname by SNI rewriting.** Both tools can rewrite the SNI
  of _fake_ packets only. The real ClientHello must carry the funnel name or the
  edge cannot route it (d085's mount is the routing key), and a rewritten real
  SNI would break certificate validation on the client (VPN-R28).
- **Treat the 404 policy as camouflage.** It is policy (VPN-R34) and lives at
  the application layer; it is not a substitute for a packet-level defence and
  this record does not propose extending it.
- **Use `tailscale funnel --tls-terminated-tcp` to get a raw forwarder.** That
  is d136's recorded near-miss, not a desync remedy.

## Verification status

Read from the mirrors at the heads above: zapret's `docs/readme.en.md`
(mechanisms, "When it will not work", "Server side fooling"), its
`config.default`, and byedpi's `README.md`, `main.c`, `desync.c`,
`dist/linux/byedpi.service`.

Executed: `ciadpi` built from the mirror, run as a non-root user, and driven
through SOCKS5 by `curl` under the seven strategies in the table above.
Verified in estige's tree by reading `relaychain.go`, `relaynode.go`,
`egress.go` and the two unit files.

Inside estige, `go test -run "SOCKS5|RelayChain"` passes at this head, so the
chain hop itself is covered; a relay node dialing a live tunnel _through_
`ciadpi` was not run end to end. The cheapest next spike is exactly that: start
`ciadpi`, export `SOCKS_SERVER`, and run mode E against a local tunnel server to
confirm the ladder reports the same rung and the certificate still verifies.

Not verified: any of this against a real DPI — the container has no censoring
middlebox, so the table demonstrates transparency to a correct peer, not
evasion. zapret2's `nfqws2` and zapret1's `nfqws`/`tpws` were read but not executed. A Termux
build of `ciadpi` was not attempted. Whether a `wss` to a funnel survives an
ISP's reset-on-ClientHello is unmeasured, and is the measurement that would
settle the adoption question.

## Re-verify

| source                      | what to re-read                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `bol-van/zapret` `73ee2aa0` | `docs/readme.en.md` — "When it will not work", "Server side fooling", and the `nfqws`/`tpws` option lists                         |
| `bol-van/zapret2` `9b9b929` | `docs/readme.md` (what changed from zapret1, why strategies became Lua), `docs/manual.en.md`, `docs/LICENSE.txt`                  |
| `hufrea/byedpi` `e2684772`  | `README.md` option table; `desync.c` for what a strategy does; `dist/linux/byedpi.service` for the no-privilege deployment shape  |
| estige                      | `relaychain.go` (chain env surface), `egress.go` (`dialValidated`'s pinning), `packaging/ol/*.service` (`CapabilityBoundingSet=`) |
