---
id: d224
type: module-design
status: active
title: "d224 — llama-swap publishes 9292, upstream's example port, and llama-server's own default never surfaces"
parent: llm-local-inference
depends-on: [llm-local-inference]
references: [d027, d070, d108, d110, d170]
tags: ["llama-swap", "ports", "llama-server", "upstream-defaults", "serving"]
---

# d224 — llama-swap publishes 9292, upstream's example port

This record moves the local-inference publish port from 8101 to 9292, the port
upstream llama-swap's own example publishes, and settles what llama-server's
port default means for this instance (nothing). The reader is whoever touches
`llm-local-inference/run.py`, the tsnet serve endpoint in front of it, or a
document that quotes a serving port.

## Problem

8101 was a local invention. d027 needed a host port that was not 8080, because
the funnel front had claimed 8080, and 8101 was the first free number. It
carried no meaning: upstream llama-swap publishes `9292` in every example,
so every operator comparing this tree against upstream's README translated one
number for no gain.

llama.cpp changed the other half of the picture. `llama-server`'s own default
listen port is 9931 in current llama.cpp (it was 8080), which reads like a
second upstream default this instance ought to follow. It is not one, and the
confusion is worth one paragraph of prevention rather than a config change.

## Decision

**The publish port is 9292, over an in-container 8080.** `run.py` publishes
`${HOST_PORT:-9292}:8080` and passes `-listen 0.0.0.0:8080`. That pair is
upstream's example shape exactly — the image's own default listen address, with
host port 9292 in front of it — so an operator reads one number and recognises
it. `HOST_PORT` still overrides for a host that needs another number. Host
port 8080 stays estige's (d110), which is why the publish is not simply 8080.

**llama-server's own default port is not part of this surface.** The
`LLAMA_SERVER` macro in `config.d/00-general.yaml` always passes
`--port ${PORT}`, and llama-swap assigns `${PORT}` from `startPort`
(`llama-swap-core.json`). llama.cpp's default never applies, no client, user or
outside host names a llama-server port, and llama.cpp moving that default to
9931 changes nothing visible here. llama-swap owns backend ports; the
`llama-server` binary owns none of the tree's published ones.

## Consequences

- `llm-local-inference/run.py`, `.env.example` and `DESIGN.md` carry the
  new default, and FR-S3 in `docs/requirements.md` states it.
- The tsnet `tailscale serve` endpoint in front of this instance maps its host
  root onto the publish port, so the host's serve configuration moves to 9292
  in the same change. The fact-table row's `baseUrl` carries no port (d070),
  so no generated artifact changes.
- A host that sets `HOST_PORT=8101` keeps serving on 8101; the default is the
  only thing that moved.
- Historical records keep 8101 (d027, d070, d047, d091 and the rest): they are
  dated artefacts and their time-anchored words mean "at the time of the
  record" (d072).

## Alternatives rejected

- **Keep 8101.** A custom number forces every reader to translate it from
  upstream's documentation, and nothing here depends on the specific value.
- **Publish 8080 on the host.** estige's port (d110); the collision d027
  resolved would return.
- **Publish 9931, following llama-server's new default.** It would present
  llama-swap as a llama-server and put a client-visible port next to the range
  llama-swap assigns to backends.
- **Bind 9292 in the container as well.** The publish is the only number a
  client names; `8080` needs no flag because it is the image's default, and a
  second custom number inside the container buys nothing.
