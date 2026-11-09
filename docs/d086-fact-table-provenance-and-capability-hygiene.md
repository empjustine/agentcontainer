---
id: d086
type: module-design
status: active
title: "d086 — fact-table provenance, churn discipline, and capability hygiene"
parent: coding-agent
depends-on: [d047, d072, d079, d085]
references: [d021, d032, d114, d033]
---

# d086 — fact-table provenance, churn discipline, and capability hygiene

## Status

The `fetchedFrom` removal, the capability URL gate, and the churn recipe's
generator work have landed; layer separation is deferred — see the
[Implementation status](#implementation-status).

## 1. Context

Three findings from the fact-table churn review and the d085 funnel work:

1. **Churn anatomy (measured).** The v22.22 fact refresh moved one line in
   `lib/catwalk-facts.json` — only `fetchedAt`, data identical — 1–5 lines in
   the provider fact tables, and ~415k lines in the raw `models.dev` mirror,
   all inside a feature commit. Two species: timestamp-noise (a diff when
   nothing changed) and mirror-bloat (raw upstream dumps in git), hidden in
   feature history because the regen was not a standalone commit.
2. **The `fetchedFrom` leak.** The cache documents recorded the live fetch
   URL — which goes through the Funnel mount (`…​.ts.net/<funnel-mount>/<host>/…`,
   docs/d047 host-form route). The mount path IS the mode A capability
   (d070/d085): anyone with the URL reaches the proxy. The property is
   therefore a committed credential — in git history since v22.15 — and
   unstable on top: it churns whenever the mount or the relay chain rotates.
3. **Indistinguishable fixtures.** A test fixture carried a second
   mount-shaped URL; synthetic and live look identical to a reader.

d079 §3.5 already wanted provenance as "an exact commit SHA", not a live
URL. This record removes the URL property and pins the discipline that
makes provenance stable instead.

## 2. Decision

- **`fetchedFrom` is removed** from cache documents _and_ refresh logs
  (coding-agent/catalog-facts.mjs). The log echo was the same leak into
  shipped logs — the proxy's VPN-R44 redaction duty had exactly this
  rationale. Provenance is `fetchedAt` plus the file's own identity; the
  pinned-source provenance d079 §3.5 wants lands as the source id + upstream
  content hash in the `_meta` block below — never a URL with a mount in it.
- **Capability URL gate (lint.sh, gating).** No tracked file may contain a
  `.ts.net/<uuid>` shape; the only allowed instance is the canonical
  synthetic fixture (all-zero UUID). The leak is textual, so a plain pattern
  is the whole detector — it catches any writer, not just known generators.
- **Churn discipline** (landed — see the Implementation status):
  1. _Canonical serialization_ — sorted keys, stable order, normalized
     numbers: unchanged data ⇒ byte-identical file.
  2. _Hash short-circuit_ — skip the rewrite when the upstream and derived
     hashes are unchanged; `fetchedAt` bumps only when a hash moves. This is
     what actually deletes timestamp-noise.
  3. _`_meta` provenance block_ — stable leading block per generated file:
     schema, source id, upstream sha256, generator, regen command, owning
     decision. Grep answers "where from / how fresh / how regen / who owns
     it" — the grep-able frontmatter question, answered in JSON.
  4. _Layer separation_ — stable facts vs volatile observations in separate
     files; raw mirrors (models.dev) live outside git, hash-pinned.
  5. _Commit discipline_ — facts regens are standalone `chore(facts):`
     commits, never mixed into feature versions.
  6. _Idempotence lint_ — regenerate to temp; the diff must be empty.

## Implementation status

The recipe's generator half landed — canonical serialization, hash
short-circuit, `_meta` provenance, and the idempotence lint. Layer
separation stays deferred, and commit discipline was and remains process.

- **One home for the recipe.** `lib/fact-table.mjs` owns it for every fact
  table: `publishFactCache` for the wrapped caches (`lib/catwalk-facts.json`,
  `coding-agent/<id>-facts.json`) and `publishProviderMirror` for the raw
  models.dev mirror. `coding-agent/catalog-facts.mjs` and
  `coding-agent/refresh-models-dev.mjs` are its two callers, and both still
  write through the atomic tmp+rename choke point in `lib/artifact.mjs`.
- **Canonical ordering** stays in `lib/canonical-json.mjs`
  (`canonicalizeProviderCatalog`, `canonicalizeFactsCache`), so "is this
  collection a set?" is answered once for manifests and fact tables alike.
  Order-insensitivity is not tidiness here: it is what lets the writer decide
  "the facts did not move" at all.
- **`fetchedAt` now means when the CONTENT last moved**, never when the last
  fetch ran. A shape migration (a cache written before `_meta` existed)
  preserves the timestamp it found, and the refresh log separates
  `refreshed` from `unchanged — not rewritten` — so the age a stale-tolerant
  consumer reads is the data's real age instead of resetting every run.
- **`_meta` leads each wrapped cache** with `schema`, `source`,
  `contentSha256`, `generator`, `regen`, `decision`. The recipe above says
  "upstream sha256"; it is realized as the hash of the canonical facts — the
  records alone, `_meta` and `fetchedAt` excluded — because raw upstream
  bytes carry the vendor's own map iteration order. A hash of raw bytes would
  move on every fetch of identical data and could never short-circuit
  anything.
- **The raw mirror is exempt from `_meta`** (a narrowing of the block above):
  `lib/models.dev.api.json` _is_ the provider map every generator indexes by
  provider id, so a provenance member would sit in the provider namespace and
  the file would stop being a faithful mirror of upstream `api.json`. Its
  provenance is the `contentSha256` in the refresh log until it leaves git.
  It also keeps its tab indentation — 8.4 MB of vendored upstream JSON, where
  tabs are ~18% smaller; only its order is contractual, so the serializer
  difference from the 2-space manifests cannot reach a consumer or a diff.
- **Verified churn.** A refresh that finds identical facts now produces a
  zero diff: `tests/fact-table.test.mjs` publishes the same facts in a
  different arrival order and asserts the file is byte-identical and
  untouched. The same file guards the four committed caches — a cache whose
  bytes are not exactly what a refresh would write, or whose records do not
  match its `contentSha256`, fails by name. That guard is the idempotence
  lint, and it also catches a writer that bypasses the publisher.
- **Measured effect on the mirror.** Two committed captures of `api.json`
  with an identical 233-provider set (`9e2c138`, `ff9e90d`) differ by
  206,618/206,175 lines raw and 929/486 lines canonical — a ~290× drop, and
  what is left is the records that genuinely moved. The mirror's churn was
  ordering, not data.
- **Still deferred: layer separation.** Moving the raw mirror out of git and
  hash-pinning it changes offline generation, and the catalog's dependants are
  being retired from it in separate work — d108 already took estige out of the
  picture entirely, and most generators and the extensions are following. The
  move gets its own record once that shape is settled.

## Culling the mirror to the providers in use

The mirror is a full upstream `api.json` — 235 providers, 8.45 MB, 386,843
lines — while ten of those rows are read (`cloud-providers.json`: openrouter,
opencode, opencode-go, cline-pass, hyper, inferx, synthetic, mistral, google,
nvidia; verboo and llama-swap have no upstream row). Would culling it to the
rows in use, then canonicalizing, make the committed file less churn-prone?

**Canonicalization is already the answer to ordering churn** — the earlier
capture pair in this record measured a ~290× drop — and the two steps commute:
the canonical form of a slice is the slice of the canonical form. Culling is a
second, smaller lever, and it acts on the _size_ of what a refresh can touch,
not on whether it touches it. Measured 2026-11-08: the committed capture
(2026-11-05) against live upstream, both canonicalized with
`canonicalizeProviderCatalog` before counting `diff -u` lines, so only records
that moved remain; catwalk the same way over its `/v2/providers` listing:

| artifact      | as committed                    | culled to the ids in use                                                      | one refresh, changed lines    |
| ------------- | ------------------------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| mirror        | 8,449,958 B / 386,843 lines     | 719,218 B / 33,185 lines (11.7× smaller)                                      | 5,302 → 2,039, 217 → 64 hunks |
| catwalk facts | 880,371 B / 28,709 lines (41 p) | 212,483 B / 6,917 lines (openrouter, opencode-zen, opencode-go, gemini; 4.1×) | 484 → 220, 62 → 32 hunks      |

28 of the 235 providers moved in those three days and four of them are read
(`hyper`, `opencode`, `opencode-go`, `openrouter`); the largest movers are
unused rows (`edenai` ~16k committed lines, `cloudflare-ai-gateway` 3.8k).

**The reduction is smaller than the size ratio, and that is the finding.** The
kept providers are the fast-moving ones, so churn per kept line is roughly 4×
the whole-file rate (6.1% of the culled file against 1.4% of the full one).
Culling shrinks the absolute diff and the offline artifact — 8.45 MB → 719 KB is
a container-image and `--offline` win as much as a diff win — while the kept
slice cannot become stable, because opencode and openrouter gain models daily.
The lever that _deletes_ a diff instead of shrinking it stays layer separation,
still deferred in the Implementation status above.

What the cull would cost, and why it is not a filter on the writer:

- **The mirror stops being a mirror.** Its contract — the document _is_ the
  provider map, no wrapper, no `_meta`, byte-faithful to upstream — is exactly
  what a slice breaks. A slice is a derived cache: it needs the `_meta` block
  (source, `contentSha256`, regen, decision), a schema id, and
  `publishFactCache` in place of `publishProviderMirror`. The idempotence guard
  in `tests/fact-table.test.mjs` becomes "the committed bytes are exactly the
  slice a refresh would write".
- **The cull set is derived, never prose.** `cloud-providers.json` is the
  machine-readable source: a provider absent from it is read by nobody (d032's
  F9 — every consumer subsets the table explicitly). A set compiled from doc
  mentions would churn with prose edits and resurrect retired providers
  (`estige`, d108).
- **Absence becomes the normal case.** d021 exists because a provider missing
  from the catalog must skip with a warning; under a slice, 225 providers are
  missing by design, so the reader has to tell "not vendored" apart from
  "upstream outage" or the warning becomes noise.
- **The refresh validation inverts.** `refresh-models-dev.mjs` today requires
  every provider in the payload to carry a models map; a slice must also require
  every _used_ id to be present, or one typo in the table turns into a silently
  empty provider.

Verdict: a compatible, worthwhile step — 11.7× smaller artifact, 2.6× smaller
refresh diff — and not the churn fix. It is worth doing when the mirror's
contract is reopened for layer separation anyway, not instead of it.

## 3. Consequences

- **Rotation is required, not optional.** The d085-collapsed mount
  (`c143d52a-…`) is burned in history since v22.15 and a second mount shape
  since v22.20. Republish the Funnel under a fresh mount and unpublish the
  old; if the repo has been pushed to the forge, treat both as public.
  History rewrite is optional depth — rotation is the fix.
- `fetchedFrom` was write-only (no reader anywhere): the removal breaks no
  consumer.
- Accepted loss: "which relay candidate won" is no longer in the refresh
  log; the label and cache path still name the provider and artifact.

## 4. Options rejected

- **Keeping `fetchedFrom` with the mount scrubbed.** Leaves an unstable
  property churning caches, plus a scrubber one bug away from leaking —
  d085's lesson: two representations of one secret breed silent traps.
- **Provenance frontmatter alone.** Necessary and right, but churn dies only
  with determinism + the hash short-circuit; `_meta` without them just
  relocates the noise into a new block.
