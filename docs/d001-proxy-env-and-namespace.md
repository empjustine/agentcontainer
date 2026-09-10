# d001: proxy env & baseUrl policy

## Context

Pi auto-detects providers from standard env vars (`OPENROUTER_API_KEY`,
`OPENCODE_API_KEY`, etc.). When one of these vars is present in the shell, pi
makes that provider's models available using its **built-in default URL** (e.g.
`https://openrouter.ai/api/v1`).

This is unwanted when the provider should only be reached through a **proxy**:
the default URL should never receive traffic, yet pi shows the models as
available the moment the env var is detected.

## Decisions

### 1.  Proxy config lives in the generator's process environment, not the shell

The provider generators (`llm-reverse-proxy/gen-lib.mjs`,
`coding-agent/generate-models.json.mjs`) read provider overrides from the
**process environment** (`process.env`, populated by `load_secrets` on the
host — Infisical via `load_secrets`, or keys already exported by the caller).
The shell environment is NOT consulted for `*_BASE_URL` vars directly — the
scripts read what Node gives it via `process.env`.  No `.env` file or
`$ENV_FILE` is read by anything in this repo (see
[load_secrets](../lib/workload-runtime.sh) for the contract).

### 2.  `baseUrl` is baked as a literal in the generated config

`baseUrl` in the generated peer / provider config (peer-cloud.yaml, models.json
overrides) does **not** support `$VAR` interpolation (only `apiKey` and
`headers` do, per pi's `models.md`). Therefore the generator reads
`OPENROUTER_BASE_URL` / `PEER_BASE_URL` (etc.) from the environment at
generation time and writes the resolved URL as a plain string into the
emitted file.

Re-run the generator when the proxy URL changes.

### 3.  No env-var prefix hides provider keys from pi auto-detection

Earlier revisions used a `__` double-underscore prefix on provider keys
(e.g. `__OPENROUTER_API_KEY`) so the *bare* name would not appear in the
shell and would not trigger pi's built-in provider auto-detection. The prefix
was removed: provider keys are read as plain env vars by `gen-lib.mjs`
(e.g. `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `CLINE_API_KEY`) and consumed
**server-side** by llama-swap (which resolves the `${env.*}` references in
`config.d/` from its own process environment). pi is only a *client* of
llama-swap and authenticates with the llama-swap bearer key (`PEER_API_KEY`),
so it never reads these provider keys and the prefix was unnecessary.
