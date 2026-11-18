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

This record turns the Firefox extension named by d172 into a requirements register for full history and bookmark slurping at Promnesia's coverage, streamed in an eventually consistent, adaptive batch flow. It covers the live-history, backfill, and bookmark streams, the oldest-first order, the 5-second lock budget, the tombstone boundary, and the dedicated daemon. It excludes current-page content, which belongs to the hister-side extension. The reader is whoever specifies or builds the extension. The settled part is the stream shape, the daemon boundary, the browser's own deletion surface, and the retention of the browser's copy; what stays open belongs to the store (d205's archive retention, erasure execution and offsite copy).

## Status

Draft — a requirements register. The user decisions below are recorded, and the retention and scrub rules are settled in [Retention, the browser's copy](#retention-the-browsers-copy). The daemon half is built: `POST /ingest/slurp` on `datalakehouse/browse-daemon.py`, with the batch envelope, the record kinds and the `(src, kind, key)` dedupe specified in [`datalakehouse/README.md`](../datalakehouse/README.md). The producer is built in [`datalakehouse/firefox-extension/`](../datalakehouse/firefox-extension/README.md); its `wire.mjs` is the authority on the envelope and the daemon reads exactly those fields.

## Coverage

The target is the set of facts `karlicoss/promnesia` would collect from the browser: every visit in local history and every bookmark, with the titles and folder context the browser exposes. Current-page content is not part of this producer. The hister-side extension owns the page snapshot and posts it to the hister API of d205; this extension never injects a content script and never reads the DOM.

The extension reads no profile file, so it works with Flatpak Firefox and the SELinux boundary d172 removes. It sends raw URLs; the daemon canonicalizes with the vendored `cannon`.

## The streams

| stream           | Firefox source                                  | unit                   | identity candidate                                                     | payload                                                                                              |
| ---------------- | ----------------------------------------------- | ---------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| visit (live)     | `history.onVisited`                             | one visit              | `(url, lastVisitTime)` — the event carries a page guid, not a visit id | url, visit time, page guid, title                                                                    |
| visit (backfill) | `history.search` plus `getVisits`               | one visit              | the same pair                                                          | the same fields plus the transition and the local visit id, read oldest-first from a checkpoint      |
| title            | `history.onTitleChanged`                        | one page               | page guid                                                              | url, title, seen at                                                                                  |
| bookmarks        | `bookmarks.getTree` plus the bookmark events    | one bookmark or folder | node guid                                                              | url, title, parent guid, position, date added, node type; stored as context, never as a visited mark |
| tombstone        | `bookmarks.onRemoved`, `history.onVisitRemoved` | one removal            | node guid, page URL, or `*`                                            | kind, key, deleted time, source                                                                      |

Each stream has its own cursor and checkpoint. The streams are independently resumable; the daemon must not assume a cross-stream order. The history backfill runs oldest to newest because the oldest entries are the ones a browser retention rule is most likely to prune first. Bookmarks are read in `dateAdded` order, oldest to newest.

A bookmark's folder path is not a stored field: the facts are the parent guid and the position, and the path is a view the daemon derives from them, so a move costs one row rather than a subtree rewrite.

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

| id        | requirement                                                                                                                                                  | status  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| SLURP-R1  | Capture every live visit with the URL, visit time, page guid, and title; the transition follows from the backfill, because the live event does not carry it. | settled |
| SLURP-R2  | Backfill all local history through `history.search` and `getVisits`, oldest first, from a durable checkpoint.                                                | settled |
| SLURP-R3  | Snapshot every bookmark and folder, subscribe to create, change, move and remove, and preserve the parent guid, position and node type.                      | settled |
| SLURP-R4  | POST batches to the dedicated daemon; treat the daemon's accepted/duplicate response as the ack.                                                             | settled |
| SLURP-R5  | Key every row on the stream's natural identity; never key on a file path, a tab id, or a local row number.                                                   | settled |
| SLURP-R6  | Send raw URLs; canonicalize only in the daemon.                                                                                                              | settled |
| SLURP-R7  | Exclude private windows and send nothing from them.                                                                                                          | settled |
| SLURP-R8  | Keep a bounded local queue when the daemon is down; resume from the last ack, not from the start.                                                            | settled |
| SLURP-R9  | Carry a checkpoint per stream and write it only after the daemon acks the batch.                                                                             | settled |
| SLURP-R10 | Report per-stream counts, the last checkpoint, the last error, and the daemon version.                                                                       | settled |
| SLURP-R11 | Carry an extension/schema version in every batch so the daemon can reject or migrate an old producer.                                                        | settled |
| SLURP-R12 | Support static-key authentication when the operator enables it; default to no key on loopback.                                                               | settled |
| SLURP-R13 | Support the current stable Firefox and the current most-recent ESR from one build.                                                                           | settled |
| SLURP-R14 | Capture page-title changes keyed on the page guid, so a title learned later never invents a visit.                                                           | settled |
| SLURP-R15 | Drop queued visits and titles before bookmarks and removals when the queue reaches its ceiling.                                                              | settled |

## Adaptive batching and the 5-second budget

The producer and the daemon both have a soft ceiling: the target is that no browser API call and no daemon transaction is held for more than five seconds. The rule is a target, not a guarantee — one oversized row can exceed it — so the implementation must bound the work at the row boundary and expose when the bound was missed.

- **History backfill** — a time window plus a result page. `history.search` is newest-first and capped, so the producer always passes an explicit window and `maxResults`; a page that comes back full is halved and the cursor does not move, because such a page may hide its oldest rows. The window advances only after the whole page is acked.
- **Visit expansion** — `getVisits` has no time filter and returns a URL's whole timeline, so a page past `visit_cap` is sent from its own last visit as one coarse row, and the rest of that timeline stays with the live stream. Below the cap the expansion takes every visit at or before the window end, not only those inside the window: `history.search` selects a page by its LAST visit, so a page reached late is expanded for the first time with earlier visits whose own windows are already behind the cursor, and the row key makes the repeat harmless.
- **Live history** — the event is one visit, so the batch is an accumulation by count and bytes, flushed on a timer or when the byte cap is reached.
- **Bookmarks** — the snapshot is one `getTree` call, because Firefox's `getChildren` fetches the whole tree internally; a per-folder walk would bound the extension's payload, not the browser's work. The slice is on the write side: a sweep walks a bounded number of rows in chunks and keeps a durable resume point, so a six-figure tree lands over several sweeps instead of one wake.
- **Daemon** — one transaction per batch, one ack per transaction. A retryable answer leaves the batch queued; any other 4xx drops it after recording the error, because reposting identical bytes cannot succeed.

The starting size is deliberately small and grows while the observed duration stays under the ceiling. A timeout halves the size and records the event. The byte cap is separate from the count cap because one bookmark or one visit can be much larger than the median. The queue and the checkpoint are durable across a Manifest V3 background suspension; a periodic `alarms` wake retries. A trailing repair window re-reads the last few hours of history once the cursor has caught up, because an event page can be suspended while an event fires; the daemon's row key absorbs the duplicates.

## Deletions and tombstones

A local history deletion is not a reliable signal: the extension can observe its own absence or a browser removal event, but it cannot distinguish "deleted" from "never seen" after the fact. The design therefore does not synthesize history tombstones from absence.

- **Bookmarks** — `bookmarks.onRemoved` is an observable event and reports the removed item only: Firefox filters a folder's descendants out as descendant removals, so a folder deletion is one row marked `cascade` and the daemon resolves the subtree it already stores. A bookmark deletion does not erase the visit history or the document.
- **History from Firefox Sync** — there is no sync-origin event. Sync's history engine deletes a remotely removed page through `PlacesUtils.history.remove(url)`, which raises the same notification a local deletion does, so a remote deletion is visible but indistinguishable from a local one and carries no origin marker.
- **Local removal** — `history.onVisitRemoved` reports `(allHistory, urls)`, page-granular and with no visit or time detail; partial-visit removals are not reported at all, which is why no requirement depends on the event.
- **A full clear** — `history.clear()` arrives as `allHistory: true` and is forwarded as one global mark, never expanded into per-row deletions.

A tombstone carries `(kind, key, deleted_at, source)`, with `source` naming `bookmark` or `local`; there is no `sync` value, because Firefox does not expose the origin. What a removal may erase is decided below, from what the browser actually names.

## What a removal may erase

The rule comes from the producer's visibility, not from a retention policy: a
tombstone erases exactly the identity its event carried, and never a wider one.

| event                                  | what it names                                                                                                                                                       | what the producer may assert                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `bookmarks.onRemoved`                  | the node's guid, its parent and index. A folder's descendants are filtered out of the event, but the parent chain they hang from is what the daemon already stores. | that bookmark, or that folder subtree, is gone. An exact identity, so erasure is defined. |
| `history.onVisitRemoved`               | page URLs only. Visits and times are absent, and partial-visit removals are not reported at all.                                                                    | that the page left the local store. No visit identity exists, so this is a page mark.     |
| `history.clear()` (`allHistory: true`) | one global flag; no rows.                                                                                                                                           | that everything local was cleared at that instant — a global mark.                        |

So a bookmark tombstone is an **erase instruction** and a history tombstone is a
**mark**. The daemon may compact a bookmark row away; it must keep the visit
rows behind a page mark, because the visit that was deleted cannot be named and
d173's archive is append-only.

Two corollaries. A visit row can never be erased through this API: the live
event carries no visit id and the removal event carries no time, so "this
visit" is not expressible — only "this page". And a folder erase is resolved
from the parent chain rather than from the event, because Firefox suppresses
descendant removals.

## Retention, the browser's copy

The browser is a holding pen, not a store: Firefox expires history on its own
schedule, so a row that is missing before a sweep reached it never enters the
archive. The producer therefore stays ahead of the browser and lets history
fall into the archive in a controlled manner.

- **The prune call is user-grade.** The extension deletes through the public
  history API (`history.deleteRange`), the same call the browser's own forget
  front end makes, and never edits the places database.
- **The targets lead the browser's rule.** Gecko expires exotic visits at 90
  days and derives a page limit from a 75 MiB database budget, falling back to
  100 000 pages when it cannot measure the database (`PlacesExpiration.sys.mjs`,
  `DATABASE_MAX_SIZE`, `places.history.expiration.max_pages` default `-1`); 180
  days is a favicon threshold, not a history rule. The producer halves both, so
  the browser is pruned to 45 days and 50 000 pages — a target that equals the
  browser's would race it, and the other half is the producer's working set (the
  tail the daemon has not acknowledged yet). The page target names no timestamp,
  so its cutoff is estimated from the observed span and re-measured next pass.
  The factor is one named constant, not a scattering of numbers: moving it (for
  instance to keep even less in the browser) is a later tuning decision and is
  out of scope here.
- **The two targets cost different queries.** The day rule is answered by one
  one-row probe (`history.search` with `endTime` at the target), which
  authorises a range delete of the whole policy window; the page rule needs the
  profile's size, which no API reports, so it is the only case that enumerates —
  and it does so only when nothing is past the day target. The day rule's delete
  is deliberately optimistic: a page just inside the window goes with it, because
  the row is already archived (the clamp above) and the next pass re-measures.
  For the same reason a prune is recorded as a window rather than a URL list:
  the delete is a time range, so the pages it catches are not always nameable,
  and a removal event while the window is fresh is the extension's own.
- **Nothing is pruned before it is archived.** The prune cutoff is clamped to
  the visit stream's acknowledged checkpoint, and a profile with no ack yet is
  pruned not at all — the same rule the bookmarks follow.
- **The browser cannot be asked for its limit.** A WebExtension has no access to
  `places.*` preferences, so the source above is the static check and the sweep
  records the count and oldest row it observed as the runtime one: a browser that
  holds far fewer pages or fewer days than the rule says is expiring early, and
  the archive is behind.
- **A bookmark is recorded before the browser loses it.** A GitHub repository
  root — exactly two path segments on github.com, so `github.com/owner/repo`
  but never `/issues`, `/tree/…`, a profile, or a reserved first segment — is
  removed with `bookmarks.remove` once the bookmark stream is settled. The same
  rule is not applied to longer URLs: those are the user's reading list.
- **The prune never runs ahead of the archive.** The cutoff is clamped to the
  visit stream's checkpoint, so a browser row is deleted only after the daemon
  acknowledged it; with no checkpoint yet, the pass probes nothing and prunes
  nothing. One pass deletes a bounded chunk, because the call's cost is the row
  count and the removed URLs have to be remembered.
- **A prune is not a user deletion.** `deleteRange` raises the same removal
  event a user's deletion raises, and the producer forwards removals. The URLs a
  pass deleted are therefore kept in the scrub state and consumed when their
  event arrives, so the extension never marks the pages it just archived as
  gone.
- **The cadence is fast while there is backlog and slow while there is not.**
  The sweep gap is 5 s while history is oversized or older than the day target;
  once settled it doubles per sweep up to a 7-day cap, and a backlog (new
  visits, or history that has fallen under the targets because the browser
  expired it) puts it back to 5 s. The bookmark walk is not a cadence input: it
  is paced by what the flush drained, so a fast loop would add probes without
  moving a bookmark. The floor is a timer and
  the slow lane is an alarm, because an alarm's floor is a minute and a timer
  does not survive a suspended event page. The slow lane drops the periodic
  minute sweep and schedules one alarm at the computed gap, so the cap is real
  rather than decorative; the daily bookmark re-walk and the trailing visit
  re-read are repair paths that then ride the same gap, which is why they are
  the first thing a restart or an install puts back on the fast lane.
- **What the extension can see is what gets recorded.** A removal the extension
  observes is sent as its tombstone; an absence it never saw is not a deletion,
  and the archive keeps the row.
- **A prune is not a removal.** `history.deleteRange` and `bookmarks.remove`
  raise the same events a user's deletion raises, so the pass records the URLs
  and bookmark ids it deleted and the listeners consume them: forwarding them
  would mark exactly what the pass just archived as gone — a page mark for the
  visits and, for the GitHub-root bookmark, an erase instruction against the row
  the archive had just taken. The record is trusted for ten seconds and then
  dropped, so a missed event cannot turn into a permanent claim that the user
  deleted nothing.

## The daemon boundary

The daemon is not d181. d181 is the session ingest route, with a session-shaped spool and a session-shaped dedupe key; the browsing stream has visits, bookmarks, tombstones, and content documents. The browsing daemon is the d205 backend's ingest edge:

- **Ingest face** — `POST /ingest/slurp`, one single-stream batch per request, carrying visits, titles, bookmarks and removals. The envelope, the record kinds and the `(src, kind, key)` dedupe are specified in [`datalakehouse/README.md`](../datalakehouse/README.md); the producer's `wire.mjs` builds them.
- **Read faces** — the Promnesia protocol for the stock sidebar and the hister API for the hister extension. The extension uses only the ingest face; it does not read back.
- **Auth** — static keys are possible and disabled by default. The producer sends `Authorization: Bearer <key>` and the daemon also accepts `X-Access-Token`; the key is a shared secret in the extension's background storage and the daemon's `BROWSE_TOKEN`, and the daemon binds loopback when no key is set.
- **Idempotence** — the daemon's `(src, kind, key)` key absorbs a re-sent batch. The sequence mark is recorded but never used to skip a batch: a producer that resets its sequence (storage wipe, reinstall, restored profile) starts at 1 while the daemon remembers a higher mark, so trusting it would answer every later batch as a duplicate while writing nothing.

The extension's endpoint is loopback HTTP. A daemon bound to `0.0.0.0` exposes the token and the history to the LAN; the bind address must be loopback or the static key must be treated as a network secret. The extension needs a host permission for the loopback origin, and the key belongs in the background context, never in a page.

## Firefox Sync and versions

Firefox Sync writes other devices' history and bookmarks into the same local stores. The extension treats what is locally visible as local history; it does not call the Sync service and does not invent a device identity. A synced visit is a visit; a synced bookmark is a bookmark. The one sync-specific case is deletion, and it has no API of its own: the Sync engine removes the page locally and the removal reaches the extension through the same event a local deletion raises.

The supported versions are the current stable Firefox and the current most-recent ESR, built from one manifest. Firefox runs a Manifest V3 background as a document rather than a service worker — `service_worker` is accepted in the manifest schema and `scripts` still run as an event page — so `background.scripts` with `type: "module"` is the shape both channels share. The ESR floor is declared in `strict_min_version`; a feature that exists on one channel only is optional and capture falls back. Chromium and Edge are a later port, not a second code path in the MVP.

## Permissions and packaging

**Packaging is three extensions, never one.** The history and bookmark producer
needs `history`, `bookmarks`, `storage`, `alarms` and a loopback host
permission. A content client — the hister capture of the current page, the
Promnesia marking of already-visited links — needs host permissions for every
site and a content script, which is a different privacy surface and a different
failure mode; folding it in would put a page-content permission inside the
producer that d204 deliberately keeps DOM-free. So the producer stays alone, and
each content client is its own extension with its own update channel: a
hister-capture extension and a Promnesia-marking extension are options to build
when the stock extensions are shown to fall short, not parts of this one. The
stock hister and Promnesia extensions remain the compatibility target
(docs/d205), so a custom client is justified only by a behaviour gap, and the
shared wire, queue and settings code is copied per unit (docs/d113), not shared
by one omnibus manifest.

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
- query strings travel whole: a redacted or hashed URL cannot answer Promnesia's `/visited` check, which matches exactly, and it would break the visit key as well. A skip list would be the escape hatch; none is built, and the archive's locality plus d173's storage rule carry the risk instead;
- only `http` and `https` are captured: `about:`, `file:`, `moz-extension:`, `data:` and `blob:` are dropped by a whitelist, not a blacklist;
- the static key kept in the background context and never injected into a page;
- the local queue bounded and cleared on uninstall;
- a visible first-run consent screen that states the history and bookmark streams leave the browser.

d173's Datensparsamkeit is the storage rule for this data. The extension sends the facts Promnesia needs; it does not send page content.

## Producer decisions taken

The questions this register used to leave open are settled on the producer side:

- **The sync-origin event does not exist.** Sync deletes a remote page through the same Places path a local deletion uses, so a removal cannot be labelled `sync`; it travels as `local` and the archive keeps the rows (see Deletions and tombstones).
- **`history.onVisitRemoved` is forwarded as a page-granular mark.** It is best-effort by construction — Firefox suppresses partial-visit removals — so a missing event is not an error and no requirement depends on it.
- **A removal erases exactly what Firefox named** (see What a removal may erase): a bookmark tombstone names an exact node and may be compacted away, a history tombstone names only a page and stays a mark. Retention of the browser's copy is this record's (see Retention, the browser's copy); retention of the archive's rows stays d205's.
- **The static key is entered on the extension's options page** into the background's storage, never into a page, and must equal the daemon's `BROWSE_TOKEN`.

## Verification status

The browser facts below are read from mozilla-central's implementation and from
MDN rather than from an API summary; the file that decides each one is named so
a later reader can re-check it without a browser.

- **`history.onVisited`** (`browser/components/extensions/parent/ext-history.js`) fires a page item — page guid, url, title, last visit time, visit count, typed count. It has no visit id, no transition and no referring visit.
- **`history.getVisits`** (same file) returns `{id, visitId, visitTime, referringVisitId, transition}`, newest first, for one URL. Both ids are `moz_historyvisits` row numbers: local, not synced, and renumbered by a profile rebuild — which is why the visit key is `(url, visit time)` and the referring visit travels as an opaque local id.
- **`history.search`** (same file) defaults to the last 24 hours, `maxResults: 100`, and sorts newest-first; it passes only `text`, `startTime`, `endTime` and `maxResults` to Places, so a Chrome-only filter such as `title` or `url` is ignored. `includeHidden` is forced on.
- **`history.onVisitRemoved`** (same file) reports `{allHistory, urls}` and suppresses partial-visit removals.
- **Sync's deletion path** (`services/sync/modules/engines/history.sys.mjs`) calls `PlacesUtils.history.remove(record.id)`, which raises the same notification a local deletion raises. No sync-origin event exists.
- **Bookmark events** (`browser/components/extensions/parent/ext-bookmarks.js`) pass `dateAdded` in raw PRTime microseconds while `getTree`/`get` convert to milliseconds; `onRemoved` filters descendant removals and tag changes; `onChanged` carries only `{title}` or `{url}` and `onMoved` only the old and new parent and index.
- **Bookmark reads** (same file) implement `getChildren` as `getSubTree(root)` internally, so a folder-by-folder walk does not bound Places' work.
- **Manifest V3 background** (`toolkit/components/extensions/schemas/manifest.json`): `service_worker` is accepted, but Firefox runs `scripts` as a document and `type: "module"` applies to scripts, not to a service worker.
- **`alarms`** (`toolkit/components/extensions/parent/ext-alarms.js`) is an in-memory `nsITimer`: no persistence across a restart and no sub-minute clamp, so the extension re-creates its alarm on every load as well as on startup.
- **Host permissions** (MDN, `manifest.json/host_permissions`) are granted at install in Firefox and displayed in the install prompt from 127; a match pattern cannot name a port, so `http://127.0.0.1/*` covers every port.

Still unmeasured: `history.search` and `getVisits` throughput on a real
profile (the first passes measure and tune it), the Flatpak XPI install path,
and a session on the ESR channel.

## What a real profile is expected to cost

The reference profile is years old and bookmark-heavy, and Firefox Sync keeps
writing history and bookmarks into the same local stores the producer reads. The
extension never calls Sync, but the store it reads is being filled while it is
being scanned, so the design targets progress rather than a completion time:

- the backfill window shrinks toward its floor in dense regions and grows in sparse ones, so a first fill spreads over many sweeps; the status line's cursor, accepted/duplicate counts and budget misses are the progress read;
- the bookmark walk is budgeted per sweep with a durable resume point (see Adaptive batching), so a six-figure tree does not need one wake to hold it;
- a page whose timeline would flood a pass is caught by the row budget instead: the window is not advanced and the next pass searches a smaller page;
- the queue ceiling absorbs the rest, and a dropped visit is re-derivable by the next sweep, so a long first fill is slow rather than lossy.

No completion time is promised (d205's no-SLO rule), and no separate benchmark is
planned: every pass measures itself and tunes the next one.

## Alternatives rejected

- **Current-page content in this extension.** It is the hister-side extension's job; adding it here doubles the permissions and the privacy surface.
- **Reuse the d181 session route.** The session route is write-only, session-shaped, and spool-shaped; the browsing stream needs visits, bookmarks, tombstones, and content documents.
- **Read `places.sqlite` directly.** It reintroduces the Flatpak/SELinux boundary and the live-WAL race d172 removes.
- **One global cursor or one massive batch.** It locks a side, loses progress on a crash, and cannot resume oldest-first.
- **Infer history deletions from absence.** The extension cannot tell a deletion from a page it has not reached; an append-only archive is safer.
- **Chromium first.** The MVP is Firefox; a second browser is a port after the Firefox flow is measured.

## Where this lands

The producer is [`datalakehouse/firefox-extension/`](../datalakehouse/firefox-extension/README.md) and the daemon that consumes it is `datalakehouse/browse-daemon.py` (d205). The storage tiers are d173 and the cold search is d177; the browsing source extends the datalakehouse unit rather than opening a third storage path.
