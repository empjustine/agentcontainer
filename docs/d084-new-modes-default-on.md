---
id: d084
type: decision
status: implemented (superseded in part by d085 — the arm env is the operator keyset, not VPN_TUNNEL_PREFIX)
title: "d084 — the new modes arm by default: -modes starts at cd, and the capability env arms the tunnel family"
parent: llm-reverse-proxy
depends-on: [d073, d077, d081]
references: [d078, d080]
---

# d084 — the new modes arm by default

## Problem

(v22.22) The tunnel family was opt-in at both ends: the client's `-modes`
default offered only `d`, and the server armed only from a config block
(`tunnel.enabled`). A deployment built from the generated config therefore
came up as pure mode A — start logs byte-identical to the pre-d073 proxy
("I'm not sure if it is actually running the correct thing at all") — and
the new surface needed a config edit to exist at all. d081 had gated the
`-modes` flip on spike L3; deployment reality outran the spike.

## Decisions

### 1. `-modes` defaults to `cd` (the L3 gate is superseded)

The client offers mode C first with the built demotion chain (C → D,
fail-closed, VPN-R26) unless `MODES`/`-modes` says otherwise.
**d081's spike-L3 bar (≥6 concurrent streaming POSTs through the edge) is
superseded by operator decision: deploy first, measure in production.**
The spike's measurement value stands — only its VETO is gone. Revert
criterion: if concurrent streaming POSTs prove unstable in practice, the
default returns to `d` — one line, no migration.

### 2. The capability env arms the tunnel family

`tunnelConfig.Enabled` becomes tri-state: **absent = the env decides**
(armed iff `VPN_TUNNEL_PREFIX` is set — superseded by d085: the operator keyset env is the trigger), **false = veto** even when armed,
**true = assert armed** and let the boot fail loudly if the env is missing
(enableTunnel's validation is that fail-loudly path, unchanged). The config
grants nothing — the credentials arrive only through the env chain
(VPN-R44), so the env IS the opt-in. A half-armed env (prefix without its
keyset) still fails the boot: a loud misconfiguration beats a silent
mode-A fallback. The egress default is unchanged (default-deny CIDRs,
public-web ports — VPN-R35).

### 3. What this does NOT change

- Mode E stays unbuilt — d081's L4 gate is untouched and
  `parseClientModes` still fail-loudly rejects `e`.
- Mode A fallback and d080's host policy are untouched (VPN-R2: an
  unarmed deployment behaves exactly as before).
- The provisioning prerequisite stands: the vault must carry
  `VPN_TUNNEL_PREFIX` + `VPN_OPERATOR_KEYS` (or `VPN_OPERATOR_TOKEN`) for
  the family to arm. Unarmed deployments still serve mode A only. (d085:
  just the keyset — `VPN_TUNNEL_PREFIX` is gone from the env surface.)

## Consequences

- `run.sh` no longer restates the `-modes` default (both branches): the
  binary's flag default is the single source, `MODES` overrides. The
  server's container branch now forwards `VPN_TUNNEL_PREFIX` /
  `VPN_OPERATOR_KEYS` / `VPN_OPERATOR_TOKEN` (d085 drops the prefix) —
  before this, a containerized server could never arm regardless of the
  vault.
- The next build lights up the tunnel line on any host whose environment
  chain carries the pair; clients connect with C on offer first.

## Verification record

- `go test ./...` green (`arm_test.go` pins the tri-state parse +
  resolver; the tunnelserver/modec/e2e fixtures dropped a now-meaningless
  `Enabled: true` — enableTunnel never read it), `go vet`, `gofmt -l`,
  `go build` clean; `./lint.sh` clean on the run.sh changes.
- `parseClientModes` semantics unchanged (modec_test.go table).
