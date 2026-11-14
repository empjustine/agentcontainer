---
id: scoped-models-and-proxy-overrides
type: module-design
status: draft
title: "Scoped models and proxy overrides — the distilled rationale"
parent: coding-agent
tags: ["design", "scoped-models", "overrides"]
---

# Scoped models and proxy overrides

The coding-agent container is configured on the host ahead of pi by
the generator, whose install target is the agent dir that
`./node-run.sh coding-agent/run.mjs` mounts at `~/.pi/agent` (docs/d054; credentials
arrive via the explicit env chain — see
Credentials below). This replaces the earlier, fragile
"generate a full model list" workflow with a **scoped models** approach.

## Approach

Instead of fetching live `/models` endpoints from each provider, filtering for
`:free` / `-free` variants, computing virtual costs, and re-generating a model
list client-side, the generators emit **only provider overrides** (`baseUrl` +
`apiKey`) for pi's built-in providers. pi then uses its **own** built-in model
catalog for each provider (kept fresh via `pi update --models`), simply
re-routed through the configured proxy/endpoint.

The specific models the agent actually uses are **not enumerated** by the
generator. The agent cycles pi's own catalog.

> **Deprecated: the `enabledModels` setting.** No coding-agent tooling sets it
> — the generators do not emit it, `run.sh` does not pin it, and the committed
> `settings.json` carries no such key (docs/requirements.md FR-U3). Earlier
> revisions of this document described a four-model opencode-go scope written
> into `settings.json`; that was never implemented and is no longer expected.
> An operator who wants a personal scope can still set the key in their own
> agent dir — pi honours it, and it is then operator state rather than this
> repo's contract.

## Credentials

There is no staged credentials file: the generated `models.json` carries
`"$VAR"` apiKey references that pi resolves from the container env at request
time — loaded once on the host by the explicit chain (`./environment.sh`,
`docs/d046-infisical-run.md`) and forwarded through the `workload_env`
allowlist. Credentials never touch `settings.json`.

## settings.json

Static `settings.json`, installed into `~/.pi/agent/settings.json` by the
generator (`generate.sh`; the runner mounts that dir, docs/d054).
(Default-model pinning is no longer generated dynamically.)

> **Deprecated:** the `OPENCODE_GO_API_KEY` name below is retired — OpenCode
> now uses the unified `OPENCODE_API_KEY` (rationale in
> **[d001](../docs/d001-proxy-env-and-namespace.md)** §3).

- The default model is pinned to the opencode-go subscription (DeepSeek V4
  Flash) **only** when `OPENCODE_GO_API_KEY` is present. When the key is absent
  the default fields are omitted so pi falls back to its built-in default
  model selection instead of failing on an unconfigured provider.
- `enabledModels` is **deprecated** — see the note above; no tooling sets it.

## Related decision records

- [`d001-proxy-env-and-namespace.md`](../docs/d001-proxy-env-and-namespace.md) — proxy
  env vars, plain un-prefixed key naming, `baseUrl` baking (in force; cited
  directly by `coding-agent/route-probe.mjs`,
  `coding-agent/refresh-models-dev.mjs`, `coding-agent/gen-lib.mjs`).
- [`d003-llamacpp-context-windows.md`](../docs/d003-llamacpp-context-windows.md) —
  generation-time context-window embedding (in force).
- [`d186-retire-legacy-full-catalog-notes.md`](../docs/d186-retire-legacy-full-catalog-notes.md) —
  the retirement of the free-tier generation notes (d004–d015) this approach
  replaced, with the surviving law mapped one note at a time.
