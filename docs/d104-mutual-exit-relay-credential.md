---
id: d104
type: module-design
status: active
title: "d104 — mutual exit↔relay credential: time-windowed Ed25519 proofs with named principal keys replace the tunnel bearer"
parent: estige
depends-on: [d073, d078, d084, d085, d088, d090b]
references: [d071, d077, d080, d091, d095]
tags: ["serving", "proxy", "vpn", "auth", "ed25519", "secrets", "tunnel", "tunnel-auth"]
---

# d104 — mutual exit↔relay credential

## Status

Accepted — decision record only; the implementing change is pending.

## Problem

The tunnel's operator credential is a literal bearer (d073's VPN-R31,
realized as the `Authorization` handshake header per VPN-R12), and it fails
in three places at once:

- **It is visible in a third process.** The funnel TLS terminates in the
  host's tailscaled — not an endpoint of the credential — and the token
  crosses into estige as ordinary plaintext HTTP. Whoever holds the
  terminator's memory holds the credential.
- **It is permanent.** Capture once (either endpoint, any backup, any log
  the env ever touched), replay forever; there is no window, no freshness,
  and no per-use evidence.
- **It is symmetric in the weakest sense.** Both nodes hold the same bytes,
  so the server can impersonate clients and any thief of either side owns
  both directions.

PKI was evaluated first and rejected (see the alternatives): real mTLS on
the funnel is possible only by making estige the TLS front door, and RFC 9421
request signing cannot sign streaming bodies or byte-pump frames. What is
wanted is narrower than either: **the secret must never appear on the wire
or in any process that is not an endpoint**, while the payload stays
opaque (the CONNECT/byte-pump vow — no tampering, no inspection) and the
camouflage-404 posture (VPN-R34) survives — no challenge round trip, no 401,
no oracle. The credential must also name its principals by deployment
(d088), because the plan beyond today's single hub is relay-to-exit-to-relay.

Three constraints shape the scheme before any crypto is chosen:

- **One verification per proof, regardless of keyring size.** The obvious
  way to verify against a bounded set — try every key held until one
  verifies — makes authentication linear in the set: fine for today's
  single pairing, wrong for the hub-and-spoke future this record exists to
  compose into, where every handshake would pay verification work for
  principals that were never going to match. The wire must therefore say
  **which security principal key** is being proven, so the verifier
  indexes instead of doing crypto across the set.
- **A storage model where identity, role, and pairing are structurally
  distinct.** Every credential ambiguity patched so far traced to how the
  credential was spelled and stored: the bearer said nothing about who
  held it; flat env vars forced cardinality (singular/plural names) and a
  value grammar (shaped strings, separators, right-edge parsing) to
  encode what directories and filenames express directly. The credential
  must be storable, rotatable, and auditable like any host credential —
  ssh is the working example — rather than reconstructed from env
  spelling discipline on every node.
- **Disruptive operations are preferred over insecure operations.** Where
  a configuration is ambiguous, incomplete, or contradictory, the store
  refuses loudly (an outage) instead of guessing, falling back, or
  accepting an unknown (a compromise). This is VPN-R26's fail-closed law
  stated as an explicit preference ordering, and it governs every
  refusal below.

## Decision

### Mechanism — single-flight mutual Ed25519 proofs

Time-windowed signatures: TOTP's shape without TOTP's digit truncation and
without TOTP's shared secret. Each side computes its proof before the
exchange; one message each direction; no challenge round trip (a challenge
needs a pre-auth response — an oracle, which VPN-R34 forbids, and a wasted
round trip for a client that can compute its proof up front).

```
relay → exit:  X-Relay-Proof: v2.<relay-key-name>.<step>.<base64url(sig_r)>
               sig_r = Sign(sk_relay, "estige/v2/relay-to-exit" ‖ step ‖ relay-key-name ‖ exit-key-name)
exit → relay:  X-Exit-Proof:  v2.<exit-key-name>.<step>.<base64url(sig_e)>
               sig_e = Sign(sk_exit,  "estige/v2/exit-to-relay" ‖ step ‖ exit-key-name ‖ relay-key-name ‖ sig_r)
```

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
  class puts brute force off the threat list entirely, regardless of the
  accepted window — which is why rate limiting is DoS hygiene here, not
  a security control.
- **Algorithm: Ed25519, stdlib `crypto/ed25519`.** Deterministic
  (identical message → identical signature: no signing-time RNG, replay-
  friendly tests), parameterless (no curve choices, no padding
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
- **The exit's proof binds `sig_r`** — the pair belongs to one exchange.
  The relay verifies it and fails closed (VPN-R26's spirit): an exit
  whose key is not the one embedded in the relay's pairing is refused at
  the handshake, beyond VPN-R28's hostname pinning. Today's
  `Sec-WebSocket-Accept` check proves nothing about server identity —
  anyone can compute it from the client's own key.
- **`step` = floor(unix/30), accepted ±1.** Signatures are exactly as
  replayable as MACs — the window is purely a replay bound, not a
  guessing bound — so widening it for the relay host's clock drift
  (restricted internet: NTP may itself be blocked) costs nothing against
  forgery. What a captured proof buys an attacker: replay to the same
  endpoint inside ~90 seconds — strictly less than the forever-bearer it
  replaces. The exact step/window is an open question below; the
  security argument does not depend on it.
- **No body in the signed message.** Method/path/identity/step only:
  signing the body would re-import RFC 9421's streaming killer, and TLS
  already carries body integrity on the client→edge leg (the edge→node
  leg is the operator's own tailnet).
- **Every tunnel-namespace authentication point speaks the envelope.** The
  mode D upgrade carries it on the handshake request/response headers;
  modes C and E carry it on each POST's request/response headers — d077's
  per-request credential point, since a body session has no handshake
  header of its own. Same shape, same verification, one envelope each way
  per authentication.

### Versions — estige tunnel v2

Three counters exist and they mean different things; the implementing change
must not conflate them:

- **Credential generation** — v1 is the shipped static bearer handshake
  (d073's tunnel as deployed); v2 is this scheme. That is what "estige v2
  tunnel protocol" names, and it versions itself in two places that move
  together: the envelope's `v2` token and the labels' `estige/v2/`
  prefix — so a future proof revision re-versions both, and a v3 proof can
  never be signed under v2 labels.
- **HELLO/frame version** (VPN-R15) — stays 1. No frame changed; auth runs
  before any HELLO, so a cross-generation peer dies at the credential layer
  (a bearer where a proof is expected, or the reverse) as a fail-closed
  camouflage 404, before a frame version could ever disagree.
- **The envelope token is the wire-visible one** — a node must be able to
  refuse an unknown generation without computing anything.

### Cost — index by name, one verify per proof

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
- The residual timing delta — an unknown name skips its one verify,
  tens of microseconds — is below network jitter and against a name that
  is a log-safe label the operator's logs already print; the load-bearing
  oracle control is VPN-R34's byte-identical response vocabulary, not
  microsecond flatness (the dummy-key flatten is rejected below).

### Key store — role-scoped directories and two helper files

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
  (d090b's shared-env case) simply has one file in each role directory,
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
  lands. d090b's one-spelling-per-fact is satisfied **structurally** —
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

### Naming — deployment roles, protocol layer included

The exit/relay vocabulary (d088) extends into the wire and the store:
credential headers, signed-message labels, principal names, store paths
(`prv/relay`, `prv/exit`, `relay.json`, `exit.json`), and
log fields speak exit/relay, never client/server. Two senses are exempt
because they are not this repo's to rename: RFC 6455's WebSocket mask
polarity (the RFC's word for who masks) and `relay.go`'s role-neutral
"peer". d088 is amended accordingly; the code-field rename belongs to the
implementing change.

### Failure posture — unchanged camouflage

Wrong, missing, malformed, or expired proof — and now also an **unknown key
name** in either envelope, a direction-swapped proof (a relay signature
presented as an exit's), or a name whose signature does not verify under
the embedded key — all answer the allowlist relay's byte-identical
camouflage 404 (VPN-R34): no 401, no challenge, no distinct body, no
proof, key, or name bytes in logs or error bodies beyond the success-path
attribution (VPN-R33). Store-side ambiguity never reaches a response: it
refuses at load. The success signal (a `101`) is unavoidably
distinguishable from failure; nothing else is.

### Arming — the d084/d085 contract, via helper presence

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
change). The scheme stays namespace-scoped to the tunnel (VPN-R2's
separation): the allowlist relay is untouched, and the gateway namespace
(d091, now deprecated) keeps its staged bearer — out of scope here and
no longer planned anywhere: extending proofs there would be a separate
decision.

### Rotation — staged, zero-gap (considered; CLI deferred)

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
  PEM; (2) each peer imports the new key *alongside* the old — both
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

## Requirement deltas (restated with citations)

- **VPN-R31 (amended for the tunnel namespace)** — the tunnel's operator
  credential becomes the mutual named-key proofs above — each direction
  signed by its own principal's private key; the literal bearer retires
  from the `Authorization` handshake header when the implementing change
  lands. The authenticated relay's gateway credential (d091) is
  untouched.
- **VPN-R12 (amended)** — the tunnel handshake still carries its
  credential in headers; the content becomes `X-Relay-Proof` and
  `X-Exit-Proof`, each `v2.<own-key-name>.<step>.<sig>` — the minter's
  security principal key name included, never a bearer.
- **VPN-R33 (unchanged, applied)** — both admitted-set name scans are
  full-width constant-time over every row with no early exit; signature
  comparison is the primitive's own full-width check; signatures, seeds,
  and PEM/DER material are log-forbidden like every credential; key
  names and fingerprints are log-safe labels (d078's id sense).
- **VPN-R34 (unchanged, applied)** — proof failures, unknown names, and
  direction swaps answer the camouflage 404, byte-identical to the
  allowlist relay's garbage response.
- **VPN-R44 (restated for signatures)** — capability keys keep the
  ~100-bit floor; the tunnel identity is Ed25519 with fixed sizes (32-byte
  seed, 32-byte public key, 44-byte SPKI), validated by parse, fail-closed.
- **VPN-R32 (AMENDED — the transport of keys changes)** — key material
  and tunnel pairing configuration **never enter env**; the key store at
  `~/.local/share/estige/` is the one secret surface, and env carries
  only non-secret runtime knobs. The chain step no longer transports key
  material — it validates the store (`estige key check`) before exec.
- **d090b (applied, then satisfied structurally)** — one spelling per fact:
  role = directory, identity = filename, pairing = one JSON object. The
  bearer-era spellings (`VPN_OPERATOR_TOKEN`, `VPN_OPERATOR_KEYS`,
  `VPN_TUNNEL_URL`) retire with the implementing change; the four-env
  cardinality law that intermediate designs needed never lands.
- **d071 (amended for the store)** — the vault stops being the source of
  truth for tunnel keys: the store is (generated on-host by `keygen`
  from `crypto/rand`, never in the vault, never in git). The vault keeps
  its other-namespace secrets untouched; `environment.sh`'s one-round-
  trip mechanics are unchanged. Key strength moves from "the vault owns
  it" to "keygen owns it, the loader enforces shape and size".
- **d095 (reworked by the implementing change)** — the chain step's
  credential gate becomes `estige key check`; the pinning test
  `tests/check-vpn-relay-chain.sh` is updated with it.
- **d084/d085 (kept, re-based)** — the tri-state arming contract holds:
  helper presence is intent, absence is byte-identical unarmed,
  presence-with-a-broken-store is loud refusal.

## Consequences

- The TLS terminator (host tailscaled) sees only ≤90-second signatures and
  never secret material: exposure degrades from "permanent credential in a
  third process" to "windowed replay against the intended endpoint".
- **Direction isolation is structural**: verifiers hold public keys that
  cannot sign — the bearer's symmetry weakness is answered by the
  primitive, not by prose. And the admitted sets are leak-safe: exfiltrating
  `exit.json` or `relay.json` forges nothing (public material
  only); substitution remains the residual attack, answered by
  out-of-band fingerprints.
- **One secret surface**: key material exists only as `prv/*` files under
  a 0700 directory — never in env, never inherited by child processes,
  never in `/proc/*/environ`. Children, logs, and crash dumps carry
  names, endpoints, and public keys at most.
- **Distribution is generate-in-place**: each principal's private key is
  created on the host that holds it and never travels; only public
  fingerprints/PEMs move, over any channel. N+M keys for N relays and M
  exits — no cartesian pairing set — and the audit of "which pairs does
  this host hold" is one file read.
- **Rotation without outage is format-reserved** (staged double entries);
  the CLI verbs that drive it are design intent for the implementing
  change. During any disruptive fallback the failure is a camouflage 404
  or a boot refusal — never a weaker accept.
- **Cost is flat in the set, plus one ~30–80µs verify per
  authentication**: an unauthenticated flood can force verify work — the
  DoS surface this primitive adds — rate limiting stays hygiene, not a
  security control (VPN-R34's vocabulary is the oracle control).
- **No topology change**: still the CLI funnel, plain-HTTP estige behind
  loopback; no tsnet embedding, no TLS front door, no allowlist-relay
  regression, no CA, no certificate lifecycle.
- **Pairs upgrade together**: this is a wire change — a mixed
  old/new pairing fails closed (camouflage 404 on the wire; loud store
  refusal at boot), never a downgrade to bearer.
- Code deltas — the tunnel handshake on both nodes, the store
  loader/validator, the `estige key` CLI, the launchers' intent
  detection, the chain step's gate and its pinned test, and the relay's
  dialer — are all pending; this record is decision-only, per the
  instruction that landed it.

## Alternatives rejected

- **No key name on the wire — verify against every key held** — the cost
  problem this design exists to solve: authentication becomes O(set)
  verifications, linear in a set that only grows with the deployment.
  It buys nothing secret either: the name is a log-safe label the
  operator's logs already print, while the material never leaves its
  holder.
- **HMAC with a shared pair key (this record's first shape)** —
  symmetric verification forces both endpoints to hold the full key, so
  "neither side can mint the other's direction" was **false**: either
  endpoint could mint both directions. Pair keys also force a bad
  scaling trade — N×M secrets (the accidental cartesian) or per-
  principal keys whose compromise spreads across every pair of that
  principal. Direction separation never came from the key either way —
  it comes from the labels, which both schemes share. Ed25519 keeps the
  envelope's shape and makes the claim true.
- **HMAC four-env cardinality law (`VPN_RELAY_KEY`/`VPN_EXIT_KEY`
  singular, `VPN_RELAY_KEYS`/`VPN_EXIT_KEYS` plural)** — a patch on
  env's flatness: plurality encodes own-vs-accepted, and the values
  still needed a shaped-string grammar. The store makes the distinction
  structural (directory vs. helper) and the law never lands.
- **Shaped-string env values (`name.material`, dot or hyphen
  separator, right-edge parsing)** — the grammar archaeology that
  follows from storing identities in flat values: separators chosen
  against alphabet collisions, fixed-width parsing hacks, JSON-type
  matrices. Filename-as-name ends the entire class.
- **`pbl/` per-key public files** — intermediate idea: config
  references a key file, key file holds the value — two spellings of
  one binding, drift-prone, and a directory of keys is not auditable as
  a *pairing* list. Embedding the key in the helper is one spelling and
  one read.
- **One merged helper (or three or more)** — merged interleaves the two
  roles' sections and couples their failure domains on a dual-role
  host; three-plus splits a binding (endpoint ↔ key) across files,
  re-creating the desync embedding kills. Two role-disjoint files.
- **Custom plaintext helpers (ssh-config style, `#` comments)** — a
  bespoke grammar means a bespoke parser, a bespoke error surface, and
  bespoke edge cases (inline comments, duplicate directives, trailing
  separators — the env-era shape of bugs, one field at a time). Stdlib
  JSON with unknown-field rejection buys an airtight fail-closed
  grammar at zero dependencies; no comments is the accepted cost, and
  reviewable diffs are had from one-field-per-line formatting the
  parser does not care about.
- **`VPN_PRINCIPAL` / `identity =` selection** — a second spelling of
  identity beside the filename; exactly-one-file-per-role-directory is
  the single spelling, and the mismatch case simply refuses.
- **Hash-table name index** — probes a bucket structure whose cost
  varies with the presented name — the timing variance VPN-R33's flat
  scan exists to flatten — to save nanoseconds under a cap of 32.
- **Dummy-key verify for unknown names** — buys sub-microsecond timing
  flatness for requests against an attacker who must already reach the
  tunnel namespace through the funnel; the load-bearing oracle control
  is VPN-R34's byte-identical vocabulary, and the delta is one verify
  buried in network jitter. Cost without a threat.
- **mTLS via tsnet `FunnelTLSConfig`** — verified possible (the funnel
  edge forwards TLS L4; the node terminates), but it moves TLS
  termination into estige (front-door handshake load, dependency and
  identity shift for a zero-dependency unit), gates the whole hostname
  in one `tls.Config` so namespace-split policies need two hostnames,
  and a handshake-layer oracle or a soft-verify fallback either breaks
  camouflage or dilutes the gate. Raw public-key pins keep the no-CA
  property this rejection protects; certificates wrapping those pins
  would import a CA lifecycle for no additional trust (substitution is
  handled by fingerprints instead).
- **RFC 9421 HTTP Message Signatures** — body digests require hashing
  the whole body before send (kills streaming, estige's core contract)
  and the byte pump has no per-request message components to sign.
  Wrong layer twice.
- **Challenge-response over a nonce** — needs a pre-auth round trip; the
  first response becomes an oracle (VPN-R34) and costs a handshake RTT
  for nothing a pre-computed proof does not buy.
- **31-bit (RFC 4226) or 6-digit truncation** — typable-code ergonomics
  for humans; both ends are machines, and truncation re-opens online
  guessing for zero benefit.
- **ECDSA P-256** — needs a secure RNG at signing, low-s
  canonicalization discipline, and carries a nonce-failure history;
  Ed25519 is deterministic and parameterless.
- **RSA-PSS** — 2048-bit minimum, slow verify, padding discipline;
  strictly dominated at this tag size.
- **X25519 ECDH + HMAC (Noise-style)** — static↔static collapses to a
  shared secret (the same blast radius as the rejected shared pair key,
  just curve-shaped); ephemeral key agreement adds forward secrecy for
  session secrets that do not exist here — payload confidentiality is
  the tailnet's WireGuard job. HKDF and transcript machinery for zero
  gain.
- **Keep the literal bearer** — identical endpoint trust, but
  permanently replayable and plaintext in the terminator; strictly
  dominated.

## Open questions

- **Migration** — recommended: store-first, one cut. `keygen` runs on
  each host and the helpers are provisioned while the old binary still
  runs on the bearer env (the store is inert to it); then the binary
  lands (old names alone refuse loudly with the rename spelled out;
  helpers present = armed; the wire change means a pairing upgrades in
  lockstep — mixed generations fail closed). The HMAC-era env design was
  never implemented and never ships: production goes bearer →
  store+proofs directly.
- **Namespace scope** — this record gates the tunnel namespace only.
  Whether the allowlist relay's public face or d091's gateway later adopt
  per-request proofs (method+path+step, never the body) is a separate
  decision.
- **Step/window on the relay host** — 30s/±1 is the assumed default;
  confirm the restricted host's clock source and record the measured
  drift before widening.
- **Multi-pairing relay** — the format takes exactly one `endpoint`
  and one `exit` principal today (a second entry is same-name staging
  only; different names are refused). Whether one relay dials several
  exits is not designed here — the array grammar does not preclude it.
- **Staged-rotation CLI surface** — the verbs and caps above are design
  intent; the implementing change settles their exact flags and whether
  `revoke` edits helpers atomically (write-temp + rename) or requires
  operator hands.

## Verification

- store refusals, each with file/line or field-path context, none
  reaching a running surface: helper present but unparseable; unknown
  field or wrong type (strict decode); missing `endpoint`; empty `exit`
  or `relays`; name grammar violation; bad base64 or non-Ed25519 SPKI;
  zero or two-plus private keys in the active role's directory; PEM
  private key; store directory not 0700 or `prv/*.der` group/world-
  readable; duplicate names beyond the staged cap; `exit.json`
  present but empty;
- import accepts PEM, DER, and ssh-pubkey lines into the same entry with
  the same fingerprint; `export-pub` prints PEM; the fingerprint is
  identical across all three encodings of one key;
- missing / wrong / expired proof → byte-identical camouflage 404
  (smoke-test negative, VPN-R34); an **unknown key name** in either
  envelope → the same 404; a relay signature presented where an exit's
  belongs (direction swap) → 404; the `exit` entry's name matching but
  signature wrong → 404; name ≠ the `exit` entry → 404;
- proof replayed outside ±1 step → 404; replayed inside the window to
  the same exit → accepted (the declared bound);
- staged rotation (format-level): two entries for one principal both
  verify; a third same-name entry refuses at load;
- an `exit.json` at the cap of 32 relays authenticates a named
  proof with exactly one verify (the cost assertion, test-hooked);
- signature bytes, seeds, and PEM/DER material absent from logs, 404
  bodies, and error bodies (VPN-R33); key names and fingerprints appear
  in the success-path attribution only;
- `keygen` creates `prv/` at 0700 and keys at 0600;
- `estige key check` fails loud before any bind for every refusal above
  (the chain-step gate; `tests/check-vpn-relay-chain.sh` updated with
  the implementing change);
- no store at all → byte-identical unarmed behavior (d084 smoke).
