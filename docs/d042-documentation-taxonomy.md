---
id: d042
type: architecture-design
status: active
title: "d042 — documentation taxonomy: requirements / reference / design, plus the decision log"
parent: architecture
tags: ["docs", "taxonomy", "brd", "srd", "tdd"]
references: [d111]
---

# d042 — documentation taxonomy (BRD / systems reference / TDD)

## Status

The `type:` half of this taxonomy is **retired** (d111): every living document
now carries one of the five ThinkRail spec-graph types
(`goal-and-requirements`, `architecture-design`, `module-design`,
`submodule-design`, `task-spec`), and lifecycle is a separate `status:` field
(`draft`/`active`/`stale`/`done`/`deprecated`). The taxonomy table below is
kept as history — it records the vocabulary this tree used before d111, and
how each kind of writing maps onto the standard types. Still binding: the
**anchor constraint**, the **numbering constraint**, and the habit of one
document per purpose.

## Motivation

The docs tree accumulated three kinds of writing inside the same flat
directory, and several single documents mix all three. Working from the same
source, an operator cannot tell which document is _the_ statement of what the
system must do, which documents describe the system as it exists, and which
are implementation notes frozen at the moment they were written:

- requirement-like prose (the goal statement, per-module responsibility
  sections, normative invariants) lived scattered across
  `goal-and-requirements.md`, the folder `SPEC.md` files, and
  `architecture.md`;
- systems-reference material (topology, environment matrix, persistence
  table, runbooks, tooling maps) shared files with both of the above;
- one-time research/audit findings and self-archived operational docs sat
  beside live ones with only prose banners to tell them apart.

## The taxonomy (retired by d111)

Every document carried exactly one of these `type:` values (frontmatter), and
the README documentation index was grouped by them:

| type           | role                                                                                           | contents                                                                                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requirements` | the BRD — what the system should do, normative                                                 | `docs/requirements.md` (renamed from root `goal-and-requirements.md`, absorbs the per-module requirement statements)                                                                                                                                                      |
| `reference`    | the systems reference — structure, components, matrices, runbooks, as the system IS            | `docs/architecture.md` (the map), `container-tooling.md`, `environments-and-variants.md`, `coding-harness-persistence.md`, `hf-cache-upkeep.md`, `refresh-llm-local-inference-manifest.md`, `gguf-vram-fit-estimates.md`, `gguf-model-tooling.md`, per-folder `README.md` |
| `design`       | TDD — implementation rationale and mechanics not graspable from source at a glance             | per-module `DESIGN.md` (renamed from `SPEC.md`), `llm-reverse-proxy/DESIGN.md` (split out of its README), `scoped-models-and-proxy-overrides.md` (the distilled rationale for scoped models + baseUrl overrides), `pi-summarized-thinking/summarized-thinking.md`         |
| `research`     | one-time findings/audits — the record of an investigation, not a statement of current behavior | `docs/archive/*` + the anchored strays below                                                                                                                                                                                                                              |
| `decision`     | the decision log (history — kept mechanically accurate, not immutable; d072)                   | `docs/d0XX-*.md` (the d0XX prefix IS the marker; their records now carry the standard `architecture-design` / `module-design` types plus a `bugfix` tag where the genre matters)                                                                                          |

The rows above are the pre-d111 reading of the tree. Under the standard
vocabulary: `requirements` → `goal-and-requirements`; `reference`, `design`
and `research` → `architecture-design` or `module-design` depending on scope
(system-wide vs. one runner folder), with `research` docs additionally
`status: done`; `decision` → per-record `architecture-design`/`module-design`,
with a `bugfix` tag where the genre matters. `docs/spec-graph-standard.md`
states the vocabulary that binds now.

## The anchor constraint

`docs/d0XX-*.md` bodies are history: never rewritten wholesale to change a
verdict, but mechanically kept accurate when they describe the current tree
(FR-D2, d072 — the old always-append rule only ever preserved rot such as
d041's stale `AGENT_DIR` mentions). Eight non-d0XX docs are referenced **by path**
from d0XX bodies, so they are physically anchored at `docs/` root:

`architecture.md`, `container-tooling.md`, `termux-serving.md`,
`termux-build-audit.md`, `sandbox-helper-env-analysis.md`,
`scoped-models-and-proxy-overrides.md`, `refresh-llm-local-inference-manifest.md`,
`coding-harness-persistence.md`.

Consequence: **no `docs/reference/` or `docs/design/` subdirectory.** Moving
half the reference docs would split the type across two locations — worse
than type-scoping them by frontmatter + the README index. Type separation is
metadata-first; physical moves happen only where no anchor blocks them.

## Placement follows the parent edge (d117)

The anchor constraint above prices a move, it does not forbid one: it names the
records that must be edited, and since d072 those edits are permitted (history
is kept mechanically accurate, not frozen). d117 spends that price and replaces
the anchoring habit with a placement rule — **a living doc's file sits beside
the node its `parent` edge names**. A doc that guides exactly one unit moves
into that unit's folder, and its citing records are retargeted in the same
change; a doc that spans units stays at `docs/` root with `parent: architecture`.

So the list above is now a list of _candidates_, judged one at a time:
`scoped-models-and-proxy-overrides.md`, `coding-harness-persistence.md` and
`refresh-llm-local-inference-manifest.md` described a single unit and moved
(under `coding-agent/` and `llm-local-inference/`); `architecture.md`,
`container-tooling.md` and `environments-and-variants.md` stayed because they
genuinely span folders; `termux-serving.md`, `termux-build-audit.md` and
`sandbox-helper-env-analysis.md` stayed as host-level audits and archived maps.
`docs/` keeps a second thing the rule never moves: the `dNNN` decision log, one
chronological set whose readers arrive by number, not by folder.

## The numbering constraint

Decision records do not number their sections and do not cite sections by
number. New records use named headings (`## Problem`, `## Decision`,
`## Consequences`, `## Alternatives rejected`, `## Acceptance`) and
reference content by name ("see the Verification status"), never a section
number — and never one pointing into another record.

The reason is churn: a section number is a pointer maintained by hand.
Renaming or reordering a section silently breaks every number cite to it,
and a cross-record number cite turns one record's renumbering into edits
across every record pointing at it (the log already carries dozens of
cross-record `§` citations — the cautionary sample, not a pattern to
extend). Named headings survive reordering — at most one prose reference
needs updating — and read without the reader counting sections.

Scope, consistent with the anchor constraint above: existing records keep
their historical numbering; d0XX bodies are never rewritten wholesale
(d072), so the numbered records stay as history. The constraint binds
records written or extended after it — new sections in an old record get
named headings too, and no new `§` reference is added anywhere. Root
`AGENTS.md` states the operative rule for agents.

## Moves, renames, splits

| action            | from                                                                                                                                                                                                                  | to                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rename (BRD)      | `goal-and-requirements.md` (root)                                                                                                                                                                                     | `docs/requirements.md`, `type: requirements`, absorbs per-module requirements from the SPECs + normative invariants; keeps `id: goal` so existing `parent: goal` pointers stay valid                      |
| rename            | `llm-local-inference/SPEC.md`                                                                                                                                                                                         | `llm-local-inference/DESIGN.md` (`type: design`; responsibility statement condensed, requirements live in the BRD)                                                                                        |
| rename            | `local-llm/SPEC.md`                                                                                                                                                                                                   | `local-llm/DESIGN.md` (same treatment)                                                                                                                                                                    |
| split             | `llm-reverse-proxy/README.md`                                                                                                                                                                                         | reference entry stays in README; design rationale (three-source union, full-real-base-URL convention, 404 anti-oracle, RFC 9457 type design, known deviations) moves to new `llm-reverse-proxy/DESIGN.md` |
| archive           | `peer-variant-work.md`, `mini-swe-agent.md`, `model-architecture-findings.md`, `bwrap-runtime-audit.md`, `comparison-with-huggingface-estimate.md`, `endpoint-runtime-rewiring.md`, `llama-swap-response-analysis.md` | `docs/archive/` (research findings + self-archived ops docs; none anchored by d0XX)                                                                                                                       |
| archive           | `future-config-generator-system.md`                                                                                                                                                                                   | `docs/archive/` — superseded: d030/d037 implemented the generator split-by-concern and d041 the unified entrypoints; `architecture.md`'s trailing pointer updated                                         |
| retype            | all living docs listed in the taxonomy table                                                                                                                                                                          | frontmatter normalized (`type:` value + `status:`); untyped living docs get frontmatter for the first time                                                                                                |
| anchored in place | `termux-serving.md` (archived banner, d041), `termux-build-audit.md`, `sandbox-helper-env-analysis.md`                                                                                                                | stay at `docs/` root, typed `research` — d0XX records reference their paths                                                                                                                               |

## Resolved deferral

The original plan deferred **`coding-agent/SPEC.md`** because a concurrent
work stream was merging the `coding-agent/` generators. That merge has
landed: the four former per-concern pi stages were consolidated into ONE
`generate-pi-coding-agent.mjs` (the "broad by-agent merge", recorded in its
header — it supersedes d037's process split; d037's per-layer merge verdicts
stand), plus `generate-opencode.mjs` (former `generate-opencode.jsonc.mjs`).
With the folder quiet again, the deferred work was executed: `SPEC.md` →
`DESIGN.md` (renamed, typed `design`, responsibility condensed to a charter

- BRD pointer) with its Shape section rewritten to the two-generator
  reality, and the README layout/index rows for the deleted stage files
  replaced. d042's taxonomy now covers every module.

## Consequences

- One document per purpose: the BRD answers "what must it do", reference
  answers "what is it and how do I operate it", design answers "why is it
  built this way", archive answers "what did we learn and discard", d0XX
  answers "what did we decide and when".
- The README documentation index states the type map; frontmatter is the
  machine signal, and it is the one that must stay right.
  **Amended: the index no longer enumerates documents.** It describes the five
  `type` patterns and a short reading path, and a doc's specifics live in its
  own frontmatter and body. The amendment is the churn lesson: a row per doc
  (130+ of them, ~75 % of README) had to be re-edited on nearly every doc
  landing, still drifted from the graph, and each edit was a chance for the
  prose to rot. Enumerating a searchable metadata set in a hand-kept list is
  work with no reader, and agents can search the data far better than they can
  maintain the index.
- Anchored-by-pointer: a path referenced from a d0XX body moves only if the
  records naming it are updated too — mechanical upkeep, permitted since
  d072 (before that, moving a doc meant leaving dangling pointers in
  history). New docs should still pick their type-scoped home immediately.

## Verification record

- Frontmatter census over the whole tree: every non-d0XX doc carries exactly
  one taxonomy `type:` (requirements ×1, reference ×10, design ×5, research
  ×11); the d0XX log keeps its own shape (the `d0XX` prefix is its type
  marker; per-record flavor fields are historical) — and since d072 its
  bodies are maintained rather than frozen (FR-D2). At census time
  `coding-agent/SPEC.md` was still `module-design` — the deferred rename
  executed later, see "Resolved deferral" above.
- Stale-link sweep for every moved stem across README, AGENTS.md, all living
  docs, archive index, `lib/`, root scripts: zero hits outside d0XX bodies,
  `.thinkrail/` session state (historical), and d042's own citations.
- Living-doc link fixes applied: `coding-agent/coding-harness-persistence.md` →
  `archive/bwrap-runtime-audit.md`; `docs/architecture.md` trailing pointer →
  archive with supersession note.
- Supersession banner added to `archive/future-config-generator-system.md`
  (d030/d037/d041 implemented its substance); `archive/README.md` records the
  pre-archive link caveat and the anchored strays.
- `lint.sh` gate: exits 1 on the SAME pre-existing findings before and after
  (SC2153 ×2 in `llm-reverse-proxy/run.sh`, SC2034/SC2086 in
  `llm-reverse-proxy/smoke-test.sh` — left untouched per standing decision);
  no new findings from the docs change or the coding-agent merge. (An earlier
  "clean, exit 0" line here was a pipe-exit artifact — the gate's real status
  was never 0 on this host.)
- README documentation index rebuilt as the type map (requirements /
  reference / design / decision log / research+archive) and folder-layout
  `docs/` block updated; every former index row accounted for in its new
  section.
- post-merge coherence pass (after the coding-agent by-agent merge landed):
  deleted stage files (`generate-local-llama-swap`, `generate-cloud-providers`,
  `generate-default-model`, `generate-opencode.jsonc`, `merge-models-json`)
  are referenced by NO living doc; the deferred `coding-agent/SPEC.md` →
  `DESIGN.md` split executed (Shape rewritten to the two-generator structure,
  d037-supersession noted); README layout rows + the doc-index row for
  `merge-models-json.mjs` replaced; `llm-local-inference/refresh-llm-local-inference-manifest.md`
  pointer updated to `generate-pi-coding-agent.mjs`.
