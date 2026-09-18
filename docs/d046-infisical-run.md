# d046 — `infisical run` replaces the hand-rolled vault loader

**Date:** 2026-09-18
**Status:** adopted
**Supersedes:** the custom loader mechanics of `lib/environment.sh`
(exit-96 empty-vault pre-flight, in-process dotenv parser, `secrets
--output=dotenv` + parse + exec chain); the chain *contract* is unchanged.

## Context

`lib/environment.sh` was the repo's explicit env chain:
`./lib/environment.sh <script>` — fetch the vault, inject it into the
environment, `exec` the target. The *contract* (consumers read plain env,
never load secrets, no `.env` files, fatal on failure) was repo policy; but
the *mechanism* — an `infisical secrets --output=dotenv` round-trip captured
into a shell variable, a hand-rolled here-doc dotenv parser (`_inject`,
`export "$_l"`, no re-expansion), then `exec` — re-implemented what the
Infisical CLI itself ships as `infisical run`:

    infisical run [--env=...] [--path=...] -- <cmd>

`run` fetches, injects into the child environment and spawns the command —
in memory, nothing on disk, same one-round-trip guarantee.

## Decision

The loader is reduced to the three things the CLI does not own:

1. **Binary resolution** — `$INFISICAL_BIN` › `~/Infisical/cli/infisical`
   (the Termux/Android source build, `lib/provision-termux.sh`) › PATH ›
   `mise x infisical@latest`. Repo provisioning policy; the CLI cannot know
   about the checkout build.
2. **Pinned identity** — `INFISICAL_API_URL` / `INFISICAL_PROJECT_ID`
   defaults, shared with `lib/workload-runtime.sh`; exported as
   `INFISICAL_DOMAIN` for the CLI.
3. **Target contract** — relative-to-caller resolution and the exit-91
   "target script not found" check.

Everything else is deleted with the mechanism:

- **The dotenv parser** (`_inject`, the here-doc loop, the
  `shellcheck disable=SC2163`): `run` builds the child environment itself.
- **The empty-vault pre-flight (exit 96)**: a failing vault aborts via the
  CLI's own non-zero exit. The successful-but-empty vault is no longer
  detected — a deliberate regression (the old check needed the parsed
  payload, which no longer passes through this process). Consumers'
  "generators tolerate missing keys" contract (docs/requirements.md FR-U
  family) covers the consequence: an empty vault surfaces as missing
  provider keys downstream, not as a chain error. NFR-2 (loud failures)
  still holds at the step that owns the failure — the consumer that
  actually needs the key.
- **The `exec` without a wrapper process**: `run` must stay the parent to
  inject the env, so the loader shell is replaced by `infisical`, not
  bypassed. Cosmetic; nothing observed the difference.

### Pinned flags

- `--expand=false` — `run`'s default is `true` (shell parameter expansion
  of secret values). The hand-rolled parser never re-expanded
  (`export "$_l"` on the literal line); `--expand=false` preserves that.
  This is the one behavior change a secret containing `$…` would have
  silently suffered.
- `INFISICAL_DOMAIN` env var, **not** `run`'s `--domain` flag — verified
  against CLI 0.43.132: the flag mis-parses on the `run` subcommand
  ("Unable to parse domain url" regardless of position) while the env var
  works; also the flag's default is `https://app.infisical.com/api` (with
  the `/api` suffix), unlike the pinned `INFISICAL_API_URL`.
- `--projectId` stays on the command line; **no `.infisical.json` is
  checked in** (deliberately — one was tried early on and removed). Such a
  file only ever helped commands launched from inside the repo root; every
  consumer here is cwd-independent by design, so identity is pinned by
  flags/env instead.
- `INFISICAL_ENV` (default `prod`) overrides the vault env; `--path=/inference`
  unchanged.

## Consequences

- `lib/environment.sh`: ~160 lines → ~100, of which ~60 are the header
  contract. Mechanism prose ("in-memory here-string parse", "never a file
  on disk", "no wrapper process left behind") is gone from the header and
  from every doc that narrated it (architecture, requirements FR-L2,
  container-tooling, README, d032, termux-serving, workload-runtime.sh,
  provision-termux.sh, coding-agent/run.sh).
- The chain contract is untouched: same invocation, same consumers-read-
  plain-env rule, same exit codes except 96 (retired). No consumer changed.
- The stale "checked-in .infisical.json" references in comments
  (environment.sh, workload-runtime.sh) were corrected — the file is
  deliberately absent (see Pinned flags).
- Known gap: no end-to-end live proof on a logged-in host was run before
  adoption (this machine had no infisical session); flags and the
  `INFISICAL_DOMAIN` workaround were verified against CLI 0.43.132
  directly.
