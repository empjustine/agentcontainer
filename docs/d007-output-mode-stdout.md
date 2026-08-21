# d007: output mode — stdout only, no file merge

## Context

The original `generate-models.json.js` (staged at v9/v10; since split into
`openai-completions-peer/generate-config.yaml.js` for llama-swap config and
`coding-agent/generate-models.json.js` for pi models.json) accepted `-o <path>`,
`--print`, and a positional path argument. It read the existing `models.json`,
merged provider entries under `providers`, and wrote back. The current version
has been simplified.

## Decision

### Print generated JSON to stdout only

The script now prints the generated `{ providers: { ... } }` document to
**stdout** and nothing else. Warnings and errors go to stderr so they never
pollute the JSON output.

```
node coding-agent/generate-models.json.js > models.json
```

### No CLI flags

The `-o`, `--print`, and positional path arguments have been removed. The
script takes no arguments. Redirect stdout to persist the output.

### No merge with existing config

The script no longer reads or merges with an existing `~/.pi/agent/models.json`.
It emits a fresh document each run. The caller is responsible for merging or
replacing.

### Empty providers map on no input

When no env overrides are present and no model fetches succeed, the script
prints `{ "providers": {} }` with a warning on stderr (instead of exiting with
a fatal error).

## Rationale

Stdout output follows the Unix pipe philosophy — the caller decides where the
output goes. The caller (`coding-agent/run.sh` or the user) can redirect, pipe
through `jq`, or merge with other configs. This decouples generation from
deployment.
