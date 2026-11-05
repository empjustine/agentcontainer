---
id: d143
type: architecture-design
status: active
title: "d143 — every document opens with what it is, what it is not, and who reads it"
parent: architecture
depends-on: [d042, d142]
references: [writing-style, spec-graph-standard]
tags: [docs, writing, structure, audience]
---

# d143 — every document opens with what it is, what it is not, and who reads it

This record makes an opening block part of every document: a statement, before
the first section, of what the document is, what it leaves out, and who reads it
— plus, for a record, what was decided.

**Non-scope.** It retypes and reorganizes nothing, and it leaves the frontmatter
alone. A document's type and its edges belong to `docs/spec-graph-standard.md`;
the block is prose, and the rules that shape the rest of the prose live in
`docs/writing-style.md`.

**Audience.** Anyone writing a document, and the reader who opens one by id and
needs to know within a screen whether it answers the question they arrived
with.

## Problem

A reader arrives inside a document with no idea whether it is the right one.
This tree makes that arrival the normal case: it holds 124,963 words of prose,
its longest document runs to 7,667 words, and a reader — human or agent —
reaches a document by `id` or by a search hit, not by walking a reading path
from the front.

Five of 212 documents stated what they cover or who reads them. The other 207
opened at the first `##` and left the reader to infer scope from the title. Two
consequences followed, and both are visible in the prose:

- **No non-scope.** Nothing said what a document deliberately leaves out, so
  every reader had to read a long document to learn that their question belonged
  elsewhere. The vendored guides call this the reason a scope statement exists at
  all: the non-scope is what keeps a reader from hunting in the wrong file
  (`docs/docs/google-tech-writing/one/documents.md:19`–`27`).
- **No answer up front.** A record opens with its `## Problem` and argues toward
  a decision at the end, which serves the reader who wants the reasoning and
  strands the one who wants the verdict. Google's courses put the summary first
  for exactly that reader — "Imagine that your peers might only read the first
  paragraph of your document"
  (`docs/docs/google-tech-writing/one/documents.md:73`–`80`).

The tree already knows the discipline elsewhere: a doc's `## Status` section
carries a one-line qualifier for anyone who stops early (`docs/spec-graph-standard.md`),
and `docs/d042` settled that one document serves one purpose. What was missing is
the same service at the top of the page.

## Decision

**A document opens with a block of at most five sentences — or a short list —
that answers four questions:**

1. What is this document: the subject, in one sentence a reader could quote.
2. What does it not cover: the non-scope a reader could reasonably expect.
3. Who reads it, and what they need to know first.
4. For a record: what was decided.

The block sits after the `H1` and before the first `##`. A record's `## Status`
qualifier keeps its place as the first section, with the block above it, so the
position rule and the standard's status rule do not fight.

The shape is deliberately not a genre. It does not separate tutorial from
reference from explanation — the standard's five `type` values already answer
scope (`docs/spec-graph-standard.md`), and a second axis would charge every
document a decision it has already made. The opening block is a service to the
reader, not a taxonomy.

A document that cannot answer the second question has no boundary. Either the
non-scope is unwritten or the document covers two subjects, and the block
surfaces that at the moment the document is written rather than a year later.

## The audience this assumes

Two readers, and naming them is what rules out the vendors' voice advice:

- **An agent working one question.** It greps for an `id`, opens one file, and
  reads until it has the answer. It never sees a reading order, and a document
  that opens with "as described in the previous section" is a dead end.
- **The owner, months later.** They arrive mid-tree with a symptom and need to
  know within one screen whether this document holds the answer.

Both readers want the same four facts in the same order, and neither wants
register, warmth or a narrative of how the document came to be. That is why
d142 rules the vendors' conversational voice out, and why the opening block is
declarative present tense throughout.

## Alternatives rejected

- **A `summary:` frontmatter field.** Frontmatter is the machine-readable layer
  — identity, type, edges — and a summary there is prose in the wrong layer. It
  would rot where no reader looks, and the block asks for four answers, not one.
- **A required `## TL;DR` heading.** A heading for prose that belongs to no
  section. It would also sit inside the document's outline, where it distorts
  the skeleton a scanning reader reads.
- **A single index page that states each document's scope.** This is d042's
  churn lesson in another costume: a hand-kept list of 200 summaries had to be
  edited on nearly every doc landing, and drifted from the graph besides.
- **The Diátaxis split (tutorial / how-to / reference / explanation).** A real
  taxonomy, and the wrong one here: the standard already types documents by
  scope, and this tree holds no tutorials. Adopting both would leave every
  document with two classifications that can disagree.
- **Front-load the decision by reordering every record** — `## Decision` before
  `## Problem`. It reads worse: a verdict before the problem it answers is an
  answer to a question the reader has not yet asked. The one-sentence summary in
  the opening block serves the impatient reader without inverting the argument.

## Consequences

- A reader's first screen answers "is this the right document" — for both the
  agent that opened it by id and the owner who found it by search.
- Writing a document starts with a scope decision rather than a heading. A
  document whose non-scope cannot be stated splits, and it splits early and
  cheaply.
- Records gain a quoted verdict at the top, so the log stays navigable by
  argument: read the opening block of ten records and know what each decided.
- The block is prose with no field behind it, so nothing mechanical enforces it.
  It lands with the document, or not at all.

## Verification record

- The gap was counted over the 212 documents present before this record: five
  carried a section stating scope, audience or prerequisites; the remaining 207
  opened with a section heading. The counting rule is the one d142 states for its
  audit.
- The rule's cost was checked against the tree's longest documents, all eight
  above 3,000 words: five sentences at the audit's 22-word mean wrap into ten
  lines of Markdown, so the block stays inside the first screen of even the
  7,667-word record.
- `./node-run.sh docs/spec-check.mjs` gates the new node's frontmatter and edges
  with the rest of the tree.
