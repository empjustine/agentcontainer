---
id: d169
type: module-design
status: draft
title: "d169 — estige v5: inner mTLS over the tunnel — channel security for an untrusted carrier"
parent: estige
depends-on: [d077, d104, d108, d131, d132]
references: [d073, d081, d085, d090, d103, d133, d136, d171, d185, d211, d236]
tags: ["estige", "tunnel", "mtls", "tls", "crypto", "channel-security"]
---

# d169 — estige v5: inner mTLS over the tunnel

This record proposes **deployment generation v5**: a mutually authenticated
TLS 1.3 session carried inside an already-admitted estige tunnel, so the byte
pipe between relay and exit holds confidentiality, integrity and replay
protection even when its carrier is hostile. It covers the channel layer only —
v4's admission credential ([d104](d104-mutual-exit-relay-credential.md),
[d131](d131-estige-v4-proof-mechanics.md)) keeps its job, its wire shape and
its refusal vocabulary, and none of its crypto choices changes here. It
implements nothing: the record is the design, the build-cost accounting for
each candidate, and the alternatives rejected. The reader is an auditor of the
crypto surface, and three facts come first — every primitive named here is Go
standard library, the new code is one self-signed certificate per store key
plus a `net.Conn` adapter, and verification is the library's own: no
`InsecureSkipVerify` and no hand-written callback whose omission could fail open.

## Status

Draft — a proposal, not in force and not accepted; nothing in the tree has to
obey it yet, and d104/d131/d132/d133 remain the credential design on record.
The implementation would land as a separately sequenced change, the way
d104's own implementation order sequences its steps. An earlier revision of
this draft kept the clock out of the channel with `InsecureSkipVerify` and a
hand-written verifier; the decision below replaces that with the library's
own verification against a bounded validity window, and the rejected shape is
recorded under Alternatives rejected.

An earlier revision also minted an ephemeral leaf under a CA root. That layer
is removed: process compromise exposes the store key at boot in either shape,
so the leaf moved the bytes without moving the boundary. d211 records the
front-door alternative that drops this whole channel layer.

d236 closes the audit of this proposal. It supplies the settled certificate
shape, the `e-auth` and `E-Pub` admission pair, the log-only `seen_hosts` event
and the per-window channel rule. Where this draft disagrees with d236, d236
binds.

## Generation numbering

This record claims the fifth generation of d108's tree-wide table, whose
current state is:

| generation | shape                                                      | state at this record                          |
| ---------- | ---------------------------------------------------------- | --------------------------------------------- |
| v1         | trusted reverse proxy with allowlisted hostnames           | deleted (d108)                                |
| v2         | the same with symmetric credentials                        | never deployed                                |
| v3         | tunnel transports under the shared static env bearer       | what ships                                    |
| v4         | the same transports under mutual single-use Ed25519 proofs | decision records only, implementation pending |
| v5         | v4 plus the channel layer this record designs              | proposed here                                 |
| v6         | front-door mTLS instead of proofs and the inner channel    | proposed in d211                              |

The bearer v3 carries is the static shared key this design exists to outlive;
v4 already replaces it with mutual named-key proofs, and this record adds the
half v4 explicitly does not claim — protection of the bytes after admission.
The `v2` token inside the proof envelope is not a generation: it versions the
envelope shape and stays put until the envelope itself changes (d131's
Versions discussion).

## Problem

v4 authenticates the two nodes and secures admission, and it does not secure
the channel. d131 states the boundary in its own words: mTLS "makes a captured
handshake worthless **and** keys the session traffic with the negotiated
record keys; a signature is not a key agreement, so this scheme buys the same
admission guarantee with bounds instead." After admission, every frame on the
wire — `frameConnect`, `frameData`, a mode E window's `trace-id` and
`span-id` headers — travels with no cryptographic protection of its own.

The design can treat the tunnel as trusted because each leg inherits
protection from another layer:

| leg                  | protection                                                    |
| -------------------- | ------------------------------------------------------------- |
| client → funnel edge | TLS at the funnel's public certificate (VPN-R28)              |
| edge → exit node     | the operator's own tailnet (d131's integrity-by-tailnet note) |

The tunnel protocol claims no integrity of its own; it borrows it. Assume the
carrier between the two estige nodes is hostile — readable, writable,
reorderable — and the borrowing ends. What then becomes possible:

- **Post-admission hijack.** An active carrier cannot impersonate either
  node, because verifiers hold only public keys. It can inject, splice,
  truncate or desync frames inside an admitted session, including a forged
  `frameConnect` that makes the exit open an attacker-chosen target. The
  egress policy still applies (VPN-R35–R38), but the choice of target stops
  being the client's.
- **Payload exposure.** Provider keys and model responses ride the pipe in
  whatever form the carrier carries them.
- **Forgeable mode E windows.** `trace-id` and `span-id` are cleartext
  dispatch headers; on a hostile carrier a duplicate, reordered or
  synthesized window is accepted as ordering evidence.
- **The declared replay residual stays.** Block the genuine exchange, replay
  one captured proof, buy one CONNECT — d104's declared residual, unaffected
  by any channel layer, because a pre-computed proof admits exactly that
  attack by construction.
- **Availability and size stay out of reach.** A hostile carrier can drop
  everything, and no record layer hides sizes or timings; padding would be a
  separate, optional layer and is not part of this record.

Closing the gap needs six things the proofs do not provide:

1. **A key agreement** — ephemeral Diffie-Hellman producing per-direction
   session keys, forward secrecy included.
2. **A record layer** — AEAD with sequence numbers: confidentiality,
   integrity, and replay, reorder and duplication detection per record.
3. **Channel binding** — the identity proof must cover the key-agreement
   material, or a genuine admission can be spliced onto an attacker's own
   exchange.
4. **Transcript binding** — negotiated parameters hashed together, so a
   downgrade or a cross-mode splice fails closed.
5. **A failure posture** — record failures answer in the existing camouflage
   vocabulary, never a distinct signal that confirms a tunnel.
6. **A stated position on padding** — out of scope, recorded as such.

DoS answers to none of them: an unauthenticated flood still costs one verify
(d104's arithmetic), and rate limiting stays hygiene rather than a security
control.

## Decision

**v5 is inner mTLS over the family's byte pipe**: one TLS 1.3 session, mutually
authenticated, carried as payload inside an already-admitted tunnel session,
on every rung of the ladder (modes C, D and E). Its cryptography is Go
standard library `crypto/tls`; its identities are v4's store keys; its outer
wire shape, camouflage 404 and proof envelopes stay as designed. v4's own
choices — Ed25519, single-use nonces, replay caches, constant-time scans, no
clock in the auth path — need no amendment for any of this, and the
envelope-token bump d131 reserves remains the path for channel material if a
non-TLS channel layer ever appears. Each node presents its own store-key
certificate in the handshake; there is no CA root and no per-boot leaf.

### Layering and ordering

The admission proof runs first, at the HTTP layer; the inner handshake runs
after admission answers; the byte pump runs inside the handshake. Two
properties fall out of that order:

- **No new oracle.** An unauthenticated probe dies at the byte-identical
  camouflage 404 before any TLS flight exists (VPN-R34), so the handshake
  never distinguishes a live tunnel from a refused one.
- **Handshake cost sits behind admission.** Only a peer that already passed
  one verify pays a handshake, which keeps d104's DoS surface exactly where
  it was.

The two layers keep distinct jobs: the proof answers "may this connection be
admitted, once"; the handshake answers "is this channel mine, for its life".
One key material serves both, held in one store — the handshake consumes the
certificate made from the store's key, and no second credential surface exists.

### Uniform wrapping

Every proxied byte rides the inner session — all three doors (HTTP
CONNECT, SOCKS5, the d103 forward) in both modes (C's POST, E's pipe) —
with no payload class and no passthrough. The earlier low-overhead shape,
which tunneled only plaintext through mTLS and passed already-encrypted
streams raw, dies on disambiguation: the relay cannot tell the two apart
reliably enough to stake protection on the answer, and the split's wrong
guess fails silently — the stream that was not safe after all simply
rides unprotected. What the split would save is one AEAD pass per record;
what it would cost is a second security posture. The failure modes are
recorded under Alternatives rejected; the compute price under
Consequences.

### One certificate per principal

Each node's store key is presented directly. The implementing change makes
`estige keygen` wrap the public half of the `prv/<principal>.der` Ed25519 key
(d132) in one self-signed certificate and store it as public material in the
pairing row. No CA
certificate and no ephemeral leaf exist; the same bytes are the trust anchor
in the peer's pool and the certificate sent in the handshake.

- **No CA fields.** The certificate is not marked `IsCA` and carries no
  `KeyUsageCertSign`. Go's verifier exempts trust anchors from the CA and
  key-usage checks it applies to intermediates, so a self-signed non-CA
  certificate in `RootCAs` or `ClientCAs` verifies itself. The fingerprint in
  the pairing row decides the outcome.
- **Validity is bounded, and the bounds carry the clock tolerance.**
  `NotBefore` is 24 hours before the host clock at mint and `NotAfter` at most
  15 years after it (What a verifiable certificate must carry states the
  provenance of both numbers). The backdate absorbs a day of drift; the
  forward bound sits far past any realistic skew.
- **Trust is pinning, not public chains.** Each side holds the peer's
  certificate in the role helper (d132's `relay.json` and `exit.json` rows).
  System roots never enter the inner path, and no second key is generated at
  boot.
- **Rotation is staged, not expired.** A principal switches keys through
  d133's staged double entries in the peer's trust pool. The name stays fixed
  while the key moves, so no peer configuration changes — d185 states why a
  name, not a certificate, is the unit a peer selects.

An earlier revision issued an ephemeral leaf under a CA root. The leaf bought
key separation on paper: a stolen leaf was one identity instance, not the
durable key. It did not move the boundary in practice — the process that mints
the leaf at boot already holds the durable key in memory — and it added a CA
lifecycle, a second key and roughly 150 lines. Dropping it is accepted here;
d211's front-door design starts from the same single-certificate shape.

### Verification and validity bounds

d104's no-clock law binds the **admission** path: the Ed25519 proofs read no
wall clock, because a drifted clock must never widen an admission decision.
The inner session is a different layer with a different failure mode — a
certificate that fails to verify tears down one channel, it never admits a
stranger — so this record runs the library's own verification, clock
included, instead of hand-rolling a verifier to keep the clock out.

An earlier revision of this draft resolved the collision the other way: it set
`InsecureSkipVerify` on both sides and made `VerifyPeerCertificate` the
verifier, keeping time under the record's control. That resolution is
rejected. `InsecureSkipVerify` with a forgotten or misordered callback
accepts any chain, and a hand-written verifier owes its own signature,
basic-constraint, extended-usage and name checks, each a chance to differ
from the library's. Standard verification fails closed at every one of those
points, and an auditor reads the library's code rather than this record's.

The trust wiring is the standard one:

- **Client** — `RootCAs` is a pool holding only the pinned peer certificate
  (system roots are never added), `ServerName` is the peer's principal name,
  and `Certificates` carries the local self-signed certificate.
- **Server** — `ClientCAs` is the same single-certificate pool and `ClientAuth`
  is `RequireAndVerifyClientCert`.
- **No callback and no skip** — `InsecureSkipVerify` does not appear and
  `VerifyPeerCertificate` is not set; chain, key usage, extended key usage
  and the `NotBefore`/`NotAfter` window are the library's checks against
  `time.Now()`.

Because the clock is in the channel path, the certificate bounds carry the
skew tolerance (One certificate per principal lists them): the 24-hour
`NotBefore` backdate absorbs a day of drift, and the multi-year `NotAfter`
is far beyond any realistic skew. A clock outside that window fails the
handshake closed in the existing teardown vocabulary — a channel outage,
never a widened admission.

### What a verifiable certificate must carry

The mandatory fields and their limits are findings from the pinned toolchain
(go1.27.4), not inference, because this design leans on the library refusing
what a hand-rolled verifier would have to enforce itself:

- **The validity window is mandatory.** RFC 5280 §4.1.2.5 makes `Validity` a
  two-`Time` SEQUENCE with no `OPTIONAL`, so a certificate that omits it
  does not parse. Go's `x509.CreateCertificate` accepts a zero
  `NotBefore`/`NotAfter` rather than refusing it — it encodes the zero time
  as year 1 (`00010101000000Z`) — which yields a certificate that parses and
  then fails every wall-clock verifier. The mint therefore sets both:
  `NotBefore` 24 hours before the host clock at mint, `NotAfter` at most 15
  years after it.
- **A name is mandatory, and the name is a SAN.** Under standard verification
  a client refuses an empty `ServerName` ("tls: either ServerName or
  InsecureSkipVerify must be specified in the tls.Config") and matches the
  name against the certificate's `subjectAltName`; a name living only in
  `commonName` is rejected ("x509: certificate relies on legacy Common Name
  field, use SANs instead"). No configuration keeps chain verification while
  dropping the name — that takes `InsecureSkipVerify` or a callback, both
  rejected above — so every certificate carries a SAN naming its own principal
  (the host key's `prv/<principal>.der` basename, docs/d132).
- **The trust pool holds certificates, not SPKIs.** `RootCAs`/`ClientCAs`
  take certificate entries, so the peer's public material in the pairing row
  is its self-signed certificate (One certificate per principal), not the bare
  SPKI the admission keys travel as.
- **The public CA limits do not bind.** A private pinned pairing is outside
  the subscriber regime, so the 398-day cap and its shorter successors do not
  apply. The 15-year bound follows Mozilla's websites-trust horizon; it exists
  so standard verification has a window to check, not as a rotation trigger.

Session resumption is disabled (`SessionTicketsDisabled`). Tickets add
cross-restart state for the price of one handshake, and in the manual shape
this record rejects, a resumed connection skips the verification callback;
standard verification removes that hazard, but the state still does not earn
its keep.

### Configuration laws

- **TLS 1.3 only** (`MinVersion: tls.VersionTLS13`) — no 1.2 negotiation, so
  no legacy CBC or MAC suite and no downgrade surface inside the inner
  session.
- **Each certificate carries both usages** (`ServerAuth` and `ClientAuth`) — each
  node acts as server for its own leg of life and as client for the other,
  and one symmetric usage list keeps the config one-spelling.
- **Verification is the library's, over a single-certificate pool** — system
  roots are absent, `InsecureSkipVerify` is absent, and the peer's certificate
  is the only anchor (`RootCAs` client-side, `ClientCAs` server-side).
- **No suite selection of our own** — AES-GCM versus ChaCha20-Poly1305 is
  the library's hardware decision; the record picks nothing.
- **Key exchange is inherited** — TLS 1.3 mandates ephemeral DH, so forward
  secrecy and the X25519 key schedule arrive without a design decision, and
  the pinned toolchain's client offers a post-quantum-hybrid key share by
  default.
- **Failure posture is one vocabulary** — a handshake error or a record
  error tears the session down in the existing shapes: camouflage 404 at
  admission, session death in relay. A "decrypt failed" signal with its own
  shape does not exist.

### Mixed pairings

The proof envelope does not change, so a v4 and a v5 node authenticate each
other at admission. The implementing change therefore carries the channel
requirement on the admission request: a v5 exit refuses an admission that
declares no channel, with the camouflage 404, while a v4 exit ignores the
marker, admits, and then treats the v5 handshake's bytes as a frame-layer
protocol violation — a teardown, never a downgrade. No direction of a
half-upgraded pairing continues unprotected. Since v4's implementation is
pending, the folded option also exists — land credential and channel as one
wire change, and the mixed state never occurs; sequencing them separately
buys two independent review surfaces for the cost of the teardown above.

## Implementation surface

Nothing in this design is cryptographic code. The new surface is:

| piece                                      | shape                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `net.Conn` adapter over `tunnelStream`     | Read, Write, Close and deadlines delegating to the frame-msg primitives          |
| certificate minting                        | one `x509.CreateCertificate` call and its extension fields                       |
| the TLS trust wiring                       | single-certificate `RootCAs`/`ClientCAs`, `ServerName`, `SessionTicketsDisabled` |
| placement in three modes + failure posture | handshake after admission, alert mapped to teardown                              |
| the refusal matrix                         | below — the bulk of the change                                                   |

The bug list is mint plumbing, not math: a certificate that omits the name the
peer dials, a validity window too tight for the skew the bounds promise, and a
trust pool holding the wrong public material. The test matrix that pins it:
happy path; wrong pin; tampered certificate; mixed key generations during a
staged rotation; an expired certificate and a not-yet-valid certificate, each
failing closed; and a peer clock pushed past the 24-hour backdate, likewise
failing closed.

## Consequences

**Gains**

- The carrier leaves the trust model. Confidentiality, integrity, anti-replay,
  ordering evidence and downgrade protection now live on the pipe rather than
  on the legs around it.
- Forward secrecy: session keys die with the session; the store key's theft
  decrypts nothing that was recorded.
- One credential surface: the store key is the certificate. No second key is
  generated at boot and no CA lifecycle exists.
- No fail-open wiring: standard verification carries the signature,
  constraint, usage and validity checks, so the forgotten-callback defect
  class does not exist here.
- The certificate message is encrypted under TLS 1.3, so the chain is
  invisible to the carrier and to the funnel terminator — strictly more
  private than the proof headers, which ride outer HTTP as log-safe labels
  by design.
- v4's crypto estate survives whole: Ed25519 identities, no clock in the
  admission path, no public CA, keys only in `prv/`, an empty `go.mod`,
  fail-closed refusals.

**Costs**

- One handshake round trip per session (d077 Study B's accounting), plus
  window round trips under mode E's stop-and-wait — the carrier's physics do
  not improve, and this record does not pretend otherwise.
- The TLS-in-TLS fingerprint Study B recorded: an active DPI can classify the
  inner ClientHello. That is the observable axis, orthogonal to this record's
  integrity axis, and Study B's reopen trigger (spike L5) stands unchanged.
- Double encryption for streams whose payload already runs TLS: one extra
  AEAD pass and roughly 21 bytes of record overhead per 16 KiB record —
  accepted deliberately, since the split that would avoid it was rejected
  on disambiguation, not on price.
- Roughly three to five hundred lines of new code and its tests — the TLS
  wiring, the minting and the placement — reviewed as plumbing, not as
  crypto.
- The channel depends on host clocks: drift past the 24-hour backdate, or a
  certificate whose `NotAfter` has passed, refuses the handshake until the clock or
  the certificate is corrected. Admission stays clock-free; a channel outage is the
  exposure the bounds accept.
- Sizes and timings remain visible; padding stays a separate, optional layer.

**Unchanged**

- The DoS surface: verify first, handshake second; unauthenticated floods
  still cost one verify, and rate limiting stays hygiene.
- End-to-end target validation (VPN-R29, VPN-R55): the inner session
  authenticates the two nodes and never the target; the client still sees the
  target's own certificate.
- The camouflage 404 and the one-authentication-one-connection-one-CONNECT
  bound: admission does not change, and the certificate is an identity for the
  carrier's life, not an admission ticket.

## Requirement deltas

- **VPN-R30 (no TLS termination by the proxy)** — the inner session is
  node-to-node channel protection inside an admitted tunnel; it terminates no
  tunneled exchange. The requirement's meaning — the nodes never enter the
  client's trust path to the target — holds unchanged.
- **VPN-R31 and VPN-R12 (the tunnel credential)** — unchanged; the proof
  envelopes remain the admission credential exactly as d104 amended them.
- **VPN-R34 (camouflage)** — preserved by ordering: no TLS flight exists
  before admission answers.
- **VPN-R32 (no secrets in env)** — satisfied structurally: the certificate
  is public material derived from `prv/`; no env spelling exists.
- **VPN-R28 (no trust anchor beyond the public one)** — binds the outer leg
  only. The inner leg's anchor is the peer's certificate from the store, which is
  this record's point; the two never meet, because system roots are not
  offered inner.

## Alternatives rejected

- **Noise or a Noise-inspired handshake** — doubles the trust surface: an
  external kit (`flynn/noise` is a framework, not a finished channel —
  pattern, prologue, framing and record layer remain ours to compose) plus
  this codebase's own protocol code, which is the exact combination this
  design avoids. The one thing Noise would buy — admission and channel in
  one flight — costs a redesign of d131's single-flight exchange, plus
  either a second key per principal or Ed25519-to-X25519 key conversion.
  Rejected for trust surface, not for performance.
- **DTLS over the mode E windows** — `pion/dtls` is mature but is the first
  dependency in a zero-dependency `go.mod`, and DTLS's loss and reorder
  machinery is redundant over a `tunnelStream` that already delivers
  ordered, exactly-once bytes. DTLS earns its place on a genuine datagram
  carrier (d073's UDP assessment) or once a design removes the stop-and-wait
  reliability shim; neither exists here.
- **mTLS at the front door (`FunnelTLSConfig`)** — rejected here, proposed as
  v6 in d211. Front-door handshake load, hostname-wide gating and the loss of
  the camouflage 404 remain costs; no CA lifecycle does, now that the leaf is
  gone. Inner placement is what keeps admission and channel separate in v5.
- **An ephemeral leaf under a CA root** — the earlier shape of this draft.
  It bought key separation on paper but not at the boundary: the process that
  minted the leaf at boot already held the durable key. It cost a CA
  lifecycle, a second key and roughly 150 lines. Removed from this design;
  One certificate per principal records the accepted trade.
- **An intermediate certificate** — delegation does not exist in a two-party
  pairing; the extra signature would be machinery with no decision behind it.
- **RSA or any non-elliptic certificate** — forced only by a FIPS module
  predating Ed25519 approval or by a peer that cannot speak Ed25519; both
  ends are this binary, so either would be a downgrade rather than a
  requirement. ECDSA P-256 is the bridge if a FIPS-locked host ever joins the
  pairing, and it too is elliptic.
- **Dropping the proof layer once the handshake authenticates** — the
  handshake cannot serve admission: an unauthenticated probe must receive the
  byte-identical 404, and a TLS flight in the answer would be a
  distinguishable response (VPN-R34). The proofs stay; the handshake is the
  second layer, not the replacement.
- **Manual verification under `InsecureSkipVerify`** — the earlier
  revision's shape, rejected under Verification and validity bounds: it keeps
  the clock out of the channel at the cost of hand-writing the chain,
  constraint, usage and name checks, and it opens the fail-open hole a
  forgotten callback leaves. Standard verification over a bounded validity
  window is the smaller surface.
- **Wall-clock expiry as a rotation trigger** — rejected: staged rotation is
  the mechanism, and the validity window exists only so standard verification
  has one to check. Letting expiry drive rotation would reintroduce the clock
  d104 removed from the admission path for a job staged rotation already
  does.
- **The low-overhead split: tunnel only plaintext, pass already-encrypted
  streams raw** — the classification it needs fails three ways. A
  first-bytes heuristic guesses, and the wrong guess is silent: a
  STARTTLS-shaped start or a preamble-then-TLS stream loses protection
  with no alarm, while the conservative mistake only costs the overhead
  the split exists to save. A declared class cannot live inside the inner
  session — that is circular — so it rides unprotected post-admission
  metadata the carrier forges (the v4 gap) or the client's word, which
  moves the disambiguation out of the relay without solving it. On a
  degraded leg (d171) the sniffed input is the carrier's own bytes, so
  the adversary shapes the class decision itself. d171's gate records the
  general limit: first-bytes classification is an accident-guard, not a
  boundary, and a protection decision needs a boundary.

## Implementation order

1. **Store certificate** — `estige keygen` mints the host identity at
   `~/.local/share/estige/prv/<principal>.der` (PKCS#8 Ed25519, the
   principal its file name), prints its `{name, public}` config entry and
   issues the self-signed certificate that carries that public half.
   `estige public` re-derives the entry from an existing key, and
   `estige key check` validates the certificate like every other row.
2. **Adapter and TLS config** — `net.Conn` over `tunnelStream` and the
   standard `tls.Config` wiring: the single-certificate `RootCAs`/`ClientCAs`
   pools, `ServerName`, `RequireAndVerifyClientCert`, and
   `SessionTicketsDisabled`.
3. **Placement** — handshake after admission in modes C, D and E, with the
   failure posture mapped to teardown and the camouflage vocabulary.
4. **Refusal matrix** — the tests above, plus end-to-end cases mirroring
   `vpn_e2e_test.go`: a tampered carrier must fail the session, never the
   policy layer.

Step one is inert — invisible to a binary that does not read them — so it can
land and be rolled back before any wire changes; the handshake
placement is the cut-over, and mixed pairings fail closed as the Mixed
pairings section states.
