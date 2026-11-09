---
id: d163
type: module-design
status: active
title: "d163 — guaranteed refusals answer first at both doors; legacy IP relaying and the IP-exit switch are opt-in"
parent: estige
depends-on: [d073, d145, d146]
references: [d080, d130]
tags: ["estige", "tunnel", "relay", "egress", "bogon", "dns", "socks5", "switches"]
---

# d163 — guaranteed refusals at both doors

This record is estige's refusal contract for the two places a target enters
the tunnel: the relay's loopback doors and the exit's CONNECT gate. It fixes
one ordering rule — a guaranteed refusal answers before any lookup, switch,
or table — and it puts both halves of address relaying behind explicit
switches. It does not restate the egress tables
([d080](d080-forward-proxy-no-host-allowlist.md), VPN-R35) or the client's
`socks5h` contract ([d130](d130-chain-step-spelling-contract.md)), and it
constrains the reverse-relaying designs
([d145](d145-relay-remote-port-forwarding.md),
[d146](d146-subnet-routes-over-socks5.md)) without implementing them. The
record is for whoever writes a relay door or a gate verdict. It is also the
reference a reviewer reads when deciding what an operator setting may
re-enable.

## Status

In force: `estige/` implements every rule below — `targetVerdict` and
`localTargetRefusal` are the two gates, `-legacy-ip-relay` and the
`allowIPLiterals` config field are the two switches — and the Go suite pins
each refusal path. The record amends two decisions it depends on: [d146](d146-subnet-routes-over-socks5.md)
relaxes the relay's IP-literal refusal to pass-through, and this record makes
that relaxation opt-in; VPN-R22 and VPN-R35 on [d073](d073-ssl-vpn-three-modes.md)
read as unconditional denials, and the Requirement deltas section below
narrows them to the guarantee's carve-out. Its enable rule for reverse
relaying binds [d145](d145-relay-remote-port-forwarding.md) and
[d146](d146-subnet-routes-over-socks5.md), which stay draft — their feature
does not exist in the tree.

## Problem

- VPN-R22 puts resolution and dial policy at one point, the exit, but three
  doors had to reach that answer by coincidence: the relay's CONNECT
  response, the relay's SOCKS reply, and the exit's verdict before the dial.
  Nothing ordered them, and each carried its own vocabulary.
- The guaranteed-bogon set [d146](d146-subnet-routes-over-socks5.md) defines
  had no gate behind it. `allowAddr` is operator-allow-wins over the deny
  table, so one broad `allowCidrs` entry re-enabled a dial into loopback
  space.
- A `localhost` target spent its lookup before anything said no. The name is
  useless over the network, and the refusal, when it came, arrived
  post-resolution from the address table — if the allowlist had not already
  flipped it.
- [d146](d146-subnet-routes-over-socks5.md) reads address relaying at the
  relay's doors as the default pass-through. Address relaying as the default
  is the behavior VPN-R22 exists to remove.
- The two reverse-relaying modes — [d145](d145-relay-remote-port-forwarding.md)'s
  security-principal claims and
  [d146](d146-subnet-routes-over-socks5.md)'s CIDR routes — need their enable
  point fixed before either lands, so a relay started without it bridges
  nothing.

## Decision

### One gate answers for the relay's three doors

`localTargetRefusal` in `estige/relaynode.go` is the relay's single answer:
the CONNECT handler, the SOCKS5 handler (all three address forms) and the
forward branch call it. It runs before a tunnel exists, so a refused target
opens no exit session. HTTP answers `403 target-refused` with a detail
string that names the rule it enforced; SOCKS answers `0x08` for an address
target that the switch could help, and `0x02` for a guarantee that no switch
can.

### The exit's verdict answers before the dial

`targetVerdict` in `estige/egress.go` is the exit's gate, shared by the
tunnel server's CONNECT phase. Its order is the policy: a
guaranteed-refused name, then a guaranteed-bogon address, then the IP-exit
switch, then the port set. It reads no DNS — the address table is consulted
after resolution, where the addresses are, and VPN-R36's single resolution
point still holds.

### The guarantee answers first, and no setting re-enables it

A guaranteed target dies by code on both ends before operator data is read.
The address half is `guaranteedBogons`: loopback, `0.0.0.0/8`,
`255.255.255.255`, multicast, `::`, `::1`, the v4-mapped block and
`100::/64`. The name half is `isBogonName`: `localhost` and every name
under the `.localhost` TLD, so `dev.localhost` and `app.localhost` fall
with the rest of the sub-tree, plus the `/etc/hosts` loopback family a
default Fedora/RHEL hosts file sets beside `localhost` — `localhost4`,
`localhost4.localdomain4`, `localhost6`, `localhost6.localdomain6` and
`localhost.localdomain`. The family is named as exact spellings, because a
prefix rule over `localhost` would also swallow `localhost.example.com`, a
name the network may answer for. Both halves are refused before any lookup: a
name in that family resolves inside the host by RFC 6761, so no query can
produce a useful answer. Each half answers for its spelling as written —
`LOCALHOST.`, `LOCALHOST4.LOCALDOMAIN4.`, `app.localhost.` and
`::ffff:127.0.0.1` die the same deaths as their plain forms, because a
trailing dot, DNS's case folding and the v4-mapped block are spellings, not
different targets. The address set is
deliberately narrower than the deny table: RFC 1918, link-local and the
documentation ranges are possible bogons a real network does allocate and
stay with the pinhole review, while space that can never answer a connection
does not.

### Address targets are opt-in at each door

Default stays VPN-R22's refusal: the relay refuses an address target —
`0x08`/403 for the address form, `0x02`/403 for a guaranteed-bogon spelling,
which answers first — and the exit's gate answers `target-ip-literal`.
Two switches relax it, one per process owner: `-legacy-ip-relay` (argv at
relay startup) passes an address from the relay's doors to the exit's gate,
and `allowIPLiterals` (a `VPN_TUNNEL_EGRESS` field) admits an address to
the exit's dial path. A relay client's address target needs both switches set
to be dialed; each switch alone moves the refusal one gate further along.

The pass beyond that is implicit rather than claimed: an address the
guarantee does not refuse reaches the exit's own gates — the port set, then
the address table — and no claim lookup stands in front of them.
[d146](d146-subnet-routes-over-socks5.md)'s rendezvous refusal for an
unclaimed literal yields to this fall-through when its claim system lands, so
unclaimed means pass, not a second refusal. Neither switch is default, and
both leave the guarantee first in the order.

### Reverse relaying opens only on an explicit startup setting

Reverse relaying has two modes: [d145](d145-relay-remote-port-forwarding.md)'s
security-principal mode, where a relay exports services under its own
principal by host-form claims, and
[d146](d146-subnet-routes-over-socks5.md)'s cidr-range mode, where a relay
exports a subnet by CIDR claims. Neither mode may turn on by default, by
ambient environment, or by anything the exit grants: each requires an
explicit setting at relay startup — argv or a configuration file — and a
relay started without it opens no ACCEPT session and answers no claim. In
[d145](d145-relay-remote-port-forwarding.md)'s design the `-R` arguments are
that setting, and nothing else may open the session.

## Requirement deltas

### VPN-R22 restated

The relay refuses an address target at its doors — `0x08`/403 for an
address the guarantee has no claim on, byte-identical to
[d130](d130-chain-step-spelling-contract.md)'s contract, with a
guaranteed-bogon spelling answering `0x02` first — and passes it through
only when `-legacy-ip-relay` is set; the exit's gate refuses it until
`allowIPLiterals` is set. A guaranteed-bogon target dies at either door
regardless of both, by address or by a localhost-family name, so no path
dials an unchecked address and no path queries a name the network cannot
answer for.
Resolution and pinning stay exit-side: a relay client that resolves locally
performs the legacy behavior, and the door refuses it rather than
accommodating it.

### VPN-R35 restated

The default-deny table stands for every possible bogon — RFC 1918,
link-local, metadata, documentation space — with operator allow entries
winning over it as before. The guaranteed subset is carved out of that
permission: loopback, this-network, limited broadcast, multicast,
unspecified, the v4-mapped block and discard-only space are refused before
the table is consulted, and an allowed CIDR cannot reach them.

### VPN-R36 restated

Resolution stays pinned at one point: names resolve once, at the exit, and
the dial uses the validated addresses. The name door is pre-resolution by
design — a refused name is never queried at all — so the door removes
lookups instead of adding a second resolution point.

## Consequences

- `target-bogon` joins the tunnel's stable reason vocabulary, and the relay's
  problem type `target-refused` carries the detail. The SOCKS split — `0x08`
  for the switch's reach, `0x02` for the guarantee's — keeps
  [d130](d130-chain-step-spelling-contract.md)'s byte-identical default for
  address targets outside the guarantee.
- The relay switch is argv, not environment: the same side of the ledger as
  [d145](d145-relay-remote-port-forwarding.md)'s relay-side flags, visible in
  the process command line.
- The guarantee stays code rather than configuration, because the point of it
  is what an operator setting must not buy back. A bad CIDR entry panics at
  load instead of mis-verdicting at some later dial.
- The Go suite resolves through a hermetic alias table and never the host's
  DNS: the door refuses `localhost` before any lookup, so tests reach a
  loopback upstream by alias name, and an accidental lookup fails NXDOMAIN
  rather than emitting a packet. The anchor tests are
  `TestGuaranteedRefusals`, `TestIsBogonName`, `TestTargetVerdictOrder`,
  `TestServerGuaranteedRefusalsAnswerFirst` and
  `TestRelayLegacyIPRelaySwitch` in `estige/`.
- [d130](d130-chain-step-spelling-contract.md)'s `socks5h` spelling stays
  honest under the default: a name is still the only target form that
  travels from a relay, and local resolution is the legacy behavior the door
  refuses.

## Alternatives rejected

- Pass-through as the relay default,
  [d146](d146-subnet-routes-over-socks5.md)'s original reading — it makes
  address relaying the norm VPN-R22 removes, so the opt-in keeps the refusal
  the default.
- Unmapping the v4-mapped spelling before the check — `::ffff:127.0.0.1` then
  escapes the refusal the mapped block exists for.
- The guarantee as configuration — that is exactly the knob the guarantee
  must not have.
- Refusing after resolution — it spends the lookup the refusal exists to
  avoid; the guarantee's whole point is that no query leaves the machine for
  it.
- One switch for both doors — the doors run in different processes under
  different operators, and a direct tunnel client never crosses the relay's
  door.
