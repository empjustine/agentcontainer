---
id: d204
type: architecture-design
status: draft
title: "d204 — the Firefox history and favourites slurp extension: full Promnesia coverage, eventual consistency, and tombstones from sync"
parent: architecture
depends-on: [d172, d173, d178]
references: [d174, d176, d177, d181, d184, d205, datalakehouse, personal-datalakehouse-prior-art]
tags:
  [
    "firefox-extension",
    "browsing-history",
    "bookmarks",
    "requirements",
    "eventual-consistency",
    "batching",
    "tombstones",
    "datalakehouse",
  ]
---

# d204 — the Firefox history and favourites slurp extension

This record turns the Firefox extension named by d172 into a requirements register for full history and bookmark slurping at Promnesia's coverage, streamed in an eventually consistent, adaptive batch flow. It covers the live-history, backfill, and bookmark streams, the oldest-first order, the 5-second lock budget, the tombstone boundary, and the dedicated daemon. It excludes current-page content, which belongs to the hister-side extension. The reader is whoever specifies or builds the extension. The settled part is the stream shape and the daemon boundary; the open part is the Firefox Sync deletion surface and the retention policy.

## Status

Draft — a requirements register. The user decisions below are recorded; no extension or daemon exists.

## Coverage

The target is the set of facts `karlicoss/promnesia` would collect from the browser: every visit in local history and every bookmark, with the titles and folder context the browser exposes. Current-page content is not part of this producer. The hister-side extension owns the page snapshot and posts it to the hister API of d205; this extension never injects a content script and never reads the DOM.

The extension reads no profile file, so it works with Flatpak Firefox and the SELinux boundary d172 removes. It sends raw URLs; the daemon canonicalizes with the vendored `cannon`.

## The streams

| stream           | Firefox source                           | unit         | identity candidate                       | payload                                                                        |
| ---------------- | ---------------------------------------- | ------------ | ---------------------------------------- | ------------------------------------------------------------------------------ |
| live history     | `history.onVisited`                      | one visit    | `visitId` (verify) or `(url, visitTime)` | url, visit time, transition, referring visit, title when known                 |
| history backfill | `history.search` plus `getVisits`        | one visit    | the same pair                            | the same fields, read oldest-first from a checkpoint                           |
| bookmarks        | `bookmarks.getTree` plus bookmark events | one bookmark | bookmark id                              | url, title, folder path, position, date added, type, tags/keyword when present |

Each stream has its own cursor and checkpoint. The streams are independently resumable; the daemon must not assume a cross-stream order. The history backfill runs oldest to newest because the oldest entries are the ones a browser retention rule is most likely to prune first. Bookmarks are read in `dateAdded` order, then folder order, oldest to newest.

## Settled requirements

These are binding, either from d172 or from the user decisions recorded here:

- full local history and every bookmark, including bookmark folder context, not a selected folder;
- no current-page content, no content script, and no DOM access;
- eventual consistency over a global snapshot; no single massive cursor and no all-history request;
- adaptive batches that target a soft 5-second ceiling per side, never a fixed batch that can lock the browser or the daemon;
- oldest-first backfill for history and bookmarks;
- private-window history is out of scope: Firefox does not preserve it, so the extension has nothing useful to send;
- MVP is Firefox only; Chromium and Edge follow later;
- supported Firefox is the current stable channel and the current most-recent ESR;
- Firefox Sync history is in scope only when it is present in the local history store; the extension does not talk to the Sync service;
- the daemon is a dedicated browsing daemon, not the d181 session route; it exposes a Promnesia/hister/custom-slurper shaped API;
- static-key authentication is available but disabled by default;
- the stock Promnesia extension and the hister extension are both consumers of the daemon; this extension is a producer only, and the hister extension is the separate current-page content producer.

## Functional requirements

| id        | requirement                                                                                                          | status   |
| --------- | -------------------------------------------------------------------------------------------------------------------- | -------- |
| SLURP-R1  | Capture every live visit with the URL, visit time, transition, referring visit, and title when available.            | settled  |
| SLURP-R2  | Backfill all local history through `history.search` and `getVisits`, oldest first, from a durable checkpoint.        | settled  |
| SLURP-R3  | Snapshot every bookmark and subscribe to create, change, move, and remove events; preserve folder path and position. | settled  |
| SLURP-R4  | POST batches to the dedicated daemon; treat the daemon's accepted/duplicate response as the ack.                     | settled  |
| SLURP-R5  | Key every row on the stream's natural identity; never key on a file path or a tab id.                                | settled  |
| SLURP-R6  | Send raw URLs; canonicalize only in the daemon.                                                                      | settled  |
| SLURP-R7  | Exclude private windows and send nothing from them.                                                                  | settled  |
| SLURP-R8  | Keep a bounded local queue when the daemon is down; resume from the last ack, not from the start.                    | settled  |
| SLURP-R9  | Carry a checkpoint per stream and write it only after the daemon acks the batch.                                     | settled  |
| SLURP-R10 | Report per-stream counts, the last checkpoint, the last error, and the daemon version.                               | proposed |
| SLURP-R11 | Carry an extension/schema version in every batch so the daemon can reject or migrate an old producer.                | proposed |
| SLURP-R12 | Support static-key authentication when the operator enables it; default to no key on loopback.                       | settled  |
| SLURP-R13 | Support the current stable Firefox and the current most-recent ESR from one build.                                   | settled  |

## Adaptive batching and the 5-second budget

The producer and the daemon both have a soft ceiling: the target is that no browser API call and no daemon transaction is held for more than five seconds. The rule is a target, not a guarantee — one oversized row can exceed it — so the implementation must bound the work at the row boundary and expose when the bound was missed.

The batch shape:

- **History backfill** — a time window plus a result page. `history.search` returns a bounded page; `getVisits` fills the visit detail for that page. The window advances only after the whole page is acked. A page that takes longer than the budget is halved on the next call; a page that finishes well under it grows.
- **Live history** — the event is one visit, so the batch is an accumulation by count and bytes, flushed on a timer or when the byte cap is reached.
- **Bookmarks** — the tree is walked in folder slices, not one `getTree` result. Each slice is a batch; a large folder is split by child count.
- **Daemon** — one transaction per batch, one ack per transaction. The daemon returns `{accepted, duplicates, checkpoint?}`; a non-2xx leaves the batch queued.

The starting size is deliberately small and grows while the observed duration stays under the ceiling. A timeout halves the size and records the event. The byte cap is separate from the count cap because one bookmark or one visit can be much larger than the median. The queue and the checkpoint are durable across a Manifest V3 background suspension; a periodic `alarms` wake retries.

## Deletions and tombstones

A local history deletion is not a reliable signal: the extension can observe its own absence or a browser removal event, but it cannot distinguish "deleted" from "never seen" after the fact. The design therefore does not synthesize history tombstones from absence.

The tombstone sources are narrower:

- **Bookmarks** — `bookmarks.onRemoved` is an observable event. A removed bookmark is sent as a tombstone carrying its bookmark id, the parent folder, and the removal time. A bookmark deletion does not erase the visit history or the document.
- **History from Firefox Sync** — the Sync service is the component that propagates a deletion across devices. If the local Firefox API exposes a sync-origin removal event, the extension forwards it as a tombstone. If it does not, the backend keeps the visit: an append-only archive is preferable to guessing a deletion.
- **Best-effort local removal** — if `history.onVisitRemoved` fires, the extension may forward it as a best-effort tombstone, but no requirement depends on it and a missing event is not an error.

A tombstone carries `(kind, key, deleted_at, source)`, with `source` naming `bookmark`, `sync`, or `local`. The daemon must apply tombstones idempotently and must not let a tombstone delete a different visit with the same URL. The exact key is the same natural key as the row it deletes.

## The daemon boundary

The daemon is not d181. d181 is the session ingest route, with a session-shaped spool and a session-shaped dedupe key; the browsing stream has visits, bookmarks, tombstones, and content documents. The browsing daemon is the d205 backend's ingest edge:

- **Ingest face** — a custom slurper verb for visits, bookmarks, and tombstones; the hister-shaped `/api/add` and related endpoints for the hister-side extension's content posts.
- **Read faces** — the Promnesia protocol for the stock sidebar and the hister API for the hister extension. The extension uses only the ingest face; it does not read back.
- **Auth** — static keys are possible and disabled by default. A key is a shared secret in the extension's background storage and the daemon's environment; the daemon binds loopback when no key is set.
- **Idempotence** — the daemon's `(src, kind, key)` key absorbs a re-sent batch. A re-post after a crash is not a duplicate row.

The extension's endpoint is loopback HTTP. A daemon bound to `0.0.0.0` exposes the token and the history to the LAN; the bind address must be loopback or the static key must be treated as a network secret. The extension needs a host permission for the loopback origin, and the key belongs in the background context, never in a page.

## Firefox Sync and versions

Firefox Sync writes other devices' history and bookmarks into the same local stores. The extension treats what is locally visible as local history; it does not call the Sync service and does not invent a device identity. A synced visit is a visit; a synced bookmark is a bookmark. The deletion case is the one that needs the sync-origin event, because a remote deletion is otherwise indistinguishable from a local absence.

The supported versions are the current stable Firefox and the current most-recent ESR. The extension build targets both from one manifest; a feature that only exists in one channel is optional and the capture falls back to the older API. Chromium and Edge are a later port, not a second code path in the MVP.

## Permissions and packaging

| permission                     | why                                                     |
| ------------------------------ | ------------------------------------------------------- |
| `history`                      | live visits, backfill, title changes, removals          |
| `bookmarks`                    | tree snapshot and bookmark events                       |
| `storage`                      | checkpoint, queue, settings, optional static key        |
| `alarms`                       | periodic backfill and retry after background suspension |
| host permission for the daemon | `fetch` to the loopback origin                          |

The extension does not need `tabs`, `webNavigation`, `scripting`, or `activeTab` because it does not capture the current page. The install path is a temporary add-on through `about:debugging` for development, a signed XPI through AMO for a permanent install, or an enterprise `policies.json` for a managed profile. Flatpak Firefox installs the XPI into its own profile; the extension still reaches the host daemon over loopback.

## Privacy and security

History and bookmarks are sensitive even without page content. The extension is the first collector:

- private windows excluded;
- query strings redacted or hashed before storage if they can carry tokens;
- no capture from `file://`, `about:`, extension pages, or authentication flows;
- the static key kept in the background context and never injected into a page;
- the local queue bounded and cleared on uninstall;
- a visible first-run consent screen that states the history and bookmark streams leave the browser.

d173's Datensparsamkeit is the storage rule for this data. The extension sends the facts Promnesia needs; it does not send page content.

## User input required

The remaining decisions are narrow:

1. Does the local Firefox API expose Firefox Sync's deletion events, and is that the only tombstone source the user wants? If it does not, the archive keeps deleted history.
2. Is a best-effort `history.onVisitRemoved` tombstone forwarded, or is the Sync-origin event the only history deletion signal?
3. What retention applies to history and bookmark rows in the warehouse, and does a tombstone delete the row or only mark it?
4. How is the optional static key distributed when the operator enables it — options page, build-time injection, or a host-written config?

## Research needed

- Verify whether Firefox exposes a sync-origin history deletion event, and what `history.onVisitRemoved` carries.
- Verify `visitId` stability and uniqueness across restart, profile export, and Firefox Sync.
- Measure `history.search` and `getVisits` throughput on a real profile and tune the time window and page size.
- Verify bookmark event payloads, folder ordering, and the cost of walking a large tree in slices.
- Verify Manifest V3 background lifetime and `alarms` behavior in both stable and ESR.
- Verify loopback `fetch` host permissions and CORS from a Firefox extension origin.
- Verify Flatpak Firefox XPI installation.
- Verify the stable-versus-ESR API surface for `history` and `bookmarks`.
- Verify that Firefox Sync history is visible in the local history store the extension reads.

## Alternatives rejected

- **Current-page content in this extension.** It is the hister-side extension's job; adding it here doubles the permissions and the privacy surface.
- **Reuse the d181 session route.** The session route is write-only, session-shaped, and spool-shaped; the browsing stream needs visits, bookmarks, tombstones, and content documents.
- **Read `places.sqlite` directly.** It reintroduces the Flatpak/SELinux boundary and the live-WAL race d172 removes.
- **One global cursor or one massive batch.** It locks a side, loses progress on a crash, and cannot resume oldest-first.
- **Infer history deletions from absence.** The extension cannot tell a deletion from a page it has not reached; an append-only archive is safer.
- **Chromium first.** The MVP is Firefox; a second browser is a port after the Firefox flow is measured.

## Where this lands

The daemon and the store are d205. The storage tiers are d173 and the cold search is d177. The unit that would own the daemon is [`datalakehouse/`](../datalakehouse/README.md); the browsing source extends that unit rather than opening a third storage path.
