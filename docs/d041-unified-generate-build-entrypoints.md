---
id: d041
type: decision
status: implemented
title: "d041 — unified generate/build entrypoints; runners never build or generate"
parent: d023
tags: ["generators", "builders", "runners", "entrypoints"]
---

# d041 — unified generate/build entrypoints; runners never build or generate

Follow-up to the d039 lib/ fold-back. Four moves, registered together because
they reshape the same surface: who can invoke generation/building, from where,
and in what language.

## Problem

1. `node_run` (repo-pinned node interpreter selection: system node on Termux,
   `mise exec node@24` elsewhere) lives inside `lib/workload-runtime.sh`, a
   315-line container-description API — buried for a general-purpose helper,
   and duplicated verbatim in `coding-agent/generate.sh` (which shadowed it
   with a `mise x` variant).
2. Generation is orchestrated by three per-folder `generate.sh` shells
   (391 + 94 + 45 lines) whose logic is cp/mkdir/env/spawn plumbing — shell
   reimplementations of what the .mjs generators already do in-process.
3. Building is scattered over four `build.sh` shells with duplicated logic:
   the go toolchain probe + Android flag recipe exists in
   `llm-reverse-proxy/build.sh`, and image pulls/builds run one-per-invocation.
4. Runners still reach back into generation/building
   (`coding-agent/run.sh` auto-runs generate.sh inside the container on every
   launch; a `GENERATE=1` hook is documented in two runners), so a runner can
   half-mutate config as a side effect of serving.

## Decisions

### (a) `lib/node-run.sh` — the visible sh lib

`node_run` moves to its own `lib/node-run.sh`, self-contained (its Termux
profile check is a `case` inside the function — no `_termux` global, no
source-order coupling). `lib/workload-runtime.sh` sources it so existing
consumers keep working; the generate.sh copies die with the shells. This is
the interpreter-selection lib any repo shell script can source standalone.

### (b) One `generate.mjs` per folder + root "generate everything" entry

Per folder (the fallback the request allows, needed for the copy unit — the
in-container run can only mount its own folder + `../lib`):

- **`coding-agent/generate.mjs`** (~350 L): 1:1 port of the shell
  orchestration — scratch staging, settings install, stage sequencing,
  default-model merge, models.json install with the 0-provider guard,
  opencode stage, SKIP_GEN/DRY_RUN semantics. The d037 stage modules stay
  separate files and are spawned as child processes (the narrow-merge verdict
  holds; layer independence is the point). Stages run via
  `process.execPath` — the orchestrator itself was already resolved through
  the pinned node by the shim.
- **`llm-local-inference/generate.mjs`** (~470 L): `gen-lib.mjs` +
  `generate-general.yaml.mjs` + `generate-local-llm-models.yaml.mjs` fold in
  (all single-consumer, 424 L total) and the top-level bodies become
  `generateGeneral()` / `generateLocalInference()` under the ported
  capability gate. The config.d layer contract (d018) is unchanged —
  scripts fold, layers don't.
- **`llm-reverse-proxy/generate.mjs`**: `generate-config.mjs` renamed and
  the 45-line shell folded in — it was already the one generator.

Each folder's `generate.sh` remains as a 3-line interpreter shim
(`. ../lib/node-run.sh && node_run generate.mjs`) — same invocation paths as
today, so doc references don't move; the shell carries zero logic.

**Root `generate.mjs`** spawns each folder's `generate.mjs` sequentially
(cheap/offline first: proxy, local-inference, coding-agent), continues past a
failed folder (a GPU-less host failing local-inference must not block the
other two), and exits non-zero if any folder failed. That is "generate
everything at once" without violating the standalone rule — the root entry
only spawns, never imports across runner folders.

### (c) Root `build.mjs` — builders in node, parallel on container hosts

- Target table: coding-agent OCI image, llama-swap image pull,
  llm-reverse-proxy OCI image, llm-reverse-proxy native binary, Termux
  provisioning.
- **Container hosts: image targets run in parallel** (`Promise.all`) — all
  base images at once. **Termux: strictly serialized** (provisioning →
  android binary) — ~1 GB devices cannot parallelize go builds.
- `lib/go-build.mjs` centralizes the go toolchain probe (PATH → mise shims →
  `go version` exec test — a `command -v go` hit is not proof) and the
  Android/host flag presets. `llm-reverse-proxy/smoke-test.sh` keeps its own
  host-binary build (test harness, pre-existing).
- The three per-folder `build.sh` files are deleted; their per-target logic
  (tri-mode detection, FORCE) ports into the target table. Their
  **idempotency guards do NOT port**: the old skip-if-present checks (image
  `inspect` / binary file-exists, ported from the old proxy build.sh) keyed
  on tag/file PRESENCE, so a source edit after a build left the stale
  image/binary in place unless the operator knew `FORCE=1` — a silent-
  staleness trap (caught in review after the first implementation). The
  caches already provide idempotence by CONTENT: a container build on
  unchanged inputs is a layer-cache hit (seconds) and go's build cache is
  content-addressed, so targets always run and pick up changes without a
  flag. `FORCE=1` is therefore redefined as cache-bust: `--no-cache` for
  image builds, `-a` for go.
- **Root `build.sh` becomes `lib/provision-termux.sh`** (git mv, unchanged
  body): it is environment provisioning — `pkg`, git clone/pull, the infisical
  checkout build — not artifact building. It stays shell on purpose: every
  path in it is Termux-only and cannot be regression-tested from a container
  host; a blind port would be risk with no behavioral gain. `build.mjs`
  invokes it as the serialized first stage on Termux. The root `./build.sh`
  name becomes the shim into `build.mjs`, so existing references to
  `./build.sh` keep resolving.
- `BUILD_PLAN=1` logs the chosen target set without executing (the only
  testable mode from a container host for the Termux branch).

### (d) Runners never build or generate

Stale/missing artifacts are user issues; a runner's job is to fail loudly and
point at the generator/builder, never to fix state implicitly:

- `coding-agent/run.sh`: the in-container launch chain no longer runs
  generate.sh — it stages the committed config (settings.json, models.json,
  opencode.jsonc) and execs bash. Missing committed models.json is
  `log_die` with "run ./generate.sh first". The `GENERATE` hook (Termux) and
  the generate tee/rc machinery die; the generator mounts stay so an
  in-container session can still regenerate manually via the shim.
- `llm-local-inference/run.sh` and `llm-reverse-proxy/run.sh` already follow
  this contract (`log_die` "generate/build it first"); messages updated for
  the new entrypoints.

## Consequences

- Scratch staging, mount lists and `tsconfig.json` change: shims mount
  `generate.mjs` + `lib/node-run.sh`; staged lists drop modules the
  orchestrator no longer spawns. `count-providers.mjs`/`list-providers.mjs`
  (whose only consumers were the former shell install-condition count and
  per-provider report loop) were pruned in this change — the orchestrator
  absorbed both contracts inline (a later d023-era "possible follow-up"
  resolved by removal, not merging).
- Committed artifacts (models.json, opencode.jsonc, config.d,
  llm-reverse-proxy.json) are the only run-time inputs. Refreshing them is
  `./generate.sh` (per folder) or `./generate.sh` at the root (everything).
- `lib/` gains `node-run.sh`, `go-build.mjs`, `provision-termux.sh`;
  `workload-runtime.sh` shrinks (`node_run`, `default_run_dir`, `_termux` leave
  with the shells that consumed them).
- Historical decision docs keep the old file names; live runbooks
  (README, SPECs, architecture, termux-serving, container-tooling) are updated
  in this change.

## Verification record

- Static: `tsc --strict` clean (tsconfig includes the four new `generate.mjs`
  + `build.mjs` + `lib/go-build.mjs`); biome 0 findings; `node --check` on
  every `.mjs`; shellcheck on every `.sh` — only pre-existing findings remain
  (`llm-reverse-proxy/run.sh` SC2153 ×2, `smoke-test.sh` SC2034/SC2086, all
  present at HEAD); `tests/check-workload.sh` 4/4 (the `node_run` extraction
  did not disturb the description API).
- Proxy: `llm-reverse-proxy/generate.mjs` output is byte-equivalent to the
  committed `llm-reverse-proxy.json` (ex `fetchedAt`): 220 routes,
  `perSource: {pi-ai:31, models.dev:182, models.dev(npm):14, catwalk:34}`,
  overruled 8, skipped 24.
- Local inference: on this keyless, GPU-less, container-tool-less host the
  gate fires (`exit 94`, loud message) AFTER the general layer is written;
  `LOCAL_INFERENCE=1 DRY_RUN=1` produces both `.dry-run` previews.
  The committed vault-era `config.d/10-*` artifacts (baked for the GPU host)
  were restored from HEAD after the test run pruned them — faithful old-shell
  behavior (stale-layer removal on non-viable hosts), but they are committed
  artifacts this host cannot regenerate.
- Coding agent: `AGENT_DIR=/tmp/... node generate.mjs` end-to-end — settings
  install, 4 direct-mode providers merged (cline-pass **13 models**, d040
  intact), default model `cline-pass`/`z-ai/glm-5.3-flash` (d036 intact),
  opencode.json staged to `OPENCODE_CFG_DIR`.
- Root dispatcher: `./generate.sh` runs all three folders, continue-on-
  failure, exit 1 when any failed (here: local-inference 94 — the documented
  gate for this host class). One real bug found and fixed in verification:
  the root `repoRoot` used a double `dirname` (copied from the folder-level
  pattern), spawning `~/<folder>/generate.mjs`.
- Root builder: `BUILD_PLAN=1 ./build.sh` logs the chosen target set and
  exits 0 (here: the bare-host `llm-reverse-proxy-native` target, image
  targets skipped with a warn). The native target was exercised for real
  (mise `go@1.27`): first build 6.6s, unchanged-source rebuild 0.45s (go
  cache), rebuilt source picked up without a flag, `FORCE=1` full rebuild
  6.4s — confirming the presence-skip removal (idempotence by cache, not by
  skip) costs nothing and removes the staleness trap.
- Vault-era live state: the verification run that used the default `AGENT_DIR`
  rewrote `~/.pi/agent/models.json` — restored to the d040-compliant state by
  re-running generation with `AGENT_DIR=~/.pi/agent` (13-model
  cline-pass; the pre-test live file was the stale 445-model pre-d040 output)
  and re-applying the pi-runtime settings fields (theme/lastChangelogVersion)
  from the installer's own backup.
