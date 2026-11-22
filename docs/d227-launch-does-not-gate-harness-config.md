---
id: d227
type: module-design
status: active
title: "d227 — the launcher gates no harness config: exit 94 retires with the artifact gate"
parent: coding-agent
depends-on: [d041, d054, d065]
references: [d052, d061, d070, d108, d216, d225, coding-harness-persistence]
tags: [coding-agent, launcher, artifacts, models-json, exit-codes, validation]
---

# d227 — the launcher gates no harness config

**Status: landed.** `coding-agent/run.mjs` no longer checks what the mounted
harness dirs contain. Exit 94 is gone from the launcher's contract, and the
canonical-URL verifier keeps only its generation and review roles.

## Problem

`artifactGate` stood between `ensureHostState` and the launch, and refused the
start in two ways:

- `settings.json`, `models.json` and `mcp.json` had to EXIST in the agent dir,
  else exit 94 naming the generator (`./npm-run.sh coding-agent generate`).
- The installed `models.json` was re-verified at every launch: a spawned
  `check-canonical-artifacts.mjs` parsed it with strict `JSON.parse` and
  required every provider URL to be the fact-table upstream, else exit 94.

Both moved into the launcher when the config was a per-run STAGE the launcher
built (d041, d054): a missing staged file really did mean nothing would load,
and the copy was the launcher's own output. d216 then mounted the host dirs
directly, so the files became host state the launcher mounts and the harnesses
read — but the gate stayed.

Three premises have since expired, and each is measurable:

- **A missing `models.json` no longer means a broken pi.** The pinned pi
  composes its bundled catalog, its `models-store.json` dynamic catalogs and
  extension-registered providers, with `models.json` an optional override layer
  above them (upstream `docs/configuration.md` lists it beside
  `settings.json` and `mcp.json` as user config). This folder's own
  `pi-*` packages register their providers with `apiKey: "$<KEY>"` and
  `refreshModels`, so no `models.json` row is needed for them either.
- **Strict `JSON.parse` rejects files pi accepts.** pi reads `models.json` as
  JSONC (comments and trailing commas) and reports a broken one as a warning
  rather than refusing to start. Measured against the old gate: a JSONC
  `models.json` exited 94, and so did a zero-byte one.
- **The installed manifest and pi's real config had already divorced.** On the
  host this record was written on, the agent dir's `models.json` was
  `{"providers":{}}` — a shape `generate.mjs` itself refuses to write
  (`installModels` aborts at zero providers, d063) — while pi's live dynamic
  catalog sat in `models-store.json`. The gate was demanding an artifact that
  no longer carries the providers, while the file that does was never checked.

## Decision

**R1 — Config content is not the launcher's business.** Existence, parseability
and URL form of `settings.json`, `models.json`, `mcp.json` and
`opencode.json` are outside the launcher. A launch starts, and whatever a
harness makes of its config reaches the operator inside the session — where the
harness itself reports it.

**R2 — Exit 94 retires; nothing reuses the number.** A launch has no status to
report about file content. Wrappers and docs that quote 90–93 for this entry
point stay correct; a wrapper still waiting for 94 waits for nothing.

**R3 — The credential gates stay.** `auth.json` content (exit 93) and the
`providers.json` / `installation.json` warnings are about a CREDENTIAL STORE
riding a read-write host mount (d052, d216), not about whether config parses.
The distinction is the mount: a key in the sandbox is the launcher's problem; a
typo in a model list is the harness's.

**R4 — The argv and mount gates stay.** A DIRECTORY that is not a directory or
resolves to `$HOME` (exit 90), a missing required mount source (91) and a
host without a container backend (91) are facts the launcher assembles itself.
They refuse before anything is created, and they are unaffected.

**R5 — The canonical-URL verifier keeps two roles, not three.**
`check-canonical-artifacts.mjs` still guards the committed snapshots
(`tests/artifact-urls.test.mjs`) and still runs inside generation. It no
longer runs over the agent dir, so a route-form leftover in host state is caught
by a committed-snapshot review or by regenerating, never by a refused launch.

**R6 — The opencode overlay warns; pi's artifacts do not.** A missing
`opencode.json` costs the provider reroute the generator installed, which is
worth one line. A missing or hand-edited pi artifact costs nothing a warning
would prevent: pi starts on its bundled catalog and its extension providers
either way.

**R7 — Generation is unchanged, and it is no longer a precondition.**
`generate.mjs` still installs `settings.json`, `mcp.json` and
`models.json` into the agent dir, and opencode's overlay into the host config
dir (d054, d065). What it writes is a convenience for the next launch, not a
contract this launcher enforces — a broken install surfaces where it is visible,
inside the harness.

## Verification status

Measured against the retired gate (stub `podman`, isolated `$HOME`, one file
varied per run), then re-measured after the removal:

| agent-dir state         | before | after |
| ----------------------- | ------ | ----- |
| `{"providers":{}}`      | 0      | 0     |
| no `models.json`        | 94     | 0     |
| zero-byte `models.json` | 94     | 0     |
| JSONC `models.json`     | 94     | 0     |
| garbage `models.json`   | 94     | 0     |
| no `settings.json`      | 94     | 0     |
| no `mcp.json`           | 94     | 0     |
| no `opencode.json`      | 0      | 0     |
| populated `auth.json`   | 93     | 93    |

`tests/check-run-dirs.test.mjs` carries the regression: its fixture installs no
generated config at all, one test launches against that empty agent dir, and
another launches over an intentionally JSONC `models.json`.

## Consequences

- **A bad host `models.json` can now reach a session.** pi reports it itself
  (a file-path-aware warning in the TUI); the launcher no longer pre-empts it.
  Accepted: the alternative refused launches pi accepts.
- **The launcher has one fewer failure mode to document.** Its exit-code
  contract is 90–93, and the artifact-free start is a single code path with no
  generator pointer in it.
- **The committed-snapshot check is the only URL-form gate.** It is stronger
  where it applies (every committed artifact, every `./npm-run.sh`
  generation) and blind to host state, which is the deliberate trade: reviewable
  bytes, not a mutable mount.
- **The generator's install and the launcher's expectations can no longer
  disagree**, because the launcher has no expectations left to disagree with.

## Alternatives rejected

- **Keep existence-only (no parse, no URL check).** Still refuses a launch over
  host state pi starts on; `models.json` and `mcp.json` are optional upstream,
  so the check would encode this folder's preferences as a start refusal.
- **Downgrade the gate to warnings.** A warning on every missing artifact of a
  harness that does not need them is noise — R6 keeps the one line that names a
  real cost.
- **A JSONC-tolerant gate.** Fixes the measured false positive and keeps the
  premise: a launch still validates a file its own harness tolerates.
- **Validate only the committed snapshots from the launcher.** That is R5
  without the mount-time cost: the committed copy is already covered by tests
  and by generation.

## Superseded decisions

This record retires the launch-time half of:

- **d041's** "stale/missing artifacts are user issues; a runner fails loudly" —
  it stays true for the local-inference and generate entries, and no longer
  describes this launcher.
- **d065's** contrast between opencode's tolerated partial config and pi's
  exit-94 abort: the asymmetry is gone, and the tolerated shape is the rule.
- **d225's** worked example — `artifactGate` no longer exists as a gate;
  `credentialGate` and `requireMountSources` carry the same shape.

The records keep their text (d072's curated history); the "Superseded in part"
notes in d041, d065 and d225 point here.
