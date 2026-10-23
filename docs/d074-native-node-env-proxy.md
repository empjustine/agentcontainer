---
id: d074
type: decision
status: implemented
title: "d074 — retire the fetch proxy monkey-patch; rely on NODE_USE_ENV_PROXY"
parent: coding-agent
depends-on: [d001, d023, d071]
references: [d039, d041, d051, d063]
tags: ["generators", "proxy", "node", "fetch", "env", "coding-agent"]
---

# d074 — retire the fetch proxy monkey-patch

**Status: implemented.**

## Problem

The generator modules carried a repo-side proxy shim: `useEnvProxy()` in
`coding-agent/route-probe.mjs` detected `http(s)_proxy` and installed
undici's `EnvHttpProxyAgent` via `setGlobalDispatcher`, called at module
load and re-called by `refresh-models-dev.mjs` and `catalog-facts.mjs`. It
was written when Node had no native way to make `fetch()` honor the standard
proxy env (the rationale it cited was docs/d001 §1).

It was wrong in three ways:

- **It duplicated a platform feature.** Node v24.0.0 / v22.21.0 added
  `NODE_USE_ENV_PROXY=1`, which makes global `fetch()` **and**
  `http`/`https` honor `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
  natively (Node's pre-execution step installs undici's own
  `EnvHttpProxyAgent`).
- **It silently degraded.** A missing/unresolvable `undici` dropped proxy
  support with only a warning; the native path has no optional dependency to
 miss.
- **It shadowed the native dispatcher.** A repo `setGlobalDispatcher`
  replaces the process-global dispatcher `NODE_USE_ENV_PROXY` would install,
  so the two can never be combined and the repo copy can drift from Node's.

## Decision

1. **Delete `useEnvProxy()` and its call sites** (`route-probe.mjs`,
   `refresh-models-dev.mjs`, `catalog-facts.mjs`). No repo-side dispatcher
   remains; the comment left where the function was states why it must not
   come back (a repo dispatcher would only shadow the native one).
2. **Set `NODE_USE_ENV_PROXY=1` where generator/agent node runs:**
   - `lib/node-run.sh` — per-invocation on both arms (Termux `node` and
     `mise exec node@24 -- node`), never exported, so sourcing the shim still
     sets no global state (d041's contract). `lib/node-run.ps1` is unchanged:
     its consumers are the Windows mirror-maintenance scripts (d062), not the
     generators.
   - `coding-agent/Containerfile` — in the image `ENV` block, so the
     agent's own node honors proxy env inside the container.
3. **Version floor recorded, not gated.** The variable exists from Node
   22.21 / 24. An older system node (a Termux host below that) silently
   ignores it — the same "a current node is the environment's job" stance as
   d051, with no new version gate.

## Consequences

- Proxy handling is one platform switch, not a repo module; the three
  generators lose an import, a function, and an optional `undici` load.
- The old failure mode ("proxy set but undici unavailable") is gone; the new
  one is a silent no-op on pre-22.21 node, recorded here.
- docs/d001 §1 (proxy config in the generator's process env) still governs how
  *base URLs* are baked; only the fetch-dispatcher mechanism changed.
- d023's "the undici `EnvHttpProxyAgent` setup moved here too" and d071's
  mention of `useEnvProxy()` are historical; this record supersedes the
  mechanism they describe.

## Verification

- `grep` for `useEnvProxy` / `EnvHttpProxyAgent` / `undici` under
  `coding-agent/` returns only the retirement comment.
- `node --check` on the three edited modules; `sh -n lib/node-run.sh`.
