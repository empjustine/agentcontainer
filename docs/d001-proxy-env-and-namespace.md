# d001: proxy env & namespace isolation

## Context

Pi auto-detects providers from standard env vars (`OPENROUTER_API_KEY`,
`OPENCODE_API_KEY`, etc.). When one of these vars is present in the shell, pi
makes that provider's models available using its **built-in default URL** (e.g.
`https://openrouter.ai/api/v1`).

This is unwanted when the provider should only be reached through a **proxy**:
the default URL should never receive traffic, yet pi shows the models as
available the moment the env var is detected.

## Decisions

### 1.  Proxy config lives in a dedicated `.env` file (not the shell)

`generate-config.yaml.js` reads provider overrides from the **process environment**
(via `--env-file` or exported vars). The shell environment is NOT consulted for
`*_BASE_URL` vars directly — the script reads what Node gives it via
`process.env` (populated by `--env-file` or manual `export`).

### 2.  `baseUrl` is baked as a literal in `models.json`

`baseUrl` in `models.json` does **not** support `$VAR` interpolation (only
`apiKey` and `headers` do, per pi's `models.md`). Therefore the script reads
`OPENROUTER_BASE_URL` (etc.) from the environment at generation time and writes
the resolved URL as a plain string into `models.json`.

Re-run the script when the proxy URL changes.

### 3.  API keys use `__` prefix for namespace isolation

> **Deprecated.** The `__`-prefixed key naming was retired. Generators now read
> plain env var names (e.g. `OPENCODE_API_KEY`, `OPENROUTER_API_KEY`); see
> **[d019](d019-unified-opencode-key.md)**.

Standard pi env vars like `OPENROUTER_API_KEY` cause pi to auto-detect the
provider with the default URL. To prevent this, API key vars use
**double-underscore-prefixed** names:

```
OPENROUTER_API_KEY=sk-or-v2-...
__OPENCODE_ZEN_API_KEY=sk-opencode-...
```

The script writes them into `models.json` as `"apiKey": "$OPENROUTER_API_KEY"`
— an env-var reference that pi resolves at runtime. Because pi does **not**
recognise `OPENROUTER_API_KEY` as a standard auth env var, the mere presence
of this var in the shell does **not** trigger auto-detection.

**Two usage modes:**
- **Sourced session:** `source ~/.pi/agent/proxy.env && pi` — the `__` vars
  are present for pi to resolve, no standard auth env vars are needed.
- **Persistent env:** set `OPENROUTER_API_KEY=...` in `.bashrc` alongside
  `OPENROUTER_API_KEY=...` for other tools. Both coexist.

### 4.  `resolveApiKeyEnv()` prefer-then-fallback

> **Deprecated.** `resolveApiKeyEnv()` (prefer `__`-prefixed, fall back to bare)
> was removed; `gen-lib.mjs` reads `apiKeyEnv` directly. See
> **[d019](d019-unified-opencode-key.md)**.

The helper `resolveApiKeyEnv("OPENROUTER_API_KEY")` first checks for the
`__`-prefixed var, then falls back to the bare `OPENROUTER_API_KEY`. Returns
the chosen name (or `""` when neither is set) so the script writes a `$VAR`
reference.
