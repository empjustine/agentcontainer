<!-- source: https://developers.google.com/tech-writing/one/lists-and-tables -->
<!-- clipped: 2026-11-05 -->

# Lists and tables

## Page Summary

- Technical writing benefits from using lists to organize information, specifically bulleted, numbered, and embedded lists, with a preference for the first two.
- Lists should maintain parallelism, ensuring items match in grammar, logical category, capitalization, and punctuation for readability.
- Numbered lists often start with imperative verbs to create clear instructions or steps.
- Tables should have clear headers, concise cell content, and introduce the data being presented with an introductory sentence.
- Both lists and tables need introductory sentences providing context and often using the word "following" to signal their presence.

**Estimated Time:** 15 minutes

Good lists can transform technical chaos into something orderly.
Technical readers generally love lists. Therefore, when writing,
seek opportunities to convert prose into lists.

## Choose the correct type of list

The following types of lists dominate technical writing:

- Bulleted lists
- Numbered lists
- Embedded lists

Use a **bulleted list** for _unordered_ items; use a
**numbered list** for _ordered_ items. In other words:

- If you rearrange the items in a _bulleted_ list, the list's meaning
  does not change.
- If you rearrange the items in a _numbered_ list, the list's meaning
  _changes_.

For example, we've made the following a bulleted list because rearranging its
items does not change the list's meaning:

> Bash provides the following string manipulation mechanisms:
>
> - Deleting a substring from the start of a string
> - Reading an entire file into one string variable

The following list, by contrast, must be a numbered list because rearranging its
items would change the list's meaning:

> Take the following steps to reconfigure the server:
>
> 1. Stop the server.
> 2. Edit the configuration file.
> 3. Restart the server.

An **embedded list** (sometimes called a **run-in** list) contains items
stuffed within a sentence. For example, the following sentence contains
an embedded list with four items.

> The llamacatcher API enables callers to create and query llamas, analyze
> alpacas, delete vicunas, and track dromedaries.

Generally speaking, embedded lists are a poor way to present technical
information. Try to transform embedded lists into either bulleted lists or
numbered lists. For example, you should convert the sentence containing
the embedded list into the following passage:

> The llamacatcher API enables callers to do the following:
>
> - Create and query llamas.
> - Analyze alpacas.
> - Delete vicunas.
> - Track dromedaries.

### Exercise

Convert the following paragraph into one or more lists:

> Today at work, I have to code three unit tests, write a design document, and
> review Janet's latest document. After work, I have to wash my car without
> using any water and then dry it without using any towels.

Don't forget to introduce your list(s).

#### Click the icon to see the answer.

Here's one possible answer:

> I must do the following at work today:
>
> - Code three unit tests.
> - Write a design document.
> - Review Janet's latest document.
>
> After work, I must do the following:
>
> 1. Wash my car without using any water.
> 2. Dry my car without using any towels.

The following is an alternative answer:

> I must do the following tasks today:
>
> - At work:
>   - Code three unit tests.
>   - Write a design document.
>   - Review Janet's latest document.
> - After work:
>   1. Wash my car without using any water.
>   2. Dry my car without using any towels.

---

## Keep list items parallel

What separates effective lists from defective lists? Effective lists
are parallel; defective lists tend to be nonparallel. All items in a
**parallel** list look like they "belong" together. That is, all
items in a parallel list match along the following parameters:

- Grammar
- Logical category
- Capitalization
- Punctuation

Conversely, at least one item in a **nonparallel** list fails at least
one of the preceding consistency checks.

For example, the following list is parallel
because all the items are plural nouns (grammar),
edible (logical category), in title case (capitalization),
and without periods or commas (punctuation).

- Carrots
- Potatoes
- Cabbages

By contrast, the following list is painfully nonparallel along
all parameters:

- Carrots
- Potatoes
- The summer light obscures all memories of winter.

The following list is parallel because all the items are complete
sentences with complete sentence capitalization and punctuation:

- Carrots contain lots of Vitamin A.
- Potatoes taste delicious.
- Cabbages provide oodles of Vitamin K.

The first item in a list establishes a pattern that readers expect
to see repeated in subsequent items.

### Exercise

Is the following list parallel or nonparallel?

- Broccoli inspires feelings of love or hate.
- Potatoes taste delicious.
- Cabbages.

#### Click the icon to see the answer.

The list is nonparallel. The first two items are complete sentences, but the
third item is not a sentence. (Don't be fooled by the capitalization and
punctuation of the third item.)

---

### Exercise

Is the following list parallel or nonparallel?

- The red dots represent sick trees.
- Immature trees are represented by the blue dots.
- The green dots represent healthy trees.

#### Click the icon to see the answer.

This is a nonparallel list. The first and third items are in active voice,
but the second item is in passive voice.

---

## Start numbered list items with imperative verbs

Consider starting all items in a numbered list with an imperative verb. An
**imperative verb** is a command, such as **open** or **start**. For example,
notice how all of the items in the following parallel numbered list begin with
an imperative verb:

1. Download the Frambus app from Google Play or iTunes.
2. Configure the Frambus app's settings.
3. Start the Frambus app.

The following numbered list is nonparallel because two of the sentences start
with an imperative verb, but the third item does not:

1. Instantiate the Froobus class.
2. Invoke the Froobus.Salmonella() method.
3. The process stalls.

### Exercise

Make the following list parallel. Ensure that each element in the result list
begins with an imperative verb:

1. Stop Frambus
2. The key configuration file is `/etc/frambus`. Open this file with an ASCII
   text editor.
3. In this file, you will see a parameter named Carambola, which is currently
   set to the default value (32). Change this value to 64.
4. When you are finished setting this parameter, save and close the
   configuration file
5. now, start Frambus again.

#### Click the icon to see the answer.

The following is one possible answer:

1. Stop Frambus.
2. Open the key configuration file, /etc/frambus,
   with an ASCII text editor.
3. Change the Carambola parameter from its default value (32) to 64.
4. Save and close the configuration file.
5. Restart Frambus.

---

## Punctuate items appropriately

Though different style guides offer conflicting advice about punctuating
list items, the [Google developer documentation style
guide](https://developers.google.com/style/lists#capitalization-and-end-punctuation)
recommends (with some exceptions) starting each list item with a capital
letter. For example:

- Loops
- Conditionals
- Variable declarations

If a list item is a sentence, use appropriate sentence-ending punctuation.
For example:

1. Open the program.
2. Click the settings icon.

## Create useful tables

Analytic minds tend to love tables. Given a page containing multiple
paragraphs and a single table, engineers' eyes zoom towards the table.

Consider the following guidelines when creating tables:

- Label each column with a meaningful header. Don't make readers guess what
  each column holds.
- Avoid putting too much text into a table cell. If a table cell holds more
  than two sentences, ask yourself whether that information belongs in some
  other format.
- Although different columns can hold different types of data, strive for
  parallelism _within_ individual columns. For instance, the cells within
  a particular table column should not be a mixture of numerical data and
  famous circus performers.

**Note:** Some tables don't render well across all form factors. For example,
a table that looks great on your laptop may look awful on your phone.

## Introduce each list and table

We recommend introducing each list and table with a sentence that tells readers
what the list or table represents. In other words, give the list or table
context. Terminate the introductory sentence with a colon rather than a period.

Although not a requirement, we recommend putting the word **following** into
the introductory sentence. For example, consider the following introductory
sentences:

> The following list identifies key performance parameters:
>
> Take the following steps to install the Frambus package:
>
> The following table summarizes our product's features against our key
> competitors' features:

### Exercise

Write an introductory sentence for the following table:

| Language | Inventor          | Year Introduced | Key Feature |
| -------- | ----------------- | --------------- | ----------- |
| Lisp     | John McCarthy     | 1958            | recursion   |
| C++      | Bjarne Stroustrup | 1979            | OOP         |
| Python   | Guido van Rossum  | 1994            | simplicity  |

#### Click the icon to see the answer.

Here are a couple of possible introductory sentences for the table:

> The following table contains a few key facts about some popular programming
> languages:

> The following table identifies the inventor, year of invention, and key
> feature of three popular programming languages:

---

**Next unit:** [Paragraphs](/tech-writing/one/paragraphs)
