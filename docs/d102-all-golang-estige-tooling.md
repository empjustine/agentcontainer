---
id: d102
type: module-design
status: active
title: "All-golang estige tooling: Go generator, JSON fact table, subcommand dispatch"
parent: estige
depends-on: [d023, d024, d038, d039, d041, d047, d050, d058, d070, d101]
references: [d064, d082]
tags: [estige, golang, tooling, generators, fact-table]
---

## Problem

The estige unit's product is one static Go binary plus one JSON config, but
its generation path was Node: `generate.mjs` (the vendored pi-ai table, the
fact-table projection, the host collapse, the canonical write through
`lib/`) behind a 3-line `node_run` shim, wired through `lib/node-run.sh`'s
mise pin. A host with only the go toolchain could build and serve but not
regenerate the allowlist — a cross-language dependency inside the very unit
docs/d082 plans to extract. Every phase-1 rename hunk that had to touch both
a `.go` file and a `.mjs`/`.sh` pair for one behavior was the same smell.

Separately, the shared provider fact table (`lib/cloud-providers.mjs`,
docs/d024) existed only as JS: any non-node consumer would have had to
re-declare the provider facts — the exact drift class d024 was written to
kill, moved one folder over.

## Decision

The unit's generation becomes Go, end to end:

- **`estige generate` is a subcommand of the proxy binary itself**
  (`generate.go`), dispatched in `main()` before flag parsing — the
  proxy's own flags all start with `-`, so any bare first argument is a
  subcommand by construction. No separate tool, no shim, no node: the
  unit's generator IS the unit's binary, and `go run . generate` runs it
  from source with no stale-binary trap.
- **The shared fact table moves to `lib/cloud-providers.json`.**
  `lib/cloud-providers.mjs` becomes the node-facing loader + derived
  projections (same exports, same order, loud validation), and the Go
  generator reads the same bytes. Row-level rationale (full-base-path
  rationale, catalog gaps) rides the rows as `note` strings, so the
  reasoning travels with the data instead of dying in a deleted comment
  block.
- **The pi-ai built-in table stays in Go code** (`generate.go`): it is
  single-consumer and is itself the re-extraction input (docs/d039's
  floor-copy rule) — typed and compile-checked where it lives, data-in-JSON
  only where consumers are plural.
- **Byte parity is the porting contract.** Same artifact bytes (docs/d050
  canonical JSON: `listen` first, `allowHosts` key-sorted, 2-space indent,
  trailing newline, atomic tmp+rename per docs/d023), same structured-log
  vocabulary and field order (docs/d045 shape — `ts`/`level`/`tool`/`msg`
  then caller fields in insertion order, no HTML escaping), same collapse
  semantics ("owner rows share one upstream host — collapsed to one
  allowlist row"), same drift reports keyed by host. Proven by regenerating
  the committed `estige.json` with the Go generator and requiring zero
  diff — that proof is what let `generate.mjs` and `generate.sh` die in the
  same commit.
- **The orchestrator follows** (docs/d041's shape, unchanged): root
  `generate.mjs` spawns the estige leg as `go run . generate` from the
  folder; the node-based folders keep their generators and shims.

Landing in this same change set: the smoke test moves to Go —
`smoke-test.go`, the `estige smoke-test` subcommand — keeping the check
vocabulary (`ok`/`FAIL`/`skip`, the `passed=N failed=N skipped=N` summary)
byte-stable so operator-facing output does not change, and running the
child with the proxy env stripped (the shell script inherited `http_proxy`
silently — a host chain, docs/d094, could flip non-loopback checks).
34/34 green against the Go implementation.

The launcher surface is assessed, not converted: `vpn-exit.sh` /
`vpn-relay.sh` are one-shot launchers whose operational surface (env,
exit codes, `workload_rm`) is the parent repo's declarative workload API —
`lib/workload-runtime.sh` — shared with the other folders. Converting them
here would trade a known, gated shell surface (shellcheck-clean,
chain-tested by `estige/tests/check-vpn-relay-chain.sh`) for a Go re-implementation
whose environment plumbing is not yet designed; that trade belongs to the
docs/d082 split-time question, same as the workload API itself.

## Consequences

- Regenerating the estige unit needs only the go toolchain — the same
  toolchain building it needs. `estige/CI.md`'s drift gate is go-only
  (`cd estige && go run . generate` + `git diff --exit-code estige/`).
- The unit's remaining node@24 surface shrinks to the root builder the shim
  runs and the canonicity guard (`tests/committed-manifests.test.mjs` since
  docs/d104; docs/d050's canonicalizer still
  governs the node generators — the Go generator implements the same
  ordering natively). The per-change CI-critical path is plain
  `go build` + `go test ./...`.
- One fact table, two readers: a projection copy of the provider facts can
  no longer drift from the deployed allowlist, and `LIB_DIR` remains the
  unit's single injected directory — its generation-related content is now
  one JSON file.
- The port set the template for the rest of the unit's tooling: a script
  that only sequences toolchains the unit already requires becomes a Go
  subcommand or test, and the subcommand surface (`generate` first) is where
  further launcher verbs would go if the workload-API assessment lands
  that way.

## Alternatives rejected

- **Re-declaring the fact table in Go** (`cloudProviders := []row{...}`):
  the d024 drift class one commit later — the table's whole point is that
  node and Go generators agree byte for byte.
- **Keeping a shim** (`estige/generate.sh` → `go run . generate`): a shim
  that exists only to find a toolchain the unit requires anyway; deleting
  it is the entire point of the exercise.
- **Embedding the JSON table in the binary** (`go:embed`): the deployed
  allowlist would then depend on the build stamp of whichever binary
  happened to be on disk — generation must read the tree, like every other
  generator in the repo.
- **A separate `cmd/estige-generate` tool**: the unit is one binary by
  design (docs/d082's boundary); a second binary doubles the release
  surface for one offline code path.
