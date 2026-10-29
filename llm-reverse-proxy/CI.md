---
id: llm-reverse-proxy-ci
type: reference
status: deferred (until the d082 standalone-repo split; findings recorded now, no workflow exists)
title: "GitHub Actions for llm-reverse-proxy — findings, deferred until the split"
parent: llm-reverse-proxy
tags: ["ci", "github-actions", "build"]
---

# GitHub Actions for llm-reverse-proxy — findings, deferred until the split

Findings from a dry-run assessment of building and testing this unit on
GitHub Actions. **No workflow exists yet, deliberately**: d082 moves the
unit to its own repository, and a workflow added here would have to be
migrated with it days later (the `git filter-repo` checklist in d082 §4
must carry `.github/workflows/llm-reverse-proxy*.yml` when it runs).
d082 §4.3 already reserves "CI running `go test ./...` + the
canonical-json check" as a split step; this file is the working notes
for that step, recorded before context is lost.

## What the workflow must do (verified facts)

1. `actions/checkout`, then Go: `actions/setup-go` with
   `go-version-file: llm-reverse-proxy/go.mod`. The unit has zero
   external deps (34-byte go.mod, module + go directive only) and no
   toolchain install step — `lib/go-build.mjs`'s `go build` needs
   nothing but a modern Go.
2. `go test ./...` — hermetic: tests are `httptest`-based, no
   `os.Getenv`, no network, no tailnet, no `testing.Short` skips.
3. Node 24 for the generators and the canonical-json test — the
   friction point. `lib/node-run.sh` resolves `mise exec node@24`;
   there is **no repo `mise.toml`** (d051/d082: the pin lives only in
   the shim, deliberately — a root mise.toml would re-pin bare `node`
   for anyone cd-ing into the repo). CI must use `jdx/mise-action` +
   `mise install node@24`, not rely on a checked-in config.
4. Generator drift gate (cheap, hermetic):
   `./llm-reverse-proxy/generate.sh` then
   `git diff --exit-code llm-reverse-proxy/` — generate.mjs is fully
   offline (no fetch; static passthroughs of models.dev/catwalk data
   plus vendored PI_AI_PROVIDERS).
5. `./lib/node-run.sh tests/canonical-json.test.mjs` — the check d082
   §4.3 names.
6. `./llm-reverse-proxy/build.sh llm-reverse-proxy-image` — **the
   shim, never an inline `podman build -f`** (d041/d083/d087 law: one
   build implementation; inlining `imageBuildArgs`/`--pull`/tag
   logic into the workflow would create a second one to drift).

## Node.js is a monorepo convenience, not a business requirement

Node@24 is load-bearing three times in this unit's pipeline today: the
root builder the shim runs (`build.mjs`), `generate.mjs` (the routing
table emitted from the shared fact tables), and
`tests/canonical-json.test.mjs`. All three are monorepo structure, not
unit requirements: the same node is implicitly required for
`./coding-agent/` generation anyway and is present on every host in
use — but the unit's product is one Go binary plus one JSON config.
Cross-language dependencies should be minimized where possible.

Post-split shape this points at (it feeds d082 §4 step 4's fact-data
decision):

- steps 3–5 above (node@24, the drift gate, the canonical-json test)
  move into a **path-filtered maintainer job** that runs when the fact
  tables or the generator change — not on every build;
- the per-change CI-critical path degrades to plain `go build` +
  `go test ./...` with no node at all;
- the canonical-json guard stays BESIDE generation rather than getting
  a go port: it validates the generator's output format (key
  canonicalization, docs/d050), which the Go binary itself never
  observes — so it belongs with the job that regenerates.

## Cross-build artifacts: Termux android/arm64 and arm32v5 — both are plain Go cross-compiles

Both build on any linux/amd64 runner with nothing but Go — CGO off in
both cases, no NDK, no extra toolchain:

- **Termux android/arm64** — the preset already exists
  (`androidBuildEnv`, lib/go-build.mjs):
  `CGO_ENABLED=0 GOOS=android GOARCH=arm64`. It is NOT bionic-linked,
  despite being a "Termux binary": the output is static, no libc —
  GOOS=android only switches the stdlib DNS resolver to Android's
  paths instead of the missing `/etc/resolv.conf`. Prerequisites:
  build.mjs selects the preset ONLY via on-device detection
  (`$PREFIX` under `com.termux`), and registers
  `llm-reverse-proxy-native` only when NO container tool exists — a
  docker-equipped runner `noteGated`s it. What's missing is an
  explicitly selectable cross target in the builder (post-split: the
  unit's own build.mjs); the workflow then invokes the target NAME,
  never its flags (one-build law, d041/d083/d087).
- **arm32v5 (EN7562CT, MikroTik e50ug)** — `GOOS=linux GOARCH=arm
  GOARM=5 CGO_ENABLED=0` compiles the same trivial way. No preset or
  target exists today (the arm5 runner retired with its whole folder —
  archive only), so this is a new builder target as well. A static
  no-libc binary is the friendliest possible artifact for a 128 MB
  flash router. Device-side execution is a SEPARATE question from
  building: the RouterOS 7 variant is retired
  (docs/environments-and-variants), so re-adding the device is a
  deploy story, not a CI story.
- **CI-side verification**: qemu-user-static on the runner can execute
  both artifacts (armv5, arm64-linux) for a boot/`-version` smoke —
  not wired today; the full smoke-test.sh (ports, funnel, badssl)
  stays a same-arch affair.
- Artifacts land via `actions/upload-artifact`; the OCI image build
  stays amd64 (the Containerfile has no cross TARGETPLATFORM wiring).

## Runner friction (must-check on the first real run)

- **Paths filter** must include `llm-reverse-proxy/**`, `lib/**`,
  `build.mjs`, and the workflow itself: the shim delegates to the root
  builder, so a `lib/` edit changes whether and how the image builds.
- **Buildx lands in the daemon store** under the runner's default
  docker driver (`docker buildx build` without `--load`); verify with
  `docker image ls` on the first run before adding any push step.
- **`cloudReachable()` gate** (models.dev HEAD canary via
  `lib/host-capabilities.mjs`) registers the image target only when
  outbound cloud answers: a models.dev outage makes the target
  selection empty → exit 91, red build. No env override exists —
  accepting that flake, or adding a CI-scoped override, is its own
  decision (d087-era capability law: gates key on network facts).
- **`llm-reverse-proxy-native`'s "target not registered" warning** on
  a container-capable host is expected and harmless (noteGated).

## Optional follow-ups (not required for a green build)

- **GHCR publish**: `permissions: packages: write`, GITHUB_TOKEN
  login, push gated to `push` events (fork PRs get read-only tokens);
  consumers then slave `vpn-exit.sh`/`vpn-relay.sh` via their existing `IMAGE_TAG` env.
- **`./lint.sh` + `./check-types.sh`** as extra jobs — both hermetic
  (shellcheck via mise; typescript@5.9.3 + @types/node@22 installed by
  check-types.sh itself).

## Verification limits

Nothing here has run on a real runner; every step above is a reading of
the scripts, not an execution. The first real workflow must validate:
mise resolution of node@24 on the runner image, the buildx daemon
landing, and the cloud gate's exit-91 behavior during a models.dev
outage.
