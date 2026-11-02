---
id: d123
type: decision
status: implemented
title: "d123 — the sweep runs the Go suite, and an empty egress config is refused"
parent: estige
depends-on: [d108, d113, d122]
references: [d084, d102, d104]
tags: [estige, testing, sweep, egress, fail-loudly]
---

# d123 — the sweep runs the Go suite, and an empty egress config is refused

## Problem

`go test ./...` in `estige/` was red on `TestEgressFromEnv/refused` and had been
for months, while every gate the repo runs stayed green: the sweep's globs are
`*/tests/*.test.mjs` and `*/tests/*.sh`, and estige's suite is Go, in-package
(`estige/*_test.go`). Nothing in the repo could see it. d113 recorded the
failure as "pre-existing, reproduces unchanged on `main`" and moved on — which
is exactly the shape of a red test that survives a refactor: attributed to
somebody else's tree and never re-read.

The failing subtest was `refused: {"allowCidrs": []} ` — one of four cases
added with `e58abb5` (d108's slice 5, "estige reads no config file"), each a
plausible typo whose silent reading would be *"configured, and the default deny
still applies"*. The parser answered `nil`: `egressFromEnv` (d108) refuses
unknown fields and trailing content, but an all-empty object decodes cleanly
and returns a zero `egressConfig`, which `newEgressPolicy` then reads as
"nothing configured" and replaces with the default deny table plus ports 80/443.
So the case list and the code landed together and disagreed; only the case list
was right.

## Decision

**`./test.sh` runs the Go suite.** It is the one leg the globs cannot discover,
so it is invoked explicitly, with the same three-step toolchain probe as
`estige/lib/go-build.mjs` (PATH, the mise shims dir, and `mise where go` — which
answers only for an *installed* toolchain, so a sweep never downloads one).
A host with no Go **skips loudly** with the reason and the install hint rather
than failing: the suite is real, but a laptop with no toolchain cannot be asked
to run it. A failing Go test fails the sweep — verified by planting one.

**An egress config that names neither a CIDR nor a port is refused.** Unset
already means the default deny table, so `{}` and `{"allowCidrs": []}` configure
nothing; accepting them lets an operator believe a range is reachable while every
dial to it fails, which is the same NFR-2 fail-loudly rule the unknown-field
check already enforces. Naming only one half stays valid — ports 80/443 (or the
deny table) fill the other, per d104's defaults.

## Invariants

- The Go leg's toolchain probe must not install anything: a gate that mutates
  the host mid-run is not a gate.
- A skipped leg is counted in the log with its reason; "sweep passed" never
  claims a leg that did not run.
- `egressFromEnv` still accepts `{"ports": [8443]}` and
  `{"allowCidrs": ["127.0.0.0/8"]}` — half a config is a config.

## Alternatives rejected

- **Add a `*/tests/*.go` glob to the sweep.** `go test` runs in the package
  directory and needs the module, not a file list; a per-file glob would fight
  the Go tool and still miss `_test.go` files that live beside their subject.
- **Make the test match the parser** (accept the empty object). That reverses
  the direction of the fix: the case list encodes the operator-facing intent,
  and the parser was the thing that had never been written.
- **Refuse only `{}` and not `{"allowCidrs": []}`.** Both mean the same thing to
  `newEgressPolicy`; distinguishing them would be a rule no operator can
  remember.

## Consequences

- estige's suite is now a gate, so the failure cannot recur silently. It costs
  ~0.7s on a host that has Go.
- d113's "pre-existing failure" note is dated in place; the record keeps its
  history, and this one carries the resolution.
- The empty-config refusal is a behavior change for any deployment that set
  `VPN_TUNNEL_EGRESS={}` deliberately — which produced no configuration at all,
  so leaving it unset is the correct spelling.

## Verification status

`./test.sh` → `ok estige` inside the sweep, 264 node checks still green; a
planted `t.Fatal` in `TestEgressFromEnv` → sweep exit 1; `go vet ./...` clean.
