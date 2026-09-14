---
id: d036
type: architecture-design
status: implemented
title: "d036 — default model is operator-hardcoded; the dynamic picker is retired"
parent: architecture
references:
  - d035
  - d024
depends-on:
  - coding-agent
---

# d036 — default model is operator-hardcoded; the dynamic picker is retired

**Status:** implemented (supersedes the *selection* mechanism of d035; d035's
provider facts remain valid)

## Problem

The dynamic picker (`generate-default-model.mjs`, d035) reads the generated
`models.json` and selects a default from whichever provider layer the cascade
emitted. In practice this still lands the agent on a broken endpoint:

- The picker's usability signal — "the cascade emitted a layer for this
  provider" — proves *routing*, not *callability*. A 401-gated peer route, a
  model the host's credentials cannot actually serve, or a provider with no
  credits all pass the signal and then fail at request time.
- When the pick is garbage (or no default gets written), pi falls back to its
  own built-in default — the broken inference-API endpoint d035 already
  identified as unusable from this host.

Every dynamic fallback has now failed in practice. Default-model choice is
not a fact that can be probed; it is an operator decision.

## Decision

The operator's current choice — **`cline-pass` / `z-ai/glm-5.3-flash`**, the
pair already present in the host's live `~/.pi/agent/settings.json` — becomes
the hardcoded default, as is:

1. `coding-agent/settings.json` (the static base `generate.sh` installs and
   `run.sh` stages as the container fallback) carries
   `defaultProvider`/`defaultModel`. Both entry points therefore use a
   settings.json that boots on the operator's default even when generation
   fails entirely or `SKIP_GEN=1`.
2. `generate-default-model.mjs` no longer probes `models.json`. It returns
   the hardcoded pair read from the settings source (single source of truth:
   `coding-agent/settings.json`, via `$PI_SETTINGS`), so the merge stage in
   `generate.sh` is idempotent and the stage can no longer *fail to find a
   default*. The models.json-ordering constraint from d035 dies with the
   probing.
3. Changing the default is an edit to `coding-agent/settings.json` — one
   place, then re-run generation. The picker never overrode the operator's
   choice again.

## Why not keep a dynamic fallback

"detect whether the pick is callable at generation time" would need a real
authenticated request per candidate model — key spend and a probe oracle for
exactly the signal the reachability rule (docs/d033) refuses to trust. The
operator already knows which default works on this host; encoding that beats
any generation-time guess.

## Files

- `coding-agent/settings.json` — gains the hardcoded pair
- `coding-agent/generate-default-model.mjs` — returns the pair from the
  settings source, drops the models.json probe
- `coding-agent/generate.sh` — exports the settings source to the picker;
  merge stage unchanged (idempotent now)
