---
id: d185
type: module-design
status: done
title: "d185 — naming the identity: SNI, name-based certificate selection and the ECH question"
parent: estige
depends-on: [d132, d169]
references: [d073, d104, d133, d171, d236]
tags: ["estige", "tls", "sni", "ech", "identity", "rotation"]
---

# d185 — naming the identity: SNI, name-based certificate selection and the ECH question

This record answers one question for the v5 host identity: can a peer negotiate
which certificate or name it connects to, so a key can be replaced more easily?
It covers the TLS selection mechanisms, what a hostile carrier sees, and the
Encrypted Client Hello option. It implements nothing — the key tooling is d169
and the store is d132 — and its reader is the implementer of the inner mTLS and
the operator rotating a host key. The finding: a peer selects a **name**, never
a certificate, so rotation keeps one stable principal name and moves only the
key; ECH stays out of the design.

## Status

Investigation finished. The key tooling (`estige keygen`,
`estige public`) implements the stable-name half; ECH is deferred, and
nothing in the tree waits on it. d236 pulls the neutral `estige` wire name into
v5, so the stable-principal SAN finding below no longer names the v5 channel.

## The question

A crude rotation story names each key generation — `tlalocayotl1`,
`tlalocayotl2` — and has the client ask for the generation it wants.
The question is whether TLS offers that, so a key can be replaced without
touching the peer's configuration.

## What TLS negotiates

TLS carries two name-based hints and no certificate-level one.

### The client's request is SNI

The client's `tls.Config.ServerName` becomes the SNI extension (RFC 6066) and the name it verifies. The server receives it as
`ClientHelloInfo.ServerName` and can select a certificate per name
through `GetConfigForClient` or `GetCertificate`. A server
that presents a certificate for another name fails the client's verification.
The hint selects a name; it does not authenticate, and the server may ignore
it.

### The server's request is an acceptable-CA list

A server with `ClientAuth` and `ClientCAs` sends those CA
subjects in `CertificateRequest.certificate_authorities`. The client
receives them as `CertificateRequestInfo.AcceptableCAs`, and
`GetClientCertificate` (or the default selection) chooses which of its
own certificates to present. The hint is keyed on issuer identity, not on a
fingerprint, and it stays a hint: the server's own verification against
`ClientCAs` decides.

### What TLS does not offer

No field carries a certificate fingerprint, serial or arbitrary key id, so a
client cannot demand a specific certificate. TLS 1.3 removed renegotiation, and
Go treats a post-handshake `CertificateRequest` as an unexpected
message, so an identity change takes effect only on a new connection. Sessions
are per connection here anyway (d169 disables tickets).

## SNI is a cleartext ClientHello extension

SNI travels inside the TLS handshake, not at the TCP layer, so it is
transport-agnostic: it crosses a `tunnelStream` adapter exactly as it
crosses a socket. It is also unencrypted, because the ClientHello precedes the
key exchange, and a middlebox reads it by peeking at the ClientHello bytes.

For the v5 inner session this means the carrier reads the inner SNI — the peer's
principal name — even though it cannot decrypt the records that follow. That is
the inner-ClientHello visibility d169 already records as the TLS-in-TLS
fingerprint.

## Rotation makes the name the stable unit

The name and the key are separate facts, and rotation is cheapest when only the
key moves.

- **A stable principal** keeps the SAN, the peer's `ServerName` and the
  store row name unchanged. Rotation changes the key and the root, and the peer
  adopts the new root through d133's staged double entries. No peer
  configuration changes, and the carrier learns nothing new.
- **Per-generation names** are expressible through SNI, but they buy nothing:
  the peer must already trust the new root to accept the new certificate, so the
  trust distribution happens either way. A generation name also leaks which key
  the node uses, over a channel the carrier can read.

A principal is a valid SAN and `ServerName` without a dot, matched
case-insensitively. The check that established it (go1.27.4) put
`tlalocayotl`, `relay_bazzite` and `exit-home`
through the handshake as both SAN and `ServerName`, and all three
verified.

## The ECH option

Encrypted Client Hello hides the inner ClientHello, including SNI, from the
carrier. Go supports it natively in `crypto/tls`: the client sets
`EncryptedClientHelloConfigList`, the server sets
`EncryptedClientHelloKeys` (or
`GetEncryptedClientHelloKeys`), and the client verifies a rejection
through `EncryptedClientHelloRejectionVerify`. It requires TLS 1.3,
which the inner session already mandates, and it fails closed when the server
rejects it.

Four costs keep it out of the v5 design.

- **It is another key pair to distribute.** The server holds an HPKE private key
  beside the ECH config, and clients hold the `ECHConfigList`, which
  carries the public key, the cipher-suite ids, the config id and the outer
  `public_name`. The two configs must match byte-for-byte, and the
  list needs its own distribution step, like the pinned root.
- **Go does not generate the config.** The parser is unexported, so the config
  bytes and the HPKE key are the operator's or an external tool's job; only
  `crypto/hpke` is stdlib.
- **The rejection path is a new trust decision.** Go performs no normal
  certificate verification before `EncryptedClientHelloRejectionVerify`,
  so that callback is hand-written verification again — the shape d169 removed.
- **The encoding is draft-fragile.** Go's own contract warns that the parsing
  may change with the final ECH specification.

ECH also hides less than it appears: the outer ClientHello still carries the
`public_name`, the IP, and the packet sizes and timings.

## Findings

- The client selects a name, never a certificate; the server selects the
  certificate for that name.
- The server can ask for a client identity only by issuer, through the
  acceptable-CA list.
- Rotation is a key-and-root change under a stable principal name, and needs no
  negotiation at all.
- ECH is available and would hide the principal from the carrier's
  inner-ClientHello read, at the cost of a second key pair, a hand-built config,
  a verification callback and a draft-fragile encoding.

## What follows

Adopt the stable principal. The host key tooling already names the private file
for it (`prv/<principal>.der`, d132) and derives the SAN from the same
string (d169). v6 (d211) keeps the name as the stable unit but fills it with a
neutral constant: the wire name carries no principal information, and the
pinned key carries the identity. The selection mechanics in this record are
unchanged. Revisit ECH only if hiding the principal name from the carrier
becomes a requirement, and record that adoption as its own decision then.
