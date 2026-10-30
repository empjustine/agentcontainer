# TODO — pi-synthetic

Open items, in the order they can be worked. Each states what is blocked, what
"done" looks like, and what is already verified so a future session does not
re-derive it.

## 1. Host-side verification of the extension

**Mostly CLOSED.** `@earendil-works/pi-coding-agent@1.4.0` is npm-installable,
so the provider contracts are checked against the real packages, and
`tests/pi-synthetic.test.mjs` imports and RUNS the real entry point, feeding
every registered row through `calculateCost` and `getSupportedThinkingLevels`.
See `README.md` → "Checked against pi 1.4.0" for the two contracts that check
corrected.

### Still open — needs a running pi

1. **Load it and run a real turn.** `pi -e ./pi-synthetic/index.ts`,
   `/model synthetic …`, then a turn with a tool call and an image input, plus
   one `syn:*` tier — confirm the display name renders, and that the TIER id
   (not the target id) is what gets sent.
2. **The refresh path at runtime.** `ModelsStoreEntry.stored.models` is pi's
   `readonly AnyModel[]` — a different shape from the
   `ProviderModelConfig[]` this extension returns — and `fromStore()` hands
   that shape back on the offline path. Confirm pi normalizes it, and that a
   refresh which omits a row does not disturb a session using that model.
3. **Auth + wire.** `authHeader: true` against the real endpoint. **Auth is
   VERIFIED live**: `GET /openai/v1/models` and a
   `POST /openai/v1/chat/completions` turn both returned 200 with
   `Authorization: Bearer $SYNTHETIC_API_KEY`. The key reaches this sandbox
   through `run.sh`'s `workload_env_allowlist` intact (non-empty — the
   silent-drop mode the allowlist comment warns about did not fire); check the
   env before blaming the vault. The service also offers an Anthropic-compatible
   surface (`/anthropic/v1/messages`) which the fleet does not use and this
   folder deliberately does not offer — one surface, one wire.
4. **Type-check `index.ts` for real.** It is out of `tsconfig.json` because its
   pi import is host-provided. Once a host has the packages, add a `paths`
   alias and include it, or keep relying on the executed test and say so here.

## 2. The mirror-dependent questions — RESOLVED (mirror now mounted)

**BOTH ANSWERED.** The farm is at `~/Downloads/references/github.com/` (bare
mirrors, read with `git -C <path> …` — note the path has `.com`: the
`references/github/` directory the older `../docs/d043`/`d044` wording
points at holds only `webrecorder`).

1. **The catwalk cache-field pairing — NEITHER SIDE IS WRONG.** catwalk's own
   schema is explicit (`CRUSH.md`: `cost_per_1m_in_cached` = cache
   **creation/write** price, `cost_per_1m_out_cached` = cache **read** price;
   same in `cmd/vercel/main.go`). So `../coding-agent/generate-pi-coding-agent.mjs`'s
   pairing `cache_read ← cost_per_1m_out_cached` / `cache_write ←
   cost_per_1m_in_cached` is correct — it only *looks* crossed relative to the
   naive field names ("out" suggests output, but cached tokens are input-side).
   No fix owed to the sibling runner.
2. **`aliou/pi-synthetic` as a cross-check.** Mirror copy present
   (`github.com/aliou/pi-synthetic.git`, tip `@0.30.0`). Already read (live
   clone) for the `authHeader`/Bearer detail and the "the provider's own
   listing is authoritative" idea; nothing was copied. Worth re-reading only if
   a runtime surprise turns up — that repo tracks pi closely and is the
   cheapest witness of a WORKING registration.

## 3. The seam into `coding-agent/` (deliberately blocked)

`../coding-agent/generate-pi-coding-agent.mjs` still derives the `synthetic` row
from models.dev alone (its own `PROVIDER_SPECS` entry → layer
`model-019-cloud-synthetic.json`). Two sources now describe one provider, and
they can drift silently: `model-019` carries models the provider has rotated
away, and misses the `syn:` tiers entirely.

**Blocked on purpose**: the existing generators keep working unchanged until the
deployment issues with the current `../llm-reverse-proxy/` are solved. Do not
start this until that lands.

Done looks like (either option, plus the doc sync):

- **A** — the `synthetic` `PROVIDER_SPECS` row reads this folder's shaped
  listing (import `pi-synthetic/sources.mjs` + `merge.mjs`, or read
  `pi-synthetic/models.json`), and `model-019` becomes a rendering of it.
- **B** — `coding-agent/generate.mjs` runs `pi-synthetic/generate.sh` as a
  pre-step and copies `model-019` from `pi-synthetic/models.json`.

Either way `model-019` stays CANONICAL (docs/d070), routing stays in
`coding-agent/`, and this folder gets registered in the root
`generate.mjs`/`build.mjs` if it should participate.

## 4. Smaller polish

- **`infinite:*` tiers — CLOSED, the filter stays.** Probed live with the
  fleet's key: a non-streamed call returns **400** ("Infinite models require
  streaming"), and the same call with `stream: true` returns **402** —
  *"Infinite models require an active Big plan subscription. Upgrade at
  https://synthetic.new/billing"*. The key authenticates fine (§1.3) but lacks
  the subscription tier, so `UNSUPPORTED_ID_PREFIXES` is not a gap to fill
  later — it is the correct behavior for this key level. Revisit only if the
  fleet ever holds a Big-plan key. Two wire facts for that day: the family
  REQUIRES `stream: true` even before billing matters, and the authoritative
  docs are at `https://synthetic.new/docs` **behind a login** — not mirrored
  in `~/Downloads/references` (no synthetic org in the farm, unlike
  `cline/cline` or `anomalyco/opencode`), so the 402's own error body is the
  cheapest offline citation.
- **`--check` in CI.** The flag exists and is proven both ways (clean run vs a
  hand-append). Wiring it into the repo's test or lint path would make "someone
  forgot to regenerate" a gate rather than a review catch.
- **Seed format versioning.** `index.ts` reads `SYNTHETIC_MODELS` and
  `SYNTHETIC_ALIASES` by name. A seed from an older shape should degrade to "no
  seed", never to a parse error — the current code has no such path because the
  seed is a plain import; keep it that way.
