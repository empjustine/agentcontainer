# d012: intermediate JSON dumps to `./cloud-llm/`

## Context

Every tool that fetches model data from a provider endpoint or reads pi's
internal package structures should preserve the **raw, unfiltered** response
as a JSON file in `./cloud-llm/`. This enables offline inspection,
diffing across pi versions, debugging filter logic, and auditing what the
server actually returned.

## Decision

### All endpoint-fetching tools must dump raw JSON

| Tool                     | Data to dump                                    | Filename pattern              | Persisted?             |
|--------------------------|-------------------------------------------------|-------------------------------|------------------------|
| `dump-provider-models.mjs` | pi's internal `.models.js` definitions         | `pi-models.ndjson`            | yes                    |
| `generate-config.yaml.js`  | Raw `/models` response per provider             | `<provider>-raw-models.json`  | no (re-fetched via API)|
| `apply-models.js`        | Raw `/models` response from llama.cpp           | `llamacpp-raw-models.json`    | no (re-fetched via API)|
| `apply-pi-settings.js`   | Raw `/models` response from llama.cpp           | `llamacpp-raw-models.json`    | no (re-fetched via API)|
| `coding-agent/models.sh`| Raw `/models` response (via curl) *(removed — superseded by generate-config.yaml.js)* | `llamacpp-raw-models.json`    | no (re-fetched via API)|

> **Transient raw dumps:** the `<provider>-raw-models.json` and
> `llamacpp-raw-models.json` files are *not* persisted or committed. They are
> intermediate working artifacts that every tool above re-fetches from the live
> provider `/models` API on each run (given the relevant credentials, or a
> running llama.cpp server), so they can always be regenerated on demand. Only
> `pi-models.ndjson` (sourced from pi's installed package) and the transcribed
> `*-pricing.json` snapshots are kept in the repo.

### Dump directory

Persistent dumps go to `./cloud-llm/` relative to the repository root.
The transient `<provider>-raw-models.json` / `llamacpp-raw-models.json` files are
written to the same directory by the tools at runtime, but are not committed
(see the note under the table above).

Scripts in `cloud-llm/` write cloud-provider dumps to the `cloud-llm/` data
directory (`scriptDir`), and route the local llama.cpp dump to `../local-llm/`
via `join(scriptDir, "..", "local-llm")`.

*(Removed during the v13 refactor — llama.cpp `/models` is now fetched inline by
`generate-config.yaml.js` / `apply-models.js` when `LLAMACPP_BASE_URL` is set.)*
The `coding-agent/models.sh` script writes to `local-llm/llamacpp-raw-models.json`.

### Format

Two dump formats are used:

- **Catalog dump (`dump-provider-models.mjs`):** a single compact NDJSON file
  (`pi-models.ndjson`). Each line is one model object (`JSON.stringify` with no
  whitespace) and lines are sorted by `(provider, id)`. Every model carries a
  `provider` field, so the single file preserves the per-provider grouping that
  previously lived in separate `<provider>-models.json` files. The trailing
  newline terminates the final record.
- **Endpoint raw dumps (`generate-config.yaml.js`, `apply-*.js` *(`models.sh` removed)*):**
  pretty-printed JSON files with a trailing newline. The content is the
  **exact** response body `data` array (or the raw body if not an expected
  shape), before any filtering or transformation.

### No network calls for dump-only mode

`dump-provider-models.mjs` reads local files from the installed pi-ai package.
It never makes network calls.

## Rationale

Raw snapshots make it possible to:
- Verify what the server actually returned vs what the filter produced
- Detect upstream API changes (new model naming conventions, removed fields)
- Compare pi's built-in catalogue with the live API catalogue
- Debug filter logic offline without network access
- Track changes over time by committing the dumps (or diffing against a
  reference)
