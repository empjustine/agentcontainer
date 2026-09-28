---
id: d054
type: architecture-design
status: active
title: "d054 — pi mounts its real agent dir, stages a per-run session dir (PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR)"
parent: coding-agent
depends-on: [coding-agent]
references: [d026, d030, d041, d052, coding-harness-persistence]
tags: [coding-agent, pi, persistence, mounts, sessions, credentials]
---

# d054 — pi agent dir + session dir mounts

**Status: active (landed).** `coding-agent/run.sh` no longer stages a per-run
copy of the pi agent dir. It mounts the host's real agent directory RW as
`PI_CODING_AGENT_DIR` and stages a separate per-run session directory as
`PI_CODING_AGENT_SESSION_DIR`. Both are pi's own documented env vars (pi
`README.md` env table / `docs/environment-variables.md`), and the run aborts if
a **non-empty** `auth.json` is found in the agent dir (pi itself writes an
empty `{}` on startup, so existence alone is not a signal).

## Problem

pi state was staged per run into `~/workspace/$container_name/pi/agent`: a
fresh agent dir seeded with the committed `settings.json` / `models.json`.
That had two costs:

- **Config garbage, and a drift seam.** Every launch left a full agent-dir
  copy under `~/workspace` whose only durable content was session JSONL; the
  copied config was throwaway. The generator's install target
  (`PI_CODING_AGENT_DIR`) and the dir pi actually read were deliberately the
  same path by construction, but the runner then copied a *second* snapshot
  into a different dir — a second thing to keep in sync (the class of bug the
  `AGENT_DIR` alias retirement in `generate.mjs` removed).
- **Two kinds of state shared one directory.** Durable config (settings,
  models, skills) and per-run session JSONL were indistinguishable inside
  `pi/agent`, so there was no way to persist config without also keeping every
  run's throwaway config copy.

pi exposes the split directly: `PI_CODING_AGENT_DIR` names the config dir and
`PI_CODING_AGENT_SESSION_DIR` names the session store (precedence
`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `settings.json:sessionDir`),
independent of it. The runner was ignoring the session mechanism.

## Decisions

1. **`PI_CODING_AGENT_DIR` is the host's real agent dir, mounted permanent
   RW.** The generator installs the committed config into `~/.pi/agent`;
   mounting that directory means the generator's install target, the host pi,
   and the sandboxed pi are one directory. In-container manual regeneration
   (`/opt/coding-agent/generate.sh`) writes back to that same host dir instead
   of a throwaway copy. Config and skills persist across runs by construction.
2. **`PI_CODING_AGENT_SESSION_DIR` is a per-run stage under the container's
   `pi/`, mounted RW.** `~/workspace/$container_name/pi/sessions` (the same
   stage root the old `pi/agent` layout used) is mounted at
   `/home/$USER/.pi/sessions` and exported in the generated launch chain. The
   path is **pinned**, not read from the host env — a host pi with
   `PI_CODING_AGENT_SESSION_DIR` set must not silently point the mount at the
   host's own store and merge the two. Sessions are **per-run audit state**
   (docs/d026: host-retained, not reused across runs), kept out of the shared
   config dir so their churn cannot rewrite it. pi's *newer* session handling
   may write sessions directly into this dir rather than the old nested
   `agent/sessions` path — the mount is the explicit sink either way, so we do
   not depend on pi's internal nesting.
3. **A non-empty `auth.json` is a hard abort.** pi resolves the `"$VAR"`
   api-key references in `models.json` from the forwarded environment, so a
   *populated* credential file is dead state. Since the agent dir is now
   mounted RW, shipping it into the sandbox is exactly what docs/d052 removed.
   pi itself materialises an **empty** store (`{}`) whenever it starts (verified
   against pi 0.86.0: a bare `pi --list-models` against a fresh agent dir writes
   `{}`), so `run.sh` keys on content, not existence — `{}`/`[]`/blank/absent
   all pass, anything else exits 93. (A naive existence gate would abort every
   run after the first, since pi re-creates the empty file.)
4. **No per-run pi config stage.** `run.sh` stages `opencode/`, `cline/`,
   `thinkrail/`, and now `pi/sessions`; `pi/agent` disappears from
   `~/workspace`.
5. **Termux is unchanged.** The Termux branch `exec`s pi against
   `PI_CODING_AGENT_DIR` directly and keeps pi's default session store
   (`<agentDir>/sessions`). The split exists to give the *sandbox* a
   single-purpose session mount; Termux has no mount boundary to split.

## Invariants and consequences

- **d041(d) refined, not reversed.** Runners still never generate. The config
  is still the generator's output — installed into `PI_CODING_AGENT_DIR` by
  the generator and read from there, rather than re-copied per run.
- **d052's staging invariant is mechanically superseded for pi.** d052 says
  `run.sh` stages exactly `settings.json`, `models.json`, `opencode.jsonc`;
  pi config is now mounted, not staged, so `run.sh` stages neither pi config
  file (it does stage the per-run session dir). d052's *decision* — never
  stage a credentials file — is not just untouched but now enforced by the
  `auth.json` abort.
- **Host agent state is exposed to the sandbox.** `~/.pi/agent` also carries
  host skills/extensions, which the container can read and rewrite. This is
  accepted because the credential-shaped risk (a populated `auth.json`) is
  excluded by decision 3; if pi gains other host-only agent-dir state, this
  record should be re-read.
- **Concurrency.** Two simultaneous `run.sh` launches share one agent dir
  (previously isolated per run). A live run can observe another's regeneration
  of `settings.json`/`models.json`. The session dirs stay per-run/isolated;
  no locking is added here.
- **Launch relabel cost moves to the host dir.** Workload RW mounts carry
  `z,U` (lib/workload-render.jq), so each launch recursively relabels the host
  agent dir (skills/config) plus the fresh session stage. The host dir is
  durable, so that half is no longer a fresh per-run copy.
- **Per-run sessions are not `/resume`-able across runs.** This is the same
  behavior as the old staged agent dir; it is intentional (audit, not merge).
  `run.sh` pins the session dir rather than reading
  `PI_CODING_AGENT_SESSION_DIR` from the host env specifically so a host pi
  with that var set cannot make the sandbox share the host's session store.
  Cross-run history would require changing this record.

## Alternatives considered

- **Stable host session store (`~/.pi/sessions`).** Enables cross-run
  `/resume` and a single diode target, but mixes session churn into the host's
  own `~/.pi` and departs from the per-run audit-stage model docs/d026 is
  built on. Rejected in favor of the per-run `pi/sessions` stage.
- **Keep the per-run stage; only override the session dir.** Preserves the
  committed-config snapshot and per-run isolation, but keeps the config copy
  (and its drift seam) and the `~/workspace` config garbage. Rejected: the
  whole point was to stop staging pi config.
- **Mount the host agent dir read-only, stage a per-run config dir RW.**
  Avoids exposing host agent-dir writes, but breaks in-container manual
  regeneration, which must write `settings.json`/`models.json`. Rejected.
- **tmpfs session store (truly ephemeral, nothing on the host).** Rejected:
  no host-side audit trail, which is the asset docs/d026 protects.
- **Ignore `auth.json` entirely instead of gating.** Rejected: it would
  silently mount a real credential store into the sandbox (d052's exact
  anti-goal). The empty-store carve-out keeps pi's own `{}` from tripping the
  gate.

## References

- `docs/coding-harness-persistence.md` — the persistence table this record
  updates (pi config host dir + per-run session stage).
- `docs/d026-data-diode-audit.md` — the per-run session stage is its diode
  target.
- `docs/d041-unified-generate-build-entrypoints.md` — runners never generate
  (the mechanism in d041(d) is refined here).
- `docs/d052-tombstone-credential-staging.md` — no credential file is staged;
  the `auth.json` abort enforces it.
- `docs/d030-coding-agent-flow-simplification.md` — stage-dir GC and the
  host↔container staging duplication this removes for pi config.
