<!-- source: https://developers.google.com/tech-writing/one/audience -->
<!-- clipped: 2026-11-05 -->

# Audience

## Page Summary

* Good documentation provides the necessary knowledge and skills for the audience to perform a task, taking into account their existing knowledge and skills.
* Defining the audience involves identifying their roles and proximity to the subject matter, considering factors like technical expertise, project familiarity, and time since last exposure to relevant concepts.
* Documentation should be tailored to the audience's needs by carefully selecting vocabulary, explaining potentially unfamiliar abbreviations and implementation details, and avoiding the curse of knowledge.
* When writing for an international audience, strive for cultural neutrality by avoiding idioms and culturally specific references, opting for simple and clear language to aid understanding and translation.

**Estimated Time:** 10 minutes

The course designers believe that you are probably comfortable with mathematics.
Therefore, this unit begins with an equation:

> good documentation = knowledge and skills your audience needs to do a task −
> your audience's current knowledge and skills

In other words, make sure your document provides the information that your
audience needs but doesn't already have. Therefore, this unit explains how to do
the following:

* Define your audience.
* Determine what your audience needs to learn.
* Fit documentation to your audience.

As the following video suggests, targeting the *wrong* audience can be messy:

## Define your audience

Serious documentation efforts spend considerable time and energy on
defining their audience. These efforts might involve surveys,
user experience studies, focus groups, and documentation testing.
You probably don't have that much time, so this unit takes a simpler
approach.

Begin by identifying your audience's **role**(s). Sample roles include:

* Software engineers
* Technical, non-engineer roles (such as technical program managers)
* Scientists
* Professionals in scientific fields (for example, physicians)
* Undergraduate engineering students
* Graduate engineering students
* Non-technical positions

We happily appreciate that many people in non-technical roles have great
technical and mathematical skills. However, roles remain an essential
first-order approximation in defining your audience. People within the same role
*generally* share certain base skills and knowledge. For example:

* Most software engineers know popular sorting algorithms,
  [big O notation](https://en.wikipedia.org/wiki/Big_O_notation),
  and at least one programming language. Therefore, you can depend on
  software engineers knowing what O(n) means, but you can't depend on
  non-technical roles knowing O(n).
* A research report targeted at physicians should look very different
  from a newspaper article about the same research aimed at a lay audience.
* A professor's explanation of a new machine learning approach to graduate
  students should differ from the explanation to first-year undergraduate
  students.

Writing would be so much easier if everyone in the same role shared exactly
the same knowledge. Unfortunately, knowledge within the same role quickly
diverges. Amal is an expert in Python, Sharon's expertise is C++,
and Micah's is in Java. Kara loves Linux, but David only knows iOS.

Roles, by themselves, are insufficient for defining an audience.
That is, you must also consider your audience's *proximity* to the knowledge.
The software engineers in Project Frombus know something about related
Project Dingus but nothing about unrelated Project Carambola.
The average heart specialist knows more about ear problems than the
average software engineer but far less than an audiologist.

Time also affects proximity. Almost all software engineers,
for example, studied calculus. However, most software engineers don't use
calculus in their jobs, so their knowledge of calculus gradually fades.
Conversely, experienced engineers typically know vastly more about their current
project than new engineers on the same project.

### Sample audience analysis

The following is a sample audience analysis for fictitious Project Zylmon:

> The target audience for Project Zylmon falls into the following roles:
>
> * Software engineers
> * Technical product managers
>
> The target audience has the following proximity to the knowledge:
>
> * My target audience already knows the Zyljeune APIs, which are somewhat
>   similar to the Zylmon APIs.
> * My target audience knows C++, but has not typically built C++
>   programs in the new Winged Victory development environment.
> * My target audience took linear algebra in university, but many
>   members of the team need a refresher on matrix multiplication.

## Determine what your audience needs to learn

Write down a list of everything your target audience needs to learn
to accomplish goals. In some cases, the list should hold tasks
that the target audience needs to *perform*. For example:

> After reading the documentation, the audience will know how to do
> the following tasks:

> * Use the Zylmon API to list hotels by price.
> * Use the Zylmon API to list hotels by location.
> * Use the Zylmon API to list hotels by user ratings.

Note that your audience must sometimes master tasks in a certain order.
For example, your audience might need to learn how to build and
execute programs in a new development environment *before* learning
how to write particular kinds of programs.

If you are writing a design spec, then your list should focus on
information your target audience should learn rather than on mastering
specific tasks. For example:

> After reading the design spec, the audience will learn the following:

> * Three reasons why Zylmon outperforms Zyljeune.
> * Five reasons why Zylmon consumed 5.25 engineering years to develop.

## Fit documentation to your audience

Writing to meet your audience's needs requires unselfish empathy.
You must create explanations that satisfy your audience's curiosity
rather than your own. How do you step out of yourself in order to fit
documentation to the audience? Unfortunately, we can offer no
easy answers. We can, however, offer a few parameters to focus on.

### Vocabulary and concepts

Match your vocabulary to your audience. See [Words](/tech-writing/one/words) for help.

Be mindful of proximity. The people on your team
probably understand your team's abbreviations, but do
people on other teams understand those same abbreviations?
As your target audience widens, assume that you must explain more.

Similarly, experienced people on your software team probably
understand the implementation details and data structures of your
team's project, but nearly everyone else (including new members
of your team) does not. Unless you are writing specifically for
other experienced members of your team, you typically must
explain more than you expect.

### Curse of knowledge

Experts often suffer from **the curse of knowledge**, which means that
their expert understanding of a topic ruins their explanations to newcomers.
As experts, it is easy to forget that novices don’t know what you
already know. Novices might not understand explanations that make
passing reference to subtle interactions and deep systems that the
expert doesn’t stop to explain.

From the novice's point of view, the curse of knowledge is a "File not found"
linker error due to a module not yet compiled.

### Exercise

1. Assume that the following paragraph is the start of a paper aimed at
   physicians who have never programmed before. Identify the aspects
   of the paragraph that suffer from the curse of knowledge:

   > C is a mid-level language, higher than assembly language but lower than
   > Python and Java. The C language provides programmers fine-grained control
   > over all aspects of a program. For example, using the C Standard Library,
   > it is easy to allocate and free blocks of memory. In C, manipulating
   > pointers directly is mundane.
2. Suppose the preceding paragraph was aimed at undergraduate computer
   science students new to C but comfortable with Python.
   Does the paragraph still suffer from the curse of knowledge?

#### Click the icon to see the answer.

1. This paragraph suffers immensely from the curse of knowledge.
   The target audience has never programmed before, so the following
   terms are inappropriate or unfamiliar:
   * Language
   * Mid-level language
   * Assembly language
   * Python
   * Java
   * Program
   * C Standard Library
   * Allocate and free blocks of memory
   * Pointers
2. This paragraph also suffers from the curse of knowledge for
   the alternative audience. The average Python programmer is
   unaware of manipulating memory or pointers. A better introductory
   paragraph would compare and contrast C with Python.

---

### Simple words

English has become the dominant language for technical communication worldwide.
However, a significant percentage of technical readers are more comfortable
in languages other than English. Therefore, prefer simple words over complex
words; avoid obsolete or overly-complex English words.
[Sesquipedalian](https://www.google.com/search?q=sesquipedalian)
and rare words repel some readers.

### Cultural neutrality and idioms

Keep your writing culturally neutral. Do not require readers to understand the
intricacies of NASCAR, cricket, or sumo in order to understand how a piece of
software works. For example, the following sentence—packed with baseball
metaphors as American as apple pie—might puzzle some Parisian readers:

> If Frambus 5.0 was a solid single, Frambus 6.0 is a stand-up double.

**Idioms** are phrases whose overall meaning differs from the literal
meaning of the individual words in that phrase. For example, the
following phrases are idioms:

* a piece of cake
* Bob's your uncle

Cake? Bob? Most readers from the United States recognize the first idiom; most
British readers recognize the second idiom.
If you are writing strictly for a British audience, then
*Bob's your uncle* can be fine. However, if you are writing for
an international audience, then replace that idiom with *this task is done*.

Idioms are so deeply ingrained in our speech that the special nonliteral
meaning of idioms becomes invisible to us. That is, idioms are another
form of the curse of knowledge.

Note that some people in your audience use translation software to read
your documentation. Translation software tends to struggle more with
cultural references and idioms than with plain, simple English.

### Exercise

Identify the problems with the following sentences:

1. As of Version 3.0, it was still kosher to call the Frambus method.
2. Deciding which BlogResource constraints are combinable is a
   sticky wicket.
3. Be that as it may, you still have to write unit tests.

#### Click the icon to see the answer.

1. In some places in the world, **kosher** has become slang for "acceptable
   usage." Many readers, however, will wonder how religious dietary laws
   pertain to software.
2. A **sticky wicket** is British slang, which does not travel well.
   Substituting the phrase **challenging problem** will fix this issue.
3. **Be that as it may** is an idiom. Substituting the transition
   **However** will fix this problem.

---

**Next unit:** [Documents](/tech-writing/one/documents)
