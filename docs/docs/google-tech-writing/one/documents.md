<!-- source: https://developers.google.com/tech-writing/one/documents -->
<!-- clipped: 2026-11-05 -->

# Documents

## Page Summary

- Define the scope of your document clearly, including what it covers and, importantly, what it does not cover to manage reader expectations.
- Identify your target audience and their existing knowledge to tailor the content appropriately, considering their needs and goals for reading the document.
- Summarize the key points at the beginning of the document to provide readers with a quick overview and entice them to read further.
- Relate new concepts to familiar ones by comparing and contrasting them with existing technologies or ideas that your audience already understands.
- Organize your document logically based on your audience's needs, ensuring it flows smoothly and addresses their key questions in a clear and concise manner.

**Estimated Time:** 10 minutes

You can write sentences. You can write paragraphs. Can you organize
all those paragraphs into a coherent document?

## State your document's scope

A good document begins by defining its scope. For example:

> This document describes the design of Project Frambus.

A better document additionally defines its non-scope—the topics not
covered that the target audience might reasonably expect your document
to cover. For example:

> This document does not describe the design for the related technology,
> Project Froobus.

Scope and non-scope statements benefit not only the reader but also the
writer (you). While writing, if the contents of your document veer away from the
scope statement (or venture _into_ the non-scope statement), then you must
either refocus your document or modify your scope statement. When reviewing
your first draft, delete any sections that don't help satisfy the scope
statement.

### Exercise

What problem do you see in the following paragraph?

> This document explains how to use the Frambus API to create, update, and
> publish Fwidgets. This document does not explain how to use the Frambus
> API to delete Fwidgets or cover the history of the Linux operating system.

#### Click the icon to see the answer.

The non-scope should only include information that users would reasonably
expect the document to cover. No reasonable user would expect the document to
cover the history of the Linux operating system.

## State your audience

A good document explicitly specifies its audience. For example:

> This document is aimed at the following audiences:
>
> - software engineers
> - program managers

Beyond the audience's role, a good audience declaration might also
specify any prerequisite knowledge or experience. For example:

> This document assumes that you understand matrix multiplication
> and the fundamentals of backpropagation.

In some cases, the audience declaration should also specify prerequisite
reading or coursework. For example:

> You must read "Project Froobus: A New Hope" prior to reading this document.

## Summarize key points at the start

Engineers and scientists are busy people who won't necessarily read all
76 pages of your document. Imagine that your peers might only read
the first paragraph of your document. Therefore, ensure that the start of your
document answers your readers' essential questions.

Professional writers focus considerable energy on page one to increase the
odds of readers making it to page two. However, the start of any long document
is the hardest page to write. Be prepared to revise page one many times.

### Compare and contrast

In your career, no matter how creative you are, you will author precious few
documents containing truly revolutionary ideas. Most of your work will be
evolutionary, building on existing technologies and concepts. Therefore, compare
and contrast your ideas with concepts that your audience already understands.
For example:

> This new app is similar to the Frambus app, except with much better graphics.

Or:

> The Froobus API handles the same use cases as the Frambus API, except that the
> Froobus API is much easier to use.

### Exercise

What problem do you see in the following introduction?

> Frambus Weather app v2 introduces ten features not available in Frambus
> Weather app v1. Most importantly, v2 offers two-week forecasts, v1 offered
> only one-week forecasts. Tidal information won't change.

#### Click the icon to see the answer.

The final sentence (about tides) isn't important enough to appear in the
opening paragraph. The first sentence mentioned ten new features, so readers
would likely expect to hear more about those new features. Instead, the final
sentence refers to something other than a new feature.

## Write for your audience

This course repeatedly emphasizes the importance of defining your audience.
In this section, we focus on audience definition as a means of organizing
your document.

### Define your audience's needs

Answering the following questions helps you determine what your document
should contain:

- Who is your target audience?
- What is your target audience's goal? Why are they reading this document?
- What do your readers already know _before_ they read your document?
- What should your readers know or be able to do _after_ they read your
  document?

For example, suppose you have invented a new sorting algorithm, which is
similar to quicksort. The following list contains some potential answers
to the preceding questions:

- **Who is your target audience?** The target audience consists of all the
  software engineers in my organization.
- **What is your target audience's goal?** My target audience wants to
  find more efficient ways to sort data. They are reading this document to
  determine whether this new algorithm is worth implementing.
- **What do your readers already know _before_ they read your document?**
  My target audience knows how to write code and has previously studied
  sorting algorithms, including quicksort. However, most people in my
  target audience haven't implemented or evaluated a sorting algorithm
  in several years.
- **What should your readers know or be able to do _after_ they read your
  document?** My target audience will be able to do all of the following:
  - Understand how the algorithm compares and contrasts with quicksort.
  - Identify the two kinds of datasets for which the algorithm outperforms
    the quicksort algorithm.
  - Implement the algorithm in their choice of programming language.
  - Identify the two edge cases in which the algorithm performs poorly.

### Organize the document to meet your audience's needs

After defining the audience's needs, organize the document to help readers
get the information they need. For example, based on the answers in the
previous section, the outline for the document could look as follows:

1. Overview of the algorithm
   - Compare and contrast with quicksort, including Big O comparisons
     - Link to Wikipedia article on quicksort
   - Optimal datasets for the algorithm
2. Implementing the algorithm
   - Implementation in pseudocode
   - Implementation tips, including common mistakes
3. Deeper analysis of algorithm
   - Edge cases
   - Known unknowns

**Next unit:** [Punctuation](/tech-writing/one/punctuation), an optional unit
