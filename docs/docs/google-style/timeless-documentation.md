<!-- source: https://developers.google.com/style/timeless-documentation -->
<!-- clipped: 2026-11-05 -->

# Timeless documentation

## Page Summary

- Timeless documentation avoids time-sensitive language to ensure accuracy and longevity, focusing on the current state of the product.
- It's crucial for technical documents as words like "now" or "new" can quickly become outdated, hindering comprehension.
- While acceptable in time-sensitive content like blog posts, these terms should be avoided in product documentation to reduce maintenance and prevent assumptions about prior product knowledge.
- Timeless documentation benefits users by providing clear and current information without relying on past or future context.
- To achieve timelessness, avoid phrases like "currently," "new," or "latest" when describing product features and capabilities, instead focusing on factual and enduring descriptions.

Timeless documentation is documentation that avoids words and phrases that anchor the
documentation to a point in time or assume knowledge of prior or future products and features. In
general, document the current version of a product or feature.

Timeless documentation is especially important for technical documents that might be read a long
time after they are written. Words like _now_, _new_, and _currently_ can render
such documentation inaccurate, outdated, or unmeaningful. In contrast, timeless documentation
focuses on how the product works right now—not on how it has changed from previous versions,
and not how it might change in the future.

| Recommended                                                  | Not recommended                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| These subcommands let you interact with HTTP load balancing. | These new subcommands let you interact with HTTP load balancing. |
| The following command-line options aren't supported:         | The following command-line options aren't currently supported:   |
| The emulator supports the following filters:                 | The emulator now supports the following filters:                 |

If you're writing procedural or time-stamped content such as press releases, blog posts, or
release notes, such time-based words and phrases are okay. For example, _new_ is okay in a blog
post that announces updates to a product: _Dataflow includes several new features._ Or,
_soon_ is okay in procedural content to emphasize a change in state after a user performs a
step: _The VM goes offline soon after you send the shutdown command._ However, some of these
words can become outdated or incorrect when used in product documentation to refer to a product's
features and capabilities, so we recommend against using such words in that context.

Writing timeless product documentation has the following value:

- It reduces the maintenance required to keep documentation up to date.
- It avoids assuming the reader is familiar with earlier versions of the product.

## Words and phrases to avoid

The following words and phrases can undermine timelessness in documentation:

- **Words and phrases that make promises or project plans and
  strategies**. In the context of describing product or feature capabilities, words and phrases such
  as _at present_, _as of this writing_, or _eventually_ can prematurely disclose plans
  for a product or feature, or they can inappropriately imply that a product or feature might change.
  In those cases, don't use such words and phrases.

  For more information, see [Documenting future features](/style/future).

- **Words and phrases that are implied**. At Google, we assume our documentation is
  current unless a specific release version is specified. Thus, words and phrases such as
  _currently_ and _as of this writing_ are implied by the existence of the documentation
  itself.
- **Words and phrases that become outdated soon after publication**. Words such as _soon_
  and _latest_ quickly become irrelevant.
- **Words and phrases that assume prior knowledge of a product or feature**. If you must use
  words like _new_, give a reference point such as a date or version release number—for
  example, _The January 14, 2021 release of BigQuery includes a new resource panel._

When describing product or feature capabilities in product and reference documentation, avoid
the following words and phrases:

- as of this writing
- currently
- does not yet
- eventually
- existing
- future, in the future
- latest
- new, newer
- now
- old, older
- presently, at present
- soon
