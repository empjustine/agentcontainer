<!-- source: https://developers.google.com/style/text-formatting -->
<!-- clipped: 2026-11-05 -->

# Text-formatting summary

## Page Summary

- This page provides a summary of basic text formatting rules, including guidance on bold, italics, code font, capitalization, and quotation marks.
- For detailed information and specific examples, refer to the linked resources within each section for deeper understanding.
- Avoid using underlines, overriding font styles, and using ampersands as conjunctions, ensuring content adheres to established guidelines.
- When working with code, filenames, class names, and similar elements should be formatted using code font for clarity.
- Follow American English conventions for capitalization and punctuation, with exceptions noted for UI elements and specific contexts.

The page summarizes, and provides a quick reference for, many of the general text-formatting
conventions covered elsewhere in the style guide. For more information, see
[Visual formatting](/style/semantic-tagging#visual-formatting).

Bold
: Use bold formatting, `<b>` or `**`, only for
[UI elements](/style/ui-elements#formatting) and
[run-in headings](/style/lists#types-of-lists), including at the beginning of
[notices](/style/notices).
: Although a double underscore, `__`, can also indicate bold styling in Markdown, it
can be difficult to distinguish in a text editor. It's best to use the double asterisk for bold in
Markdown.

Italic
: In general, use italics sparingly.
: When you're discussing or introducing terms, such as when defining terms or using
_words as words_, use italics formatting, `<i>` or `_`. For more
information, see
[Use italics to discuss terms](/style/italics-terms)
and
[Format abbreviation introductions](/style/abbreviations#format-abbreviations).
: When you need to add emphasis to indicate importance, use italics, not bold or underline. But
usually, your words can carry the emphasis without adding italics. To indicate
[semantic emphasis](/style/semantic-tagging) in HTML, use the `em` element,
which renders as italics in most contexts. To indicate emphasis in Markdown, use underscores
(`_`), which render as italics; you can't do semantic tagging in Markdown.
: Although an asterisk, `*`, can also indicate italics in Markdown, we recommend
underscores to make it easier for humans to distinguish italics from bold in the Markdown file.
: Italicize titles of books, movies, web series, and other full-length works, unless they're part
of a link. For more information, see
[Cross-references and linking](/style/cross-references).
: Italicize mathematical variables—for example, _x_ + _y_ = 3.
Don't italicize mathematical operators such as the plus sign. For more information about
formatting mathematical notation, see
[Mathematical notation](/style/mathematical-notation#format-mathematical-notation).
: Italicize version variables—for example, version 1.4._x_.

Underline
: Reserve underlining for link text. For more information, see
[Style link text](https://developers.google.com/style/cross-references#style-link-text).

Code font
: Use `<code>` in HTML or `` ` `` in Markdown to apply a monospace font
and other styling to [code in text](/style/code-in-text), inline code, and user
input.
: Use code blocks, `<pre>` or ` ``` `, for
[code samples](/style/code-samples) or other blocks of code.
: Do not override or modify font styles inline.
: Use code font to mark up code, such as filenames, class names, method names, HTTP status codes,
console output, and placeholders. For more information, see
[Some specific items to put
in code font](/style/code-in-text#some-specific-items-to-put-in-code-font).

Capitalization
: Use American English style for
[general capitalization](/style/capitalization).
: Use sentence case in all [headings,
titles, and navigation](/style/capitalization#capitalization-in-titles-and-headings).
: Use all-capitals for [placeholders](/style/placeholders#placeholder-text).

Quotation marks
: In general, use American English style when [punctuating
quotations](/style/quotation-marks).
: For titles of shorter works—such as articles or episodes in a web series—put titles in quotation
marks, unless they're part of a link.

Font type, size, and color
: Do not override global styles for [font type, size, or
color](/style/fonts).
: Use [semantic HTML](/style/semantic-tagging) or Markdown to
control the style of text on a page—for example, code tags in HTML (`<code>`)
or backticks in Markdown (`` ` ``)—instead of manually styling text with a monospace
font.

Other punctuation conventions
: Don't use [ampersands (&)](/style/word-list#ampersand) as conjunctions or
shorthand for _and_. Use _and_ instead. That includes headings and navigation.
**Exception**: It's okay to use _&_ in cases where you need to refer to a UI
element or the name of a menu that uses _&_.
: Put quotation marks and end punctuation outside of link text. For more information, see
the [Punctuation around link text](/style/cross-references#punctuation)
and [Quotation marks and italics](/style/cross-references#quotation-marks-italics)
sections of the "Cross-references and linking" page.

## More resources

- [Mathematical notation](/style/mathematical-notation)
