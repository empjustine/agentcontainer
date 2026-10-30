---
id: d100
type: decision
status: implemented
title: "d100 — the pi provider extension family: every important provider as a pi package, forward-proxy only, provenance documented"
parent: coding-agent
depends-on: [d064, d090, d096, d097]
references: [d028-superseded, d033, d040, d046b, d049, d057, d070, d074, d080, d092]
tags: [providers, pi, extensions, coding-agent, hyper, verboo, mistral, opencode, provenance, forward-proxy]
---

# d100 — the pi provider extension family

## Problem

Three extension folders existed (pi-synthetic, pi-cline-pass, pi-opencode-go)
against a first-class tier of six providers — and the operator's directive
went further than the tier: hyper, mistral, opencode (zen) and verboo were
all named as important, with a hint that opencode might unify with the
opencode-go folder. Unlike cline-pass (whose own `/models` serves a
DIFFERENT provider, which is why that folder reconciles two published
sources), hyper, verboo — and llama-swap — each serve a usable, authoritative
model catalog endpoint of their own.

Separately, a provenance review of the existing folders and generators found
exactly one behavioral copy in the tree (the hyper compat mirror) and one
deployment-shaped caveat (cline-pass's sources sit outside the fact table,
fine under the forward proxy, unreachable under mode-A-only egress) — with
no documented home for either.

## Decision

The pattern split d096/d097 established is the whole design: **pi does not
build the provider in → the folder carries its catalog** (the pi-synthetic
shape: one live listing at the canonical upstream, throw-on-failure,
committed `models.json` + `models.js` pair, `--check` drift gate);
**pi builds it in → the folder is a watchdog** (the d097 shape: only
`refreshModels`, never a model list). Four additions and one unification:

- **`pi-hyper/`** (catalog-carrying): the provider's own `/provider`
  document is the one source — PUBLIC, so a keyless regeneration shapes the
  same catalog. Carries the fleet row's transcribed wire-compat mirror and
  ON_OFF thinking map (the provenance flag below), the UA client-identity
  convention with our package name, and the verified cached-price pairing.
  Landing parity with the fleet's model-016: 23/23 ids, equal values except
  one `deepseek-v4.1-flash` context window the LIVE listing has corrected
  since the fleet layer was last regenerated — the same drift class as
  synthetic's open seam, visible at landing.
- **`pi-verboo/`** (catalog-carrying): the `/models` listing is the only
  lineup that can exist (models.dev carries no verboo row, the fleet's
  catalogOptional case) and it is AUTH-GATED, so regeneration needs
  `VERBOO_API_KEY`. The listing publishes capabilities but no prices and no
  output limits, and the artifacts assert neither (manifest omits `cost`
  and `maxTokens`; the extension fills the mandatory zeros and the
  schema's own 16384). The committed pair was SEEDED from the fleet's facts
  cache of the same listing (2026-10-29) by running the real generate path
  with only the transport stubbed — the first keyed regeneration is the
  honest refresh.
- **`pi-mistral/`** (watchdog): mistral is pi-native, so no catalog; the
  one divergence from the opencode watchdogs is the auth-gated listing —
  without `MISTRAL_API_KEY` there is nothing to observe and the watchdog
  stays silent (pi hides the unconfigured provider anyway), where a public
  listing's keyless failure means the endpoint moved and is worth the
  warning.
- **`pi-opencode/`** (watchdog, UNIFIED): the former pi-opencode-go folder,
  renamed by `git mv`, registering BOTH `opencode` (zen) and
  `opencode-go` — one vendor family, one key env, per-provider interval
  clocks so one outage cannot silence the other. d097's rule is unchanged;
  its Amendment section records the move.
- **`pi-llama-swap/` is deliberately deferred.** The upstream is the
  llama-swap host's tsnet-only serve hostname — not a public DNS name, so
  the d080 forward-proxy posture ("any public DNS name on the policy's
  ports") does not cover it; the auth is the proxy's own key; and the
  lineup exists nowhere but the live farm. An extension for it needs a
  reachability decision that is a deployment fact (tailnet membership of
  the tunnel exit), not a code fact — recorded here so the gap is a
  decision, not an oversight.

Every folder in the family is third-generation transport only: canonical
fact-table URLs committed verbatim (d070), requests riding
`NODE_USE_ENV_PROXY=1` + the forwarded `HTTP(S)_PROXY` (d074), zero
relay/route machinery — the extensions are not clients of the
llm-reverse-proxy at all.

**Provenance sections are now part of the family contract.** Every
`pi-*/README.md` and `coding-agent/DESIGN.md` carries a Provenance section
classifying every cross-repo reference as LIVE DATA (self-correcting — fact
table, provider listings, catalogs), ATTRIBUTION (read, credited, nothing
copied — aliou/pi-synthetic), or BEHAVIORAL COPY — and every behavioral
copy must be flagged with its rot risk. The tree's one behavioral copy is
the hyper compat mirror (charmbracelet/pi-hyper-provider `src/models.ts`,
transcribed in both the fleet generator's modelCompat and
pi-hyper/merge.mjs): upstream can revise its table and no tripwire exists.
Today's mitigations are documentation-at-the-copy plus the extension tests
pinning the transcribed values (a silent LOCAL edit is caught; an upstream
change is caught only by a human re-deriving). The honest fixes — deriving
compat from what hyper's own listing publishes, or pinning a tested commit
of that repo — are open. Second caveat, documented in pi-cline-pass's
section: models.dev and raw.githubusercontent.com are outside the fact
table, reachable by design under the forward proxy (d080) and unreachable
under mode-A-only egress (d047 allowlist) — the committed artifacts are the
mode-A state.

## Consequences

- The family now covers five of six first-class providers (all but
  llama-swap, deferred above) plus mistral (best-effort tier) and opencode
  zen (superficial tier — a watchdog costs no generation-time work and
  substitutes nothing, so it does not contradict that tier's "not
  smoke-tested" contract; it is the operator's explicit call, recorded
  here).
- Three fleet seams now exist (synthetic, hyper, verboo): each provider has
  two committed descriptions — the fleet layer (models.dev-derived and/or
  facts-cache-enriched) and the extension folder's (live-listing-derived).
  All three joins are blocked on the same llm-reverse-proxy deployment
  decision; the drift is real (synthetic's rotated-away ghosts; hyper's
  stale context window) and each folder's README says so.
- verboo's committed pair ages until the first keyed regeneration — the
  same "fresh checkout ages until someone regenerates" posture d096
  adopted, with the seeding provenance recorded in its AGENTS.md.
- What is still NOT verified, for the new folders exactly as for d096/d097:
  a real turn. No pi process has loaded pi-hyper/pi-verboo/pi-mistral or the
  unified pi-opencode; the suites import and run the real entries, and
  pi-hyper's artifacts were generated from the live endpoint, but the
  transport-through-tunnel path is exercised only by the generators.

## Alternatives rejected

- **One mega-folder registering every provider** — cross-provider coupling
  (a cline-pass lineup regression would touch every other provider's
  package), and the standalone copy unit (folder + `../lib`) balloons.
- **Watchdogs for hyper/verboo** — pi does not build them in, so there is
  no built-in catalog to protect and nothing to watch: the provider would
  simply not exist for a session without the fleet's agent dir.
- **Catalog-carrying folders for mistral/opencode/opencode-go** — d097's
  substitution rule: a returned list REPLACES the built-in catalog and can
  only downgrade it.
- **Porting the relay ladder into the new folders** — the point of the
  third generation is that it is not needed; every new folder was written
  route-free from the start rather than retrofitted.

## Verification

- `node --test` over the six extension suites: 100 tests, all green
  (pi-synthetic 19→, pi-cline-pass, pi-opencode extended for both providers
  and per-provider interval independence, plus the three new suites).
- `./pi-hyper/generate.sh` against the live public endpoint: 23 models,
  artifacts committed, `--check` clean on rerun (byte-idempotent).
- Landing parity diff vs model-016: identical lineup and values except the
  one live-fresh context window recorded above; compat key order aligned
  with the fleet literal so a future seam-unifying diff is clean.
- pi-verboo's committed pair byte-equal to what the real generate path
  produces over the seeded listing (the seeding ran that very path).
- `./check-types.sh` and `biome check` green for the new folders (tsconfig
  and biome wiring updated; generated artifacts ignored like their
  siblings).
