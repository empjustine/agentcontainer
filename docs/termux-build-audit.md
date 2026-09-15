---
id: termux-build-audit
type: research
status: findings
title: "Termux build audit — Infisical CLI and llm-reverse-proxy native build"
parent: architecture
tags: ["research", "termux", "build"]
---

# Termux build audit — Infisical CLI (`./build.sh`) and `llm-reverse-proxy/`

Findings from verifying, on the termux host (aarch64, bionic, no root,
Go 1.27.1 android/arm64, ~1 GB RAM), whether both build systems actually
work here and whether `./build.sh`'s `go install` path really removes the
checkout upkeep it claims to. Every claim below was executed, not inferred.

## Verdict at a glance

| Component | Verdict |
|---|---|
| `./build.sh` go install path | **Never works** — structurally impossible while upstream go.mod has `replace` directives (all platforms) |
| `./build.sh` checkout build | Works on Termux; verified end-to-end (`git pull --ff-only` + `-checklinkname=0` build, ~50 min) |
| `llm-reverse-proxy` native build | Works untouched — `GOOS=android` binary builds in seconds |
| `llm-reverse-proxy` runtime | Works — serves, streams, and reaches real HTTPS upstreams (models.dev 200 through the proxy) |
| `llm-reverse-proxy` smoke test | Was 28/29 on this host — the one failure was a **harness calibration bug** (absolute timing threshold), fixed; now 29/29 |

## 1. `./build.sh` — the `go install` primary path is dead

The header claimed `go install github.com/Infisical/cli@main` had *replaced*
the checkout-clone maintenance ("no clone, no checkout refresh, no local
build state"). **False**, on two independent counts:

### 1a. Upstream go.mod replace directives (fatal on ALL platforms)

`go install pkg@version` hard-rejects modules whose go.mod carries `replace`
directives. Upstream's does (Infisical forks of `zalando/go-keyring` and
`pion/turn/v4`):

```
$ go install github.com/Infisical/cli@main
go: github.com/Infisical/cli@main (in github.com/Infisical/cli@v0.43.132):
    The go.mod file for the module providing named packages contains one or
    more replace directives. It must not contain directives that would cause
    it to be interpreted differently than if it were the main module.
$ echo $?
1
```

Exit 1, no binary. There is no flag to bypass this; it fails before any
compilation. So the "reduced maintenance" premise was wrong from the start:
the clone + `git pull --ff-only` + `go build` path is the *only* path that
produces a binary, on every platform.

### 1b. Android linkname rejection (the real, narrower issue)

Even if (1a) were resolved, a `go install` binary on Android would need the
checkout build's linker flag: `wlynxg/anet` (via `pion/turn/v4` →
`pion/transport/v3`) uses `//go:linkname` to alias Go's unexported
`net.zoneCache`, and Go ≥ 1.23's default `-checklinkname=1` rejects that on
Android. `go install` cannot pass `-ldflags=-checklinkname=0`. anet has no
newer release; the checkout build with `-checklinkname=0` is the only fix.

### 1c. What was fixed

- Header of `./build.sh` rewritten: the `go install` path is demoted to an
  **opportunistic** fast path (may succeed if upstream ever drops the
  replaces); the checkout build is documented as the **operative** path
  everywhere, with `-checklinkname=0` as the Android-only flag.
- The success signal of the `go install` branch is the binary at the
  expected path, never go install's exit status (an exit 0 without a binary
  must fall through; an exit ≠ 0 must merely warn).

## 2. `llm-reverse-proxy` — builds and works on Termux, as designed

The dual-mode `build.sh` detects `$PREFIX` and builds the native
`GOOS=android` binary (`llm-reverse-proxy-android`, ~7 MB, seconds) —
`GOOS=android` is required for Android's system DNS resolver (no
`/etc/resolv.conf`); that is implemented and correct. Verified:

- `FORCE=1 SKIP_PKG=1 ./build.sh` → exit 0.
- `./generate.sh` → routing table (11 providers), exit 0.
- `./run.sh` (native branch) → proxy up; `GET /models.dev/` → **200**
  through the proxy (real HTTPS upstream, CA-bundle TLS verification and
  Android DNS both fine). No changes needed.

## 3. `smoke-test.sh` — the 29th check was harness-calibrated, not a proxy bug

`streaming-unbuffered` demanded the first SSE chunk in < 250 ms absolute.
On this host it measured ~305 ms — but a **direct** fetch of the same first
chunk from the upstream node process (bypassing the proxy) is also ~300 ms:

| measurement (termux, first chunk, node interval = 100 ms) | time |
|---|---|
| direct: curl → upstream node | 296 / 297 / 317 ms |
| through proxy | 301 / 316 / 330 ms |

Proxy overhead ≈ 0–15 ms — `FlushInterval: -1` is genuinely unbuffered; the
absolute threshold is simply unachievable on this CPU (curl + node spawn +
scheduler dominate). Fixed by making the check **relative**: the baseline is
measured straight from the upstream (port 19091) and the proxy must land
within baseline + 150 ms. Result: `passed=29 failed=0`, exit 0.

## Reproduction summary

```sh
cd ~/agentcontainer
FORCE=1 SKIP_PKG=1 ./build.sh                    # infisical CLI (checkout build)
~/Infisical/cli/infisical --version              # → infisical version devel
cd llm-reverse-proxy
FORCE=1 SKIP_PKG=1 ./build.sh                    # → llm-reverse-proxy-android
./generate.sh && ./run.sh                        # → serves :8080
./smoke-test.sh                                  # → passed=29 failed=0
```

The `run.sh` container branch and the multi-stage `Containerfile` remain the
container-host path and were not exercised here (no container runtime on
Termux — by design, see `docs/termux-serving.md`).
