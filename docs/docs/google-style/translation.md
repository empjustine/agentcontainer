<!-- source: https://developers.google.com/style/translation -->
<!-- clipped: 2026-11-05 -->

# Write for a global audience

## Page Summary

- Write developer documentation in US English with localization, translation, and internationalization in mind, favoring clear and concise language for easier translation.
- Structure content with short, unambiguous sentences, active voice, and direct address (using "you") for better comprehension across languages.
- Maintain consistency in terminology, phrasing, formatting, and capitalization to minimize ambiguity and translation costs.
- Prioritize inclusivity by avoiding culturally specific references, using diverse example names, and omitting colloquialisms, idioms, humor, and seasonal references.
- Adhere to specific guidelines on grammar, word choice, and sentence structure to ensure clarity and accuracy for a global audience, referring to provided resources for detailed explanations and examples.

We write our developer documentation in US English, but some of it is
translated into languages other than English or is read by developers for whom
English is not their primary language.

Write with localization, translation, and
internationalization in mind. The following list defines these terms:

- _Localization:_ Adapting a product and its associated documentation for a specific country.
  This process involves more than translation—for example, using local currencies or units of
  measurement.
- _Translation:_ Translating one language to another language. This process might involve
  localization, but the two terms aren't synonymous with one another.
- _Internationalization:_ Designing a product and its associated documentation to minimize
  the localization effort—for example, placing all UI strings in a separate file to simplify
  translation.

For more information, see
[Language localization](https://wikipedia.org/wiki/Language_localisation).

For other writing best practices, see the following resources:

- [Write accessible documentation](/style/accessibility)
- [Write inclusive documentation](/style/inclusive-documentation)
- [Voice and tone](/style/tone)

## Use clear, concise, and unambiguous language

Consider global audiences and translation and write in a way that's clear, concise, and
unambiguous.

### Use simpler words and shorter sentences

- Use a simple word. For example, don't use words like _commence_ when you mean _start_
  or _begin_. Don't use _consequently_ when you mean _so_. Don't use words like
  _utilize_ or _leverage_ when you mean _use_. (It's fine to use these words when
  you're conveying a special sense—for example, _Cloud Spanner utilizes up to 100% of the available
  CPU resources._)
- Use a single word when it conveys the same idea as a phrase. For example, don't
  use a phrase like _a number of_ when you can use _some_ or _many_.
- Write shorter sentences. The shorter the sentence, the easier it is to translate. English sentences can be
  shorter in length than some languages, so an English sentence of average length might result in a
  long sentence when translated. Longer sentences can impair understanding, cause rendering issues
  on the page or product interface, lengthen translation time, and increase translation and
  review costs.

### Avoid phrasal verbs

- Avoid phrasal verbs when possible. A phrasal verb combines multiple words to form a single
  verb phrase. These verbs are also known as compound verbs. Try to substitute a simpler verb first.
  There might not be a better verb; for example, a few exceptions to this rule include _set up_,
  _log in_, and _sign in_.

  Recommended: This document uses the following
  terms:

  Not recommended: This document makes use of
  the following terms:

### Use modifiers appropriately

- Don't use too many modifiers. In particular, don't use more than two nouns as modifiers of
  another noun.

  Recommended: A cloud-native DevSecOps
  pipeline in a hybrid environment

  Not recommended: A hybrid cloud-native
  DevSecOps pipeline

- Don't misplace modifiers. For example, place a word like _only_ immediately before the
  word or phrase that it relates to. If the meaning is still ambiguous, try rephrasing the sentence.

  Recommended: Request only one token.

  Recommended: Request no more than one token.

  Not recommended: Only request one token.

- Describe technical details in precise, technical terms. Avoid subjective modifiers such as
  _simply_, _properly_, or _carefully_. Subjective words can be vague. For more
  information, see [Avoid subjective
  language](/style/inclusive-documentation#subjective-language).

### Use active voice and present tense

- Use [present tense](/style/tense) and avoid complex or uncommon verb forms.
- Use active voice. The subject of the sentence is the person or thing performing the action.
  With passive voice, it's often hard for readers to figure out who's supposed to do something.
  For more information, see [Active voice](/style/voice).
- Avoid participles and gerunds (that is, _verbing_) when possible. _Verbing_ can be
  less direct and ambiguous. Consider replacing _using_ with _by using_,
  _that use_ (or _that uses_), or _you use_ as appropriate. For more information, see
  the word list entry [using](/style/word-list#using).

  | Recommended                                                                  | Not recommended                                                                  |
  | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
  | You must configure the VPC firewall rules before you deploy the VM instance. | Configuring the VPC firewall rules is required before deploying the VM instance. |
  | This guide describes how to set up database replication.                     | This guide describes setting up database replication.                            |

### Use words in their primary sense

- Don't use the same word to mean different things. In particular, avoid using the same word as
  both a noun and a verb in close proximity. For examples of words that have multiple meanings, see the word
  list entries for [once](/style/word-list#once), [while](/style/word-list#while), [as](/style/word-list#as), and [since](/style/word-list#since).
- Avoid directional language (for example, _above_ or _below_) in procedural
  documentation. For more information, see
  [UI elements and interaction](/style/ui-elements#buttons).

### Use helper words and optional words

- Use qualifying nouns for technical keywords. For example, when referring to a file called
  `example.yaml`, call it the _`example.yaml` file_ and not
  _`example.yaml`_ by itself. For more information, see
  [Grammatical treatment of code elements](/style/code-in-text#keywords).
- Repeat a word if the redundancy improves comprehension.

  | Recommended                                                                                                                    | Not recommended                                                                                                    |
  | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
  | If the VM has started and if you're able to connect...                                                                         | If the VM has started and you're able to connect...                                                                |
  | The resource hierarchy design creates both IAM segmentation and network segmentation by default.                               | The resource hierarchy design creates both IAM and network segmentation by default.                                |
  | An egress rule whose action is `allow`, whose destination is `0.0.0.0/0`, and whose priority is the lowest possible (`65535`). | An egress rule whose action is `allow`, destination is `0.0.0.0/0`, and priority is the lowest possible (`65535`). |
  - Use helper words. Helper words such as _then_, _that_, and _of_
    are frequently left out of conversational English. Use these words to avoid ambiguity.

    | Recommended                                                                                     | Not recommended                                                                            |
    | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
    | If the attribute key is not found, then the default value is returned.                          | If the attribute key is not found, the default value is returned.                          |
    | This document is intended for data engineers and assumes that you have the following knowledge: | This document is intended for data engineers and assumes you have the following knowledge: |
    | Identify all of the datasets.                                                                   | Identify all the datasets.                                                                 |
    | Start the profiler, and then run the app.                                                       | Start the profiler, then run the app.                                                      |

    See also [Optional pronouns](/style/pronouns#optional-pronouns).

  - Don't omit relative pronouns. To provide clarity and to avoid ambiguity, use relative
    pronouns such as _that_ and _which_. For more information, see
    [Relative pronouns](/style/pronouns#relative-pronouns).

    Recommended: You can programmatically update
    the rules that you previously defined.

    Not recommended: You can programmatically
    update the rules you previously defined.

### Clarify abbreviations and pronouns

- Define abbreviations. Abbreviations can be confusing out of context, and they don't translate
  well. Spell things out whenever possible, at least the first time that you use
  a given term. For more information, see [Abbreviations](/style/abbreviations).
- Clarify antecedents. Using pronouns can get tricky when translators are working with small,
  unconnected strings of text. Help them out by making things as clear as
  possible. For example, if a pronoun is ambiguous, then replace it with the
  appropriate noun.

  Recommended: If you use the term
  _green beer_ in an ad, then make sure that the ad is targeted.

  Not recommended: If you use the term
  _green beer_ in an ad, then make sure that it's targeted.

### Use apostrophes appropriately

Be careful with how you use plural and possessive forms. In general, don't form a plural with
_'s_, don't use the plural or possessive form with trademarks of company, product, and feature
names, and don't use uncommon contractions. For more information, see [Possessives](/style/possessives), [Pluralization](/style/pluralization), and [Contractions](/style/contractions).

## Address users and their needs directly

Address the user and their needs directly and avoid providing unnecessary information.

- Address the reader directly. Use _you_, instead of _the user_ or _they_, unless
  you're referring to someone who uses the software that the reader is developing. For more
  information, see [Second person and first person](/style/person).
- Provide context. Don't assume that the reader already knows what you're talking about.
- Avoid negative constructions when possible. Consider whether it's necessary to tell the reader
  what they can't do instead of what they can.

## Be consistent

Use standard sentence structures, consistent terminology, and appropriate punctuation to avoid
creating barriers to understanding, ambiguity, and mistranslations.

### Use consistent terminology

If you use a particular term for a concept in one place, then use that exact same term
elsewhere, including the same capitalization. If you use different names for the same thing,
translators might think you're referring to different concepts, and thus might use different
translations. Inconsistency in terminology and phrasing can increase translation costs,
particularly when translation memory and machine translations are used as first steps in
translation.

### Use standard sentence structures and formatting

- Use standardized phrases for frequently used sentences, introductory phrases, and other common
  tasks. For examples, read about [introducing links](/style/cross-references#link-introductions),
  [introducing output](/style/placeholders#placeholders-in-output), and
  [introducing code samples](/style/code-samples#introductions).
- Use standard English word order. Sentences follow the _subject + verb + object_ order.
- Try to keep the main subject and verb as close to the beginning of the sentence as possible.
- Use the conditional clause first. If you want to tell the audience to do something in a
  particular circumstance, mention the circumstance before you provide the instruction. For more
  information, see [Sentence structure](/style/sentence-structure).
- Make list items consistent. Make list items parallel in structure. Be consistent in your
  capitalization and punctuation. For more information, see [Lists](/style/lists).

### Use consistent text formatting

- Use consistent typographic formats. Use bold and italics consistently. Don't switch from
  using italics for emphasis to underlining. For more information, see
  [Text-formatting summary](/style/text-formatting).
- Use consistent capitalization. For more information, see
  [Capitalization](/style/capitalization).

## Be inclusive

You're not writing for your culture. Write with inclusivity in mind. For more information, see [Writing inclusive documentation](/style/inclusive-documentation).

- Write [dates and times](/style/dates-times) in unambiguous and clear ways.
- Don't be too
  culturally specific. In particular, don't refer to specific holidays, cultural practices, or sports
  unless you're certain they're known worldwide.
- Use a diverse set of example names. If you
  need to use people's names (for example, as email addresses), use a diverse set of names. For more
  information, see [Example domains and names](/style/examples).
- Avoid
  colloquialisms, idioms, or slang. Phrases like _ballpark figure_, _back burner_, or
  _hang in there_ can be confusing and difficult to translate.
- Avoid humor. Most humor
  is difficult to translate, and much humor is culturally specific.
- Avoid geographically
  specific references, like the seasons. Remember that August isn't summer in the southern hemisphere.
  For more information, see [Expressing divisions of the
  year](/style/dates-times#divisions-year).

## Consider accessibility for images

Use screenshots and text in figures sparingly. Images don't get translated. Any new information
should be conveyed through text and not introduced in a figure or image. For more information, see
[Figures and other images](/style/images).
