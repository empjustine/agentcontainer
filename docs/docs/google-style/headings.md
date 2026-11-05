<!-- source: https://developers.google.com/style/headings -->
<!-- clipped: 2026-11-05 -->

# Headings and titles

## Page Summary

- Use sentence case for all headings and titles to improve readability and navigation.
- Structure content with descriptive headings that reflect the type of content (task-based or conceptual) using bare infinitives for tasks and noun phrases for concepts.
- Organize content hierarchically with heading tags (h1, h2, h3, etc.) and ensure each page has a unique h1 heading; avoid skipping heading levels or using empty headings.
- Avoid using "-ing" verbs, numbers, and excessive punctuation in headings; if an abbreviation is used, define it in the first paragraph following the heading.
- When summarizing subheadings, use the phrase "in the following sections" to clearly connect the content.

Use sentence case for headings and titles. Use descriptive headings and titles because they help
a reader navigate their browser and the page. It's easier to jump between pages and sections of a
page if the headings and titles are unique.

## Heading and title text

Write document titles based on the primary purpose of the document. If a
document is primarily a tutorial, but it has a conceptual introduction, write a
task-based title. Write section headings based on the type of content that's in
the section.

| Guidance                                                                                                                                                                                                                                                                                                                                                                                                                 | Recommended                    | Not recommended                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------- |
| For a task-based heading, start with a [_bare infinitive_](https://wikipedia.org/wiki/Infinitive#English), also known as a _plain form_ or [_base form_](https://wikipedia.org/wiki/English_verbs#Base_form) verb. In English, the _imperative mood_ also uses the base form verb, so it looks the same as the bare infinitive. Task-based headings are frequently used in quickstarts, how-to documents, and tutorials. | Create an instance             | Creating an instance            |
| For a conceptual or non-task-based heading, use a [_noun phrase_](https://wikipedia.org/wiki/Noun_phrase) that doesn't start with an _-ing_ verb. Noun-phrase headings are frequently used in concept documentation.                                                                                                                                                                                                     | Migration to Google Cloud      | Migrating to Google Cloud       |
| If a section is not required for all users or scenarios, use the _Optional:_ prefix in the heading. This prefix signals when the section information applies only to a specific configuration or use case. For information about optional steps in a procedure, see [Optional steps](/style/procedures#optional-steps).                                                                                                  | Optional: Customize your alias | Customize your alias (optional) |

### Title phrasing

Use a unique level-1 heading (`h1`) for each page in a set of documents and only use
a level-1 heading once on a page.

Avoid repeating the exact page title in a heading on the page. For example, if you document
how to create a virtual machine and how to start a virtual machine on the same task-based
page, the page title might be _Create and start VM instances_, with section headings
_Create a VM_ and _Start a VM_.

### Mixed heading styles

It's OK to use task-based and conceptual heading styles in the same document.
If a single document includes both task-based and conceptual sections, then use
the appropriate phrasing for each section's heading.

### Use of _-ing_ verb forms

When possible, avoid using _-ing_ verb forms as the first word in any heading or
title.

Recommended:
Transfer data sets

Not recommended:
Transferring data sets

An _-ing_ verb form is a present participle or gerund. These verb forms
are inconsistently translated when they're used as the first word in a title,
and they increase character count in limited spaces.

Sometimes, there might not be a better alternative to using a gerund, such as the following
examples:

- Billing
- Pricing

It's OK to use a gerund in these cases.

It's OK to use an _-ing_ verb form later in a heading or title, such as
_Introduction to BigQuery monitoring_.

### Example headings

The following example is a task-based document that includes a conceptual
heading and a task-based heading.

Recommended:

### HTML

```
<h1>Log serving requests by using AI Platform Prediction</h1>

<p>This task-based document shows how to monitor machine learning models. The
document title starts with a bare infinitive.</p>

<h2>ML model monitoring overview</h2>

<p>This section provides a conceptual overview of ML model monitoring. Its title is
a noun phrase.</p>

<h2>Configure notebook settings<h2>

<p>This task-based section provides a series of steps to set variables in a
notebook. Its title starts with a bare infinitive.</p>
```

### Markdown

```
# Log serving requests by using AI Platform Prediction

This task-based document shows how to monitor machine learning models. The
document title starts with a bare infinitive.

## ML model monitoring overview

This section provides a conceptual overview of ML model monitoring. Its title is
a noun phrase.

## Configure notebook settings

This task-based section provides a series of steps to set variables in a
notebook. Its title starts with a bare infinitive.
```

## Heading and title format

The following sections list and define our writing standards for capitalization,
abbreviations, and technical elements in headings. In general, guidance
that applies to standard text also applies to headings—for example,
[contractions](/style/contractions) and [articles](/style/articles).

### Syntax and capitalization

- **Use sentence case** for all headings and titles. For more information, see
  [Capitalization in titles and
  headings](/style/capitalization#capitalization-in-titles-and-headings).
- **Keep punctuation simple**. Punctuation can be a sign that your heading is too complicated. Consider rewriting.
- **Limit abbreviations**. Only use an abbreviation of a word in a page title or heading if it's the more commonly known
  version of the word. If you do so, define the abbreviation in the first instance of the word in a paragraph.
  You can define the abbreviation in the page title or heading, but consider if the additional
  length adds value. For SEO, use the more prominent version of a term in headings. For more information, see
  [Abbreviations](/style/abbreviations).

### Formatting and code

- **Don't use numbers in headings** to indicate a sequence of sections.
  Instead, rely on heading hierarchy and order to indicate sequence.
- **Avoid code items in headings**. If you must mention a code item in a heading,
  add a descriptive noun to the item in code font. For more information, see
  [Grammatical treatment of code elements](/style/code-in-text#grammatical-treatment-of-code-elements).
- **Don't put links in headings**. A link can easily be confused as a style applied to the
  heading instead of a link.

### Hierarchy and structure

- **Don't use heading tags to change visual formatting**. Use CSS rather than a heading level
  that doesn't fit the hierarchy. Don't make up your own formatting for headings.
- **Apply proper heading tags**. Use heading tags to structure your content hierarchically—for example,
  `<h1>`, `<h2>`, and `<h3>` in HTML, or
  `#`, `##`, and `###` in Markdown.
- **Maintain logical order**. Don't skip levels of the heading hierarchy. For example, put an `<h3>` tag
  only under an `<h2>` tag.

  Recommended:

  ### HTML

  ```
  <h1>Transfer data sets</h1>

  <p>This document provides a high-level overview of ways to transfer your data to Google
  Cloud.</p>

  <h2>Estimate costs</h2>
  ```

  ### Markdown

  ```
  # Transfer data sets

  This document provides a high-level overview of ways to transfer your data to Google Cloud.

  ## Estimate costs
  ```

  Not recommended:

  ### HTML

  ```
  <h1>Transfer data sets</h1>

  <p>This document provides a high-level overview of ways to transfer your data to Google
  Cloud.</p>

  <h3>Estimate costs</h3>
  ```

  ### Markdown

  ```
  # Transfer data sets

  This document provides a high-level overview of ways to transfer your data to Google Cloud.

  ### Estimate costs
  ```

- **Don't use empty headings**. Make sure headings are followed by content.

  Recommended:

  ### HTML

  ```
  <h2>Migrate VMs to Compute Engine</h2>

  <p>Migration is not just a single step. The following sections describe the recommended
  steps.</p>

  <h3>Design the migration</h3>
  ```

  ### Markdown

  ```
  ## Migrate VMs to Compute Engine

  Migration is not just a single step. The following sections describe the recommended steps.

  ### Design the migration
  ```

  Not recommended:

  ### HTML

  ```
  <h2>Migrate VMs to Compute Engine</h2>

  <h3>Design the migration</h3>
  ```

  ### Markdown

  ```
  ## Migrate VMs to Compute Engine

  ### Design the migration
  ```

## Refer to a group of sections

If you introduce a group of related H3 or lower sections within a larger H2 section, use the
phrase _the following sections_. Don't refer to the group of sections using the phrases
_this section_ or _these sections_ because those phrases are ambiguous.

Recommended:

### HTML

```
<h2>Views in the data preparation editor</h2>

<p>The following sections describe the views in the data preparation editor.</p>

<h3>Data view</h3>

<p>...</p>

<h3>Graph view</h3>

<p>...</p>

<h3>Schema view</h3>

<p>...</p>
```

### Markdown

```
## Views in the data preparation editor

The following sections describe the views in the data preparation editor.

### Data view

...

### Graph view

...

### Schema view

...
```
