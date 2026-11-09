---
id: d162
type: architecture-design
status: active
title: "d162 — the PowerShell endpoints are deleted: the mirror is served from WSL2 or not at all"
parent: architecture
depends-on: [d062, d121, d138]
references: [d044, d074, d075, d113, d138, d160, d161]
tags: ["git", "mirror", "windows", "powershell", "deletion", "wsl2", "shim"]
---

# d162 — the PowerShell endpoints are deleted

## Problem

Two PowerShell entry points were authored here, and each existed for one purpose: to serve the
mirror farm from a Windows host, outside WSL2.

- `node-run.ps1` — the PowerShell counterpart of `./node-run.sh`, at the repo root.
- `git/maintain.ps1` — the Windows-native maintenance entry, which ran `maintain-mirrors.mjs`
  through the first one (docs/d062 owns the plan they belonged to).

That serving path was an experiment, and it lost on the two metrics that decide where a 344 GB
mirror lives. Maintained from the Windows side, over the boundary, throughput was poor and disk
space efficiency was worse than the same work inside WSL2. The measurement is the operator's, on
the work mirror; no Windows host is reachable from this container, so the figures are second-hand
here and the comparison is attributed, not reproduced.

Keeping the files as banner-marked deprecations was the first answer, and it is the worse one: a
file that still runs, still parses, and still advertises itself in a help text is a file somebody
eventually runs. An unmaintained runner is a trap with a sign on it.

## Decision

**The repository-owned `*.ps1` endpoints are deleted.** Both files are removed from the tree:

| file                     | role                                        | disposition                |
| ------------------------ | ------------------------------------------- | -------------------------- |
| `node-run.ps1`           | the PowerShell node runner at the repo root | deleted                    |
| `git/maintain.ps1`       | the Windows-native mirror maintenance entry | deleted                    |
| docs/d062                | the plan that motivated both files          | kept, `status: deprecated` |
| `.venv/bin/activate.ps1` | virtualenv output, not authored here        | untouched                  |

The mirror is served from inside WSL2, and a Windows host reaches it through the tool surface,
which is transport-neutral (positional argv, one JSON envelope on stdout, docs/d121):

```
wsl.exe -e bash -lc './node-run.sh git/farm-tool.mjs repo_info github.com/anomalyco/opencode'
```

Serving the mirror never required a Windows-side interpreter; it required a runner, and the WSL2
one is the runner that gets exercised.

## Recovering a deleted endpoint

The deleted files are in this repository's history, and the pickaxe finds the tip that still had
them. A future Windows-side need starts by reading what was removed, not by reinventing it:

```
git log --all --diff-filter=D --oneline -- '*.ps1'
git show "$(git rev-list -1 HEAD -- git/maintain.ps1):git/maintain.ps1"
git show "$(git rev-list -1 HEAD -- node-run.ps1):node-run.ps1"
```

What the recovery cannot carry back is the reason the experiment was abandoned. A re-adopted
endpoint has to answer this record's measurement first: the boundary is where the cost was, and a
better PowerShell script is a cheaper way to do the expensive thing.

## What made the experiment expensive

Measured on the WSL2 side, which is where the cost lives.

**The work is large sequential pack I/O, not many small files.** `anomalyco/opencode.git` holds
1,479,646 packed objects in a single 2.92 GiB pack, spread over 27 files in total. A maintenance
pass reads and rewrites those packs; the per-file call count is small, the bytes moved are not, so
the boundary's per-syscall cost lands on the expensive operation rather than the cheap one.

**A second copy is not a rounding error.** The mirror filesystem reports a 4 KiB block size and
reflink support: copying 100 MiB with `cp --reflink=always` moved the `df` used count by **152 KiB**
— metadata only. An NTFS volume has no reflink, and the same copy is 102,400 KiB of new blocks. A
Windows-side working copy of a farm, or a repack that needs a second copy of a pack, therefore
pays in full for space the WSL2 side shares for free.

**Nothing in the tree measured it.** docs/d138 already records that the ps1 half was reasoned,
never executed, on this host: no `pwsh` is available, so no test, lint leg or sweep covered it. A
green gate never meant the PowerShell path worked, which is the second reason deletion beats a
banner.

## Consequences

### The living documents stop mentioning a Windows-side runner

`README.md`, `docs/architecture.md`, `git/README.md` and `git/non-bare-issues.md` no longer describe a
ps1 counterpart. `./lint.sh`'s runner-copy gate keeps its purpose — one user-facing runner, at the
repo root, no per-unit copy — and loses the ps1 patterns with the files.

### The cross-platform code splits in two

`git/lib/git-core.mjs` and `migrate-to-bare.mjs` carry accommodations for Windows paths: `/`-spelled
paths, path translation for limiters, CRLF-tolerant output parsing, NTFS destination notes. These
answer two different questions and only one of them lost its caller:

- **still live** — WSL2 reading a farm root that lives on NTFS or an SMB share (`/mnt/c/…`): the
  paths arrive with Windows separators even though the host is Linux;
- **retirement candidates** — a maintenance run executing _on the Windows side_: that caller no
  longer exists.

Which accommodation is which is not always obvious from the comment, so removal is a separate
change that names each one, with this record as the reason it is possible.

### The records keep their history

d044, d062, d074, d075 and d138 reference the trampoline shape these two files instantiated. They
are records, so they keep it: docs/d062 gains a `status: deprecated` qualifier and an explicit note
that the file is gone and recoverable, docs/d138 says the same about its aftermath, and no record is
rewritten to pretend the experiment never happened.

### Keeping this working after the forge changes

The deletion removes an endpoint, not a capability. The mirror tool surface is the durable Windows
path — transport-neutral today, and still transport-neutral when the second-generation,
object-storage forge replaces the bare mirrors, because the envelope is the contract (docs/d160,
d161). A forge served from object storage needs no Windows-side working copy at all, which is the
same shape of argument d161 makes for mirror state: the part that has to work everywhere is the
answer, not the host that produced it.

## Verification status

`git/maintain.ps1` and `node-run.ps1` were deleted; `git ls-files '*.ps1'` now reports nothing
authored here. The living documents, the `maintain-mirrors.mjs` usage text and the runner-copy gate
were updated to match, and `docs/d062` carries `status: deprecated` with a `## Status` qualifier
naming this record and the recovery command.

Not verified here: the Windows-side measurement itself (no Windows host, and no `pwsh` — the same
gap docs/d138 records), and whether any operator script outside this tree invoked either file. The
second is the one to ask before assuming no consumer lost an entry point.

## Alternatives rejected

- **Banner-marked deprecation** — an unmaintained file that still runs is a trap with a sign on it;
  the history is a better archive than the tree.
- **Keep them maintained** — the reason to serve from Windows died with the measurement; keeping a
  second runner alive for a path nobody should take spends maintenance on the wrong host.
- **Reword the ps1 files' behaviour instead of deleting them** — the cost is the boundary, not the
  script; a better PowerShell runner is a cheaper way to do an expensive thing.
