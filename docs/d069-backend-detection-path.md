---
id: d069
type: decision
status: implemented
title: "d069 — the workload backend is detected through PATH, the way it is invoked"
parent: lib
depends-on: [d059]
references: [d056, d059, d068]
tags: [workload, podman, docker, testing, lib]
---

# d069 — backend detection resolves through PATH

**Status: implemented.** `detect_workload_tool()` in `lib/workload-runtime.sh`
probes with `command -v podman` / `command -v docker` instead of
`-x /usr/bin/podman` / `-x /usr/bin/docker`.

## Problem

Detection and invocation used two different answers for one question.
`workload_run()` launches `$_workload_tool container run ...` — a bare name,
so the tool that actually runs is whatever PATH resolves at that moment. The
probe, meanwhile, only ever looked at /usr/bin. Consequences:

- a PATH hit shadowing /usr/bin/podman (a wrapper, a mise shim) was declared
  irrelevant by detection and then used by the launch: the check could
  neither confirm nor deny the thing it exists to confirm;
- a backend installed outside /usr/bin produced `no workload backend
  available` (exit 91) on a host where the launch would have worked;
- **no test could drive a runner end-to-end.** A stubbed tool on PATH is
  invisible to the probe, so `tests/check-run-dirs.sh` — which needs
  `coding-agent/run.sh` to run all the way to `workload_run` to see the
  container argv — had nothing legal to hang the stub on. That gap is why
  the d068 class of bug (folders mounted at the wrong in-container path) had
  no gate: shellcheck cannot resolve `$_home`, lint.sh only compiles the
  renderer, and `tests/check-workload.sh` renders host==guest pairs by
  construction.

## Decisions

1. **One resolution rule.** Detection asks the same question the invocation
   answers — `command -v` on the tool name — so what was detected and what
   runs are the same binary. Podman before docker, as before.
2. **The fail-fast gate is untouched** (d059): no backend still means exit 91
   before any staging, launch chain or mount manifest exists.

## Invariants and consequences

- Every host that satisfied the old probe still satisfies this one (/usr/bin
  is on PATH), so the change is additive: it can only find more backends.
- Detection now picks up PATH-provided stubs, which is exactly what
  `tests/check-run-dirs.sh` relies on — a stub is a backend as far as the
  launcher is concerned, and the test proves the launcher's argv without
  touching a real container.
- `lib/host-capabilities.mjs` still probes `/usr/bin/podman` for capability
  reporting (a different question: is the SYSTEM install there); this record
  does not change it.

## Alternatives considered

- **Leave the probe and let the test patch run.sh (or a copy of it) to flip
  the gate.** The test then stops exercising the real file, and the
  detection/invocation split survives untouched. Rejected.
- **BASH_ENV-injected shim for `[` in the test.** Works only for bash, hides
  the split behind alias/function trickery, and would break the moment run.sh
  stops using bash for its probe. Rejected.
- **A `WORKLOAD_TOOL` env override.** Ambient env is not a config surface
  (d060) and the environment must not choose the isolation backend. Rejected.
- **Invoke the absolute path detection probed.** Symmetric in the other
  direction, and it would break backends that work today through PATH.
  Rejected.

## References

- `lib/workload-runtime.sh` — `detect_workload_tool()`, `workload_run()`.
- `tests/check-run-dirs.sh` — the argv gate this makes possible.
- `docs/d059-container-only-run-sh.md` — the fail-fast exit 91 this keeps.
- `docs/d068-home-relative-mount-targets.md` — the bug the argv gate pins.
