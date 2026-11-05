<!-- source: https://developers.google.com/style/prescriptive-documentation -->
<!-- clipped: 2026-11-05 -->

# Prescriptive documentation

## Page Summary

- Prescriptive documentation provides direct guidance by recommending specific actions and paths to achieve goals, rather than presenting multiple options.
- The structure, examples, and procedures in prescriptive documents are tailored to the most relevant use cases and reader needs.
- When writing prescriptive documentation, the words "must," "can," and "might" are used to indicate required, optional, or possible actions/outcomes respectively, whereas "should" is generally avoided due to its ambiguity.
- To make actions clear, writers should use imperatives for required steps, or employ phrases like "We recommend" for suggested actions.
- When describing a state or outcome, prescriptive documentation should use precise language that conveys whether the state is actual or required and the outcome is expected or possible.

Write prescriptive documentation.

_Prescriptive_ (or _opinionated_) documentation recommends a way to achieve tasks
and accomplish goals. It tells the reader what to do instead of giving them a list of options to
choose from. When a goal or task is complex and involves multiple approaches or products,
prescriptive documentation recommends a path.

Prescriptive writing affects several aspects of documentation:

- **The purpose and structure of a document**. Prescriptive documentation states a clear,
  specific purpose. Headings and content are written with that purpose in mind.
- **Example scenarios and procedures**. Scenarios and procedures reflect the use cases that
  are most likely relevant to the readers.
- **Sample commands**. Prescriptive documentation provides commands and arguments that
  accomplish the task for the most common use case. For more information about documenting
  command-line options, see
  [Optional arguments in click-to-copy commands](/style/code-syntax#click-to-copy-commands).

For instance, best practice documents are typically prescriptive documents. For an example, see
[Operations best practices](https://cloud.google.com/architecture/security-foundations/operation-best-practices).

## Word choice for recommendations and requirements

To indicate required or optional user actions or the outcomes of a process, select an appropriate
auxiliary verb—for example, _must_, _can_, or _might_. Generally avoid the word
_should_. The word can create ambiguity and uncertainty for readers and is thus problematic for
prescriptive documentation. For example, if you're telling the reader what to do, _should_
implies that the action is recommended but optional, which can leave the reader unsure about what to
do.

To clarify what you mean, determine if an action is _required_ versus _optional_, an
outcome is _expected_ versus _possible_, or a state is _actual_ versus
_recommended_.

- **If an action is required**: use _must_, or rephrase
  the sentence so that it's a clear imperative instruction such as
  "Do the following before you continue."
- **If an action is recommended**: use _We recommend ..._ or
  _Google recommends ..._. You can use _should_ if a
  recommended action is generally recognized. For example, "You should
  use a strong password ..." or "You should follow the principle of
  least privilege ...."
- **If an action is optional**: use _can_. For example,
  "You can also use approach B to solve the same problem."
- **If an outcome is expected**: describe the outcome in terms of
  what is expected. For example: "The process returns 10 items."
- **If an outcome is possible**: use _might_ or _can_.
  For example, "The process can take about 30 minutes."
- **If a state is actual**: when you're describing the state of
  something, such as the value of a variable, avoid writing "The value
  should be true." Instead, clarify which of the following you mean:
  - "You must set the value to true."
  - "The server sets the value to true."
  - "If the value is false, follow these steps to change it to true."

  For information about clarifying who's performing an action, see
  [Active voice](/style/voice).

Recommended: Ensure that the
Classroom Share Button conforms to our min-max size guidelines and related
color/button templates.

Recommended: The column of the data
table that the filter operates on.

Recommended: Whether it's a brand new
project or an existing one, perform the following steps.

Not recommended: The Classroom Share
Button should conform to our min-max size guidelines and related color and
button templates.

Not recommended: The column of the
data table that the filter should operate on.

Not recommended: Whether it's a brand
new project or an existing one, here's what you should do.

## More resources

- See also [can](/style/word-list#can), [could](/style/word-list#could),
  [may](/style/word-list#may), [might](/style/word-list#might),
  [must](/style/word-list#must), and [would](/style/word-list#would) in the
  word list.
