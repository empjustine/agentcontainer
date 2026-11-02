---
id: d110
type: module-design
status: active
title: "d110 — a single-port bind has exactly one knob: env PORT; the listen spellings (config field, argv, launcher env) are removed"
parent: estige
depends-on: [d073, d088, d090b, d104, d108]
references: [d095]
tags: ["estige", "runtime", "config", "ports", "12-factor", "cli"]
---

# d110 — a single-port bind has one knob: env PORT

## Status

Accepted — the implementing change landed: the binary reads `PORT`, and the
`listen` field, the `-listen` argv and the `LISTEN`/`HOST_PORT` launcher
variables are removed.

## Problem

The exit node binds exactly one TCP port: its funnel-fronted HTTP server. That one
fact currently has four spellings that must agree — the `listen` field in
`estige.json`, the `-listen` argv, and the launcher's steering in both paths:
`LISTEN` (native: `-listen` with the env's value) and `HOST_PORT`-driven
`-listen 0.0.0.0:...` (container). Meanwhile the port convention that process
starters actually speak — the 12-factor/Procfile rule, one env var named `PORT` —
is read nowhere, so a standardized coordinator cannot steer the exit without
editing files or argv.

## Decision

A tool that binds exactly one TCP port is configured for its port by exactly one
knob: the optional env var `PORT`. Unset → the code default (8080), bound on all
interfaces (`$PORT` carries a number; the socket is `:PORT`). Every other
spelling of that bind is removed:

- the `listen` config field — and it does **not** reappear in the role store:
  d104's `exit.json` carries the exit's *policy* (admitted relays, egress),
  never its bind;
- the `-listen` argv;
- the launcher's `LISTEN` env and the container path's
  `-listen 0.0.0.0:$HOST_PORT` — a workload is steered by `PORT` there too.

`PORT` is deliberately unprefixed: the convention's entire value is that
coordinators already speak it; a `VPN_`-prefixed shadow would defeat the
interop and re-create a second spelling (d090b's law, generalized: one fact, one
spelling — here the spelling is the standard env).

A tool binding several ports is exempt — today the relay, one listener per proxy
protocol (`-proxy-listen` CONNECT, `-socks-listen` SOCKS5, and their
`PROXY_LISTEN`/`SOCKS_LISTEN` launcher envs): a single `PORT` cannot
address the set, and those knobs stay as they are. The rule scopes itself to
single-port binds precisely so that `PORT` stays meaningful.

## Consequences

- The bind's host half disappears as a concept: all-interfaces is the only
  shape. (The tracked `estige.json` said `0.0.0.0:8080` and the default said
  `:8080` — the same socket in Go; nothing real is lost.) An operator who needs
  an interface-scoped bind needs a future decision.
- One external follower remains: the Tailscale funnel front is configured
  outside estige, so whoever steers `PORT` steers the funnel target and must
  repoint the front — that coupling belongs to the steering side.
- d108's tree-shake loses `listen` from its fold list: `tunnel.enabled`
  dissolves into arming, `tunnel.egress` folds into `exit.json`, and
  `listen` dies outright (this record).
- The implementing change covers the binary (`-listen` removal, `PORT` read),
  both `vpn-exit.sh` paths, the chain step (d095 — whatever launches an exit
  passes `PORT` through untouched), and the tests pinning the old spellings.

## Alternatives rejected

- **Keep `listen` in the config and let `PORT` override the port part** — two
  spellings that can drift, plus precedence rules to document and test: the
  exact disease d090b names for the env surface.
- **A prefixed name (`VPN_EXIT_PORT`)** — no coordinator speaks it; the
  interop is the point.
- **`PORT` for the relay too** — nonsense at two listeners; the scope rule
  (single-port binds only) is what keeps the standard honest.
- **A host-component knob (`LISTEN_HOST`, env host:port)** — more knobs for a
  case that has never needed one; default-all-interfaces covers reality.
- **Keep `-listen` argv "for flexibility"** — a steering surface the standard
  doesn't know isn't steering, it's another spelling.
