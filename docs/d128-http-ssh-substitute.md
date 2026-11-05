---
id: d128
type: architecture-design
status: draft
title: "d128 — an HTTP-native ssh substitute: capability API, operation set, carrier ladder, client projections"
parent: architecture
depends-on: [d073, d077]
references: [d108, d117, d136]
tags:
  [
    "http",
    "sftp",
    "files",
    "capability-security",
    "cli",
    "sync",
    "tunnel",
    "tailscale",
    "dpi",
    "agent-tooling",
  ]
---

# d128 — an HTTP-native ssh substitute

## Status

Draft proposal for a product that does not exist yet: no code, no build, and no
spike run against the edge for _this_ design. Its carrier analysis inherits
estige's measured edge evidence (d073's spikes, d077's evidence base) wherever a
row below says **measured**, which is why the record links to them rather than
restating the numbers. The transport section separates **measured**,
**source-derived** and **unverified** claims deliberately: the unverified rows are
the spikes that must run before any wire format is frozen.

Two boundaries keep it honest. It is a **product**, not an estige mode — estige
carries restricted-network egress as a VPN-shaped twin of `ssh`, this carries the
file/tunnel/exec surface as an `ssh`-shaped twin of HTTP — and its contract is
the HTTP API, so no part of it depends on this repo's tooling, spec graph or
skills.

## Context

`ssh`, `scp`, `sftp` and `rsync` are unavailable wherever SSH traffic is blocked
— TCP/22 egress denied, upgrade-stripping proxies, HTTP(S)-only edges. The
product is a server plus clients exposing the operational subset people actually
use SSH for — read, write, list, move, transfer, TCP tunnelling, and running a
declared command with real stdin/stdout/stderr — over ordinary HTTP.

Six facts shape every decision:

- **The CLI is the primary client.** An `rsync`-like sync, an `scp`/`sftp`-like
  transfer, `ssh -L/-D/-R`-like tunnelling and an `ssh host cmd`-like exec are
  the product. Their requirements — ranges, resume, deltas, exit codes, stream
  separation, progress — drive the design.
- **The LLM is one client among several, never the reference client.** Agent
  tooling is a _projection_ of the same API and must not distort it.
- **Authorization is a product feature, not a wrapper.** A grant can be written
  down, reviewed and revoked, and a confused or compromised client is bounded by
  its grant rather than by the server's OS account.
- **The first deployment is behind a Tailscale Funnel edge.** The wire form must
  be chosen against what that edge actually does — measured, not assumed.
- **Traffic must survive hostile paths**, including networks that are stricter
  than Funnel: DPI, TLS-terminating proxies, gateways that buffer, strip
  upgrades, or reject anything but `GET`/`POST`.
- **Nothing is allowed by default.** A new credential reaches no path, runs no
  command, opens no tunnel and listens on no port until an operator writes that
  authority down. Closed-by-default is not a hardening pass applied later; it is
  the schema.

## Relationship to estige

estige is the sibling product, and the reason half this record's edge facts are
already known: it solved "reach the internet from a restricted network" against
the same deployment edge, so its _measured transport findings_ transfer — the
ALPN offer, the `101` upgrade passing the edge proxy, the HTTP/1.1 backend hop
and its h2c gate (d073, d077) — and its camouflage-404 posture (VPN-R34) is the
one this record adopts for `/`.

Its **product** does not transfer. estige sells egress and is shaped like a VPN:
a tunnel plus a policy table. This sells reach and authority over one filesystem
tree and is shaped like `ssh`: an operation set, per-credential grants, byte
pipes. Sharing an edge's behavior is not sharing a design, and the strongest form
of that: an estige mode should not grow a file API to save one binary.

## Decisions

### The API is a resource-oriented HTTP API, not one remote procedure call

Read and write are `GET`/`PUT` with `Range`/`Content-Range`; preconditions via
`ETag`/`If-Match`; metadata and existence via `HEAD`; namespace operations via
`POST /op/<name>` (see the wire-form decision, which explains why namespace
operations are _not_ required to use WebDAV verbs).

Why not one JSON-RPC endpoint: ranges, resumption, conditional writes, `HEAD`
and cacheability come free and are exactly what the CLI clients need; a
single-endpoint RPC discards them and forces each to be reinvented as body
fields. Why not SFTP framing inside HTTP: SSH's file protocol is a session
multiplexer built for one encrypted stream; HTTP already provides multiplexing
and intermediaries, so copying the framing buys nothing while making every proxy
a suspect.

### The wire form is negotiable; the operation semantics are not

This is the load-bearing decision for Funnel and DPI, and it splits the protocol
in two:

- **Semantics (fixed):** the operation set, grants, path authority, preconditions,
  idempotency, error taxonomy, and the meaning of every field.
- **Carrier profile (negotiated per dial):** how those semantics are encoded on
  the wire — which method, which framing, which direction is streamed.

Two profiles, identical semantics:

| profile        | encoding                                                                                                                            | when                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `native`       | real verbs (`PUT`, `DELETE`, `PATCH`, `MOVE`), real headers (`Range`, `ETag`, `If-Match`)                                           | edge passes them         |
| `encapsulated` | one `POST` per operation to a single opaque path, JSON envelope carries verb + path + headers, body follows in the envelope framing | DPI or gateway is strict |

Both profiles are the _same_ protocol; `encapsulated` is a transport encoding,
not a second API. Every capability survives it (ranges, preconditions, resume are
envelope fields), so nothing is lost — accept the round-trip overhead as the
price of reachability. This is the distinction that keeps the earlier rejection
of JSON-RPC honest: the objection was to _discarding_ HTTP's capabilities, not to
bytes in a JSON body.

Rules that follow:

- **Negotiation is in-band.** The first request on a channel proposes the
  profile and the carrier rung in a body field; the server answers in-band. Never
  negotiate through a header, a query parameter or an ALPN hint a middlebox may
  strip or rewrite.
- **Credentials never travel in a URL.** Paths and query strings are logged,
  cached, and — see the Funnel row below — sometimes stripped; auth is a header
  on the native profile and an envelope field on the encapsulated one.
- **No dependency on `CONNECT`, `OPTIONS`, `TRACE`, 1xx responses, trailers,
  `Expect: 100-continue`, client IP, or WebDAV verbs.** Any of these may be
  absent. Where a deployment offers them, they are optimizations.
- **Standard verbs only, and `POST` always works.** `GET`/`HEAD`/`POST` are
  universal; `PUT`/`DELETE`/`PATCH` are nearly universal; `MOVE`/`COPY`/
  `PROPFIND` are the ones to avoid in the required path.
- **The server must also work behind an ordinary HTTPS origin** (nginx, a CDN, a
  corporate gateway), not just Funnel — Funnel is the first deployment, not the
  contract.

### What the deployment edge actually does

**Moved to [d136](d136-edge-limits-and-carrier-ladder.md)** — the per-row
provenance of what a Funnel-class edge really does (no native `CONNECT`, no
RFC 8441, upgrade query strings stripped, h2c gated to gRPC, no PROXY protocol,
capped bandwidth), plus the carrier ladder those rows justify and what each rung
survives. It is the evidence for this record's negotiation rule, not a decision.

### A capability is a grant over (path prefix, operation set, targets, expiry) — never a shell

Shell access collapses every capability into one grant. A primitive surface lets
an operator say "this credential may read `/srv/data`, write into
`/srv/data/inbox`, move within `/srv/data`, and tunnel only to `10.0.4.0/24:443`"
and mean it.

| grant      | operations                                      | default |
| ---------- | ----------------------------------------------- | ------- |
| `inspect`  | stat, ls, grep, find, read                      | absent  |
| `publish`  | write into one directory; no move, no delete    | absent  |
| `edit`     | read, write, edit, mkdir, move within prefix    | absent  |
| `relocate` | move/copy/sync between two named roots          | absent  |
| `tunnel`   | dial TCP targets in a declared set; `-L`, `-D`  | absent  |
| `listen`   | accept inbound TCP, forward to the client; `-R` | absent  |
| `exec`     | run declared commands, with streams             | absent  |

Nothing outside a grant may be reachable — including "just `stat`", which leaks
tree structure.

**Every credential starts empty.** There is no default grant, no implicit root,
no "owner" flag, and no administrator credential that bypasses evaluation: an
operator with full authority is a credential whose grant set happens to be large
and whose actions are logged under its own name. Three consequences worth
stating, because each is where allow-by-default quietly comes back:

- **Grants are per credential, never shared or unioned.** Two credentials do not
  pool authority; a grant on one is invisible to the other.
- **Capability is never implied by other capability.** `edit` does not imply
  `exec`; `tunnel` is not implied by any file grant; `listen` is not implied by
  `tunnel`, because accepting inbound and dialing out are different authorities.
- **Limits are per credential too** — bytes, objects, concurrent streams,
  requests per second — so one leaked token cannot exhaust the server for
  everyone else.

### Nothing is served outside the capability path

The server's entire route table is its capability path. Everything else — `/`,
`/index.html`, `/robots.txt`, `/favicon.ico`, `/api`, `/.env`, `/.git/HEAD`,
`/wp-login.php`, a wrong method on a real path, `OPTIONS *`, `TRACE` — gets the
**same** response: a plain `404`, with no route table, no method list, no version
string, no `Server` header, no redirect and no directory listing.

This is a decision because the edge does no authentication at all: a Funnel-shaped
deployment is a public hostname, and it appears in scanner lists within hours.
Three rules make that noise cost nothing:

- **Refuse before authorizing.** An unknown path never reads a credential, never
  touches disk and never allocates session state — the 404 is synthesized, not
  looked up, so scanning cannot be turned into load.
- **Make refusals indistinguishable.** Unknown path, bad credential, expired
  grant, malformed request and wrong method must render the same bytes in
  comparable time; any difference is an enumeration oracle. The same applies to
  anything the client can induce into a response body.
- **No landing page, not even for authenticated users.** The capability path _is_
  the site; there is nothing to greet, and a public index would only list what an
  observer must not learn.

Boring is the point: a scanner that sees a generic 404 and no banner moves on.

### Core operations are server-side; bytes cross the wire only when the operation requires them

`move`, `copy`, `sync`, tree delete, archive extract and batch operations execute
on the server, under one authorization decision, atomically where the OS allows.
`move` is `rename(2)`. A client transfers content for exactly two reasons: it is
reading content it will show, or it is writing content it produced.

The rule that follows: **results carry references, not payloads.** A listing
returns names, types, sizes, mtimes and content hashes; content is fetched by an
explicit ranged read. Every client gets cheaper — CLI, script or model — and
large trees stay out of an LLM's context without special-casing the LLM.

### The operation set is SFTP's, minus the escape hatches, plus the primitives SFTP lacks

| SFTP operation              | Exposed as              | Caller-visible | Notes                                                                  |
| --------------------------- | ----------------------- | -------------- | ---------------------------------------------------------------------- |
| `stat`/`lstat`, `fstat`     | `stat`                  | yes            | symlink policy explicit per request, never silently followed           |
| `opendir`/`readdir`         | `ls` (paged)            | yes            | paging is mandatory; a flat listing of a large tree attacks the client |
| `open`/`read` (offset, len) | `GET` + `Range`         | yes            | ranges are the primitive behind resume and caller-side truncation      |
| `write` (offset, len)       | `PUT` + `Content-Range` | yes            | atomic: temp → `fsync` → `rename`; preconditions required              |
| `rename`/`posix-rename`     | `move`                  | yes            | replaces upload → download → upload                                    |
| `remove`/`rmdir`            | `remove`                | yes            | recursive delete is its own grant, never implied by depth              |
| `mkdir`                     | `mkdir`                 | yes            |                                                                        |
| `setstat` (chmod/utime)     | internal                | **no**         | a privilege knob with no user story; the server owns modes             |
| `realpath`, `fsync`         | internal                | **no**         | transport detail, not a client decision                                |
| `readlink`                  | `readlink`              | optional       | read-only, still subject to containment resolution                     |
| `symlink`, `hardlink`       | —                       | **no**         | symlink is the canonical prefix escape; hardlink defeats retention     |
| `statvfs`                   | `statfs`                | yes            | clients need free space to plan                                        |
| — extension                 | `copy`, `sync`          | yes            | absent from SFTP; the reason to build this at all                      |
| — extension                 | `hash`                  | yes            | content identity for sync short-circuit and audit                      |
| — extension                 | `archive`/`extract`     | optional       | zip-slip-safe by construction, or deliberately omitted                 |

The client-side half of SFTP — `close`, handle management, `fsync` — disappears.
A stateless service has nothing to close, and every operation states its own
precondition and postcondition. Handle-less operations are also what make rung 3
possible: a windowed exchange has no state to lose.

### Path authority is enforced server-side, after canonicalization, on every operation

Canonicalize, resolve symlinks under the stated policy, re-check containment
_after_ resolution, refuse traversal. Corollaries that are cheap before v1 and
expensive after: the API cannot create symlinks; hardlinks are rejected;
`extract` validates every entry path before writing; `move` may not leave its
grant's reachable set; `copy` inherits the destination grant, not the source's.
None of this belongs in a client — a client-side path check is a nicety, not a
boundary.

### TCP tunnelling is an ssh-shaped byte pipe: any target the credential's ACL names, and none by default

`-L` (local forward), `-D` (SOCKS5 `CONNECT` proxy) and `-R` (remote forward)
multiplex over the carrier as framed byte pipes — SSH's channel model, not a
VPN's route model:

- **The ACL is the only authority.** Whatever the credential's destination set
  names is dialed: loopback, the server's own management ports, link-local
  metadata endpoints, anything. The server does not second-guess it. An operator
  who grants `127.0.0.1:22` or `169.254.169.254:80` means it, and a guard that
  silently refuses "dangerous" targets makes the ACL a lie while buying no
  safety — the same grant can usually reach an equivalent target under another
  name. What the operator gets instead is honesty in the grant document: a
  `tunnel` grant **is network position on that host**, and one covering metadata
  or management addresses is equivalent to handing over the credentials those
  services issue without authentication.
- **The default destination set is empty**, so a fresh credential tunnels
  nowhere; enabling it is a written, reviewed act, per credential.
- **Byte pipe, not route.** No address assignment, no routing table, no DNS
  interception, no packet semantics. The client side is a listener (or a SOCKS
  proxy) that accepts TCP and asks for one stream per accepted connection.
- **Channel model**: one multiplexed carrier; `open` names the target, `data`
  streams both ways, `half-close` and `close` terminate, `error` is per-stream.
  Per-credential caps on concurrent streams and bytes, accounted per stream.
- **Blind relay**: no TLS termination, no protocol sniffing, no rewriting, no
  ALG. The caller's own TLS to the target rides untouched, so `ssh` inside the
  tunnel keeps its host keys, certificates and verification.
- **`listen` is a separate grant from `tunnel`.** `-R` has the server open a
  listening socket and forward to the client. Accepting inbound is a different
  authority from dialing out — it publishes the server's own network position —
  so it stays off even for credentials that may dial.
- **`-R` needs a durable channel**: on rungs 1–2 the client accepts
  server-initiated `open`; on rungs 3–4 it degrades to polling for pending opens
  (acceptable at low rate; refused above a configured threshold rather than
  silently queueing).
- **Refused because the model has no place for them**, not for safety:
  `UDP ASSOCIATE` (v1 carries TCP only), and caller-chosen bind addresses on the
  server (that is `listen`, and it is declared, never requested per call).
- **Observability is the grant's audit, not a debugging aid.** Every stream logs
  target, credential, bytes both ways, duration and outcome — for a byte pipe
  that log is the only record of what the authority was used for.

### Exec carries three real streams; a command registry decides what may run

`ssh host cmd` is the requested workflow, so exec is not a one-shot RPC:

- **Streams**: `stdin`, `stdout`, `stderr` are separate logical streams on the
  carrier, plus a terminator carrying `exit code` and, if it happened, the
  signal. `stderr` is never merged into `stdout` — scripts and `rsync`-class
  tooling depend on the separation, and so does a human reading a build log.
  `stdout` is byte-exact: no line-ending translation, no charset guessing.
- **What may run**: a **command registry** — the operator declares
  `{name, argv, cwd, timeout, max output, allowed exit codes}` and the caller
  names one. Nothing the caller sends reaches a shell parser. `exec --list`
  publishes what is runnable, because a capability you cannot discover is a
  support ticket.
- **No PTY** (see the deferred list): no terminal dimensions, no job control, no
  escape-sequence stream. Programs that require a tty fail loudly rather than
  receive a fake one.
- **Default stdin is closed**, so exec behaves like `cmd </dev/null`. Opening
  stdin is explicit, and interactive stdin requires a duplex carrier — on rungs
  3–4 the client refuses an interactive invocation instead of pretending.
- **Cancellation**: a per-stream `close` sends `SIGTERM`, a second one
  `SIGKILL`, and the exit terminator distinguishes "exited" from "killed by the
  server".

### Out of scope: PTY, Unix domain sockets, X11, Wayland

Each is deliberately excluded, with one escape hatch for all four: **run `ssh`
inside the TCP tunnel.** Unix sockets and `X11`/`Wayland` sockets are
socket-semantics forwarding problems that `ssh -L` already solves (including
`-L` onto a local Unix socket), and PTY is a terminal-semantics problem whose
surface — echo, line discipline, window size, signals, terminal capability
databases — dwarfs this project. Carrying them here would mean reimplementing
`sshd`'s hardest parts to reach parity with a client that is already installed.

The tunnel makes that escape hatch real rather than rhetorical: because the relay
is blind and carries arbitrary TCP, `ssh` inside it behaves exactly as it does
natively, certificates and all. That is also the honest boundary of this
project — it replaces the _transport_, not the terminal.

### Integrity is HTTP's job: preconditions, idempotency, atomicity — not a client lock

There is no cross-request mutation mutex worth having, so read-modify-write is
optimistic: every `PUT`/`move`/`edit` takes `If-Match` (or an explicit version),
and a lost race returns `412` with current state instead of overwriting. Retries
are assumed — the carrier demotes and reconnects — so every mutating operation is
idempotent or carries an idempotency key. Use the OS's atomic rename where it
exists; where it does not (directories, cross-device), document the partial states
and make them resumable. An operation that takes more than one filesystem action
either happens under one server-side transaction or exposes `plan`/`apply`, so a
caller can see the whole change before committing it. A dry-run shape is not
optional for `sync` and recursive `remove`.

### Authentication and failure posture

The Funnel edge is public and does no authentication, so every request
authenticates itself. Two habits: an unknown path, an unknown credential and a
malformed request answer the **same** uniform 404 with no route table, no
method list and no version string; and nothing authenticates by URL (the edge
strips query strings on upgrade requests, and proxies log paths).

### Observability is part of the product

Per-operation records — credential id, grant used, operation, canonical path,
bytes, carrier rung, outcome, correlation id — written by the server,
independent of client cooperation. For the CLI that is `-v`; for an operator it
is the reason to allow the credential at all; for an LLM client it is the review
trail a shell could never provide. The carrier rung belongs in the record: a
deployment silently sitting on rung 3 is a fact its operator needs to see.

### Agent tooling is a projection of the API, and must not change the API

The LLM adapter exposes a subset with names and contracts the model already knows
(`read`, `ls`, `grep`, `find`, `write`, `edit`) plus the primitives that make
composition unnecessary (`move`, `copy`, `stat`, `mkdir`, `remove`), and — only
if granted — `exec` and `tunnel`. Two boundaries:

- **Server semantics stay exact; presentation is the adapter's job.** The API
  answers with exact ranges and complete paged listings — a CLI needs nothing
  less. Line/byte truncation with a "continue with offset" notice, one-line call
  rendering and diff output are _client_ behaviour. Encoding one consumer's
  truncation budget into the protocol would break the CLI and couple the wire
  format to an adapter.
- **The adapter preserves the tool contracts the model's habits come from:**
  `read` paginates by offset/limit over lines and truncates at a documented
  ceiling; `edit` matches an exact string and returns a unified diff; `write` is
  whole-file with a precondition. Those are model-reliability contracts, and the
  API already provides what they need.

### Scripted composition is a client-side convenience bounded by round trips — bulk work belongs on the server

If a sandboxed-JavaScript client is offered (the model writes code calling the
exposed operations; only what the script emits returns), it is an optional
adapter, and its limits define what the API must provide:

| work shape                                                 | where it belongs                    | why                                              |
| ---------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| one namespace op (`move`, `copy`, `stat`)                  | one API call                        | atomic, authorized once, no bytes                |
| decide-then-act on a few entries (`ls` → filter → 3 moves) | script loop over the API            | control flow, small N                            |
| bulk (10⁴+ files, whole trees, large objects)              | server-side `sync`/`copy`/`archive` | one round trip per script call is fatal at scale |
| large content transfer                                     | ranged caller-side transfer         | script values are JSON, not streams              |

Consequences that hold for any client:

- every result is compact, JSON-shaped and **bounded**: references, pages, and
  file content only on an explicit read;
- cancellation is first-class and propagates to in-flight server work per
  operation; a cancelled bulk operation must be resumable, not half-applied;
- errors are typed and actionable (conflict, precondition, denied, not-found,
  rate-limited), because a script branches on them and a model retries them;
- determinism is per operation, not per session: nothing depends on connection
  state, handle state or ordering between concurrent requests.

What scripting must never become: the only way to do bulk work, or a reason to
put an interpreter in the server.

## Consequences

- **The carrier ladder is most of the protocol's complexity.** Four carriers,
  one frame format, automatic downgrade and per-rung tests — more work than the
  file API, and unavoidable given Funnel plus hostile networks.
- **Backend multiplexing is not free money.** Public h2 does not reach the
  backend through a Funnel-shaped edge, so concurrency comes from concurrent
  streaming handlers and the frame layer, not from the transport.
- **No general `ssh host cmd`.** Workflows needing arbitrary composition must be
  declared in the registry. Power users feel this immediately; it is the price of
  the authorization model.
- **`sync`/`copy` are the hard part of the project.** A correct delta sync
  (rolling checksums or content-hash short-circuit) is more engineering than the
  entire HTTP surface; rsync parity is a research project. Ship hash-based
  short-circuit first and grow it.
- **rclone-scale provider breadth is out of scope.** The target is a filesystem
  tree behind a per-server authority boundary; crossing two independent servers
  is its own decision (brokered vs. relayed).
- **Two CLIs, not one:** an interactive one (`sftp`-like, port forwards, exec
  with streams) and a scriptable non-interactive one (`scp`/`rsync`-like: exit
  codes, progress on stderr, `--json` output).
- **Projection drift is a standing risk.** Two projections over one API diverge
  in presentation; the mitigation is that the API is the tested contract and both
  clients stay thin.
- **Every mutation verb needs a prefix-escape review** — `extract`, `copy`
  destinations, `sync` roots, partial resumptions — and every tunnelling path
  needs a destination-set review. That recurring cost argues for a small surface.
- **Bandwidth is capped by the edge and unpublishable**, so progress reporting,
  resumption and honest failure are product features, not polish.
- **Closed-by-default makes onboarding a deliberate step.** A new credential does
  nothing until someone writes grants down: demos get slower, accidental exposure
  gets rarer. That trade is the product's entire point.
- **A `tunnel` grant is network position, and the API says so out loud.** No
  guard rail softens it, so the grant document plus per-stream audit is the only
  thing between a leaked credential and the server's neighbours — which argues
  for short expiry and real logs, not for clever restrictions.

## Alternatives rejected

- **Ship a shell (`bash -c`) and rely on OS permissions.** Grants collapse to
  "the process's account", no per-operation audit, no bounded blast radius, and
  the file API's motivation disappears. Rejected; the command registry is the
  concession.
- **Registry-only tunnelling with no dialer.** Would fail the requirement:
  `-L`/`-D` are about caller-chosen targets. Replaced by policy-gated dialing with
  a closed registry as the default state.
- **`connect(host, port)` with no destination set.** Turns a file credential into
  SSRF-capable egress. Rejected; destination sets and grant separation instead.
- **Rely on WebSocket-over-h2 (RFC 8441).** Not proxied at the edge (the upgrade
  never reaches the backend once the client negotiates h2), and structurally
  pointless here regardless: it is an h2 stream plus a handshake plus a redundant
  framing layer. The WebSocket carrier pins `http/1.1` instead.
- **gRPC as the tunnel carrier.** It works through the edge — gRPC is a supported
  Funnel workload — but its content type is a DPI signature, it depends on
  trailers, and a byte pump gains nothing from protobuf. Kept out; see the
  carrier ladder for the full comparison.
- **Put the credential or route in a WebSocket query string.** The edge strips
  query strings on upgrade requests; and paths/queries are logged everywhere
  else. In-band or header auth only.
- **One JSON-RPC endpoint as _the_ protocol.** Would discard ranges,
  preconditions, resumption and cacheability. Kept only as the `encapsulated`
  profile, where those properties are preserved as explicit fields.
- **Model the wire format on SFTP.** Discards HTTP's properties and makes every
  proxy a suspect. Only SFTP's _operation set_ is kept.
- **Require WebDAV verbs for namespace operations.** `MOVE`/`COPY`/`PROPFIND` are
  the methods middleboxes are most likely to reject. `POST /op/<name>` instead.
- **Publish `sshd` via `funnel --tls-terminated-tcp=` on 443.** A valid
  deployment fallback, but not HTTP: it fails exactly where HTTP-level policy is
  enforced, and it cannot carry the file API. Not this design.
- **PTY, Unix sockets, X11/Wayland forwarding.** Reimplementing `sshd`'s hardest
  surfaces to match a client that is already installed. Deferred to
  `ssh`-inside-the-tunnel.
- **Adopt an existing filesystem-server tool surface as the protocol.** Coarse,
  connection-per-process, weak metadata, no ranges, no preconditions, no `move`.
  Fine as a _client_ of this server; unusable as its shape.
- **Make the LLM tool schema the API contract.** Bakes one consumer's truncation
  and naming habits into the protocol and breaks the CLI. Inverted: API first,
  adapter second.
- **Expose `symlink`/`hardlink` for completeness.** Prefix authority cannot be
  enforced over symlink creation without post-hoc auditing, and hardlinks break
  retention. Omitted.

## Open decisions

- **Spikes before the wire format freezes**: concurrent streaming `POST` through
  the edge (write and read at once, and how long an idle stream survives); `101`
  upgrade with ALPN pinned to `http/1.1`; `PUT`/`DELETE`/`PATCH` acceptance;
  `text/event-stream` behaviour on rung 4; response flush timing.
- **Authentication scheme**: bearer credential per grant vs. mTLS vs. per-request
  signatures; and whether a grant is the token or a server-side policy a token
  references.
- **Server-to-server transfer**: brokered (server A pulls from B under its own
  credential) vs. relayed through the caller without buffering — which determines
  whether `copy` can be authorized on both ends.
- **`sync` scope**: content-hash short-circuit only, or rolling-sum delta; one
  operation or a `plan`/`apply` pair only.
- **Archive support**: `archive`/`extract` first-class (with the traversal
  surface) or omitted in favour of `sync`.
- **Quotas and recursion limits**: per-grant bytes/objects/streams, advisory
  (reported by `statfs`) or enforced.
- **Where the agent adapter lives**: same repo/binary as the CLI clients, or a
  separate package consuming the published API — the latter keeps "one of the
  possible users" structurally honest.
- **Paging cursors**: opaque vs. name-based resume; matters for `sync` over
  mutating trees.
- **Whether `listen`/`-R` ships in v1 or v1.1** — it needs the server to accept
  inbound connections and to degrade to polling on non-duplex carriers.
- **Whether `symlink` becomes an opt-in operation**, and if so whether
  authorization re-resolves the final target against the credential's own prefix
  (the rule that would make it safe against cross-credential laundering) or the
  operation is refused outright.

## Verification status

Nothing implemented for this project; no spike has been run against the edge for
_this_ design. The transport table's provenance is stated per row: **measured**
rows come from estige's deployment spikes on a Funnel edge (ALPN negotiation, the
`101` upgrade passing the edge proxy, ports/names/bandwidth — d073's spikes and
d077's evidence base), **source-derived** rows come from reading the upstream
ingress proxy (`ReverseProxy`, h2c gated to
gRPC content types, h1.1 edge→backend hop), and the upstream issues cited are
third-party reports, not our measurements. The gRPC feasibility claim rests on an
upstream change that special-cases gRPC content types so gRPC services can be
served through the edge (merged upstream in 2023), plus the currently open issues
asking to widen that special case beyond gRPC; gRPC's _full-duplex_ streaming
through the edge specifically was not verified here, and the rejection does not
depend on it. **Unverified** rows are marked as such
and are the spikes listed under open decisions. The agent-client tool contracts
(`read` offset/limit with a documented truncation ceiling, exact-match `edit`
with a unified diff) are taken from `pi-coding-agent`'s tool descriptions as an
input to the adapter decision — not as a dependency of this project.
