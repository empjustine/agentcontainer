# PENDING — pi-synthetic

Mid-state findings and open work for this folder. Written by a session that was
asked to **collapse the three data sources to one** and instead found an
in-flight change already rewriting the same files, so it stopped, verified, and
recorded what it learned rather than racing it.

`pi-synthetic/TODO.md` (written by the in-flight change) owns the forward
worklist for the shipped design. **This file owns (a) the findings that led to
the requested collapse, (b) the collapse's own scope, and (c) the defects the
in-flight change had not closed.**

> **UPDATE 2 (same day, later). §1 IS ADOPTED.** The three-source ladder is
> deleted: `sources.mjs` now fetches the provider's listing and nothing else,
> `merge.mjs` shapes one record from it, the route/relay machinery and the
> copy step are gone, the folder IS the pi package (`index.ts` at this level),
> and a failed fetch fails the run rather than falling back. What §1.2 said to
> KEEP is kept (`thinkingLevelMapFor`, `piCost`, `toInput`/the d049 gate,
> canonical sort), and one thing it said to DELETE was kept for a reason it
> predates: `ALIAS_TIER_IDS` survives as a WARN-ONLY checklist, not as injected
> rows — the listing is the sole source of truth, and a tier it stops serving
> is reported, not invented. The `syn:*` tiers and their target-bearing display
> names were an explicit user requirement, so they stay in whatever the listing
> serves. §1.4's stated consequence is now the design's honest position: a fresh
> checkout ages until someone regenerates, and `./generate.sh --check` is the
> gate that says so.
>
> **UPDATE (same day). `§3`'s four defects are all CLOSED**, by the session that
> owned the in-flight change, after this review arrived:
> §3.1 (cost — the blocker) and §3.2 (thinking levels) were fixed in
> `merge.mjs` and verified against the installed `pi-*` 1.4.0 packages;
> §3.3 was resolved by DELETING the unsound parser (the alias mapping is data,
> never re-derived from a display name); §3.4/§3.5/§3.6 (types, biome) are green,
> and `extension/types.d.ts` is gone.
> **§1 (the collapse to one source) is still undecided** — it is the user's call,
> and this file's argument for it is intact. Read §3 as a historical record of
> what was wrong at 23:07Z, not as open work.

State at the time of writing (2026-10-29 23:07Z, `v23.0: ssl vpn`):

| Gate                                                     | Result                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `node --test tests/pi-synthetic-merge.test.mjs`          | **19/19 pass**                                                                              |
| `merge.mjs` / `sources.mjs` vs their `extension/` copies | **in sync** (`cmp`)                                                                         |
| `./check-types.sh`                                       | **8 errors** in `generate.mjs`, `merge.mjs`, the test file                                  |
| `biome check pi-synthetic`                               | **4 format errors** (`TODO.md`, `extension/index.ts`, `extension/models.js`, `models.json`) |
| `./generate.sh` twice, offline                           | **byte-identical** (idempotent), 16 rows, `resolved: 4`                                     |

---

## 1. The requested change: collapse to the canonical source

**LANDED** (see UPDATE 2 above) — kept here as the record of why, since the
measurements below are the argument for the current design.

### 1.1 The finding that justifies it

Measured against the live listing (`SYNTHETIC_RELAY_URL=https://api.synthetic.new/openai/v1/models`),
comparing `mergeSources({live, catalog, prices})` with
`mergeSources({live, catalog: null, prices: new Map()})`:

|                                                                                    | live listing alone | models.dev slice                       | catwalk slice     |
| ---------------------------------------------------------------------------------- | ------------------ | -------------------------------------- | ----------------- |
| lineup                                                                             | **13 rows**        | 12 (4 already rotated away)            | never (ids drift) |
| every emitted field (name, context, maxTokens, reasoning, modalities, effort enum) | **all**            | changed **0** values                   | 0 values won      |
| complete four-field price block                                                    | **13/13**          | 4 incomplete (block therefore dropped) | 0 values won      |

`mergeSources` with and without the two vendored catalogs produced
**byte-identical model records**. catwalk's contribution was a strict superset
of models.dev's identical prices; models.dev's contribution was nothing. The
second and third rungs of a three-source precedence engine never fired.

Worse, they fired _wrong_: the vendored catalogs still carry
`hf:MiniMaxAI/MiniMax-M3`, `hf:Qwen/Qwen3.6-27B`, `hf:moonshotai/Kimi-K2.7-Code`
and `hf:zai-org/GLM-5.2`, which the provider has rotated away, while _omitting_
the `syn:*` tier the provider serves. So the committed artifact — when
generated offline, the default in this repo — was 4 ghosts plus a missing tier.

The user's framing, which this file adopts: if the provider's own metadata
endpoint is unreachable, then WAN/proxy/the provider are already broken, and a
stale second catalog cannot make anything work. The offline rungs buy nothing
and cost a precedence engine, a copy step, two env surfaces and a
source-availability-dependent lineup.

### 1.2 Scope of the collapse

Delete from `sources.mjs` (~475 → ~180 lines):

- `modelsDevSlice()`, `catwalkPrices()`, `effortValues()`
- `proxyBases()`, `relayCandidates()`, `tlsUnverifiable()`
- the `LIB_DIR` / `MODELS_DEV_JSON` / `CATWALK_FACTS_JSON` env surface
- `REVERSE_PROXY_BASE_URLS` / `SYNTHETIC_RELAY_URL` reads

Delete from `merge.mjs` (~440 → ~200 lines):

- per-field source precedence (`catalogById`, `liveById`, the `fresh`/`vendored`
  pairs), `composeCost`'s multi-source composition
- the `SourceModel.source` union's `"models.dev"`/`"catwalk"` members

**Keep, unchanged** — these are the folder's real value:

- `laysWithinPiModalities` / `toInput` (docs/d049 gate), `thinkingLevelMapFor`,
  `piCost` (docs/d057 complete-or-absent), canonical id sort (docs/d050).

Change in `generate.mjs`:

- one `fetch` of the fact table's canonical `baseUrl` + `/models`
- drop the `MIN_MODELS` floor and the "below half of previous" clamp (per the
  user: a bogus answer from the provider means the provider is down, and the
  fetch failing is the whole signal)
- drop `--update-extension-data` and the whole copy step; ship the folder as
  ONE pi package (`package.json` → `pi.extensions: ["./index.ts"]` at the
  folder root, so `pi install ./pi-synthetic -l` works with no `extension/`
  subfolder and no `cmp` discipline)

### 1.3 Second half: delete the route machinery, use the forward proxy

Per the user: this extension should not carry the reverse-proxy handling that
`coding-agent/generate-pi-coding-agent.mjs` needs for 1st/2nd-gen
`llm-reverse-proxy` limitations. The 3rd generation has real forward-proxy
capability (docs/d073/d077 modes C–E, docs/d094 chain, docs/d095
`vpn-relay.sh`), so a client can address canonical URLs directly.

Both consumers already have this path, so no new code is needed:

- `lib/node-run.sh` sets `NODE_USE_ENV_PROXY=1` per invocation, so
  `fetch(process.env.SYNTHETIC_BASE_URL + "/models")` rides the tunnel with zero
  code (docs/d074);
- `coding-agent/run.sh:303` uses `workload_network host` and forwards
  `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`, so pi in the sandbox resolves the canonical
  URL through the relay.

This deletes `proxyBases`/`relayCandidates`/`tlsUnverifiable` entirely rather
than porting them. Route/probe machinery stays in `coding-agent/route-probe.mjs`
for the generators that still need it (catalogs, lineup probes) — this folder
stops being a third hand-rolled client.

### 1.4 Consequences to state in the record

- **Drift moves to a commit.** Today a fresh checkout can render a live-fresh
  lineup with no generation run. After the collapse the committed seed ages
  until someone regenerates. Given the artifact is a reviewed diff, that is a
  better trade than a lineup that silently contradicts its own upstream.
- **The `coding-agent` seam becomes mandatory, not optional** (see §3), because
  `model-019` is models.dev-derived and would still carry the 4 rotated-away
  ids while `pi-synthetic/models.json` does not.
- **Docs to sync:** `docs/d096` §2/§4, `pi-synthetic/README.md`,
  `pi-synthetic/AGENTS.md` (drop "the copy step is the design, not a wart"),
  the root `README.md` folder row (line ~133) and index row (line ~285).

---

## 2. What the in-flight change actually did (different axis)

It kept all three sources and added a _provider-contract tier_ mechanism on top.
Useful to know before reverting or reconciling:

- `sources.mjs` — new `ALIAS_TIER_IDS` (`syn:large:text|vision`,
  `syn:small:text|vision`) and a `pointsAt` field parsed from the listing's
  `hugging_face_id`.
- `merge.mjs` — `mergeSources` force-injects the 4 tiers as `primary: "contract"`
  rows when no source lists them; `displayNameFor`/`parseDisplayName` encode the
  alias target into the display **name**; `withContractResolutions` re-hydrates a
  tier from the previous seed.
- `generate.mjs` — `seedMemory()` recovers `SYNTHETIC_ALIASES` + prior rows by
  scanning the committed `extension/models.js`.
- `extension/index.ts` — `withSeed()` re-points tiers at their target row's
  current attributes at refresh time.
- `tests/` — 5 new tests (name round-trip, contract tiers, remembered aliases).

Net effect: more moving parts than the ladder it replaced. Reverting is the
honest move if the collapse lands — `git stash push -- pi-synthetic/` (or
`git checkout -- pi-synthetic/`) first, since `PENDING.md`, `TODO.md` and the
docs are also in the tree.

---

## 3. Defects open in the current tree (ALL CLOSED — see the note at the top)

### 3.1 BLOCKER (proven): four rows register **without** a `cost`, and pi throws on them

The committed seed omits `cost` for exactly the 4 rows whose models.dev block is
incomplete (`hf:MiniMaxAI/MiniMax-M3`, `hf:Qwen/Qwen3.6-27B`,
`hf:moonshotai/Kimi-K2.7-Code`, `hf:zai-org/GLM-5.2`) — that is `piCost`'s
complete-or-absent rule working as designed for a _schema-optional_ field.

But pi's **extension registration type requires it**:
`ProviderModelConfigBase.cost: AnyModel["cost"]` is **non-optional** in
`@earendil-works/pi-coding-agent` 1.4.0
(`dist/core/provider-composer.d.ts:20`). Reproduced against the real packages:

```
registered: [ 'hf:MiniMaxAI/MiniMax-M3' ]
cost field on the registered model: undefined
thinkingLevelMap on the registered model: undefined
costing a registered row THROWS: Cannot read properties of undefined (reading 'tiers')
```

`calculateCost(model, usage)` dereferences `model.cost.tiers` unconditionally
(`pi-ai/dist/models.js:672-691`), and every openai-completions turn calls it
(`api/openai-completions.js:1198`). A user selecting one of those 4 models gets a
thrown stream, not a zero-cost turn.

The `models.json` artifact is fine (`cost` really is optional there); it is the
**extension** path that is wrong. Fix belongs in `toExtensionModel`: always emit a
four-field block, zeros when unpublished — the extension's registration schema
makes presence mandatory, which is a different contract than the manifest's.

### 3.2 Thinking levels differ between the two artifacts' paths

Also proven against the real packages:

- extension path (`compat.supportsReasoningEffort` only, no `thinkingLevelMap`):
  `["off","minimal","low","medium","high"]`
- `models.json` path (`thinkingLevelMap` from the published enum, e.g. GLM-5.3):
  `["low","high","max"]`

`getSupportedThinkingLevels` (`pi-ai/dist/models.js:693`) returns levels
`off` through `high` **minus any explicitly `null`** when no map is present. So
the extension advertises a **`none`/off** level the provider's enum does not
publish for those models, and hides `max`/`xhigh` it does. A user cycling
thinking levels sees different options depending on which path registered the
model — the exact "one merge, two renderings" failure the folder exists to avoid.

Either emit `thinkingLevelMap` from the extension too (the folder already
derives it in `toPiModel`), or drop `thinkingLevelMap` from `models.json` so
both paths agree. The folder's own rule — no wire value invented — favors
emitting the map from the derived enum.

### 3.3 `parseDisplayName` is an unsound parser on arbitrary display names

`merge.mjs:88` — `/^(.+) \(([^()]+)\)$/` applied to names that are **not**
generated by `displayNameFor`:

```
"GLM 5.3"                            -> undefined          (ok)
"DeepSeek V4.1 Flash 10/17 (free)"   -> "free"             (wrong)
"Nemotron 3 Super 120B (NVFP4)"      -> "NVFP4"            (wrong)
```

Any upstream name ending in parentheses parses as an alias target. Today it is
only consulted for rows whose id is in `ALIAS_TIER_IDS`, so the damage is
bounded — but it makes the display name **load-bearing data**, which is the
opposite of what a display name should be. If the alias mapping is worth
keeping, carry it as a real field (a separate export, as
`SYNTHETIC_ALIASES` already is) and never re-derive it from `name`.

### 3.4 `merge.mjs:270` — the `primary` union lost `"contract"`

```
merge.mjs(270,37): error TS2322: Type '"contract"' is not assignable to
type '"catwalk" | "models.dev" | "api"'.
```

The `MergedModel` typedef was updated for the new provenance value; the
`SourceModel` typedef in `sources.mjs` was not. Cheap fix, but it is a type
gate failure, so `./check-types.sh` cannot pass as-is.

### 3.5 `./check-types.sh` — 8 errors total

Beyond 3.4: 5 × TS7006 implicit-`any` in `generate.mjs` (208, 213, 217) and
8 × `tier is possibly 'undefined'` in `tests/pi-synthetic-merge.test.mjs`
(266, 267, 289, 291, 295, 296, 302, 311). The repo standard is a green
type gate, so this must close before the change can land.

### 3.6 `biome check` — 4 format errors

`TODO.md`, `extension/index.ts`, `extension/models.js`, `models.json`. Note
`models.json` and `extension/models.js` are **generated**; per
`pi-synthetic/AGENTS.md` they belong in `biome.jsonc`'s `files.includes`
ignore list (same reasoning as `coding-agent/model-*.json`) — they are
**not** there yet, which is why the formatter argues with them.

### 3.7 `extension/index.ts` was edited outside the copy discipline

No defect, but worth recording: `extension/index.ts` is a hand-written sibling
of the copies, and the in-flight change edited it in place (adding
`displayNameFor`, `SYNTHETIC_ALIASES`, and the tier re-pointing loop in
`withSeed`). `pi-synthetic/AGENTS.md` says "edit the generator's copy, never the
extension's" — that rule is about `sources.mjs`/`merge.mjs`, and `index.ts` has
no generator copy, so this is legitimate. Recording it because the `cmp` checks
in `AGENTS.md` do not cover `index.ts` and a reader may assume they do.

---

## 4. Verified pi 1.4.0 contracts (so nobody re-derives them)

Because the sandbox that wrote this folder had no `@earendil-works/pi-*` packages,
the "Verify before trusting" list in `pi-synthetic/README.md` is still open.
A throwaway install (`npm i --prefix /tmp/pitypes @earendil-works/pi-coding-agent@1.4.0`)
settled several items without a live pi:

1. **`ProviderConfig.refreshModels` really is the legacy form and really does
   accept the returned array.** `dist/core/extensions/types.d.ts:1448`:
   `refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>`.
   The doc comment: "The returned list replaces extension-provided models."
   So the extension's shape is right; no migration to `context.publish({update})`
   is required.
2. **The context object matches what `index.ts` reads.**
   `RefreshModelsContext` (`pi-ai/dist/models.d.ts:15`) carries
   `{ credential?, stored?, publish, allowNetwork, force?, signal, baseUrl? }` —
   all of `RefreshContext`'s fields exist, and `signal` is **always present**
   (not optional), which the local interface currently over-declares as optional.
3. **`ModelsStoreEntry.stored.models` is `readonly AnyModel[]`** — i.e. pi's
   _pi-ai_ model shape, not the `ProviderModelConfig` shape this extension
   returns. `fromStore()` therefore hands back rows in a different shape than the
   refresh path. Probably fine (pi normalizes), but untested — see TODO.md #1.2.
4. **`compat` is the correct field name** (`ProviderChatModelConfig.compat`),
   confirming the in-flight rename from the invented `compatibility`. The
   ship-time type also demands `reasoning`, `contextWindow`, `maxTokens`, `input`
   and `cost` — see 3.1 for the one this extension violates.
5. **The `models.json` -> extension field mapping is exact.** `ProviderChatModelConfig`
   uses `model.id`, `name`, `reasoning`, `input`, `cost`, `contextWindow`,
   `maxTokens`, `thinkingLevelMap`, `compat`, `promptCache`, `samplingParams` — no
   spelling surprises.
6. **`extension/types.d.ts` is now obsolete but still NOT harmful** — it declares a
   module that a real host provides. It should be deleted (and `extension/index.ts`
   added to `tsconfig.json`'s `include` with a `paths` alias to the real
   packages) once a host has them; see TODO.md #1.5.

One caveat on 1–6: the type declarations are authoritative, the **runtime**
behaviour of `withSeed`'s tier re-pointing is not. That still needs a live pi.

---

## 5. Order of work

1. **Decide the axis** (§1 vs §2). If the collapse lands, revert first
   (`git stash push -- pi-synthetic/`), then land §1, then close §3.1/§3.2 in the
   collapsed shape — they are both symptoms of "two renderings of one record",
   which the collapse removes.
2. **If the current design is kept instead:** fix §3.1 (blocker), §3.2, reconcile
   §3.4, green `./check-types.sh` and `biome check`, add the generated files to
   `biome.jsonc`'s ignore list, then §3.3 (make the alias a real field).
3. Close the `coding-agent` seam (`TODO.md` §3 — currently blocked on the
   user's decision that the existing generators stay untouched until the
   `llm-reverse-proxy` deployment issues land).
4. Host-side verification (`TODO.md` §1) — still the only thing between
   "artifacts are right" and "it runs".

---

## 6. Housekeeping

- `pi-synthetic/TODO.md` is new and untracked; `pi-synthetic/models.json` and
  `pi-synthetic/extension/models.js` are generated but **not** in
  `biome.jsonc`'s ignore list.
- The staged blob (`git show :pi-synthetic/...`) still holds the pre-change
  versions, so `git diff` (unstaged) shows the in-flight delta and
  `git diff --cached` shows the original. `git checkout -- pi-synthetic/` would
  restore the **staged** content, i.e. revert the in-flight change — that is the
  intended revert path.
- Nothing outside `pi-synthetic/` and the 5 new tests was touched by the
  in-flight change: `README.md`'s folder/index rows still describe the
  three-source design, `docs/d096` still says "not verified", and
  `tsconfig.json` is unchanged.
