---
id: sbex-pages-and-islands
type: submodule-design
status: draft
title: "sbex pages and islands: document-centric delivery on the servlet stack"
parent: sbex
references: [sbex-servlet-vs-reactive, sbex-resource-isolation, sbex-optimisation-findings]
tags: ["html", "mpa", "islands", "htmx", "progressive-enhancement", "browser-support"]
---

# Pages and islands: document-centric delivery on the servlet stack

This note owns the choice between an HTTP page and a client-side application, and the browser support that makes the page competitive again: server-rendered HTML, plain links and forms, and interactive islands mounted where state actually lives. No page exists in this tree — both applications serve JSON and one CSV report — so this is the requirement a first page would meet, not a description of code. It does not cover the stack choice ([sbex-servlet-vs-reactive](servlet-vs-reactive.md)), admission control ([sbex-resource-isolation](resource-isolation.md)), or the per-row allocation a render inherits ([sbex-optimisation-findings](optimisation-findings.md)). The reader is an engineer choosing what one screen is, and arrives knowing the servlet application's shape.

## Status

Draft. The delivery-unit rule is a design position; the versions under "Browser support for the primitives" were read from MDN browser-compat-data.

## The delivery-unit rule

The delivery unit is chosen per page from its interaction profile, not per product from its framework.

| Unit        | Interaction profile                                                                           | Examples                                  |
| ----------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| HTTP page   | a document: read-mostly, forms over data, CRUD, admin panels; the URL is the state            | content pages, dashboards, internal tools |
| Application | a state machine: long-lived local state, offline work, optimistic UI, rich wizards            | editors, spreadsheets, chat               |
| Mixed       | one product, several units: a document surface, one isolated application surface, plain pages | most internal suites                      |

An SPA pays for client routing, hydration, a state manager, a bundle budget, and a second copy of the view logic that the API also holds. A form over a table pays for none of that, because the back button, deep links and form submission are the browser's. The defect is rarely a wrong framework; it is a delivery unit chosen before the interaction profile was read.

## Browser support for the primitives

| Primitive                                                                 | Chrome | Firefox | Safari | Note                                                                                    |
| ------------------------------------------------------------------------- | ------ | ------- | ------ | --------------------------------------------------------------------------------------- |
| Same-document view transitions (`document.startViewTransition`)           | 111    | 144     | 18     | shipped in all three engines                                                            |
| Cross-document transitions (`@view-transition`, `pagereveal`, `pageswap`) | 126    | preview | 18.2   | the one gap: Firefox ships it in preview builds only, so a page must survive without it |
| `popover`                                                                 | 114    | 125     | 17     | replaces most custom dropdown, tooltip and menu script                                  |
| `<dialog>`                                                                | 37     | 98      | 15.4   | modal semantics, focus trap and Escape come with the element                            |
| `<details>`                                                               | 12     | 49      | 6      | disclosure without script                                                               |
| `<details name>` (exclusive accordion)                                    | 120    | 130     | 17.2   | one open panel at a time, enforced by the element                                       |
| Native form validation                                                    | 4      | 4       | 5      | constraint attributes and `:valid`/`:invalid` cover the common case                     |
| Scroll-driven animations (`animation-timeline`)                           | 115    | 159     | 26     | Firefox has not shipped it; it cannot be the reason a page drops scripting              |

Two rules follow. A page can rely on `popover`, `<dialog>`, `<details>` and native validation, because the oldest engine in the table is years past. Cross-document transitions and scroll-driven animation are enhancements: they must degrade to a normal navigation and a normal scroll, because one engine still lacks each.

## Progressive enhancement

- Render HTML on the server, per request. The server owns the view; the URL is the state; `GET` reads and `POST`/`PUT`/`DELETE` writes end in a redirect (redirect-after-post is what keeps refresh from resubmitting).
- The page must work with scripting disabled and before the script loads. Interactivity is layered on server-rendered markup and is never load-bearing.
- Ship interactive components as islands on specific DOM nodes, with explicit hydration triggers. Astro's directives are the worked example — `client:load`, `client:visible`, `client:idle`, `client:only`, `client:media` — and Astro's own claim is zero JavaScript by default, so the default is the discipline.
- For a dynamic fragment without a reload, swap server-rendered HTML into the DOM: htmx, Unpoly and Turbo all do this, and the server stays the only renderer.
- Do not build a JSON API speculatively. While HTML is the only consumer, HTML is the API; a JSON API arrives with a second consumer, before that consumer binds to markup.

## The costs

- **Markup and endpoint couple.** A fragment swap names an endpoint that returns markup; renaming one renames the other. The mitigation is a server-side partial layer with one owner, not a client router that hides the coupling.
- **State moves to the server.** Sessions and rows replace component state. Optimistic and offline flows are genuinely harder, which is the same sentence as "those flows are the application case".
- **Team familiarity is a real cost.** Templates and HTTP semantics are older than the frameworks that replaced them, not simpler to a team that never used them.
- **Mixed units share plumbing.** One product with a page surface and an application surface must settle session/cookie auth, the design system, and per-unit CI deliberately, or each one is decided by accident.

## Where a page would live in this unit

The servlet application is the host: Tomcat plus virtual threads renders a page the way it renders the streaming report, and the reactive application stays API-only because a template render is blocking work on an event loop. A page adds a controller returning a view name, a template engine (Thymeleaf is the common choice and a new starter dependency), and nothing to the core or the schema. The render's per-row cost is [sbex-optimisation-findings](optimisation-findings.md)' subject: a template loop over a million rows pays a formatter per row exactly as the CSV writer does.

The existing JSON controllers stay as they are: a page over the order API reads the same service, and the API keeps serving anything that is not a browser.

## References

- MDN browser-compat-data: [view transitions](https://github.com/mdn/browser-compat-data/blob/main/css/at-rules/view-transition.json), [`popover`](https://github.com/mdn/browser-compat-data/blob/main/html/global_attributes.json), [`<dialog>`](https://github.com/mdn/browser-compat-data/blob/main/html/elements/dialog.json), [`<details>`](https://github.com/mdn/browser-compat-data/blob/main/html/elements/details.json), [`animation-timeline`](https://github.com/mdn/browser-compat-data/blob/main/css/properties/animation-timeline.json)
- Astro: [template directives](https://docs.astro.build/en/reference/directives-reference/), [why Astro](https://docs.astro.build/en/concepts/why-astro/)
- Fragment libraries: [htmx](https://htmx.org/), [Unpoly](https://unpoly.com/), [Turbo](https://turbo.hotwired.dev/)
- Spring: [view rendering in Spring MVC](https://docs.spring.io/spring-framework/reference/7.0/web/webmvc-view.html)
