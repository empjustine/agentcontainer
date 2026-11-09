---
id: d158
type: architecture-design
status: done
title: "d158 — spike: propagated context is not a data channel (baggage, TTL'd PII handles, and the stability of sub)"
parent: architecture
depends-on: [d045, d151, d157]
references: [d106, d134, d155]
tags: [privacy, pii, baggage, otel, propagation, oidc, spike]
---

# d158 — spike: propagated context is not a data channel

A deployment's two hardest privacy questions meet in the same header. W3C
Baggage is on by default in most SDK propagator stacks, is round-tripped by every
hop that is not explicitly told to strip it, and is read as untrusted input on
the way in — so a field built for cross-service correlation is the easiest way to
put personal data into a dozen logs nobody classified. The identifier most
deployments put in it, an OpenID Connect `sub`, is a stable per-person key on
almost every provider. This spike works out what to carry instead: a reference
with a lifetime, never a record.

## Status

Investigation finished, nothing implemented; the requirements at the end are not in
force. The findings are the W3C baggage specification's own properties, the
OpenID Connect subject types, and the identifier surfaces this tree already has
(d045's record shape, d106's correlation vocabulary, d155's journal fields). Open:
the authority of the handle vault (who may resolve, and what is audited), and
what a purge looks like when a telemetry store's retention outlives the handle.

## The carrier and its leaks

The W3C Baggage specification defines a `baggage` header of percent-encoded
key/value pairs. It sets no maximum size; per-entry limits are
implementation-defined. It is designed to be propagated — that is its whole
function — and it is designed to cross trust boundaries, which is why the
problems below are properties of the design rather than bugs in an
implementation.

A propagated header is logged by everything that reads headers: reverse proxies,
CDNs, WAFs, API gateways, access logs, tracing agents of other vendors, and the
browser's own developer tools. Each of those is a store with its own retention
and its own access list, and none of them is in the privacy review.

Three properties make inbound baggage worse than a leak:

- **It is on by default.** The composite propagator most SDKs install is
  `tracecontext,baggage`, so a service that never configured propagation still
  emits and accepts it.
- **It is attacker-controlled.** A browser or a partner may set it. Reading a
  value out of baggage and acting on it is accepting untrusted input as an
  authorization, which is the confused-deputy bug wearing a header.
- **It is copied into telemetry by reflex.** `baggage.FromContext` into a span
  attribute is the routine one-liner, and a span attribute reaches a
  long-retention store with broad read access — strictly worse than the header it
  came from.

## The threat model this spike assumes

Every decision below follows from assuming four things at once, because a
deployment that assumes only the first has no way to know the others are absent.

- Broad read access to the telemetry backend: a support engineer, a vendor, a
  secondment, a compromised role.
- Log aggregation as an unbounded secondary copy: proxy logs, WAF logs and
  vendor agents with retention nobody set.
- A cross-tenant or cross-purpose join: two systems that each hold a different
  pseudonym for one person, which together identify them.
- An erasure request against an append-only store: nothing in a trace backend can
  be deleted per subject without an index nobody has.

The last one is the load-bearing assumption. It inverts the usual advice:
redaction is the wrong control, because redaction asks how to find every copy
after the fact, and there is never an answer. What can be controlled is whether
the copy still means anything.

## The invariant set

- **R1 — the edge decides trust.** Ingress strips inbound `baggage` and
  `tracestate` from untrusted sources.
- **R2 — the SDK refuses unknown keys.** A sanitizing propagator injects only
  registered keys and drops everything else on extract; no application code path
  sets an unregistered key.
- **R3 — the schema is executable.** One table of key, value shape, purpose and
  TTL, with a CI check that fails on a key outside it.
- **R4 — a value is a reference or a classification.** Never a field value, and
  never a value that merely _points_ at a person, including a hash of one.
- **R5 — baggage never becomes an attribute.** An exporter filter deletes
  `baggage.*` from spans and log records.

`tracestate` belongs in the strip list beside baggage: it is a free-form
vendor-keyed slot that several vendors populate with tenant or account
identifiers, and it travels exactly as far.

## The reference holder

The instinct to hold the record in one privileged system and propagate a
temporary reference is correct, and turning it into a control takes five
properties:

- **Issue and resolve are separate operations with separate authority.**
  `issue(subject, purpose, ttl) → handle` is called by a service that has already
  authenticated the subject; `resolve(handle, caller, purpose) → fields` is called
  by a service reopening a case, and its field set is a function of the purpose
  rather than of the record. A handle that resolves to the whole record is a
  capability to escalate.
- **The handle is random and vault-mapped, not encrypted PII.** An encrypted
  subject id is a permanent pseudonym under a key that cannot be rotated fast
  enough; a random handle is revoked by deleting a row.
- **Unlinkability is a per-purpose derivation where it is needed.**
  `handle = truncate(HMAC(k_purpose, subject_id))` makes two purposes' handles
  unjoinable without the vault, and revoking one purpose is one key rotation.
- **The mapping expires.** The vault keeps `handle → subject` only for the
  incident window, and the _handle inside the trace_ dies of old age.
- **Every resolution is audited.** Without that, the vault is a PII API with no
  accountability and the expiry buys nothing.

| property                | random + map | HMAC per purpose | encrypted id | signed token |
| ----------------------- | ------------ | ---------------- | ------------ | ------------ |
| unlinkable across uses  | yes          | yes              | no           | no           |
| revocable singly        | yes          | no (key-wide)    | no           | no           |
| verifiable offline      | no           | no               | yes          | yes          |
| needs a lookup          | yes          | yes              | no           | no           |
| expires without storage | no           | no               | no           | yes          |

Random-with-a-map is the default. The signed token is the offline path, and it
is the only column that expires without the vault having to remember anything —
which is what makes it attractive for a field with a hard lifetime.

## The payoff: expiry, not deletion

The reason a TTL'd handle beats redaction is structural rather than procedural.
Telemetry retention is measured in weeks; a handle's lifetime is measured in
days. When the trace is still in the backend and the handle has expired, the
trace contains only dead random strings — so **the trace's retention stops being
a privacy exposure surface**, and the usual argument about scrubbing a backend
becomes an argument about a table with a delete statement.

That reframes erasure: a subject-access or deletion request becomes one delete in
the vault's mapping table. The append-only trace store never has to be touched,
and no index of "which traces mention this person" has to exist, because no trace
ever mentioned them.

The trade is real and must be stated: an expired handle cannot be resolved, so a
case investigated after the TTL has no subject. The TTL is therefore set by the
incident window, not by the retention window, and the vault's audit log records
the resolutions that did happen.

## `sub` is a permanent pseudonym in most deployments

OpenID Connect defines pairwise subject identifiers, and they are opt-in:
`subject_types_supported: [pairwise]` plus a `sector_identifier_uri`. Google,
Microsoft Entra and a default Keycloak configuration are `public`, where `sub` is
stable for the lifetime of the account at that provider — a global identifier for
a person across every relying party. Providers backed by a directory frequently
make it the email or the distinguished name.

The conclusion is not "use pairwise": no deployment controls every provider, and
federation, a customer IdP and a vendor login each decide on their own. The
conclusion is that `sub` must not be the identifier a system propagates:

- One binding table maps `(iss, sub)` to a local surrogate, encrypted at rest,
  access-controlled and audited.
- The surrogate is what appears in traces, logs and metrics; OTel has the
  attribute for it (`enduser.pseudo.id`) and no use for `enduser.id`.
- `sub` appears in no span, no log line, no URL path and no metric label — the
  same sink rules as PII, because it is PII with a stable join key.
- "Forget me" deletes the binding row; the surrogate is orphaned, and every
  reference to the person downstream is a random string that no longer resolves.

Pairwise is still worth enabling wherever the provider offers it: it costs
configuration, it removes one whole class of cross-provider join, and it is never
the plan.

## The identifier and sink matrix

The enforceable artifact is a table, because a table is cheap to review and a diff
that adds a column is a reviewable privacy decision.

| identifier           | baggage | span attr | log field | URL path | DB statement |
| -------------------- | ------- | --------- | --------- | -------- | ------------ |
| IdP `sub`            | never   | never     | never     | never    | never        |
| email, phone, name   | never   | never     | never     | never    | handle only  |
| local surrogate      | yes     | yes       | yes       | avoid    | handle       |
| TTL'd PII handle     | yes     | yes       | yes       | avoid    | yes          |
| template or route id | yes     | yes       | yes       | yes      | yes          |

`avoid` rather than `never` in the URL column is deliberate: a handle in a path
lands in every proxy log on the way, so it belongs in a header or a field, not in
a path segment a CDN will index.

## Enforcement that is not advice

- **Edge strip**, in the ingress configuration rather than in application code.
- **Sanitizing propagator** installed as the only propagation path, so there is no
  API by which application code can set an unregistered key.
- **Schema check in CI**, plus a grep that fails on a literal key in a
  `baggage.set` call.
- **Exporter redaction** for `baggage.*` and for the known attribute names, with the
  same schema file as its source.
- **A canary.** Synthetic PII strings planted in test fixtures, asserted absent
  from the exporter double's output; it catches the regression that the schema
  review cannot see.
- **A header-length assertion** at the edge, which catches "somebody put a JSON
  blob in a value" without having to name it a privacy bug.

## Where the database fits

Statement text and bind parameters are the largest PII surface in most
deployments, and their carrier is a separate problem with a separate trap: d159
owns it, and it reaches the same conclusion — a reference, never the payload.

## Requirements

- **R6 — `sub` never leaves one table.** The binding table is the only place it
  exists.
- **R7 — a handle is purpose-bound.** Resolution returns the fields the purpose
  allows, never the record.
- **R8 — a handle expires.** Its TTL is set by the incident window and is shorter
  than the telemetry retention it appears in.
- **R9 — resolution is audited, per caller and per purpose.**
- **R10 — erasure is one delete.** A deletion request is satisfied by removing
  the mapping row, without touching a telemetry store.

## Open questions

- A telemetry store whose retention is _shorter_ than the handle TTL makes the
  expiry argument vacuous; the pairing is a deployment invariant nothing currently
  checks.
- Who may resolve: an on-call engineer with a case id, an automated rule, both?
  The audit is only as good as the authorization in front of it.
- A provider that rotates `sub` (account recreation, tenant migration) needs a
  re-binding path, and a naive re-binding merges two people.
- The browser as a baggage source is still the untrusted edge; a first-party web
  app that sets baggage deliberately blurs R1.

## Alternatives rejected

- **Redaction at the exporter by pattern.** Reliable for a card number, useless
  for a name, and it leaves the record in every store that received it first.
- **Encrypt the identifier into the baggage value.** A permanent pseudonym under a
  key that rotation cannot reach quickly, with the decryption key in every
  service that can read it.
- **Transport the whole PII record in baggage.** The failure mode this record
  exists to prevent, and it works well enough at low volume to reach production.
- **Keep `sub`, delete on request.** The deletion needs an index of every store
  that ever received it, including the CDN's.
- **Strip baggage entirely.** Correct for an internet-facing ingress, insufficient
  inside a mesh that needs one correlation channel that is not a URL.
- **Rely on backend access control.** One control where six stores hold copies.

## Prior art carried in this record

W3C Baggage and Trace Context (a header designed to propagate, and `tracestate`'s
vendor slot), OpenID Connect Core's subject types and sector identifiers, OTel's
`enduser.pseudo.id`, and the data-vault pattern of one authoritative store with
narrow access paths.
