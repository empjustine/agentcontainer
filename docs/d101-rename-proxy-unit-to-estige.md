---
id: d101
type: decision
status: implemented
title: "d101 — rename the proxy unit llm-reverse-proxy → estige (the name of what v3 became)"
parent: estige
depends-on: [d071, d073, d077, d088]
references: [d047, d082, d091, d095]
tags: [proxy, terminology, naming, estige, forward-proxy]
---

# d101 — llm-reverse-proxy → estige

## Problem

The unit's name stopped being true. It was named for what it did in v1
(a reverse proxy in front of provider APIs). By v3 it is a forward proxy
in the operator's sense: the SSL-VPN tunnel transports (h2-POST, WebSocket,
and h1.1-POST) let clients ride loopback CONNECT/SOCKS5 through it to the
cloud (docs/d073, d077, d095), and the runtime names had already drifted
halfway — the image tag
(`localhost/estige:latest`), the container names (`estige-exit`/
`estige-relay`), and the relay state dir said `estige` since d088's
vocabulary work, while the folder, module, binary, config, log prefixes,
env overrides and every doc said `llm-reverse-proxy`. Two spellings for
one unit is exactly the one-fact/one-name drift d090 legislates against,
and every new document had to keep explaining the mismatch.

## Decision

The unit is **estige** — every live spelling renames in one pass:

- folder `llm-reverse-proxy/` → `estige/`; go module `estige`; binary and
  committed artifact `estige`; config `estige.json` (example:
  `estige.example.json`); the container-internal paths `/estige` and
  `/etc/estige/estige.json`; the Termux cross-build `estige-android`;
  build targets `estige-image`/`estige-native`; log prefix `[estige]` and
  log tools `estige/…`; the relay state dir `…/estige`; the smoke test's
  `.invalid` host label.
- env override `LLM_PROXY_BIN` → `ESTIGE_BIN` — the last old-spelling
  knob (one vocabulary per fact, d090).
- container names and the image tag were already estige-*; they stay, and
  now they are simply the unit's name in runtime roles rather than a
  second vocabulary that needed explaining.

Live code, configs, shims, generated artifacts and docs rewrite to the
new spelling, following d071's precedent: **decision records keep the
names of the day** — record bodies and filenames (including their link
slugs) are exempt, because rewriting them would break the history the log
exists to keep (d072's curated-history rule) and every pointer into it.

## Consequences

- Deployed hosts move once: the served config is `estige.json` beside the
  `estige` binary (or `ESTIGE_BIN` for an off-tree binary). A half-renamed
  pair must not run at once — the launchers `workload_rm` their own
  container name before starting, so the stale-named container (if any) is
  removed on next launch, not before.
- CI notes (`estige/CI.md`) and every path reference in the root docs now
  speak `estige/**`; the committed binary is rebuilt from the renamed
  module (go build/vet/test green, config regenerates byte-identically).
- The rename touches no behavior: same binary, same config format, same
  ports. Anything that only reads env and paths keeps working after the
  path update.

## Alternatives rejected

- Keep `llm-reverse-proxy` as a compatibility alias (symlink, wrapper
  script, retained env spelling): two spellings for one fact — the very
  drift this decision retires, and a permanent explanation burden in
  every future doc.
- Rename only the folder and docs but keep the binary/config/env names:
  the operator-facing spellings are precisely the ones that must agree;
  a partial rename maximizes the mismatch surface instead of minimizing it.
