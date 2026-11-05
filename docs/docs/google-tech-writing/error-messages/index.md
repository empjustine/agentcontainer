<!-- source: https://developers.google.com/tech-writing/error-messages -->
<!-- clipped: 2026-11-05 -->

# Writing Helpful Error Messages

## Page Summary

- This self-study course focuses on writing clear and effective error messages, primarily for developers, with examples geared towards developer-facing scenarios.
- Good error messages are crucial for a positive user experience, providing actionable information and reducing support burdens by enabling user self-help.
- This course teaches you to write and review error messages that clearly explain the problem and guide users towards a solution, but does not delve into the technical implementation of displaying them.
- The ultimate goal of a good error message is to concisely answer two questions: "What went wrong?" and "How does the user fix it?".

This self-study course helps you write clearer, more effective error messages,
whether they appear in IDEs, command lines, or GUIs. While this course contains
lessons for many error message scenarios, the majority of examples and guidance
focus on developer-facing error messages.

**Note:** Not all guidelines presented in this course are appropriate in every
situation for every target audience. Always aim error messages at the product's
target audience.

## Target audience for this course

We've aimed this course at the following audiences:

- Engineers
- Program managers
- Technical writers

We recommend taking [Technical Writing
One](https://developers.google.com/tech-writing/overview) before taking this
error messages course. After all, good error messages are just another form
of good technical writing. If you'd prefer to skip Technical Writing One for
now, that's okay—you can still benefit from this error messages course.

## Why take this course?

Bad error messages frustrate users. Good error messages provide critical
information when things are not working as expected. Error messages are
often the main way developers interact with users when problems occur.
Some error messages are caused by invalid user inputs or misuse of certain
features and some are caused by product defects; all error messages require
users to figure out what to do next.

Data collected through Google support systems and UX research identified the
following common problems with _bad_ error messages:

- unactionable
- vague
- imprecise
- confusing
- inaccurate
- unclear cause
- unknown next steps

Conversely, _good_ error messages provide the following benefits:

- Deliver the best user experience.
- Are actionable.
- Are universally accessible. (To learn more, take [Tech Writing for
  Accessibility.](/tech-writing/accessibility))
- Enable users to help themselves.
- Reduce the support workload.
- Enable faster resolution of issues.

## Learning objectives

After completing this class, you will know how to do the following:

- Write clearer, more helpful error messages.
- Review your teammates' error messages.

### Learning non-objectives

This course does not explain the mechanics of generating error messages.
For example, this course does not explain how to display error messages within
a GUI.

## This course in ten seconds

Great error messages answer two questions as clearly and concisely as possible:

- What went wrong?
- How does the user fix that problem?

Yes, it's just that simple.

And, it's just that hard.

**Next unit:** [General error handling rules](/tech-writing/error-messages/error-handling)
