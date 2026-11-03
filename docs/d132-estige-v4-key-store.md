---
id: d132
type: module-design
status: draft
title: "d132 — the v4 credential's key store: role-scoped directories, helper files and the CLI"
parent: estige
depends-on: [d104, d131]
references: [d073, d078, d090]
tags: ["serving", "proxy", "vpn", "auth", "secrets", "key-store", "mechanics"]
---

# d132 — v4 credential mechanics: the key store

**Mechanics companion to [d104](d104-mutual-exit-relay-credential.md)**, and the
second half of [d131](d131-estige-v4-proof-mechanics.md)'s mechanism: d131 says
what a proof looks like and how it verifies; this record says where the key
material lives, what shape the pairing files take, and how an operator creates,
checks and rotates them.

d104 owns the decision (including the store's existence, its secret-surface
guarantee and the rotation-without-outage intent). This file is the detail you
need to implement or audit the store itself.

## Key store — role-scoped directories and two helper files

```
~/.local/share/estige/              0700   (XDG_DATA_HOME/estige honored)
├── relay.json          relay role: dial-out pairing — endpoint + expected exit key
├── exit.json           exit role: admitted relays — principals + public keys
└── prv/                          0700
    ├── relay/${principal}.der    0600   this host's relay identity (exactly one)
    └── exit/${principal}.der     0600   this host's exit identity (exactly one)
```

- **Directories are named singular — they are system namespaces, not user
  collections.** `prv/relay`, `prv/exit` stay singular even where the
  analogous lists hold many keys (the likely case): the singular marks a
  system-owned folder; plural would suggest a browsable collection. The
  role half of every path is the deployment role (d088), so a path reads
  as a fact: "the relay identities on this host".
- **Identity is answered by the directory, not by a config field.** Each
  active role's `prv/<role>/` must contain **exactly one** key file; its
  basename is the principal name — on the wire, in the signed-message
  inputs, and in peers' admitted lists: one identity spelling, from disk
  to wire. Zero or two-plus files refuse loudly. A dual-role host
  (d090's shared-env case) simply has one file in each role directory,
  and each role process reads its own. A `VPN_PRINCIPAL`-style selector
  is rejected as a second spelling of the same fact.
- **Private keys: PKCS#8 Ed25519, DER only.** PEM-format private keys are
  refused with the intent in the message ("private keys are DER-only;
  rotate, don't move"). The friction is deliberate: no `cat` into
  scrollback, no casual text export, no implied migration path — an
  honest speedbump against human error, **not a boundary** (anything that
  can read the file can copy the bytes); the boundaries are the
  permissions below. The DER parse enforces algorithm and size — a
  32-byte seed, fail-closed (d071's law; d078's floor carried: an
  identity key's compromise is total impersonation for that principal).
- **Public keys live as normalized entries inside the helpers, never as
  their own files.** Import accepts PEM, DER, and ssh-pubkey lines (all
  three are encodings of the same SPKI — convenience, not ceremony);
  storage normalizes to one line; `export-pub` prints PEM for
  interchange; fingerprints are `SHA256:<base64url of SHA-256(raw
  32-byte pubkey)>` — encoding-independent, so the same key has one
  fingerprint however it was imported, and it can be compared over a
  second channel at provisioning (public-key substitution is the
  residual attack; see rotation).
- **Permissions are enforced at load, SSH-style.** The store directory
  must be 0700; a world- or group-readable `prv/*.der` is **refused,
  not warned**; the helpers live under the 0700 boundary (their material
  is public, but they are trust config — integrity matters, secrecy does
  not). Backups must exclude the store (an ops note this record carries
  deliberately: the same note ssh carries).
- **One loader, one grammar, two consumers.** `estige key check` and
  the runtime's boot load share the parser the CLI uses — validation
  never forks from use. Every refusal cites its file plus the parse
  error's line/column or the field path (`"relays[1].name": ...`); a bad
  store never becomes a running surface
  that authenticates nobody (VPN-R26/R31).

**The two helpers — and why the keys are embedded.**

- **`relay.json`** (operator-edited) answers the relay's three
  questions in one JSON object: the endpoint to dial (URL with path
  prefix — `VPN_TUNNEL_URL`'s fact retires here), which principal to
  identify as (answered by `prv/relay/`, above — recorded so the
  question is not left dangling), and which exit key to expect:

  ```json
  {
    "endpoint": "https://exit-home.example:8443/tunnel/",
    "exit": [
      {"name": "exit-home", "public": "<base64url-spki>"}
    ]
  }
  ```

  The pairing binding — endpoint ↔ principal ↔ key — is **one JSON
  object, one spelling**: it cannot desync between a config reference
  and a separate key file, and one read audits the complete pair (the
  auditability of "which pairs does this host hold" that flat env could
  never answer at a glance).
- **`exit.json`** answers the exit's one question — which relays may
  use this exit — as one key entry per admitted relay:

  ```json
  {
    "relays": [
      {"name": "relay_bazzite", "public": "AAAA..."},
      {"name": "relay_laptop",  "public": "AAAA..."}
    ]
  }
  ```

  The key entry is the one fact cluster everywhere — `{"name",
  "public"}` — so the principal is embedded **in** its key entry: never
  a separate directive, never concatenated into a shaped string (the
  env-era grammar stays rejected). Names unique; the entries are the
  complete admitted set — the file *is* the list, not an index into
  one.
- **JSON, decoded strictly — the grammar is the parser.** No bespoke
  format: stdlib `encoding/json` with unknown-field rejection (Go's
  `Decoder.DisallowUnknownFields`) carries the fail-closed law for
  free — an unknown field, a wrong type, or a missing required field
  refuses at load, never at a surprising later moment. One schema for
  both files: `relay.json` takes `endpoint` (non-empty string) and
  `exit` (an array of key entries — required, exactly one entry today,
  a second only as same-name staging); `exit.json` takes `relays` (an
  array — ≥1 entries, unique names, cap 32) plus `egress` (d080's
  VPN-R38 opt-in data, inner shape owned there) — the fold that retires
  `estige.json` (d108's tree-shake) — while the exit's *bind* is no
  config fact at all: exactly one knob, env `PORT` (d110), never in the
  store; entry names match
  `[A-Za-z0-9_-]{1,64}`; `public` is unpadded base64url decoding to a
  44-byte Ed25519 SPKI. JSON's no-comments cost is accepted (annotation
  belongs in a field or outside the file) and recorded in the
  alternatives; one-field-per-line formatting keeps diffs reviewable
  and the parser does not care.
- **Embedding wins the one-spelling test** (the deliberate sidenote):
  a config that references key files and key files that hold values are
  two spellings of one binding — they can drift, and the fix for drift
  is either an outage (mismatched key fails closed) or worse (a stale
  reference silently trusting the wrong material). Embedded, there is
  nothing to desync: editing the trust statement is editing the key.
  The costs are accepted: helpers become integrity-critical config
  (they are — same class as any trust statement), openssl cannot read a
  key in place (the CLI's `list`/`fingerprint`/`export-pub` covers
  every human need), and a peer's public key is duplicated into every
  trusting host's file (inherent to distributed trust — the
  authorized_keys pattern).
- **Exactly two helpers — decided by role-disjointness.** Outbound
  pairing (relay) and inbound authorization (exit) are different facts
  for different roles: one merged file would interleave the two roles'
  sections and couple their failure domains on a dual-role host; three
  or more would split a binding across files — re-creating the desync
  embedding just killed. Two files, named after the roles they serve —
  `relay.json` ↔ `prv/relay/`, `exit.json` ↔ `prv/exit/` — so the role
  name is each path's only vocabulary: no third synonym per role
  (`conf`/`authorized` were exactly that, and are gone). The store has
  no other top-level shape.
- **The env surface shrinks to nothing secret.** `VPN_TUNNEL_URL` moves
  to `relay.json`; the bearer-era `VPN_OPERATOR_*` spellings retire;
  no `VPN_PRINCIPAL` ever exists; the four-env cardinality law never
  lands. d090's one-spelling-per-fact is satisfied **structurally** —
  role = directory, identity = filename, pairing = one line — instead of
  by naming discipline, and env keeps only non-secret runtime knobs.
- **Fail-closed, all of it**: a role helper present but unparseable;
  an unknown field, a wrong type, a missing `endpoint`, an empty `exit`
  or `relays`; a name failing the grammar; a `public` value that is not
  a 44-byte Ed25519 SPKI; zero or two-plus private keys in an active
  role's directory; PEM private keys; unreadable store directory or
  over-open private permissions; duplicate names beyond the
  staged-rotation cap; a `relay.json` whose `exit` array names two
  different principals; an `exit.json` that is present but empty (an
  exit that admits nobody is refused, not started) — all refuse startup
  loudly with path context, and the preference is recorded:
  **disruptive, never insecure**.
