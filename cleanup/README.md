---
id: cleanup
type: module-design
status: active
title: "cleanup — reproducible-artifact cleanup for a work tree"
parent: architecture
references: [cleanup-design, d113, d138]
tags: ["cleanup", "shell", "host-side", "tooling"]
---

# cleanup/

Host-side shell scripts that recover disk space by removing **reproducible
artifacts** under a root: things an `install`, `build` or `gc` reconstructs.
One script owns one artifact type, the default is a dry-run, and three git
guards keep source and deliberately versioned artifacts out of the removal set.

The contract — requirements, guards, per-script boundaries and acceptance
tests — is in [DESIGN.md](DESIGN.md). This page is the usage and inventory.

## Usage

```sh
./clean-<type>.sh [--apply] [root]   # root defaults to the current directory
./run-all.sh [--apply] [root]        # all clean-*.sh, alphabetical
./git-gc.sh [--apply] [root]         # maintenance; NOT in run-all.sh
```

The default is a dry-run: every candidate is logged with its size, then a
summary event is emitted. Nothing is removed until `--apply`. Output is one
JSON log event per line (the repo's `log.sh` format); the summary carries the
kind, mode, item count, total size, skipped/warned counts and failure count.

The guard order is: tracked by git (never removed) → ignored by `.gitignore`
(removed) → inside a repository but neither tracked nor ignored (kept and
warned) → outside any repository (removed). A path that is tracked anywhere
inside it is treated as tracked.

```sh
cd ~/some/work-tree
/path/to/cleanup/run-all.sh            # measure everything
/path/to/cleanup/clean-python.sh --apply
/path/to/cleanup/run-all.sh --apply    # after reviewing the list
/path/to/cleanup/git-gc.sh --apply     # optional maintenance
```

## Scripts

| Script                     | Removed type                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clean-python.sh`          | `__pycache__`, `*.pyc/pyo`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache` outside venvs                                                                               |
| `clean-venvs.sh`           | `.venv`, `.venv.tmp`, `venv`, `.virtualenv`, `ENV`                                                                                                                    |
| `clean-node-modules.sh`    | `node_modules` (npm/pnpm/yarn)                                                                                                                                        |
| `clean-pnpm-store.sh`      | top-level `.pnpm-store`, `.pnpm`, `.yarn`, `.npm`                                                                                                                     |
| `clean-js-builds.sh`       | `dist`, `build`, `out`, `.next`, `.nuxt`, `.output`, `.svelte-kit`, `.angular`, `.vite`, `.turbo`, `.cache`, `.parcel-cache`, `.swc`, `*.tsbuildinfo`, `.eslintcache` |
| `clean-coverage.sh`        | `coverage`, `htmlcov`, `nyc_output`, `.nyc_output`, `.coverage`                                                                                                       |
| `clean-os-junk.sh`         | `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*~`, `._*` files; `._*` directories are reported only                                                                       |
| `clean-zone-identifier.sh` | `*:Zone.Identifier` sidecars (NTFS/WSL)                                                                                                                               |
| `git-gc.sh`                | `git gc` per repository; maintenance, intentionally outside `run-all.sh`                                                                                              |

## Why the maintenance split

`git-gc.sh` does not run with the cleaners. Recovering a commit that only the
reflog still references is development routine, so gc cannot be an automatic
cleanup step. It keeps git's default reflog grace period and never passes
`--prune=now`; a lock is reported, not treated as a fatal error.

## Tests

`tests/cleaners.test.sh` builds a throwaway tree under `mktemp` and exercises
the guards, the dry-run/apply split, idempotence, exit statuses and the
`run-all.sh` membership. `./test.sh` runs it through the repo-wide shell test
glob.
