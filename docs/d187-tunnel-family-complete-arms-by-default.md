---
id: d187
type: module-design
status: active
title: "d187 — the tunnel family is complete and arms by default"
parent: estige
depends-on: [d073, d077]
references: [d081, d084, d085, d090, d093, d108, d169, d171]
tags: ["serving", "vpn", "tunnel", "estige", "modes"]
---

# d187 — the tunnel family is complete and arms by default

## Status

Supersedes d081 (the build-order and gate record) and d084 (the default-offer
record). Both decided a rollout that has since finished — the transports are
built, the gates are gone, the default is settled — so this record states the
law that survives and the gate history stays in those two bodies.

## The law

- **Every transport is built, and no build gate remains.** The h2-POST, the
  WebSocket and the h1.1-POST tunnels shipped; the L1-L4 spikes are post-hoc
  characterization — run them to validate the shipped provisional constants
  and the carrier choice, never to unblock a mode (d081's amendment; the
  ladder itself is d077).
- **The family arms by default.** The arm signal is the operator keyset in the
  env: the family is armed exactly when the keyset is present (d085). The
  former `VPN_TUNNEL_PREFIX` config trigger and its tri-state
  `tunnelConfig.Enabled` are gone, so a deployment needs no config edit and no
  flag for the family to exist.
- **The offer is the whole ladder.** Mode selection is the relay node's
  per-dial ranking — h2-POST, then WebSocket, then h1.1-POST — discovered
  against what the endpoint actually does. `-modes` and `MODES` are retired
  (d093), and no spelling of the knob remains (d090).
- **The edge is tunnel-only.** The allowlist relay (the old "mode A") and the
  authenticated relay (the old "mode B", never built) are deleted (d108), so
  there is no fallback mode to arm and no host allowlist to choose between.
- **A degraded transport is operator opt-in.** Cleartext `ws://`/`http://` and
  skipped upstream verification exist only behind the relay's `-insecure-exit`
  switch; without it a cleartext tunnel URL is refused at boot (d169, d171).

## Consequences

- The deployment's whole arming surface is the keyset in the env chain; a
  half-armed env refuses at boot, because a loud misconfiguration beats a
  silent mode-A fallback.
- A future transport joins the ladder and the ranking; it never re-introduces
  a selection flag.

## Alternatives rejected

- **Keeping a measurement gate per transport.** A gate exists so shipped code
  cannot silently flip traffic onto an unmeasured mode, but a ladder rung
  entered only when the built probes fail has no traffic to flip: the
  operator listing it in a deployment where nothing else works is the
  measurement (d081's amendment).
- **Keeping the `-modes`/`MODES` knob.** The offer is a per-dial fact only
  the client can observe, so pinning it at configuration time is guessing, and
  every spelling of the knob could only degrade the ladder (d093).
