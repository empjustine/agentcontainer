---
id: d236
type: module-design
status: active
title: "d236 — estige v5: audit findings and the settled channel decisions"
parent: estige
depends-on: [d104, d131, d132, d133, d169, d171, d185, d211]
references: [d041, d083, d088, d090, d120, d222, d223]
tags: ["estige", "v5", "mtls", "audit", "decisions"]
---

# d236 — estige v5: audit findings and the settled channel decisions

This record closes the d169 audit. It covers the v5 channel, the admission
headers, the key store, carrier placement and container tooling. It does not
design v6 or the mailbox profile. Its reader is the implementer of v5 and the
auditor checking why the earlier draft's wording no longer binds.

## Status

Accepted and implemented in `estige/`. d169 stays as the original proposal, and
this record wins where the two disagree. **d239 amends two things here**: the
windowed-carrier handshake rule binds `h2-post-windowed` only, because
`h1.1-post-windowed` cannot complete a handshake behind an upgrade-stripping
gateway and therefore retires; and the container open details below are
resolved.

## Audit findings

| class        | finding                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| missing      | The certificate had no home in d132's strict `{name, public}` SPKI helper. The channel key, the generation signal, re-mint propagation and the adapter contract were undefined.            |
| ambiguous    | One exit admits many relays while the draft said `ClientCAs` held one cert. Post-admission refusal, mode E headers and the degraded-mode guard sat on two layers without an ordering rule. |
| over-defined | Exact patch-level toolchain facts, the Mozilla trust horizon, cipher defaults and line-count estimates were stated as decisions. They are library behaviour or accounting.                 |

The audit also found one factual trap: a fresh self-signed certificate from
the same Ed25519 key, with a new serial and validity, does not verify against
the old pinned certificate under Go's verifier. Re-mint is a pin change.

## Iterations

- The store's `public` row stays the certificate's material. The certificate
  arrives in its own `e-pub` header instead of being packed into the envelope,
  because reverse proxies cap header sizes and a truncated blob would deny
  service to everyone.
- Role-scoped private keys collapse into one host key at
  `prv/<principal>.der`. The private half never leaves its host.
- Mixed-generation handling disappears. v4's implementation is skipped, older
  generations fail closed, and a minimal blind token is folded into v5.
- The principal SAN becomes the neutral `estige` SAN with an empty subject.
  The name is a filter; the pinned certificate carries the identity.
- The CA chain and ephemeral leaf stay rejected. The apparent multi-root case
  is a set of independent self-signed pins, not a hierarchy.
- `seen_hosts` becomes a structured log event, not a file. A queue on disk
  would need rotation and would collect untrusted noise.
- TLS itself supplies no keepalive. Inner liveness needs tunnel frames written
  through the TLS connection.
- The Node image builder retires. Go `build.go` and `run.go` commands own the
  container path.

## Decisions

### Generation and admission

v5 is the only generation in this implementation. A v3 bearer or any earlier
wire shape fails closed. No fallback, demotion or downgrade path exists.

Admission is a blind proof exchange in both directions. The four-segment
`v2.<name>.<nonce>.<sig>` token and the signed messages
`estige/v2/relay-to-exit` and `estige/v2/exit-to-relay` keep their bytes. The
headers are direction-specific — `e-relay-auth` on a request, `e-exit-auth` on
a response — and an auth failure answers the camouflage 404.

### Store and key material

The store root is `$XDG_DATA_HOME/estige`, with the XDG default
`~/.local/share/estige` when the variable is unset. The process's home decides
which store it reads, so service and user modes own separate stores. A
container sets `XDG_DATA_HOME=/var/lib/estige/.local/share/` and bind-mounts
`/var/lib/estige` from a host-managed path.

One merged host certificate belongs at `prv/<principal>.der`. The role
directories in d132 retire. The private key stays on the host that generated
it; only the public certificate crosses the wire.

### Certificate shape

Each certificate is self-signed over an Ed25519 key, with an empty subject and
one DNS SAN equal to `estige`. No IP, email or URI SAN exists. An empty subject
also gives an empty issuer for the self-signed mint. Other name fields must be
absent; a field that is mandatory and not a date uses `estige`.

`NotBefore` is 24 hours before mint and `NotAfter` is at most 15 years after
it. Both EKUs, `ServerAuth` and `ClientAuth`, are present. The certificate is
not a CA and carries no `KeyUsageCertSign`. System roots never enter either
pool, and no chain or leaf is issued.

The client verifies with `RootCAs` holding its paired exit's certificate and
`ServerName` set to `estige`. The exit verifies with `ClientCAs` holding one
self-signed certificate per admitted relay. Verification is the standard
library's, with TLS 1.3, disabled tickets, no skip and no callback.

### Headers and refusal

The proof pair is direction-specific: a request carries `e-relay-auth`, a
response carries `e-exit-auth`, and each is the `v2.<name>.<nonce>.<sig>`
envelope d131 pins. One header per direction means the header set alone says
which half an exchange holds; the signed label still binds the direction, so a
proof cannot be reflected. `e-pub` carries the sender's whole self-signed
certificate as unpadded base64url DER, and each request and each response
carries exactly one of it. Zero values, two or more values, bad encoding, bad
certificate shape, wrong SAN, non-empty subject, non-Ed25519 key, CA marking,
bad validity or a bad self-signature all answer the camouflage 404 with no log
line.

Every admission-bearing response also carries `Vary: *` and
`Cache-Control: no-cache, private`: the proof is bound to one exchange, so an
intermediary must never reuse or store the response for another request. The
camouflage 404 stays byte-identical and gains nothing (VPN-R34).

A valid `e-pub` that is not in the local trust set also fails the connection.
It emits the `seen_hosts` event once per distinct peer per one-minute window,
whether the trusted set is empty or not, and the dedupe table is swept at its
cap — so an unauthenticated Funnel peer cannot turn a mandated hint into a
warning amplifier by minting a fresh certificate per request. That event is a
hint for an operator; it never grants trust.

The two refusals are not symmetric, and only one is terminal. The relay's own
check of the exit's proof stops the dial at the rung it failed on. The exit's
refusal of the relay's proof is the camouflage 404 — indistinguishable from a
dead carrier (VPN-R34) — so the relay demotes and fails closed at the last
rung rather than guessing.

### Trust events

`seen_hosts` is a log category, not a file. The event carries `ts`,
`severityNumber`, `msg`, a `role` tag and one nested `entry` shaped like the
trusted helper element. A relay entry includes the endpoint. An exit entry
carries only the name and public material. The nested shape stays for now; a
flat pipeline may force a flattened spelling later, which is a new decision.

Pinning is the only trust decision. Expired or out-of-window certificates deny
the session, and recovery is rotation or a re-provisioned pin. No PKI
propagation, chain or trust-on-first-use accept path exists. d171's TOFU
rejection stands for acceptance; the log event is not TOFU.

### Channel placement and liveness

The blind token runs at the outer HTTP layer. The inner TLS handshake follows
admission. Every proxied byte rides the inner session, with no payload class
and no passthrough.

`h2-post-windowed` interrupts sessions in a lossy and unpredictable way, so
each window carries its own proof and its own TLS handshake and no TLS session
spans windows. The non-windowed carriers run one handshake per admitted
session. `h1.1-post-windowed` cannot honour that rule — a gateway that buffers
the request body will not deliver the server's flight before the body ends —
and d239 retires it rather than serve it unprotected.

TLS is silent when idle. An inner keepalive writes `framePing` through the
`tls.Conn` and answers with `framePong` through it. The raw-stream keepalive
covers the period before the handshake. The TLS alert path promotes errors to
`protocolViolation()` and closes the stream; body carriers treat the hook as
a no-op, so the close is what tears the channel down.

The `net.Conn` adapter returns `0.0.0.0:0` from both address methods. The
tunnel is an implementation detail and no address reaches an outside reader.
`SetWriteDeadline` is a no-op because each carrier already bounds writes.

### Carrier vocabulary

The letter modes are historical markers, not names. Documentation and code
use `h2-post-unbounded`, `websocket` and `h2-post-windowed` from
`estige/vocabulary.go`. `h1.1-post-windowed` retired with d239.

### Container tooling

The Node `estige-image` target and the multi-stage `Containerfile` retire.
`estige/build.go` builds the image after the operator has run `go build .`; it
packages that binary into `debian:trixie-slim` with `busybox-static` and
`ca-certificates`. `estige/run.go` only runs an existing image, with host
networking, no restart policy and argv forwarded. Each Go command is a
standalone file because `go run <file>` compiles that file alone.

### Launcher details (resolved)

The four local choices this record left open are settled in `estige/build.go`
and `estige/run.go`:

- **User and mount ownership**: the image runs as uid/gid 65532 and owns only
  `/var/lib/estige/.local/share`; the store is a bind mount, so the host's
  ownership and mode 0700 survive (`XDG_DATA_HOME` points into it).
- **Container tool**: `podman` when present, else `docker`; both are invoked
  with the same explicit `build` subcommand and the same argument order.
- **Image tag**: `localhost/estige:<packaging/VERSION>`, overridable with
  `IMAGE_TAG`.
- **How env reaches the container**: `--env-file $ESTIGE_ENV_FILE` when set,
  otherwise explicit `-e` names for the non-secret knobs (`PORT`,
  `PORT_CLOUDFLARE`, `VPN_CLIENT_LABEL`). No credential has an env spelling to
  forward, and `XDG_DATA_HOME` is never forwarded: the image pins it to the
  directory the store is mounted at, so the host's value would point the
  container at a path it cannot see.

## Amendment map

- **A staged pair shares one policy.** Two `exit.json` rows under one name are
  a key rotation, so `loadExitStore` refuses a pair whose `egress` tables
  differ (compared by meaning, not spelling): admission trusts both
  certificates, while a session runs under one table, so differing rows would
  let row order decide policy.
- **d239** amends the windowed-carrier handshake rule (it binds
  `h2-post-windowed` only) and records the `h1.1-post-windowed` retirement; it
  also carries the fail-closed ladder that follows from it.
- d169 loses its marker, mixed-pairing, principal-SAN and letter-mode wording
  to this record.
- d132 retires the role directories in favour of the merged host key.
- d171 gains the log-only `seen_hosts` amendment; its TOFU refusal stands.
- d185's stable-principal SAN finding no longer names the v5 wire name.
- d211 shares the neutral `estige` wire name with v5.
- d120 loses the "packages only" claim; container deployment is supported.
- d132's store grammar is what ships: `relay.json` carries the dial endpoint
  at top level, `exit.json` carries `egress` beside the admitted relays, and a
  relay row may carry its own `egress`; every `public` value is the
  certificate's DER (this record's "Store and key material").
- d083 keeps the per-unit build entry; its image target moves from Node to Go.

## Verification

The pinned Go toolchain resolved to 1.27.4. Checks behind this record:
`./node-run.sh docs/spec-check.mjs` clean; `go test ./...` green in `estige/`;
a self-signed non-CA certificate verifies against a one-certificate pool; a
pool of several self-signed pins verifies any member; an empty subject with
one DNS SAN verifies with `ServerName=estige`; a CN-only certificate fails;
zero-valued times encode as year 1; and a same-key re-mint does not verify
against the old pin. Go's `crypto/tls` has no heartbeat.

## Alternatives rejected

- **A marker header for v5 generation detection.** Mixed pairings do not exist
  when v4 is skipped.
- **Certificate bytes inside the auth envelope.** A truncated header denies
  service; the separate `e-pub` value keeps the envelope's pinned grammar.
- **One header for both directions (`e-auth`).** A single name made the reader
  decode the direction from the payload; `e-relay-auth`/`e-exit-auth` say it on
  the wire and an auditor sees which half an exchange carries.
- **A persistent `seen_hosts` file.** Log-only events need no rotation and
  cannot accept a peer by accident.
- **Principal names in SAN or subject.** The identity is the pinned key; the
  name is a fixed filter and carries no principal information.
- **CA roots, intermediate certs and boot-time leaves.** No delegation exists
  in a two-party pairing, and the boot process already holds the durable key.
- **Node image builder and scratch image.** The unit's container tooling is
  Go, and the base image is a current Debian slim with glibc and busybox.
