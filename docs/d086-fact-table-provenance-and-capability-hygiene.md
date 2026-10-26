---
id: d086
type: decision
status: accepted (fetchedFrom removal + capability URL gate landed; the churn recipe's generator work is pending)
title: "d086 — fact-table provenance, churn discipline, and capability hygiene"
parent: coding-agent
depends-on: [d047, d072, d079, d085]
references: [d021, d027b, d033]
---

# d086 — fact-table provenance, churn discipline, and capability hygiene

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

- **`fetchedFrom` is removed** from cache documents *and* refresh logs
  (coding-agent/catalog-facts.mjs). The log echo was the same leak into
  shipped logs — the proxy's VPN-R44 redaction duty had exactly this
  rationale. Provenance is `fetchedAt` plus the file's own identity; the
  pinned-source provenance d079 §3.5 wants lands as the source id + upstream
  content hash in the `_meta` block below — never a URL with a mount in it.
- **Capability URL gate (lint.sh, gating).** No tracked file may contain a
  `.ts.net/<uuid>` shape; the only allowed instance is the canonical
  synthetic fixture (all-zero UUID). The leak is textual, so a plain pattern
  is the whole detector — it catches any writer, not just known generators.
- **Churn discipline** (accepted direction; generator work pending):
  1. *Canonical serialization* — sorted keys, stable order, normalized
     numbers: unchanged data ⇒ byte-identical file.
  2. *Hash short-circuit* — skip the rewrite when the upstream and derived
     hashes are unchanged; `fetchedAt` bumps only when a hash moves. This is
     what actually deletes timestamp-noise.
  3. *`_meta` provenance block* — stable leading block per generated file:
     schema, source id, upstream sha256, generator, regen command, owning
     decision. Grep answers "where from / how fresh / how regen / who owns
     it" — the grep-able frontmatter question, answered in JSON.
  4. *Layer separation* — stable facts vs volatile observations in separate
     files; raw mirrors (models.dev) live outside git, hash-pinned.
  5. *Commit discipline* — facts regens are standalone `chore(facts):`
     commits, never mixed into feature versions.
  6. *Idempotence lint* — regenerate to temp; the diff must be empty.

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
