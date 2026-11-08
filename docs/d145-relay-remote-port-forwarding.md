---
id: d145
type: module-design
status: draft
title: "d145 — remote port forwarding: a standing ACCEPT is the step-0 ACL, argv-seeded claims, connections outlive the ACCEPT"
parent: estige
depends-on: [d073, d104, d106, d131, d132, d144]
references: [d080, d090, d108, d110, d123, d128, d146, d120]
tags: ["estige", "tunnel", "forwarding", "ports", "claims", "v4", "ssh"]
---

# d145 — remote port forwarding

This record proposes estige's remote port forwarding: an exporting relay
holds a standing `ACCEPT` session whose live claim set is the step-0 ACL —
no standing session, no bridge — seeded at establishment from ssh-style
forwarding arguments in the relay's argv, and every bridge attempt an
event on that session, re-checked at the relay before anything opens. It
covers the host-form claims; the CIDR claim form is
[d146](d146-subnet-routes-over-socks5.md), the consumer-side listener is
[d144](d144-relay-local-port-forwarding.md), and d128's capability
product is separate. It is read by whoever implements the tunnel's ACCEPT
session and by whoever reviews how one principal reaches another's
services. The decision: no new entry in any config file, one new session
kind, additive frames, claims held in RAM for their session's life, argv
as the claim seed, and established connections deliberately outliving
the ACCEPT that authorized them — while how an already-established relay
opens a new tunnel stays undecided (Open item).

## Status

**Draft.** Nothing is implemented, and the store the configs live in
([d132](d132-estige-v4-key-store.md)) is itself unimplemented, so the
feature lands after it. The implementing change lands three deltas: d131's
session-bound wording and the frame grammar's additive extension (restated
under Requirement deltas), and d106's log vocabulary — and only the
ACCEPT kind's sentences, because the record deliberately leaves the
serving mechanism undecided (Open item). Notably, d132's schema takes
**no** delta: `exit.json` is untouched, `relay.json` is untouched, and
the claim seed is argv — the pairing table and export list earlier
drafts put in those files were cut into Alternatives rejected. Two
earlier drafts of this record also carried shapes that are gone: an
exit-side ingress listener, and a standing registry whose death tore down
live bridges.

## Problem

estige's traffic all starts at the relay: the relay dials the exit, the
relay names every target, and nothing on the exit initiates toward a
relay — so a service behind one relay is unreachable from every other
relay even though both tunnels terminate on the same exit. That is ssh's
`-R` direction in fleet form.

Five constraints decide the shape before a frame is drawn. d131's session
bound says one authentication buys one connection, so a service carrying
many connections cannot share one payload carrier without the mux
(VPN-R17, deferred). The exit's serving bind is env `PORT` and never a
config fact (d110, d132), and this design gives the exit no socket at all.
The fleet already has one name per relay — d132's principal name — so the
reachability vocabulary needs no new namespace. Config economy: every
explicit table is an artifact someone must test, keep in three parties in
sync, and reconcile against live sessions; a runtime fact cannot drift, so
who-reaches-what must not be configuration. And the exporter is the server
side of a reverse connection: it must build tunnels only for what it is
set up to reverse, never for arbitrary traffic an event names.

## Decision

### No config file changes

`exit.json` is `relays` and `egress` as it was; `relay.json` is untouched
by this record, because the claim seed is argv (below), an invocation
fact rather than stored config. The pairing table an earlier draft put on
the exit and the export list it put on the relay would each be a second
source of truth to test and drift against the sessions that actually
exist. Reachability has exactly one source: the ACCEPT session currently
open, its claims in RAM.

### Targeting: principal names shadow, claims gate

A `CONNECT {target, port}` on an authenticated consumer's tunnel:

- If the target's host is a principal in the exit's `relays` table, it is
  the bridge path — admitted principals are never resolved as DNS. The
  bridge opens only if that principal holds a live ACCEPT whose claims
  contain the port; otherwise `CONNECT_ERR` (never a fall-through to
  resolution, so the principal namespace cannot half-shadow a name).
- If the host is an IP literal, it must match a live claim — d146's rule,
  byte-identical refusal when it does not.
- Anything else takes the ordinary path: resolve at the exit, egress
  policy, dial or refuse, exactly as today.

### The ACCEPT session is the ACL

The ACCEPT session is scope-driven: a relay opens one if and only if it
was initiated with reverse forwarding — any `-R` argument, port or route
form — and closes it when that want ends. The want is an initiation
fact, not a runtime one: a relay started without forwarding arguments
never opens an ACCEPT, and a running relay that wants to begin reversing
restarts with arguments rather than opening one late — the late-open
question is decided here, not left open. A relay with nothing to reverse
holds no ACCEPT at all, so the step-0 question is answered before
any claim is consulted: the session's existence is itself the decision,
and killing the relay remains the way to pull the plug on everything at
once. Its first frame after `HELLO_OK` carries the initial claim set
(`ports`, plus d146's `routes`). One ACCEPT per principal: a second live
ACCEPT from the same principal is refused in-band and closed, so claims
can never be split across two sessions.

Claims mutate while the session lives: the relay sends a `CLAIMS` frame
and the exit replaces its RAM copy atomically — a full snapshot, not
incremental operations, so the session itself is the idempotent ordering
authority and a lost update is structurally impossible. A snapshot the
exit refuses — a rule violation, or a claim on exit-owned space
([d146](d146-subnet-routes-over-socks5.md)) — tears the ACCEPT down
instead of leaving a set the exit cannot hold whole: the full-snapshot
discipline admits no partial acceptance, the refusal rides `ACCEPT_ERR`
in-band, and the relay does not reopen the session until the process
restarts, because the argv seed has not changed and the refusal would
repeat. Removals bind immediately: they gate new bridges at the exit and
are re-checked at the relay (below), and they say nothing about
connections already established.

Shrinking the claim set to nothing and closing the session are the same
withdrawal at different granularities: the exit gates on session
existence and claim membership separately, so an empty-but-open session
bridges nothing either way, and closing it changes nothing for
connections already established (below).

### The claim set comes from argv, in the style of ssh

At establishment the relay takes its forwarding arguments the way ssh
takes its own — one flag per forward, repeatable:

- `-R <port>` — the exit-side reach is `<port>`; the relay dials
  `127.0.0.1:<port>`, the same number back at itself.
- `-R <port>:<host>:<port>` — the exit-side reach is the first port; the
  relay dials the `host:port` given. The rewrite is relay-private: it
  never appears on the wire, and the claim at the exit stays the reach
  port alone.
- `-R <cidr>:<ports>` — a route claim; the grammar is
  [d146](d146-subnet-routes-over-socks5.md)'s.

There is no bind-address half to ssh's `-R`: the exit binds no socket at
all (this record's decision), so the first field is a claim on an
existing door, not a listener anyone opens. Malformed arguments — an
unparseable port or CIDR, an empty host half, a missing field, more than
32 forwards (d132's list cap) — refuse relay startup loudly at the argv,
before any tunnel dials; a broken forward never reaches the wire.
The forwarding arguments ride the invocation itself: the packaged service
unit's `ExecStart` carries them ([d120](d120-estige-ships-as-packages.md)
retired the launcher script that this pass-through used to live in), and
a direct invocation spells them itself. The other flag of the style,
`-L`, is [d144](d144-relay-local-port-forwarding.md)'s record. d110's
multi-knob exemption already covers the relay's argv surface, so the
spelling creates no delta there.

The arguments are also the want: any `-R` argument means this relay
wants to reverse something, so its ACCEPT opens at tunnel establishment
carrying the argv set as the initial claims, and a relay with no `-R`
argument never opens one (scope-driven, above). The `CLAIMS` frame
remains the runtime channel for changing a live set — argv fixes the
start, not the life.

### The bridge, per connection

1. The exit matches the target as specified above: live ACCEPT, claim
   present, consumer authenticated.
2. It sends `EVENT {id, consumer, target, deadline}` through the ACCEPT
   pipe — a tunnel frame on a carrier the exit can originate frames on.
   A carrier that holds the connection open carries it on the
   already-open stream (the h2-POST and WebSocket tunnels); a carrier
   that does not — the h1.1 stop-and-wait floor, and any mode that closes
   each exchange — falls back to long-poll: the relay parks one exchange
   whose response carries the events as they come, and that fallback is
   the rule for every kind of pipe the exit must originate, not only this
   one. The frames stay tunnel frames; SSE or websocket vocabulary does
   not enter the wire. Which rung carries the ACCEPT, and the held-open
   h1.1 variant that would spare the floor the long-poll, is a
   ladder-level question broader than this record (Open items). The
   consumer principal travels
   with it so a per-consumer rule can be added later without new frames.
   The id is single-use, at least 128 random bits (the nonce discipline
   of d104's replay caches), and bounds one entry in the exit's
   deadline-limited pending map.
3. The relay re-validates the target against its **current** claim set —
   this is the imperative: as the server of the reverse connection, it
   creates a serving tunnel only for what it is set up to reverse, never
   for arbitrary traffic an event names. An in-flight event whose claim
   was just removed loses to the removal here.
4. On a miss the relay answers `DECLINE {id, reason}` on the same pipe;
   on a dead deadline the exit answers the consumer `CONNECT_ERR`
   either way.
5. On a hit, how the relay opens the tunnel that serves this connection
   is undecided by design and unimplemented (Open item): this record
   fixes the gate — match, event, re-check, decline — and not the
   actuation behind it.
6. Whatever actuation lands, its pumping is this record's contract:
   backpressure, half-close, blind pipe (VPN-R18, VPN-R19, VPN-R25).

A session's kind is fixed for its life. ACCEPT carries claims and events
and never payload; any frame outside its kind tears down that carrier —
the existing fail-closed path, scoped to one session. The serving
session's kind belongs to the undecided actuation; its frames stay
unassigned until the Open item chooses them — frame kinds are additive
past version 1's defined set, and a peer that cannot decode a kind tears
down only the carrier it arrived on.

### Established connections outlive their ACCEPT

When an ACCEPT closes — the want ending, a relay restart, a network
blip, a process kill — its claims die with it and every subsequent bridge
attempt is refused, but connections already bridged keep pumping. After
establishment the exit maps nothing between a bridged connection and the
ACCEPT that authorized it: no ownership ledger exists at either end to
reconcile, whatever the actuation turns out to be. A claim removal is a
statement about the future; revoking a live connection is process-level —
kill the relay, and its tunnels end physically.

VPN-R26's kill switch survives in the place it belongs: bytes flow only
while that connection's own serving tunnel is alive, so every pipe is its
own tunnel-before-bytes. What disappears is the spanning ledger that
earlier drafts used to enforce revocation logically.

### Stop semantics: a lone signal drains

A lone SIGINT — or SIGTERM, the signal every service manager sends by
default — stops the relay from growing and lets it empty: the ACCEPT
closes — claims die with it, so no new bridge passes the step-0 check —
every proxy door and local listener stops accepting, so no new connection
can buy a new tunnel, and connections already open keep pumping until
they end on their own, at which point the process exits. A second signal
ends the drain now and keeps the meaning the lone signal has today:
stop everything immediately, established connections torn down with the
rest. The drain itself is new — today the first signal is already the
immediate teardown, and this record replaces that first-signal meaning;
the implementing change adds the second-signal handler, since the
current signal handling arms only the first.

The stop contract propagates to every launcher, or the drain exists only
where the binary is invoked by hand. The container image already execs
the binary directly (`ENTRYPOINT ["/estige"]`), so the runtime's stop
signal arrives and the runtime's stop grace is the drain window. The
systemd units' defaults deliver SIGTERM and their `TimeoutStopSec` is
the drain window, with the manager's kill playing the second signal's
role; runit's `sv stop` sends the same TERM and waits, which is the same
mapping on Termux — the run scripts already exec, so the signal lands on
the binary. The exit node's stop is unchanged by this record: its
tunnels die with the process, and no drain is defined for it here. The
packaging deltas are named on
[d120](d120-estige-ships-as-packages.md) by the implementing change.
Graceful shutdown is therefore the scope-driven rule's "want ends" path
exercised by signal — nothing new opens while the relay drains, and the
drain's ceiling is the operator's hand on the second signal.

### Refusals split by credential

A credential failure at session open answers the camouflage 404
(VPN-R34): ACCEPT is never reached by an unauthenticated peer and the
namespace stays invisible. Post-authentication failures answer in-band:
`DECLINE` for a relay that declines an event, `CONNECT_ERR` for no
ACCEPT, an unclaimed port or a deadline — the same frame and log-safe
reason classes egress refusals already use. The event id and any proof
appear in no log line, error body or health field (VPN-R33; VPN-R44's
redaction argument applied to a session capability).

## Requirement deltas

Restated with citations, the way d104 carries its own:

- **d131's session bound gains one sentence.** "One authentication buys
  one connection, one CONNECT" becomes "…one session of one declared
  kind": an ACCEPT session's handshake admits its claims and the events
  it receives, never a tunneled payload. The bound's purpose is
  untouched — no renegotiation, and each session dies with its
  authenticated carrier. The serving session, when its mechanism is
  chosen, takes its own sentence there.
- **The frame grammar extends additively.** One session-kind spelling
  (ACCEPT) and frames `CLAIMS`, `EVENT`, `DECLINE`, `ACCEPT_ERR` — new
  kinds numbered past version 1's defined set, `HELLO`'s version staying
  1, for d106's reason: `decodeHello` is strict, so a version bump
  becomes a pair-wide transition with deployment-order outage risk, while
  an old peer's rejection kills only the carrier it does not understand.
  Nothing is pre-reserved for these kinds in v1's grammar — the reserved
  fields are the stream id (VPN-R17's mux reservation) and the flags
  byte — so the extension is exactly the additive kind an old peer fails
  closed on: `decodeFrame`'s unknown-type refusal tears down the carrier
  that brought the frame and nothing else. The serving kind and its
  frames stay unassigned until the Open item chooses them.
- **d106's vocabulary gains `via=accept`**, plus reason values for
  unclaimed, declined and ambiguous matches. Lifecycle rules stand:
  every open paired with a close, identity fields repeated on the close,
  no credential in any line.
- **d132 takes no delta.** No schema change exists to land for this
  record; the relay-side claim seed is argv (Decision), not a schema.

## Consequences

- The exit's standing state is per principal: one session and one claim
  set in RAM, plus transient deadline-bounded pending events (the id
  map). No registry, no lifetime mapping, and nothing to reload — the
  memory-only ruling is trivially kept because nothing else exists to
  store.
- The exit binds nothing and dials nothing: the serving-port law (d110)
  is satisfied trivially, the egress table (d080) is untouched, and the
  funnel front and tunnel-only serving edge (d108) share nothing with
  this feature.
- Which consumers may use an ACCEPT? Key admission alone: whoever may
  open a session at all may ask, and the relay's claims answer what it
  reverses. That is the fleet-trust posture with no per-consumer
  selectivity today — the `EVENT` already carries the consumer's
  principal, so adding one later is a rule, not a wire change.
- The consumer entry is a relay's proxy door: SOCKS5 or HTTP CONNECT at
  any admitted relay, the already-bound doors of a native host running
  both roles from one env (d090), and proxy-unaware clients through
  d144's forwards (`-L 5432:relay2:5432`).
- The relay's `/healthz` shows its claim set, ACCEPT state, stopping
  state and in-flight events (d106 vocabulary). The exit has no health
  surface; its state is visible in lifecycle records.
- Verification is the Go suite (d123): a malformed `-R` argument refuses
  relay startup before any dial; argv claims arrive in the ACCEPT's
  first frame, and no `-R` argument means no ACCEPT ever opens; no-ACCEPT
  refusal is immediate and creates nothing; an unclaimed port answers
  `CONNECT_ERR` without an event; a claim snapshot removes a port for
  new bridges while an established bridge keeps pumping; a second ACCEPT
  is refused in-band; an event whose claim was removed between step 2
  and step 3 is declined at the relay; a wrong-kind frame tears down only
  its session; a claim snapshot the exit refuses tears the ACCEPT down
  and the relay does not reopen it until restart; ACCEPT close leaves
  established pipes untouched and new attempts refused; a first SIGINT
  closes the ACCEPT, closes the doors to new connections and leaves
  established pumps running, a second tears everything down; a credential
  failure is byte-identical to today's camouflage 404; no event id or
  proof reaches any log line. The actuation's own assertions wait for its
  Open item.

## Alternatives rejected

- **Always-on ACCEPT (opened whenever a tunnel comes up).** A relay with
  nothing to reverse would hold a consent-shaped session encoding no
  decision, and `an ACCEPT exists` would stop meaning `wants to`.
  Scope-driven keeps the step-0 fact itself the decision, at zero cost
  in config.
- **Store-seeded claims (`relay.json` gains a forwardings array).** The
  config-economy law again: stored scope outlives the intent that
  created it, needs reconciling against the session that actually
  exists, and is one more explicit table to test — while ssh's own
  forwarding flags are per-invocation by nature and this record keeps
  that nature.
- **Pairing rows in `exit.json` and export lists in `relay.json`** (this
  record's earlier drafts). Config to test later, drift between two
  stores, and a three-party sync — and none of it survives contact with
  live sessions anyway. The standing session is both the consent and the
  registry, and it cannot be out of date.
- **Spanning teardown of live bridges when the standing session dies**
  (also earlier). It required the exit and the relay to track which
  serving connection belonged to which ACCEPT for each connection's whole
  life — an ownership ledger at both ends — to enforce logically what
  killing the relay does physically. Survivorship deletes the ledger.
- **Offering the connection on the exporter's payload session.** Mixed
  control frames into a bound-restricted session and cost a bound delta;
  the ACCEPT kind needs none, because it never carried payload at all.
- **A per-connection accept decision.** The relay would need a rule
  evaluated on every arrival, and the exit an offer path to evaluate it
  over. Step-0 consent with claims makes the rule "what I am set up to
  reverse", checked locally at both ends and mutable over time.
- **Exit-side ingress listener.** Consumers are relay-side, where binding
  is that node's nature, or on a native host that already runs both roles
  (d090); a proxy-unaware consumer on a pure exit host runs `-mode relay`
  beside it from the same shared env rather than growing the exit.
- **`relay1-*` pairing rows (wildcard exporter).** The exporter side is
  where the destination is defined; a wildcard there is anycast with no
  authority for which principal's service answered — and redundant,
  because the same reachability is N explicit claims.
- **Data on the control session (mux), a `tunnelVersion` bump, or a
  capability byte.** VPN-R17's deferral; d106's strict-`decodeHello`
  transition law; and a chicken-and-egg where each direction's
  exact-length grammar rejects a new member outright.
- **Reverse SOCKS: the consumer names any local target at the exporter.**
  The claim set is the reviewable fact, and the relay only ever creates
  tunnels for it.
- **Persisting claims or sessions to disk.** Tunnels are ephemeral;
  relays re-open and re-claim, so recovery is re-declaration and a
  persisted copy would outlive the session it describes.

## Open items

- **How an already-established relay opens a new tunnel.** Everything
  this record decides runs on the tunnels that exist from establishment:
  the argv-seeded ACCEPT, its `CLAIMS` mutations, the event pipe. What a
  hit actuates — the fresh proof-paying serving session with a
  single-use credential (sketched by this record's earlier draft), a
  standing pool of pre-opened sessions, the deferred mux (VPN-R17) — is
  undecided here and unimplemented, deliberately: the gate this record
  fixes (match, event, re-check, decline) is the same behind any of
  them. Late ACCEPT opening is decided, not open: the want is
  initiation-time argv, so an established relay opens no ACCEPT.
- **The ACCEPT's carrier rung.** Which ladder rung carries the ACCEPT's
  event pipe is a ladder-level question broader than this record: the
  duplex rungs (h2-POST, WebSocket) carry events on the open stream, the
  stop-and-wait floor long-polls a parked exchange, and an h1.1
  held-open full-duplex variant — attempted, if feasible, before the
  WebSocket and the floor, to spare the floor the long-poll — would be a
  new rung owned by a ladder record in d077's family, not here. Until it
  lands, the relay rides the duplex rungs and long-polls the floor.
- Per-consumer rules on top of `EVENT`'s consumer field, if a fleet is
  admitted but not mutually trusting.
