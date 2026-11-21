---
id: d223
type: architecture-design
status: draft
title: "d223 — the mailbox profile: NNCP packets over an object store, and why it is not a tunnel generation"
parent: architecture
depends-on: [d113, d131, d187, d188]
references: [d073, d075, d104, d105, d121, d169, d211, d222]
tags: ["estige", "nncp", "store-and-forward", "mailbox", "object-storage", "oci", "batch", "llm"]
---

# d223 — the mailbox profile

A store-and-forward profile for LLM traffic was researched as a possible "v7" of
the tunnel family: the relay submits a job to a store, an exit claims it, runs it
and publishes the result, with no live session between them. The research found
the shape is a **job mailbox, not a transport** — it has no session, no ALPN, no
frames, and it does not compose with v4–v6 — and that the mailbox should carry
**NNCP packets over an object store** rather than a protocol of its own. Its
reader is whoever picks the LLM batch profile up; the finding is that the
smallest correct design is an adapter plus a shim, and that a new wire format
would be a weaker rediscovery of NNCP's.

## Status

Draft — research recorded, nothing implemented, no spike run. The record was
written after the fact from the research session of 2026-11-21; see the
[recovery status](#recovery-status) for what those statements rest on and what
was not re-checked.

## What was asked

Five questions, in order:

- Whether a **v7** could store-and-forward LLM traffic through a git repository
  instead of carrying HTTP, given that interactive traffic could never use it.
- Whether **OCI Object Storage** is a better staging zone for those intermediate
  states.
- How badly the proposal **copies NNCP** (node-to-node copy), whose mirror sits
  in the reference farm.
- Whether NNCP `exec` messages are **contained and authenticated** — whether a
  party able to write the store could issue or forge execs.
- Whether the output could **trickle** like a streaming LLM endpoint, or whether
  that needs a genuinely online capability.

## The finding: a mailbox, not a transport

The relay becomes a **submitter**, the exit a **worker**, and the store the
rendezvous: submit → claim → execute → publish. Neither node listens; both reach
out. That is the one genuine gain — it survives a network that permits nothing
but an HTTPS egress — and it is a transport gap, not an architecture gap.

What it cannot be is a byte pipe:

- **Latency floor of two store round-trips.** Any client that waits on the
  mailbox waits seconds to tens of seconds; a relay that blocks its local proxy
  on a round-trip breaks every client timeout and stream expectation.
- **Batch only.** Batch completions, evals, embeddings, long local sweeps fit.
  Interactive SSE chat does not, and a batch-shaped submit/poll API is the shape
  a harness can actually consume.
- **Not a ladder rung.** d187's law says a future transport joins the ladder and
  its ranking; this one has no session to rank, so d187 and d188 need an
  amendment, and the profile is an orthogonal axis to the v1–v6 family (whose
  members differ in credential and channel shape over a live pipe, d169, d211).
  Calling it v7 is admissible only with that non-composition stated.

## The trust reversal

Today the relay never sees provider keys and the exit relays an opaque payload
(d073's table, VPN-R40 in d188). A mailbox removes the live client→provider TLS,
so the provider request — its `Authorization` header included — must travel
inside the envelope for the worker to dial the provider at all. **The exit
becomes a trusted gateway holding provider credentials**, and envelope encryption
protects the payload from the store, not from the exit. That is a requirement
reversal to record explicitly, not a detail to discover at implementation time.

## What replaces mTLS

mTLS authenticates a TLS session between two endpoints; in a mailbox the store
sits between them and each side's TLS terminates at the store's host. A client
certificate then proves "this pusher may write this repository" to the host, with
no freshness, no anti-replay and no confidentiality from that host. The
per-message primitives d131 and d169 already reach for carry the load instead, all
from the standard library:

- **Provenance** — an Ed25519 signature per envelope from a pinned public key.
- **Confidentiality** — X25519 (ephemeral to the recipient's static key) → HKDF →
  ChaCha20-Poly1305; the store sees ciphertext, ids, sizes and timing only.
- **Freshness and anti-replay** — a unique job id, a per-direction sequence, a
  not-before and an expiry, and a bounded seen-set; results bind to the request
  id.
- **Git-hop TLS, and optionally a client certificate to a self-hosted forge** —
  hop hygiene, not endpoint authentication.

Certificates-as-keys still work (d169, d211): the wrapper survives, the handshake
does not.

## The store: OCI Object Storage over git

Oracle's own documentation (read in that session through the docs MCP) supplies
four properties a mailbox needs and git cannot give:

| property           | as documented                                                                                                                                                                            | what it buys                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| consistency        | "Object Storage always serves the most recent copy of the data that was written"                                                                                                         | a claim protocol that needs no defence against list lag                                     |
| conditional writes | `PutObject` takes `if-match` and `if-none-match` (whose only valid value is `*`) — native API headers, not the S3-compatibility subset (that shim carries Put/Get/Head/Delete/multipart) | create-if-absent for a claim, and the claim ETag as the fence for a result write            |
| lifecycle          | `DELETE`/`ARCHIVE` rules on current or previous object versions, plus versioning and retention rules                                                                                     | a finished job is actually dropped on a schedule instead of living in packfiles and reflogs |
| events             | create/update/delete events delivered to Notifications, Streaming or Functions                                                                                                           | a worker long-polls a stream instead of a list                                              |

The rest of the surface that matters: 10 TiB per object, 50 GiB per part, 10 000
parts, 4 KiB metadata, multipart recommended above 100 MiB (which covers every
LLM request or response worth staging), pre-authenticated requests scoped to an
object or prefix with an expiry, a Service Gateway path from a private VCN subnet,
and Always Free eligibility (the exact allowance belongs to the current Free Tier
page, not to memory). Two cautions: a PAR is a bearer URL that lands in access
logs, so a write PAR must never sit inside the object it protects; and a relay
outside OCI needs a user principal or customer secret key in d104's store, never
in the environment.

Laid out as the mailbox, the layout is four prefixes and one rule each:

- `jobs/<id>/request` — immutable, written with `If-None-Match: *` so a retried
  submit is idempotent.
- `claims/<id>` — written with `If-None-Match: *`; the body carries owner, lease
  epoch and expiry, and **the object's ETag is the fencing token**.
- `results/<id>/<seq>` — written with `If-Match: <claim ETag>`, so a worker whose
  lease was replaced fails the write instead of publishing.
- `acks/<id>` — the submitter's receipt; a lifecycle rule deletes the first three
  after N days, and versioning keeps what was overwritten.

Git as the same mailbox is possible and poorer on every axis: a branch per job
(never one shared queue branch, for append contention), a claim by
`git push --force-with-lease` against an absent ref, `git ls-remote` to discover
and a shallow `git fetch` to read, one commit per result chunk, and hosted limits
that force chunking (100 MiB per file, a push capped around 2 GiB, a repository
around 5 GB). Deleting refs does not delete objects, so ciphertext and metadata
persist in reflogs and packs. Git is not a queue: visibility timeout, nack,
priority and fencing are all custom code with custom failure modes. Invoking it
means shelling out under d075/d121's scrub (`GIT_TERMINAL_PROMPT=0`,
`GIT_ASKPASS`, `GIT_CONFIG_NOSYSTEM`, scratch `HOME`, a deadline) and no Go git
library, per the vetted-dependency rule.

The honest ordering: **if OCI is reachable, use OCI; git is the fallback for a
network where the forge is the only permitted egress, and it is a poor one.**

## NNCP: the proposal was a re-derivation

The farm's mirror is `~/Downloads/references/salsa.debian.org/go-team/packages/nncp.git`
(upstream 8.12.1; `src/pkt.go`, `src/sp.go`, `src/tx.go`, `src/toss.go`,
`src/via.go` and the `doc/` set, including `comparison.texi`). Against it, the
proposed mailbox is NNCP's _model_ with the parts that make it work removed:

| the proposal               | NNCP                                                                                                                                                    | delta                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| signed and sealed envelope | X25519 exchange key, Ed25519 header signature, 128 KiB ChaCha20-Poly1305 blocks, BLAKE3 header, separate size-block and payload keys, IPAD/OPAD padding | the proposal leaks payload size and path length unless it pads, and has no resumable block framing       |
| job id, result chunks      | MTH (BLAKE3) content-addressed packet names; `chunked` with `.nncp.meta` and per-chunk hashes; `nncp-reass`                                             | commits are chunks by convention, not a reassembly manifest with checksums                               |
| branch per job, CAS claim  | `tx`/`rx`/`tmp` spool, `tx.lock`/`rx.lock`/`toss.lock`, atomic renames, `.part` and `.nock` states                                                      | one node per spool needs no lease; a _shared_ store with concurrent workers is the genuinely new problem |
| ack object                 | ACK packet type, `nncp-ack`, `-gen-ack`, `tx/ack/`                                                                                                      | the proposal has no receipt vocabulary                                                                   |
| seen/idempotency           | opt-in `seen/`, duplicate hashes, `nncp-check`                                                                                                          | subset                                                                                                   |
| retention                  | `nncp-rm` by node, type or age                                                                                                                          | git keeps history forever; OCI lifecycle is the real answer                                              |
| polling                    | `nncp-caller` cron expressions, `nncp-call`, `nncp-daemon`, `nncp-xfer`, `nncp-bundle`                                                                  | subset                                                                                                   |
| —                          | PATH/transition packets, `via` routing, onion encryption                                                                                                | absent                                                                                                   |
| —                          | niceness 1–255 with FLASH/PRIORITY/NORMAL/BULK aliases                                                                                                  | absent                                                                                                   |
| —                          | multicast areas with nested encryption                                                                                                                  | absent                                                                                                   |
| —                          | resumable online transfer over Noise, ping and deadline handling                                                                                        | absent                                                                                                   |
| —                          | bundle as a pax stream `NNCP/RECIPIENT/SENDER/PACKET` for tapes and append-only media                                                                   | git could carry that stream; the proposal re-invents a worse log                                         |
| —                          | `nncp-stat`, `nncp-rm`, `nncp-check`, `nncp-pkt`, `nncp-log`                                                                                            | absent                                                                                                   |
| —                          | `nncp-exec`: allow-listed handle, argv plus stdin, `NNCP_SELF/SENDER/NICE`, optional notification reply                                                 | the proposal misses the right answer to the provider-key problem                                         |

The last row decides the design. In any store-and-forward LLM gateway the exit
necessarily holds the provider credential; the only question is where it comes
from. The envelope proposal carried the provider request — keys included — in the
job. `exec` carries `handle + argv + stdin` while the exit's own configuration
maps the handle to a local executable: the gateway reads its credential from the
exit's own store, and no packet, job blob, repository history or second relay
ever holds a provider key.

The single property NNCP lacks is the **hosted rendezvous with no inbound port**
(its online mode needs TCP reachability; its offline modes need a shared
directory or a sequential medium). That gap is what an object store fills.

## The adapter that closes it

Build an **exchange transport for NNCP packets**, not a replacement protocol:

- **Producer** — `nncp-bundle -tx NODE` (a pax stream, one object) or one object
  per encrypted packet at `tx/<recipient>/<sender>/<hash>`, each `PUT` with
  `If-None-Match: *`. Content-addressed names make a duplicate push harmless.
- **Consumer** — fetch the object or prefix, verify hashes, `nncp-bundle -rx
  -check` (or drop the packets into the spool), then `nncp-toss`.
- **Leases only where the store is shared** — the claim object above, with the
  ETag fence; lifecycle for cleanup and events for wake-up. NNCP's own
  single-tosser lock model does not apply to a shared store, and this is the one
  piece of genuinely new code.
- **The LLM batch API is a shim** over `nncp-exec` (submit), `nncp-freq` or a
  `file` packet (result) and the notification reply — no new wire format.
- **Acks, `seen/`, niceness, chunking, routing and padding survive untouched**,
  and the store only ever sees ciphertext.

Licensing and dependency: estige is AGPL-3.0 and NNCP is GPL-3.0, so a subprocess
relationship is unambiguous and vendoring would be the permitted direction.
NNCP is a single-maintainer project with its own dependency set (`x/crypto`,
XDR, Hjson, zstd, BLAKE3, Noise) — a vetted-dependency decision to record, and a
smaller liability than a reimplementation.

## `exec`: authenticated, contained at command selection

Read from the mirror, the packet layer does most of what was asked:

- `PktEncWrite` signs the header with the sender's Ed25519 key and generates a
  fresh X25519 exchange key per packet; the AEAD's associated data is
  `BLAKE3(TBS)` over magic, niceness, sender, recipient and the ephemeral key, so
  an edited header breaks decryption as well as the signature.
- `PktEncRead` rejects a foreign recipient, an unknown sender and a bad
  signature; `toss` re-checks the neighbour map, and the import tools check the
  recipient and the sender before importing.

So a party with write access to the store **cannot** forge a packet (it lacks
both keys), retarget a sender, recipient, handle or arguments, insert an exec
from an unconfigured node, turn a `file` packet into an `exec` (the type is
inside the authenticated plaintext), or forge an ACK. What it **can** do is
observe ciphertext size and timing, drop, delay, replay, and fill the spool.

Containment is real but narrower than "the input is safe":

- **The allow-list is per sender** (`NodeJSON.Exec`, read as `sender.Exec[handle]`),
  so a compromised relay reaches only the handles configured for its node id.
- **There is no shell** — the path is NUL-split into argv — but argv comes from
  the authenticated peer, so a handle configured as `/bin/sh -c` is arbitrary
  execution by design.
- **Argv is tiny** (`Path` is capped at 255 bytes), so a job body goes on stdin.
- **There is no sandbox**: the same UID as the tosser, the inherited working
  directory and environment (plus `NNCP_SELF/SENDER/NICE`), no input or output
  bound — `-maxsize` is a sender-side flag. A compromised sender key can ship a
  zstd bomb, and `CombinedOutput()` buffers stdout in memory.
- **A non-zero exit retries forever**: the failure path returns before the
  seen-file write and the spool removal, so the packet is executed again on every
  toss — a cost bug and a replay generator against a billed endpoint.
- **No freshness**: the header carries no timestamp and the packet no nonce, so a
  store can hold a genuine exec and deliver it a year later.

The handler contract follows, and it is the operator's work, not NNCP's: read
stdin under a hard byte cap; require a unique `job_id` and reject duplicates,
stale and expired ids (NNCP cannot); keep one narrow executable per job type;
write the result to the store and print only a status; **exit 0 always** and
encode failure in the result; run as a dedicated user with a scrubbed
environment and let systemd or runit supply the limits NNCP does not. Import
through `nncp-xfer` or `nncp-bundle -rx` (never by writing `rx` directly, which
skips the `seen/` check), keep the seen files for the whole replay window, run
staging nodes with `nncp-toss -noexec` and their own spool, and `nncp-rm`
unknown-handle or malformed packets instead of letting them retry.

## Streaming is a different workload

NNCP is packet-granular by construction: `SIZE` and `HASH` are fixed before a
packet can be offered (`INFO`, `FILE` carrying hash and offset, `DONE` carrying
the hash), `nncp-file` writes the complete packet before it is advertised, and
the packet-type set has no stream member — the online mode is a spool
synchronisation over Noise, closer to rsync at file granularity than to a socket.

A trickle is therefore **chunk packets plus a poll**: the handler emits one result
packet per chunk and the relay's SSE adapter flushes each imported chunk.

| granularity          | packets for a 60 s / 1 000-token completion | overhead                                            |
| -------------------- | ------------------------------------------- | --------------------------------------------------- |
| 1 s chunks           | ~60                                         | one header, signature, AEAD tags and padding — fine |
| 100 ms chunks        | ~600                                        | process and packet overhead starts to dominate      |
| per token (20–100/s) | 1 200–6 000                                 | a signed, hashed, padded packet per token — absurd  |

The latency floor is production plus store write plus poll or import plus verify
plus flush: about a second on OCI with a short poll or Streaming, and a commit per
chunk on git, which is brutal. Ordering is not free either — a sequence in the
object name, a completion marker and gap handling are all the adapter's, since
`seen/` gives idempotency and not order.

The split that follows is per workload, and it is the reason this record is not a
transport generation:

- **Batch or async** — evals, long completions collected at the end, jobs that
  cross a disconnected window: the mailbox, with NNCP packets, no stream.
- **Interactive** — chat, SSE, tool-call loops: the tunnel, because token-level
  delivery needs a live bidirectional flow with backpressure (v3's `CONNECT` and
  SOCKS relay today, v5's inner TLS at an untrusted edge per d169, the carrier
  family as d222 shapes it per edge).
- **In between** — a long job with visible progress: chunked results at about a
  second, or dispatch by mailbox plus a streaming side channel for the deltas.
  Implemented and named as chunked results, so the latency and ordering contract
  stays honest.

## Requirement deltas against d188

- **Drop or replace** — VPN-R11 (the transport is the ladder), d188's frame,
  session, handshake and backpressure requirements (R15–R19), the loopback proxy
  and cert requirements (R23–R25), the edge trust-anchor requirements (R28–R30)
  and the bearer and camouflage requirements (R31–R34).
- **Keep** — R20–R22 (the exit resolves, pins and rejects IP literals), R35–R38
  (egress policy, still the boundary), R19 (metadata-only logs), R26 (fail
  closed: no result by the deadline is a failure, never a direct fallback), R27
  (status), R32 and R33 (key store, no secrets in logs).
- **New** — the job envelope, the batch API contract, poll and backoff, lease
  expiry, the dead-letter path, and a size and retention policy.
- **Reusable from estige** — `egress.go`, `keygen.go`/`keyset.go` with X25519
  added, `logging.go`, `status.go`, the drain path. **Not reusable** —
  `relay.go`, `tunnelproto.go`, the `modec`/`modee`/`h2windowed` carriers, the
  WebSocket carrier and the relay ladder.
- **Runtime** — `git` on both nodes plus HTTPS egress to the forge, in the git
  variant; an OCI tenancy, bucket and principal in the object-store variant.

## Alternatives rejected

- **A new envelope protocol over git or OCI.** Rejected: it is NNCP's surface,
  weaker on every row above, and NNCP already ships it.
- **Git for payloads only (LFS or object store beside a git control log).**
  Rejected: two retention policies, two failure domains, and the latency is
  unchanged.
- **Git as control plane with payloads over the existing tunnel.** Smaller than
  the mailbox and it dodges the key reversal — but it needs a live channel, which
  was the premise the mailbox existed to remove.
- **Keep the tunnel and add a batch endpoint at the gateway.** The right answer
  when both ends can reach an endpoint, and it needs no new transport at all; the
  mailbox earns its keep only where one end cannot be reached.
- **A stream frame inside NNCP's Noise session.** Rejected: it is a protocol
  change that discards the property that every object is complete and
  content-addressed, and it stops being store-and-forward the moment the peer
  must be online.

## Where the code would live

Two shapes fit d113's copy-unit rule, and the choice waits on the spike:

- **A new unit folder** (a mailbox unit beside `estige/`) — the spool side, the
  adapter and the shim are its own code, with its own pruned `lib/` copy and its
  own tests, and estige is untouched. The exit's gateway then depends on two
  units instead of one.
- **An `estige mailbox` mode** — the adapter inherits `egress.go`, the key store,
  logging and the status surface, at the cost of a third deployment shape in a
  module whose four carriers already share one binary.

The carrier vocabulary is not a carrier here: d105's rule names mechanisms rather
than letters, and this profile's name is the mailbox, never v7.

## The spike that decides it

Before any wire format:

1. A local bare git repository and an OCI bucket as interchangeable dead drops for
   `nncp-bundle -tx` / `-rx`.
2. Two workers racing one claim; the loser discards; a stale worker's result
   rejected by the ETag fence.
3. Lease expiry with a crashed worker mid-claim.
4. A 100 MB response through multipart, and a lifecycle delete observed.
5. A replay of a genuine exec packet, and a forged unsigned envelope refused.

If a few hundred lines cover the adapter, the adapter is the product and the new
protocol should not exist.

## Recovery status

This record is a reconstruction: the research happened in a session that wrote no
file, and the text above carries its findings rather than new work. The NNCP
statements were read from the farm mirror named under the comparison table during
that session and are **not re-checked here** — the reference farm is not mounted on
the host this record was written on, so a reader who needs certainty re-reads
`src/pkt.go`, `src/toss.go`, `src/sp.go` and `doc/` at the tip they care about.
The OCI statements are Oracle's documentation as served to that session and carry
the vendor-document caveat: no bucket was exercised, so consistency,
conditional-write and lifecycle behaviour is unproven here. Nothing in the tree
implements any of it, and no spike exists.
