<!-- source: https://developers.google.com/tech-writing/two/llms -->
<!-- clipped: 2026-11-05 -->

# Using large language models (LLMs) in technical writing

**Estimated Time:** 20 minutes

[**Large language models**](/machine-learning/glossary#large-language-model)
(**LLMs**) such as [Gemini](https://gemini.google.com) can help you improve
your documents. On the other hand, careless use of LLMs can inject mistakes
into your documents. This section focuses on responsible use of LLMs to
help you do the following:

- Generate a first draft.
- Revise a document.
- Format a document.
- Summarize a document.

The requests you make to an LLM are called
[**prompts**](/machine-learning/glossary#prompt). An LLM reacts to prompts
by generating [**responses**](/machine-learning/glossary#response). This module
explains how to write prompts that generate useful responses.

In general, writing good prompts requires following good technical writing
principles.

**Caution:** Responses sometimes contain errors. Always check responses carefully,
not only for factual errors but also for instances where the response
doesn't "feel" right.

## Generate a first draft

An LLM can help you write that dreaded, bang-your-head-against-the-screen
first draft. To get a good first draft, you'll need to supply good prompts.

LLMs generate the best responses for topics they "know" about. LLMs know
the following:

- The information the LLM was
  [**pre-trained**](/machine-learning/glossary#pre-training) on.
- Any additional information the LLM was subsequently
  [**fine-tuned**](/machine-learning/glossary#fine-tuning) on.
- Information traditionally available through a search engine (if the LLM
  is enhanced with
  [Retrieval-Augmented Generation (RAG)](/machine-learning/glossary#retrieval-augmented_generation)).
- Any additional information you provide in prompts or attachments.

For example, most LLMs are pre-trained on a lot of information about the
Python programming language. Therefore, most LLMs can generate a first draft
of text about any standard Python function. However, an LLM doesn't know about
the Python function that you wrote this morning unless you pass that source
code within a prompt.

The rest of this section explores specific ways to write effective prompts
for generating a first draft.

### Take on a role

LLMs tend to generate better responses when the prompt tells the LLM to
impersonate a role. For example:

Recommended

> You are an expert technical writer...

> You are a patient senior software engineer talking to a junior software
> engineer...

> You are a computer science professor writing slides for your first-year
> students...

To choose a role, imagine who could best explain or teach a certain topic
to the target audience.

### Identify your target audience

Prompts should specify the target audience.
For example, the following prompt does _not_ identify a target audience,
so the LLM's response may or may not be helpful:

Not recommended

> Describe the Carambola app.

In contrast, the following prompts are far more specific and will likely yield
better responses:

Recommended

> Describe the Carambola app to new hires on my team responsible for
> maintaining the app.

> Describe the Carambola app to a software engineer on another team...

> Describe the Carambola app to the vice-president of marketing...

### Specify the document type

What _type_ of document do you want the LLM to generate?
The following prompt, for example, doesn't answer the preceding question:

Not recommended

> Generate a document...

In contrast, the following prompts are more specific:

Recommended

> Generate an FAQ...

> Generate an email...

Consider prompting for a subset of a lengthy document rather than the entire
document. For example, if a programmer's guide needs to be hundreds of pages
long, then the following prompt might yield a poor response:

Not recommended

> Generate a complete programmer's guide on...

In contrast, prompting for specific chapters might yield better responses:

Recommended

> Generate the section of the programmer's guide that explains how to
> book a reservation.

> Generate the section of the programmer's guide that explains how to
> change a reservation.

### Define the goal of the document

People read technical documentation in order to learn something or do
something. A good prompt tells the LLM what the reader intends to with
the information. For example, the following prompts provide practical
goals:

Recommended

> After reading the FAQ, readers should be able to debug common
> problems themselves.

> After reading this tutorial, the reader should know the difference between
> regular functions and lambda functions in Python.

### Choose the style

LLM responses are typically a lot of bulleted lists connected by short
paragraphs. That's usually an appropriate style for technical writing.
However, your prompt can suggest a different style or a format. For example:

Recommended

> ... Organize the release notes in the following order:
>
> 1. An introductory paragraph
> 2. A table containing one-line summaries of each bug
> 3. Subsections for each bug, detailing the problem and any workarounds

Alternatively, if you like the style of another document, you can attach
that document to the prompt and tell the LLM to mimic its style (or selected
aspects of its style). You can even specify a style guide to mimic.
For example:

Recommended

> Write comments for the following Python function that conform to the
> Google Python Style Guide.

LLM responses tend to be too long. Consider telling the LLM to
abbreviate a response. For example:

Recommended

> ... Limit the bulleted list to the most important three items.

**Note:** LLMs sometimes make math mistakes, so the resulting bulleted list
might not contain exactly three items.

### Add prompt constraints

You can reduce [hallucinations](/machine-learning/glossary#hallucination)
in the LLM response by adding specific constraints to your prompt. For
example, you can constrain the LLM to only use information that you provide
in the prompt:

Recommended

> Only use information from the following text in your response:

You can also constrain the LLM to only use information from a specific
set of files.

### Iterate and refine

Your initial prompt generally won't produce a perfect response.
You'll probably need to prompt multiple times, making adjustments each time.
If the responses still aren't very good, consider the following questions:

- Do your prompts identify a role, a target audience, and a document type?
- Are your prompts sufficiently specific? Are you asking for exactly what
  you want?
- Is your prompt clear? Would your prompt conform to the technical writing
  lessons in [Technical Writing One](/tech-writing/one)?
  If you gave the same prompt to a human, would that person know what you
  are requesting?

Sometimes, the perfect is the enemy of the good. If a response is very good,
but not quite perfect, it is tempting to continue refining the prompt. However,
it can be more efficient to edit the very good response yourself rather than
endlessly refine the prompt.

**Note:** LLMs often produce different responses to the _same_ prompt. So, even
re-issuing the same prompt can sometimes be a form of iteration.

### Set the context

As mentioned earlier, LLMs can only use the sources available to them.
Providing additional information to establish context helps LLMs generate
better responses. The additional information could include just about any
information relevant to the topic, including:

- Documents
- Meeting transcripts
- Source code
- Emails
- Diagrams

For example, attaching the relevant source code to a prompt can help an LLM
generate a first draft of documentation:

Recommended

> Base the documentation on the attached source code.

An LLM generally assumes that information in attachments is factual, and this
can cause problems. For example, an LLM might mistakenly assume that the bugs
in attached source code are actually features.

### Consider this counterpoint

When you rely on an LLM to create a first draft, you lose the _benefits_ of the
writing process.

> "One writes to know what one is thinking" - Abraham Verghese

Writing is a struggle, but that struggle crystallizes ideas, turning vague
notions into focused plans. Until you write a design document, you haven't
fully worked through all the issues and their solutions. Clear technical
writing is the byproduct of clear technical thought.

### Exercise

A design team recorded a brainstorming session aimed at designing a new app.
We captured
[the transcript](/tech-writing/two/artifacts/design-meeting-transcript) of
that highly creative session. Prompt an LLM to create an email based on the
transcript. The email should aim to convince the vice-president of engineering
to fund development of the pet translator app. The vice-president is busy, so
keep the email short and focused.

#### Click the icon to see a possible answer.

Prompting almost never has a single right answer. That said, here is
one possible prompt:

> You are a senior engineer. Based on the transcript, write an email to convince
> the vice-president of engineering to fund development of the pet translator app.
> Make the tone serious and formal. The vice-president of engineering is busy, so
> keep the email short. Start the email with an opening paragraph summarizing the
> proposal. Then, provide a three-item bulleted list. Finish with a one-sentence
> call to action.

---

## Revise a document

LLMs excel at critical analysis. LLMs are such good critics that they can even
find mistakes in the text that _they_ generated.

### Reorganize

We recommend fixing organizational issues before editing grammar and style
issues. When prompting an LLM to reorganize documents, a clear detailed prompt
will outperform a vague prompt. For example, the following prompt forces the
LLM to guess at your intentions:

Not recommended

> Reorganize the attached course.

In contrast, the following prompt provides context and specificity to help
guide the LLM to reorganize more effectively.

Recommended

> The attached course is an introduction to logistic regression in machine
> learning. The course is aimed at second-year computer science students
> who know how to program in Python but know little to nothing about machine
> learning fundamentals. Can you recommend a better organization of the
> course modules? For example, what material should I move to a different
> module? Should the course discuss classification threshold earlier?

### Copy edit

LLMs "know" a tremendous amount about grammar, punctuation, and spelling.
So, a general prompt like the following usually detects embarrassing problems:

Recommended

> Find grammatical, punctuation, and spelling issues in the attached passage.

### Find style problems

LLMs can spot stylistic issues. For example:

Recommended

> Identify any passive voice in the following passage:

Going a step further, you can ask an LLM to suggest edits. For example:

Recommended

> Replace any passive voice sentences in the following passage with their
> active voice equivalents.

You can ask an LLM to perform a general hunt for style issues:

Recommended

> How does the attached document deviate from the writing principles in Google's
> Technical Writing One course? Assume that the document is aimed at expert
> software engineers seeking to get better at testing automation.

### Find other issues

LLMs also excel at finding logical inconsistencies or outright mistakes in
documentation. Providing a role within the prompt can help put the LLM in
the proper "mindset." For example:

Recommended

> You are a computer science professor reviewing the attached first draft of
> a paper that describes research on a new machine translation paradigm.
> Examine the Introduction section for any mistakes in the description of
> prior algorithms. Then, assess the rest of the paper for any possible
> logical flaws.

## Format a document

LLMs can convert a document from one format to another. For example, you can
ask an LLM to convert a Word document to HTML or Markdown. To do so, you'll
need to provide the following:

- The document to convert.
- The target format.
- Any specific formatting requirements.

For example:

Recommended

> Convert the attached Word document to Markdown, making all headings
> either level 2 or level 3.

You can also ask an LLM to reformat a document to conform to a specific
style guide. For example:

Recommended

> Reformat the attached HTML document to conform to the Google developer
> documentation style guide.

## Summarize a document

Condensing lengthy writing down to 50 or 100 words is so challenging that most
technical professionals struggle to write abstracts, executive summaries,
and overviews. Fortunately, LLMs generally excel at summarization.
Prompts to summarize text should typically identify the following:

- Style
- Target audience
- Purpose
- Optionally, tone

For example, here is a good summarization prompt:

Recommended

> Write a one-sentence summary of the attached course.
> Aim the summary at software engineers who will use the summary
> to determine whether to take the course. Make the summary engaging,
> yet professional; the summary shouldn't look like marketing literature.

Ironically, a good summarization prompt might be longer than the
generated summary.

In some cases, summaries must match a specific style. Therefore, your
prompt should identify or attach the relevant style guide.

In other cases, although the style isn't codified in a style guide,
your summary should still resemble certain summaries. You can pass those
exemplar summaries as part of the prompt. (This technique is called
[few-shot prompting](https://developers.google.com/machine-learning/glossary/#few-shot-prompting).)
For example:

Recommended

> Write a tldr-style summary for the attached design doc that matches
> the style of the following tldr summaries:
> This fun four-hour course gives software engineers a solid grounding
> in Python.
> This hands-on two-hour course guides software engineers through building
> better prompts for generating Python code.

### Alternate media for summaries

If the medium you are working in _requires_ a textual summary, then you'll
need to provide text. Sometimes though, technical people default to producing
textual summaries when a non-text summary (for example, an image or a video)
might be more memorable or engaging.

Or, viewing the problem in a different way, you could ask an LLM to write
a textual summary of an image.

### Exercise

We've captured [the
transcript](/tech-writing/two/artifacts/design-meeting-transcript) of
an overly creative brainstorming session to design a new app.

**Task 1:** Prompt your favorite LLM to generate a one-sentence summary of the
pet translation app discussed in the brainstorming meeting. (Copy-and-paste the
transcript along with the prompt.) This summary should get other engineers
interested in working on the project.

#### Click the icon to see a possible answer.

As always, many different prompts will produce a good response.
Here is one possible prompt:

> You are a respected senior engineer. Generate a one-sentence summary of
> the attached app discussed in the attached transcript. Aim the summary
> at junior engineers. The summary should get those junior engineers interested
> in working on the project.

---

**Task 2:** Prompt your favorite LLM to create an image representing the app.
The image should help non-technical people understand the app.

#### Click the icon to see a possible answer.

Here is one possibility:

> Create an image that helps non-technical people understand the app.

---

## What's next?

Congratulations: you've completed the pre-class work for Technical Writing Two.

If your organization is offering the in-class portion of Technical Writing Two,
do take it. If you'd like to facilitate the in-class portion
of Technical Writing Two, see the
[facilitator's guide](/tech-writing/for-instructors/two/instructors-guide).

A quick compilation of the topics covered in Technical Writing Two
is available on the [Summary](/tech-writing/two/summary) page.
