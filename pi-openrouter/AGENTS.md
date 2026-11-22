# AGENTS.md — pi-openrouter

**Reference documentation only: no code, no model data.** OpenRouter is built
into pi-coding-agent, so `../pi-opencode/AGENTS.md`'s built-in-provider rules
(docs/d097, applied family-wide by docs/d100) bind this folder unchanged:

- **No model data, ever** — no seed, no `models.json`, no generator. A returned
  model list REPLACES pi's whole provider catalog, so any copy here could only
  downgrade it. The fleet's lineup is `../coding-agent/models.json`.
- **The only content is `README.md`'s MCP reference** — where the vendor's live
  catalog and docs lookups live (`https://mcp.openrouter.ai/mcp`). Nothing in
  this tree reads it at runtime, and no test pins it: the endpoint is
  OAuth-gated, so a keyless assertion can only see its `401`.
- **No extension entry until there is something to register.** A registration
  that does land is the `refreshModels`-only watchdog shape
  (`../pi-opencode/index.mjs`), never a catalog; it brings `package.json` with
  `pi.extensions`, `index.mjs`, `tests/` and its `knip.jsonc` entry.
- **The fleet entry stays inert.** `../coding-agent/mcp.json` lists the server
  `enabled: false` with `exposure: hidden` (docs/d061), so a merge never hands a
  session a billable tool; turning it on is an operator step in `/mcp`, and the
  description keeps the trust clause that a hidden entry cannot show.
