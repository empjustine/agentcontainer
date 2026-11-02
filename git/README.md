---
id: git
type: module-design
status: active
title: "git — the host-side reference farm: bare mirrors, their upkeep, and search over them"
parent: architecture
references: [git-non-bare-issues, d043, d044, d062, d075, d076, d089, d099, d113, d121]
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
discovered on every run (`lib/git-core.mjs`), because the farm is not a clean tree —
an owner directory can be a repository that wraps further clones, and stored
paths can disagree with the origins they point at (`non-bare-issues.md`).

## Boundary

- **Host-side only.** No runner, container image, or `./build.sh` target
  depends on this folder. The read path is a host loopback façade (d099), never
  something a workload reaches directly.
- **Owns its `lib/`, and it is a core library** (docs/d121). `lib/` holds the
  shared floor (`git-core.mjs`, `forge-remotes.mjs`), the plumbing every entry
  parses and reports through (`cli.mjs`, `retry.mjs`, `farm-lock.mjs`,
  `farm-posture.mjs`), and this folder's own hand copies of the kernels
  (docs/d113) — `log.mjs`, `canonical-json.mjs`, the node runners. Pruned to
  what the farm uses: the shell logger went when its last shell consumer did.
- **Shell is interpreter only.** A top-level `.sh` is a shim (`lib/node-run.sh`
  + `node_run`) or the one thing node cannot express: `farm-lock.sh`, whose
  `flock` in fd mode guards commands a subprocess cannot see (docs/d121).
- **Reads upstreams, never writes them.** Every mutation is local to the mirror
  (fetch, repack, commit-graph, hardlink or redownload). Nothing here pushes.
- **`tests/` exercises the helpers, not the farm.** The pacer, the two glob
  matchers, argv parsing, retry policy and the lock probe are unit-tested; the
  ports are covered end to end against throwaway fixture farms and manifests
  (`tests/git-farm-tool.test.mjs`, `tests/git-vbs-mirror.test.mjs`) — those
  replaced the shell they came from, so the tests are the parity evidence.

## The pieces

Three jobs, and each job's entry point is the one to read:

| job | entry point | why it is shaped that way |
| --- | --- | --- |
| **Get a repo in** | `-forge-mirror.sh` (any forge, idempotent, farm-wide `flock`), `-vbs-mirror-all.sh` → `vbs-mirror-all.mjs` + `vbs-har.mjs` (a whole VBS tenant from a captured HAR — no live session, no rolling token) | d099 for the locking, d044 for the HAR extraction path; the tenant exposes one repository under three URLs, normalized in `lib/forge-remotes.mjs` |
| **Keep it healthy** | `migrate-to-bare.mjs` (full clone → bare, local hardlink or redownload), `maintain-mirrors.mjs` (align + repack/commit-graph; `--deep-optimize` adds `gc --aggressive`), `audit.mjs` (report anomalies before migrating), `local-changes.mjs` (everything a repo holds that its remotes do not — the check before anything is archived) | d044's "why bare", d089's maintenance passes, d076's one-job-per-host scheduler, d062's Windows port (`maintain.ps1`, POSIX-separator-free `lib/git-core.mjs`), d075's non-interactive git environment |
| **Search it** | `farm-tool.sh` → `farm-tool.mjs` (+ `lib/farm-posture.mjs`, `farm-lock.sh`) — the d099 tool surface as positional-argv CLI, one JSON object per call; `search-references.mjs` for the wide cross-repo/cross-branch Zoekt container | d099 (capped reads, allowlisted plumbing verbs, scrubbed git env so repository config can execute nothing) and d043 (Zoekt for wide queries; `git grep` for scoped ones) |

`lib/git-core.mjs` is the shared floor under all three: how to run git without
throwing a run away, how to discover a repository under a reference root, and
the exact optimization sequence that makes pickaxe over deep history fast.
`lib/cli.mjs` is the floor under every *entry*: the flag table, the one
unknown-flag error, and the report tail (docs/d121).

The d099 MCP façade is the one piece still missing: the CLI surface it will
wrap already exists, so it lands here beside the discovery it needs rather than
as a new module.

## Working in this folder

- A new farm operation is a `.mjs` plus a `.sh` shim, documented by the record
  that motivated it, and listed in this folder's row in the README folder map.
  No logic lands in shell: the shim sources `lib/node-run.sh` and execs.
- Never interpolate into a shell string: positional argv, `--end-of-options`,
  `grep -e`, `--literal-pathspecs` (d099). Farm data includes repository names
  nobody in this repo chose.
- Anything that mutates a mirror takes the farm `flock`. Anything that fetches
  goes through the by-host pacing gate, because the software-forge tenant
  rate-limits concurrent requests (d076, d044).
