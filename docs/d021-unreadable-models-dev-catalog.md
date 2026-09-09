# d021: an unreadable models.dev catalog must skip providers, not abort the layer

## Context

The vendored `models.dev` catalog (`models.dev.api.json`) is the model-id source
of truth for two providers, and is read by two generators:

| Consumer | Reads | Provides |
|----------|-------|----------|
| `llm-reverse-proxy/gen-lib.mjs` → `loadModelsDev()`, called from `fetchPeerModels()` | `llm-reverse-proxy/models.dev.api.json` | model ids for the `modelsDev`-flagged peers: `opencode`, `opencode-go` (all models, unfiltered) |
| `coding-agent/generate-cline-pass.mjs` | `coding-agent/models.dev.api.json` | the `cline-pass` layer (`model-015-cloud-cline-pass.json`) |

Providers *without* the `modelsDev` flag take their ids from their own live
`/models` endpoint — today that is `openrouter`, filtered to `:free`. So a
catalog problem should only ever cost the OpenCode peers.

[`d018`](d018-split-config-d.md) already states the intended behaviour:

> `peer-cloud.yaml` — **removed** when no provider answers **AND** the models.dev
> catalog lacks the OpenCode entries; individual provider skips are granular, so
> one outage never blanks the others.

Note the distinction baked into that sentence: "catalog **lacks the OpenCode
entries**" is a handled condition, while an *unreadable* catalog is not handled
at all — and that is the bug. `refresh-models-dev.mjs` is atomic
(tmp + validate + rename), so **refreshing** can never corrupt the catalog; the
catalog can still be missing or unreadable for reasons refresh does not cover:

- a partial checkout (the generator tree without the 4.3 MB data file),
- a fresh clone where the blob was not fetched,
- a read-permission problem on the serving host,
- a caller pointing the refresh step at a different output path.

## Failure mode

`loadModelsDev()` is a bare read, and `fetchPeerModels()` wraps only the
*live-endpoint* branch in `try/catch` — the `modelsDev` branch is unprotected:

```js
export async function fetchPeerModels(p) {
  if (p.modelsDev) {
    const provider = loadModelsDev()[p.modelsDev];          // ← throws (ENOENT / EACCES / SyntaxError)
    if (!provider || typeof provider.models !== "object" || provider.models === null) {
      console.warn(`  warning: models.dev catalog has no provider "${p.modelsDev}" — skipping`);
      return null;
    }
    return Object.keys(provider.models);
  }
  const apiKey = process.env[p.apiKeyEnv] ?? "";
  try { /* live /models fetch — guarded */ }
  catch (err) { /* warn + null — granular skip, as documented */ }
}
```

`generate-peer-cloud.yaml.mjs` awaits `fetchPeerModels()` in a bare loop, so the
throw becomes an unhandled rejection (observed on node 24, from a checkout with
the catalog hidden):

```
Error: ENOENT: no such file or directory, open '…/llm-reverse-proxy/models.dev.api.json'
    at readFileSync (node:fs:441)
    at loadModelsDev (gen-lib.mjs:72)
    at fetchPeerModels (gen-lib.mjs:106)
    at main (generate-peer-cloud.yaml.mjs:29)
Node.js v24.18.0
exit=1
```

Consequences, all of them contrary to d018:

1. **The whole cloud-peer layer is lost** — including `openrouter`, which never
   consults the catalog.
2. **Nothing is written**, so a `peer-cloud.yaml` from an earlier run survives —
   violating the write-or-remove rule, and leaving llama-swap to load peers that
   may no longer be reachable.
3. **The failure is easy to misread as success** by anything wrapping the
   generator: config.d/ still looks populated. (`generate.sh` prints
   `warning: … failed; using existing config.d/ if present`, which is accurate
   but easy to skim past; `llm-reverse-proxy/generate.sh` now tracks
   generator failures explicitly and reports `config.d/ NOT regenerated
   (failed: …) — listed files may be stale` for exactly this reason.)

`coding-agent/generate-cline-pass.mjs` has the same shape at the top of
`main()`:

```js
const catalog = JSON.parse(readFileSync(API_JSON, "utf-8"));
const provider = catalog[PROVIDER_ID];
if (!provider) throw new Error(`provider ${PROVIDER_ID} not found in ${API_JSON}`);
```

Here the blast radius is smaller — `generate.sh` tolerates the failure and the
existing `model-015-…` layer is kept, which is the right outcome — but the
diagnostic is a stack trace instead of a one-line warning.

## Impact

| Consumer | Today | After the patch |
|----------|-------|-----------------|
| `generate-peer-cloud.yaml.mjs` | aborts the entire layer; stale `peer-cloud.yaml` kept; `openrouter` lost with it | warns per provider, skips `opencode` / `opencode-go`, still emits `openrouter`; if *no* provider answers, the generator's own write-or-remove rule applies |
| `generate-cline-pass.mjs` | stack trace, exit 1; caller keeps the existing layer (correct outcome, noisy log) | one-line warning, exit 0, no write; identical outcome, legible log |

## Patch

### 1. `llm-reverse-proxy/gen-lib.mjs` — guard the `modelsDev` branch

```diff
 export async function fetchPeerModels(p) {
   if (p.modelsDev) {
-    const provider = loadModelsDev()[p.modelsDev];
+    let provider;
+    try {
+      provider = loadModelsDev()[p.modelsDev];
+    } catch (err) {
+      // Unreadable catalog (missing file, permissions, truncated/partial
+      // checkout) must behave like "no entry": skip this provider, keep the
+      // rest of the layer.  See docs/d021.
+      console.warn(
+        `  warning: models.dev catalog unreadable: ` +
+        `${err?.code || err?.message || err} — skipping provider "${p.id}"`,
+      );
+      return null;
+    }
     if (!provider || typeof provider.models !== "object" || provider.models === null) {
```

Optionally hoist this into an exported `loadModelsDevSafe()` (returning `null`
instead of throwing) if other catalog readers appear; with one caller the inline
`try/catch` is enough.

### 2. `coding-agent/generate-cline-pass.mjs` — warn and return

```diff
 function main() {
-  const catalog = JSON.parse(readFileSync(API_JSON, "utf-8"));
+  let catalog;
+  try {
+    catalog = JSON.parse(readFileSync(API_JSON, "utf-8"));
+  } catch (err) {
+    // Best-effort layer: no write, keep whatever is already on disk.
+    // See docs/d021.
+    console.warn(
+      `  warning: models.dev catalog unreadable ` +
+      `(${err?.code || err?.message || err}) — skipping the ${PROVIDER_ID} layer`,
+    );
+    return;
+  }
   const provider = catalog[PROVIDER_ID];
-  if (!provider) throw new Error(`provider ${PROVIDER_ID} not found in ${API_JSON}`);
+  if (!provider) {
+    console.warn(`  warning: provider ${PROVIDER_ID} not found in ${API_JSON} — skipping layer`);
+    return;
+  }
```

Returning without writing (exit 0) matches the best-effort philosophy of
`refresh-models-dev.mjs` and keeps `generate.sh`'s `|| warning: … using existing
layer if present` from firing for a condition the generator itself has already
reported. The alternative — keep throwing and let `generate.sh` warn — produces
the same on-disk result; the only difference is who logs it.

## Verification

```sh
# Scratch checkout of upstream with the catalog hidden.  Note: /tmp is
# privileged on Android — use $TMPDIR / $PREFIX/tmp on Termux, not /tmp.
W="${TMPDIR:-${PREFIX:-/data/data/com.termux/files/usr}/tmp}/d021"
rm -rf "$W" && mkdir -p "$W" && git archive origin/main | tar -x -C "$W"

cd "$W/llm-reverse-proxy" && mv models.dev.api.json "$W/catalog.hidden"

node generate-peer-cloud.yaml.mjs; echo "exit=$?"
#   before: ENOENT stack trace (gen-lib.mjs:72 ← :106 ← generate-peer-cloud.yaml.mjs:29),
#           exit=1, peer-cloud.yaml untouched — whatever is in config.d/ is stale
#   after:  2 “catalog unreadable — skipping provider” warnings, exit=0,
#           peer-cloud.yaml written with openrouter only

mv "$W/catalog.hidden" models.dev.api.json

cd "$W/coding-agent" && mv models.dev.api.json "$W/catalog.hidden"
node generate-cline-pass.mjs "$W/out.json"; echo "exit=$?"
#   before: ENOENT stack trace, exit=1
#   after:  one warning, exit=0, $W/out.json NOT written (existing layer kept)
```

Expected end state with the catalog missing: `config.d/peer-cloud.yaml` carries
`openrouter` alone (ids from its own endpoint), and `config.d/` no longer holds
`10-local-llm-inference.yaml` on hosts without a container backend + GPU
(per d018). With the catalog present, all three peers return.

## Non-goals

The same unguarded-read shape exists for other static inputs —
`llamacpp-model-data.json` and `active-b.json` in
`generate-local-llm-models.yaml.mjs`, `llama-swap-core.json` in
`gen-lib.loadCore()`. Those only run on GPU-capable container hosts and their
absence means a genuinely broken checkout, so they are left alone here; wrap
them only if uniform messaging is wanted.

## Status

**Proposed — not applied.** Raised during the Termux realignment: until this
lands, anything driving these generators must treat a non-zero exit as
"config.d/ may be stale" rather than reporting the previous peer count as
current (see `llm-reverse-proxy/generate.sh`).

Related: [`d018-split-config-d.md`](d018-split-config-d.md) (layer + stale-output
rules), [`termux-serving.md`](termux-serving.md) (Termux serving environment).
