---
id: d026-data-diode
type: architecture-design
status: draft
parent: lib
title: "d026 — data-diode audit trail for harness state (design note)"
tags: ["security", "audit", "persistence", "design-only"]
---

# d026 — Data-Diode Audit Trail for Harness State (design note)

Status: **design only — no implementation.** Complements
`docs/coding-harness-persistence.md`, which documents the *current* per-run
RW-mount staging that this design would replace.

## Problem

`coding-agent/run.sh` persists each harness's state by RW-mounting per-run
stage dirs (`~/workspace/$container_name/{pi/agent,opencode/*,cline,thinkrail}`)
into the container. This survives container death, but *within* a live run the
container holds full RW power over everything mounted: malicious code inside
the container (compromised dependency, prompt-injected agent) can delete or
rewrite its own traces — the current run's session logs, auth state, and
harness db — before the run ends. Cross-run dirs are invisible to the
container, so only *previous* runs are safe today.

The goal is a **data diode**: state flows out to the host; the container can
never read back, rewrite, or delete what has already been captured.

## Threat model

- Adversary: arbitrary code execution inside the container, up to and
  including attempts to make the harness or shell destroy session logs and
  command history.
- Protected asset: the audit trail on the host (what the agent did, how its
  state evolved).
- Trust boundary: the container boundary. **The host is a trusted
  environment** — the store must be unreachable/unalterable *from the
  container*; host-side tampering is out of scope (per current decision).
- Non-goals: suppressing capture of events malware withholds (no diode can
  force emission); host-side compromise; diode availability under flooding.

## Layering

Harness-management layers (JetBrains Air, JetBrains ThinkRail) are
orchestration/UX, not enforcement:

- ThinkRail runs `pi` in-process — wherever it runs, agent code gets its
  privileges; it cannot enforce a diode on itself.
- Air isolates task workspaces and keeps its own task/review records
  host-side (already diode-grade), but harness-internal traces stay inside
  the task container and its isolation is not configurable as a one-way sink.

Composition: management layer on top as a *consumer* of the audit trail; the
diode is a property of the sandbox runtime + collector beneath it.

## Approaches

| | Mechanism | Verdict |
|---|---|---|
| A. Socket diode | Harnesses/exporter emit events over a passed-in Unix socket; host daemon is the store's only writer | True per-event diode, but full fidelity needs intrusive per-harness support; an in-container file tailer bridge is killable by the malware it audits |
| B. Host-side sweeps | Periodic `podman cp` (or inotify on the rootless overlay upperdir) copies state out | Zero in-container support, but the sweep interval is an unpersisted-trace window (write+delete inside one interval may never export) |
| **C. FUSE diode FS** | Host FUSE daemon serves the harness state paths; bind-mounted where the RW mounts sit today | **Recommended direction** — see below |
| D. Full VM (d020) | QEMU/KVM guest, virtiofs RO shares, vsock diode | Strongest boundary, heaviest cost (GPU, SELinux, cold starts); deferred, composes with C later |

## Approach C — FUSE write-through, versioned (the diode contract)

A host-side FUSE daemon backs the harness state paths; `run.sh` mounts it into
the container in place of the plain RW bind mounts:

1. **Current-version reads are served normally** — harnesses keep working
   unchanged: pi reads its session JSONL, Cline its db, ThinkRail its state.
   No harness cooperation required (the design's core constraint).
2. **Writes pass through** to the host backing store as new immutable
   *versions* in a per-file append-only chain — never in-place rewrites.
3. **Deletes, renames, truncates** affect only the container-visible view.
   Historical versions remain in the host store, never served back. The
   container sees a mutable filesystem; the host retains tamper-evident-by-
   isolation history underneath — a "time-travel diode".
4. The backing store is a plain per-run host directory
   (`~/workspace/$container_name/audit/…`) — matching the "plain immutable
   copies" decision (host trusted). Seeding (`settings.json`, `models.json`,
   `opencode.json`) happens host-side before the mount, replacing today's
   `cp` seeding.
5. Cross-run: fresh start (store is exported per run, never re-staged into
   later runs — no read channel back into the container).

Enforcement quality: the kernel guarantees past versions are unreadable from
the container — no harness behavior is trusted. Daemon hardening notes: run
the FUSE daemon on the host outside the container's pid namespace (container
processes cannot signal or ptrace what they cannot see), and under a distinct
uid as belt-and-braces (containers here run with `--userns=keep-id`, i.e. the
host user's uid).

Known implementation risks (to resolve when implemented):

- FUSE read/write latency on hot paths — session JSONL writes are small and
  append-shaped (acceptable); frequent tiny reads of `models.json` are the
  case to benchmark.
- Rootless bind propagation of a FUSE mount into podman (and the `:Z`/SELinux
  relabeling friction documented for bazzite in d020).
- Coordinating the daemon lifecycle with `run.sh` (spawn per run, ensure
  teardown can't leave the store writable through a stale mount).

## Status of related harnesses

- Scope (decided): harness state only — pi sessions, Cline sessions/db,
  ThinkRail state, generate.sh logs. LLM-traffic capture (host relay path) and
  a shell-command audit hook were considered and declined for now.
- Tamper-evidence (decided): plain immutable copies. Hash-chaining and
  RFC-3161 timestamping were considered and declined while the host is
  trusted; revisit if that assumption changes.
- Management layer: Air/ThinkRail remain candidates as *consumers* of the
  trail (and Air's ACP support for pi/OpenCode/Cline makes it the natural
  orchestration layer above this runtime), never as the enforcement point.
