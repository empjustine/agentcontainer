<!-- source: https://developers.google.com/style/jargon -->
<!-- clipped: 2026-11-05 -->

# Jargon

## Page Summary

- Jargon, while common in specific groups, can hinder clear communication, especially for global or diverse audiences.
- When possible, avoid or replace jargon with plain language for better clarity and inclusivity.
- If jargon is necessary (e.g., for SEO), define it clearly on first use or link to a trusted definition.
- Prioritize clear communication over using specialized terminology that may not be widely understood.

Jargon is the specialized and often figurative terminology of a specific group to represent a
larger concept—for example, _camel case_, _swim lane_,
_break-glass procedure_, or _out-of-the-box_. Jargon can also include
vaguely defined or overloaded terms like _solution_, _support_, or
_workload_.

Typically, the meaning of jargon isn't understood except by the specific group. For this reason,
jargon can hamper our efforts to publish content that's clear, that reaches a
[global audience](/style/translation)
in multiple languages, that serves readers at various levels of product knowledge, and that's
inclusive of different groups and cultures. For more information about writing with
inclusivity and diversity in mind, see
[Write inclusive documentation](/style/inclusive-documentation).

However, some jargon is widely understood and accepted by our industry or by the intended
audience of a document. It can be valuable to include jargon in a document when you know that
readers search for those terms. If you're going to use jargon, consider the following questions:

- **Can you write around the term?** If you don't need the term for search engine
  optimization (SEO), try writing around it. For example, instead of writing _Hold a
  post-mortem_, write _When the project is finished, review what processes worked or didn't
  work_. Instead of writing _Create a back-of-the-envelope design_, write _Use an informal
  design process_.
- **Can you replace the term with a different, more specific term?** For example, the
  [word list](/style/word-list)
  for this style guide offers several replacement terms: _affected area_ or _spatial
  impact_ (for _blast radius_), _import_ or _load_ (for _ingest_), and
  _ready-made_ or _pre-built_ (for _off-the-shelf_). When a term on the word list is
  marked as "Don't use" (some jargon can be considered offensive, violent, or not inclusive),
  replace that term or write around it.
- **Are you using the term only once in your document?** If so, describe the term in plain
  language and refer to it in parentheses, or link to a trusted definition.

  Recommended: You then move the task to an
  earlier part of the process (also known as _shifting left_).

  Recommended: A
  [split-brain](<https://en.wikipedia.org/wiki/Split-brain_(computing)>)
  situation can develop.

- **Are you using the term throughout your document?** If so, briefly describe the term in
  parentheses on first reference, or link to a trusted definition.

  Recommended: The application is in the
  same state as a _cold standby_ (a backup or redundant system that's identical to a primary
  system).

  Recommended: A better approach is to use
  a pattern called a
  [_dead letter queue_](https://en.wikipedia.org/wiki/Dead_letter_queue).

- **Is the term used in a command or code sample?** If so, use the words only in direct reference to the code items
  ([formatted as code](/style/code-in-text)), and make it clear
  what you're referring to.

  Recommended: Add a user to the
  allowlist (`whitelist`) by entering the following:
  `whitelist adduser EMAIL_ADDRESS`.

  Not recommended: Add a user to the
  whitelist by entering the following: `whitelist adduser
  EMAIL_ADDRESS`.
