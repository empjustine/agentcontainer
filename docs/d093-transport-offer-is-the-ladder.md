---
id: d093
type: decision
status: accepted
title: "d093 — the offer is the whole ladder: -modes and MODES retire; mode selection is the relay node's per-dial ranking"
parent: llm-reverse-proxy
depends-on: [d073, d077, d081, d084, d090]
references: [d085, d088]
---

# d093 — the transport offer is the whole ladder

## Problem

The transport offer had three spellings of one fact — the `-modes` flag, the
`MODES` env, and `run.sh`'s forwarding of it into both branches (d084 §3
even needed a rule that `run.sh` must not restate the flag's default, which
is the tell that the spelling count was already out of control). Worse, every
spelling of the knob could only ever **degrade** the ladder.

The transport choice is not a deployment fact at all. It is discovered per
dial against what the endpoint actually does — ALPN h2 ⇒ C, upgrade 101 ⇒ D,
refusal ⇒ E's floor (d077 §9's ranked ladder) — and the ranking inputs exist
only at the dial, which is the relay node's side: the tunnel's client. An
operator pinning the offer at configuration time was guessing about a fact
only the client can observe, and d084's flag existed for exactly one
historical reason: gating the default flip while mode C's rollout settled.
The rollout settled.

The knob also forced a config-time guard: d090 §2's C⇒wss cross-check in
`validate()`, because *offering* `c` against a cleartext URL was a config
error that failed lazily. With the offer fixed to the full ladder that
failure mode is unreachable — C never probes a cleartext plane
(`alpnNegotiate` skips non-wss; the rung is simply not offered *there*),
D and E always remain, and the empty-attempt-list error needs a restricted
offer to occur. The check and the knob retire together.

## Decision

1. **The offer is the constant full ladder, in rank order (c, d, e).**
   `dialTransport`'s per-letter gates die: C → D → E runs unconditionally,
   the demotion log lines and the composite attempt record are
   unconditional, and the startup log still prints the offer — one spelling,
   in the binary.
2. **`-modes`, `MODES`, and `run.sh`'s forwarding (both branches) retire**;
   so do `parseRelayModes` and `relayConfig.modes`. `relayConfigFromEnv`
   loses its modes parameter.
3. **d090 §2's C⇒wss startup check retires here (superseded).** The
   dial-time backstop stays: `openPOST` still requires `wss` and refuses a
   cleartext C attempt by construction. A cleartext URL remains a valid
   config — d090's mode E cleartext acceptance (`http://` + ladder ⇒ C
   skips, D/E carry) is unaffected.
4. **No migration surface.** `run.sh` and the binary ship in lockstep
   (docs/d083); a stale launcher passing `-modes` to the new binary fails at
   `flag.Parse` — loud, before any bind. A leftover `MODES` env is simply
   never read.

## Alternatives rejected

- **Keep the knob and document it** — the three spellings drift, and the
  knob's only possible use (degrading a ladder the endpoint ranks for you)
  is answered better by an endpoint that refuses.
- **Server-side selection** — the exit node serves whichever carrier
  arrives; the ranking inputs (ALPN outcome, upgrade refusal) exist only at
  the dial. Selection anywhere else is guessing.
- **A hidden diagnostic flag** — a second, undiscoverable spelling of the
  same fact. Tests pin behavior by endpoint shape (upgrade-stripping
  gateway, h1-only TLS front), not by offer restriction.

## Phases

1. **This record + index** (docs/d093; README index row; d084's row
   annotated "the knob retired by d093"; d090's row annotated "the C⇒wss
   check retired with it"; unit README).
2. **Code** — `main.go` (flag dies), `relaynode.go` (constant offer;
   `dialTransport` gates, `parseRelayModes`, `relayConfig.modes`, and the
   C⇒wss check die), `run.sh` (env/argv forwarding dies, both branches).
3. **Tests** — `TestParseClientModes` dies; the plain-h1 mode E e2e rides
   the upgrade-stripping gateway (with the ladder whole, a plain tunnel
  server legitimately carries D — E is what a *refusal* demotes to); the
   config table loses the modes dimension.

## Acceptance

- `-modes`/`MODES` return nothing in the unit but history.
- `wss` + h2 front: C carries (existing e2e).
- `ws` + plain tunnel server: D carries (the server offers 101).
- `ws` + upgrade-stripping gateway: D demotes to E, logged (existing e2e).
- `https` + h1-only TLS front: C skips, D refused, E carries (d090's
  generalized-URL e2e, now on the constant offer).
- Existing suite green.
