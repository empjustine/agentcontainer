---
id: d104
type: module-design
status: active
title: "d104 — mutual exit↔relay credential: single-use nonce-bound Ed25519 proofs with named principal keys replace the tunnel bearer"
parent: estige
depends-on: [d073, d078, d084, d085, d088, d090]
references: [d071, d077, d080, d091, d095, d131, d132, d133]
tags: ["serving", "proxy", "vpn", "auth", "ed25519", "secrets", "tunnel", "tunnel-auth"]
---

# d104 — mutual exit↔relay credential

## Status

Accepted — decision record only; the implementing change is pending.

**This record is deployment generation v4** in d108's tree-wide numbering,
and d108 owns that numbering; this record's own earlier credential counter
(v1 bearer / v2 proofs) is retired — see "Versions" for why, and for what the
`v2` envelope token does and does not mean. Adopting the numbering is a naming
change only: the wire shape, the exchange and the replay discipline are as
designed below.

Amended before any implementation shipped: the proof's time-step window
(`step` = floor(unix/30), accepted ±1) is replaced by single-use nonces
with an exit-side replay cache — no clock anywhere in the auth path —
and the session bound (one authentication = one connection = one
CONNECT) is stated as a security bound instead of left as an
implementation accident. Nothing was ever deployed on the step shape,
so the amendment is in-place, not a generation bump; the retired shape
and its weaknesses are recorded in the alternatives.

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

Single-use nonce-bound Ed25519 proofs in both directions replace the shared
bearer, with key material held in a role-scoped store rather than the env chain:
**one authentication buys one connection and one CONNECT**, and no side can mint
the other's direction because a verifier holds only public keys.

**The mechanics live in three companion records**, split out because this record
had grown past the point where a decision could be read as one:

| record | owns |
| --- | --- |
| [d131](d131-estige-v4-proof-mechanics.md) | the envelopes, both signatures, the signed message layout, the version counters (`v4` deployment vs the `v2` envelope token), and what a verify costs |
| [d132](d132-estige-v4-key-store.md) | the store: role-scoped `prv/` directories, the `relay.json` / `exit.json` helpers, the strict-JSON parsing law, and the `estige key` CLI |
| [d133](d133-estige-v4-credential-operations.md) | operating it: arming by helper presence, deployment naming, the unchanged camouflage failure posture, and staged zero-gap rotation |

What stays here is the decision itself and what follows from it: the problem, why
this primitive and not the alternatives, the requirement deltas it forces, its
consequences, and the alternatives rejected.

## Requirement deltas (restated with citations)

- **VPN-R31 (amended for the tunnel namespace)** — the tunnel's operator
  credential becomes the mutual named-key proofs above — each direction
  signed by its own principal's private key; the literal bearer retires
  from the `Authorization` handshake header when the implementing change
  lands. The authenticated relay's gateway credential (d091) is
  untouched.
- **VPN-R12 (amended)** — the tunnel handshake still carries its
  credential in headers; the content becomes `X-Relay-Proof` and
  `X-Exit-Proof`, each `v2.<own-key-name>.<nonce>.<sig>` — the minter's
  security principal key name and single-use nonce included, never a
  bearer.
- **VPN-R33 (unchanged, applied)** — both admitted-set name scans are
  full-width constant-time over every row with no early exit; signature
  comparison is the primitive's own full-width check; signatures, seeds,
  and PEM/DER material are log-forbidden like every credential; key
  names, fingerprints, and nonces are log-safe labels (d078's id sense —
  a nonce is wire-public single-use data, not a secret).
- **VPN-R34 (unchanged, applied)** — proof failures, unknown names,
  direction swaps, and replayed nonces answer the camouflage 404,
  byte-identical to the allowlist relay's garbage response.
- **VPN-R44 (restated for signatures)** — capability keys keep the
  ~100-bit floor; the tunnel identity is Ed25519 with fixed sizes (32-byte
  seed, 32-byte public key, 44-byte SPKI, 16-byte nonce), validated by
  parse and consumed by the replay cache, fail-closed.
- **VPN-R32 (AMENDED — the transport of keys changes)** — key material
  and tunnel pairing configuration **never enter env**; the key store at
  `~/.local/share/estige/` is the one secret surface, and env carries
  only non-secret runtime knobs. The chain step no longer transports key
  material — it validates the store (`estige key check`) before exec.
- **d090 (applied, then satisfied structurally)** — one spelling per fact:
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
  `tests/check-vpn-relay-chain.sh` is updated with it (then deleted with the
  launchers, docs/d120).
- **d084/d085 (kept, re-based)** — the tri-state arming contract holds:
  helper presence is intent, absence is byte-identical unarmed,
  presence-with-a-broken-store is loud refusal.

## Consequences

- The TLS terminator (host tailscaled) sees only single-use proofs and
  never secret material: exposure degrades from "permanent credential in
  a third process" to "block-the-genuine-exchange-then-replay-once,
  buying one CONNECT on one connection".
- **The auth path reads no clock**: host clock drift can cause outages
  elsewhere (TLS validity, log ordering), never a weakened or widened
  authentication decision — the restricted relay host's NTP question
  retires with the step shape.
- **The exit's replay cache is attack-inert**: only verified proofs enter
  it, so its growth is bounded by genuine handshakes alone and its
  memory by the cap, regardless of traffic.
- **One authentication admits one connection, one CONNECT**: no
  renegotiation, no chained CONNECT, a session dies with its carrier —
  the bound mTLS buys from record keys is bought here from single-use
  admission instead.
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
  for nothing a pre-computed proof does not buy. (A client-*drawn* nonce
  in the first message is not this: it adds freshness without a flight,
  and is what the decision uses.)
- **The time-step window (`step` = floor(unix/30), accepted ±1) — this
  record's original shape** — a replay bound with three weaknesses the
  nonce removes at the same zero-round-trip cost: Ed25519 is
  deterministic, so a message with no per-exchange entropy made every
  proof in a step byte-identical — the exit proof's binding to `sig_r`
  was really a binding to the (step, names) pair, so a captured exchange
  admitted a same-step MITM of the relay on top of window-long replay at
  the exit; the bound depended on both hosts' clocks (NTP may itself be
  blocked on the restricted relay host); and one replayed mode D
  handshake opened a session that outlived the window. Strictly
  dominated by a single-use nonce with a consumed-at-verify cache.
- **Nonce plus a loose signed timestamp (±10 min) instead of the cache** —
  keeps a clock in the auth path (drift past tolerance is an outage) and
  admits unlimited replays inside the tolerance; the cache admits one.
- **Nonce with no cache** — first presentation wins forever: a captured
  proof stays replayable indefinitely, and the genuine exchange fails if
  it arrives second. Dominated by both.
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
  per-request proofs (the envelope, never the body) is a separate
  decision.
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
- missing / wrong / replayed proof → byte-identical camouflage 404
  (smoke-test negative, VPN-R34); an **unknown key name** in either
  envelope → the same 404; a relay signature presented where an exit's
  belongs (direction swap) → 404; the `exit` entry's name matching but
  signature wrong → 404; name ≠ the `exit` entry → 404; an exit proof
  that does not bind the connection's own `nonce_r` → 404;
- a proof replayed after its genuine exchange (the same nonce presented
  a second time) → 404 — the cache consumes the nonce on first verify;
- the declared residual, pinned: a proof whose genuine first flight was
  blocked is accepted exactly once and opens exactly one CONNECT — a
  second CONNECT frame on the live session is a protocol violation, and
  the session dies with its carrier;
- the replay cache never grows on attack traffic: forged proofs and
  unknown names never enter it (cap test-hooked);
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
  the implementing change, and replaced by the Go tests in docs/d120);
- no store at all → byte-identical unarmed behavior (d084 smoke).
