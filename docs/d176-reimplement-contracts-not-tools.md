---
id: d176
type: architecture-design
status: draft
title: "d176 — the end-game: reimplement the Promnesia and hister contracts, not the tools"
parent: architecture
depends-on: [d172, d175]
references: [d173, d174, personal-datalakehouse-prior-art, d178]
tags: ["end-game", "contracts", "promnesia", "hister", "data-model", "licensing", "personal-search"]
---

# d176 — reimplement the contracts, not the tools

This record fixes the end-game: the personal browsing index imitates Promnesia's
and hister's contracts and depends on neither implementation. It states the two
contracts, the one-store-with-two-faces target, and the license boundary that
makes code reuse a liability. The reader is whoever builds or audits the
replacement. What is decided: the data models, the behavior and the query shapes
are copied; the code is not.

## Status

Draft — a direction, not yet built. [d172](d172-push-based-browsing-index.md) and
[d175](d175-hister-tiering.md) remain the nearer proposals, and this record keeps
either tool from becoming a runtime dependency of the end-game.

## The Promnesia contract

- **Store.** A visit is `(norm_url, orig_url, dt, locator_title, locator_href,
  src, context, duration)`, one row per visit.
- **Behave.** Canonicalize URLs aggressively; keep the per-visit timeline; answer
  visited marks, the context sidebar, search-around and per-visit search;
  local-first, with sources merged and deduped.
- **Source.** `karlicoss/promnesia` (MIT). The model is described in
  [d172](d172-push-based-browsing-index.md).

## The hister contract

- **Store.** One current document per normalized URL and owner: `text`,
  `html`, `title`, `favicon`, `language`, `added`, `updated`,
  `add_count`, version diffs, labels and metadata, with content-addressed
  blobs.
- **Behave.** Capture automatically per visit; full-text and semantic search;
  facets; version and preview reconstruction; allow and skip rules; per-user
  ownership; operator-owned retention and erasure.
- **Source.** `asciimoo/hister` (AGPL-3.0). The storage is described in
  [d175](d175-hister-tiering.md).

The two contracts cover different facts. Promnesia has visits and no content;
hister has content and no visit timeline. Neither tool is the target; the union
of their shapes is.

## One store, two faces

- A **visit fact table** and a **document fact table** in one tiered store.
- A **serving layer** that exposes the Promnesia-shaped API for the sidebar and
  the visited marks, and the hister-shaped API for search, facets and versions.
- **One push producer**, the browser extension of d172, feeding both tables.
- The **tiers of d173** below, and the cold search of
  [d177](d177-cold-full-text-search.md) where the data goes cold.
- The **workload of [d178](d178-datalakehouse-workload.md)** above both:
  trickle-bursty writes and the single hot read, the visited check.

## The license boundary

- **Promnesia is MIT.** Vendoring `cannon.py` or the response shapes is fine with
  attribution, which is why d172 imports it.
- **hister is AGPL-3.0.** Copying its extractors, normalizer or indexer puts a
  network service under the AGPL source obligation. Reimplementation from
  behavior and documentation is the safe path.
- The reference farm's AGPL cluster — hister, omnom, Logseq, webrecorder —
  reinforces "imitate, do not copy", while the permissive set (dogsheep,
  Datasette, DuckDB, `karlicoss`) can be vendored or linked. The field's inventory is
  [personal-datalakehouse-prior-art](personal-datalakehouse-prior-art.md).

## Consequences

- The contracts must exist as a spec — data model plus query shapes — before the
  build; that spec is the asset, and the implementations are replaceable.
- Imitating a shape means owning either bug-compatibility or a documented
  deviation. Nothing may depend on the original's internals.
- Hister's Bleve index is an implementation detail; the search behavior and the
  ranking contract are the part worth imitating.
- d172 is the first instance: it vendors only `cannon.canonify` and serves the
  protocol from a different backend.

## Alternatives rejected

- **Run Promnesia and hister as components.** Two engines, two dependencies, and
  an AGPL edge behind a network.
- **Fork hister and tier it in place.** [d175](d175-hister-tiering.md) already
  answers this.
- **Depend on hister's AGPL code across a network boundary.** The AGPL's network
  clause is the reason the boundary does not help.
- **Imitate without writing the contract down.** Reimplementation from memory
  drifts; the spec is what keeps the two faces stable.
