---
id: d052
type: architecture-design
status: active
title: "d052 — tombstone: no staged credentials file (auth.json retired)"
parent: coding-agent
depends-on: [coding-agent]
references: [d030, d042]
tags: [coding-agent, credentials, tombstone, documentation]
---

# d052 — tombstone: no staged credentials file

**Status:** standing rule — `auth.json` staging does not exist in this tree.

Long after the tree stopped having one, several live docs and two decision
records still described a staged `auth.json` (pi's credentials file, copied by
`coding-agent/run.sh`). The file was never committed, never tracked, and
`run.sh` stages only `settings.json`, `models.json`, `opencode.jsonc`
(`coding-agent/DESIGN.md`). Per d042 / FR-D2, decision-record bodies are never
rewritten — a newer record is the sanctioned tombstone older mentions point
at. This is that record.

## Drivers

- Four live docs claimed `auth.json` was staged or committed (README quick
  start + layout, FR-U1 in `docs/requirements.md`, `docs/architecture.md`
  ×2) while DESIGN.md and the code said the opposite — a ghost that kept
  resurfacing in audits.
- `docs/scoped-models-and-proxy-overrides.md` even advertised an
  `example.auth.json` template that never existed.

## Decisions

- **No staged credentials file, ever.** The explicit chain
  (`lib/environment.sh`, `docs/d046-infisical-run.md`) does the single
  `infisical run` round-trip on the host; plain env is forwarded into the
  workload via the `workload_env` allowlist, and pi resolves the `"$VAR"`
  apiKey references in the generated `models.json` at request time.
- **Only this record, the immutable d0XX bodies, and `docs/archive/` may name
  `auth.json`.** Live docs and code must not cite it. (The one other
  occurrence — the OpenCode row of `docs/coding-harness-persistence.md` — is
  OpenCode's own `~/.local/share/opencode/auth.json`, a third-party file, and
  stays.)
- Older mentions are history, not re-adoptable design: `d020` (cloud-init
  sketch), `d028` (layering comparison), `docs/archive/endpoint-runtime-
  rewiring.md`, `docs/archive/future-config-generator-system.md`.

## Invariants

- `run.sh` stages exactly `settings.json`, `models.json`, `opencode.jsonc`;
  a credentials file appearing in staging code is a regression against this
  record.
- `settings.json` stays credential-free.

## Out of scope

- OpenCode's own `auth.json` under its data dir (third-party storage).
- The retired peers-only serving mode — covered by
  `docs/environments-and-peer-variants.md` and the container-tooling
  environment table.

