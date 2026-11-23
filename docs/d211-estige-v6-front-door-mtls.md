---
id: d211
type: module-design
status: draft
title: "d211 — estige v6: front-door mTLS — one TLS 1.3 session from the start"
parent: estige
depends-on: [d073, d085, d104, d108, d131, d132, d169, d185]
references: [d077, d090, d133, d136, d171, d188, d236]
tags: ["estige", "tls", "mtls", "funnel", "identity", "generation-v6"]
---

# d211 — estige v6: front-door mTLS

This record proposes **deployment generation v6**: one mutually authenticated
TLS 1.3 session terminated by estige at the Funnel front door, replacing both
v4's HTTP admission proofs and v5's inner channel. It covers the credential and
the channel as one decision. Its reader is the operator or auditor who has to
decide whether hiding the tunnel's existence is still worth two layers; the
finding is that route hiding buys no cryptographic security, and dropping it
buys a single standard handshake with no custom proof machinery.

## Status

Draft — a proposal, not in force. v4's proofs and v5's inner session stay the
designs on record for a deployment that keeps the camouflage 404; v6 is the
alternative cut-over for one that does not. Nothing here implements code, and
no deployment claims this generation yet. d236 gives v5 the neutral `estige`
wire name, so that choice is no longer unique to this proposal.

## Generation numbering

d108 owns the tree-wide table; this record claims its sixth row. v5's own table
(d169) lists v6 as proposed here. The numbering names deployment shapes, not
envelope versions: the `v2` token inside d131's proof envelope stays put and
disappears with the proofs rather than being renumbered.

## Problem

The generations split one job in two. v4 replaces the v3 bearer with
single-use Ed25519 proofs, so the TLS terminator never holds a reusable
credential — but it adds envelopes, direction bindings, two replay rings and a
declared replay residual: a proof whose genuine flight is blocked can be
replayed once. v5 keeps all of that and adds a second TLS session inside the
byte pipe, so the payload has confidentiality, integrity and replay
protection at the price of double AEAD, an inner ClientHello that DPI can
classify, and a `net.Conn` adapter over the frame primitives.

Both costs trace to camouflage. VPN-R34 requires an unauthenticated request to
answer byte-for-byte like a missing route, which forbids a challenge round
trip and any TLS flight before admission. d085 already retired the independent
path capability; the Funnel mount is a fixed, reachable path, so hiding route
existence is low-observable polish rather than a security boundary. The
uniform refusal vocabulary still has value as a discipline — fail closed, no
soft fallback — but the byte-identical 404 is not what supplies it.

## Decision

**v6 terminates TLS 1.3 mTLS in estige at the Funnel front door.** Tailscale
forwards the tunnel leg at L4 through `FunnelTLSConfig`; estige presents its
pinned store-key certificate, requires a client certificate, and verifies it
against the peer certificate held in the role store. The handshake
authenticates both nodes, negotiates ephemeral keys and records the whole
conversation, and every proxied byte rides that one session across the Funnel
mount.

No HTTP admission layer survives in the tunnel namespace: no proof envelopes,
nonces, replay caches or 404-shaped credential refusals. No inner channel
survives either: there is no byte pipe to wrap, so the adapter, the second
handshake and the double AEAD pass disappear with them.

### Requirement deltas

- **VPN-R30 (no TLS termination by the proxy)** — amended. The node terminates
  the tunnel leg only. Target TLS remains end to end (VPN-R29, VPN-R55): the
  client still validates the upstream's real certificate, and the node never
  enters that trust path.
- **VPN-R34 (camouflage)** — retired for the tunnel namespace. A failed
  handshake is the refusal, and an unauthenticated probe receives a TLS
  failure rather than a plain 404. The fail-closed rule stays: no retry, no
  weaker cipher, no fallback to bearer or proofs on the same hostname.
- **VPN-R28 (public trust anchor)** — amended for the tunnel leg. The client
  verifies the pinned store-key certificate instead of the Funnel's public
  certificate. No CA is installed anywhere, and system roots are absent from
  both pools.
- **VPN-R31 and VPN-R12** — the bearer and its header spelling retire with the
  HTTP layer. The store key is the credential, in the sense d104 gave the term
  to v4.
- **VPN-R32** — unchanged. Key material lives in `prv/` and public material in
  the role helpers; env carries no secret.

### Wire name and identity

The certificate SAN and the client's SNI carry one neutral constant,
`estige`. A middlebox reads the SNI on the public leg and any active client
can read the server certificate after the handshake starts, so neither field
is a place for a human principal name. d185's finding still holds — the peer
selects a stable name, never a certificate — but the name is opaque.

Identity lives in the pinned public key. Each principal's self-signed
certificate (d169's One certificate per principal, with no minted leaf and no
CA) is both the trust anchor in the peer's pool and the certificate presented
in the handshake. Its subject is derived from the public key rather than the
principal label, so an exit holding several admitted peers selects one root by
subject and key id instead of trying every entry. The pairing row's
fingerprint is compared out of band at provisioning time, as d133 records.

### Verification and rotation

- TLS 1.3 only, `MinVersion: tls.VersionTLS13`; no 1.2 negotiation.
- Client: `RootCAs` holds the exit's pinned certificate, `ServerName` is the
  neutral constant, `Certificates` carries the relay's certificate.
- Server: `ClientCAs` holds the admitted peers' pinned certificates and
  `ClientAuth` is `RequireAndVerifyClientCert`.
- No `InsecureSkipVerify`, no `VerifyPeerCertificate` or `VerifyConnection`
  callback. Chain, usage, name and validity checks are the library's own.
- No session tickets (`SessionTicketsDisabled`); a new connection pays one
  handshake, and identity changes take effect on the next connection.
- Validity bounds follow d169: `NotBefore` 24 hours before mint, `NotAfter` at
  most 15 years after it. The clock is in the channel path, so drift past the
  backdate is an outage, never a widened admission.
- Rotation uses d133's staged double entries. The neutral name and the
  principal label are both stable while the key and its derived subject move.

### Failure posture

An untrusted or unknown peer fails the handshake before any tunnel bytes
exist. The failure has one shape on both sides: connection teardown, never a
downgrade, never a second attempt with weaker verification. A v6 node refuses
a v4 or v5 peer in both directions; mixed generations fail closed.

## Consequences

**Gains**

- One vetted protocol owns authentication, freshness, key agreement and the
  record layer. The pre-computed-proof replay residual disappears with the
  replay rings.
- The Funnel terminator and every other on-path process see only ciphertext
  after the handshake: no reusable credential and no proof labels.
- No double AEAD, no inner ClientHello fingerprint, no frame adapter, no CA
  hierarchy and no minted leaf.
- The code delta is TLS wiring and topology, not cryptography.

**Costs**

- Embedding tsnet moves TLS termination into estige and adds its dependency
  surface to a zero-dependency binary, including the build and cross-compile
  consequences on Termux and in the scratch image.
- The front door now answers TLS handshakes for unauthenticated probes. A
  flood costs a handshake and the server's certificate verify; rate limiting
  stays hygiene, not a security control.
- One `tls.Config` gates the whole hostname. A namespace that needs a
  different client policy needs a second hostname.
- Route hiding is gone. The Funnel mount is probeable, and the SNI and packet
  sizes stay visible on the public leg.

**Unchanged**

- End-to-end target validation and the egress policy (VPN-R29, VPN-R55,
  VPN-R35–R38) sit above the channel and do not move.
- Store layout, arming by helper presence, staged rotation and the no-secrets-
  in-env rule are d132/d133's.
- Traffic-analysis resistance is not claimed. Padding stays a separate layer.

## Alternatives rejected

- **Keep v5's inner channel** — the right shape while camouflage binds. It
  keeps admissibility separate from channel life, but it also keeps the proof
  machinery and the TLS-in-TLS fingerprint. Chosen only where route hiding
  matters.
- **External-PSK TLS 1.3** — the natural fit for a v3 shared secret, but Go's
  `crypto/tls` exposes PSKs only as resumption state, not as an external-PSK
  API. Reusing resumption serialization would pin the design to an encoding
  documented as opaque and version-unstable.
- **Encrypted Client Hello** — Go supports it, but d185's four costs remain: a
  second key pair, a hand-built config, a hand-written rejection verifier and a
  draft-fragile encoding. A neutral SNI removes the disclosure without any of
  them.
- **Kerberos** — an online KDC, clock sync and a third party able to
  impersonate every principal. It solves centralized identity, not this
  two-node pairing.
- **A challenge round trip at the HTTP layer** — better freshness than
  pre-computed proofs, but it still needs a custom protocol and a plaintext
  HTTP layer. The front-door handshake supplies the same freshness as part of
  TLS.

## Implementation order

1. **Topology** — embed tsnet, publish the tunnel mount with
   `FunnelTLSConfig` and confirm the L4 forward reaches the estige listener.
2. **Store certificate** — generate and validate the self-signed store-key
   certificate as in d169's first step; no new key and no new env name.
3. **Trust wiring** — the two single-certificate pools, the neutral
   `ServerName`, TLS 1.3 only and disabled tickets.
4. **Placement** — remove the admission layer and carry every door and mode on
   one TLS session.
5. **Refusal matrix** — the tests below, then the cut-over: v4/v5 and v6
   cannot share a hostname, so the change is a swap, not a staged overlap.

## Verification

- pinned peer verifies; an untrusted, substituted or tampered certificate
  fails the handshake on both sides;
- an expired or not-yet-valid certificate fails closed, and a peer clock past
  the 24-hour backdate fails closed;
- the neutral name is what both sides send and verify; no principal label
  appears in SNI, SAN or acceptable-CA subjects;
- a staged rotation admits both old and new keys and refuses a third;
- a v4 or v5 peer is refused in both directions, with no downgrade path;
- target-certificate validation and the egress policy still reject their own
  failures, not the channel's.
