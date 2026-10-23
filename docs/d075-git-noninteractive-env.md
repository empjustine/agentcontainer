---
id: d075
type: decision
status: implemented
title: "d075 — no mirror run may stop on a prompt: the non-interactive git env"
parent: architecture
depends-on: [d044, d060, d062]
references: [d044, d060, d062]
tags: ["git", "references", "mirrors", "credentials", "ssh", "prompts", "fail-fast"]
---

# d075 — no mirror run may stop on a prompt (non-interactive git env)

**Status: implemented.**

## Problem

A reference-farm run is a *fleet* operation: one sweep touches hundreds of
mirrors. Git's failure mode for "I have no credential" or "that repo no longer
exists" is not an error — it is an **interactive prompt** on the operator's
terminal (`Username for 'https://…':`, an ssh host-key `yes/no?`, an ssh
key passphrase, an IDCS keyboard-interactive challenge, or a Git Credential
Manager GUI dialog on Windows). An unanswered prompt does not fail; it **hangs
the run**, so one dead token or deleted upstream blocks every later repo
instead of becoming that repo's logged fetch failure.

Measured on this repo (pseudo-TTY, idle stdin, missing repo so the forge
answers 401 — `git ls-remote` as a stand-in for any fetch/clone):

| env | result |
|-----|--------|
| none | **hangs** at `Username for 'https://github.com':` until killed |
| `GIT_ASKPASS=/usr/bin/false` only | **still hangs** — git reports the dead askpass, then falls back to its *terminal* prompt anyway |
| `GIT_TERMINAL_PROMPT=0` | instant fatal: `could not read Username … terminal prompts disabled` |

Two consequences shaped the decision:

1. **`GIT_TERMINAL_PROMPT=0` is load-bearing; askpass is not a substitute.**
   Askpass only closes one channel (the `GIT_ASKPASS`/ `SSH_ASKPASS` helper);
   the terminal fallback behind it stays open.
2. **Channels are per-transport.** `GIT_TERMINAL_PROMPT` governs git's own
   https credential prompt *only*. ssh prompts (host key confirmation, key
   passphrase, keyboard-interactive) are opened by ssh directly on the tty —
   `SSH_ASKPASS` is consulted only when there is no tty — so the ssh guard is
   `BatchMode=yes`. Git Credential Manager's GUI dialog (the
   `maintain.ps1` Windows path, d062) answers neither variable;
   `GCM_INTERACTIVE=Never` is its own switch.

Before this record the coverage was uneven: `-vbs-mirror-all.sh` exported
`GIT_TERMINAL_PROMPT=0` alone (with **ssh as its default transport**), while
`-forge-mirror.sh`, `-github-clone.sh`, and every Node tool reaching
network git through `git-lib.mjs`'s `git()` — `maintain.sh`/`maintain.ps1`,
`migrate.sh` (`--redownload`/shallow), `-software-forge-mirror.sh` — had
no guard at all.

Rate limits are deliberately *not* part of this problem: a 403/429 is text,
not a prompt. `-vbs-mirror-all.sh` already retries/backoffs/cools down
(d044), and `maintain-mirrors.mjs` logs a failed fetch and moves on. The
interactive hang was the only failure mode that could stop the entire run.

## Decision

One env contract, applied at the two places where git is spawned — the shared
Node choke point and the three shell acquisition sweeps:

1. **`git/git-lib.mjs` — `noninteractiveGitEnv()`** passed as `execFile`'s
   `env` on every `git()` call. This is the single spawn site for Node
   (verified: the only `execFile("git")` in the folder), so it covers
   `maintain`, `migrate`, `-software-forge-mirror` and any future tool
   using `git()`, on POSIX and on the `maintain.ps1` Windows path alike.
2. **`git/-forge-mirror.sh`, `git/-github-clone.sh`** — the same block
   exported right after `set -eu`, before any loop iteration can spawn git.
3. **`git/-vbs-mirror-all.sh`** — its existing `GIT_TERMINAL_PROMPT` export
   extended to the full block.

The contract:

| variable | closes |
|----------|--------|
| `GIT_TERMINAL_PROMPT=0` | git's terminal credential prompt (missing credential, deleted repo → 401) — **the load-bearing entry** |
| `GIT_ASKPASS=/usr/bin/false` | the askpass channel (a GUI askpass helper configured via `core.askPass`/env) |
| `SSH_ASKPASS=/usr/bin/false` | ssh's askpass channel where ssh has no tty (sweeps run from cron/CI) |
| `GCM_INTERACTIVE=Never` | Git Credential Manager's GUI dialog on Windows (d062) |
| `GIT_SSH_COMMAND=${GIT_SSH_COMMAND:-ssh -oBatchMode=yes}` | every ssh interactive prompt — host key confirmation, key passphrase, keyboard-interactive |

**`GIT_SSH_COMMAND` is fallback-if-not-set, evaluated at call time**: an
operator's own value carries their ssh wiring (identity file, port, jump host)
and passes through untouched — it is transport, not sweep policy, so d060's
"argv, never env" rule does not apply to it (that rule governs what a run
*does*, and the default below still makes the unset case fail fast).

## Consequences

- A missing credential, deleted upstream repo, expired token, or unknown ssh
  host becomes an instant per-repo failure with the reason in the log
  (`terminal prompts disabled`, `Host key verification failed`, GCM refusing
  to show UI) — never a hang. Already-stored credentials (helper / store /
  manager) are unaffected: they answer before any prompt channel is reached,
  so healthy configured hosts work exactly as before.
- **First-contact ssh hosts must be seeded beforehand** (`ssh-keyscan` into
  known_hosts): `BatchMode=yes` fails rather than asks the
  "authenticity … yes/no?" question. That is the intended trade — the sweep
  pays one operator step per new host instead of a possible hang.
- `/usr/bin/false` need not exist on the host (e.g. the Windows path): a
  missing askpass binary only fails the askpass attempt, whose terminal
  fallback is already disabled — fast error either way.
- No change for the local-only tools: `audit.mjs`, `local-changes.mjs`,
  `vbs-har.mjs`, `search-references.mjs` spawn no network git, and the
  pure shims (`audit.sh`, `maintain.sh`, `migrate.sh`, …) inherit the
  contract from `git-lib.mjs` at call time.
- Failure *reporting* changes shape: `maintain-mirrors.mjs` /
  `software-forge-mirror.mjs` fetch failures now carry the fail-fast stderr
  lines quoted in their `fetch failed`/`align failed` logs.

## Verification

- Reproduced the hang under a pseudo-TTY with idle stdin (no env: killed at
  12 s still prompting; `GIT_ASKPASS` only: same hang; `GIT_TERMINAL_PROMPT=0`:
  instant exit 128).
- `sh -n` on the three edited scripts; `node --check` on `git-lib.mjs`;
  `node --test` (the `git-lib` tests import only the pure helpers).
- Fallback behaviour: `GIT_SSH_COMMAND` set → the run's git children see the
  caller's value; unset → `ssh -oBatchMode=yes`.
