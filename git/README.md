---
id: git
type: module-design
status: active
title: "git — the host-side reference farm: bare mirrors, their upkeep, and search over them"
parent: architecture
references: [git-non-bare-issues, d043, d044, d062, d075, d076, d089, d099]
tags: ["mirrors", "search", "host-side", "tooling"]
---

# git

This folder is the **reference farm's tooling**: the machinery that turns every
upstream repository an agent might need to read into a bare mirror on the host,
keeps those mirrors healthy, and answers code searches against them. It is not
part of any container image and it is not on the `./generate.sh` / `./build.sh`
path — it runs on the host, against the host's disk, before a workload exists.

The farm itself is data, not code: `~/reference` and the work machine's mirror
roots hold `host/owner/repo` bare repositories, plus the SMB and non-NTFS roots
d044 and d062 brought in. Nothing in this folder owns that layout; it is
discovered on every run (`git-lib.mjs`), because the farm is not a clean tree —
an owner directory can be a repository that wraps further clones, and stored
paths can disagree with the origins they point at (`non-bare-issues.md`).

## Boundary

- **Host-side only.** No runner, container image, or `./build.sh` target
  depends on this folder. The read path is a host loopback façade (d099), never
  something a workload reaches directly.
- **Owns its `lib/`.** `lib/log.mjs` / `lib/log.sh` are this folder's own hand
  copies (docs/d113), so farm output is structured like the rest of the tree;
  the copies are pruned to what the farm uses — logging, the canonical JSON
  helper, and the node runner.
- **Reads upstreams, never writes them.** Every mutation is local to the mirror
  (fetch, repack, commit-graph, hardlink or redownload). Nothing here pushes.
- **`tests/` exercises the helpers, not the farm.** `tests/git-pacer.test.mjs`
  and `tests/git-glob.test.mjs` pin the two safety properties of `git-lib.mjs`
  (fetch serialization, glob semantics) without needing mirrors on the machine.

## The pieces

Three jobs, and each job's entry point is the one to read:

| job | entry point | why it is shaped that way |
| --- | --- | --- |
| **Get a repo in** | `-forge-mirror.sh` (any forge, idempotent, farm-wide `flock`), `-vbs-mirror-all.sh` + `vbs-har.mjs` (a whole VBS tenant from a captured HAR — no live session, no rolling token) | d099 for the locking, d044 for the HAR extraction path; the tenant exposes one repository under three URLs, normalized in `software-forge-remotes.mjs` |
| **Keep it healthy** | `migrate-to-bare.mjs` (full clone → bare, local hardlink or redownload), `maintain-mirrors.mjs` (align + repack/commit-graph; `--deep-optimize` adds `gc --aggressive`), `audit.mjs` (report anomalies before migrating), `local-changes.mjs` (everything a repo holds that its remotes do not — the check before anything is archived) | d044's "why bare", d089's maintenance passes, d076's one-job-per-host scheduler, d062's Windows port (`maintain.ps1`, POSIX-separator-free `git-lib.mjs`), d075's non-interactive git environment |
| **Search it** | `farm-tool.sh` (+ `farm-tool-lib.sh`, `farm-lock.sh`) — the d099 tool surface as positional-argv CLI, one JSON object per call; `search-references.mjs` for the wide cross-repo/cross-branch Zoekt container | d099 (capped reads, allowlisted plumbing verbs, scrubbed git env so repository config can execute nothing) and d043 (Zoekt for wide queries; `git grep` for scoped ones) |

`git-lib.mjs` is the shared floor under all three: how to run git without
throwing a run away, how to discover a repository under a reference root, and
the exact optimization sequence that makes pickaxe over deep history fast.

The d099 MCP façade is the one piece still missing: the CLI surface it will
wrap already exists, so it lands here beside the discovery it needs rather than
as a new module.

## Working in this folder

- A new farm operation is a `.mjs` (or `.sh` when it is a thin POSIX wrapper
  over one), documented by the record that motivated it, and listed in this
  folder's row in the README folder map.
- Never interpolate into a shell string: positional argv, `--end-of-options`,
  `grep -e`, `--literal-pathspecs` (d099). Farm data includes repository names
  nobody in this repo chose.
- Anything that mutates a mirror takes the farm `flock`. Anything that fetches
  goes through the by-host pacing gate, because the software-forge tenant
  rate-limits concurrent requests (d076, d044).
