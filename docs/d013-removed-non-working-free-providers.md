# d013: removed non-working "free" providers

## Context

`generate-config.yaml.js` registers a set of providers that are *supposed* to
expose usable free (or free-tier) models via the generated `models.json`.
During use it turned out that several of these do **not** actually offer any
working free models through this flow, so they only contribute dead entries,
extra fetch attempts, and confusion.

The affected providers:

| Provider ID         | State in script before removal                         | Why it doesn't work                                              |
|---------------------|--------------------------------------------------------|------------------------------------------------------------------|
| `groq-free`         | active override (`requireApiKey: true`)                | Groq is built into pi already and exposes no usable free models via this flow |
| `xai-free`          | active override (`requireApiKey: true`)                | xAI/Grok is built into pi already and exposes no usable free models via this flow |
| `cerebras-free`     | active override (`requireApiKey: true`)                | Cerebras exposes no usable free models through the generated list |
| `huggingface-free`  | commented-out entry + `fetchHuggingFaceModels` fn      | Non-standard `/models` endpoint (`pipeline_tag` filter); commented out and never wired up |
| `bai-free`          | commented-out entry                                    | Dead/commented-out gateway entry; no real free model catalogue exposed |

## Decision

Remove all of the above from `generate-config.yaml.js`:

- Drop the `groq-free`, `xai-free`, and `cerebras-free` entries from
  `BUILDIN_PROVIDERS`, `DEFAULT_BASE_URLS`, `MODEL_FILTERS`, and
  `METADATA_PROVIDER_MAP`.
- Delete the commented-out `huggingface-free` and `bai-free` entries from the
  same four tables.
- Remove the dead commented-out `fetchHuggingFaceModels()` implementation and
  its special-case dispatch block in the model-fetch loop (both only referenced
  `huggingface-free`).

These providers are either already covered by pi's built-in catalogue or were
never functional in this script, so removing them simplifies the generation
path and avoids advertising models that don't exist on the free tier.

## Rationale

Keeping providers that produce no usable free models adds maintenance surface
(fetch attempts, filter entries, metadata mappings, dead code) for zero
benefit. pi already provides Groq / xAI / Cerebras as built-ins, so re-adding
them here is redundant. The commented-out Hugging Face / B.AI entries were
never operational and only obscured the list of actually-working providers.
