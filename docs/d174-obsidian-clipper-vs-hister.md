---
id: d174
type: architecture-design
status: active
title: "d174 — obsidian-clipper against hister: adjacent capture tools, and what a clipper note can reconstruct"
parent: architecture
references: [d172, d173, d176, personal-datalakehouse-prior-art]
tags:
  [
    "obsidian-clipper",
    "hister",
    "defuddle",
    "readability",
    "content-store",
    "markdown",
    "reconstruction",
    "prior-art",
  ]
---

# d174 — obsidian-clipper against hister

This record compares `obsidianmd/obsidian-clipper` with `asciimoo/hister` and
answers whether a clipper entry can reconstruct a page. It covers the two data
models, their overlap, the bridges between them, and the reconstruction limit of
each template variable. The reader is whoever chooses between a curated Markdown
archive and an automatic full-text index, and whoever wants one to feed the
other. The finding is that the tools are adjacent rather than competing: the
clipper is curation, hister is recall, and the only true overlap is that both
extract page content and key on the URL.

## Status

Reference comparison; no implementation action. Both tools were read at
`obsidian-clipper` v1.7.1 (`6d56d618`) and `hister` `3414902b`.

## What each stores

Clipper writes Obsidian Markdown notes on demand. The default template is
`noteContentFormat: '{{content}}'` with frontmatter `title`, `source`,
`author`, `published`, `created`, `description` and `tags`
(`src/managers/template-manager.ts`). `{{content}}` is Defuddle's readability
extraction converted to Markdown (`src/api.ts:192`); the variable set also
exposes `{{contentHtml}}`, `{{fullHtml}}`, `schemaOrgData`, `metaTags`
and `extractedContent` (`src/utils/shared.ts`). The note reaches the vault through
the `obsidian://new` URI, under a create, append, prepend, overwrite or daily
behaviour (`src/utils/obsidian-note-creator.ts`).

Hister keeps one searchable document per normalized URL, owner-scoped, carrying
`URL`, `HTML`, `Text`, `Title`, `Favicon`, `Language` and `AddCount`
(`server/document/document.go`). The extension submits
`document.documentElement.innerHTML`, the live DOM after JavaScript ran
(`webui/ext/src/modules/extract.ts`). Storage splits into a Bleve index,
content-addressed HTML and favicon files, and a GORM database — SQLite or
PostgreSQL — for users, history, versions and jobs (`docs/data-lifecycle.md`).

## Overlap

| axis         | Clipper                                                      | Hister                            |
| ------------ | ------------------------------------------------------------ | --------------------------------- |
| trigger      | manual: click, shortcut, or template trigger                 | automatic per visit               |
| unit         | one note per clip                                            | one current document per URL      |
| extraction   | Defuddle, readability class                                  | live DOM, server-side Readability |
| primary form | Markdown plus YAML frontmatter                               | full HTML plus extracted text     |
| metadata     | author, published, description, schema.org, og and meta tags | title, favicon, language          |
| annotations  | highlights with XPath, offsets and notes                     | none; only `add_count`            |
| storage      | files in an Obsidian vault                                   | Bleve index plus a SQL database   |
| query        | Obsidian's, over the vault                                   | full-text and semantic index      |

The tools are adjacent, not competing. The overlap is the extraction step and the
URL key. The intent differs: the clipper records a page a human chose to keep,
with metadata and annotations; hister recalls every page automatically.

## Bridges

- **Clipper renders hister's HTML.** The CLI reads HTML from a file or stdin
  (`obsidian-clipper <url> --html <path> -t template.json -o out.md`,
  `src/cli.ts`), and the `./api` export is an environment-agnostic `clip()` that
  returns the note and its variables (`src/api.ts`). Hister's stored HTML can
  therefore become a Markdown note.
- **Hister indexes the clipper vault.** Hister watches directories and indexes
  `.md` files (`files/extract/markdown.go`, `docs/file-types.md`).
- **The identity gap.** Hister's Markdown handler renders the file and takes the
  title from the first `# H1`; it parses no frontmatter. A clipper note's
  `source`, `author` and `published` become body text, and the document URL is
  the `file://` path rather than the page URL.

## Page reconstruction from a clipper entry

The template variable decides how much of the page survives.

| variable                | reconstructable                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{content}}` (default) | the article as reader mode: text, headings, lists, blockquotes, code, links and remote images. No layout, CSS, scripts, page chrome, iframes, or content Defuddle excluded.                                                                                   |
| `{{contentHtml}}`       | the extracted subtree as HTML, with better inline structure and the same scope.                                                                                                                                                                               |
| `{{fullHtml}}`          | the whole rendered page as HTML, cleaned: the content script removes `<script>` and `<style>`, removes `style` attributes, absolutizes `src`, `href` and `srcset`, and flattens shadow DOM before serializing `documentElement.outerHTML` (`src/content.ts`). |

`{{fullHtml}}` is a near-complete reconstruction of the DOM as rendered at clip
time. Its gaps are the removed scripts and inline styles, resources not loaded
yet, and image bytes, which the source does not download; the Markdown keeps
remote image URLs. Highlights are a separate per-URL store,
`{xpath, content, startOffset, endOffset, textQuote, notes}`, so their passages
survive independently, and re-anchoring them needs the content HTML
(`src/utils/highlighter.ts`).

Hister is the stronger snapshot for this purpose, because it keeps the raw
`innerHTML` with scripts and inline styles. The clipper is the stronger
annotation store, with metadata and highlights the index does not carry.

## Where this lands

The clipper is a promnesia-shaped context source and hister is a content index,
which is the split [d172](d172-push-based-browsing-index.md) assumes; a clipper
vault is a second context source beside bookmarks. The storage tiers of
[d173](d173-browsing-history-storage-tiers.md) apply to both, because both keep
content that most queries never read. The wider personal-data landscape is
surveyed in [personal-datalakehouse-prior-art](personal-datalakehouse-prior-art.md).
