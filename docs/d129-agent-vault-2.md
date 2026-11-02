---
id: d129
type: architecture-design
status: draft
title: "d129 — agent-vault-2: a credential-brokering proxy on an honest substrate"
parent: architecture
depends-on: [d126, d127, d077]
references: [d073, d094, d128]
tags: ["agent-vault", "credential-brokering", "mitm", "tls", "proxy", "rewriter", "http2", "grpc", "security", "sandbox"]
---

# d129 — agent-vault-2: a credential-brokering proxy on an honest substrate

## Status

A proposal for a product that does not exist: no code, no build, no spike. What
it inherits is narrower than it looks. [d126](d126-agent-vault-in-the-chain.md)
is a source read of Infisical's agent-vault at `17b2473` — every claim about the
current implementation's behaviour traces to a file there. [d127](d127-proxy-only-container-egress.md)
is documentation- and OCI-runtime-spec-grounded, not measured on an engine.
[d077](d077-ssl-vpn-transport-ladder.md)'s h2c amendment is third-party upstream
evidence, not measured here. Two container facts in this record — that a
loopback-bound broker is invisible to a rootless-bridge workload, and that the
`createContainer` hook survives a hostile in-image `iptables` — are exactly as
strong as d127 says they are and no stronger.

Nothing here has run against a real agent, a real IdP, or a real edge. The
sections that need measurement say so at the point of use.

## Problem

[agent-vault](d126-agent-vault-in-the-chain.md) solves the right problem — the
agent holds a placeholder, the broker holds the secret — with four choices that
each cost more than they look:

- **It terminates TLS unconditionally.** Every deployment therefore has to
  distribute a CA. `vault run` exports six variables for that
  (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`,
  `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `DENO_CERT` —
  `internal/isolation/env.go`), and the ecosystems outside that list (JVM
  `javax.net.ssl.trustStore`, .NET, Elixir, anything reading only
  `SSL_CERT_DIR`, Rust with webpki roots) either fail closed with a confusing
  error or ignore the variable and fall back to system roots, which presents as
  a network fault. Six variables is not a compatibility list; it is a sample.
- **It captures nothing and mints everything.** That is the right instinct
  (*Credentials are minted server-side*) but it is implemented as a partial OAuth
  client, so a target that is only approximately OAuth silently half-works
  (d126's G7 table).
- **Its far leg is opaque.** A failure on the broker→origin hop reaches the agent
  as a generic `502`; the actual cause is five layers down in a vault row.
- **It speaks HTTP/1.1 only** (`NextProtos: []string{"http/1.1"}`,
  `internal/mitm/connect.go`) and rewrites only headers. Bodies, both
  directions, are out of reach — which is why the interesting credential
  brokering (signed requests, tokens carried in payloads) cannot be expressed at
  all.

The product this record describes keeps the brokering contract and replaces all
four.

## What this is not

- **Not an estige mode.** estige carries restricted-network egress; its nodes
  terminate nothing and are never in the trust path (`estige/DESIGN.md`,
  `estige/relaynode.go`). Credential brokering is a different product with a
  different adversary.
- **Not [d128](d128-http-ssh-substitute.md).** That is an HTTP-native `ssh`
  substitute: a capability API over files, exec and byte pipes. It shares the
  carrier ladder and nothing else; a grant is authority to *do*, never a secret
  to *inject*.
- **Not a plugin proxy.** No script host, no Wasm, no user-supplied expression
  language on the hot path. The evidence for that refusal is in *The rewriter is
  a dispatch table*.
- **Not a drop-in replacement.** Dropping the CA changes every client's
  configuration; that is a migration, not an upgrade, and *Consequences* prices
  it.

## Decisions

### The substrate has three interception modes, and only two are allowed

| mode | the agent sees | the broker does | injects | CA needed |
| --- | --- | --- | --- | --- |
| **blind tunnel** | real TLS to the origin | `CONNECT`, copies bytes | no | no |
| **mint** (agent-vault today) | real TLS to the *broker* | terminates, re-originates | yes | **yes** |
| **honest cleartext** | plain `http://` to the broker | absolute-form request, real TLS to the origin | yes | no |

v1 implements **blind tunnel** and **honest cleartext**, and refuses to mint.
The modes are per-target, not per-deployment: a rule either names a target the
broker can rewrite (cleartext) or leaves it to the tunnel. There is no mode in
which the broker holds a certificate for someone else's name.

### No CA anywhere: the broker never mints a certificate

A minting proxy is a CA, whether or not it says so: `MintLeaf` on any SNI
(`internal/ca/provider.go`) is a certificate authority whose only input is the
SNI the client chose. That has three consequences a brokering product should not
accept: the trust anchor has to be planted into every client runtime
individually; origin certificate failures stop being attributable, because the
agent validates the *broker's* leaf and the real `x509` error dies in a log; and
whoever controls the broker can impersonate any origin to anything that trusts
that anchor.

The honest alternative is not "less security" — it is the same security with the
boundary drawn in a place the kernel enforces. Under d127's egress rule the
workload's only reachable destination is the broker
(`ip daddr <broker> tcp dport <broker-port> accept`, everything else dropped), so
the cleartext leg is a private path between two processes in one namespace. The
threat that TLS would address on that leg — a network attacker — has no route in.
What TLS *would* add is a second thing to break.

### Honest cleartext is only honest if the client can be pointed at it

Mode 3 requires the client to speak `http://broker` for a target it would
otherwise address as `https://origin`. That works where the base URL is
configurable — SDK-shaped agents (OpenAI/Anthropic-style clients), `pip
--index-url`, an npm `registry`, most API integrations — and it fails where the
origin is compiled in: `git clone https://…`, `docker pull`, `apt`, any client
with HSTS or a pinned base. Those targets get the blind tunnel and no injection,
which is a real functional loss and must be stated in the product's own terms
rather than discovered per deployment. Which toolchains actually accept an
`http://` base is an open decision below, not an assumption.

### The rewriter is a dispatch table of total functions, never an evaluator

The temptation is a general rewriter — a template language, a Wasm module, a
small VM — because "store and replace credentials in bodies, both directions,
any format" sounds unbounded. It is not; it is *addressing*, and the general
form buys nothing:

- **Auditability.** "Credential X was injected at this offset" has to be
  provable from configuration alone. Arbitrary logic makes the injected value
  unanalyzable — the same failure as d126's bespoke IdP, moved inside the trust
  boundary.
- **Termination.** Catastrophic regex backtracking, body bombs, decompression
  ratios. A rewriter must be total; a language makes totality a research
  problem.
- **Sandbox surface.** Wasm isolates but adds a runtime and a serialization
  boundary, for what is a finite set of field edits.

So a rule is a small, terminating, per-target function: `(request, secret) →
patched request | refuse`. The set of rules is a table keyed by target, and an
unmatched target is a refusal, never a passthrough-with-best-effort.

### Rewrite depth: headers, textual bodies, then the wall at signatures

| depth | what is rewritten | what must be parsed | what a failure looks like |
| --- | --- | --- | --- |
| **headers** | `Authorization`, `X-Api-Key`, cookies | nothing | none — this is agent-vault's whole surface today |
| **textual body** | a declared path in JSON / form / XML | content type + one path | a silent no-op on schema drift, so the rule must match *and* verify |
| **signed body or URL** | JWT bodies, SigV4 headers, S3/GCS presigned URLs | **the signer's canonical input** | not expressible as substitution at all — the credential *is* the signature's subject |
| **framed or binary** | protobuf, capnp, msgpack, gRPC, custom TLV | framing + schema, per target | rewriting at the wrong offset is silent corruption |
| **protocol state** | OAuth2/ROPC/OIDC/session flows | the whole flow | d126's G7 table: refusal, or a silent stop |

The wall is the third row, and it is not a power wall. Nothing in a SigV4 header
can be substituted, because the signature covers the secret; the broker has to
*be the client* for that target — canonicalize, sign, attach. That is a registry
of signers (AWS SigV4, GCS/S3 presign, RFC 7523 JWT bearer, and per-target
HMACs), each a bounded function with its own conformance note. Rows four and
five are explicitly out of scope in v1: a broker that half-parses protobuf is
worse than one that refuses, for the same reason h2 is refused below.

### A rule is a grammar plus a locator, and it fails closed

Concretely, a rule carries: the target (host, port, path prefix); the surface
(header name, JSON pointer, form field, query key); the secret to write there;
the encoding to use; and the verification that the request reached the expected
shape. Anything not covered by a rule is refused, visibly. The design rule that
follows: **no rewrite may depend on state the broker cannot see.** That is what
kills response-derived credentials and multi-step flows invented by the target —
not a philosophical objection, an observability one.

### Responses: detect and fail, never surgically rewrite

Rewriting a response means buffering it, which forfeits streaming, `Content-Length`
fidelity, `ETag`/`Content-MD5` integrity, range semantics, and every proxy
behaviour built on `io.Copy` — the current code streams responses through and
only messages them when a byte cap trips (`response_too_large`,
`internal/mitm/forward.go`). Two concrete traps sit on the same path: nothing
handles `Content-Encoding`, so a compressed *request* body silently escapes
substitution today; and nothing reads `Trailer`, which is where gRPC keeps its
status.

v1 therefore does one thing on the response path: **detect and refuse**. A
content scan over a bounded prefix looks for high-confidence credential shapes
(known prefixes, checksums, entropy thresholds) and fails the response with a
named error when one appears. If redaction is ever needed it must be a
consistent mapping table so a later call can still use the value — and it is an
open decision whether even that is worth the integrity cost.

### h2 and gRPC are carried, never brokered

The current implementation cannot broker h2 and this record does not propose to
fix that: `NextProtos` offers only `http/1.1` (`internal/mitm/connect.go`,
`internal/mitm/websocket.go`), and offering h2 would not be enough anyway. The
`CONNECT`-then-serve shape is one request per hijacked connection through
`http.Server` over a one-shot listener — no multiplexing, no flow control, no
`SETTINGS`/`GOAWAY`, no per-stream lifecycle. gRPC additionally needs trailers,
which the forward path drops, and per-stream frame framing (a 5-byte length
prefix on a stream, not one body).

The edge evidence agrees from the other side: d077's amendment records that the
h2c path is gated on a `application/grpc*` content type, that Connect RPC is not
covered by that sniff (tailscale#18483), and that tailscale#18871 proposes
deleting the sniff entirely. [d128](d128-http-ssh-substitute.md) is designed
around the same conclusion — never needing `CONNECT`, 1xx, trailers or RFC 8441.

Rule: **h2 and gRPC ride the blind tunnel.** They get no injection and no
rewriting, and a rule that targets them is rejected at configuration time rather
than half-executed at request time.

### Credentials are minted server-side, never captured from traffic

The broker may hold a secret, and may hold a *derivable* credential (refresh
token, client credentials, a password grant) that it exchanges itself. It may
not learn a credential by reading a response it proxied. Capturing would make
the broker adopt "whatever JSON the upstream just returned", chosen by a request
the agent controls — a token-poisoning seam with the agent as the author.

That keeps the whole lifecycle server-driven, which is what makes a current
token possible at all: the credential's stored value *is* the live token, so
every rule naming that key follows rotation with no agent involvement (d126
records the mechanism and its traps).

### Conformance is checked, not assumed

The current token client is a strict RFC 6749 client with no conformance gate,
so a target that is only approximately OAuth fails as a `502` or — worse —
silently stops refreshing when `expires_in` is absent (d126's G7 table; the
field is only RECOMMENDED by §5.1, and the code persists a nil expiry that
disables refresh forever). And `token_type` is parsed and then ignored while
injection hardcodes `Bearer` (`internal/broker/broker.go`).

agent-vault-2 inverts the default: **probe before storing.** At credential
creation the broker fetches the discovery document where one exists, records
which `token_endpoint_auth_methods_supported` and grant types the target
actually offers, requires a JSON token response with an explicit `expires_in`,
and refuses to store a credential whose lifecycle it cannot model. A target that
does not fit gets the out-of-band minter path — a sidecar that speaks the target's
protocol and deposits a token with an explicit expiry — so the non-standard part
lives in the one component written for it. ROPC itself is a non-goal: if a
legacy IdP must be supported, it is supported by a `password` grant implemented
deliberately and tested, not by pretending the standard flow covers it.

### Every failure names the leg that failed

The three recurring failures in d126 share one shape: the broker's far leg
becomes an opaque failure domain.

| leg | the failure must say so |
| --- | --- |
| agent → broker | policy refusal, `401` on the token, no rule for this target |
| broker → origin, transport | DNS, refused, timeout, and which of them |
| broker → origin, TLS | the real `x509` error, unattributed to the broker's own certificate |
| origin response | the upstream status and the response's own error identity, verbatim and un-summarised |
| credential lifecycle | which stage failed (discovery, exchange, refresh, inject) and against which endpoint |

That is the property blind tunnelling has for free — the application holds the
TLS session, so the `x509` error is the application's — and the property a
brokering proxy has to earn back deliberately. A generic `502` is a bug, not a
posture.

### The three components are separable

- **Substrate** — the two modes, the `CONNECT`/absolute-form surface, real TLS to
  the origin, per-leg errors, no CA.
- **Rewriter** — the rule table, the signer registry, the refusals.
- **Lifecycle** — probes, minting, refresh, revocation, the placeholder contract.

They are separate on purpose: the substrate is the part a blind tunnel could
implement (estige nearly is it), the rewriter is the part that must stay dumb,
and the lifecycle is the part that must stay server-driven. A deployment can
have a substrate without a rewriter — that is a tunnel — and must never have a
rewriter without one.

### Observability records the rewrite, not just the request

The audit unit is the rewrite: target, rule identity, surface, secret *key* (never
value), outcome, and the leg that refused if it refused. That is what makes
"credential X was injected here" provable afterwards, and it is the reason the
rule table has to be declarative. Attribution is per-agent and per-rule, so
rotation can be surgical (an instance-level token that spans every vault is a
blast-radius decision, per d126).

## Consequences

- **The trust-variable surface collapses.** The workload needs no CA variable at
  all: one base URL (or one `HTTP_PROXY`) instead of six `*_CERT_*` exports plus
  per-runtime exceptions. That is the largest practical win, and it is what makes
  the JVM/.NET/`SSL_CERT_DIR`/webpki gaps disappear rather than get documented.
- **Some traffic cannot be brokered.** Anything with a hardcoded `https://`
  origin, and everything h2/gRPC, falls back to the blind tunnel with no
  injection. The product is "configure your client", not "set `HTTPS_PROXY` and
  forget" — an adoption cost this record accepts in exchange for the CA.
- **Fail-closed is the default and it will be felt.** A target with no rule
  refuses; a target with a signed body needs a signer; a target whose IdP fails
  the probe is rejected at creation. Every one of those is a support ticket and a
  correct outcome.
- **Migration is a re-pointing, not an upgrade.** Existing agent-vault
  deployments are in mint mode by construction. Moving a workload to mode 3
  means changing its base URLs; workloads that cannot be re-pointed stay on the
  old broker until they can.
- **Deployment inherits d127's shape.** Broker and relay as a gateway on the
  workload's `--internal` network, the kernel rule as the egress boundary, the
  three environment scopes. Nothing in this record weakens that rule; the
  cleartext mode *depends* on it.

## Alternatives rejected

- **A Wasm/DSL rewriter.** Buys expressiveness the problem does not need, costs
  auditability, termination and a second runtime on the hot path. Rejected in
  *The rewriter is a dispatch table*.
- **Keep minting, make it convenient.** The CA tax is not a packaging problem;
  it is a trust-root problem. Convenience packaging (a generated bundle, a
  `vault run`-style wrapper) still leaves every uncovered runtime one silent
  fallback away from an unexplainable TLS error.
- **Surgical response rewriting.** Buffering, integrity headers, ranges,
  streaming, and consistency of replacements all break at once. Detect-and-fail
  covers the actual goal — the agent must not receive a secret — at a fraction of
  the surface.
- **Broker h2 by adding ALPN.** Fails on trailers, multiplexing and per-stream
  framing, per *h2 and gRPC are carried*. A real h2 proxy is a different program.
- **Capture the token from the proxied response.** The agent authors the
  request, so it authors the token. Rejected in *Credentials are minted
  server-side*.
- **Fork agent-vault in place.** The substrate change is not additive: no CA,
  different modes, body rewriting, h2 refusal, conformance probes. A fork would
  touch every layer while [d126](d126-agent-vault-in-the-chain.md)'s W-A patch is
  still the fastest way to put the *current* vault behind the chain.

## Open decisions

- **Which toolchains accept an `http://` base.** Must be enumerated before the
  mode-3 contract is frozen: SDK clients (base URL override), `pip`
  (`--index-url`), npm (`registry`), cargo (source replacement, and whether it
  permits plain HTTP), `git` (generally not), container and OS package
  managers. Each "no" is a target that can only be tunnelled.
- **The signer registry's MVP set.** SigV4 and presigned URLs are the load-bearing
  pair; JWT-bearer and per-target HMACs follow. Which one is first depends on
  what real agent traffic hits.
- **Response scanning thresholds.** A repository diff legitimately contains
  high-entropy strings; a DLP pass that fails those responses is unusable. The
  false-positive budget needs measurement against real content before the
  detector ships, or the refusal becomes the outage.
- **Whether redaction can ever be consistent enough.** A mapping table preserves
  later calls; it also creates a second secret store keyed by the first. If it
  cannot be made boring, drop redaction and keep detect-and-fail.
- **The probe's authority.** A discovery document is a claim, not a fact; the
  broker should validate what it is told (a token response with `expires_in`, a
  refresh that actually rotates) rather than trusting metadata alone.

## Verification status

Not verified: nothing in this record has been built or run. Specifically
unmeasured:

- mode 3 against a real coding agent — that its SDK accepts an `http://` base
  for every capability it uses, and what it does when one is unavailable;
- the netns boundary holding in each backend (inherited whole from d127, which is
  itself unmeasured on an engine);
- the signer registry against live AWS/GCS credentials;
- the response detector's false-positive rate on real repository content;
- every *current implementation* claim, which rests on d126's source read of
  agent-vault at `17b2473` — accurate as of that commit, and a moving target.
