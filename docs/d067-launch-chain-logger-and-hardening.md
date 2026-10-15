---
id: d067
type: architecture-design
status: implemented
title: "d067 — coding-agent/run.sh: self-contained launch chain (no logger mount), hardening deliberately off"
parent: coding-agent
depends-on: [coding-agent]
references: [d026, d041, d045, d054, d056, d065, d066, coding-harness-persistence, container-tooling]
tags: [coding-agent, mounts, logging, hardening, sudo, sandbox]
---

# d067 — No in-container logger, and why hardening stays off

**Status: implemented.** Two audit findings against `coding-agent/run.sh`,
settled together because both are argv-level decisions about what the sandbox
is granted:

1. The in-container log line and the `lib/log.sh` ro-mount that fed it are
   gone. The launch chain is self-contained (env pins + `exec bash`), so no
   repo file is mounted into the sandbox any more.
2. `workload_hardening()` stays uncalled — deliberately, and now with the
   reason in the code. The other two runners harden; this one cannot while
   the agent is expected to `sudo`.

## Problem

**The logger was the last repo-tree bind.** `run.sh` ro-mounted
`$REPO_ROOT/lib/log.sh` to `/opt/lib/log.sh` so the generated launch chain
could source it and emit exactly one line
(`log_info "launching interactive bash" agentDir=…`). Nothing else in the
container read it: `lib/log.sh` has no `export -f`, and `launch.sh` is
`/bin/sh`, so no log function survives `exec bash`. A host repo file was
bound into every sandbox for a single JSON line.

The line's only unique value was attestation — it was emitted *inside* the
container, so it proved the shell actually started. That is worth little here:
the host already logs `starting container` immediately before `workload_run`
(which then blocks, foreground `-it`), and the operator's real readiness
signal is the bash prompt. What the line cost was a permanent repo→sandbox
coupling that kept the "the generator tree is NOT mounted" claim (docs/d041,
docs/d056) only almost true.

**The missing hardening was undocumented.** `coding-agent/run.sh` is the only
runner that never calls `workload_hardening()`; both siblings do
(`llm-reverse-proxy/run.sh`, `llm-local-inference/run.sh`). Nothing in the
tree said why, so the omission read as an oversight — and the "obvious fix"
(copy the sibling's call) would silently break the sandbox.

## Decisions

### (a) No in-container logger; no repo file mounted

The heredoc drops `. /opt/lib/log.sh`, `LOG_TOOL='coding-agent/launch'` and
the `log_info` call; the `workload_ro "$REPO_ROOT/lib/log.sh"` mount is
deleted. The host-side `starting container` line is now the launch marker,
and its comment says so. `LOG_TOOL='coding-agent/launch'` disappears from the
log stream — nothing consumed it (repo-wide grep: one occurrence, the
assignment itself).

Consequences accepted: no container-side attestation of the shell start, and
the marker now prints before podman's own output rather than after it. Both
were judged cheaper than the bind.

### (b) `workload_hardening()` stays off — the sudo hatch wins

The image grants the sandbox user `NOPASSWD:ALL` sudo
(`coding-agent/Containerfile`), which is how the agent installs a system
package mid-session. Hardening and that hatch are mutually exclusive by
construction:

- `--security-opt no-new-privileges` sets `PR_SET_NO_NEW_PRIVS`
  (inherited, cannot be cleared). At `execve` the kernel then refuses to add
  privileges: the setuid bit and file capabilities are ignored. Debian's
  `sudo` is setuid-root (4755), so it starts as uid 1000 and fails with its
  own "effective uid is not 0" error.
- `--cap-drop=all` empties the bounding set, so nothing can regain a
  capability by exec — no `CAP_SETUID`/`CAP_SETGID`, no
  `CAP_DAC_OVERRIDE`/`CAP_CHOWN`/`CAP_FOWNER`, no `CAP_SETFCAP`, no
  `CAP_MKNOD` — so `apt-get install` fails even if uid 0 is reached some
  other way.
- The nested-user-namespace escape (create a userns, be root inside it) is
  normally closed too: the default seccomp profile gates `unshare` /
  `clone(CLONE_NEWUSER)` on `CAP_SYS_ADMIN`, which `--cap-drop=all`
  removes.

So "harden the coding sandbox" and "let the agent sudo" is a policy choice,
not a flag combination. The choice made here is the hatch, recorded in
`run.sh` next to `workload_user` with a pointer to this record.

## Invariants and consequences

- **No repo file is mounted.** The only repo-tree coupling left is the
  CWD/`ARGV` directory mount — and when the documented launch runs from the
  repo root, that mount *is* the repo (the open point recorded in the d066
  audit; this record does not change it).
- **The launch chain is self-contained**: env pins, `exec bash`, nothing
  sourced. The one ro-mount it still needs is its own generated file.
- **Hardening cannot be switched on in isolation.** Enabling
  `workload_hardening()` requires removing the sudo grant first — the
  `sudo` package and the `ALL=(ALL) NOPASSWD:ALL` drop-in in the
  Containerfile — and moving any privileged install to build time or to a
  separate rootful step. Otherwise the agent loses its escape hatch with no
  replacement, and `apt` fails with a confusing `EPERM`.
- **The privilege surface is now explicit.** `NOPASSWD:ALL` + no cap-drop +
  no `no-new-privileges` + `--network=host` is what the coding sandbox
  grants; a reader of `run.sh` sees all four, with the reason for the first
  three.
- **The test fixture follows the code**: `tests/check-workload.sh` case 1
  ("coding-agent shape") no longer mounts `lib/log.sh`; it still exercises
  both mount modes and `workload_ro_if` via its other entries.

### How to re-check the hardening clause

Not runnable on every host (a container backend is required; the flags'
semantics above are from the kernel/podman documentation, not measured here):

```sh
podman run --rm --cap-drop=all --security-opt no-new-privileges --user 1000:1000 \
  localhost/empjustine/coding-agent:latest sudo -n id -u   # expect the "effective uid is not 0" failure
podman run --rm --cap-drop=all --security-opt no-new-privileges --user 1000:1000 \
  localhost/empjustine/coding-agent:latest mise install    # expect the per-user toolchain to still work
```

The second line is the one that decides whether the hardening is affordable:
if the toolchain survives, the only real loss is runtime `apt`, which the
pre-provisioning alternative above covers.

## Alternatives considered

- **Log from `lib/workload-runtime.sh` instead** (a line in `workload_run`).
  Rejected: all three runners already log their own launch line immediately
  before calling it (`starting container`, `serving (container, host
  network)` ×2), so a machinery-level line adds a fourth record per launch
  rather than removing one — and it would be a shared-infra change for a
  coding-agent-only convenience.
- **Keep the line, stage a copy of `log.sh`** (mount
  `$stage/lib/log.sh`). Keeps in-container semantics byte-identical with no
  repo coupling, but keeps a mount and a generated file to serve one line —
  more machinery than the line is worth. Rejected.
- **Keep the mount as-is.** The audit's premise: attestation is not valuable
  enough to justify the coupling. Rejected.
- **Host-side pre-rendered line** (capture `log.sh`'s output at stage time
  and `printf` it in-container). Preserves the ready marker, but reintroduces
  a stale timestamp and a quoting step for no information gain over the
  existing host-side line. Rejected.
- **`--cap-drop=all` with the needed caps added back** (`SETUID`,
  `SETGID`, `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETFCAP`, `MKNOD`)
  plus no `no-new-privileges` so setuid works. That is most of the cap set
  and no NNP — hardening in name only. Rejected.
- **Root-in-userns, keep NNP, drop `--cap-drop=all`.** `apt` works (root
  already holds the namespace caps, so nothing is *gained*), but container-root
  writes into mounted dirs land on the host as a subuid — the ownership
  problem `--userns=keep-id` + the `z,U` relabel exist to avoid. Trades
  hardening for `re-chown.sh` runs. Rejected.
- **Move privileged work out of the sandbox** (build-time provisioning in the
  Containerfile, or a separate rootful/host-side step). The correct path *if*
  hardening is ever wanted; not taken now because it removes the agent's
  ability to install a system package unattended. Recorded so the trade is
  visible when the policy is revisited.

## References

- `coding-agent/run.sh` — the mount manifest, the self-contained launch
  chain, and the hardening comment.
- `coding-agent/Containerfile` — the `NOPASSWD:ALL` grant that the
  hardening decision trades against.
- `docs/d056-run-directory-mounts.md` — generator-tree mounts; its
  "`lib/log.sh` for the launch chain's logger" clause is superseded here.
- `docs/d066-hf-cache-mount-removal.md` — the sibling audit finding, and the
  CWD-mount open point this record leaves standing.
- `docs/d045-structured-logging-and-error-construct.md` — the log contract
  the removed line obeyed; unchanged by this record.
- `docs/container-tooling.md` / `docs/coding-harness-persistence.md` — the
  mount and persistence references updated alongside.
- `tests/check-workload.sh` — the argv differential test whose coding-agent
  fixture drops the logger mount.
