# AGENTS.md — pi-mistral

The folder IS the pi package (`pi.package` in `package.json`) and its
`index.ts` is the extension entry. It is the mistral instance of
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
- `index.ts` deliberately has zero `../lib` imports: a copied package must
  stand alone. The upstream URL is a pinned constant; the tests assert the
  pin against the fact table.
