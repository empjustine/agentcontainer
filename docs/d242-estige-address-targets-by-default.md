---
id: d242
type: module-design
status: active
title: "d242 — address targets are the default: a VPN routes IP traffic, so the guarantee is the only refusal out of the box"
parent: estige
depends-on: [d163, d188, d146, d236]
references: [d073, d104, d130, d241]
tags: ["estige", "v5", "egress", "ip-literals", "policy", "decisions"]
---

# d242 — address targets are the default

This record reverses d163's "address targets are opt-in at each door" and
narrows VPN-R35's default-deny table to the guaranteed-bogon set. It is the
posture change that makes the tunnel a VPN rather than a name-only proxy: IP
traffic is what a VPN carries, so refusing a pre-resolved target refuses the
thing itself.

## Status

Accepted and implemented in `estige/`. It awaits the operator's own egress
data only for reservations: with no `exit.json` `egress` block, the exit's
default posture is exactly what this record states.

## Problem

d163 made an address target die at the relay's doors unless `-legacy-ip-relay`
was set, and at the exit unless `allowIPLiterals` was set in its egress. Both
switches off was the shipped default, so:

- **A client that resolved a name itself had no path.** `CONNECT 1.1.1.1:443`
  failed with `target-ip-literal`; SOCKS5 `ATYP=1/4` (what `socks5://` makes a
  client send) failed with `0x08`. For a VPN that is an idle tunnel: the point
  of a VPN is to carry packets whose destination the client already decided.
- **The default-deny table answered for space it had no business judging.**
  link-local and RFC 1918 ranges are ordinary destinations on a real network —
  a peer on `169.254.0.0/16`, a service on `10.0.0.0/8` — and refusing them by
  default makes the tunnel useless in exactly the environments that need it.
- **The switch was named for its non-default state.** `-legacy-ip-relay`
  described the relaxation, so the posture an operator got by default had no
  name and no visibility, while the one they wanted needed two flags.

## Decision

**An address target is the default, and the only default refusal is the
guarantee.**

The two layers keep their jobs:

| layer                             | refuses                                                                                        | configurable?                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| relay door (`localTargetRefusal`) | the guarantee, always (`0x02` / 403 `guaranteed-…`)                                            | no; plus `-refuse-ip-targets` refuses the whole address form (`0x08` / 403 `target-refused`) |
| exit gate (`targetVerdict`)       | the guarantee, always (`target-bogon`)                                                         | no                                                                                           |
| exit policy (after the gate)      | the operator's `denyCidrs`, minus `allowCidrs` exceptions (`egress-denied`), then the port set | yes: the store's `egress`, per process or per relay row                                      |

- **The guarantee is unchanged and stays code.** `0.0.0.0/8`, `127.0.0.0/8`,
  `255.255.255.255/32`, `224.0.0.0/4`, `::/128`, `::1/128`, the v4-mapped block
  and `100::/64` can never answer a connection, so no switch and no allow list
  reaches them. The reserved `localhost` name family stays refused beside them.
- **`defaultDenyCidrs` empties.** Private, link-local and ULA space is a normal
  destination; a refusal there is an operator's judgement about their own
  network, and it is expressed as data.
- **Reservation is the operator's verb.** `egress.denyCidrs` names the ranges
  to refuse, `egress.allowCidrs` carves a range back out of a reservation (an
  explicit allow wins, VPN-R35's rule), `egress.ports` bounds the port set, and
  `egress.refuseIPLiterals` restores the form-level refusal at the exit.
- **The strict door becomes the visible opt-in.** `-refuse-ip-targets` (argv,
  relay role) refuses the address form locally in the old vocabulary; the
  default needs no flag, so the non-default posture is the one a `ps` shows
  (d163's ledger, inverted).

### The trade, stated

`169.254.169.254` (cloud metadata) is reachable through the tunnel by default,
because link-local is also where real peers live and the record refuses to
guess which link-local address an operator's network uses. The mitigation is
the reservation table, one entry per endpoint:

```json
"egress": {"denyCidrs": ["169.254.169.254/32", "fd00:ec2::254/128"]}
```

The pre-d242 posture is likewise one block: the d242 record's own test list
carries the exact ranges (`TestEgressReservationAndException` and the README's
example), and an operator who wants it gets it by data, not by a code change.

`d130`'s `socks5h` spelling stays the default in `proxy-env`: a name still
gives the exit the resolution and the pinning (`VPN-R36`), so a client that can
send names should. What changed is that a client which cannot is no longer
refused.

## Requirement deltas

- **VPN-R22** — "A `CONNECT` whose target is a literal IP address is rejected"
  becomes: an address target is admitted unless the operator's strict door
  (`-refuse-ip-targets`) or form switch (`refuseIPLiterals`) refuses it; the
  guarantee and the reservation table answer either way. Resolution and
  pinning stay the exit's for **names**, which is what the requirement was
  protecting: the exit never dials an address it did not check.
- **VPN-R35** — "Default-deny egress: loopback, link-local, cloud metadata,
  unspecified, multicast and RFC 1918/ULA are denied unless allowed" becomes:
  the guarantee (unspecified, loopback, broadcast, multicast, discard, the
  v4-mapped block) is denied always; every other range is admitted unless the
  operator reserves it.
- **VPN-R24** — the SOCKS5 listener still offers remote-name resolution; it now
  also carries a literal, so `socks5://` and `socks5h://` both work, with
  `socks5h` still the recommended spelling.
- **d163** — its "address targets are opt-in at each door" decision is
  reversed; everything else it settled (the guarantee first, the two doors'
  vocabularies, the name refusals, `0x02` never re-enabled) stands.

## Amendment map

- **d188** — VPN-R22, VPN-R24 and VPN-R35 as above.
- **d163** — Decision section reversed at "Address targets are opt-in at each
  door"; the guarantee's precedence, the vocabularies and the name rules
  unchanged.
- **d130** — `socks5h` stays recommended for the pinning guarantee, no longer
  because a literal is refused.
- **d146** — its "unclaimed means pass" reading now holds by default rather
  than behind two switches.
- **d241/`estige/README.md`/`estige/DESIGN.md`** — the flag name, the store
  grammar and the default posture follow.

## Verification

`go test ./...` in `estige/` covers: the guarantee refusing under a
`0.0.0.0/0` allow list (no switch re-enables it), the default admitting public,
private, link-local and ULA addresses, `denyCidrs` reserving with `allowCidrs`
carving exceptions, `refuseIPLiterals` answering before the port set,
`-refuse-ip-targets` answering at the door in `0x08`/`target-refused`, and both
doors carrying a literal to the exit's policy by default. A probe through a real
relay records the SOCKS reply bytes for each shape.

## Alternatives rejected

- **Keep the switches, flip only the relay's default.** The exit's
  `target-ip-literal` would then be the answer to every literal, so the client
  would see no change beyond the token — the complaint this record exists to
  fix.
- **Admit literals but keep the default-deny table.** Then `169.254.169.254`
  and every RFC 1918 destination stay refused, so a VPN still cannot reach the
  private network it was deployed for; and the table would be answering for
  space the operator never mentioned.
- **Warn instead of refusing a literal.** A refusal an operator cannot see is
  worse than one they configure; the two switches are that visibility, and both
  remain available.
- **A relay-side CIDR reservation list.** Ranges are the exit's policy surface
  (d104/d078's split); the relay keeps a door switch, not a policy table.
