---
id: d131
type: module-design
status: draft
title: "d131 — the v4 credential's proof mechanism: envelopes, verification and the version counters"
parent: estige
depends-on: [d104]
references: [d073, d077]
tags: ["serving", "proxy", "vpn", "auth", "ed25519", "mechanics"]
---

# d131 — v4 credential mechanics: envelopes, verification, versions

**Mechanics companion to [d104](d104-mutual-exit-relay-credential.md).**
Everything here is subordinate to that record's decision: d104 owns _what_ the
v4 credential is and why; this record owns the shape of the proofs, how a node
verifies one, what the version counters mean, and what a verify costs. Read d104
first — nothing in this file makes sense as a decision on its own.

Split out because d104 had grown to ~6,800 words: the decision, its requirement
deltas, its consequences and its rejected alternatives stay there, and the
mechanism you would only read when implementing or auditing moved here.

## Versions — deployment v4, envelope token `v2`

Four counters exist and they mean different things; the implementing change
must not conflate them:

- **Deployment generation** — the tree-wide numbering, owned by d108 and not
  renumbered here: v1 is a trusted reverse proxy with allowlisted hostnames,
  v2 the same with symmetric auth credentials (never deployed), v3 the tunnel
  transports under the shared env bearer (**what ships today**), and v4 the
  same transports under this scheme. This record IS v4; the earlier "estige
  tunnel v2" phrasing was this record's own credential counter and is retired
  (see the history note below).
- **Envelope token** — stays `v2`, along with the `estige/v2/` label prefix.
  This is deliberate and is NOT the deployment generation: the token versions
  the proof ENVELOPE (its fields and its label domain), which did not change
  when the deployment numbering was adopted. A future proof revision
  re-versions the token and the prefix together, so a v3 envelope can never be
  signed under `v2` labels — and carrying two numbers is safe precisely
  because a node refuses an unknown token without computing anything.
- **HELLO/frame version** (VPN-R15) — stays 1. No frame changed; auth runs
  before any HELLO, so a cross-generation peer dies at the credential layer
  (a bearer where a proof is expected, or the reverse) as a fail-closed
  camouflage 404, before a frame version could ever disagree.
- **The envelope token is the wire-visible one** — a node must be able to
  refuse an unknown envelope without computing anything.

**What v4 changes, and what it does not.** The wire shape is this record's as
designed: same envelopes, same both-directions signatures, same single-flight
exchange, same replay caches (one per end) and session bound. What v4 changes relative to v3
is where credential material LIVES — files under the role-scoped store, not
`VPN_*` environment variables. That is why the `VPN_*` tunnel surface is
deprecated with this generation (VPN-R32's amendment) instead of surviving as
a parallel path, and why this record's renumbering is a naming change rather
than a new mechanism.

**History (why the numbering moved).** This record originally counted its own
credentials: v1 the shipped bearer, v2 this scheme. That counter collided with
d108's generation table, where v2 is the never-deployed symmetric-credential
proxy, and the collision is what produced a "d104 v4 / bearer v3" reading in
circulation. Nothing was ever deployed under the old counting on the proof
side, and the bearer side keeps d108's name, so the renumber is in place
rather than a generation bump.

## Mechanism — single-flight mutual Ed25519 proofs

Single-use nonce-bound signatures: no clock, no window, no TOTP-style
digit truncation, no shared secret. The relay draws its nonce and
computes its proof before the exchange; the exit computes its own inside the
response it was going to send anyway — one message each direction, no challenge
round trip (a challenge needs a pre-auth response — an oracle, which VPN-R34
forbids — and a wasted round trip for a peer that can compute its proof up
front: a client-drawn nonce riding the existing first message needs no extra
flight). Freshness comes from the nonces, and each end consumes its own.

```
relay → exit:  X-Relay-Proof: v2.<relay-key-name>.<nonce_r>.<sig_r>
               sig_r   = Sign(sk_relay, "estige/v2/relay-to-exit" ‖ nonce_r ‖ relay-key-name ‖ exit-key-name)
               nonce_r = 16 random bytes (crypto/rand), drawn fresh for every authenticated connection
exit → relay:  X-Exit-Proof:  v2.<exit-key-name>.<nonce_e>.<sig_e>
               sig_e   = Sign(sk_exit,  "estige/v2/exit-to-relay" ‖ nonce_e ‖ nonce_r ‖ exit-key-name ‖ relay-key-name)
               nonce_e = 16 random bytes (crypto/rand), drawn fresh for every proof-bearing response
```

- **The envelope grammar is pinned, and it is d132's convention on the wire**
  — one encoding, so no field is hex on one side of the seam and base64url on
  the other. `v2.<name>.<nonce>.<sig>` is exactly four dot-separated segments:
  the token literal `v2`; the minter's name under d132's `[A-Za-z0-9_-]{1,64}`
  charset (which has no dot, and that is what makes four segments parse); the
  nonce as **unpadded base64url, 22 characters** (16 raw bytes); the signature
  as **unpadded base64url, 86 characters** (64 raw bytes). A header that is not
  four segments, a field of the wrong length, or base64url that decodes to the
  wrong byte count is malformed and never repaired — it answers the camouflage
  404 (VPN-R34) before any name scan or verify. Unpadded on purpose: `=`
  padding is a second spelling of the same bytes, and a parser with two accepted
  spellings is a parser with two ways to disagree.

  **The encoding carries the exact byte count and nothing else.** Each field has
  one legal content: the canonical unpadded base64url spelling of the precise
  number of bytes the verifier needs — 16 for a nonce, 64 for a signature. Three
  checks, in this order, and none of them is a repair: the field's **length** is
  bounded first, so an over-long value (anything that could not encode exactly
  16 or 64 bytes) is refused before a decoder ever sees it and a hostile
  multi-kilobyte header costs neither memory nor CPU; then the decode must
  produce exactly that many bytes; then **re-encoding the result must reproduce
  the input byte for byte**, which is the one check that rejects non-canonical
  trailing bits, the standard alphabet's `+` and `/` where base64url has `-` and
  `_`, embedded whitespace or newlines, and any other spelling of the same
  bytes. Canonicality is not pedantry here: a signature that can be spelled two
  ways is a signature two implementations can disagree about, which is exactly
  the drift the store side already refuses (d132).

  **Failure is a camouflage break, never a correction.** A malformed, over-long
  or non-canonical field is answered with the same byte-identical response the
  allowlist relay gives garbage (VPN-R34) **and the connection is broken there**:
  mode D closes without a WebSocket, modes C and E fail that exchange with no
  reuse of the carrier. Nothing is re-encoded, trimmed, re-padded or retried, and
  the relay never "repairs" a proof — a broken field is indistinguishable from
  a wrong signature, an unknown name or a replayed nonce, which is the whole
  point. It is also **not a dial failure**: a credential the exit refused does
  not demote the transport ladder (d077's ladder is about carriers, not
  credentials), so the same target is not re-attempted on the next rung.

- **Two principals, two keys, two names — each envelope names its
  minter, and the verifier holds only the minter's public key.** The
  relay's proof is signed with the relay's private key and names it; the
  exit indexes its admitted-relay list by that name and verifies against
  the embedded public key. The exit's proof is signed with the exit's
  private key and names it; the relay verifies the same way against its
  embedded expected key. **Neither side can mint the other's direction —
  and this time the property is structural**, not prose: a verifier
  holds public keys, which cannot sign. (A shared-secret scheme cannot
  have this property: verification requires the full key, so both
  endpoints necessarily hold both directions' secrets. See the
  alternatives.) The key name is a **label, never a capability**
  (d078's id sense): the private seed never leaves its node, and the
  public key grants nothing without a signature over this exchange.
- **Both key names enter both signed messages.** A proof binds both
  principal identities, so one minted for exit A verifies neither at exit
  B nor under a renamed entry.
- **Full 64-byte signature, base64url — never truncated.** RFC 4226's
  31-bit dynamic truncation (and TOTP's ~20-bit digits) exists so humans
  can type codes; both ends here are machines. Ed25519's ~2^128 forgery
  class puts brute force off the threat list entirely — replay, not
  forgery, is the attack a proof must bound, and the nonce is that bound —
  which is why rate limiting is DoS hygiene here, not
  a security control.
- **Algorithm: Ed25519, stdlib `crypto/ed25519`.** Deterministic
  (identical message → identical signature: no signing-time RNG) — which
  is exactly why the nonce is _in_ the signed message: a message with no
  per-exchange entropy makes every proof of a step byte-identical (the
  retired shape's weakness, carried in the alternatives); the nonce makes
  every exchange's signatures unique while signing stays deterministic
  and replay-friendly to test. Parameterless (no curve choices, no padding
  discipline), constant-time verify, zero new dependencies — the
  repo's zero-dependency ethos holds. ECDSA's nonce/low-s history,
  RSA-PSS's size and padding, and X25519+HMAC's shared-secret collapse
  are rejected in the alternatives.
- **Domain-separation labels are direction plus version**
  (`estige/v2/relay-to-exit` / `estige/v2/exit-to-relay`): a relay's
  proof can never verify as an exit's (reflection-safe), and the labels
  are the composition point for the hub-and-spoke future —
  relay-to-exit-to-relay is two ordinary pairwise hops, each verified
  independently, zero new crypto. Relay-relay direct needs only a
  rendezvous the restricted network is unlikely to ever allow: not
  designed for, not excluded.
- **The exit's proof binds `nonce_r` and answers with `nonce_e`** — the
  pair belongs to exactly one exchange, and each field has a job. `nonce_r` is
  the binding that carries the weight: the relay drew it itself and never reuses
  it, so an exit proof captured on an earlier exchange cannot verify against a
  later connection — a verifier that checked only the signature would accept the
  capture, one that also checks this tie cannot. `nonce_e` is the exit's own
  freshness field: signed into `sig_e` and consumed by the relay's replay cache
  (below), so it is live rather than decorative, and it is what makes a replayed
  exit proof detectable _independently_ of the `nonce_r` tie. The relay verifies
  it and fails closed (VPN-R26's spirit): an exit
  whose key is not the one embedded in the relay's pairing is refused at
  the handshake, beyond VPN-R28's hostname pinning. Today's
  `Sec-WebSocket-Accept` check proves nothing about server identity —
  anyone can compute it from the client's own key.
- **Freshness = a single-use nonce, and each end consumes its own.** After a
  relay proof verifies, the exit puts its `nonce_r` in a replay cache; a second
  presentation of the same nonce answers the camouflage 404. After an exit proof
  verifies, the relay puts its `nonce_e` in a cache of the same shape and
  refuses the repeat — a repeat is not a request to retry, it is a peer
  presenting a proof that was already accepted, so the exchange answers the
  camouflage 404 **and the relay tears that session down** (mode D: the tunnel's
  WebSocket; modes C and E: the request fails and the next exchange must present
  a fresh proof), with no retry and no fallback to another exit. Each cache
  grows only on proofs that verified — a forged or unknown-name proof never
  reaches one, and an attacker without a principal's private key cannot mint
  valid proofs to fill that side's cache — so each is one LRU ring with a 64
  Ki-entry cap (≈2 MiB at 16 bytes per nonce) whose eviction horizon is 64 Ki
  _genuine_ authentications: practically forever, and no clock is read anywhere
  in the auth path — a drifting host can cause an outage elsewhere, never a
  weakened or widened auth decision.

  The `nonce_r` tie above already stops a captured exit proof from verifying, so
  the relay's ring makes that property redundant rather than load-bearing: a
  future refactor that loses the tie degrades to "one replayed exchange, refused
  and disconnected" instead of "unlimited". What a captured _relay_ proof buys
  an attacker is exactly one thing: _block_ the genuine exchange first
  (otherwise the genuine flight consumes the nonce), then present the captured
  proof once — one CONNECT on one connection (the session bound below) and
  nothing more. That is the declared residual, strictly smaller than any
  time-window: a window admits unlimited replays for its duration; the cache
  admits one.

- **One authentication buys one connection, one CONNECT — nothing
  chained.** The protocol already carries the shape structurally
  (VPN-R17: one WebSocket per CONNECT; any control frame during the
  relay phase, a second CONNECT included, is a protocol violation), and
  this record states it as a security bound, not an implementation
  accident: no renegotiation exists, a session dies with its
  authenticated carrier, and a mode E session — whose trace-id registry
  outlives individual POST exchanges — complies by authenticating every
  exchange afresh. This is the honest mTLS-equivalence: mTLS makes a
  captured handshake worthless _and_ keys the session traffic with the
  negotiated record keys; a signature is not a key agreement, so this
  scheme buys the same admission guarantee with bounds instead — the
  handshake is single-use, and what it admits is one connection's one
  tunneled target.
- **No body in the signed message — identity and nonces only.** The
  tunnel surface is one fixed reserved path (VPN-R42), so to any third
  party — network observer, funnel edge, TLS terminator — every exchange
  reads as the same GET/POST to the same URL: method and path are
  constants an attacker cannot vary, and signing them would bind
  nothing. The signed counterparty name already carries the
  endpoint-binding role (a proof minted for exit-home names exit-home),
  and the funnel hostname is a deployment constant. Signing the body
  would re-import RFC 9421's streaming killer, and TLS
  already carries body integrity on the client→edge leg (the edge→node
  leg is the operator's own tailnet).
- **Every tunnel-namespace authentication point speaks the envelope.** The
  mode D upgrade carries it on the handshake request/response headers;
  modes C and E carry it on each POST's request/response headers — d077's
  per-request credential point, since a body session has no handshake
  header of its own. Same shape, same verification, one envelope each way
  per authentication.

## Cost — index by name, one verify per proof

The store is read and validated **once at boot**; the admitted sets load
into memory. Verification is then symmetric on both nodes and has bounded,
constant cost:

- **Each node scans its admitted set's names — constant-time per row, over
  every row, no early exit** (VPN-R33's discipline, kept): the exit scans
  `exit.json`'s `relays` entries; the relay scans `relay.json`'s ≤2
  `exit` entries. Every name is compared full-width, and the scan visits
  all rows whether or not one matched, so neither the matched principal's
  position nor the set's contents leak through timing. Nanoseconds per row
  against the bounded-set cap (32, carried over) — a lookup, not the
  credential check.
- **Exactly one Ed25519 verify is computed per proof** — the matched
  public key's signature check, full-width by the primitive. No match
  means no verify: that request answers the camouflage 404 having paid
  one scan. The whole cost argument: authentication is O(rows) byte
  compares plus a single verify, independent of set size and of which
  name was presented — a fifty-relay exit pays what a one-relay exit
  pays. The verify itself costs ~30–80µs (vs. a MAC's sub-microsecond):
  negligible at handshake rates, a few percent of a core at a few hundred
  per-request authentications per second (modes C/E) — recorded in the
  consequences with its DoS arithmetic.
- **Each replay cache costs one map probe per _verified_ proof** — forged
  and unknown-name proofs never reach either — and its memory is the cap,
  independent of attack traffic: the exit's ring grows only on genuine
  handshakes, the relay's only on exit proofs it accepted, so an attacker
  without a principal's private key cannot grow that side's ring. Two rings at
  ≈2 MiB each is the whole memory cost of replay protection in both directions.
- The residual timing delta — an unknown name skips its one verify,
  tens of microseconds — is below network jitter and against a name that
  is a log-safe label the operator's logs already print; the load-bearing
  oracle control is VPN-R34's byte-identical response vocabulary, not
  microsecond flatness (the dummy-key flatten is rejected below).
