---
id: d104
type: decision
status: accepted (decision record only — the implementing change is pending)
title: "d104 — mutual HMAC exit↔relay credential: time-windowed HMAC-SHA-256 proofs replace the tunnel bearer"
parent: llm-reverse-proxy
depends-on: [d073, d078, d084, d085, d088, d090]
references: [d071, d077, d080, d091, d095]
tags: ["serving", "proxy", "vpn", "auth", "hmac", "secrets", "tunnel", "tunnel-auth"]
---

# d104 — mutual HMAC exit↔relay credential

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
wanted is narrower than either: **the shared secret must never appear on the
wire or in any process that is not an endpoint**, while the payload stays
opaque (the CONNECT/byte-pump vow — no tampering, no inspection) and the
camouflage-404 posture (VPN-R34) survives — no challenge round trip, no 401,
no oracle. The credential must also name its principals by deployment
(d088), because the plan beyond today's single hub is relay-to-exit-to-relay.

## Decision

### Mechanism — single-flight mutual HMAC proofs

Time-windowed HMAC proofs: TOTP's shape without TOTP's digit truncation.
Each side computes its proof before the exchange; one message each
direction; no challenge round trip (a challenge needs a pre-auth response —
an oracle, which VPN-R34 forbids, and a wasted round trip for a client that
can compute its proof up front).

```
relay → exit:  X-Relay-Proof: v1.<step>.<base64url(tag_r)>
               tag_r = HMAC-SHA256(K_relay, "estige/v1/relay-to-exit" ‖ step ‖ relay_id ‖ exit_id)
exit → relay:  X-Exit-Proof:  v1.<step>.<base64url(tag_e)>
               tag_e = HMAC-SHA256(K_relay, "estige/v1/exit-to-relay" ‖ step ‖ relay_id ‖ exit_id ‖ tag_r)
```

- **Full 32-byte tag, base64url — never truncated.** RFC 4226's 31-bit
  dynamic truncation (and TOTP's ~20-bit digits) exists so humans can type
  codes; both ends here are machines. Online forgery sits at the birthday
  bound, ~2^128, regardless of the accepted window — brute force leaves the
  threat list entirely, which is why rate limiting is DoS hygiene here, not
  a security control.
- **Hash: HMAC-SHA-256.** TOTP's SHA-1 is a 2005 authenticator constraint,
  not a recommendation: no practical HMAC-SHA1 forgery is known, but SHA-1
  caps the tag at 160 bits (~2^80 forgery) and signals legacy. SHA-512 buys
  nothing above this class — the 32-byte tag already caps forgery at the
  2^128 class where TLS and AES live.
- **Domain-separation labels are deployment-pair names** (d088's names, per
  this record's protocol-layer extension there): a relay's proof can never
  verify as an exit's (reflection-safe), and the labels are the composition
  point for the hub-and-spoke future — relay-to-exit-to-relay is two
  ordinary pairwise hops, each verified independently, zero new crypto.
  Relay-relay direct needs only a rendezvous the restricted network is
  unlikely to ever allow: not designed for, not excluded.
- **The exit's proof binds `tag_r`** — the pair belongs to one exchange.
  The relay verifies it and fails closed (VPN-R26's spirit): an exit that
  does not hold the key is refused at the handshake, beyond VPN-R28's
  hostname pinning. Today's `Sec-WebSocket-Accept` check proves nothing
  about server identity — anyone can compute it from the client's own key.
- **`step` = floor(unix/30), accepted ±1.** With full-width tags the window
  is purely a replay bound, not a guessing bound, so widening it for the
  relay host's clock drift (restricted internet: NTP may itself be blocked)
  costs nothing against forgery. What a captured proof buys an attacker:
  replay to the same endpoint inside ~90 seconds — strictly less than the
  forever-bearer it replaces. The exact step/window is an open question
  below; the security argument does not depend on it.
- **No body in the MAC.** Method/path/identity/step only: hashing the body
  would re-import RFC 9421's streaming killer, and TLS already carries body
  integrity on the client→edge leg (the edge→node leg is the operator's own
  tailnet).

### Keys and principals

- **256-bit keys, fail-closed.** Each keyset value is exactly 32 bytes from
  `crypto/rand`, base64 in the JSON; a value that decodes to anything else
  refuses startup loudly (d071's law; d078's fail-closed invariant with its
  floor raised 16 bytes → 32). This raises VPN-R44's ~100-bit capability-key
  floor where it actually matters: an HMAC key is the only secret, it never
  rides the wire, and its compromise is total impersonation — the standard
  is "at least the MAC's output length, uniformly random". A 512-bit key is
  wasted: the tag caps forgery at ~2^128 regardless.
- **Per-principal keys; ids are node names** (`relay-bazzite`,
  `exit-home`) in d078's unchanged keyset shape — JSON id → key, log-safe
  id grammar, bounded set, constant-time full-set scan with no early exit
  (VPN-R33). Revocation stays what it was: remove one row.
- **Each node holds only its own half**: the exit holds the keyset
  (`VPN_OPERATOR_KEYS`, d090's split), each relay holds exactly its own
  key. No process outside the two endpoints ever holds a usable credential
  — the whole point of the scheme.

### Naming — deployment roles, protocol layer included

The exit/relay vocabulary (d088) extends into the wire: credential headers,
MAC labels, principal ids, the tunnel handshake's label field, and log
fields speak exit/relay, never client/server. Two senses are exempt because
they are not this repo's to rename: RFC 6455's WebSocket mask polarity (the
RFC's word for who masks) and `relay.go`'s role-neutral "peer". d088 is
amended accordingly; the code-field rename belongs to the implementing
change.

### Failure posture — unchanged camouflage

Wrong, missing, expired, or malformed proof → the allowlist relay's
byte-identical camouflage 404 (VPN-R34): no 401, no challenge, no distinct body, no proof
or key bytes in logs or error bodies (VPN-R33), full-width constant-time
compare over the bounded principal set. The success signal (a `101`) is
unavoidably distinguishable from failure; nothing else is.

### Arming — the d084/d085 contract, unchanged

Env presence remains the tri-state arm: the tunnel surface exists iff the
exit's keyset env carries v1 keys; absent = today's byte-identical unarmed
behavior. The scheme is namespace-scoped to the tunnel handshake (VPN-R2's
separation): the allowlist relay is untouched, and the gateway namespace
(d091) keeps its staged bearer until a separate decision extends proofs there.

## Requirement deltas (restated with citations)

- **VPN-R31 (amended for the tunnel namespace)** — the tunnel's operator
  credential becomes the mutual proofs above; the literal bearer retires
  from the `Authorization` handshake header when the implementing change
  lands. The authenticated relay's gateway credential (d091) is untouched.
- **VPN-R12 (amended)** — the tunnel handshake still carries its credential
  in a header; the content becomes `X-Relay-Proof` plus the principal id,
  never a bearer.
- **VPN-R33 (unchanged, applied)** — 32-byte tags compare full-width,
  constant-time; proofs and keys are log-forbidden like every credential.
- **VPN-R34 (unchanged, applied)** — proof failures answer the camouflage
  404, byte-identical to the allowlist relay's garbage response.
- **VPN-R44 (raised for keys)** — capability keys keep the ~100-bit floor;
  HMAC keys are exactly 32 raw bytes (256 bits), fail-closed at decode.
- **VPN-R32 (unchanged)** — keys arrive env-only through the one chain
  step; this record changes the credential's shape, not its transport.
- **d090 (unchanged)** — one spelling per fact survives: the relay's
  credential fact keeps exactly one env name; whether that name stays
  `VPN_OPERATOR_TOKEN` when its content becomes a key is left to the
  implementing change (open question below).

## Consequences

- The TLS terminator (host tailscaled) sees only ≤90-second proofs and
  never the secret: exposure degrades from "permanent credential in a third
  process" to "windowed replay against the intended endpoint".
- No topology change: still the CLI funnel, plain-HTTP estige behind
  loopback; no tsnet embedding, no TLS front door, no allowlist-relay
  regression, no CA, no certificate lifecycle.
- The hub-and-spoke future (relay-to-exit-to-relay) composes as pairwise
  hops with zero new crypto; multi-exit means one keyset per exit plus one
  relay key per exit it dials — the pairing `VPN_TUNNEL_URL` already
  implies.
- Code deltas — the tunnel handshake on both nodes, `operatorKeysFromEnv`'s
  floor, the launchers' env allowlists, the relay's dialer — are all
  pending; this record is decision-only, per the instruction that landed it.

## Alternatives rejected

- **mTLS via tsnet `FunnelTLSConfig`** — verified possible (the funnel edge
  forwards TLS L4; the node terminates), but it moves TLS termination into
  estige (front-door handshake load, dependency and identity shift for a
  zero-dependency unit), gates the whole hostname in one `tls.Config` so
  namespace-split policies need two hostnames, and a handshake-layer
  oracle or a soft-verify fallback either breaks camouflage or dilutes the
  gate. The deferred "genuine second factor" d073/d085 kept naming is
  answered here instead.
- **RFC 9421 HTTP Message Signatures** — body digests require hashing the
  whole body before send (kills streaming, estige's core contract) and the
  byte pump has no per-request message components to sign. Wrong layer
  twice.
- **Challenge-response over a nonce** — needs a pre-auth round trip; the
  first response becomes an oracle (VPN-R34) and costs a handshake RTT for
  nothing a pre-computed proof does not buy.
- **31-bit (RFC 4226) or 6-digit truncation** — typable-code ergonomics
  for humans; both ends are machines, and truncation re-opens online
  guessing (6 digits ≈ 2^20 ≈ minutes at modest rates; 31 bits ≈ months)
  for zero benefit. A human-code variant, if ever wanted, is a documented
  downgrade, not this scheme.
- **Keep the literal bearer** — identical endpoint trust, but permanently
  replayable and plaintext in the terminator; strictly dominated.
- **SHA-1 (TOTP's hash)** — no practical HMAC break, but the 160-bit tag
  caps forgery at ~2^80 and nothing else recommends it.

## Open questions

- **Migration** — recommended: the implementing change replaces the tunnel
  bearer outright; an exit armed with v1 keys whose keyset values are not
  32-byte keys refuses startup loudly with the migration spelled out
  (d090's refusal pattern), vault edit first, binary second. Coexistence
  (accept bearer OR proof for one release) only if a deployed relay
  cannot be vault-updated in lockstep.
- **Namespace scope** — this record gates the tunnel handshake only.
  Whether the allowlist relay's public face or d091's gateway later adopt
  per-request proofs (method+path+step, never the body) is a separate decision.
- **Step/window on the relay host** — 30s/±1 is the assumed default;
  confirm the restricted host's clock source and record the measured drift
  before widening.
- **The relay's env spelling** — `VPN_OPERATOR_TOKEN`'s content becomes a
  key; rename-or-keep is a d090 one-spelling-per-fact call for the
  implementing change.

## Verification

- missing / wrong / expired proof → byte-identical camouflage 404
  (smoke-test negative, VPN-R34);
- valid proof pair → `101`; an exit with the wrong key → the relay fails
  closed at the handshake (VPN-R26), never a tunneled byte;
- proof replayed outside ±1 step → 404; replayed inside the window to the
  same exit → accepted (the declared bound);
- proof bytes and keys absent from logs, 404 bodies, and error bodies
  (VPN-R33);
- keyset values of 15, 31, and 33 bytes → loud startup refusal (the
  fail-closed floor).
