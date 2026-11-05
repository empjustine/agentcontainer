# docs/docs — how to write documentation (vendored references)

This folder is **third-party reference text, vendored**, not a decision record and
not part of the spec graph: nothing here carries `id`/`type` frontmatter, so the
graph tools see plain notes (the same standing as
`llm-local-inference/model-cards/*.md`, docs/spec-graph-standard.md). It exists
because four style authorities are worth having offline and greppable, and one of
them is not published as Markdown anywhere.

| folder                 | source                                                                                                                                                               | form                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `google-style/`        | [Google developer documentation style guide](https://developers.google.com/style)                                                                                    | 70 files: 69 pages + index, **clipped from HTML** (no Markdown upstream)                             |
| `google-tech-writing/` | [Technical Writing One](https://developers.google.com/tech-writing/one) / [Two](https://developers.google.com/tech-writing/two)                                      | 29 files: the two courses plus the shared `/tech-writing` sections that link them, clipped from HTML |
| `microsoft-style/`     | [MicrosoftDocs/microsoft-style-guide](https://github.com/MicrosoftDocs/microsoft-style-guide) → [live guide](https://learn.microsoft.com/en-us/style-guide/welcome/) | 950 files: the upstream `styleguide/` tree **verbatim** (authored in Markdown, media dropped)        |

Clipped from commit `c6945c32294e845a84b192a094fb1b7c2c452a6a` of the Microsoft
repo, and from the live Google pages on **2026-11-05**; `./refresh.sh` re-does
both, `./refresh.sh <set>` does one.

## Licensing — this folder is NOT AGPL

The repository's own license (AGPL-3.0, see `/LICENSE`) does **not** cover these
files. Both sources are published under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):

- **Google style guide + Technical Writing courses** — "Except as otherwise
  noted, the content of this page is licensed under the Creative Commons
  Attribution 4.0 License." © Google, from `developers.google.com/style` and
  `developers.google.com/tech-writing`. _Changes made:_ rendered HTML converted
  to Markdown, navigation/breadcrumbs/feedback chrome removed, one file per page,
  with the source URL and clip date in a comment at the top of each file.
- **Microsoft Writing Style Guide** — CC BY 4.0; the upstream `LICENSE` is
  copied beside the text at `microsoft-style/LICENSE`. © Microsoft Corporation.
  _Changes made:_ the `styleguide/` tree copied as-is
  minus non-Markdown assets (`media/` images are not vendored, so image links in
  the copy are dead; the live site renders them), then oxfmt-canonicalised — see
  Formatting below.

## Why one is clipped and the other copied

- The Microsoft guide is _authored_ in Markdown — copying the source tree is
  lossless, so a scrape would be strictly worse.
- Google's guide has no Markdown upstream: the page is rendered HTML, so the clip
  is the product of a converter and the only way to get it offline.
- `refresh.sh` documents the page discovery instead of pinning a URL list: it
  reads `/style/` and `/tech-writing/*` links from the index pages, so a new
  page upstream is picked up and a removed one surfaces as a loud `MISS` rather
  than as a silently stale file.

## Staleness

Nothing gates this folder's content. The QA sweep's freshness gate (docs/d122) watches
committed _data caches_ whose staleness changes generated artifacts; a style
guide going stale is a reading problem, not a build problem, and a gate on
third-party prose would go red for reasons nobody in this repo can fix. Re-run
`./refresh.sh` when you want current text, then update the date and upstream sha
in this file.

## Formatting

This folder is formatted like every other markdown file in the tree: oxfmt owns
the canonical shape and `./lint.sh` gates it. One one-shot reformat took the
whole repository there, vendored text included — no folder is exempt, because a
formatter with a hiding place is a formatter whose gate means nothing.
`refresh.sh` therefore re-formats whatever it writes, so a re-clip shows the
upstream change instead of a formatting diff on top of it. The version it
formats with has to match `lint.sh`'s pin, and both files say so.
