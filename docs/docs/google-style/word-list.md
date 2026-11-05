<!-- source: https://developers.google.com/style/word-list -->
<!-- clipped: 2026-11-05 -->

# Word list

## Page Summary

- This style guide promotes clear, concise, and inclusive language in technical documentation.
- It provides specific word choices and formatting guidelines for Google Cloud and other technical content.
- The guide discourages jargon, ambiguous language, and potentially offensive terms, prioritizing user understanding.
- It offers preferred alternatives for various technical and general terms to ensure accuracy and consistency.
- The guidelines aim to enhance clarity, accessibility, and inclusivity for a global audience.

**Note**: This document includes references to potentially disrespectful
or offensive terms. These terms are listed here to provide usage
guidance and alternative terms.

This word list covers style and usage guidelines that are specific to developer documentation.

If the term that you're looking for isn't on this list, check our other
[editorial resources](/style#editorial-resources), including our preferred
dictionary,
[Merriam-Webster](https://www.merriam-webster.com/). If there are multiple spellings in
the Merriam-Webster word entry, use the first form listed, which is the most common spelling. For
example, in the
[entry for _cancel_](https://www.merriam-webster.com/dictionary/canceled),
the first form listed for the past tense is _canceled_, indicating that it's more common than
_cancelled_.

If you're looking for a technical definition, then it's often a good idea to check the
authoritative documentation on the topic.

Terminology decisions, including how and when to define or contextualize
terms, often require judgments based on factors like your product area,
your audience, and prevailing convention. Here are some other pages of this
guide that can help you make those types of judgments:

- [Jargon](/style/jargon)
- [Inclusive language](/style/inclusive-documentation)
- [Write for a global audience](/style/translation)
- [Hyphens](/style/hyphens)
- [Capitalization](/style/capitalization)

As always, it's fine to deviate from our guidance if that serves your readers
better. For more information, see [Break the rules](/style#rules).

## Word list

All word list entries have a link
icon next to them. To link directly to an entry, you can right-click and
copy the link address, or click and copy the URL from your address bar.

Some word list entries include guidance to _avoid_ or _don't use_ a
term. Apply this guidance as follows:

- **Use with caution**. A recommendation to avoid using the term _when
  possible_, or to use the term with caution. The term might be ambiguous
  or obscure, so we provide alternative term suggestions or suggest that you
  use a more specific term. However, you can use the term if needed. Where
  appropriate, define the term or use it only once, as explained on the
  [Jargon](/style/jargon) page.
- **Don't use**. In all cases, we prefer to _not use the term_. The
  term might be particularly ambiguous or it might have an offensive or
  non-inclusive association. If such a term appears in code, we recommend that
  you
  [replace or write around the term](/style/inclusive-documentation#replace-or-write-around-non-inclusive-terms).
- **Android**. Applies only to Android documentation.
- **Google Cloud**. Applies only to Google Cloud documentation.
- **Google Workspace**. Applies only to Google Workspace documentation.

### Numbers and Symbols

-

: OK to use _+_ with numbers in text, such as _customer records with
300+ demographic attributes_, except in formal contexts.

& (ampersand)
: Don't use _&_ instead of _and_ in headings, text, navigation, or
tables of contents.
: It's OK to use _&_ when referencing UI elements that use _&_, or
in table headings and diagram labels where space constraints require
abbreviation.
: It's OK to use `&` for technical purposes in code.

2-Step Verification
: When referring to Google's
[2-Step Verification](https://www.google.com/landing/2step/),
use initial caps.
: When referring to
[generic 2-step verification](http://searchsecurity.techtarget.com/definition/two-step-verification),
use lowercase.

### A

a and an
: Use _a_ when the next word starts with a consonant _sound_,
regardless of what letter it starts with. For more information, see [Articles (a, an, the)](/style/articles).

A/B testing
: Capitalize and use slash notation for _A/B_.

abnormal
: Don't use to refer to a person.
: OK to use to refer to a condition of a computer system.

abort
: Avoid in general usage. Instead, use words like _stop_, _exit_,
_cancel_, or _end_. In Linux, _abort_ refers to a type of
signal that terminates an abnormal process.

about versus on
: When a cross-reference includes information that describes what the
cross-reference links to, use _about_ instead of _on_.
: Recommended: For more information
about indexes, see [Managing indexes](https://cloud.google.com/firestore/docs/query-data/indexing).
: Not recommended: For more information
on indexes, see [Managing
indexes](https://cloud.google.com/firestore/docs/query-data/indexing).

above
: Don't use for a range of version numbers. Instead, use
[_later_](#later).
: Don't use to refer to a position in a document. Instead, use
_earlier_ or _preceding_.
: Don't use to refer to a position in the UI. Instead, write instructions
that avoid directional language. For more information,
see [Writing accessible documentation](/style/accessibility).
: It's OK to use _above_ in a non-directional way, such as when describing a hierarchy.

access (verb)
: Avoid when you can. Instead, use friendlier words like _see_,
_edit_, _find_, _use_, or _view_.

access token
: Lowercase except at the beginning of a sentence,
heading, or list item.

account name
: Don't use. Instead, use [_username_](#username).

actionable
: Avoid unless it's the clearest and simplest phrasing for your audience.
Instead, leave it out or replace it with a phrase like _that you can act
on_ or _useful_.
: Don't use _actionable_ in the legal sense without consulting a
lawyer.

action bar
: In Android documentation, don't use. Instead, use
[_app bar_](#app-bar).

ad tech
: Write out on first mention: _advertising technology (ad tech)_.
: Don't use _adtech_ or _ad-tech_.

address bar
: Use to refer to the URL bar or the combined URL bar and search box in a
browser.
: Don't use _omnibox_.

ad hoc
: OK to use in database and analytics contexts to mean "free-form" or
"user-written" (for example, _ad hoc queries_ or _an ad hoc
chart_). For other contexts, try to find a more specific English
equivalent.
: Don't hyphenate or italicize the term.

admin
: Write out _administrator_ unless it's the name of a UI label or other
element.
: It's OK to use _admin_ in Android
documentation.

administrator
: In Android documentation, don't use. Instead, use _admin_.

advertised route priority
: OK to also use _base advertised route priority_ when discussing
region-to-region costs.
: Don't shorten or use variations of these terms.

agnostic
: Don't use. Instead, use a more precise term like
_platform-independent_.

AI
: In general, you can use _AI_ without spelling out _artificial intelligence_.
: Most readers are familiar with the abbreviation _AI_. If you think your audience isn't
familiar with the term, spell it out on first use.

aka
: Don't use. Instead, write out _also known as_, or present an
alternative term using parentheses or the word _or_. You can also
write out a definition.
: Recommended:
Geographic data, also known as geospatial data, is ...
: Recommended: Geographic data
(geospatial data) is ...
: Recommended: Geographic data, or
geospatial data, is ...

all apps screen
: In Android documentation: Lowercase except at the beginning of a sentence,
heading, or list item.

allowlist (verb), allowlisted, allowlisting
: Don't use as a verb. Instead, rewrite to improve clarity.
: OK to use _allowlist_ as a noun.
: For more information, see [blacklist](#blacklist).

allows you to
: Don't use. Instead, use _lets you_. For more information, see [enable](#enable).

alpha
: Lowercase except when part of a product name.
: Recommended: PRODUCT\_NAME
Alpha
: Recommended: PRODUCT\_NAME
is in alpha.

America, American
: Use only to refer to the _Americas_ or the _American continent_.
: Don't use to refer to the United States. Instead, use a more precise term
like _the US_ or _the United States_, and _people in the
US_. For more information, see [US](#us).

among
: See [between versus among](#between).

AM, PM
: To be consistent with [Material Design](https://material.io/design/communication/data-formats.html#date-and-time),
use all caps, no periods, and a space before.
: Recommended: 9:00 AM
: Recommended: 10:30 PM

and/or
: Don't use unless space is limited, such as in a table. For more
information, see [Slashes](/style/slashes#and-or).

Android
: When referring to the operating system, capitalize _Android_.

Android-powered device
: Not _Android device_.

and so on
: Avoid using _and so on_ whenever possible. For more information,
see [etc.](#etc)

anti\*
: See [guidance about hyphens with prefixes](/style/hyphens#prefixes).

anti-pattern
: Avoid using _anti-pattern_, particularly as a standalone heading.
Instead, consider using a more specific and broadly understood term.
: Recommended: Avoid these five SQL
errors.
: Recommended: Avoid these five
programming practices that make SQL queries inefficient.
: Not recommended: Avoid these five SQL
anti-patterns.

API
: Use _API_ to refer to either a web API or a language-specific API.
: Don't use _API_ when referring to a method or a class. For example,
don't write _This resource has one API_ to mean "This resource has
one method."

API Console, APIs console, developer console, dev console, or Google API Console
: Don't use. Instead, refer to the _Google APIs Explorer_ or to the
_Google Cloud console_. For more information, see
[console](#console).

API Console key
: In most contexts, use _API key_ instead of _API Console key_.
: In Apps admin APIs, it's OK to use _API Console key_ to distinguish
from other API keys.

API key
: Not _developer key_ or _dev key_.

APIs Explorer
: Not _API explorer_ or other variants.

app
: In general, use _app_ instead of _application_ when referring to
programs for end users, especially in the context of mobile or web
software.
: In some contexts, such as enterprise software, it's OK to use
_application_ to convey a sense of greater complexity.
: Use _application_ in standard phrases such as _application
programming interface_.

app bar
: In Android contexts, formerly _action bar_.

appendix
: Use the plural _appendixes_, not _appendices_.

application
: See [app](#app).

as
: If you mean _because_, then use _because_ instead of
_as_. _As_ is ambiguous; it can refer to the passage of time.
_Because_ refers to causation or the reason for something.

as of this writing
: Avoid because this phrase is implied. The phrase can also prematurely
disclose product or feature strategy or inappropriately imply that a
product or feature might change.
: See also [currently](#currently) and [presently](#presently).
: Recommended: BigQuery doesn't support
that function.
: Not recommended: As of this writing,
BigQuery doesn't support that function.
: For more information, see [Timeless
documentation](/style/timeless-documentation).

authentication and authorization
: In general, use the word _authenticated_ only to refer to users,
and use _authorized_ only to refer to requests that are sent by a
client app on behalf of an authenticated user.

    A user *authenticates* their identity by entering their password
    (or giving some other proof of identity). The *authenticated
    user* then *authorizes* the client app to send an
    *authorized request* to the server on the user's behalf.

: When you want to use a preposition with _authenticate_, use
_against_.

authN, authZ
: Don't use. Instead, use _authentication_ or _authorization_.

auto\*
: See [guidance about hyphens with prefixes](/style/hyphens#prefixes).

autohealing
: Not _auto-healing_.

auto mode VPC network
: Not _auto mode network_.

autopopulate
: Not _auto populate_ or _auto-populate_.

autoscaling
: Not _auto-scaling_.

autotagging
: Not _auto-tagging_.

autoupdate
: Don't use. Instead, use _automatically update_.

-aware
: Avoid using as a compound modifier, as in _healthcare-aware_.
: OK to use when it's part of a product name, such as _Identity-Aware
Proxy_.

### B

backend
: Not _back-end_ or _back end_.

bar
: Avoid when possible. For more information, see [foo](#foo).

bare metal
: Lowercase except at the beginning of a sentence,
heading, or list item.
: Hyphenate when used as a compound modifier, such as _bare-metal
server_.

base64
: Lowercase except at the beginning of a sentence,
heading, or list item. Otherwise, capitalize _Base64_ only if it's part of a
formal name.
: Write _base64_ in code font _only_ if it's a string literal or
otherwise quoted from code.

baz
: Avoid when possible. For more information, see [foo](#foo).

below
: Don't use for a range of version numbers. Instead, use
[_earlier_](#earlier).
: Don't use to refer to a position in a document. Instead, use _later_
or _following_.
: Don't use to refer to a position in the UI. Instead, write instructions
that avoid directional language. For more information, see
[Writing accessible documentation](/style/accessibility).
: It's OK to use _below_ in set phrases such as _below (the)
average_, _below the mean_, _below zero_.
: It's OK to use _below_ in a non-directional way, such as when describing a hierarchy.

best effort
: Avoid where possible. Instead, use more specific wording. After providing
a description, you can add a phrase like "sometimes referred to as _best
effort_."

beta
: Lowercase except when part of a product name.
: Recommended: PRODUCT\_NAME
Beta
: Recommended: PRODUCT\_NAME
is currently in beta.

between versus among
: It's fine to use _between_ when talking about more than two things;
however, _between_ isn't interchangeable with _among_.
: Use _between_ when you're talking about two or more distinct
things:
: Recommended: JavaScript introduces
dependencies between the DOM, the CSSOM, and JavaScript execution.
: Use _among_ when you're talking about things that are part of a group
or things that aren't distinct:
: Recommended: ... a conventional SQL
database that can be shared among multiple apps.
: More examples:
: Recommended: Because screen
dimensions vary widely among devices (for example, between phones and
tablets, and even among different phones), you should configure the
viewport so that your pages render correctly on many different devices.
: Not recommended: Because screen
dimensions vary widely between devices (for example, between phones and
tablets, and even between different phones), you should configure the
viewport so that your pages render correctly on many different devices.
: Recommended: You can share services
among multiple clients.
: Not recommended: You can share
services between multiple clients.
: See also [Grammar Girl's
discussion of _between_ and _among_](http://www.quickanddirtytips.com/education/grammar/between-versus-among).

big-endian
: Hyphenate. Lowercase except at the beginning of a sentence,
heading, or list item.
: Recommended: The codebase assumes
big-endian byte ordering.
: Not recommended: The codebase assumes
Big Endian byte ordering.
: Not recommended: The codebase assumes
Big-endian byte ordering.
: Not recommended: The codebase assumes big
endian byte ordering.

billing charges
: Don't use _billing charges_ to mean charges that appear on a bill.
Instead, use _billed charges_.
: Use _billing charges_ to describe the cost of creating the bill.

black-box
: Avoid using _black-box_, _blackbox_, or _black box_ to
describe monitoring and testing. Consider using a more precise term for
clarity.

    * For monitoring, use *synthetic monitoring*.
    * For testing, use *opaque-box testing*.

Black Friday
: Avoid unless explicitly referring to an event in the US. Instead use
_peak scale event_.

blackhat, black hat, black-hat
: Don't use. Instead, use precise terms for the kind of violation or
practice, such as _illegal_, _unethical_, or _in violation of
rules_.

blackhole (verb), blackholed (adjective)
: Don't use. Instead, use a more descriptive term or phrase, such as
_dropped without notification_.

blacklist, black list, black-list
: Don't use _blacklist_, _whitelist_, and _graylist_.
Instead, use more precise terms that are appropriate for your domain.
: * For the noun _blacklist_, consider using a replacement such as
_denylist_, _excludelist_, or _blocklist_. * For the noun _whitelist_, consider using a replacement such as
_allowlist_, _trustlist_, or _safelist_. * For the noun _graylist_ (_greylist_), consider using a
replacement such as _provisional list_.
: In all of these cases, consider that there might not actually be a list
involved. When replacing problematic terms, be sure to be technically
accurate for the specific context.
: For the verb forms of these words, a simple word-for-word replacement
typically isn't the best solution. Instead, replace verbs such as
_blacklisted_ with phrases that accurately convey the relevant
action. For example:
: Recommended: To deny requests from
an IP address, add it to the `dos.yaml` file.
: Not recommended: To denylist an IP
address, add it to the `dos.yaml` file.
: Don't use: To blacklist an IP
address, add it to the `dos.yaml` file.
: If the command or code that you're documenting uses one of these words,
then use the words only in direct reference to the code items
([formatted as code](/style/code-in-text)), and make it clear
what you're referring to.
: Recommended: Add a user to the
allowlist (`whitelist`) by entering the following:
`whitelist adduser EMAIL_ADDRESS`.
: Not recommended: Add a user to the
whitelist by entering the following: `whitelist adduser
    EMAIL_ADDRESS`.
: For more information, see the
[inclusive documentation](/style/inclusive-documentation) page.

blacklisted, black listed, black-listed
: Don't use. See [blacklist](#blacklist).

blacklisting, black listing, black-listing
: Don't use. See [blacklist](#blacklist).

blast radius
: Don't use. Instead, use a more precise term like _affected area_ or
_spatial impact_.

blind
: Avoid using _blind to_ or _blind eye to_. Instead, use more
precise terms like _ignore_, _unaware of_, _disregard_,
_avoid_, or _reject_.
: Avoid using _blind writes_. Instead, use a more precise phrase, such
as _a write operation without a read operation_.
: Avoid using _blind change_ or _change blindly_. Instead, use a
more precise phrase such as _change without first confirming the
value_.
: When referring to people, use terms like _person who is blind_,
_screen reader user_ (if applicable), _person who is visually
impaired_, _person who is low-vision_, _magnification user_
(if applicable).

blue-green
: Not _blue/green_ or _blue green_.

boolean
: In most contexts, _boolean_ refers to a specific data type in a
specific programming language. In such cases, use code font and the exact
spelling and capitalization of the programming keyword.
: When referring to the abstract data type, use lowercase.
: If you refer to _Boolean mathematics_ or _Boolean logic_, use
uppercase.

branding information
: In the Google Cloud console, the phrase _branding information_ refers
to the information that Google shows to users when the client asks them to
authorize access: specifically, the project's name and logo, and the
developer's Google Account. This information is set in the **Consent
screen** page.

break-glass
: Don't use. Instead, use a more precise term depending on context:

    * To describe a general emergency or procedure that grants emergency
      access, use *emergency access*.
    * To describe a fallback procedure, use *manual fallback* or
      *preplanned procedure*.

brown bag, brown-bag
: Don't use. Instead, use a more precise term like _learning session_,
_lunch and learn_, _lunchtime learning session_,
_casual training_, or _informal training_.

build cop, build sheriff
: Don't use. Instead, use a more precise term like _build monitor_.

button
: In a UI, a link isn't the same as a button; don't use the term
_button_ to refer to a link.
: Use _button_ to refer to mechanical buttons (like the volume control
buttons on the side of a phone) and capacitive touch buttons on a phone
(like the Home button). You _press_ mechanical buttons, and
_tap_ capacitive and on-screen buttons.

### C

can
: Use _can_ in the following ways:

    * To convey permission or ability (for example, "You can access the
      server").
    * To refer to an optional action (for example, "You can also view
      logs with the Log Viewer").
    * To describe a possible outcome (for example, "The process can
      take 30 minutes").

: See also [could](#could), [may](#may),
[might](#might), [must](#must),
[should](#should), and [would](#would).
: For information about clarifying who's performing an action, see
[Active voice](/style/voice).

canary
: Don't use _canary_ as a verb, and don't use _canarying_.
: When possible, avoid [jargon](/style/jargon) like _canary_ and
_canary testing_. If you use one of these phrases, define it on first
use or provide a link to the definition, and use it consistently
throughout the document.

careful, carefully
: Avoid telling a user to perform an action _carefully_, which can sound condescending or
imply that other steps don't require much attention. For more information, see [Use precise, objective language](/style/inclusive-documentation#subjective-language).
: Recommended: Enter the API key that
appears in the console.
: Not recommended: Make sure to enter the API key carefully.

cell phone, cellphone
: Don't use. Instead, use _mobile phone_, or if you're talking about
more than phones, then use _mobile device_.
: It's OK to use _phone_ (without _mobile_) when the context is
clear.: cellular data
: Don't use. Instead, use _mobile data_.

        cellular network
        :   Don't use. Instead, use *mobile network*.

        chapter
        :   When referring to documentation that isn't in the form of a book, don't
            use the term *chapter*. Instead, refer to documents, pages, or
            sections.

        check
        :   Don't use to refer to marking a checkbox. Instead, use *select*.
        :   Recommended: Select **Automatically
            check for updates**.
        :   Not recommended: Check **Automatically
            check for updates**.

        checkbox
        :   Not *check box*.

        choose
        :   *Choose* is fine to use for generic contexts. For UI elements, use
            [select](#select).

        chubby
        :   Don't use. Instead, use a word that clearly explains what you mean, such
            as *unused* or *overextended*.

        clear
        :   Use (as a verb) to refer to clearing a check mark from a checkbox.
        :   Recommended: Clear **Automatically
            check for updates**.
        :   Not recommended: Uncheck
            **Automatically check for updates**.
        :   Not recommended: Deselect
            **Automatically check for updates**.

        CLI
        :   Don't use *CLI* generically to refer to a command-line interface.
            Instead, refer to the specific command-line interface, such as the
            [Google Cloud CLI](#gcloud).

        click
        :   When the environment is a desktop with a mouse, use *click* for most
            targets, such as buttons, links, list items, and radio buttons. Don't use
            *click on*.
        :   Recommended: Click **OK**.
        :   Not recommended: Click on **OK**.
        :   Hyphenate *right-click*, *left-click*, and *double-click*.
        :   When a click or tap action reveals a collapsed list, you can write
            *click to expand* or simply *expand*.
        :   It's OK to write *click in* when referring to a region that needs
            focus (for example: *click in the window*), but not when referring to
            a control or a link.
        :   For Android apps, don't use
            *click*. Instead, use [tap](/style/word-list#tap).

        click here
        :   Don't use. For information and alternatives, see
            [Avoid vague link text](/style/cross-references#vague-link-text).

        clickthrough (noun), click through (verb)

        client
        :   In REST and RPC API documentation, *client* is short for *client
            app*—that is, the app that the developer is writing.
        :   Don't use *client* as an abbreviation for *client library*;
            instead, use *library*.

        client ID
        :   Lowercase except at the beginning of a sentence,
            heading, or list item.

        client secret
        :   Lowercase except at the beginning of a sentence,
            heading, or list item.

        Cloud
        :   Don't use as short for *Google Cloud*.
        :   For generic references such as *the cloud* or *hybrid cloud*,
            use lowercase.

        Cloud console
        :   Don't use. Instead, refer to the full name *Google Cloud console*.
        :   If you aren't discussing any other console (such as the Google Admin
            console), you can abbreviate to *the console* after first mention.
        :   Use *the* before the tool name. For more information, see
            [console](#console).

        Cloud SDK
        :   Not *Google Cloud SDK*.

        co\*
        :   See [guidance about hyphens with prefixes](/style/hyphens#prefixes).

        codebase
        :   Not *code base*.

        codelab
        :   Not *code lab* or *code-lab*. For more information, see
            [documentation](#documentation).

        cold
        :   When possible, avoid [jargon](/style/jargon) like *cold
            failover*, *cold standby*, and *cold spare*. If you use one
            of these phrases, define it on first use and use it consistently
            throughout the document.

        colocate
        :   Not *co-locate* or *colo*.

        compliant, compliance
        :   Use with caution. A claim that a product or its output is *compliant*
            with a standard is a strong statement.

        comprise
        :   Don't use. Instead, use *consist of*, *contain*, or
            *include*.

        config
        :   Avoid when possible. Instead, spell out the full word when it's used in a
            non-code sense: *configuration* or *configuring*. Use the
            verbatim code item name when referring to, for example, a data structure
            or a file with that name.

        confidential
        :   *Confidential* data is data that is protected to prevent unauthorized access. See
            [sensitive](#sensitive).

        cons
        :   Don't use. Instead, use a more precise term, such as *disadvantages*.

        console
        :   Don't use in isolation. Instead, use the name of the specific console,
            such as the [Google Cloud
            console](https://console.cloud.google.com/) or the Google Admin console.
        :   Use *the* before the name of a console.
        :   After giving the full name of a console, you can use a shortened version
            of the name, such as the *Admin console*.
        :   If you're only discussing the Google Cloud console, after giving the full
            name you can refer to *the console*.
        :   To refer to a sub-page of a console, use the term *page*.
        :   If a specific term for a browser-based interface is unavailable, use
            *web interface*.

        content type
        :   Be as specific as possible when writing about a content type, and use the term only when applicable.
            For example, you can use this term if you're referring to the value of the `Content-Type` HTTP header.
            Also see [media type](#media-type).

        Control+S, Command+S, and other keyboard commands
        :   To refer to a `Control` character, use
            `Control`+CHARACTER.
        :   Don't use *Ctl-S*, *Cmd-S*, or *Cloverleaf-S*.
        :   In most cases, use an uppercase letter for CHARACTER.
        :   In macOS, many keyboard commands use the `Command` key instead of
            the `Control` key, and there's an `Option` key instead
            of an `Alt` key. If your audience includes macOS users and
            Windows or Linux users, then mention both keyboard commands.
        :   Recommended: `Control+S`
            (`Command+S` on macOS)

        Copy and paste
        :   Avoid using. Instead, explain what to enter into a field and not how.
        :   Recommended: In the
            **Query** field, enter the output from the previous step.
        :   Not recommended: Copy the output from
            the previous step and paste into the **Query** field.

        could
        :   Avoid using. Instead, use *can* where possible.
        :   See also [can](#can), [may](#may),
            [might](#might), [must](#must),
            [should](#should) and [would](#would).
        :   For information about clarifying who's performing an action, see
            [Active voice](/style/voice).
        :   For information about tenses, see [Present
            tense](/style/tense).

        CPU
        :   All caps. No need to expand the abbreviation on first mention.

        crazy, bonkers, mad, lunatic, insane, loony
        :   Don't use. Instead, use *complicated*, *complex*,
            *baffling*, *strange*, or *unexpected*, and only for
            inanimate objects.

        Create a new ...
        :   Avoid using unless you need to distinguish the item from another recently
            created item. Instead, use *Create a ...*
        :   Recommended: Create a project.
        :   Not recommended: Create a new project.

        cripple
        :   Don't use. Instead, use more precise language. For example, instead of
            *it crippled the server*, write *it slowed the server down*.
        :   When referring to people, use terms that specifically describe a physical
            impairment, such as *person with a motor disability*; *person with
            a mobility impairment* (refers to walking or moving about); *person
            with dexterity impairment* (refers to using a standard mouse or
            keyboard); *person who uses a wheelchair, walker, or cane*;
            *wheelchair user*; *person with restricted or limited mobility*.

        cross-site request forgery
        :   Lowercase except at the beginning of a sentence,
            heading, or list item.

        curated roles
        :   Don't use. Instead, use *predefined roles*.

        currently
        :   Avoid because this word is implied. The word can also prematurely disclose
            product or feature strategy or inappropriately imply that a product or
            feature might change.
        :   See also
            [as of this writing](#as-of-this-writing) and
            [presently](#presently).
        :   Recommended: Windows isn't supported.
        :   Not recommended: Windows isn't
            currently supported.
        :   For more information, see
            [Timeless documentation](/style/timeless-documentation).

        custom mode VPC network
        :   Not *custom mode network*.

        curl
        :   Not *cURL*.
        :   For information about when to use code format, see
            [Items that are sometimes in code font](https://developers.google.com/style/code-in-text#items-that-are-sometimes-in-code-font).

        Cyber Monday
        :   Avoid unless explicitly referring to an event in the US. Instead use
            *peak scale event*.

### D

dash
: A dash (`—`) isn't the same character as a hyphen
(`-`). The characters are used for different purposes.
Therefore, don't use the word _dash_ to refer to a hyphen.

dashboard
: Don't use to refer to the Google Cloud console. For more information, see
[console](#console).
: Use _dashboard_ not _Dashboard_ unless it's officially part of a
product name.

data
: Use _data_ as singular, not plural; _the data is_, not
_the data are_.
: Use data as a mass noun, not a count noun; _less data_, not
_fewer data_.

data center
: Not _datacenter_.

data center campus
: Use when referring to an entire physical location, which can encompass one
or more data centers.

data cleaning
: Not _data cleansing_.

data flow (noun); dataflow (noun)
: If it's possible to replace with the phrase _flow of data_, then use
two words: _data flow_.
: If that replacement doesn't work, such as when referring to something like
stream processing or reactive programming, then use one word:
_dataflow_.

data source
: Not _datasource_.

datastore
: Not _data store_.

data type
: Not _datatype_.

dead-letter queue, dead letter
: Define on first use, for example _dead-letter queue (unprocessed
messages queue)_.

deep linking
: Not _deep-linking_. However, if you can replace with
_linking_, then do so.

deficient
: Don't use to refer to a person.
: OK to use to refer to a condition of a computer system.

deformed
: Don't use to refer to a person.
: OK to use to refer to a condition of a computer system or
inanimate object.

demilitarized zone (DMZ)
: Don't use. Instead, use a more precise term like _perimeter network_.

denigrate
: Don't use. Instead, use _disparage_.

denylist (verb), denylisted, denylisting
: Don't use as a verb. Instead, rewrite to improve clarity.
: OK to use _denylist_ as a noun.
: For more information, see [blacklist](#blacklist).

deprecate
: To _deprecate_ an item is to recommend against the item's use,
typically as a warning that the item will soon be unavailable or
unsupported. Don't use _deprecated_ to mean _removed_,
_deleted_, _shut down_, or _turned down_.

deselect
: Don't use to refer to clearing a check mark from a checkbox. Instead, use
_clear_.
: Recommended: Clear **Automatically
check for updates**.
: Not recommended: Deselect
**Automatically check for updates**.
: Not recommended: Uncheck
**Automatically check for updates**.

desire, desired
: Don't use. Instead, use a word like _want_ or _need_.
: Recommended: Set the value to the
size that you want.
: Not recommended: Set the value to
the size that you desire.
: Not recommended: Set the value to
the desired size.

Developers Console
: Don't use. For more information, see [console](#console).

DevOps
: Short for _development operations_. No need to spell out on first
mention unless the audience requires it. For more information, see [DevOps](https://wikipedia.org/wiki/DevOps).

dialog
: Use _dialog_ for the UI element sometimes called a [dialog box](http://wikipedia.org/wiki/Dialog_box).
: Use _dialogue_ only for verbal interaction between people.

directory, folder
: If the context that you're documenting (such as an IDE's GUI) uses one
term or the other, use that term. If not, then use _directory_ in a
command-line context, and _folder_ in a GUI context. When in doubt,
default to _directory_.

disable
: Don't use _disable_ or _disabled_ to describe something that's
broken.
: When describing a user action or the state of a UI element, use a more
precise term where possible. You can use _inactive_,
_unavailable_, _deactivate_, _turn off_, or
_deselect_, depending on the context. Use the same term consistently throughout your
document.
See also [enable](#enable).

disclosure triangle, disclosure widget
: Don't use. Instead, use _expander arrow_.

display (verb)
: Don't use as an intransitive verb. _Display_ is a transitive verb;
therefore, it requires an object. It is often misused in technical
documentation, as demonstrated by the following example:
: Recommended: The Output Directories
area appears.
: Recommended: The Output Directories
area is displayed.
: Not recommended: The Output
Directories area displays.
: The following example demonstrates correct usage of the verb
_display_ but means something quite different from the preceding
examples.
: Recommended: The Output Directories
area displays the vector image.

distributed denial-of-service (DDoS)
: Hyphenate as shown. On subsequent mention, use _DDoS_.

DNS server policy
: Lowercase _server policy_.

DNSKEY
: One word, all capital letters.

documentation or document or documents
: To refer specifically to the text on a page that explains a product, feature, or service,
use _this document_, and not _this article_, _this topic_, _this doc_, or
_this page_. It's OK to use _this tutorial_, _this quickstart_, or _this
codelab_ for those specific documentation types.

    Always spell out *documentation* except in cases where space is limited, such as in
    tabs and URLs.

    See also
    [page](#page).

: Recommended: You can find many
examples in this document.
: Not recommended: You can find many
examples in this article.
: Recommended: This document provides
guidance about creating tables.
: Not recommended: This page provides
guidance about creating tables.

documentation set
: Not _doc set_ or _docset_.

does not yet
: Avoid in timeless documentation because this phrase can become outdated.
The phrase can also prematurely disclose product or feature strategy or
inappropriately imply that a product or feature might change.
: Recommended: The Google Cloud console
doesn't support this IAM role.
: Not recommended: The Google Cloud
console does not yet support this IAM role.
: For more information, see
[Timeless documentation](/style/timeless-documentation).

dojo
: Don't use. Instead, use a precise term that is accurate for the context,
such as _training_ or _workshop_.

domain name registrar
: Lowercase except at the beginning of a sentence,
heading, or list item.

Domain Name System Security Extensions (DNSSEC)
: Write out and capitalize each word on first use. OK to abbreviate as
_DNSSEC_ after first use.

double-tap
: Hyphenate. Lowercase except at the beginning of a sentence,
heading, or list item.

downscope
: Consider using a more descriptive term like _constrain scope_ or
_reduce scope_. Because _downscope_ might not be broadly
understood, if you use the term, make sure to define it on first use.: : Don't use _down scope_ or _down-scope_
: Recommended: Reducing the scope of a
token helps you follow the principle of least privilege.
: Recommended (first use): The IAM
recommender helps you _downscope_ (reduce) the permissions that are
available to your users.

        drag
        :   Use *drag*, not *click and drag* and not *drag and drop*.
        :   OK to use *drag-and-drop* as an adjective.
        :   Recommended: Drag the USER
            to the **Authorized** box.

        drop-down
        :   In most cases, you can omit *drop-down* from phrases like *drop-down list* or
            *drop-down menu*, and just use *list* or *menu*. Include *drop-down* as a
            modifier only if the omission would cause ambiguity. Don't use *drop-down* as a
            standalone noun.

        dumb down
        :   Don't use. Instead, use a word or phrase what's happening, such as
            *simplify* or *remove technical jargon*.

        dummy variable
        :   Don't use to refer to placeholders. Instead, use *placeholder*.
        :   Also don't use if referring to the concept in statistics known as a
            [dummy variable](https://en.wikipedia.org/wiki/Dummy_variable_(statistics)).
            Instead, use alternate terms such as
            *indicator variable*, *design variable*, *one-hot
            encoding*, *Boolean indicator*, *binary variable*, or
            *qualitative variable*.

### E

each
: _Each_ refers to every individual item taken individually, not to a
group of items taken collectively. In other words, _each_ isn't a
synonym for _all_. For example, _a list of each item_ is
ambiguous; _a list of all the items_ or _a list of the items_ is
generally clearer.

earlier
: Use for a range of version numbers, not _lower_.
: Recommended: Use version 2.2 or
earlier.
: Not recommended: Use version 2.2 or
lower.
: In Android documentation, don't use
_earlier_ for a range of version numbers. Instead, use _lower_.
: When referring to a position in a document, use _earlier_ or
_preceding_, not _higher_.

easy, easily
: What might be easy for you might not be easy for others. Try eliminating this word from the
sentence because usually the same meaning can be conveyed without it. For more information, see
[Use precise, objective
language](/style/inclusive-documentation#subjective-language).

ecommerce
: Not _e-commerce_.

edge availability domain
: Don't use _edge availability zone_, _metro availability domain_,
or _metro availability zone_. Don't shorten to _EAD_.

e.g.
: Don't use. Instead, use phrases like _for example_ or _such as_.
Many people confuse _e.g._ and _i.e._

egress
: When referring to the networking term, use lowercase.

either
: When using _either_, use parallel syntax.
: Recommended: Do either option 1 or
option 2.
: Recommended: Either do option 1 or
do option 2.
: Not recommended: Either do option 1
or option 2.
: In general, use _either_ only for a choice between two things, not
for a choice among multiple things. Writing _either A or B or C_ will
distract some readers, but if it's the best phrasing for your situation,
then use it.

element
: In HTML and XML, a tag is a component of an element that indicates
the start or end of the element. (For example, the
`<i>` start tag indicates the beginning of the
`<i>example</i>` element.) In general, don't use
the term _tag_ to refer to an entire element.

email
: Not _e-mail_, _Email_, or _E-mail_.
: Don't use as a verb.
: Use a specific verb in front of the word. For example, _send email_.
This construction is better for translation and a
[global audience](/style/translation).

emoji
: Use _emoji_ for both singular and plural forms. See [Don't
know the difference between emoji and emoticons? Let me explain](https://www.theguardian.com/technology/2015/feb/06/difference-between-emoji-and-emoticons-explained) and [What's the Plural of Emoji?](http://www.theatlantic.com/technology/archive/2016/01/whats-the-plural-of-emoji-emojis/422763/)

enable
: In procedures, use the appropriate label and action for the
[UI element](/style/ui-elements) that the user interacts with. When describing a
user action or the state of a UI element, use a more precise term where possible. It's OK to
use _enable_ when not referring to a person.
: For turning on or activating an option or feature, use _enable_ or
_[turn on](#turn-on)_ consistently:

    * Use the same term in introductory text as described in the
      procedure.
    * Use the same term throughout the document unless there's a
      difference in the UI elements for different procedures.

: Recommended: To enable the API,
click the toggle.
: Recommended: Enable the API for your
project.
: For making it feasible to do something, use _lets you_.
: Recommended: The API lets you detect
features in images.
: Not recommended: The API enables you
to detect features in images.
: Not recommended: The API allows you
to detect features in images.
: In Google Workspace documentation, if possible, use
_turn on_ or _on_ instead. If referring to the state of a UI element, use
_available_.

endpoint
: Not _end point_.

enter
: Use _enter_ to refer to the user entering text. If it's important to
not press `Enter`, explicitly say so. See also
[_type_](#type).
: Recommended: In the **Owner** box,
enter your name.
: Recommended: In the **Size** box,
type a font size.

ephemeral external IP address
: Don't use _ephemeral IP address_ or _external IP address_ to
refer to ephemeral external IP addresses.

error-prone (adjective)
: Hyphenate. Lowercase except at the beginning of a sentence,
heading, or list item.

etc.
: Avoid using _etc._, _and so forth_, and _and so on_
wherever possible. If you really need to use one, use _etc._
Always include the period, even if a comma follows immediately after.
: Recommended: Your app might experience
problems such as instability or high latency.
: Recommended: Your app might experience
problems, including instability or high latency.
: Not recommended: Your app might
experience instability, high latency, and so on.
: Not recommended: Your app might
experience instability, high latency, etc.
: Not recommended: If your app
experiences instability, high latency, etc., follow these steps:

eventually
: Avoid in timeless documentation because this word can become outdated. The
word can also prematurely disclose product or feature strategy or
inappropriately imply that a product or feature might change.
: See also
[future](#future) and [soon](#soon).
: Recommended: This version of the SDK
is deprecated.
: Not recommended: This version of the
SDK is deprecated and eventually will be no longer supported.
: For more information, see
[Timeless documentation](/style/timeless-documentation).

execute
: Verb commonly used to refer to function calls, SQL queries, and other processes. When the meaning
is the same, use the simpler word _run_ instead. If you need to use a more precise term
for your context, use that term.

expander arrow
: The UI element used to expand or collapse a section of navigation or
content. If you describe this element, use the terms _expander arrow_
and _expandable section_
: Don't use terms like _expando_ or _zippy_.

exploit
: Don't use _exploit_ to mean "use."
: Only use _exploit_ in the negative sense, such as to describe
_exploiting a security vulnerability_.

external VPN gateway
: Write _external_ and _gateway_ all lowercase except at the
beginning of a sentence, heading or list item.

extract
: Use instead of _unarchive_, _uncompress_, _untar_, or _unzip_.

### F

fail over (verb), failover (noun, adjective)

fat
: Don't use. Instead, use a precise modifier that conveys the appropriate
meaning. For example, use _high-capacity network connection_ instead
of _fat connection_ or _full-featured client_ instead of _fat
client_.
: Instead of using fat in a negative sense, such as _trim the fat_,
refer in a more concrete manner to the _removal of unused items_.
: OK to use as an acronym when referring to file allocation table (FAT).

female adapter
: Don't use. Instead, use a genderless word like _socket_.

Fast Healthcare Interoperability Resources (FHIR)
: Refer to _a FHIR_ (pronounced "a fire," as in "a FHIR store"), not _an FHIR_.
For more information, see
[Indefinite articles before abbreviations](/style/abbreviations#articles).

filename
: Not _file name_

file system
: Not _filesystem_.

fill in; fill out
: Use _fill in_ when referring to entering information in individual
fields.
: Use _fill out_ when referring to completing an entire form.: : Recommended: Fill out the
questionnaire. Be sure to fill in the required fields.

        final solution
        :   Don't use. Instead, use *solution* as a standalone term or, depending
            on the context, *definitive*, *optimal*, *best*, or *last
            solution*.

        fintech
        :   Write out on first mention: *financial technology (fintech)*. Don't
            use *FinTech* or *fin-tech*.

        firewalls
        :   Don't use in Compute Engine or networking documentation. Instead, use
            *firewall rules*.
        :   Exception: If you're explaining how firewall rules work, you can explain
            that every network has an implied virtual distributed firewall.
        :   Outside of Compute Engine or networking documentation, the term
            *firewalls* is acceptable.

        first class, first-class, first-class citizen
        :   Don't use *first class* or *first-class citizen*. Instead, use
            another term that's appropriate for the context, such as *higher-order*,
            *anonymous*, or *nested*, or loosely describe the specific
            characteristics or features of the entity, resource, language, or framework.
        :   Recommended: These widgets have full access to the event system and lifecycle hooks.
        :   Not recommended: The widgets are first-class components in the UI framework.
        :   Recommended: Virtual machines are higher-order resources that can participate in resource groups and are integrated in a variety of identity, networking, and storage services.
        :   Not recommended: Virtual machines are treated as first-class resources across the identity, networking, and storage services.
        :   For more information, see
            [Write inclusive documentation](/style/inclusive-documentation).

        following
        :   It's not necessary to use a noun after *following* unless it helps
            provide clarity and enables accessibility. See [Tables](/style/tables#table-placement).
        :   Recommended: ... in the following
            code sample ...
        :   Recommended: ... in the following
            table ...
        :   Recommended: ... do the following:
            ...

        foo
        :   Avoid when possible even though it's a common term in the developer
            community. Instead, use a clearer and more meaningful placeholder name.

        for example
        :   When you introduce an example using the phrase *for example*, follow the phrase by a comma. For clarity, when
            introducing an example, separate the example using dashes, commas, or parentheses from the
            rest of the sentence as appropriate, or introduce the example in a separate sentence.
        :   Recommended: Enter a name for the instance—for example, `my-instance-99`.
        :   Recommended: Enter a six-digit hex number (for example, `228B22`), and then click **OK**.
        :   Recommended: Enter a six-digit hex number, and then click **OK**. For example, if you want the color forest
            green, enter `228B22`.
        :   For more information, see [Format examples](/style/format-examples).

        for instance
        :   Don't use the phrase *for instance* to introduce examples to avoid confusion with the
            noun *instance*. Instead, use *for example*, *like*, or *such as*. For
            more information, see [for example](#for-example).

        frontend
        :   Not *front-end* or *front end*.

        functionality
        :   Use with caution. With respect to hardware or software,
            *functionality* refers to a set of associated functions or
            capabilities and how they work. However, the word is sometimes overused,
            especially when the intended meaning is *capabilities* or
            *features*.

        future, in the future
        :   Avoid in timeless documentation because this word or phrase can become
            outdated.
        :   See also [eventually](#eventually) and [soon](#soon). For more
            information, see [Timeless
            documentation](/style/timeless-documentation).

### G

GBps
: Short for _gigabytes per second_. By convention, we don't use
_GB/s_. For more information, see [Units of measurement](/style/units-of-measure).

Gbps
: Short for _gigabits per second_. By convention, we don't use
_Gb/s_. For more information, see [Units of measurement](/style/units-of-measure).

`gcloud` CLI
: Use the full name _Google Cloud CLI_ the first time that you mention
the product on a page.

gender-neutral he, him, or his (or she or her)
: Don't use. Instead, use the singular _they_ (see [Jane Austen and other famous authors violate what everyone learned in
their English class](http://www.pemberley.com/janeinfo/austheir.html)). Don't use _he/she_ or _(s)he_ or other
such punctuational approaches. For more information, see
[Pronouns](/style/pronouns).

generative AI
: Spell out _generative_. Use sentence case.
: Don't use _gen AI_ or _Gen AI_.
: Don't hyphenate _generative AI_ as an adjective unless you must do
so for clarity. See also [AI](#ai).

ghetto
: Don't use. Instead use more precise terms like _clumsy_,
_workaround_, or _inelegant_ to refer to code that isn't in a
production-ready state.

gimp, gimpy
: Don't use. Instead, use precise, non-figurative language to refer to a
deficiency in a component.
: OK to use in reference to companies, tools, software packages, and other
entities that use the term in their names.

GKE node
: Use when first introducing GKE nodes on a given page. For subsequent
mentions, you can use _node_. A GKE node is a worker machine that
runs containerized applications and other workloads. The machine is a
Compute Engine VM that GKE creates during cluster creation. See also [virtual machine (VM) instance](#virtual-machine-instance).

Google, Googling
: Don't use as a verb or gerund. Instead, use _search with Google_.

Google Account, Google Accounts
: Capitalize _Account_.

Google API Client Library for LANGUAGE (Java, .NET, etc.)
: On second and subsequent use, you can abbreviate to
_LANGUAGE client library_.

Google API Console, Google APIs Console
: Don't use. For more information, see [console](#console).

Google Cloud
: Not _GCP_, _Cloud Platform_, or _Cloud_.

Google Cloud console
: If you're only discussing the Google Cloud console, it's OK to shorten to
_the console_ after first use on a given page.
: Use _the_ before the console name. For more information, see [console](#console).

Google Cloud project ID
: Not _Cloud project ID_ or _GCP project ID_. You can also
shorten to _project ID_, but be aware that that term is ambiguous in
some contexts.

Google Developers Console
: Don't use. For more information, see [console](#console).

Google I/O
: Not _I-O_ or _IO_.

Google Play services
: Write _services_ in lowercase.

Google Play services SDK
: Write _services_ in lowercase.

grandfather clause, grand-father clause, grand father clause
: Don't use. See [grandfathered](#grandfathered).

grandfathered
: Don't use to refer to something that is allowed to violate a rule because
it predates the rule. Instead, use an adjective like _legacy_ or
_exempt_ or a verb like _made an exception_.
: Recommended: The app is exempt because
it was released before the new requirements were announced.
: Not recommended: The app is
grandfathered in because it was released before the new requirements were
announced.

gray-box, grey-box
: Avoid using _gray-box_, _graybox_, or _gray box_ to
describe testing.
: To refer to testing that's a combination of clear and opaque testing
methods, describe exactly what it's doing.
: If you need to refer to this type of testing after you describe it,
consider using a more precise term for clarity, such as _translucent-box
testing_.

grayed-out, greyed-out, gray out, grey out
: Don't use. Instead, use _unavailable_.

grayhat, greyhat, gray hat, grey hat
: Don't use. Follow the guidance for [black hat](#blackhat) when
referring to someone violating rules or laws.

graylist, greylist, gray list, grey list, gray-list, grey-list
: Don't use. See [blacklist](#blacklist).

graylisted, greylisted, gray listed, grey listed, gray-listed, grey-listed
: Don't use. See [blacklist](#blacklist).

graylisting, greylisting, gray listing, grey listing, gray-listing, grey-listing
: Don't use. See [blacklist](#blacklist).

`gsutil`
: In the Google Cloud context, use code font for both the name of the
command-line utility and the command.

guru
: If possible, use a more precise term. For example, if you mean
_expert_ or _teacher_, use those terms.

guys, you guys
: When referring to a group of people use non-gendered language, such as
_everyone_ or _folks_.

gypsy
: Don't use. To refer to the people, use _Romani_, _Roma_, or
_Traveller_, as appropriate for the specific group you're referring
to. In place of metaphorical uses of the term, use more precise phrases.

### H

hamburger, hamburger menu
: Don't use. Instead use the `aria-label` for that particular
icon. For example, **Menu**.
For more information, see
[Buttons and icons](/style/ui-elements#buttons).

hands off, hands-off
: Use a less figurative phrase, such as _automated_. If you're
referring to a group that doesn't do anything during a process, write a
description.

hands on, hands-on
: Use a less figurative phrase, such as _customizable_, or write a
description of the activity.

hang, hung
: Don't use to refer to a computer or system that is not responding.
Instead, use _stop responding_ or _not responding_. For more
information, see [Avoid figurative
language](/style/inclusive-documentation#figurative-language).

happiness and satisfaction
: Use _happiness_ when referring to a customer's perception of a
site's reliability. Use _satisfaction_ when referring to whether the
site meets the customer's needs.
: Site reliability engineering (SRE) content generally refers to
measuring _customer happiness_ instead of _customer
satisfaction_. The two phrases are not equivalent.
: The distinction the SRE documentation makes is between satisfying a need
(a dispassionate act) and establishing an emotional response (creating
happiness). Although it is difficult to measure happiness precisely, SRE
uses [service level indicators
(SLIs)](#service-level-indicator) to quantify user perception. For example, a customer might feel
a "need" to watch a show on TV. If the show is available, the customer's
need is satisfied. But if playback is slow or choppy, the customer might
not be happy.
: For more information about SRE and measuring reliability, see [The Happiness Test](https://www.coursera.org/lecture/site-reliability-engineering-slos/the-happiness-test-ELmSr).

hardcode (verb), hardcoded (adjective)
: Don't hyphenate.

he, him, his
: Don't use a gendered pronoun except for a specific individual of known
gender. Use _they_ and _their_ for the general singular pronoun.

healthcare
: Not _health care_ or _health-care_.

health check
: Use with caution. When describing an action taken for a computer system,
only use the term _health check_ if this is the term that appears in
the interface. Be certain to remove any ambiguity regarding whether the
term refers to health in the medical sense.
: Use detailed, non-figurative language as much as possible, such as
referring to a node _being responsive_ instead of referring to a node
being healthy.

healthy
: Don't use. See [health check](#health-check).

high availability (noun), high-availability (adjective)
: Spell as _high availability_ when used as a noun and as _high-availability_ when
used as an adjective. See also [load balancing (noun), load-balancing (adjective)](#load-balancing).
: Lowercase except when part of a product name, but OK to abbreviate as
_HA_ after first use.

higher
: Don't use for a range of version numbers. Instead, use [_later_](#later).
: Don't use to refer to a position in a document. Use _earlier_ or
_preceding_.
: Don't use to refer to a position in the UI. Instead, write instructions
that avoid directional language. For more information, see [Writing accessible documentation](/style/accessibility).
: In Android documentation, use
_higher_ for a range of version numbers, not _later_.
: A release with the highest version number might not be the latest version.
For example, if version 2.0 of an operating system receives a bug-fix
update after version 3.0 has been released, then version 2.0.1 might be
the latest version, even though its version number is lower than 3.0.

high performance computing (HPC)
: Don't hyphenate. Lowercase except at the beginning of a sentence,
heading, or list item.

hit
: Don't use as a synonym for _click_, _press_, or _type_.

hold the pointer over
: Only use this verb phrase in the following cases:

    * When the user needs to hold their mouse over a UI element, but not
      click the UI element. This action involves waiting for the UI to
      react—for example, waiting for a tooltip to open or waiting for a
      submenu to open.
    * When the duration of time is important.

    The phrase *point to* is more common.

: See also [point to](#point-to).
: Recommended: In the **Admin**
menu, hold the pointer over **File**, and then click **New**.
: Not recommended: In the **Admin**
menu, hover over **File**, and then click **New**.

holiday, the holidays
: Don't use to refer to the end of the year. Instead, refer to specific
quarters or months.

home screen
: Two words in Android contexts; not _homescreen_ or
_home-screen_.

hostname
: Not _host name_.

hot
: When possible, avoid [jargon](/style/jargon) like _hot failover_,
_hot standby_, and _hot spare_. If you use one of these phrases,
define it on first use and use it consistently throughout the document. However, see
[hotspot](#hotspot).

hotspot
: In databases, _hotspots_ occur when a small number of nearby rows are
accessed frequently in a short period of time, causing CPU spikes and
affecting performance. Use _hotspot_ and _hotspots_ as nouns.
Don't use verb and gerund forms such as _hotspotting_, because they
translate less consistently.
: When you use _hotspot_, define it the first time that you use it on
a page as you normally do with jargon.
: Recommended: Hotspots in one table
can affect the performance of other tables.
: Not recommended: Hotspotting in one
table can affect the performance of other tables.

housekeeping, house keeping, house-keeping
: Don't use. Instead, use less figurative and more precise terms, such as
_maintenance_ and _cleanup_.

hover
: Don't use. Instead use [_hold the
pointer over_](#hold-the-pointer-over).

HTTPS
: Not _HTTPs_.

### I

IaaS
: Write out on first mention: _infrastructure as a service (IaaS)_.

IAM
: When referring to the Google Cloud product, spell it out on first use:
_Identity and Access Management (IAM)_.
: When referring to UI text, write this term the way it's written in the UI.
: When referring to the general practice of identity and access management,
spell it out in lowercase on first use and include a parenthetical
comment:
: Recommended: Identity and access
management (generally referred to as _IAM_) is the practice of
granting the right individuals access to the right resources for the
right reasons.

ID
: Not _Id_ or _id,_ except in string literals or enums.
: In some contexts, it's best to spell out as _identifier_ or
_identification_.

i.e.
: Don't use. Instead, use phrases like _that is_. Many people confuse
_e.g._ and _i.e._

if
: Wondering whether to use _if_ or _whether_? See [whether](#whether).
: Although it is common in casual usage to omit the word _then_ in _if...then_
statements, you should include helper words like _then_ in technical documentation. For
more information, see
[Use clear, precise, and unambiguous language](/style/translation#clear-language).

image
: _Image_ by itself doesn't localize well because of its many meanings. Consider adding
context—for example, _disk image_ or _container image_.

impact
: Use only as a noun. Instead of writing that something _has an
impact_, use the word _affect_.
: Recommended: This issue affects
user experience.
: Acceptable: This issue has an impact
on user experience.
: Not recommended: This issue impacts
user experience.

index
: Use the plural _indexes_ unless there is a domain-specific reason
(for example, a mathematical or financial context) to use _indices_.

ingest
: Use _import_, _load_, or _copy_ when referring to simple movement of data. Use
_ingest_ only when referring to such operations that also involve significant processing
of the data.

ingress
: When referring to the networking term, use lowercase. When referring
to the GKE term or API, capitalize _Ingress_.

in order to
: Avoid _in order to_; instead, use _to_.
: Use _in order to_ when needed to clarify meaning or to make
something easier to read.
: Recommended: You can use
monitoring to help identify issues.
: Not recommended: You can use
monitoring in order to help identify issues.
: Recommended: The infrastructure is
required in order to support search.
: Not recommended: The infrastructure
is required to support search.

inline
: One word as an adjective, _inline_, not _in line_ or
_in-line_.

instance group
: Don't abbreviate to _IG_. See also [managed instance
group](#mig).

intercluster
: Use unhyphenated _intercluster_, not _inter-cluster_.

interconnectAttachment
: Use when referring to the API. Otherwise, use [_VLAN attachment_](#vlan).

Interconnect connection
: Only use _Interconnect connection_ relative to a product as follows:

    * CDN Interconnect connection
    * Cloud Interconnect connection
    * Dedicated Interconnect connection
    * Partner Interconnect connection

    OK to use *connection* on subsequent mentions.

: When you're referring to a Google Cloud product, always specify the
product name. Don't use _Interconnect_ or _interconnect_ as
standalone terms, and don't use generic terms like _cloud interconnect
connection_ or _cross-connect_.

Interconnect connection location
: Only refer to an _Interconnect connection location_ in context of a
specific product, for example _CDN Interconnect_.
: OK to also use _colocation facility_.

interconnect type
: Don't use. Instead, use _connection type_. Examples of connection
types are a _dedicated connection_ or a _connection provided by a
service provider_.

interface
: OK to use as a noun.
: Don't use as a verb. Instead, use _interact_, _talk_,
_speak_, _communicate_, or other similar terms.

internal DNS
: Write _internal_ all lowercase except at the beginning of a
sentence, heading, or list item.

Internationalized Domain Name (IDN)
: Write out and capitalize each word on first use. OK to abbreviate as
_IDN_ after first use.

internet
: Lowercase except at the beginning of a sentence,
heading, or list item.

Internet Key Exchange (IKE)
: Write out and capitalize each word on first use. OK to abbreviate
_IKE_ after first use.

I/O (see also [Google I/O](#google-io))
: Not _I-O_ or _IO_.

IoT
: OK to use as an abbreviation for _Internet of Things_. Note
the lowercase _o_.

IPsec
: Not _IPSec_ or _IPSECShort_.
: Short for _Internet Protocol Security_. No need to spell out on
first mention.

### J

jank, janky
: Use only to refer to a glitch or problem with graphics that is caused by a loss of data or
inadequate refresh rate. Don't use otherwise. Use a less figurative term to refer to something
of poor or unreliable quality.

just
: Avoid. Usually, _just_ is a filler word that you can delete without
affecting your meaning.
: Recommended: BigQuery skips the row.
: Not recommended: BigQuery just skips
the row.
: If your meaning is unclear without _just_, then use a more specific
term such as _only_, _instead_, or _previously_, or revise
your language to be more specific. (Even if one of these replacement
terms fits, you often don't need it.)
: Recommended: You can run DML
statements in the same way that you'd run a `SELECT`
statement.
: Not recommended: You can run DML
statements just as you'd run a `SELECT` statement.
: Recommended: Let a user query only
the table without full dataset access.
: Recommended: Let a user query the
table without full dataset access.
: Not recommended: Let a user query
just the table without full dataset access.
: Sometimes, _just_ is useful for conveying that one approach is
simpler than another. In those cases, use _just_ instead of
[_simply_](#simple).
: Recommended: Use the namespace ID
`namespace:example-kind` or just `example-kind`.

### K

k8s
: Don't use. Instead, use _Kubernetes_.

KBps
: Short for _kilobytes per second_. By convention, we don't use
_KB/s_. For more information, see [Units of measurement](/style/units-of-measure).

Kbps
: Short for _kilobits per second_. By convention, we don't use
_Kb/s_. For more information, see [Units of measurement](/style/units-of-measure).

kebab, kabob, kebab menu, kabob menu
: Don't use. Instead use the `aria-label` for that particular
icon. For example,
**More**. For more information, see
[Buttons and icons](/style/ui-elements#buttons).

kebab case, kabob case, kebab-case, kabob-case
: Don't use. Instead, use _dash-case_.

key
: Don't use as an adjective in the sense of _crucial_ or
_important_.
: If you use _key_ as a noun, specify which kind of key you're
referring to on first mention, because there are many kinds of
keys in technical contexts.

key pair
: A pair of keys, such as a public key and a private key. Contrast with
_key-value pair_, which refers to a pairing that specifies a value
for a variable (as in configuration files).

key ring
: Use instead of _keyring_ (without the space) when referring to a
grouping of Cloud KMS keys.

key-value pair
: Use instead of _key/value pair_ or _key value pair_.

kill
: Avoid when possible. Instead, use words like _stop_, _exit_,
_cancel_, or _end_. For exceptions to this rule, see
[Documenting command-line
syntax](/style/code-syntax#linux-signals).

### L

lame
: Don't use. Instead, use precise, non-figurative language to refer to a
deficiency in a component.

later
: Use for a range of version numbers, not _higher_.
: Recommended: Use version 2.2 or
later.
: Not recommended: Use version 2.2 or
higher.
: Not recommended: Use version 2.2+.
: A release with the highest version number might not be the latest version.
For example, if version 2.0 of an operating system receives a bug-fix
update after version 3.0 has been released, then version 2.0.1 might be
the latest version, even though its version number is lower than 3.0.
: In Android documentation, don't use
_later_ for a range of version numbers. Instead, use _higher_.
: When referring to a position in a document, use _later_ or
_following_, not _below_.

latest
: Avoid in timeless documentation because this word can become outdated.
: If you must use _latest_, give the reader a reference
point—for example, a version number or release date.
: Recommended: To help keep your
system secure, install the latest version of the tools.
: Recommended: The June 2021 release
includes the latest tools that help secure your system.
: Not recommended: The product includes
the latest tools that help secure your system.
: For more information, see
[Timeless documentation](/style/timeless-documentation).

learnings
: Don't use. Instead, refer to _knowledge_ or _things that you
learned_.

left-nav, right-nav
: Don't use directional language. For more information, see
[Writing accessible documentation](/style/accessibility).
: If referring to applications, use _[navigation menu](/style/ui-elements#term-navigation-menu)_.
: If referring to navigational elements for documentation, use _content
navigation menu_.

legacy
: If possible, use a more precise term. If you do use _legacy_,
include or point to a definition to clarify what you mean in the current
context. Don't use _legacy_ with any sort of pejorative
connotation.

let's (as a contraction of _let us_)
: Don't use if at all possible.
: Not recommended: Let's click the
**OK** button now.

Letter of Authorization and Connecting Facility Assignment (LOA-CFA)
: Write out and capitalize each word on first use. OK to abbreviate as
_LOA-CFA_ after first use.

leverage
: Avoid using if you mean _use_. If possible, use a more precise term.
For example, _use_, _build on_, or _take advantage of_.

lifecycle
: Not _life cycle_ or _life-cycle_.

lift and shift
: See [rehost](#rehost).

    like
    :   It's OK to use *like* for either drawing comparisons (in the sense of *similar to*)
        or introducing examples (in the sense of *such as*).
    :   Recommended: Common I/O operations, like reading files or
        making network requests, can be asynchronous.
    :   Recommended: The new compression algorithm works like a
        dictionary encoder, replacing repeated strings with shorter codes.
    :   See also [such as](#such-as). For more information, see [Format examples](/style/format-examples).

    limits
    :   In an API context, *limit* often refers to usage limits (number of
        queries allowed per second or per day). Where possible, specify the kind
        of limit that you mean, such as *usage limit* or *service
        limit*; the word *limit* can refer to many different kinds of
        limits, including rules about acceptable use. See also [quota](#quota).

    lint
    :   Write both command-line tool name and command in lowercase. Use code font
        except where inappropriate.

    little-endian
    :   Hyphenate. Lowercase except at the beginning of a sentence,
        heading, or list item.
    :   Recommended: The codebase assumes
        little-endian byte ordering.
    :   Not recommended: The codebase assumes
        Little Endian byte ordering.
    :   Not recommended: The codebase assumes
        Little-endian byte ordering.
    :   Not recommended: The codebase assumes
        little endian byte ordering.

    livestream
    :   Not *live stream*.

    load balancing (noun), load-balancing (adjective)
    :   Spell as *load balancing* when used as a noun and as *load-balancing* when
        used as an adjective. See also [high availability (noun),
        high-availability (adjective)](#high-availability).

    lock screen
    :   Two words in Android contexts; not *lockscreen* or
        *lock-screen*.

    login (noun or adjective), log in (verb)
    :   For the verb form, *sign in* is generally better.
    :   If you're documenting a tool that uses the term *log in*, then use
        that term.

    long press
    :   In Android documentation, don't use. Instead, use *touch & hold*.
        (Not *touch and hold*.)

    long-running operation
    :   Not *long running operation*.
    :   OK to abbreviate as *LRO* after the first use.

    lower
    :   Don't use for a range of version numbers. Instead, use [*earlier*](#earlier).
    :   Don't use to refer to a position in a document. Instead, use *later*
        or *following*.
    :   Don't use to refer to a position in the UI. Instead, write instructions
        that avoid directional language. For more information, see [Writing accessible documentation](/style/accessibility).
    :   In Android documentation, use
        *lower* for a range of version numbers, not *earlier*.

### M

male adapter
: Don't use. Instead, use a genderless word like _plug_.

man hours, manhours, man-hours
: Avoid using gendered terms. Instead use terms like _person hours_.

man-in-the-middle (MITM)
: Avoid using gendered terms. Instead use terms like _on-path
attacker_ or _person-in-the-middle (PITM)_.

managed instance group (MIG)
: OK to abbreviate to _MIG_ on subsequent mention. See also
[instance group](#instance-group).

manmade, man made
: Avoid using gendered terms. Instead use a word like _artificial_,
_manufactured_, or _synthetic_.

manned
: Avoid using gendered terms. Instead use terms like _staffed_ or
_crewed_.

manpower, man power, man-power
: Avoid using gendered terms. Instead use terms like _staff_ or
_workforce_.

Markdown
: Always capitalized, even when you're referring to a nonstandard version.

master
: Use with caution. Never use in conjunction with _slave_. Where
possible, replace _master_ with a specific term that is accurate for
the context, such as _primary_, _main_, _original_,
_parent_, _initiator_, _driver_, _controller_,
_manager_, _mixer_, _aggregator_, _publisher_,
_leader_, or _active_.

    Guidance | Recommended | Not recommended || Don't use *master* in conjunction with *slave* in any context. | Cloud SQL primary/replica | Cloud SQL master/slave |
    | Avoid using *master* where possible. | * GKE control plane * Jenkins controller * root key (in security) * primary key (in databases) | * GKE master plane * Jenkins master * master key (in security) * master key (in databases) |

: If the command or code that you're documenting uses the literal word
_master_, then use this word only in direct reference to the code
item ([formatted as code](/style/code-in-text)), make it clear
what you're referring to, and use the new term thereafter.
: See also [_slave_](#slave).

Material Design
: Capitalize each word in _Material Design_.

matrix
: Use the plural _matrixes_ unless there is a domain-specific reason
(for example, a mathematical context) to use _matrices_.

may
: In general, reserve for official policy or legal considerations.
: To convey _possibility_, use _can_ or _might_
instead.
: To convey _permission_, use _can_ instead.
: See also [can](#can), [could](#could),
[might](#might), [must](#must),
[should](#should), and [would](#would).
: For information about clarifying who's performing an action, see
[Active voice](/style/voice).

MBps
: Short for _megabytes per second_. By convention, we don't use
_MB/s_. For more information, see
[Units of measurement](/style/units-of-measure).

Mbps
: Short for _megabits per second_. By convention, we don't use
_Mb/s_. For more information, see
[Units of measurement](/style/units-of-measure).

media type
: In general, use the term [_media type_](https://www.iana.org/assignments/media-types/media-types.xhtml).
In contexts where you need to refer to a _content type_—For example, if you mention
the `Content-Type` HTTP header—it's okay to use _content type_ instead, to avoid
confusion. Don't use _MIME type_.

meta\*
: See [guidance about hyphens with prefixes](/style/hyphens#prefixes).

metafeed
: Not _meta-feed_.

metageneration
: Not _meta-generation_.

method
: In programming contexts where _method_ refers to a member of a class
(as in Java), avoid also using the word generically to mean "approach" or
"manner."

metropolitan area (metro)
: In networking, a _metro_ is a city where a colocation facility is
located.

microservices
: Not _Microservices_ or _micro-services_.

might
: Use to convey possibility or an uncertain outcome (for example, "You
might be prompted to enter your credentials").
: See also [can](#can), [could](#could),
[may](#may), [must](#must),
[should](#should), and [would](#would).
: For information about clarifying who's performing an action, see
[Active voice](/style/voice).

MIME type
: _MIME_ stands for "Multipurpose Internet Mail Extensions," and was originally used to
refer to email standards.
Don't use _MIME_ when you mean [_media type_](https://www.iana.org/assignments/media-types/media-types.xhtml).
If you feel that might be ambiguous to an audience familiar with the term _MIME_,
then you can write _media (MIME) type_ for clarity.

mobile
: Don't use _mobile_ as a standalone noun. Instead, specify
_mobile phone_, or if you're talking about more than phones, then use
_mobile device_.

mobile data
: Use instead of _cellular data_.

mobile device
: Use _mobile device_ when you're referring to more than phones (for
example, tablets and phones). It's OK to use _phone_ (without
_mobile_) when the context is clear.

mobile network
: Use instead of _cellular network_.

mobile phone
: If you're talking about more than phones, then use _mobile device_.
It's OK to use _phone_ (without _mobile_) when the context is
clear.

mom test
: Don't use _mom test_, _grandmother test_, _grandma test_,
or _girlfriend test_. Instead, use terms like _beginner user
test_ or _novice user test_.

monkey, monkey test
: Don't use _monkey_ to refer to people. When referring to tests, refer
to the specific function. For example: _automated, random tests_.

multi\*
: See [guidance about hyphens with prefixes](/style/hyphens#prefixes).

multi-cluster
: Hyphenate. We generally prefer to close prefixed words, but this is an
exception because it's an established term.

multi-region, multi-regional
: Hyphenate when referring to a Google Cloud location that consists of more
than one region.
: You can use _multi-regional_ as an adjective in the context of
multi-regions, but consider _multi-region_ as
an attributive noun instead, such as in "The dataset is in the EU
multi-region location." Use _multiregional_ in other contexts.

multi-service
: Hyphenate. We generally prefer to close prefixed words, but this is
an exception because it's an established term.

multi-tenancy
: Hyphenate. We generally prefer to close prefixed words, but this is
an exception because it's an established term.

must
: Use to describe a required action or state (for example, "You must have
the Editor role"). You can also write _you need_ in order to convey a
requirement.
: See also [can](#can), [could](#could),
[may](#may), [might](#might),
[should](#should), and [would](#would).
: For information about clarifying who's performing an action, see
[Active voice](/style/voice).

### N

N/A
: Not _NA_. Spell out as _not available_ or _not applicable_
on first reference.

name server
: Not _nameserver_.

namespace
: Not _name space_.

native
: Avoid using _native_ to refer to people.
: When referring to software products, try to use a more precise
term—for example, use _built-in_ to describe a feature that's
part of a product.
: The term _native_ isn't necessarily clear—for example,
_cloud-native_ could mean that something was written for the cloud,
or that it's built in to a cloud platform, or that it currently exists in
a cloud platform.
: Alternatives to a term like _cloud-native_ could include:
_modern cloud_, _born in the cloud_, _cloud first_, and
_cloud-born_.

navigation bar
: Don't use to refer to a _navigation menu_. For more information, see
[Navigation menu](/style/ui-elements#term-navigation-menu).

neither
: Write _neither A nor B_, not _neither A or B_.

network IP address
: Don't use. Instead, use _internal IP address_.

new, newer
: Avoid in timeless documentation because this word can become outdated.
: _New_ also implies that the reader knows the older product and that
labeling something as _new_ is therefore meaningful.
: If you must use _new_, give the reader a reference point—for
example, a version number or release date.
: Don't use _newer_ to refer to a specific version of a product.
Instead, use [_later_](#later). Make sure that you provide
a version number or release date by which to understand _later_.

    In Android documentation, use
    [*higher*](#higher) instead of *later*.

: Recommended: The service's network
analysis feature reports on network health.
: Not recommended: Network analysis, a
new feature in the service, reports on network health.
: For more information, see
[Timeless documentation](/style/timeless-documentation).

ninja
: Don't use to refer to a person. Instead, use a term such as _expert_.
OK to use in reference to companies, tools, software packages, and other
entities that use the term in their names.

non\*
: See [guidance about hyphens with prefixes](/style/hyphens#prefixes).

nonce
: Use with caution: this term has a secondary slang meaning that can cause
confusion for global readers. Always define the term on first use, and
only use it in specific technical contexts such as authentication and
blockchain.
: In end-user documentation and other contexts, use a more descriptive
phrase, such as _a number that will be used only once_.

non-key
: An exception to our usual preference for closed forms.

NoOps
: Don't use. Instead, use _fully managed_. If you must include the
term, define it at first use with language such as _fully managed_ or
_no operations_, but not _non-operational_. Don't use
_noops_.
: For an instruction that does nothing, use
[_no-op_](<https://wikipedia.org/wiki/NOP_(code)>) or the
specific instruction name for your context.

NoSQL
: Not _No-SQL_ or _No SQL_.

notification drawer
: In Android contexts, don't hyphenate. Lowercase except at the beginning of a sentence,
heading, or list item.

now
: Avoid when describing features of products or services because this word
is implied.
: If the intent of the text is a comparison between past and present, you
can use _now_—for example, "In versions of the tool earlier
than 1.10, you could use only the default value, but now you can assign a
custom value."
: Recommended: This feature lets you use
combinations of user properties.
: Not recommended: This feature now lets
you use combinations of user properties.
: For more information, see
[Timeless documentation](/style/timeless-documentation).

nuke
: Don't use. Instead use _remove_ or _attack_. For example, a
_denial-of-service attack_.

### O

OAuth 2.0
: Not _OAuth 2_, _OAuth2_, or _Oauth_.

off-the-shelf, commercial off-the-shelf (COTS)
: Use more widely understood terms like _ready-made_, _prebuilt_,
_standard_, or _default_.

old, older
: Don't use to refer to a previous version of a product. Instead, use
[_earlier_](#earlier).
: Make sure that you provide a version number by which to understand
_earlier_.
: In Android documentation, use
[_lower_](#lower) instead of _earlier_.
: Recommended: This functionality
doesn't work in versions earlier than 1.17.0.
: Not recommended: This functionality
doesn't work in older versions.
: For more information, see
[Timeless documentation](/style/timeless-documentation).

omnibox
: Don't use. Instead, use _address bar_.

once
: If you mean _after_, then use _after_ instead of _once_.

on-premises
: Not _on prem_, _on premise_, or _on-premise_. Hyphenate
when used as any part of speech.
: Use to refer to a customer's resources that they manage in their own
facilities. Don't use _peer_.
: It can be acceptable to use _on-premises_ as a noun when it would be
awkward to repeatedly write out a full phrase like _an on-premises
environment_. However, it's preferable to use the more complete phrase
whenever possible.
: Recommended: An on-premises database.
: Recommended: The database runs
on-premises.
: OK: Moving data from on-premises to
Google Cloud.

OS
: OK to use as a shortening of "operating system."

outpost
: Don't use. Instead, use _channel_.
: Recommended: social media channels

outside the box, out of the box, out-of-the-box
: Avoid using in a figurative way. OK to use literally.

overview screen
: In Android documentation, don't use. Instead, use _recents screen_.

### P

PaaS
: Write out on first mention: _platform as a service (PaaS)_.

page
: Use _page_ to refer to the following:

    * A whole web page, which can include text, images, links, banners, navigational panes,
      and other features.
    * A sub-page of a [console](#console) in particular.

    See also
    [documentation or document or documents](#documentation).

: Recommended: To refresh the page, press `F5`.

parameter
: In our API documentation, _parameter_ is usually short for _query
parameter_; it's a `NAME=VALUE` pair
that's appended to a URL in an HTTP `GET` request. In some
contexts, however, the term can have other meanings.

parent-child or parent/child
: Not _parent – child_ or _parent—child_.

path
: Avoid using _filepath_, _file path_, _pathname_, or _path
name_ if possible.

peer gateway
: Don't use _on-premises gateway_ when you mean a _peer gateway_.
A peer gateway can be an on-premises device or service or another cloud
gateway.

peer network
: Don't use _on-premises network_ when you mean a _peer network_.
A peer network can be an on-premises network or another cloud network.

peering zone
: Not _peer zone_.

per
: To express a rate, use _per_ instead of the division slash (/),
unless space constraints require the use of the slash. For more
information, see [Units of
measurement](/style/units-of-measure#rates).
: Avoid _per_ in contexts other than rate units.
: Recommended: requests per day
: Recommended: create a policy for each
Pod
: Recommended: according to the style
guide
: Recommended: in response to your
request
: Not recommended: requests/day
: Not recommended: create a policy per
Pod
: Not recommended: per the style guide
: Not recommended: as per your request

performant
: Avoid where possible. Instead, use a more precise term.
: Recommended: an accurate machine
learning model
: Not recommended: a performant machine
learning model

persist
: Don't use as a transitive verb. It's best to avoid using as a verb at all,
especially in [passive voice](/style/voice).
: Recommended: To make the token
persistent ...
: OK: To make the token persist ...
: Not recommended: The token is persisted
...
: Not recommended: To persist the token
...

persistent disk
: Not _PD_.: Lowercase except at the start of a sentence.

    personally identifiable information (PII)
    :   Some government agencies use the less common term *personally
        identifying information*; use this alternate term only in contexts
        where you're referring to a document that uses this term.

    pets versus cattle, pets vs. cattle, pets v. cattle
    :   Don't use. Instead, use more precise terms like *persistent versus
        dynamic* or *manually configured versus automated*. For more
        information, see
        [Avoid
        figurative language](/style/inclusive-documentation#figurative-language).

    plain text
    :   In most contexts, use *plain text*, but use *plaintext* in a
        cryptography context.

    please
    :   Don't use *please* in the normal course of explaining how to use a
        product, even if you're explaining a difficult task.
    :   Don't use the phrase *please note*.
    :   Use *please* only when you're asking for permission or
        forgiveness—for example, when what you're asking for benefits you,
        inconveniences a reader, or suggests a potential issue with a product.
    :   Recommended: If the issue persists,
        please contact your account representative.
    :   For more information, see
        [voice and tone](/style/tone#politeness).

        plugin (noun), plug-in (adjective), plug in (verb)
        :   Use the noun form *plugin* when referring to the software component. Use the adjective
            form *plug-in* when referring to the action of installing a software component. Use the
            verb form *plug in* when you're describing the process of installing a software
            component.

        PM
        :   See [AM, PM](#am-pm).

        point to
        :   Use to refer to the action of pointing the mouse pointer (focus). This
            action doesn't imply a length of time waiting for the UI to react to user
            action.
        :   This is similar to the action [hold the
            pointer over (hover)](#hold-the-pointer-over). In most cases, it's better to use the verb
            phrase *hold the pointer over* if you want the user to wait for the
            UI to react.

        POJO
        :   If you're not actually writing about a Plain Old Java Object for a Java
            audience, use *simple object*. You can write *a simple object,
            similar to a POJO in Java* if that helps your audience.

        PoP
        :   Acronym for *point of presence*.
        :   Recommended: point of presence (PoP)
        :   Not recommended: point of presence
            (POP)

        pop-up, popup
        :   Don't use.
        :   To describe a window that appears and asks for, or presents, additional
            information, use [*dialog*](#dialog).
        :   To describe a menu that rises from an interface (such as a right-click
            context menu), use *menu*.

        populate
        :   OK to use if you're writing about a process populating a table or other
            entity. If you're writing about a person, use *fill in*.
        :   Recommended: The SQL command
            populates the table with sample data.
        :   Recommended: When you have finished
            filling in the form ...
        :   Not recommended: When you have
            finished populating the form ...

        port
        :   Use *listen on* (not *to*).

        portal
        :   Don't use to refer to the Google Cloud console. For more information, see
            [console](#console).

        possible
        :   Don't use *possible* or *impossible* to mean *you can* or
            *you can't*.

        PostgreSQL
        :   If the UI uses the name *Postgres*, it's OK to match the UI. Don't
            use *PostgreSQL*.

        postmortem
        :   Avoid in general usage. Instead, use *retrospective*.
        :   In disaster recovery (DR) and DevOps contexts, use *blameless
            postmortem*.

        practitioner
        :   Avoid using without any supporting information to define the roles that
            you're referring to.
        :   Recommended: The framework describes
            best practices for architects, developers, administrators, and other cloud
            practitioners.
        :   Not recommended: The framework
            describes best practices for cloud practitioners.

        pre\*
        :   See [guidance about hyphens with prefixes](/style/hyphens#prefixes).

        prebuilt
        :   Not *pre-built*.

        precapture
        :   Not *pre-capture*.

        preemptible
        :   Not *pre-emptible* or *pre-emptive*.

        pre-existing
        :   Not *preexisting*.

        preferred pronouns
        :   Don't use. Instead, use *pronouns*.

        prerecorded
        :   Not *pre-recorded*.

        pre-shared key
        :   Not *preshared key*.

        presently, at present
        :   Avoid because this word or phrase is implied. The word or phrase can also
            prematurely disclose product or feature strategy or inappropriately imply
            that a product or feature might change.
        :   See also [as of this writing](#as-of-this-writing) and
            [currently](#currently).
        :   Recommended: This setting is required.
        :   Not recommended: At present, this
            setting is required.
        :   For more information, see
            [Timeless documentation](/style/timeless-documentation).

        press
        :   Use when referring to pressing a key or a key combination to cause an
            action to occur. Also use for mechanical buttons.
        :   For on-screen and soft (capacitive) buttons, use *tap*.
        :   Recommended: Press
            `Control+C` (or `Command+C` on macOS).

        presubmit
        :   Not *pre-submit*.

        primitive
        :   Use with caution. Don't use *primitive* in a disparaging sense.

        project
        :   In Google Cloud documentation, use *Google Cloud project* on first
            mention and in any context in which there might be ambiguity about what
            kind of project you're referring to.

        proper, properly
        :   Avoid *proper* and *properly*, which are vague and can imply subjective judgments of
            correctness or superiority. Instead, focus on describing the technical details. For more
            information, see [Use precise,
            objective language](/style/inclusive-documentation#subjective-language).
        :   Recommended: Verify that the port is open and accepting
            connections.
        :   Not recommended: Ensure the port is properly configured.

        pros
        :   Don't use. Instead, use a more precise term, such as *advantages*.

### Q

quick, quickly
: What might be quick for you might not be quick for others. Try eliminating this word from the
sentence. For more information, see [Use precise, objective language](/style/inclusive-documentation#subjective-language).

quota
: In API contexts, often refers to API usage limits. Where possible, it's
best to use a more specific term, such as _usage limit_; the word
_quota_ means many different things to many different people.
: In some contexts, such as Google Cloud documentation, the standard term is
_quota_, so use that term.

### R

RDP
: Don't use as a verb. Instead, use _connect using RDP_. If it's
clear from context that they're using RDP, it's OK to use _connect_.

re\*
: See [guidance about hyphens with prefixes](/style/hyphens#prefixes).

read-only
: Not _read only_. Always hyphenate _read-only_.

recents screen
: In Android contexts, use instead of _overview screen_.

redline
: Don't use as a verb. Instead, use precise terms appropriate to the
context.
: In the context of editing or providing a review, refer to those actions or
to _tracking changes_.
: In the context of setting priorities and planning work, refer to those
actions or to _priority lining_.

regex
: Don't use. Instead, use _regular expression_.

rehost
: Use to describe the migration of an app or workload with no changes or
minimal changes to that app or workload. Also known as _lift and shift_. For more
information, see [Rehost: lift and shift](https://cloud.google.com/architecture/migration-to-gcp-getting-started#rehost_lift_and_shift) in the Cloud Architecture Center.
: On first mention, associate rehost with lift and shift. Okay to use _rehosting_ as needed
after first mention.
: Recommended: You can use this reference architecture to
efficiently rehost (lift and shift) on-premises applications to the cloud.
: Recommended: The first step to modernization is to rehost
your application in the cloud (also known as lift and shift).
: Don't use _the forklift approach_.

repo
: Don't use. Instead, use _repository_.

Representational State Transfer
: Don't use. To people unfamiliar with REST, this acronym expansion is
meaningless; it's better to refer to it as REST and not explain what it
stands for.

reservation, off the
: Don't use.

resource record set
: Not _resource recordset_.

retarded
: Don't use. If you are referring to a system or component being slowed,
use the word _slowed_.

retriable, triable
: Don't use _retriable_ or _triable_, unless a code item uses that
spelling. Outside of code font, write around the term.

retryable, tryable
: Where possible, write around _retryable_ and _tryable_. For
example, write out _you can try it again_ or _can be tried
again_.

review
: If you mean "read, potentially for the first time," then use _read_
instead of _review_.
: If you mean "read critically, commenting on problems" (as in _code
review_), then _review_ is fine.
: Avoid using phrasing like "If you've never heard of OAuth, then review the
OAuth documentation."

RFC
: When referencing an RFC specification, use a space between _RFC_ and
the number (for example, _RFC 2318_).

roll out
: Don't use to mean a sudden or instantaneous launch. If you use _roll
out_, define what you mean. When possible, use a more precise,
non-figurative term like _gradual_, _in stages_, _phases_,
or _progressive_.

RTFM
: Don't use. Instead, use a more precise phrase like "For more information,
see ...."

runbook
: Not _run book_.

runtime, run time
: Use the noun _runtime_ when referring to the environment in which
software runs, such as a Ruby or Java runtime.
: Use the noun phrase _run time_ when referring to the time during
program execution when something occurs, as contrasted with _compile
time_, for example.
: Recommended: The profiler collects
data at run time, and the scheduler uses this data at compile time to
improve performance for subsequent runs.
: Recommended: The App Engine standard
environment has two generations of runtime environments. The
second-generation runtimes significantly improve the capabilities of App
Engine.

### S

SaaS
: Write out on first mention: _software as a service (SaaS)_.

sane
: Don't use. Instead use a word like _valid_ or _sensible_.

sanity check
: Don't use. Instead, use a term like _quick check_, _confidence
check_, _preliminary check_ or _coherence check_.

SAP
: Pronounced as the individual letters _S_, _A_, _P_, so
write _an SAP system_, not _a SAP system_. For more information, see
[Indefinite articles before abbreviations](/style/abbreviations#articles).

scale
: Don't use _scale_ alone to say that something is large or increasing.
Include supporting words to indicate magnitude or direction of change in
magnitude, whether scaling up or down, such as when you change a machine
type to add or remove CPUs or RAM, or scaling out or in, such as adding or
removing instances from a group.
: Recommended: The system performs
better at a larger scale.
: Not recommended: The system performs
better at scale.
: Recommended: The system scales up
quickly, but it scales down more slowly.
: Not recommended: The system scales
quickly.

screenshot (noun)
: Not _screen shot_ or _screensnap_.
: Don't use as a verb; instead, use _take a screenshot_.

scroll
: OK to use _scroll_ as a verb, but if possible, instead use a term
that isn't specific to implementation. For example, write _go to the
section_, instead of _scroll to the section_.
: If you use _scroll_, don't use directional language
like _scroll up_. For more information, see
[Accessibility](/style/accessibility#document-rendering).

Search (as part of product name)
: Capitalize _Search_ when referring to a product like Google Search.

Search Console
: Capitalize each word in _Search Console_.

see
: OK as a general term and when referring to links and cross-references. Our
research indicates that language relating to sight is OK for a wide range
of readers. For more information, see
[Cross-references and linking](/style/cross-references).

select
: Use to describe choosing an item from among multiple options, selecting
text, or marking a checkbox.
: Recommended: Select **Automatically
check for updates**.
: Not recommended: Check
**Automatically check for updates**.

sensitive
: _Sensitive_ data is data for which the release might be harmful. See
[confidential](#confidential).

service
: It's OK to refer to Google products, such as Google Kubernetes Engine or
Compute Engine, as _services_. However, if the term _services_
leads to ambiguity, then use the product names.

service level agreement
: Lowercase when referring to service level agreements in general.
: It's OK to use title case (_Service Level Agreement_) when referring
to a specific document.
: OK to abbreviate as _SLA_ after first use.

service level indicator
: Lowercase except at the beginning of a sentence,
heading, or list item.
: OK to abbreviate as _SLI_ after first use.

service level objective
: Lowercase except at the beginning of a sentence,
heading, or list item.
: OK to abbreviate as _SLO_ after first use.

setup (noun or adjective), set up (verb)

sexy
: Don't use. Instead, use precise, positive words, such as _fast_,
_powerful_, or _elegant_.

SHA-1
: Not _SHA1_, except in string literals/enums and in hyphenated phrases
such as _HSA-SHA1_.

shall
: Avoid _shall_ except under advice from a lawyer. For more
information, see [should](#should).

she, her, hers
: Don't use a gendered pronoun except for a specific individual of known
gender. Use _they_ and _their_ for the general singular pronoun.

sherpa
: If possible, use a more precise term. For example, if you mean
_guide_, use that term.

shift left
: In general, avoid using this term to mean moving something earlier in
time. Instead, use a less figurative phrase, such as _shift earlier_
or _move to an earlier phase_. This figurative term relies on the
non-universal assumption that the natural flow is from left to right.
: It's OK to use _shift left_ and _shift right_ in the context of
binary multiplication and division.

should, should be
: Generally avoid.
: Because _should_ is ambiguous by definition, it can be problematic. For more information
and alternatives, see
[Word choice for recommendations and requirements](/style/prescriptive-documentation#word-choice).
: See also [can](#can), [could](#could),
[may](#may), [might](#might),
[must](#must), and [would](#would).

sign-in (noun or adjective), sign in (verb)
: Not _log in_ or _signin_.

sign into
: Don't use. Instead, use _sign in to_.

sign-on, sign on
: Don't use either form on its own. Use the hyphenated version as part of
_single sign-on_.

sign-out (noun or adjective), sign out (verb)
: Not _log out_ or _signout_.

simple, simply
: What might be simple for you might not be simple for others. Try eliminating this word from
the sentence because usually the same meaning can be conveyed without it. For more
information, see [Use precise,
objective language](/style/inclusive-documentation#subjective-language).

since
: If you mean _because_, then use _because_ instead of
_since_. _Since_ is ambiguous; it can refer to the passage of
time. _Because_ refers to causation or the reason for something.

single most
: Not _singlemost_.

single pane of glass
: Avoid. This term is used to favorably compare a centralized control and
monitoring interface against the alternative of several disparate
interfaces. It can almost always be replaced by _single interface_ or
_unified interface_.

single sign-on (noun or adjective)

slave
: Don't use. Instead, use alternative terms appropriate to your domain, such
as _worker_ or _replica_.
: If you're replacing the terms _master_ and _slave_ together,
then consider such combinations as _primary_/_secondary_,
_primary_/_replica_, _original_/_replica_,
_controller_/_worker_, _initiator_/_responder_,
_mixer_/_leaf_, _aggregator_/_collector_,
_publisher_/_subscriber_, _leader_/_follower_, and
_active_/_standby_.
: If the command or code that you're documenting uses the literal word
_slave_, then use this word only in direct reference to the code item
([formatted as code](/style/code-in-text)), make it clear what
you're referring to, and use the new term thereafter. For example, "Invoke
the secondary (`slave`) process directly when debugging issues
between the primary and secondary processes."
: See also [master](#master).

slice and dice
: Don't use the phrase _slice and dice_. Instead, use specific terms
appropriate to the task that you're describing. Some possible options
include: _segment data for analysis_ or _break information into
smaller parts_.

smartphone, smart phone
: Don't use. Instead, use [_mobile phone_](#mobile) or
_phone_. If you're talking about more than phones, then use _mobile
device_. It's OK to use _phone_ (without _mobile_) when the
context is clear.

soon
: Avoid in timeless documentation because this word can become outdated. The
word can also prematurely disclose product or feature strategy or
inappropriately imply that a product or feature might change.
: See also [eventually](#eventually) and
[future](#future).
: Recommended: This setting is
optional.
: Not recommended: This setting is
optional for existing applications but will soon be required for all
applications.
: For more information, see
[Timeless documentation](/style/timeless-documentation).

spin up
: As in _spin up an instance_. Avoid using _spin up_ unless you're
referring to a hard disk; instead, use a less colloquial term like
_create_ or _start_.

SQL
: Refer to _a SQL_ (pronounced "a sequel"), not _an SQL_. For more
information, see
[Indefinite articles before abbreviations](/style/abbreviations#articles).

ssh and SSH
: Don't use `ssh` or SSH as a verb. SSH is a secure
communications protocol; `ssh` is a utility.
: Recommended: To establish an SSH
connection, use the `ssh` command.
: Recommended: Connect to the instance
by using SSH.: Not recommended: `ssh` into
your remote shell.

    ssh'ing
    :   Don't use. See also [ssh and SSH](#ssh).
    :   Recommended: When you use
        `ssh` to log in ...

    startup (noun or adjective), start up (verb)

    static external IP address
    :   Don't use *static IP address* or *external IP address* to refer
        to static external IP addresses.

    status bar
    :   Not *statusbar* or *status-bar*.
    :   Lowercase except at the beginning of a sentence,
        heading, or list item.

    STONITH, STOMITH
    :   Avoid using
        [graphic or
        metaphorical language](/style/inclusive-documentation#graphic-language). Instead, explain the relevant feature, such as
        *fence failed nodes*.

    style sheet
    :   *Style sheet* and *stylesheet* are both acceptable spellings. However, be consistent
        with your choice throughout a given document.

    sub-command
    :   Not *subcommand*.

    subnet
    :   OK to use as a shortening of *subnetwork*. Use the same term consistently throughout your
        document. For more
        information, see [Subnets vs. subnetworks](https://cloud.google.com/compute/docs/vpc/#subnets_vs_subnetworks).

    subtree
    :   Not *sub-tree*.

    subzone
    :   Not *sub-zone* or *sub zone*.

    such as
    :   Use *such as* to introduce examples or draw comparisons. Note that *such as*,
        *like*, and *include* introduce non-exhaustive lists, so it's redundant to combine
        them with *etc.*, *so forth*, or *and more*. See also [etc.](#etc),
        [like](#like). For more information, see [Format
        examples](/style/format-examples).

    surface
    :   Avoid as a transitive verb; instead, use a more specific term, such as
        *make people aware of* or *expose*.
    :   Recommended: To make the audit logs
        available, you must configure the monitoring system.
    :   Not recommended: To surface audit
        logs, you must configure the monitoring system.

### T

tab
: When referring to the sub-pages of a [console](#console), use
_page_ instead of _tab_.

table name
: Two words. Set specific table names in code font.

tablet
: _Tablet_ is OK. If you don't know whether it's a tablet or a phone,
use _device_.

tag
: See [element](#element).

tap
: In Android documentation, use for on-screen and soft (capacitive)
buttons.: Use instead of _click_ when the environment is definitely a
touch device.
: Use instead of _touch_. However, _touch & hold_ (not _touch
and hold_) is OK to use.
: For mechanical buttons, use [_press_](#press).

    tap & hold, tap and hold
    :   In Android documentation, don't use. Instead, use *touch & hold*.
        (Not *touch and hold*.)

    tarball
    :   Don't use. Instead, use *tar file*.

    target
    :   Avoid using as a verb when possible, especially in reference to people.
        For some readers, *target* has aggressive connotations. Instead of
        "targeting" audiences, we try to attract them or appeal to them or make
        their lives easier.
    :   It's OK to use *target* as an adjective, as in *target
        audience*, but consider rephrasing for clarity. Alternatives
        include phrases such as *intended for*, *looking for*,
        *focused on*, and *interacting with*.

    terminate
    :   Avoid using as a synonym for *stop*. Instead, use words like
        *stop*, *exit*, *cancel*, or *end*.
    :   For a specific context where you can use *terminate* as a synonym for
        *stop*, see [Documenting
        command-line syntax](/style/code-syntax#linux-signals).:   :   In some contexts, such as telephony and networking, *terminate* has
                specific technical meanings that aren't synonyms for *stop*; in those
                contexts, you can use *terminate*.

            text box, textbox
            :   Don't use. Instead, use *box*. For more information, see
                [Text box](/style/ui-elements#term-textbox).
            :   In Google Cloud documentation, use
                *field* instead of *box*. For example, "In the **Instance**
                field, specify a value less than 64 characters long."
            :   In Google Workspace documentation, use
                *field* instead of *box*. For example, "In the **Instance**
                field, specify a value less than 64 characters long."

            their (singular)
            :   See [*they*](#they).

            then
            :   Although it is common in casual usage to omit the word *then* in *if...then*
                statements, you should include helper words like *then* in technical documentation. For
                more information, see
                [Use clear, precise, and unambiguous language](/style/translation#clear-language).

            they (singular)
            :   This is our preferred gender-neutral pronoun. Whether used as singular or plural, it always
                takes the plural verb.
            :   Recommended: A user enters their password, and then they
                insert their security key.
            :   See also [gender-neutral he](#gender).

            third party (noun), third-party (adjective)
            :   Spell as *third party* when used as a noun and as *third-party* when used as an
                adjective.
            :   Avoid abbreviating to *3rd party* or *3rd-party*. For more information, see [Ordinal numbers](/style/numbers#ordinal-numbers).

            this, that
            :   Where possible, put a noun after *this* or *that* for clarity.
                If doing so results in clunky prose, then don't do it; but even then, try
                thinking about what the noun would be. If you aren't sure what noun
                *this* or *that* refers to, then consider rephrasing—otherwise, your reader
                probably won't know what noun you're referring to, either.

            timeframe
            :   Not *time frame*. Avoid where possible, or use an alternative such as
                *period*, *schedule*, *deadline*, or *when*. But if
                you do use it, then write it as one word.

            timeout (noun), time out (verb)

            timestamp
            :   Not *time stamp*.

            time to live
            :   Not *time-to-live*. Abbreviate as *TTL* after first use.

            time zone (noun), time-zone (adjective)
            :   Spell as *time zone* when used as a noun and as *time-zone* when used as an
                adjective. See also [wake lock (noun), wake-lock (adjective)](#wake-lock).

            tl;dr
            :   Don't use. Instead, use something like *To summarize*, or revise the
                sentence.

            toolkit
            :   Not *tool-kit* or *tool kit*.

            touch
            :   In Android documentation, don't use. Instead, use *tap*. However,
                *touch & hold* is OK to use.

            "touch & hold"
            :   Not *touch and hold*.

            touchscreen
            :   Not *touch screen*

            traditional
            :   If possible, use a more precise term.
            :   Recommended: Conventionally, Python
                function names are lowercase, with words separated by underscores.
            :   Not recommended: Traditionally, Python
                function names are lowercase, with words separated by underscores.
            :   Recommended: This tutorial explains
                how to migrate from an on-premises data warehouse to BigQuery.
            :   Not recommended: This tutorial
                explains how to migrate from a traditional data warehouse to BigQuery.

            transpile
            :   Not *transcompile*.

            tribal knowledge, tribal wisdom
            :   Don't use. Instead, use a less figurative term to indicate knowledge held
                by a group of people.

            trojan
            :   Lowercase when referring to malware.

            turn on
            :   In procedures, use the appropriate label and action for the
                [UI element](/style/ui-elements) that the user interacts with.
            :   For turning on or activating an option or feature, use *turn on* or
                [enable](#enable) consistently. Use the same term consistently throughout your
                document.
            :   Recommended: To turn on Magic Mode,
                follow these steps.
            :   Recommended: In **Settings**, click
                the **Magic mode** toggle to the on position.

            tutorial
            :   OK to use. See [documentation](#documentation).

            type
            :   In general, use [enter](#enter) instead of *type* because
                there is typically more than one way to enter text than typing (such as
                pasting text or speaking).

            typically
            :   Use to describe what is usual or expected under normal circumstances.
            :   Don't use as the first word in a sentence, as doing so can leave the
                meaning open to misinterpretation.

### U

UI
: Don't use generically to refer to a page or dashboard. Use a more specific
term like [_page_](#page) or
[_console_](#console). If a specific term is unavailable,
use _web interface_.
: Recommended: In the Google Cloud
console
: Recommended: On the **Cloud Tasks**
page
: Recommended: In the Secure Source
Manager web interface
: Not recommended: In the **Cloud
Tasks** UI

unarchive
: Don't use. Instead, use _extract_.

uncheck
: Don't use to refer to clearing a check mark from a checkbox. Instead, use
_clear_.
: Recommended: Clear **Automatically
check for updates**.
: Not recommended: Uncheck
**Automatically check for updates**.
: Not recommended: Deselect
**Automatically check for updates**.

uncompress
: Don't use. Instead, use _extract_.

under
: Don't use for a range of version numbers. Instead,
use [_earlier_](#earlier).
: Don't use to refer to a position in the UI.
: Recommended: In the **Service account
ID** field, enter a name.
: Recommended: For **Service account
ID**, enter a name.
: Not recommended: Under **Service
account ID**, enter a name.

Unicode
: Not _UNICODE_.

Unix-like
: Not _Unixlike_ or _Unix like_.

Unix epoch time
: Use instead of _Unix time_ or _epoch time_ to refer to a
point in time represented as a number of seconds since the Unix epoch
(00:00:00 UTC on January 1, 1970), ignoring leap seconds.

unselect
: Don't use. Instead, use _clear_ for checkboxes, and _deselect_
for other UI elements.: unsighted
: Don't use. See [blind](#blind).

        untar
        :   Don't use. Instead, use *extract*.

        unzip
        :   Don't use. Instead, use *extract*.

        US
        :   OK to use as an abbreviation for *United States*. Don't use
            *U.S.* or *U.S.A.* For more information, see [Periods with abbreviations](/style/abbreviations#periods).

        user
        :   Use the word *user* only to refer to the user of the software that
            your reader is developing. Otherwise, address the reader as *you*
            and assume that they will complete the tasks that you're documenting. For
            more information, see [Second person and first
            person](/style/person).

        user base
        :   Not *userbase*.

        using
        :   Where *using* might have more than one interpretation, use *by using* or
            *that use* instead to help clarify the logic of the sentence.
        :   Recommended: Remove the Compute Engine VMs by using the
            test tag.
        :   Recommended: Identify the service accounts that use the
            Google Cloud console.
        :   Not recommended: Filter the IAM roles using custom
            permissions.
        :   It's OK to use *using* (or *with*) when misinterpretation is unlikely.
        :   Recommended: You can connect to Cloud SQL using IAM
            database authentication.

        UTF
        :   Include the hyphen in the names of Unicode encodings, such as
            *UTF-8*, *UTF-16*, and *UTF-32*.:   utilize, utilization
                :   Use with caution. Don't use *utilize* when you mean *use*. It's
                    OK to use *utilize* or *utilization* when referring to the
                    quantity of a resource being used.
                :   Recommended: When CPU utilization
                    exceeds 75%, the autoscaler adds more CPU resources.
                :   Recommended: To distribute network
                    traffic, use a load balancer.
                :   Not recommended: To distribute network
                    traffic, utilize a load balancer.

### V

v (abbreviating _version_)
: Use lowercase.

via
: Don't use.

vice versa
: Don't use. Write out the relationship explicitly. To emphasize the
reciprocal or contrasting relationship, you can use a more precise term
like _conversely_.
: Not recommended: You can copy local
files to the cloud and vice versa.
: Recommended: You can upload local
files to the cloud or download cloud files to your local environment.
: Recommended: You can upload local
files to the cloud. Conversely, you can download cloud files to your local
environment.

virtual machine (VM) instance
: Use when first introducing virtual machines on a given page. For
subsequent mentions, you can use _VM instance_ or _VM_.
: For Google Cloud: on first mention of a Compute Engine VM,
use _Compute Engine instance_ and then use _compute instance_
throughout the rest of the document. If you need to indicate other types of
VMs, use _VM_, _VM instance_, or _bare metal instance_.
: See also [GKE node](#gke-node).

visually challenged
: See [blind](#blind).

VLAN attachment
: Don't use the following: _interconnect attachment (VLAN)_,
_Interconnect attachment_, _Cloud Interconnect attachment_, or
any variation thereof. See also
[interconnectAttachment](#interconnect-attachment).

voila
: Don't use.

voodoo
: Don't use. Instead, use a term like _mysterious_, _complicated_,
or _nondeterministic_.

vs.
: Don't use _vs._ as an abbreviation for _versus_; instead, use
the unabbreviated _versus_.

### W

wake lock (noun), wake-lock (adjective)
: Spell as _wake lock_ when used as a noun and as _wake-lock_ when used as an
adjective. See also [time zone (noun), time-zone (adjective)](#time-zone).

walkthrough
: Not _walk-through_.

war room, warroom, war-room
: Don't use. Instead, use a more precise term to describe the activity or
team. Depending on context, possible alternatives include _rapid
response team_, _situation response team_, _situation room_,
_incident-management team_, or _media monitoring room_.

warm
: When possible, avoid [jargon](/style/jargon) like _warm
failover_, _warm standby_, and _warm spare_. If you use one
of these phrases, define it on first use and use it consistently
throughout the document.

we
: Don't use _we_ (or other first-person plural pronouns such as
_our_ or _us_) to address the reader who is performing the
tasks that you're documenting. Instead, use _you_.
: It's OK to use _we_ to refer to the organization that's represented
as the author of the document as long as the antecedent is clear. For more
information, see
[Second person and first person](/style/person).

web (lowercase)

WebAssembly, Wasm
: Use the capitalization established in the
[WebAssembly specification](https://webassembly.github.io/spec/core/intro/introduction.html#introduction).

web application firewall (lowercase)

webmaster, web master
: Don't use. Instead, use a more precise term to describe the specific role,
such as _website owner_, _website administrator_, _web content
manager_, _owner of a site_.

web server
: Not _webserver_.

whether
: * To decide whether it's more appropriate to use _if_ or
_whether_, see [Grammar Girl's
discussion of _if_ and _whether_](http://www.quickanddirtytips.com/education/grammar/if-versus-whether). * To decide whether you need to add _or not_ when using
_whether_, see [the New York
Times's blog post about whether (or not)](http://afterdeadline.blogs.nytimes.com/2010/03/01/whether-or-not/).

while
: Don't use to indicate a contrast. Instead, use a more precise term, such
as _although_.
: OK to use to refer to a period of time.

white-box
: Avoid using _white-box_, _whitebox_, or _white box_ to
describe monitoring and testing. Consider using a more precise term for
clarity.

    * For monitoring, use *introspective monitoring*.* For testing, use *clear-box testing*.

white glove, white-glove, whiteglove
: Avoid using. Instead use terms like _high-touch_, _premium_, or
_platinum-level_.

whitehat, white hat, white-hat
: Don't use. Instead, use precise terms for the kind of compliance, such as
_legal_, _ethical_, or _following the rules_.

white label, whitelabel, white-label
: Don't use. Instead, use a more precise term for your context, such as
_unbranded_, _unlabeled_, or _blank label_.

whitelist, white list, white-list
: Don't use. See [blacklist](#blacklist).

whitelisted, white listed, white-listed
: Don't use. See [blacklist](#blacklist).

whitelisting, white listing, white-listing
: Don't use. See [blacklist](#blacklist).

whitepaper
: Not _white paper_.
: When possible, use a more precise term. The term _whitepaper_ has a variety of
meanings in various contexts. If you must use the term _whitepaper_, also use descriptive
terms to provide context.

whitespace
: Not _white space_.

wildcard
: Not _wild card_.

will
: Avoid. Applies equally to its past tense, _would_. See also
[Present tense](/style/tense) and
[Documenting future features](/style/future).

wish
: Don't use. Instead, use a word like _want_ or _need_.

with
: Don't use _with_ when expressing ownership:: Recommended: A handset that has 2 GB
of RAM.
: Not recommended: A handset with 2 GB
of RAM.
: Don't use _with_ when expressing use:: Recommended: Use the debugging tool
to debug.
: Not recommended: Debug this tool with
the debugging tool.

workload
: The term _workload_ might refer to software, like an app or
a service; to app resources, like data and infrastructure; or to physical
components that work together.
: Where possible, use a more precise term to describe what you mean. If you
use the term _workload_, define your meaning on first use as you
normally would with jargon and other ambiguous terms.

World Wide Web
: Don't use. Instead, use _web_.

would
: Avoid using. Instead, use _can_ where possible.
: See also [can](#can), [could](#could),
[may](#may), [might](#might),
[must](#must), and [should](#should).
: For information about clarifying who's performing an action, see
[Active voice](/style/voice).
: For information about tenses, see [Present
tense](/style/tense).

### Y

ymmv
: Don't use. Instead, use something like _Your results might vary_.

you
: Use _you_ instead of [_user_](#user) to address the
reader of your document. For more information, see
[Second person and first person](/style/person).

### Z

zippy
: Don't use to refer to [expander arrows](#expander-arrow),
unless you're specifically referring to the [Zippy widget](https://google.github.io/closure-library/api/goog.ui.Zippy.html)
in Closure.
