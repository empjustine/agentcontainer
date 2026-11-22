# AGENTS.md — pi-mistral

The folder IS the pi package (`pi.package` in `package.json`) and its
`index.mjs` is the extension entry. It is the mistral instance of
`../pi-opencode/AGENTS.md`'s watchdog rules (docs/d097, applied by
docs/d100) — read that one first. Only the mistral-specific deltas are
below:

- **mistral is built INTO pi-coding-agent**, so no model data may exist in
  this folder and `registerProvider` gets ONLY `refreshModels` — the
  fleet's chat-capable scoping of the lineup (dropping mistral-embed /
  voxtral-tts) is the models.json layer's job (model-012), never a
  watchdog's.
- **The listing is AUTH-GATED** (verified: 401 before any key is sent), so
  a MISSING `MISTRAL_API_KEY` returns `undefined` without a fetch — an
  unconfigured provider is hidden by pi anyway, and a "could not refresh"
  warning about it would be noise. With a key, the opencode rules apply
  unchanged (failure throws the catalog warning).
- `index.mjs` deliberately has no sibling module: a copied package must stand
  alone. The upstream URL is a pinned constant; the test asserts the pin
  against the fact-table row literal it carries.
- **The workspace MCP surface is a reference, not a registration.**
  `README.md`'s "Documentation references" names `https://api.mistral.ai/mcp`
  (key-gated, and it can redeploy or delete workspace objects). The fleet entry
  in `../coding-agent/mcp.json` stays `enabled: false` with `exposure: hidden`
  (docs/d061), and its header is `Bearer ${MISTRAL_API_KEY}` — an env
  reference, never a credential in the file.
