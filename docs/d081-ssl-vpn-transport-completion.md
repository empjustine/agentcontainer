---
id: d081
type: architecture-design
status: accepted · the -modes default-flip gate (L3) superseded by d084 (operator decision: deploy first, measure in production); the mode-E build gate (L4) superseded by this record's amendment (mode E built without measurements — mechanics settled by the hostile-link model, parameters provisional, L4 demoted to production characterization)
title: "d081 — completing the tunnel family: Mode C adoption is a spike gate, Mode E builds to spike numbers"
parent: llm-reverse-proxy
depends-on: [d073, d077]
references: [d047, d070, d080]
---

## Status

v2 (mode A + mode D) is delivered; mode C is built (default-on since d084 — the L3 default-flip gate below is superseded); mode E
is built (docs/d077 — the L4 build gate in decision 2 below is superseded
by this record's amendment). This record decides **how the family completes and
in what order** — not what the transports are: d077 owns their mechanics,
d073 owns their requirements, and this record restates neither.

## Decision

1. **Mode C has no remaining build work — only a gate.** Adoption is
   flipping the client `-modes` default `d` → `cd` and nothing else, and
   the flip happens only when spike **L3** passes (N ≥ 6 concurrent
   streaming POSTs through Funnel, d077 §8). Until then C stays opt-in: a
   default that silently changes the traffic shape is exactly what
   `parseClientModes`' fail-loudly contract refuses on the client side
   (d077 §4) — the flag default is the same class of decision, held to the
   same standard.
2. **~~Mode E builds only to measurements.~~ SUPERSEDED by this record's
   amendment — mode E builds without L4; L4 is characterization, not a
   gate.** The original gate misfired on three counts, and the amendment
   records why so it is not re-imposed:
   - **The measurement does not transfer.** L4 ran against the work ingress,
     but E's trigger is *any* damaged link (this record's decision 4 says
     the work env is "the expected E trigger, not the only one"). Numbers
     from one gateway posture cannot set the parameters of a mode that by
     premise runs where gateways are hostile and links unreliable — a mode
     for damaged connectivity cannot be tuned to any single path's
     measurements, only given conservative defaults that are safe
     everywhere.
   - **The mechanics are decidable without data.** The one fork L4 was to
     settle — long-lived request body vs. per-exchange windowing — is
     decided *by the hostile model itself*: a long-lived body dies with the
     connection and needs cross-reconnect session state exactly where the
     link is least trustworthy, while windowed exchanges each stand alone
     (a dropped window retries; nothing to resurrect). d077 already marked
     E's cost "accepted" — one round trip per exchange, correctness not
     speed — so a timing spike had only parameters left to give, and
     parameters are what this repo already ships provisional (S1's
     keepalive/reap constants in `relay.go`: measured after, not before).
   - **The gate protected nothing.** Spike-gating exists so shipped code
     cannot *silently flip traffic* onto an unmeasured mode — C's default
     flip, and d084 already superseded even that with deploy-first. E never
     enters traffic by default-participation: it is the last rung of the
     C → D → E ladder, reached only when both built probes fail, and the
     operator listing `e` (or the default offer — d084) in a deployment
     where nothing else works **is** the measurement. There is no traffic
     to flip.

   **L4 (with L1) demoted to post-hoc characterization:** run them when a
   deployment environment wants E's numbers, to validate the shipped
   provisional constants and the carrier choice — never to unblock code.
   The mode stays media-type-neutral in spec (Study A's SSE carrier keeps
   its adopted-*in-intent* status, d077 §6).
3. **The Mode E shape is decided now; its parameters ship provisional
   (the S1 pattern — the amendment to decision 2).** The build is:
   - **client** — a stop-and-wait `tunnelStream` implementation feeding
     the same handshake and relay pump (d077 §5), `parseClientModes`
     accepting `e`, and the demotion chain C → D → E carrying the invariant
     that Mode E never surfaces as a failed exchange — the client demotes
     to the next mode instead (d077 §5);
   - **server** — a `serveTunnelPOST` sibling where the first authed POST
     mints per-`trace-id` state (TTL + reap, never leak), an unknown
     `trace-id` answers the camouflage 404 (VPN-R34), and every request
     re-authenticates with the constant-time bearer (the C/E analogue of
     VPN-R12's handshake auth);
   - **demux** — `trace-id` stops being logging identity and becomes the
     real stream key (d077 §4–§5);
   - **tests** — per-mode unit + end-to-end coverage mirroring
     `modec_test.go`/`vpn_e2e_test.go`; a mode without an e2e is a spike,
     not a mode.
4. **Spike L2 reorders, never vetoes.** L2 (work-ingress posture: ALPN
   offer, upgrade pass-through, streaming flush) decides which mode the
   restricted work environment *uses*; a deviation from the all-pass
   expectation reorders the work along the environment instead of C → E
   (d077 §8). The work environment is the expected E trigger, not the only
   one: E builds when a deployment needs it — no spike ahead of it (the
   amendment to decision 2); L4 characterizes it after, if anyone wants
   the numbers.
5. **Nothing here moves the fallback or the host policy.** Mode A is the
   fallback forever (d073), and the d047 allowlist stays mode-A-only
   (d080) — C/D/E carry egress policy (VPN-R35..R38), never host policy.

## Work breakdown

| Gate | Runs where | Decides | Unblocks |
|---|---|---|---|
| L1 | anywhere with funnel access | the 33 ms streaming bar | E's response carrier |
| L2 | the work ingress env only | which mode that env uses | order of the C default flip vs the E build |
| L3 | anywhere with funnel access | E2's overlapping-body claim live | `-modes` default → `cd` |
| L4 | the work ingress env (gateway buffering is the question) | *nothing — post-hoc characterization of E's shipped provisional constants (amendment to decision 2)* | nothing (originally: every line of E code — gate removed) |
| L5 | Study B trigger only (d077 §7) | whether inner TLS re-opens | nothing today |

Spike definitions and pass bars are d077 §8's; where this table
paraphrases, d077 wins.

## Non-goals

- **Mode B** (authenticated generic relay) stays deferred to v3 with its
  own acceptance record; nothing here implies it (d073).
- **Study B / inner pinned-anchor TLS** stays not-adopted; L5 is a watch,
  not work (d077 §7).
- **Spike method details** are ops runbooks, not architecture — they live
  wherever they get written, not in this log.
