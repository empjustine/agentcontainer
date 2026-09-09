# ClinePass peer-routing fix & localhost peer simplification

## Findings

### `generate-cline-pass.mjs` always used the real ClinePass baseUrl

`coding-agent/generate-cline-pass.mjs` is **not** an override generator like
`generate-models.json.mjs` / `generate-opencode.jsonc.mjs`. It is the **only**
source of the `cline-pass` provider definition: pi-coding-agent has **no native
`cline-pass` provider**, so the overlay layer it emits
(`model-015-cloud-cline-pass.json`) must carry the *full* provider block —
`baseUrl`, `api`, key/auth, `compat` and the complete models list — regardless
of reachability.

Before the fix the script was a purely static emitter: it always wrote

```jsonc
{ "baseUrl": "https://api.cline.bot/api/v1", "apiKey": "$CLINE_API_KEY",
  "authHeader": true, "compat": { "supportsDeveloperRole": false }, ... }
```

with no reachability probe and no peer fallback. On a host where
`api.cline.bot` is unreachable (DNS/conn-refused/TLS/timeout) but a bazzite
peer router is reachable, the other two generators correctly rewrite their
providers to route through the peer — but the cline-pass layer kept pointing at
the dead endpoint.

### The fix adds the same direct-first / peer-router cascade

`generate-cline-pass.mjs` now probes:

1. the **real** endpoint `https://api.cline.bot/api/v1` (via `GET /models`);
2. if unreachable, the **peer** candidates `[PEER_BASE_URL, bazzite tailscale
   FQDN]` (no localhost probes, see below);
3. if neither is usable, emit nothing and leave any existing layer untouched.

"Reachable" is the **network path**, not credentials: a 401/403 (or any http
response) proves the path works and keeps the real route; pi authenticates at
request time. Only the absence of *any* http response justifies a peer switch.

In **peer mode** the emitted block carries:

- `baseUrl` = the winning peer under `/v1` (e.g.
  `https://bazzite.coelacanth-barb.ts.net/<id>/v1`);
- `apiKey` = `"$PEER_API_KEY"` (the peer's bearer key — pi sends bearer by
  default, same as the other peer-routed providers; `authHeader` is not set in
  peer mode);
- `compat.supportsDeveloperRole: false` preserved (ClinePass rejects pi's
  `developer` role for reasoning models);
- the **full model list** the peer actually serves, each still enriched with
  the models.dev metadata (`name`, `reasoning`, `input`, limits, `cost`,
  `thinkingLevelMap`).

### Peer ids may be `cline-pass/cline-pass/<modelId>`

The bazzite FQDN is itself a relay pointing at a downstream cline-pass peer, so
its `/v1/models` catalog serves cline-pass entries **doubly prefixed**
(`cline-pass/cline-pass/deepseek-v4-flash`). `toCatalogId()` strips the repeated
`cline-pass/` prefix (any number of hops) and re-adds it once to resolve the id
back to the models.dev catalog key for metadata lookup. The **published** id is
always the exact id the peer returned (so pi routes against the peer), and a
peer-only model with no models.dev equivalent (`glm-5.3-flash`) is published
with minimal fields so it stays usable rather than silently dropped.

### ClinePass ownership is now single

`generate-models.json.mjs` previously carried a dormant `cline-pass` entry in
its cloud cascade (`CLOUD_PEER_IDS` / `CLOUD_PROVIDERS`). Because pi needs the
*full* cline-pass provider at all times, that responsibility belongs
exclusively to `generate-cline-pass.mjs`. The entry was removed from
`generate-models.json.mjs` so there is exactly one owner and no competing
layer. (The layer merge in `merge-models-json.mjs` takes the later
`model-015-*` layer, so even a duplicated cline-pass `model-010` entry would be
replaced — but that duplicate is now gone.)

`generate-opencode.jsonc.mjs` never attributed cline-pass in `classify()`
(its heads are `opencode`/`opencode-go`/`openrouter`/`gfx1030`), so it
has no cline-pass to remove; opencode simply has no built-in cline-pass.

## Simplification: no localhost peers

All coding-agent generators previously probed two localhost candidates:

- `http://localhost:8080` — the co-located LAN serving instance;
- `http://localhost:18080` — the legacy local-inference port (deprecated).

Both are only reachable *on the serving host itself* and, on a peers-only
host, a `localhost:8080` probe is a self-hit on the router the agent is already
bypassing. Those two candidates plus the `filter-relays.mjs` cleanup machinery
(`LOCAL_INFERENCE` / `SELF_RELAY`) existed to drop such localhost overrides
after the fact. With the candidates gone, no localhost override is ever
generated, so the cleanup machinery is dead.

Removed / changed:

- **`generate-models.json.mjs`** — `LOCAL_SOURCE_CANDIDATES` / `CLOUD_PEER_CANDIDATES`
  are now `[PEER_BASE_URL, bazzite tailscale FQDN]`; `cline-pass` dropped from
  the cloud cascade (single ownership).
- **`generate-opencode.jsonc.mjs`** — `CLOUD_PEER_CANDIDATES` / `LOCAL_SOURCE_CANDIDATES`
  are now `[PEER_BASE_URL, bazzite tailscale FQDN]`.
- **`generate-cline-pass.mjs`** — peer candidates are `[PEER_BASE_URL, bazzite
  tailscale FQDN]` (new in the fix).
- **`filter-relays.mjs`** — **deleted**.
- **`coding-agent/generate.sh`** — removed the relay-drop stage, the
  `LOCAL_INFERENCE` / `SELF_RELAY` env overrides, and `filter-relays.mjs`
  staging.
- **`coding-agent/run.sh`** — removed `filter-relays.mjs` staging and the
  `LOCAL_INFERENCE` / `SELF_RELAY` env forwarding.

The committed artifacts (`model-010-local-default.json`,
`model-015-cloud-cline-pass.json`, `models.json`, `opencode.jsonc`) were
regenerated from the current bazzite host and now route everything through the
bazzite tailscale FQDN — no `localhost` references remain.

## Env / runtime

- `PEER_BASE_URL` is the first peer candidate; the bazzite tailscale FQDN is
  the fallback. No localhost candidates exist anymore.
- `PEER_API_KEY` is the bearer key used for peer probes and for the
  `"$PEER_API_KEY"` api-key reference in peer-routed providers. `CLINE_API_KEY`
  is used only for the real-endpoint probe and remains the runtime key when the
  real route is kept.

## Future refactor: regular per-function generator naming

Today the three coding-agent generators have inconsistent, historically-grown
names that no longer describe what they do:

```text
generate-models.json.mjs       # emits model-010-local-default.json
generate-cline-pass.mjs        # emits model-015-cloud-cline-pass.json
generate-opencode.jsonc.mjs    # emits opencode config
```

`generate-models.json.mjs` is a catch-all: it handles BOTH the local
llama-swap layer AND the pi-native cloud providers (opencode / opencode-go /
openrouter). `generate-opencode.jsonc.mjs` is named after its *output format*
(jsonc) rather than its *function*. Neither name hints at the shared,
now-standardized behavior — the direct-first / peer-router cascade each one
runs.

The proposed structure groups generators by **what kind of provider they
produce**, with a per-function suffix, and drops the output-format from the
name:

```text
generate-cloud-pi-native-providers.mjs
    # THE pi providers pi already knows natively, where we only ever emit an
    # override when the real endpoint is unreachable ("swap only baseUrl /
    # apiKey"): opencode, opencode-go, openrouter.
    # = today's generate-models.json.mjs cloud cascade
    #   (generate-opencode.jsonc.mjs is the opencode-format twin of this)

generate-cloud-alternative-providers.mjs
    # THE providers pi does NOT ship natively, where the layer is the ONLY
    # source of the full provider definition and is always emitted in full
    # (baseUrl, key/auth, compat, complete models): for now only cline-pass.
    # = today's generate-cline-pass.mjs

generate-local-llama-swap.mjs
    # THE local GGUF / llama-swap layer, keyed off the live peer catalog.
    # = today's generate-models.json.mjs local cascade
```

Rationale for the split:

- **pi-native vs non-native is the real axis.** For the native set the layer is
  *optional* (an override; pi has a working default). For the alternative set
  the layer is *authoritative* (pi has no default — it must always be emitted in
  full). These have opposite merge semantics, so they should live in differently
  named files rather than share one catch-all.
- **The two cloud generators that already share the cascade have the same
  owner**: `generate-opencode.jsonc.mjs` reclassifies the same openrouter /
  opencode / opencode-go set into opencode's provider shape. A `-pi-native-`
  bucket names that shared responsibility instead of hiding it behind an
  output-format filename.
- **Local is a separate concern** already producing its own layer ids
  (`llama-swap`, plus the `local` opencode alias); giving it a function name
  removes the last reason `generate-models.json.mjs` exists as a grab-bag.

Notes to carry into the refactor:

- Output **layer ids are unchanged** — `model-010-local-default.json` and
  `model-015-cloud-cline-pass.json` are referenced by `generate.sh` and the
  merge contract in `merge-models-json.mjs`; renaming the *scripts* must not
  renumber the layers. Keep the `model-` / `00-` prefixes stable so merge order
  and the doc table in `merge-models-json.mjs` stay correct.
- Update every caller: `generate.sh`'s stage list and invocation lines, and the
  generator map in `coding-agent/run.sh`.
- `generate-opencode.jsonc.mjs` emits a different output format than the
  models.json layers; if naming symmetry is desired later it can become
  `generate-opencode-config.mjs` or fold into the pi-native group via a shared
  catalog builder, but it is NOT a candidates change for the first pass.
- Keep the header doc-strings on each script: the *cascade rule* is now shared
  (already documented in all three) and the per-group difference to document is
  the pi-native override-only vs. alternative-authoritative semantic above.