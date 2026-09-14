---
id: d040
type: bugfix
status: implemented
title: "d040 — cline-pass lineup is the curated ClinePass list, not Cline's catalog"
parent: d037
references:
  - d033
  - d037
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
(reference doc: `~/Downloads/references/github/cline/cline/docs/getting-started/clinepass.mdx`,
"Models" section — 13 curated ids):

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

1. Pin that 13-id list as `modelAllowlist` on the cline-pass spec row in
   `generate-cloud-providers.mjs`, citing the reference doc. The models.dev
   `cline-pass` slice (15 ids) is filtered through it — today that drops
   `deepseek-v4.1-flash` and `glm-5.3-flash`, which models.dev lists but the
   ClinePass docs do not. The allowlist wins; when Cline's docs add a model,
   the allowlist is the one edit.
2. cline-pass opts out of live `/models` lineup sync (`liveSync: false`): its
   listing is a different provider's catalog, so pruning/appending against it
   is semantically wrong, not just noisy. Hyper/inferx keep their sync — their
   endpoints serve their own provider data.
3. Regenerate `model-015-cloud-cline-pass.json` (13 models, full models.dev
   metadata: contextWindow, costs, reasoning effort maps) and re-merge.
