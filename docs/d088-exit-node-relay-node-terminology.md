---
id: d088
type: decision
status: implemented (phase 1 documentation; phase 2 code rename landed in-place ahead of the still-undated d082 split)
title: "d088 — exit node and relay node: name the SSL VPN deployments by network position, not protocol role"
parent: llm-reverse-proxy
depends-on: [d071, d073, d082]
references: [d080, d084]
---

# d088 — exit node and relay node: name the SSL VPN deployments by network position, not protocol role

## Problem

The SSL VPN (d073) has two deployments, and every available name for
them fails the same way: each deployment is **a mix of a client, a
server, a reverse proxy, and a forward proxy**, so none of the four
words discriminates.

- "server"/"client" name per-connection roles, and both deployments hold
  both at once: the funnel-side deployment serves the tunnel *and* is
  an HTTP client to the LLM providers; the local deployment is a tunnel
  client *and* a server in front of the local apps (loopback :3128
  CONNECT / :1080 SOCKS5). Every use in docs needed a qualifier —
  "tunnel server", "localhost client proxy" — which is the tell that
  the bare words carry no position (d071 retired the same failure mode
  once already for `REVERSE_PROXY_BASE_URLS`).
- "forward proxy"/"reverse proxy" are direction-relative to the caller:
  mode A's allowlist front is a reverse proxy from the app's view and a
  forward-looking relay from the tunnel's, and d073 §18 already flags
  that the component's own name undersells what it does.

What actually discriminates the two deployments is **network position
and connectivity**, and that is stable across every connection they
make. Name that.

## Decision

Two role names, keyed on position:

- **exit node** — the deployment that has free, unblocked internet
  connectivity and tsnet connectivity to the actual LLM endpoints:
  traffic exits the local environment through it on its way to the
  providers. Network-wise "server"-ish; implemented as a mix of client,
  server, reverse and forward proxy. This is the
  `PROXY_MODE=server` deployment: the funnel-front :8080 listener, the
  mode A allowlist front, the tunnel server with its egress policy.
- **relay node** — the deployment run locally on a restricted-internet
  environment, without direct tsnet connectivity to the LLM endpoints
  (whatever reachability it has only reaches the exit node's tunnel
  URL): it relays the local apps' traffic to the exit node.
  Network-wise "client"-ish; also a mix of client, server, reverse and
  forward proxy. This is the `PROXY_MODE=client` deployment: the
  loopback CONNECT/SOCKS5 proxies in front of the tunnel client.

The mapping is fixed: server = exit node, client = relay node. The
env values and flags stay what the code speaks (see Phases).

## Phases — this record lands documentation only

1. **Documentation (this change):** this record; the unit's live docs
   (`llm-reverse-proxy/README.md` Build & run, `DESIGN.md`); the
   `docs/architecture.md` folder row; this index row.
2. **Code (originally deferred to the d082 split; landed in-place — the
   split stays undated and every doc quoting the env values kept churning
   the old names):** `PROXY_MODE` and `-mode` values became `exit`/
   `relay` (the mapping stays fixed: server = exit node, client = relay
   node), run.sh's banners and the log prefixes (`[vpn-client]` →
   `[vpn-relay]`), and the deployment-role comments moved to the node
   names. `client.go` became `relaynode.go` — that file IS the relay
   node deployment. No alias read for the old `server`/`client` values:
   one spelling, fail closed (d071's law). The per-connection senses
   deliberately stay: the tunnel protocol's HELLO "client label" (and
   `VPN_CLIENT_LABEL`), WebSocket mask polarity, `relay.go`'s "peer"
   (the other tunnel end — the byte pump both nodes share), and HTTP
   client/server. d088 renames deployments, not wire fields.
3. **History:** untouched, by d071's law. Decision records (d070, d073,
   d077, d080, d084, d085) and README index rows that describe them
   keep the names those records used.

## Collisions and disambiguation (checked, honest)

- **d073 §1/§11 "not an exit node"** is the *Tailscale* exit-node
  sense — IP routing, TUN/TAP, an exit-node replacement. That non-goal
  stays true and unchanged. Within llm-reverse-proxy docs, "exit node"
  now means the d088 deployment role; the IP-layer sense appears only
  qualified ("IP-layer exit node").
- **"relay" already names two other things** that stay:
  the metadata-relay chain (d063's `MODELS_DEV_RELAY_URL`,
  `relayCandidates` — the reason d071 rejected `RELAY_BASE_URL(S)`),
  and `relay.go`'s bidirectional byte pump, which by design runs
  identically in *both* roles ("The SAME function runs in both roles").
  "relay node" is a deployment name and never an env identifier, so it
  cannot collide with either; the byte-pump sense actually reinforces
  the vocabulary — the pump describes what both nodes do, the node
  name says which one you are standing on.
- **mode A prose "allowlist relay"** (d073 §2) names the front's
  shape, not a node; it stays.

## Alternatives rejected

- **Keep server/client as the docs vocabulary** — needs a qualifier in
  every sentence, and the qualifier is always position.
- **tunnel server/tunnel client** — still direction-relative, and still
  ambiguous once the tunnel is not the sentence's subject.
- **upstream node/downstream node** — "upstream" is taken in this unit
  for the LLM providers themselves (main.go's "upstream connection
  closed", RFC 9459 framing).
- **edge node / gateway node** — "edge" is unclaimed but vague about
  which edge; "gateway" describes a mix (accurate) without saying
  *where* (the point of this record).
