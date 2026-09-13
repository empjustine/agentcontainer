# d031 — llm-reverse-proxy flow: complexity audit and simplification options

status: proposal (nothing decided) · parent: architecture · relates-to: d027,
d028, termux-build-audit

## Scope of the flow (as measured)

The proxy is deliberately the smallest runner in the tree — and that is its
maintainability model:

| Piece | Size | Role |
|---|---|---|
| `main.go` | 343 ln, **zero deps** | passthrough router: config, provider parse, RFC 9457 problems, error taxonomy, server |
| `run.sh` | ~80 ln | dual mode: container (host network) / native binary |
| `build.sh` | ~100 ln | triple mode: Termux android binary / OCI image / bare host binary |
| `smoke-test.sh` | ~205 ln | builds binary, node upstream, 32 behavioural checks (incl. badssl TLS taxonomy) |
| `generate.sh` + `generate-config.mjs` | ~45 + 150 ln | routing table from the shared provider fact table |

Findings here are mostly "already at the target shape"; the value of this
note is to keep it that way and to flag the few mutable spots.

## Findings

**F1 — `main.go` is the floor, not a refactor target.** 323 lines, stdlib
only, one concern per type (`provider`, `problem`, `server`), the error
taxonomy (`classify`, ~56 ln) is the largest function and is a flat
`errors.As` cascade. This is the shape to *protect*: no new dependencies, no
model routing, no credential handling (the README table is the contract). Any
feature request that would add a second concern should be answered with
"another proxy, not a flag".

**F2 — `build.sh` triple-mode, with one reducible branch.** On container
hosts it builds the image AND the host binary, marked "convenience extra for
smoke-test.sh / direct runs" — but `smoke-test.sh` already builds the host
binary itself when missing, so the convenience branch exists only for manual
direct runs on a host that also has a container runtime. Dropping it makes
build.sh cleanly dual-mode (Termux native vs image) and removes its
`_go_ready` mise-shim hedge from the container branch. Cost: a manual
`CGO_ENABLED=0 go build` one-liner for direct runs (documented in the header
if taken).

**F3 — two config paths.** Container: ro-mount at
`/etc/llm-reverse-proxy/llm-reverse-proxy.json`; native: `./llm-
reverse-proxy.json` next to the binary. Both correct; worth one sentence in
the README, not a refactor.

**F4 — stale reference pointer — RESOLVED 2026-09-12.** The README cited
`~/Downloads/references/github/mostlygeek/llama-swap/` (llama-swap
internals) as if it were the reference; that checkout does not exist on the
current host (and d029/d030 note llama-swap's `cmd`-shlex constraint
independently). The README now cites the canonical upstream
(github.com/mostlygeek/llama-swap) and demotes any local mirror path to an
optional cache.

**F5 — smoke-test is self-contained by design.** ~205 ln including the
node upstream and the badssl TLS taxonomy (10 of the 32 checks; internet-
dependent section already skippable via `BADSSL_DOWN`). The relative
streaming threshold (first-chunk vs direct baseline) fixed in
`termux-build-audit.md` is the pattern to keep: no absolute timing constants.

**F6 — the `sleep 2` + `logs | head` after container start** is cosmetic
readiness theater: llama-swap-style swap services answer when ready and the
smoke test does its own wait-loop. Harmless; trim only if touching the file
anyway.

## Options

1. **Dual-mode build.sh** (F2): delete the container-host host-binary branch.
   Small, real branch-count reduction.
2. **README touch-ups** (F3+F4): one config-paths sentence; fix/soften the
   reference pointer.
3. **Keep-everything-else**: no code changes. The flow's complexity budget is
   currently well spent — smoke-test's 29 checks are the reason the Termux
   native build could be verified cold in termux-build-audit.md.

## Cross-flow notes (shared with d029/d030)

- The env-allowlist question does not arise here: the proxy holds no secrets
  by design (no `workload_env` calls at all) — the strongest argument for
  keeping credential handling OUT of this component permanently.
- `generate.sh`/`generate-config.mjs` already consume the shared fact table
  (`lib/cloud-providers.mjs`, d024/d027); nothing to dedup.
- If d030's "stage on the host, mount once" pattern lands, this flow is
  already compliant (single config ro-mount).

## Recommendation

1 and 2 whenever convenient; otherwise leave this flow alone. Its role in
future work is the *donor* of patterns (zero-dep, table-driven config,
behavioural smoke test), not a refactor target.
