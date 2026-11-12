---
id: d169
type: module-design
status: draft
title: "d169 — estige v5: inner mTLS over the tunnel — channel security for an untrusted carrier"
parent: estige
depends-on: [d077, d104, d108, d131, d132]
references: [d073, d081, d085, d090, d103, d133, d136, d171]
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
standard library, the new code is `crypto/x509` plumbing plus a `net.Conn`
adapter, and exactly one line of that wiring can fail open; the record names
it and its test pins it.

## Status

Draft — a proposal, not in force and not accepted; nothing in the tree has to
obey it yet, and d104/d131/d132/d133 remain the credential design on record.
The implementation would land as a separately sequenced change, the way
d104's own implementation order sequences its steps.

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
non-TLS channel layer ever appears.

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
root that the store's key already is, and no second credential surface
exists.

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

### Certificate hierarchy

Each node's store key becomes that machine's **root**, and every process mints
an **ephemeral leaf** under it:

- **Root.** The `prv/` Ed25519 key (d132) issues a self-signed CA certificate
  — `IsCA`, `KeyUsageCertSign` — minted once at keygen and stored beside the
  key as public material, or re-derived at boot. Either way the private key
  never leaves `prv/`.
- **Leaf.** At boot the process generates a fresh Ed25519 key and a leaf
  certificate under its own root, in memory only: never written, never env,
  never shipped (VPN-R32 holds structurally — the certificate is derived, not
  transported).
- **Trust is pinning, not public chains.** Each side holds the peer's root as
  public material in the store pairing (d132's `relay.json` and `exit.json`
  rows) and validates the peer's leaf against it. System roots never enter
  the inner path.
- **No intermediate.** A two-party pairing has no delegation to model; a third
  certificate would add a signature with no decision behind it.
- **Rotation is staged, not expired.** Root rotation is d133's staged double
  entries in the peer's trust pool; leaves minted under whichever roots are
  staged follow without their own staging.

The hierarchy buys what a direct store-key leaf cannot: the root signs leaves
and never enters a handshake, so a leaf stolen from a process dump is one
identity instance rather than the durable identity, and root rotation becomes
a pool entry instead of a fleet event.

### Verification and the no-clock law

d104's law — no clock in the auth path; drift causes an outage, never a
widened decision — collides with `x509`'s default verification, which checks
`NotBefore` and `NotAfter` against wall time. This record settles the
collision: **expiry does no job that staged rotation does not already do
here, so the inner verification reads no wall clock.**

Mechanically, that forces the manual-verification shape: the client sets
`InsecureSkipVerify`, the server requires a client certificate without
chain-verifying it, and `VerifyPeerCertificate` becomes the verifier on both
sides — Go's own contract says that with those settings the callback "will be
considered", with `verifiedChains` nil. The callback parses the presented
leaf, checks its signature against the pinned root with `CheckSignatureFrom`,
checks basic constraints and extended usages, and compares the pinned SPKI —
all with time under the record's control, never `time.Now()`.

This is the one wiring in the design that can fail open: `InsecureSkipVerify`
with a forgotten callback accepts anything. The callback therefore lands with
a sentinel test in the same change — a chain under no root, a chain under a
wrong root, and a tampered leaf must each abort the handshake.

Session resumption is disabled (`SessionTicketsDisabled`). Go's contract says
the verification callback "is not invoked on resumed connections", so
resumption would silently bypass the verifier; it would also add
cross-restart ticket state for the price of one handshake. No resumption
means neither.

### Configuration laws

- **TLS 1.3 only** (`MinVersion: tls.VersionTLS13`) — no 1.2 negotiation, so
  no legacy CBC or MAC suite and no downgrade surface inside the inner
  session.
- **Both leaves carry both usages** (`ServerAuth` and `ClientAuth`) — each
  node acts as server for its own leg of life and as client for the other,
  and one symmetric usage list keeps the config one-spelling.
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

| piece                                      | shape                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `net.Conn` adapter over `tunnelStream`     | Read, Write, Close and deadlines delegating to the frame-msg primitives |
| root and leaf minting                      | two `x509.CreateCertificate` calls and their extension fields           |
| the verification callback                  | signature check, extension checks, SPKI pin                             |
| placement in three modes + failure posture | handshake after admission, alert mapped to teardown                     |
| the refusal matrix                         | below — the bulk of the change                                          |

The bug list is the classic CA-plumbing list, not math: wrong `IsCA` and
`KeyUsage` combinations (Go's verifier fails those closed), the forgotten
callback (the one fail-open line), and wall clock creeping into verification
(the law above). The test matrix that pins it: happy path; wrong root;
tampered chain; a leaf presenting itself as a CA; mixed root generations
during a staged rotation; a host clock at epoch, which verification must not
notice; and the fail-open sentinel.

Per-boot leaves ship first: one mint per process, root loadable only at boot,
and TLS 1.3's ephemeral key exchange already gives the session its forward
secrecy. A per-session leaf would buy only identity-layer blast radius and can
be adopted later without redesign.

## Consequences

**Gains**

- The carrier leaves the trust model. Confidentiality, integrity, anti-replay,
  ordering evidence and downgrade protection now live on the pipe rather than
  on the legs around it.
- Forward secrecy: session keys die with the session; the store key's theft
  decrypts nothing that was recorded.
- Key separation: the durable root never enters a handshake, and leaves are
  disposable by construction.
- The certificate message is encrypted under TLS 1.3, so the chain is
  invisible to the carrier and to the funnel terminator — strictly more
  private than the proof headers, which ride outer HTTP as log-safe labels
  by design.
- v4's crypto estate survives whole: Ed25519 identities, no clock, no public
  CA, keys only in `prv/`, an empty `go.mod`, fail-closed refusals.

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
- Roughly four to six hundred lines of new code and its tests, concentrated
  in the verification callback — reviewed as plumbing, not as crypto.
- Sizes and timings remain visible; padding stays a separate, optional layer.

**Unchanged**

- The DoS surface: verify first, handshake second; unauthenticated floods
  still cost one verify, and rate limiting stays hygiene.
- End-to-end target validation (VPN-R29, VPN-R55): the inner session
  authenticates the two nodes and never the target; the client still sees the
  target's own certificate.
- The camouflage 404 and the one-authentication-one-connection-one-CONNECT
  bound: admission does not change, and the leaf is an identity for the
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
- **VPN-R32 (no secrets in env)** — satisfied structurally: the leaf is
  minted in memory from `prv/`; no certificate file and no env spelling
  exist.
- **VPN-R28 (no trust anchor beyond the public one)** — binds the outer leg
  only. The inner leg's anchor is the peer's root from the store, which is
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
- **mTLS at the front door (`FunnelTLSConfig`)** — d104's rejection stands
  unchanged: front-door handshake load, hostname-wide gating, a
  handshake-layer oracle against the camouflage posture, and a CA lifecycle
  for no additional trust. Inner placement is what makes certificates
  affordable at all.
- **The store key used directly as the leaf** — roughly 150 fewer lines, but
  no key separation: a leaf stolen from a session would be the durable
  identity, and identity rotation would touch every live handshake.
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
- **Wall-clock expiry as a rotation trigger** — reintroduces the clock d104
  removed from the auth path for a job staged rotation already does. A
  decorative expiry check would claim to protect what only rotation
  protects.
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

1. **Store roots** — root minting in the `estige key` CLI (d132's verbs),
   the root certificate stored as public material in the role helper, and
   `estige key check` validating its shape like every other row.
2. **Leaf minting** — boot-time in-memory key and certificate; no new file,
   no new env name.
3. **Adapter and callback** — `net.Conn` over `tunnelStream`,
   `tls.Config` wiring with `SessionTicketsDisabled`, and the sentinel test
   in the same change as the callback.
4. **Placement** — handshake after admission in modes C, D and E, with the
   failure posture mapped to teardown and the camouflage vocabulary.
5. **Refusal matrix** — the tests above, plus end-to-end cases mirroring
   `vpn_e2e_test.go`: a tampered carrier must fail the session, never the
   policy layer.

Steps one and two are inert — invisible to a binary that does not read them —
so they can land and be rolled back before any wire changes; the handshake
placement is the cut-over, and mixed pairings fail closed as the Mixed
pairings section states.
