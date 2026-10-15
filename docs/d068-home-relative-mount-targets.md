---
id: d068
type: decision
status: implemented
title: "d068 — a home-relative DIRECTORY mounts at the container's home, not at the canonical host path"
parent: coding-agent
depends-on: [d056]
references: [d054, d056, d065, d066]
tags: [coding-agent, runner, mounts, paths, sandbox]
---

# d068 — home-relative DIRECTORYs mount at the container's home spelling

**Status: implemented.** `coding-agent/run.sh` keeps resolving every DIRECTORY
to its canonical path (`pwd -P`) for the dedupe and the `$HOME` refusal, but
the CONTAINER side of a home-relative directory is now spelled from the home
the image gives the user (`/home/$USER/...`); a directory outside the home
still mounts at its literal path. Supersedes in part d056's "mounted at its
own host path" and d066's "at its own host path".

## Problem

The launcher's contract (d056) is "same path on both sides", and it held
byte-for-byte — as long as the host home was its own canonical path. On the
reference host (Bazzite, Fedora Atomic layout) it is not: `/home` sits in
front of `/var/home`, so

    ~                       -> /home/deck      what the shell, the docs and
                                                the operator call "my home"
    pwd -P of the same dir  -> /var/home/deck  what run.sh resolves

while the sandbox's own `~` is `/home/deck` (the image's useradd home — the
same spelling every other mount in `run.sh` already uses:
`/home/${USER}/.pi/agent`, `/home/${USER}/.config/opencode`, ...).

The ARGV manifest was the ONE place that mixed the two spellings: both the
host source and the container target came from `pwd -P`, so
`./run.sh ~/Downloads/references` produced

    -v /var/home/deck/Downloads/references:/var/home/deck/Downloads/references

and a session inside the container that ran `ls ~/Downloads/references` — the
path it had just named on the host — found nothing, while `ls
/var/home/deck/Downloads/references` listed the mirror fine. The directory was
mounted; it was mounted where nobody looks. It reads as "the ARGV folders
stopped mounting".

Two facts make it a regression rather than a papercut:

- **the pre-d056 toggle spelled its guest from `$HOME`**
  (`workload_ro_if "$HOME/Downloads/references" "$HOME/Downloads/references"`
  → `/home/deck/...`, inside `~`) — d056's canonicalisation moved that guest
  one symlink away from where the sandbox looks;
- **d066 moved the HF cache into the ARGV**, from an explicitly
  `/home/${USER}/.cache/huggingface/hub` guest (correct) to "just another
  DIRECTORY" (canonical, hence outside `~` here), and told the operator to
  point `HF_HUB_CACHE` at "that path" — a path the container does not have.

## Decisions

1. **Two spellings, one rule.** The host side of a mount stays canonical
   (that is what the dedupe and the `$HOME` refusal compare — d056 decision
   c); the container side of a path *under the resolved home* is rewritten to
   `/home/USER` + `path minus the home prefix`. Paths outside the home are
   untouched: a `/srv/data` DIRECTORY mounts at `/srv/data`, as before.
2. **The container side follows the image, not the host env.** The rule is
   `/home/$USER` — the home in the container's passwd — not a re-use of the
   host's `$HOME` string: the sandbox resolves `~` from its own passwd, and
   that is also the spelling `launch.sh` exports for `PI_CODING_AGENT_DIR`,
   `OPENCODE_CONFIG_DIR`, `CLINE_DIR` and `THINKRAIL_DATA_DIR`. A host whose
   `$HOME` is the physical path is handled the same as one whose `$HOME` is
   the symlink spelling, because neither is consulted.
3. **The workdir is the first DIRECTORY**, so it goes through the same
   rewrite — `--workdir /home/$USER/agentcontainer` instead of a
   `/var/home/...` path that exists only because of how the shell got there.
4. **The policy lives in the launcher, not in the workload API.**
   `workload_rw host guest` already accepts any pair; *which* guest a
   directory deserves is a launcher contract, so `run.sh` owns the mapping and
   `lib/` stays mechanism.

## Invariants and consequences

- **`~` means the same thing on both sides.** `./run.sh ~/Downloads/references
  ~/.cache/huggingface/hub` puts both under the sandbox's `~`, which is what
  the operator typed on the host.
- **The warm HF cache needs no env override** (d066 decision 3 gains this for
  free): the guest is the image's own `~/.cache/huggingface/hub`, the path
  `hf` already reads by default, so the host store lands exactly where the
  tooling looks.
- **Dedupe and refusal are unaffected**: both still run on canonical paths,
  so `.` vs `$(pwd -P)` and a `$HOME` reached through the symlink still
  collapse / are refused.
- **A mount's two sides may now differ** for home-relative paths; anything
  asserting `source == target` must drop that assumption
  (`tests/check-run-dirs.sh` pins the real argv).

## Alternatives considered

- **Mount at the canonical path and add a `/var/home/$USER` → `/home/$USER`
  symlink in the image.** The container's `/home/$USER` is a real directory
  carrying the image's skel, `.gitconfig` and the harness mounts, and a
  second spelling would split every `launch.sh` env var from the `~` that
  points at them. Rejected.
- **Run the container with `--env HOME=` set to the host's physical home.**
  Moves the mismatch onto the image: `/home/$USER` would stop being `~`
  while `.bashrc`, `.gitconfig` and the mise shims stay installed there.
  Rejected.
- **Spell the guest from the host's `$HOME` string** (what the old toggle
  did). Correct only when `$HOME` happens to equal the image's home; on a
  host whose passwd says `/var/home/$USER` it reproduces the same bug with
  different digits. Rejected — the container's passwd is the only home the
  sandbox is guaranteed to resolve.
- **Drop `pwd -P` and mount paths as typed.** The canonical form is what
  makes d056's dedupe and `$HOME` refusal work at all (a symlinked `$HOME`
  would otherwise slip past both). Rejected.

## References

- `coding-agent/run.sh` — `guest_path()`, the ARGV loop and the workdir.
- `tests/check-run-dirs.sh` — the argv that pins this spelling.
- `docs/d056-run-directory-mounts.md` — the ARGV-as-manifest contract this
  record refines (host side unchanged).
- `docs/d066-hf-cache-mount-removal.md` — the cache-as-DIRECTORY flow this
  record makes usable without an in-container `HF_HUB_CACHE`.
- `docs/d069-backend-detection-path.md` — the PATH-resolved backend probe that
  lets `tests/check-run-dirs.sh` stub the container tool and pin this record's
  argv end-to-end.
- `docs/d054-pi-agent-and-session-dir-mounts.md` /
  `docs/d065-opencode-host-config-mount.md` — the mounts that were already
  `/home/$USER`-spelled and define the spelling the ARGV now follows.
