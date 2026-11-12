---
id: d171
type: module-design
status: active
title: "d171 — the -insecure-exit switch unifies both degraded relay→exit postures"
parent: estige
depends-on: [d073, d094, d169]
references: [d088, d104, d131, d145, d163]
tags: ["estige", "relay", "tls", "degraded-mode", "v3-v4-v5"]
---

# d171 — the -insecure-exit switch unifies both degraded relay→exit postures

This record puts every degraded relay→exit transport posture behind one argv
switch, `-insecure-exit`: skipped certificate verification on an
`https`/`wss` tunnel leg **and** a cleartext `ws://`/`http://` tunnel URL
become flag-gated operations, and the silent cleartext acceptance d094
recorded closes behind the same flag. It amends VPN-R55 — d073's requirement
bullet carries the pointer, the amended text lives here — and supersedes
d094's cleartext decision where the two disagree. It also settles what the
relay may carry while degraded: the parsed cleartext-forward door refuses
before any session opens, the blind doors keep their shape, and a narrow
first-bytes guard closes the one accident class the loopback surface can
create. The reader is the implementer of the switch and the auditor who must
be able to state, from this file alone, exactly what exposure an operator
accepts by setting it.

## Status

Decision in force; implementation pending. Today's code has no such flag,
accepts a `ws://` tunnel URL at config time with no warning unless a chain
proxy is configured, and keeps the absolute no-skip rule at all three of its
TLS construction sites. The exposure table below is the switch's contract and
must travel with any implementation of it.

## Problem

VPN-R55's rule is right in intent: the authenticated relay's `https`
upstream leg must verify chain and hostname, and `InsecureSkipVerify` — "or
any equivalent skip" — must not appear in any transport, because the loopback
client already trusts this front with plaintext, leaving the relay as the one
party who _can_ verify the upstream. The requirement's scope, however, named
only `https` legs, and the tree drew a strange gradient from that gap:

- an encrypted-but-unauthenticated leg was absolutely forbidden;
- a fully cleartext leg was legal. `relayConfigFromEnv` accepts `http://`
  and `ws://` tunnel URLs and normalizes them, mode E runs the ladder's
  floor over plaintext, and a chained cleartext URL was "accepted, loudly"
  by d094 — while an unchained one produced no warning at all beyond the
  scheme printed in the boot line.

The fence stopped the smaller trespass while the larger one walked through:
worse was allowed, and allowed by mistake — a judgment error in the
requirement's scope rather than a code accident, since d094 argued "refusing
would buy nothing" and the argument won. The practical consequence fell on
operators with defective certificates (a self-signed exit front, an internal
CA absent from system roots, an IP-literal hostname mismatch): the only
escape from a verification failure was to change the tunnel URL to `ws://`,
trading an authentication defect for total cleartext including the bearer on
every frame. The switch removes that trade and names which half of it an
operator is choosing.

The relay serves three doors while degraded, and they differ in what the
relay knows about the bytes: the d103 cleartext-forward door parses its
request and therefore knows the exchange is cleartext by construction; the
HTTP CONNECT and SOCKS5 doors are blind tunnels whose payload class is
unknown until observed. That knowledge split is the gate's foundation and is
stated under the gate heading below.

## Decision

### One switch, two postures

- **The switch** — `-insecure-exit`, argv, relay role only, default off.
  It rides the same ledger as `-legacy-ip-relay`: a switch this
  load-bearing must be visible in the process's own command line (d145,
  d163), not spelled in the environment. Passing it with `-mode=exit` is a
  boot refusal — the exit node dials nothing.
- **With the switch, posture (a)** — an `https`/`wss` tunnel leg keeps TLS:
  encryption and `MinVersion` untouched, certificate verification skipped.
  The skip lands at the three construction sites (`dialTLS`, the mode C
  transport, the mode E transport) through one config field; no other
  transport gains a knob.
- **With the switch, posture (b)** — a cleartext `ws://`/`http://` tunnel
  URL is allowed, as it is today, now only under the flag.
- **Without the switch** — `https`/`wss` verifies exactly as today, and a
  cleartext tunnel URL is refused at config time, before any listener binds,
  in `relayConfigFromEnv`'s existing fail-closed shape (VPN-R26). The
  silent-cleartext loophole closes with it.
- **One warning line** at boot names the posture and points at the exposure
  table below; the health surface (VPN-R27) reports the degraded state
  beside the tunnel endpoint, so a session's logs can be read against the
  posture that carried it.
- **Scope** — certificate defects only. The switch never lowers a protocol
  floor: an exit too old for the configured `MinVersion` still fails the
  handshake, and no suite selection changes.

### What the switch never touches

- The funnel front door: its "no opt-out knob" stance stands untouched —
  the exit's own face keeps verifying.
- VPN-R26's no-direct-dial: the switch changes posture, never route. A
  refused tunnel still answers locally; there is no fallback dial.
- VPN-R25 and VPN-R29: the relay still terminates no target TLS and holds
  no target certificates; end-to-end validation still happens at the
  client, on the target's real certificate, regardless of how rotten the
  relay→exit leg is.
- VPN-R28: the client-side trust-anchor rule is untouched; the switch is
  relay-side and installs nothing.
- The camouflage 404: exit-side and admission-side behavior is unchanged;
  the switch lives after admission, on the dial.
- The VPN-R9 taxonomy for every failure that is not certificate
  verification: those still fail closed with their existing answers.

### The exposure each generation accepts

The switch's cost is not one number; it is this table, which is the
boot warning's substance:

| generation | what an active observer of the degraded leg gets                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v3         | the long-lived bearer — TLS encryption still hides it from passive observers, and skipping verification hands it to whoever terminates the handshake — plus every cleartext exchange and post-admission frame injection. Bearer rotation is the blast-radius bound.                                                |
| v4         | no key material: proofs are signatures over single-use nonces, so at most one replayed admission past the exit's replay cache. The admitted channel is open, though — inject, truncate, forge `frameConnect` (the egress policy still applies to whatever opens).                                                  |
| v5         | availability only. The inner mTLS session authenticates both nodes regardless of the transport certificate, so an active observer fails the inner handshake and the session tears down — never a silent downgrade. The observer can burn one single-use proof in a race; that denial of service is the whole loss. |

With a benign defective certificate — no observer, just a self-signed front —
v5 runs at full security under the switch: its roots are pinned inner
material from the store (d169), never system roots, so the switch is the
supported way to run a CA-less pairing rather than a compromise for it.

### VPN-R55 (amended)

- **VPN-R55 (amended by d171)** — The authenticated relay's upstream tunnel
  leg MUST verify chain and hostname by default and MUST fail closed with
  the RFC 9457 taxonomy (VPN-R9) on verification failure. Two degraded
  postures exist, both gated by the one argv switch `-insecure-exit`: an
  `https`/`wss` leg with certificate verification skipped — encryption and
  minimum version unchanged — and a cleartext `ws://`/`http://` tunnel URL.
  Without the switch no transport may skip verification, and a cleartext
  tunnel URL is refused at config time before any listener binds
  (VPN-R26's shape). The switch is relay-role only, defaults off, and the
  boot line names the posture and its per-generation exposure. The front
  door, the no-direct-dial rule, and client-side target validation are
  untouched.

### The gate

**The parsed door refuses.** While the switch is on, the d103
cleartext-forward branch is refused before any tunnel opens — a local
answer in the problem vocabulary the local refusals already use, because at
that door the relay knows the exchange is cleartext by construction. This is
the "never insecure http proxy anything" line, and it is the one line fully
enforceable, since knowledge exists before cost does.

**The blind doors keep their shape, guarded.** HTTP CONNECT and SOCKS5 stay
blind tunnels — but in a degraded session the first bytes the loopback
client writes into a fresh tunnel are classified before they are forwarded.
An HTTP/1.x request line closes the tunnel and logs the reason locally;
everything else passes untouched: a ClientHello, an upgrade preamble, a
server greeting, an unknown protocol.

Classification is narrow on purpose. A broad "close anything plaintext"
rule would close every STARTTLS flow: SMTP submission opens with `EHLO`,
and server-first protocols — SMTP's `220`, POP's `+OK`, IMAP's `* OK` —
put a plaintext greeting on the wire before either side can upgrade, so the
relay's first observed bytes there are the target's, not evidence of the
client's intent. The narrow guard implements the rule the flag actually
exists for: no cleartext _HTTP service_ over a degraded leg. Other
protocols cross at the client's own posture, and STARTTLS's downgrade
protection is the client's opportunistic-TLS business regardless — an active
leg observer can strip an upgrade offer, and no relay-side gate prevents
that without breaking the protocol. That exposure is inherited from the
switch and recorded here rather than pretended away.

Classification is also an accident-guard, not a boundary, and both halves
of that sentence bind. The loopback clients are the operator's own tools on
a loopback-only listener (VPN-R23), so the guard exists to catch accidents —
a tool honoring `ALL_PROXY` with an `http://` URL — not to withstand a
hostile local client; a masqueraded payload passes by design. And parsing
within that accounting is legitimate under d103's standing lesson: byte
visibility is the invariant, the blind-pump shape is not.

One semantic cost is unavoidable: for the blind doors the success reply
(`200` or the SOCKS success) is already on the loopback wire when
classification fires, because a client sends nothing until it receives that
reply and classification needs its bytes. The refused accident therefore
ends as a close plus a log line, not a clean client-facing answer —
inventing a mid-tunnel error frame would extend the tunnel protocol for a
relay-local policy, which the protocol has no reason to carry.

## Implementation surface

| piece               | shape                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| config              | `relayConfigFromEnv` takes the flag; cleartext URL without it is a config error before any bind; the flag under `-mode=exit` is a boot refusal |
| the three TLS sites | one config field consumed at `dialTLS`, the mode C transport, the mode E transport; `MinVersion` and `ServerName` untouched                    |
| boot and health     | one WARNING line naming posture and exposure; `/healthz` reports degraded=true                                                                 |
| forward door        | pre-tunnel refusal with a local problem code while the switch is on                                                                            |
| the guard           | classify first client bytes in degraded sessions, close and log on an HTTP request line — the bulk of the new code                             |
| tests               | below                                                                                                                                          |

The test matrix: flag off plus `ws://` refuses at config time (the closed
loophole); flag off plus a self-signed `https` fails verification as today
(VPN-R9); flag on plus a self-signed `https` opens a session with the
warning line present; flag on plus an absolute-form request at the forward
door answers locally with no session on the exit; flag on plus `GET /` as
first bytes through CONNECT and through SOCKS closes the tunnel with the log
line; flag on plus a ClientHello, plus `EHLO`, plus a `220` greeting pumps
untouched — the STARTTLS-alive case is a named test; the flag under
`-mode=exit` refuses at boot. The existing `ws://` suites
(`wireRelayNode`, the e2e cases) gain the flag and become the degraded-mode
harness without new fixtures.

## Consequences

**Gains**

- One switch, one exposure statement: every degraded posture the relay can
  assume is nameable from the command line and printable at boot, instead
  of half of them hiding in a URL scheme.
- The silent cleartext loophole closes — a `ws://` tunnel URL now costs an
  explicit argv line, and the chain record's loud acceptance narrows to the
  same flag.
- Operators with defective certificates keep TLS encryption on the leg
  instead of trading it for cleartext.
- v5's CA-less pairing gets a supported path with no security loss beyond
  the denial of service in the table.

**Costs**

- VPN-R55's absolute fence becomes conditional: deliberate, argv-gated, and
  priced by the exposure table — that is the entire content of the
  amendment.
- A first-bytes heuristic sits on the blind path: narrow by construction,
  accounted under d103's visibility invariant, and required to refuse on
  appearance alone.
- Blind-door refusals are closes, not answers, for the timing reason above.
- Every test dialing `ws://` must carry the flag: a loud diff, which is
  also its review surface.

**Unchanged**

- The front door's no-opt-out stance, VPN-R26's kill switch, VPN-R25's
  fence, VPN-R29's end-to-end validation, VPN-R28's anchor rule, the
  camouflage 404, and the VPN-R9 answers for non-certificate failures.

## Alternatives rejected

- **Blanket close on anything that looks plaintext** — the direct reading
  of "never proxy insecurely", and it kills STARTTLS in both of its shapes:
  client-first preambles and server-first greetings. Every mail client
  tunneling through SOCKS would break on day one.
- **A ClientHello allowlist ("the tunnel must look like TLS")** — survives
  neither server-first protocols nor upgrades, turns the relay into a
  protocol gatekeeper of the kind VPN-R25's fence exists to forbid, and
  buys nothing against a local population that is trusted by construction.
- **Port-shaping the degraded mode (443 only)** — ports prove nothing about
  payload class, and the egress reasoning already rejects shape-by-port as
  a security argument.
- **A pinned or trust-on-first-use certificate store instead of skipping
  verification** — a new credential surface (files, rotation, first-use
  assumptions) for a posture whose point is temporary degraded operation;
  TOFU would also hand first contact to whoever dials first.
- **An environment spelling for the switch** — the relay's load-bearing
  switches are argv (d145, d163), visible in the process's own command
  line; a variable would hide the posture from exactly the inspection that
  must find it.
- **Leaving `ws://` legal with a warning only** — d094's status quo, and
  the mistake this record corrects: the worse posture must not be the one
  that needs no switch.
- **A v5-specific mechanism (unconditional skip or a second switch)** — one
  spelling per fact: the switch is one fact with three prices, and the
  table states all three.

## Implementation order

1. **Flag plumbing** — argv, config-time cleartext refusal, exit-mode
   refusal, boot warning, health field. Default off is today's verified
   behavior bit-for-bit; the flag is inert until set.
2. **The three TLS sites** — one config field threaded through; the
   verified path must remain the only path when the flag is off.
3. **The forward-door refusal** — pre-tunnel, local vocabulary, with its
   problem code named in the local problem set.
4. **The guard** — first-bytes classification with the STARTTLS-alive and
   masquerade-passes tests in the same change; the close-and-log path
   carries its own log line, never a tunnel-protocol extension.
5. **The existing `ws://` suites** — gain the flag in the same change that
   makes the config refusal real, so the tree never lands a state where
   the tests cannot boot.
