---
id: d137
type: architecture-design
status: active
title: "d137 — golangci-lint is the Go lint gate, strict-from-standard"
parent: architecture
depends-on: [d107, d113, d123]
references: [d090, d122]
tags: ["tooling", "golang", "lint", "estige", "golangci-lint"]
---

# d137 — golangci-lint is the Go lint gate, strict-from-standard

## Problem

estige is the repository's only Go unit (docs/d102, docs/d113): one
stdlib-only module, ~9.4k LOC across `estige/` and `estige/packaging/`. Its
static surface was unguarded. `go vet` was run by hand and recorded in
verification notes (docs/d084, docs/d123) but no gate ran it; `gofmt` was
enforced nowhere; and the sweep's globs (`*/tests/*.test.mjs`,
`*/tests/*.sh`) cannot see Go source at all. `./test.sh` runs the Go suite
(docs/d123) but nothing checked the code that suite compiles.

The JS/TS half already had the answer: biome (a pinned, explicit rule set)
plus oxlint, knip, ruff and ty, all wired into `./lint.sh` (docs/d107). The
Go half had no equivalent.

## Decision

**`golangci-lint` becomes the Go lint gate, in strict-from-standard mode.**
The config lives in `estige/.golangci.yml` — inside the copy unit, so it
travels with the folder on the docs/d082 split, exactly like `go.mod`
(docs/d113). `./lint.sh` invokes it from `estige/`.

### Strict-from-standard, not `all`

golangci-lint v2's presets are `standard` / `all` / `none` / `fast`; it has
no "recommended" preset. The gate adopts the repository's biome posture
(docs/d107) rather than `default: all`:

- **Start from `default: standard`** (errcheck, govet, ineffassign,
  staticcheck, unused) and **add linters by explicit name**, one wave at a
  time. A new upstream linter never arrives on its own, so the gate's meaning
  moves only when the config does.
- **A linter joins only after its findings are fixed**, so the gate is green
  the day it lands. The first wave enabled `bodyclose`, `canonicalheader`,
  `containedctx`, `contextcheck`, `errchkjson`, `errname`, `errorlint`,
  `forcetypeassert`, `goconst`, `gocritic`, `modernize`, `nilnil`,
  `noctx`, `nolintlint`, `perfsprint`, `prealloc`, `revive`, `unparam`;
  every finding they raised was fixed, not suppressed.
- **Formatters are separate** in v2: `gofmt` and `goimports` are enabled
  under `formatters`, which is what finally put the `websocket.go`
  const-block drift behind a gate.

### The measured survey

`--default=all` over the unit raised 2,262 findings across 44 of 112
linters; the strict-from-standard set raises zero. The difference is not a
weaker gate but a documented one: the linters left out are either
library-specific no-ops (no SQL, testify, zerolog, ginkgo or Prometheus in
this tree) or deliberately rejected style rules, recorded below.

### The justified disables

Three, each with its reason in place:

- `_test.go` errcheck, via `linters.exclusions.rules`. Test cleanup
  (`defer conn.Close()`) is fire-and-forget by design; the repo already has
  the same test-scoped relaxation for `no-floating-promises` in
  `biome.jsonc`.
- `goconst.ignore-tests: true`. Test fixtures repeat literals on purpose
  (the same upstream URL, the same `yes` header); a constant there would be a
  second spelling of a fixture. Production findings stay live, and the
  protocol spellings they demanded now live in `estige/vocabulary.go`
  (docs/d090's one-spelling-per-fact rule).
- Three `//nolint` directives, all `nolintlint`-checked: `nilnil` on the
  "no chain configured" `nil, nil` contract (`relaychain.go`),
  `containedctx` on `windowStream.parent` (the `tunnelStream` interface
  carries no context and the session outlives the request), and `unparam` on
  `encodeFrame`'s reserved v1 stream id (docs/d077's additive v3 mux).

### Rejected linters

Recorded so a future reader re-litigates with a reason, not by re-running
`all` (the `biome.jsonc` REJECTED block is the template):

- **Whitespace/style**: `wsl`, `wsl_v5`, `nlreturn`, `lll`, `funcorder`,
  `godoclint`. The repo does not enforce a formatting style; `shfmt` is
  advisory for the same reason (the deliberate column alignment in the run
  scripts).
- **Opinionated / not this idiom**: `noinlineerr` (inline `if err := …` is
  idiomatic Go), `exhaustruct`, `varnamelen`, `paralleltest`, `mnd` (the
  biome `noMagicNumbers` rejection's Go twin — the numeric literals are
  documented facts), `err113`, `dupl`, `nestif`, `gochecknoglobals`,
  `ireturn`, `nonamedreturns`, `forbidigo`.
- **Complexity budgets**: `cyclop`, `gocognit`, `gocyclo`, `funlen`,
  `maintidx` (the biome `noExcessiveCognitiveComplexity` rejection's twin —
  the carriers are deliberately long and WHY-comment-heavy).
- **No-op for this tree**: the library-specific linters (`arangolint`,
  `clickhouselint`, `ginkgolinter`, `promlinter`, `zerologlint`,
  `testifylint`, `sqlclosecheck`, `rowserrcheck`, `protogetter`,
  `spancheck`, and the rest of the 68 that raised zero).

## Pinning

The version is **pinned** in `lint.sh` (`mise exec golangci-lint@2.15.0`),
unlike the floating shellcheck/jq/shfmt legs: a linter's rule set IS the
gate's meaning, so a moving pin would change what green means between runs
(the biome/knip posture, docs/d107). The pin lives in the shim because the
repo commits no `mise.toml` (docs/d051, docs/d082). Termux has no mise and
takes whatever `pkg install golangci-lint` ships (2.15.0 today, built from
source), so a bump there re-runs the survey.

## Consequences

- The Go unit's static surface is gated for the first time: `gofmt`,
  `go vet` (via golangci-lint's `govet`), errcheck, staticcheck, and the
  wave-1 set all run in `./lint.sh`.
- `./lint.sh` needs a working Go toolchain for this leg and **skips loudly**
  without one, the same three-step probe `./test.sh` uses (docs/d123). A
  laptop with no Go cannot be asked to lint Go.
- The gate is offline after install: the module is stdlib-only, so `go list`
  downloads nothing (docs/d122's offline contract).
- The `websocket.go` gofmt drift, the unchecked `Close`/`Encode` returns,
  the unchecked type assertion, and the `log.Fatalf`-after-`defer` in
  `main.go` are fixed rather than suppressed.
- A future Go unit joins the gate by adding its own `.golangci.yml` and a
  `lint.sh` leg; the config is per-unit by construction.

## Alternatives rejected

- **`default: all` with a long disable list.** The inverse of the biome
  posture: the gate would move whenever upstream added a linter, and the
  disable list would carry every library-specific no-op.
- **Run `go vet` and `gofmt -l` directly instead.** Two more bespoke gates
  with no rule-set config, no `nolint` hygiene (`nolintlint`), and no place
  to record a rejection. golangci-lint subsumes both.
- **A repo-root `.golangci.yml`.** It would not survive the docs/d082 split
  and would break the copy-unit rule (docs/d113).
- **Pin via a committed root `mise.toml`.** The repo deliberately commits
  none (docs/d051, docs/d082); a root file would re-pin bare `go` for anyone
  entering the tree.

## Verification status

`golangci-lint config verify` passes; `golangci-lint run ./...` is **0
issues** (golangci-lint 2.15.0, go 1.27.3); `gofmt -l .` empty;
`CGO_ENABLED=0 go build ./...` and `go test ./...` green; the full
`./test.sh` sweep green (264 node checks + the Go suite).
