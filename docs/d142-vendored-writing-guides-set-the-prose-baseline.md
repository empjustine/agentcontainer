---
id: d142
type: architecture-design
status: active
title: "d142 — the vendored writing guides set the prose baseline, measured against this tree"
parent: architecture
depends-on: [d042, d072]
references: [writing-style, spec-graph-standard, d140]
tags: [docs, writing, style, audit]
---

# d142 — the vendored writing guides set the prose baseline

This record adopts the four vendored writing guides as this tree's prose
baseline, and points at the rules it takes from them — eight that bind, four
that stay advisory, each with its source line and its measurement.

**Non-scope.** It rewrites no document: the counts below are the worklist, and
each document picks up its share when a change next touches it. Frontmatter,
nesting and the numbering constraint stay with `docs/spec-graph-standard.md` and
`docs/d042`, and the mechanical legs are a later change.

**Audience.** Whoever writes or reviews a document here, and whoever wonders why
a rule about sentences exists at all.

## Problem

This tree had a contract for a document's shape and none for its prose. The
standard decides `id`, `type`, `status`, `parent`, placement, and the gate
refuses a violation of any of them (docs/d140). Nothing decided the sentences.

That asymmetry left a blind spot with a measurable size. An audit of the 212
documents present before this record — plain paragraphs only, the vendored
guides and the generated model cards excluded — found:

- 124,963 words of prose, in sentences averaging **22.0 words**;
- **459 sentences past 40 words** (8.1%), with **93 of 212 documents** whose
  ninetieth-percentile sentence passes that mark;
- **131 time-anchored words** ("now", "no longer", "previously", "currently") in
  **39 of 49 living documents** — the reference prose that decays as the tree
  moves;
- **108 uses of `should`** across 67 documents, the modal that leaves a
  statement's binding force to the reader;
- **69 Title Case headings** in 23 documents and **60 headings opening with an
  `-ing` form** in 39 — the two shapes the guides rule out;
- **5 of 212 documents** stating what they cover or who reads them;
- **17 documents** sending the reader to "see above" or "see below".

The corpus had arrived the same day the audit ran, and nothing consumed it.
`docs/docs/` vendors four style authorities — the Google developer documentation
style guide, the two Google Technical Writing courses, and the Microsoft Writing
Style Guide — and its own `README.md` types them as reference text rather than
policy. No rule cited a line of them and no check read one, which left onboarding
them a decision rather than a formality: the choice is between four manuals
nobody opens and a contract with a source line per rule.

A style guide adopted wholesale is not a policy either. The Microsoft tree alone
is 950 files, and half of it is brand voice, UI strings and formatting
minutiae that this tree decides elsewhere — `oxfmt` for formatting, the spec
graph for structure.

## Decision

**The four vendored guides set the prose baseline, and the rules this tree
adopts from them live in `docs/writing-style.md`.** Eight rules bind; four
further teachings stay advisory. The contract carries each rule with its source
line, its check, and the measurement that justified it.

Three properties make the adoption a policy rather than a reading list:

- **A rule needs a fault and a source, both named.** The admission test is a
  measurement over this tree's own prose plus a vendored line that states the
  principle. That test is why the contract has eight rules and not eighty: a
  guide rule that no document here breaks — paragraph length, which is already
  healthy — stays out, and so does a rule that only restates the standard.
- **Conflicts are ruled once, here, and the losing source is named.** The
  vendors disagree twice in ways that matter: Google requires second person
  (`docs/docs/google-style/highlights.md:28`) while Microsoft wants a
  conversational brand voice
  (`docs/docs/microsoft-style/styleguide/top-10-tips-style-voice.md:21`–`34`).
  Neither binds. A document in this tree states what the system is and does, and
  a procedure states the action, so no reader stands in as the subject of a
  sentence and personality is noise. The tree already leans that way.
- **The priority order is Google's own**, applied to this tree: repository
  decisions first, then the vendored guides, then an outside reference such as a
  dictionary or the Chicago Manual of Style
  (`docs/docs/google-style/index.md:26`–`30`).

Two rulings exist only because this tree is not a product manual:

- **The decision log is exempt from the timelessness rule.** A record is a dated
  artefact: its time-anchored words mean "at the time of the record", and d072
  keeps such a body mechanically accurate without pretending it speaks for the
  present. The audit's split is the argument — 293 hits in the log read
  correctly, 131 in living documents do not.
- **A requirement keeps its declarative voice.** `docs/requirements.md` states
  "Each host runs exactly ONE instance", which is stronger than any modal. The
  modal rule binds guidance prose; a normative requirement keeps the declarative
  constraint the BRD already uses.

## The measurement that made the case

Both figures describe the same 212 documents, before this record landed. The
first column is what a reader experiences; the second is what it cost.

| what was measured                                      | result              |
| ------------------------------------------------------ | ------------------- |
| documents / words in plain paragraphs                  | 212 / 124,963       |
| sentences / mean length                                | 5,679 / 22.0 words  |
| sentences past 40 words                                | 459 (8.1%)          |
| documents with a ninetieth-percentile sentence past 40 | 93                  |
| time-anchored words, living documents vs decision log  | 131 vs 293          |
| `should` as the operative modal                        | 108 in 67 documents |
| Title Case headings / `-ing` headings                  | 69 / 60             |
| documents stating scope or audience                    | 5                   |
| documents sending the reader to "see above/below"      | 17                  |

## Alternatives rejected

- **Bind the whole vendored corpus.** 950 Microsoft files plus 99 Google pages
  decide brand voice, UI strings, date formats and spacing around dashes. Those
  are either a formatter's business (`oxfmt`, gated by `./lint.sh`) or a
  product-manual concern this tree does not have. Binding them would make
  compliance a matter of taste and the contract unreadable.
- **Adopt Google's word list as binding.** The list decides spelling variants
  and product-name style; it stays advisory reading
  (`docs/docs/google-style/word-list.md`), and spelling falls out of the
  formatter and the vendor of each term.
- **Add the prose gate leg now.** Two rules are mechanical enough to decide —
  the time-anchored word list and the heading shapes. Both wait, and the reason
  is in the contract's _Deferred enforcement_ section: a red gate across 93
  documents under a rule nobody has swept yet trains the reader to ignore the
  gate, and the check has to learn to skip code spans and quoted material first.
- **Bring in an external prose linter.** A vale-style tool carries its own rule
  vocabulary and its own opinion about every sentence. The gap here was never
  detection; it was that nobody had decided what the prose must do. A tool
  adopted before the decision would decide it by default.
- **Make descriptive link text a rule.** Google wants a phrase instead of
  "click here" (`docs/docs/google-style/cross-references.md:75`–`90`). This
  tree's link text carries the **id**, which is the identity an agent greps and
  the graph resolves; across 168 links the rewrite would trade that precision
  for screen-reader fluency. The rule stays advisory, and it still catches the
  real fault — a bare `[here]` or `[this document]`.
- **Keep the guides as reference text only.** The status quo: four manuals on the
  shelf, and the 124,963 words above are what they produce. Reading is not
  adoption — an uncited guide changes no sentence that has already been written.

## Consequences

- The prose has a home. A writer — human or agent — opens
  `docs/writing-style.md` and finds eight rules with sources and checks, rather
  than four manuals and a judgement call.
- Living documents and records now carry different rules about time, and the
  difference is the point: the reference prose must read true whenever it is
  read, and the log must stay true to its own moment.
- The tree does not become compliant by decree. The contract says so, and it
  holds the baseline each rule is measured against: the migration happens one
  document at a time, as changes touch them.
- The vendor corpus earns its place in the tree. `docs/docs/` stops being
  uncited reference and becomes the source a binding contract cites per rule.

## Deferred

- **The sweep.** No document is rewritten by this record. The counts above are
  the worklist, and each document picks up its share when a change next touches
  it.
- **The mechanical legs.** A `prose` leg in `./lint.sh` for the two decidable
  rules, once the sweep for each has landed and the check skips code spans and
  quoted material. Its finding codes belong in the standard's table (d140),
  pinned by fixtures in `docs/tests/spec-check.test.mjs`.

## Verification record

- The audit is a script over the tracked tree — plain paragraphs only (headings,
  tables, fenced code and list blocks skipped), `llm-local-inference/model-cards/`
  excluded as generated data, `docs/docs/` excluded as third-party text. Re-runs
  against the pre-change tree reproduce every number above.
- Every `Source:` cite in `docs/writing-style.md` was read at its line in the
  vendored file before it was written down; the two named conflicts (second
  person, brand voice) are quoted on both sides so a later reader can re-check
  the ruling without the manuals open.
- `./node-run.sh docs/spec-check.mjs` and `./lint.sh` gate the new nodes with
  the rest of the tree; neither had a prose rule to change.
