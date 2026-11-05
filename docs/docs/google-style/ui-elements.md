<!-- source: https://developers.google.com/style/ui-elements -->
<!-- clipped: 2026-11-05 -->

# UI elements and interaction

## Page Summary

- Instructions should focus on user goals and avoid UI specifics unless crucial for clarity.
- UI elements like buttons and menus should be referred to by their labels in bold (e.g., **File** menu, **Open** command).
- Prioritize feature functionality over UI element type, using specific terminology for clarity (e.g., "field" instead of "text box" in Google Cloud/Workspace).
- Accessibility is important; ensure tooltips are present for icons and avoid directional language.
- Keyboard keys should be formatted using `<kbd>` tags, with uppercase letters for letter keys and spelled-out modifier keys.

## Focus on the task

When practical, state instructions in terms of what the reader
should accomplish, rather than focusing on the widgets and gestures.
By avoiding reference to UI elements, you help the reader understand
the purpose of an instruction, and it can help future-proof
procedures.

Recommended: Refresh the page.

Recommended: Expand the **Advanced options**
section.

However, know the audience and understand the context. In some cases, the point
of a procedure is to guide the reader through elements on the page. Or the UI might not be obvious,
and it's helpful to explain the gestures for completing a step. Provide the level of detail
that seems useful for the intended audience.

Recommended: Click **Refresh**.

Recommended: To expand the **Advanced
options** section, click the
expander arrow.

The rest of this page focuses on scenarios where you've decided it's
useful to explicitly discuss UI elements.

For information about writing procedures, see [Procedures](/style/procedures).

## Format names of UI elements

When referring to any UI element by name, put its name in bold, using the
`b` element in HTML or `**` in Markdown. This
includes names for buttons, menus, dialogs, windows, list items, or any other
feature on the page that has a visible name. Don't use code font for UI elements,
unless it's an element that meets the [requirements for code font](/style/code-in-text).
In that case, use both code font and bold.

**Note**: The reason for using the [`b`
element](https://html.spec.whatwg.org/multipage/semantics.html#the-b-element) is that in modern HTML, `b` connotes text to which
you want to draw visual attention, whereas the [`strong`
element](https://html.spec.whatwg.org/multipage/semantics.html#the-strong-element) indicates strong importance.

Don't make an official feature name or product name bold, except when it
directly refers to an element on the page that uses the name (such as a window
title or button name).

Recommended:
In the **New project** window, select the **New activity**
checkbox, and then click **Next**.

Not recommended:
In the New Project window, select "New Activity", and then click the
"Next" button.

If you document a UI element outside the context of a procedure, try to provide context for the
element.

Recommended: The service lets you check the status of all
jobs in the **Current jobs** section of the service console.

Not recommended: The service lets you check the status of
all jobs in the **Current jobs** section.

## Use appropriate capitalization

In most cases, follow the capitalization as it appears on the page. However,
if labels are inconsistent or they're all uppercase, use sentence case.

| Guidance                                                                                                  | Recommended                                             | Not recommended                                         |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| When a label is all uppercase, use sentence case.                                                         | Click **Refresh**.                                      | Click **REFRESH**.                                      |
| When referring to multiple labels that are inconsistently cased, use sentence case for all of the labels. | Click **New project**, and then click **New activity**. | Click **NEW PROJECT**, and then click **New Activity**. |

## Refer to UI elements

Don't use UI elements as if they were English verbs or nouns.

| Recommended                                                                                  | Not recommended                   |
| -------------------------------------------------------------------------------------------- | --------------------------------- |
| In the **Name** field, enter an account name.                                                | **Name** the account.             |
| To save the settings, click **Save**.                                                        | **Save** the settings.            |
| In the **Service account ID** field, enter a name. For **Service account ID**, enter a name. | Specify a **Service account ID**. |

## Terminology and usage

A user interface can contain a variety of UI elements. In general, focus on
the feature and its functionality, not the UI element. If you think it adds
clarity for the reader, use the name of the UI element. For example, both of the
following sentences are valid:

Recommended:
Go to **File > Tools**.

Recommended:
In the **File** menu, click **Tools**.

Don't use slang terms for UI elements—for example,
_hamburger icon_ or _zippy_. For more information, see
[Buttons and icons](#buttons).

Recommended:
To expand the **Advanced options** section, click the
expander arrow.

Recommended:
Expand **Advanced options**.

Not recommended:
To expand the **Advanced options** section, click the zippy.

The following sections define some terms to use when referring to UI
elements.

For prepositions to use with these elements, see the
[Prepositions](#prepositions) table.

### Windows, pages, dialogs, panes, and sections

Most often, a _window_ is the entire application window in a desktop
environment. However, it can also refer to modular application elements that you
can open and close. For example, in Android Studio, several windows are
available in the **View > Tool Windows** menu.

Recommended:
In the **MyApp** window, click **Edit**.

Not recommended:
In the **MyApp** page, click **Edit**.

_Page_ is the preferred term when referring to a web page in general and to a subpage
of a console in particular. For more information, see
[console](/style/word-list#console).

Recommended:
In the Google Cloud console, go to the **Deployments** page.

Not recommended:
In the Google Cloud console, go to the **Deployments** window.

A _dialog_ is a smaller window that is usually detached from the
main application window and appears in front of the window.

Recommended:
In the **Welcome** dialog, click **OK**.

Not recommended:
In the **Welcome** pop-up window, click **OK**.

A _pane_ (or _panel_) is typically a distinct rectangular region within a larger
browser or application window. A pane or panel can often be tightly coupled to surrounding UI
regions, whereas a window is distinctly separate and can be hidden. Do not use terms such as
_window_, _section_, _area_, or _column_ to refer to a pane or panel.

Recommended:
In the **Create service account** pane, click **New**.

Not recommended:
In the **Create service account** section, click **New**.

A _section_ is a labeled grouping of options and controls, usually within a window, pane, or
panel. Do not use terms such as _area_ or _column_ to refer to a section.

Recommended: In the **Create metric** pane, do the
following:

- In the **Metric type** section, select **Counter**.
- In the **Labels** section, click **Add label**.

### Menus and menu bars

In a desktop application, the _menu bar_ appears at the top of the
window or at the top of the screen; it's a set of _menus_ (such as
**File** or **Edit**), each of which is a set of related
_commands_ and/or nested submenus.

To refer to an item in a menu, use the term _command_, not _choice_, _menu item_,
or _option_. Exception: if you're documenting how to build an interface,
you can use _menu item_.

To refer to a menu, use the form _the **LABEL\_NAME** menu._

To tell the reader where to find a command in a menu or submenu, use a phrase like
_In the **File** menu, select **Open**._

Don't use _drop-down_ as a synonym for _menu_. See
[drop-down](/style/word-list#drop-down).

#### Use angle brackets

Another option is to use angle brackets (>). If you use angle brackets, follow these
guidelines:

- Put a nonbreaking space (`&nbsp;`) before each angle bracket.
- Don't bold each menu name separately; instead, enclose the entire sequence in a single bold
  tag (`<b>...</b>` or `**...**`).
- Wrap the angle bracket with a span tag and add an `aria-label` attribute with
  _and then_ text
  (for example, `<span aria-label="and then">></span>`).
  Otherwise, some screen readers might read `>` as "greater than."

In the following example, the text renders as _Select **View >
Tools > Developer Tools**_. A screen reader
interprets this as _Select View and then Tools and then Developer Tools_.

### HTML

```
Select <b>View&ampnbsp<span aria-label="and then">></span> Tools&ampnbsp<span aria-label="and then">></span> Developer Tools</b>.
```

### Markdown

```
Select **View&ampnbsp<span aria-label="and then">></span> Tools <span aria-label="and then">></span> Developer Tools**.
```

This notation is useful for abbreviating a longer phrase like _In the
**File** menu, select **Open**._ However, this notation applies only to
menu items. Don't use it to describe a combination of different UI elements.

Recommended: Select
**MyApp > Preferences**, and then select the
**Languages** preference pane.

Not recommended:
Select **MyApp** > **Preferences** > **Languages** >
**+** > **CSS**.

### Navigation menu

A _navigation menu_ is a control—usually a pane or window—that contains a list of items
that the user can click to go to pages in an application or website. Don't use the terms
_navigation bar_, _navigation pane_, _navigation panel_, or
_navigation window_ for such a control.

Recommended:
In the BigQuery navigation menu, click **Scheduled queries**.

### Toolbar

A _toolbar_ is a set of buttons for common user actions. A toolbar
button that includes a menu is called a _menu button_. Refer to the
toolbar by name if you think that the user needs help finding a button.

Recommended:
On the Google Cloud console toolbar, click
**Notifications**.

Recommended: Click
**Notifications**.

### Buttons and icons

A _button_ initiates an action when clicked (or tapped, in the case
of a touchscreen). To refer to a button, use the button's label.

Recommended: Click **OK**.

Not recommended: Click the "OK"
button.

An icon is a symbol or image that represents an object or a function. An icon
can be a button as well. If the button includes an icon, write the name of the
button as shown in the tooltip, and add the button icon before the
name. If you need to use a space between the icon and the name for readability,
use a nonbreaking space.

Recommended: Click
**Settings and utilities**.

Not recommended: Click
.

If the icon tooltip is identical to the name of the icon, use an
[empty `alt` attribute](/style/images#alt-text).

If you're unsure of the name of the icon, inspect the element using browser
tools. In many cases, a visual element like an icon has an ARIA attribute
that provides a textual description of the element for use by screen readers.
To inspect an element, right-click the element and select
**Inspect** or **Inspect element**, depending on your browser. Look for one of the following
types of labels: `aria-labelledby`, `aria-label`,
`aria-describedby`, `label`, `placeholder`, or `title`.
For more information, see
[Using aria-label](https://www.w3.org/TR/WCAG20-TECHS/ARIA14.html)
and
[Accessible Name and Description calculation](https://www.w3.org/TR/html-aapi/#accessible-name-and-description-calculation).

If a button with an icon doesn't include a tooltip, submit a bug report
requesting that a tooltip be added. Tooltips are crucial for accessibility, and
for documentation and discoverability in general.

Recommended: Click **Add**.

Not recommended: Click the icon.

If a UI element name ends with an ellipsis (...), leave out the ellipsis.

Recommended: Click **Browse**.

Not recommended: Click
**Browse ...**.

Don't use directional language to orient the reader, such as _above_,
_below_, or _right-hand side_. Phrases like those don't work well for
accessibility or for localization. If a UI element is hard to find, provide a
screenshot.

Recommended: Click **Menu**.

Not recommended: In the left-side panel,
click the button with three lines.

#### Difficult-to-find UI elements

If you have UI elements that are difficult to find, consider one of the following options
as an alternative to using directional language, which can be problematic for
accessibility and localization reasons.

- Use the button icon along with its name as shown in the button tooltip.

  Recommended: Click
  **Refresh**.

- Add context to help the user find the element.

  Recommended: On the Cloud Run toolbar, click
  **Refresh**.

- Use a screenshot.

  Recommended: In the list of services, click
  **Column display options**.

  For more information about when and how to use screenshots, see
  [Diagrams, figures, and other images](/style/images).

### Tab

A _tab_ is a navigation element that looks like a file tab. To refer
to a tab, use the form _the **LABEL\_NAME** tab_.

Recommended: Select
**Tools > Options**, and then click the **Edit**
tab.

### Text box

A _text box_ is a box that the user can type in. Use
_box_ and the form _the **LABEL\_NAME** box_. Format the text
that the user types by using the `code` element in HTML, or by using code
formatting (monospace) in other markup.

Recommended: In the **Owner** box,
enter your name.

Recommended: In the **Name** box,
enter `wsfc-1`.

In Google Cloud, use
_field_ instead of _box_.

In Google Workspace documentation, use
_field_ instead of _box_.

Recommended: In the **Instance** field,
specify a value less than 64 characters long.

### List box, combo box, and spin box

A _list box_ is a box that offers the user a list of items. To refer to a list box, use
the form _the **LABEL\_NAME** list_ or
_the **LABEL\_NAME** box_, whichever is clearer.

Recommended: In the **Item** list, select
**Desktop**.

A _combo box_ is a combination of a text box and a list box. To
refer to a combo box, use the form _the **LABEL\_NAME** box_. To refer to
entering a value into a combo box, use the verbs _type or select_ or _enter_.

Recommended: In the **Font** box, type
or select the font that you want to use.

A _spin box_ is a box that lets the user choose a value by clicking
arrows or by typing. To refer to a spin box, use the form _the
**LABEL\_NAME** box_. To refer to entering a value into a spin
box, use the verb _enter_.

Recommended: In the **Font Size** box,
enter a font size.

### Checkbox

A _checkbox_ is a small box that indicates whether an option is
on or off. To refer to a checkbox, use the form _the
**LABEL\_NAME** checkbox_.

Be wary of using the verbs _check_ and _uncheck_, which can be ambiguous; it's often
best to use _select_ and _clear_ instead.

Recommended: Select the **Automatically
check for updates** checkbox.

Recommended: Clear the
**Bookmarks** checkbox.

If you need to refer to the state of the checkbox, it's often best to refer to it as
_selected_ or _not selected_.

Recommended: Make sure that the
**Bookmarks** checkbox is selected.

Recommended: Make sure that the
**Bookmarks** checkbox isn't selected.

### Radio button

A _radio button_ is a small button used to choose one item from a
group of mutually exclusive options. To refer to a radio button, use the radio
button's label, or refer to the group of buttons by its label.

Recommended: Select **Do not remember
passwords**.

Recommended: For **Startup mode**,
select an option.

### Expander arrow

An _expander arrow_ is the UI element used to expand or collapse a section of
navigation or content. Avoid referring to these explicitly in documentation, but when you do, use
the terms _expander arrow_ and _expandable section_ rather than terms like
_expando_ or _zippy_.

Recommended: To expand the
**Advanced options** section, click the
expander arrow.

Not recommended: To expand
the **Advanced options** section, click the zippy.

### Toggle

A _toggle_ is the UI element that switches back and forth between on and off
states. Don't use the word _toggle_ as a verb. Describe the action that you want the
user to take.

Recommended: To turn on the setting, click
the **Wi-Fi** toggle.

In some cases, you might not know what state the toggle is in before the user interacts with it
so be clear what position the toggle should be in.

Recommended: In **Settings**, click
the **Magic mode** toggle to the on position.

## Press and type keyboard keys

To indicate that the user should press a given keyboard key or
combination, use the `kbd` element.

The following is an example of a `<kbd>` tag:

Recommended:
`Press <kbd>Control+C</kbd>.`

When rendered, the text appears as follows:

Recommended: Press `Control+C`.

If you're working with non-HTML markup, use monospace formatting, which is how the
`kbd` element renders.

To refer to a letter key, use uppercase instead of lowercase.

Recommended: To save, press
`Control+S`.

Not recommended: To save, press
`Control+s`.

To refer to a key that the user types to enter that key's value as text input,
use the `code` element, not the `kbd` element.
For more information, see [Code font](/style/text-formatting#code-font).

To refer to a keyboard key, use the key's name. If that's ambiguous, use the
form _the `KEY_NAME` key_.

Recommended: Press `Esc`.

Recommended: Press the `Esc` key.

Spell out the names of modifier keys such as Command, Control, Option, and
Shift. Don't use symbols for those keys. To refer to a key combination, use the
form _`MODIFIER+KEY_NAME`_.

Recommended: Press
`Control+V`.

When you provide shortcuts for multiple operating systems, put the macOS shortcut in
parentheses after the Windows and Linux shortcut.

Recommended: To copy, press
`Control+C` (or `Command+C` on macOS).

Not recommended: To copy, press
`Ctrl+C` (`⌘+C`).

To refer to a key or combination that uses the Shift key, use the form
_`MODIFIER+Shift+KEY_NAME`_.

Recommended: Press
`Control+Shift+?`.

Spell out the names of characters that could be confusing in a keyboard
shortcut, such as comma, hyphen, period, and plus.

To refer to a keyboard shortcut, use either _keyboard shortcut_ or _key
combination_.

To refer to pressing a key or combination to cause an action to occur, use
the verb _press_. To refer to typing a key or combination as part of text, use
the verbs _enter_ or _type_.

## Prepositions

When documenting the UI, use the following prepositions.

| Preposition | UI element                               | Recommended                                                                                                                                                                                                                                     |
| ----------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| in          | dialogs fields lists menus panes windows | In the **Alert** dialog, click **OK**. In the **Name** field, enter `wsfc-1`. In the **Item** list, select **Desktop**. In the **File** menu, click **Tools**. In the **Metrics** pane, click **New**. In the **Task** window, click **Start**. |
| on          | pages tabs toolbars                      | On the **Create an instance** page, click **Add**. On the **Edit** tab, click **Save**. On the **Dashboard** toolbar, click **Edit**.                                                                                                           |

## Verbs in procedures

To describe an action on the page, use the following verbs. For more
information about each verb, see its corresponding entry on the
[word list](/style/word-list).

- [Click](/style/word-list#click)
- [Choose](/style/word-list#choose)
- [Drag](/style/word-list#drag)
- [Enable](/style/word-list#enable)
- [Enter, type](/style/word-list#enter)
- Go to (see [scroll](/style/word-list#scroll))
- [Hold the pointer over](/style/word-list#hold-the-pointer-over)
- [Press](/style/word-list#press)
- [Select](/style/word-list#select)
- [Tap](/style/word-list#tap)
- [Turn on, turn off](/style/word-list#turn-on)

For information about writing procedures, see [Procedures](/style/procedures).
