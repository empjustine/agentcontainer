# d025 — shared model-data tables live in `lib/`

## Problem

The canonical GGUF model definitions (`llamacpp-model-data.json`) lived in
`llm-reverse-proxy/`, but the `local-llm/` cache tooling (`download_models.py`,
`fetch_hf_manifests.py`, `generate_vram_fit_tables.py`, `scan_cache_coverage.py`,
`fetch-model-cards.sh`) reads it directly via `../llm-reverse-proxy/…` — a data
edge that reaches into a sibling runner folder, outside the documented
"folder + `../lib`" standalone rule (docs/architecture.md). The rule prohibits
reaching into sibling *runners*; a file that is genuinely shared needs a home
that doesn't look like one runner reaching into another.

## Decision

Move `llamacpp-model-data.json` to the repo-level `lib/` (the shared
infrastructure folder, alongside `models.dev.api.json` and
`cloud-providers.mjs`). Shared **data** tables and shared **code** both live
there; a folder reading from `lib/` is always within its copy unit.

Ownership is unchanged: `llm-reverse-proxy/` still *owns* the table (its
generator and the manifest-refresh workflow drive its content — see
`docs/refresh-local-llm-manifest.md`); `local-llm/` is a consumer. The move only
changes *where the bytes live*, not who edits them.

`active-b.json` stays in `llm-reverse-proxy/` — it is an implementation detail
of that folder's model-id derivation (`docs/d003`), not shared.

## Consequences

- `generate-local-llm-models.yaml.mjs` reads it through the same `LIB_DIR`
  convention the other generators use for `log.mjs` / `peer-probe.mjs`.
- The `local-llm/` tools point at `../lib/llamacpp-model-data.json`.
- Adding a model to the catalog is still a single-file edit; consumers pick it
  up with no change.
