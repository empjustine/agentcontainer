# d024 — Per-merge-semantic generator split & shared cloud provider facts

This applies the two remaining follow-ups from the d022/d023 audits — the
"d022 future refactor" (split the `generate-models.json.mjs` grab-bag by
merge semantics) and the d023 c3/c4 follow-up (unify the `CLOUD_PROVIDERS`
fact tables) — plus the opportunistic c4 constant (`DEFAULT_PEER_FALLBACK`)
and the two cosmetic leftovers d023 noted.

## 1. The split: one generator per merge semantic (d022 future refactor)

`generate-models.json.mjs` was a 398-line catch-all: the local llama-swap
cascade AND the pi-native cloud cascade in one file, with opposite layer
semantics (the local layer ADDS a provider pi doesn't ship; the cloud layer
is an override-ONLY emission that is usually empty). The split gives each
file exactly one semantic, with the d022-proposed per-function names:

| New file | Emits | Semantic | Was |
|---|---|---|---|
| `coding-agent/generate-local-llama-swap.mjs` | `model-010-local-default.json` | ADDS the `llama-swap` provider | local half of `generate-models.json.mjs` |
| `coding-agent/generate-cloud-pi-native-providers.mjs` | `model-012-cloud-pi-native.json` | override-ONLY (empty when every pi-native cloud endpoint is reachable) | cloud half of `generate-models.json.mjs` |
| `coding-agent/generate-cloud-alternative-providers.mjs` | `model-015-cloud-cline-pass.json` | AUTHORITATIVE full block (pi has no native `cline-pass`) | `generate-cline-pass.mjs` (renamed) |

`generate-opencode.jsonc.mjs` keeps its name (d022 explicitly deferred it):
it is the opencode-format twin of the pi-native generator.

### Layer renumbering — the one deliberate contract change

Splitting the grab-bag forced one decision d022 left open: its "layer ids
unchanged" constraint assumed a pure rename, but two generators cannot write
one file. The cloud cascade now emits its own layer,
`model-012-cloud-pi-native.json` (the zero-padded lexorank keeps it between
`010` and `015`, so merge order is unchanged). Because the pi-native cloud
overrides and the `llama-swap` provider are disjoint provider ids, the merge
result is byte-identical — verified by splitting the committed
`model-010-local-default.json` mechanically and re-running
`merge-models-json.mjs`: the merged `models.json` was byte-identical to the
committed artifact. `merge-models-json.mjs`'s layer table documents the new
row.

### Shared shaping moved to `lib/pi-models.mjs`

Both pi-layer generators shape the SAME probe output the same way
(llama-swap serves `meta.llamaswap` for local GGUF and peer-routed cloud
alike): `piModel()`, `displayName()`, `providerEntry()`, the
`LLAMA_SWAP_COMPAT` block and the `PiModel`/`PiProvider`/`LlmCompat` typedefs
now live once in `lib/pi-models.mjs` (imported via `LIB_DIR`). The
pi-shaped-vs-opencode-shaped split the d023 audit preserved is untouched —
this is only the pi-side shaping.

## 2. One provider fact table: `lib/cloud-providers.mjs` (d023 c3/c4)

The cloud provider facts (id, label, key env, real base URL) were declared
three times with drifting field names:

- `generate-models.json.mjs` `CLOUD_PROVIDERS` (`baseUrl`/`apiKeyEnv`)
- `generate-opencode.jsonc.mjs` `CLOUD_PROVIDERS` (`realBase`/`keyEnv`/`label`)
- `llm-reverse-proxy/gen-lib.mjs` `PROVIDERS` (`defaultBaseUrl`/`apiKeyEnv`)

They now live once in `lib/cloud-providers.mjs` (`CLOUD_PROVIDERS`, field
name `baseUrl`), plus `PI_NATIVE_CLOUD_IDS` — the pi-native trio — so the
"which subset does this family own" decision is named, not implied. Family
membership stays a consumer decision: the pi-native generator picks
`PI_NATIVE_CLOUD_IDS`, the opencode generator picks
`[opencode, opencode-go, openrouter]` (cline-pass deliberately
absent — opencode has no built-in cline-pass and the alternative layer owns
it), and `gen-lib.PROVIDERS` spreads its llama-swap extras (`filter`,
`modelsDev`) on top of the shared facts. A `defaultBaseUrl`/key-env change
is now a one-line edit in one file.

## 3. `DEFAULT_PEER_FALLBACK` (d023 c4)

The bazzite tailscale URL was pasted in four generators as
`BAZZITE_ROUTER_TAILSCALE_URL`. It is now `DEFAULT_PEER_FALLBACK` in
`lib/peer-probe.mjs` (next to the probe toolkit it is a candidate for), with
the "no localhost candidates" rationale documented once at the definition.
`gen-lib.mjs` re-exports it for `generate-gfx1030-models.mjs`, keeping that
generator's single-import convention.

## 4. Cosmetic leftovers from the d023 report

- `tests/check-sandbox.sh` and every `lib/workload-*.jq` header still said
  `sandbox-*.jq` (the pre-rename filenames) — corrected to `workload-*`.
- `biome.jsonc` / `gen-lib.mjs` called `OLD/` "gitignored", but there was no
  `.gitignore`. Added one (covers `OLD/` and the lowercase `old/` spelling
  `docs/architecture.md` uses), making the wording true.

## Caller/plumbing updates

- `coding-agent/generate.sh` — stage list, header stage table and invocation
  lines use the new names and the `model-012` layer; the scratch `lib/`
  staging list carries `cloud-providers.mjs` + `pi-models.mjs` alongside
  `log.mjs` + `peer-probe.mjs`.
- `coding-agent/run.sh` — the generator ro-mount list and the `/opt/lib`
  module mounts updated to match.
- `tsconfig.json` — new generator and lib files in; the removed ones out.
- `merge-models-json.mjs` — layer table + merge-order text.

## Verification

- `./check-types.sh` — green (strict checkJs over all new/renamed files).
- `./lint.sh` — green (shellcheck + jq compile gate).
- `biome check` — green (only the 6 pre-existing `useTemplate`/`useLiteralKeys` infos).
- `./tests/check-sandbox.sh` — green (3/3).
- End-to-end (live network + reachable bazzite peer, host keys injected):
  - `generate-local-llama-swap.mjs` and
    `generate-cloud-pi-native-providers.mjs` outputs were **byte-identical**
    to the committed `model-010` / `model-012` layers (after the mechanical
    split), and a scratch-staged run (`LIB_DIR` pointing at a staged `lib/`,
    exactly as `generate.sh` does) reproduced them again byte-for-byte.
  - `generate-opencode.jsonc.mjs` output was **byte-identical** to the
    committed `opencode.jsonc`.
  - `generate-cloud-alternative-providers.mjs` matched the committed
    `model-015` except `glm-5.3-flash`: the committed artifact predates the
    d023 catalog refresh, and the model has since gained a models.dev
    equivalent — it is now published with full metadata instead of the
    peer-only minimal fields. That layer (and `models.json`) were
    regenerated from the live run; the committed layer contract is otherwise
    unchanged.
  - `generate-gfx1030-models.mjs` synced 222 models through the shared
    fallback candidate; `generate-peer-cloud.yaml.mjs` regenerated the
    opencode/opencode-go/cline-pass peers byte-identically (openrouter's
    live fetch is blocked by this shell's TLS interception — environment,
    not code; the committed layer was restored).
