---
id: writing-style
type: architecture-design
status: active
title: "Writing style: the prose contract for documents and decision records"
parent: architecture
depends-on: [d042, d142, d143]
references: [spec-graph-standard, d140, d072]
tags: ["docs", "writing", "style", "contract"]
---

# Writing style: the prose contract

Every node in this tree already carries a contract for its **shape** —
frontmatter, type, parent edge, placement — and `docs/spec-graph-standard.md`
states it. This document is the contract for its **prose**: one idea per
sentence, the words that fix how binding a statement is, the opening block,
headings, procedures, and the read a document gets before it lands.

**Scope.** It binds every Markdown file a change writes or touches: `docs/`, the
decision log, the module docs (`README.md` / `DESIGN.md`), and the per-unit
`AGENTS.md` / runbook files.

**Non-scope.** Four neighbours own what this file leaves out, and each one wins
where they meet:

- frontmatter, nesting and the `type` vocabulary — `docs/spec-graph-standard.md`
- the log's history rules and its numbering constraint — `docs/d072`, `docs/d042`
- the CI enforcement of both — `docs/d140`
- code comments, under `AGENTS.md`'s WHY-not-HOW rule

The vendored guides in `docs/docs/` are third-party copy. No rule here rewrites
them, and the formatter is the only thing that edits their prose.

**Audience.** Anyone writing or revising a document in this tree, and any agent
asked to do it. No prerequisite reading: each rule stands alone, and the
`Source:` line under it is where to look up the reasoning.

## Status

In force for every document a change writes or touches. There was no sweep —
the tree migrates one document at a time, and the counts under [Why this
contract exists](#why-this-contract-exists) are the baseline the migration is
measured against.

## Why this contract exists

The gate decides shape and stays silent on prose. So a rule about `parent`
edges was mechanical while a rule about clause stacking belonged to nobody, and
the tree's sentences went unread for as long as the asymmetry held. Measuring
the prose made the gap concrete.

The audit covers 212 documents of this tree's own writing, and counts plain
paragraphs only — headings, tables, lists and fenced code skipped, the vendored
guides and generated model cards excluded. The numbers describe running text:

| what was measured                                                     | result                    | rule it motivates                                                                           |
| --------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| sentences per document, mean length                                   | 22.0 words                | [one idea per sentence](#keep-one-idea-per-sentence)                                        |
| sentences longer than 40 words                                        | 459 of 5,679 (8.1%)       | the same                                                                                    |
| documents whose 90th-percentile sentence passes 40 words              | 93 of 212                 | the same                                                                                    |
| time-anchored words in living docs ("now", "no longer", "previously") | 131 hits in 39 of 49 docs | [timeless living documents](#keep-a-living-document-timeless)                               |
| the same words in the decision log                                    | 293 hits                  | legitimate there — see the ruling below                                                     |
| `should` as the operative modal                                       | 108 hits in 67 documents  | [say how binding a statement is](#say-how-binding-a-statement-is)                           |
| Title Case headings                                                   | 69 in 23 documents        | [write a heading as an instruction or a noun](#write-a-heading-as-an-instruction-or-a-noun) |
| headings opening with an `-ing` form                                  | 60 in 39 documents        | the same                                                                                    |
| documents with an opening block stating scope/audience                | 5 of 212                  | [open with what it is](#open-with-what-it-is)                                               |
| "see above" / "see below" instead of a named section                  | 17 documents              | [read the skeleton](#read-the-skeleton-then-cut)                                            |

Two rules a reader might expect are absent because the tree already holds them.
Paragraph length is fine — twelve paragraphs in the whole tree run past seven
sentences — so a paragraph rule would be ceremony. And "one home per fact" is
already `docs/d042`'s churn lesson: the README documents patterns instead of
inventory for exactly that reason.

## Where the rules come from

Four authorities are vendored under `docs/docs/`, and that folder's `README.md`
records their sources, licences and clip dates. They are the Google developer
documentation style guide, the two Google Technical Writing courses, and the
Microsoft Writing Style Guide.

They agree far more than they disagree, and this file adopts the agreement
rather than either manual. The priority order is Google's own
(`docs/docs/google-style/index.md:26`–`30`), applied to this tree:

1. this repository's decisions and contracts,
2. the vendored guides,
3. an outside reference — a dictionary, the Chicago Manual of Style.

The two vendors conflict in two places that matter, and each conflict is ruled
here once instead of per document:

- **Second person.** Google requires "you" over "we"
  (`docs/docs/google-style/highlights.md:28`) and Microsoft recommends writing
  as one speaks (`docs/docs/microsoft-style/styleguide/top-10-tips-style-voice.md:21`).
  Neither binds this tree. A document here states what the system is and does,
  and a procedure states the action; no reader stands in as the subject of a
  sentence. The tree already leans that way: second person appears 30 times
  across the living documents, and first-person plural lives in the prior-art
  studies,
  where "our backend" marks the contrast with the project being studied. The
  ruling keeps both uses and bans neither outright.
- **The conversational brand voice.** Microsoft wants contractions and a warm
  register (`top-10-tips-style-voice.md:21`–`34`), Google wants friendly without
  frivolity (`highlights.md:18`–`19`). This tree's reader arrives to settle a
  question inside one document, so plainness is the register and personality is
  noise. The voice, tone and brand half of both guides is advisory reading at
  best.

## Sentences and words

### Keep one idea per sentence

A sentence carries one idea. When a sentence carries two, split it, or promote
the second idea to a list item. A long sentence that keeps one idea can stay;
the split is for piled-up thoughts, not for length as such.

The measurable form is a proxy, not the rule: a sentence past 40 words almost
always carries two ideas. The audit's 8.1% tail is what the proxy flags.

`Source:` `docs/docs/google-tech-writing/one/short-sentences.md:37`–`38` ("Focus
each sentence on a single idea… sentences should execute a single idea"), and
`docs/docs/microsoft-style/styleguide/word-choice/use-simple-words-concise-sentences.md:12`–`16`.

### Say how binding a statement is

A statement's force is part of its meaning, so the form names the force. Three
cases, three forms:

- **Required** — a plain imperative in a procedure ("Run `./lint.sh`"), or the
  declarative constraint a requirement already uses ("Each host runs exactly ONE
  instance", `docs/requirements.md`). `must` is available for a contract clause.
- **Recommended but optional** — "Use X" in guidance, or "we recommend X" where
  the alternative is real.
- **Optional, or a possibility** — `can`, `might`.

The word `should` carries all three meanings at once, and a reader cannot tell
which one the writer meant. It is the most common hedge in the tree: 108 uses
across 67 documents.

`Source:` `docs/docs/google-style/prescriptive-documentation.md:35`–`58`. The
rule is about new prose only: a quotation inside a record keeps its original
wording (`docs/d072`).

### Keep a living document timeless

A living document describes the tree as it is. Words that anchor it to a moment
— `now`, `currently`, `no longer`, `previously`, `latest`, `soon`, `eventually`
— turn it into a narrative of changes, and the narrative decays while the
document stays.

**The ruling this tree adds:** the decision log is exempt. A record is a dated
artefact, so its time-anchored words mean "at the time of the record", which is
the truth it carries. `docs/d072` keeps such a body mechanically accurate
without pretending the record speaks for the present. The distinction is the
audit's sharpest result: 293 hits in the log are correct, and 131 in living
documents are not.

The temptation is strongest where a fact used to hold. "The helper is now
inlined in its generator" loses the previous state and keeps the present one —
which is the sentence a living document wants: "The generator inlines the
helper."

`Source:` `docs/docs/google-style/timeless-documentation.md:65`–`79` for the
word list, `:30`–`33` for the exemption Google grants to time-stamped writing —
the decision log is this tree's time-stamped writing.

## The opening block

### Open with what it is

A document opens with a block of at most five sentences (or a short list) that
answers four questions:

1. What is this document — the subject, in one sentence a reader could quote.
2. What does it not cover — the non-scope a reader could reasonably expect.
3. Who reads it, and what they need to know first.
4. For a record: what was decided.

It sits after the `H1` and before the first `##`. A record's `## Status`
qualifier keeps its place as the first section, and the block sits above it —
so a reader who stops after one screen still knows what they opened.

The measured gap: 5 of 212 documents answer any of this. The longest runs to
7,667 words, and the tree holds 124,963 words of prose in total — enough that a
reader arriving mid-document is the normal case, not the exception.

Why a block and not a field: the frontmatter holds machine-readable identity
(`id`, `type`, `parent`), and a summary there would be a second place for prose
to rot. A reader scans the first screen or nothing.

`Source:` `docs/docs/google-tech-writing/one/documents.md:19`–`27` (scope and
non-scope), `:53`–`72` (audience), `docs/docs/google-tech-writing/two/large-docs.md:175`–`183`
(what it covers, what prior knowledge, what it does not cover), and
`docs/docs/microsoft-style/styleguide/top-10-tips-style-voice.md:42`–`45` ("Lead
with what's most important").

## Headings

### Write a heading as an instruction or a noun

Two shapes, picked by the content underneath:

- **A section that asks the reader to do something** opens with the bare verb:
  `Create an instance`, `Run the sweep`.
- **A section that explains** uses a noun phrase: `Migration to Cloud`,
  `The placement rule`.

Never open a heading with an `-ing` form: a gerund blurs instruction and
description, costs characters, and translates badly. `Filtering` becomes
`Filter rows` or `The filter stage`.

Sentence case, always — capitalise the first word and proper nouns only.
Numbered headings stay banned (`docs/d042`, the numbering constraint).

`Source:` `docs/docs/google-style/headings.md:27`–`28`, `:49`,
`docs/docs/google-style/highlights.md:41`, and
`docs/docs/microsoft-style/styleguide/top-10-tips-style-voice.md:71`.

### Put the discriminating word first

The first two or three words of a heading are what a scanning reader and a
search index see. Lead with the word that separates this section from its
siblings: `Placement follows the parent edge` beats `A note about where
documents belong`.

`Source:` `docs/docs/microsoft-style/styleguide/final-publishing-review.md:30`.

## Procedures

### Write a procedure as numbered actions

A procedure is a numbered list, one action per step, each step starting with the
verb. Four consequences follow, and they are the rule:

- **Condition before instruction.** "If the host is Termux, run X" — never "Run
  X, if the host is Termux". The reader decides whether to act before reading
  the action.
- **Command, then placeholders, then what the output means**, in that order
  inside one step.
- **Optional steps carry the prefix** — `Optional: …` — never a trailing
  "(optional)".
- **One action per step.** A step holding two actions hides the failure point.

`Source:` `docs/docs/google-style/procedures.md:14`, `:79`–`96`, `:172`–`183`,
and `docs/docs/google-style/highlights.md:34`.

## Before a document lands

### Read the skeleton, then cut

Two passes, both cheap, and neither is the formatter's job:

1. **Read only the headings, then only the first sentence of each paragraph.**
   They must tell the story with no gaps and no repeats. This is where a
   document's shape is decided, and it is invisible to any check that reads
   whole paragraphs.
2. **Delete what can go.** A paragraph, a section, a restated fact, a "see above"
   that names nothing. If the document reads the same without it, it was never
   load-bearing.

A "see above" or "see below" is the marker of a document whose sections moved.
Name the section instead, or link the id.

`Source:` `docs/docs/microsoft-style/styleguide/final-publishing-review.md:28`
and `:35`.

## How to check a document

Reading decides every rule above; two of them have a greppable smell test worth
running before a doc lands. Both run from the repository root and print what to
look at:

```sh
# time-anchored words a living document must not use. The second grep drops the
# decision log (exempt) and this file, whose word lists are the match.
grep -rnE '\b(now|currently|no longer|previously|latest|soon|eventually)\b' \
  README.md AGENTS.md */README.md */DESIGN.md docs/*.md |
  grep -vE '^docs/(d[0-9]{3}-|archive/|writing-style\.md)'

# headings that open with an -ing form, or Title Case headings
grep -nE '^#{1,4} ([A-Z][a-z]+ing\b|[A-Z][a-z]+ [A-Z][a-z]+)' docs/*.md
```

Spelling and terms fall to the word lists in the vendored guides — advisory, and
`docs/docs/google-style/word-list.md` is the one this tree reads first.

## Rules held as advisory

Four things the guides teach that this tree does not bind, and the reason each
one stays advice:

- **Descriptive link text** (`docs/docs/google-style/cross-references.md:75`–`90`,
  `:127`–`141`). The guides want a phrase, not "click here". This tree's link
  text carries the **id** — `[d073](d073-ssl-vpn-three-modes.md)` — because the
  id is the stable identity an agent greps and the graph resolves. A rewrite to
  phrases would trade that precision for screen-reader fluency across 194 links.
  The rule still catches the real fault: never `[this document]` or `[here]`.
- **Paragraph length.** Already healthy, as the audit shows.
- **A per-project term list.** The repo's terms live in the docs that own them;
  a term list would be a second place to drift.
- **The guides' formatting minutiae** — spacing around dashes, serial commas,
  date formats. `oxfmt` decides what a formatter can decide, and `./lint.sh`
  gates it. Prose that argues with the formatter is prose that will be
  reformatted.

## Deferred enforcement

Nothing enforces the rules above. Two of them are mechanical enough for a gate
leg — the time-anchored word list, and the heading shapes — and both wait for a
deliberate reason. A red gate across 93 documents, under a rule nobody has
swept yet, is noise rather than a finding. The check must also ignore code
spans and quoted material before it can be honest: a vendored citation
legitimately contains the word `now`, and so does this document.

The conditions for moving one rule into `docs/spec-check.mjs` are three. The
sweep for that rule has landed, the check skips fenced code, inline code and
block quotes, and its finding code is pinned by a fixture in
`docs/tests/spec-check.test.mjs` (`docs/d140`).

## Adding to this contract

A rule arrives here the way the current eight did. A measurement over this
tree's own prose shows the fault at scale, a vendored source states the
principle, and the rule is written so a reader can apply it to one sentence
without consulting the source. A rule that only restates a guide, with no fault
to fix, belongs in the advisory list.

Superseding a rule is a new record that names this document (`docs/d142` carries
the case for the baseline, `docs/d143` the opening block).
