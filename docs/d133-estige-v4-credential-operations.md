---
id: d133
type: module-design
status: draft
title: "d133 — the v4 credential in operation: arming, naming, failure posture and rotation"
parent: estige
depends-on: [d104, d132]
references: [d073, d077, d084, d085]
tags: ["serving", "proxy", "vpn", "auth", "operations", "rotation", "mechanics"]
---

# d133 — v4 credential mechanics: operating it

**Mechanics companion to [d104](d104-mutual-exit-relay-credential.md)**, covering
what an operator and a caller observe around the credential rather than the
credential itself: how the tunnel arms once helper presence replaces the env
key, which names appear where, what a failure looks like on the wire, and how a
rotation lands without an outage.

Prerequisites: [d131](d131-estige-v4-proof-mechanics.md) (what a proof is) and
[d132](d132-estige-v4-key-store.md) (where the material lives).

## Naming — deployment roles, protocol layer included

The exit/relay vocabulary (d088) extends into the wire and the store:
credential headers, signed-message labels, principal names, store paths
(`prv/relay`, `prv/exit`, `relay.json`, `exit.json`), and
log fields speak exit/relay, never client/server. Two senses are exempt
because they are not this repo's to rename: RFC 6455's WebSocket mask
polarity (the RFC's word for who masks) and `relay.go`'s role-neutral
"peer". d088 is amended accordingly; the code-field rename belongs to the
implementing change.

## Failure posture — unchanged camouflage

Wrong, missing, malformed, or replayed proof (a nonce the exit has
already consumed) — and now also an **unknown key
name** in either envelope, a direction-swapped proof (a relay signature
presented as an exit's), a name whose signature does not verify under
the embedded key, or an exit proof that does not bind the relay
connection's own `nonce_r` — all answer the allowlist relay's byte-identical
camouflage 404 (VPN-R34): no 401, no challenge, no distinct body, no
proof, key, or name bytes in logs or error bodies beyond the success-path
attribution (VPN-R33). Store-side ambiguity never reaches a response: it
refuses at load. The success signal (a `101`) is unavoidably
distinguishable from failure; nothing else is.

## Arming — the d084/d085 contract, via helper presence

The tri-state arm moves from env presence to helper presence, keeping the
contract: **the role's helper file is the intent signal.** No
`relay.json` → the relay tunnel surface does not exist (byte-identical
unarmed behavior); `relay.json` present → the surface is intended and
the chain step must validate the whole role store (`prv/relay/` exactly
one key, JSON decodes strictly, `endpoint` and `exit` well-formed) or
refuse loudly before any bind — never silently unarmed, never
armed-but-broken. The exit side is symmetric on `exit.json` +
`prv/exit/`. `estige.json`'s `-config` file and `tunnel.enabled`
tri-state dissolve into this rule — with mode A gone (d108's
tree-shake) the store is the whole config surface, no other config
artifact remains. The chain step's gate becomes `estige key check` (d095's rework; its pinned
test `tests/check-vpn-relay-chain.sh` is updated by the implementing
change — that shell test is gone since docs/d120, replaced by the Go suite). The scheme stays namespace-scoped to the tunnel (VPN-R2's
separation): the allowlist relay is untouched, and the gateway namespace
(d091, now deprecated) keeps its staged bearer — out of scope here and
no longer planned anywhere: extending proofs there would be a separate
decision.

## Rotation — staged, zero-gap (considered; CLI deferred)

Rotation is the operation the store exists to make easy; the design below
is **recorded as considerations for the implementing change, not as
requirements of this record** — per instruction, nothing here is
implemented yet.

- **The format reserves the room for zero-gap rotation**: an admitted set
  may carry **up to two entries for the same principal** during a
  transition (both verify — a staged key is a valid key); a third is
  refused at load, never silently "pick one". The cap is part of the
  grammar now so adding it later cannot break parsing.
- **The safe order has peers accept before the principal switches**:
  (1) the principal generates a new keypair and exports fingerprint +
  PEM; (2) each peer imports the new key _alongside_ the old — both
  verify, no gap; (3) the principal rotates — the old private key is
  destroyed (rotate, not moved); (4) peers prune the stale entry. There
  is no moment where a valid key is rejected.
- **Skipping the staging is disruptive, not insecure** — the old key is
  gone, peers still hold it, handshakes fail closed (camouflage 404)
  until each peer imports the new one. Mode D sessions already
  connected are unaffected (auth is at handshake); modes C/E
  authenticate per request (d077), so their gap is request-level
  failures until peers update. The record's preference ordering
  sanctions the outage; it never sanctions accepting the wrong key to
  avoid one.
- **The CLI is design intent**: `estige key <verb>`, sharing the
  runtime's parser — `keygen`, `list`, `fingerprint`,
  `export-pub`, `import-pub`, `rotate [--commit]`, `revoke`,
  `check`. The CD/CRUD split follows the material class: **private
  keys get Create and Delete only** (no import, no export, no move —
  generation happens on the host that will hold the key, so the private
  half never travels); **public entries get full CRUD** (import from
  PEM/DER/ssh-line, list, replace, revoke). The only movement verb in
  the system is `export-pub`, and it moves public material.
- **Provisioning authenticity**: fingerprints are compared over a
  second channel when a principal is first admitted (`keygen` prints
  one; `key fingerprint` re-prints it). The helpers are
  integrity-critical trust config — substitution of an embedded public
  key is the residual attack of the whole design, and out-of-band
  fingerprint comparison is its answer, exactly as for ssh host keys.
