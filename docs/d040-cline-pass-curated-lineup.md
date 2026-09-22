---
id: d040
type: bugfix
status: implemented
title: "d040 — cline-pass lineup is the curated ClinePass list, not Cline's catalog"
parent: d037
references:
  - d033
  - d037
  - d046b
  - d047
depends-on:
  - coding-agent
---

# d040 — cline-pass lineup is the curated ClinePass list, not Cline's catalog

**Status:** implemented

## Problem

`model-015-cloud-cline-pass.json` committed 445 models — Cline's full
usage-billing catalog (`z-ai/glm-5.3`, `openai/…`, `sakana/…`). Root cause: in
direct mode the generator syncs the lineup against the provider's live
`/models` listing, but api.cline.bot's `/models` serves the **`cline`**
provider's data, not ClinePass. The sync pruned every real
`cline-pass/<modelId>` entry (zero overlap) and appended all 445 live-only
records.

The authoritative lineup is Cline's published ClinePass model table
(bare mirror — the `~/Downloads/references/github.com/cline/cline.git` farm
clone first, `~/cline/cline.git` as the flat fallback — file
`docs/getting-started/clinepass.mdx`, "Models" section — 13 curated ids):

```
cline-pass/glm-5.3            cline-pass/deepseek-v4-pro
cline-pass/glm-5.2            cline-pass/deepseek-v4-flash
cline-pass/kimi-k3            cline-pass/mimo-v2.5
cline-pass/kimi-k2.7-code     cline-pass/mimo-v2.5-pro
cline-pass/kimi-k2.6          cline-pass/minimax-m3
cline-pass/qwen3.8-max        cline-pass/qwen3.7-max
                              cline-pass/qwen3.7-plus
```

## Decision

1. Pin that 13-id list as the committed fallback `modelAllowlist` on the
   cline-pass spec row in `generate-pi-coding-agent.mjs`. At emit time the
   lineup is actually derived from Cline's published docs table by
   `resolveClinePassAllowlist` (item 5); the constant only matters on a
   broken-facts run. The models.dev `cline-pass` slice (15 ids) is filtered
   through the derived list — under the union (item 5) that also adopts
   `deepseek-v4.1-flash` and `glm-5.3-flash`, which models.dev lists but
   the ClinePass docs table does not yet.
2. cline-pass opts out of live `/models` lineup sync (`liveSync: false`): its
   listing is a different provider's catalog, so pruning/appending against it
   is semantically wrong, not just noisy. Hyper/inferx keep their sync — their
   endpoints serve their own provider data.
3. Regenerate `model-015-cloud-cline-pass.json` (13 models, full models.dev
   metadata: contextWindow, costs, reasoning effort maps) and re-merge.
4. Assert the namespace structurally: the cline-pass spec also carries
   `modelIdPrefix: "cline-pass/"`, and the catalog filter drops any id that
   does not literally start with it. This is deliberately NOT expressed via
   the allowlist: models.dev intermittently mislabels the whole `cline`
   (usage-billing) catalog under the `cline-pass` key, and the prefix is
   ClinePass's own API contract — an id served without it is billed at
   standard API pricing instead of the subscription rate. The allowlist is a
   curation list; the prefix is a namespace assertion the lineup can never
   weaken.
5. Self-check the two sources against each other instead of trusting either.
   `resolveClinePassAllowlist` parses the `## Models` GFM table out of the
   published mdx (`parseClinePassDocs`, scoped to that section because the
   later `## Reference pricing` table is a different shape; every accepted id
   must carry the `cline-pass/` prefix, so the table doubles as the namespace
   assertion) and computes the overlap with the models.dev slice:
   `|docs ∩ catalog| / |docs|`. At or above `CLINE_PASS_MATCH_FLOOR` (0.8)
   the **union** of the two sources is adopted — docs ids first (the published
   contract), then catalog-only ids — so genuine lineup growth needs no code
   edit AND catalog-first additions (models.dev records landing before the
   docs table updates) self-adopt too; the emit-time catalog filter still
   intersects, so docs-only ids with no catalog record emit nothing. Below
   the floor the committed fallback wins and a loud warning fires. The floor
   catches both failure modes with one number: a models.dev pollution dump
   (docs models vanish from the slice → ratio ≈ 0) and a docs-table reshape
   (ids stop parsing → empty). The fallback stays safe because the
   `modelIdPrefix` guard still drops unprefixed ids, so a polluted slice
   yields no layer rather than a wrong-priced one.

   The docs source is best-effort: `CLINE_PASS_MDX` points at a plain file,
   `CLINE_MIRROR` overrides the mirror lookup, and a missing mirror (the
   normal container case) or a blob-less mirror without network falls back
   after a bounded 15s timeout. The lookup order (`readMirrorFile`) is the
   env override, then the host machine's
   `~/Downloads/references/github.com/cline/cline.git` farm clone, then the
   flat `~/cline/cline.git`; the first readable mirror wins. The flat mirror
   is a depth-1 `--filter=blob:none` bare mirror (the file blob is fetched
   lazily and can be pinned by SHA
   `0809340c2c5f999429bf8fd31c70dadb658aa238`).

## Related bugfix: live-listing input schema poisoning

The same live-listing surface bit the *openrouter* override later: the raw
`/models` listing's `architecture.input_modalities` (with `video`/`audio`/
`pdf`) was emitted verbatim by `piModel()`, producing 3+ element `input`
arrays that strict models.json schemas (cline) rejected wholesale — see
[docs/d046b-live-listing-input-schema-poisoning.md](d046b-live-listing-input-schema-poisoning.md).
Fixed with the `toInput()` text+image guard in `coding-agent/gen-lib.mjs`.
The two bugs share the same root: live listings are untrusted input the
generators must schema-guard before publishing in cline-consumed artifacts.
