---
id: firefox-extension
type: submodule-design
status: active
title: "firefox-extension — the local browsing producer: visits, bookmarks and titles as stream-shaped batches"
parent: datalakehouse
depends-on: [d204]
references: [d172, d205, d113]
tags: ["firefox-extension", "browsing-history", "bookmarks", "producer"]
---

# firefox-extension

A Manifest V3 Firefox extension that streams the browser's own history,
bookmarks, and page titles to the loopback daemon of d205. It is the producer
half of [d204](../docs/d204-firefox-slurp-extension-requirements.md); the
daemon that consumes it is the unit's `browse-daemon.py`.

It reads no page content, injects no content script, and never talks to Firefox
Sync: what is visible in the local store is what is sent. The manifest's
`strict_min_version` is 128.0, above the first Firefox with Manifest V3 event
pages, so the same build serves the stable channel and the current ESR. URLs travel raw — the
daemon canonicalises with the vendored `cannon` (d172).

## Install and first run

Development is a temporary add-on: Firefox's `about:debugging` → _This
Firefox_ → _Load Temporary Add-on…_ → pick `manifest.json`. A permanent
install is a signed XPI through AMO, or an enterprise `policies.json`; Flatpak
Firefox installs the XPI into its own profile and still reaches the host daemon
over loopback.

Start the daemon from the unit root (`./datalakehouse/browse-daemon.sh`), then
open the extension's options page. Capture is **off** until the consent box is
ticked: install is not consent, and nothing is queued or posted before it
(d204's Privacy section). The page also carries the daemon origin (loopback
only — the manifest's host permission reaches nothing else) and the optional
static key, which the daemon's `BROWSE_TOKEN` must equal.

## The four streams

| stream    | Firefox source                              | identity                    | checkpoint                               |
| --------- | ------------------------------------------- | --------------------------- | ---------------------------------------- |
| visit     | `history.onVisited`, `search` + `getVisits` | `(url, visit time in ms)`   | `{cursor_ms, pending}`, moved on the ack |
| title     | `history.onTitleChanged`                    | page guid (`title:<guid>`)  | `{acked_seq}`                            |
| bookmark  | `bookmarks.getTree` plus the four events    | bookmark/folder guid        | `{walked_at, acked_seq}`                 |
| tombstone | `bookmarks.onRemoved`, `onVisitRemoved`     | node guid, page URL, or `*` | `{acked_seq}`                            |

Each stream is a separate queue and a separate checkpoint; the daemon is never
asked to assume a cross-stream order (d204's "The streams").

A removal carries exactly the identity its event carried (d204's "What a removal
may erase"). A bookmark removal names a node guid, so it is an erase the backend
may act on, with a folder cascading over the parent chain; a visit removal names
only a page URL, so it is a mark — no API ever exposes which visit was deleted.

## Why the batching looks like this

- **`history.search` is newest-first and capped.** Firefox defaults the window
  to the last 24 hours and `maxResults` to 100, returns rows descending, and
  offers no sort parameter. A window that fills the page would hand back its
  newest rows and silently hide its oldest — exactly what a retention rule
  prunes first — so a full page halves the window and the cursor does not move.
- **A visit is keyed on `(url, visit time)`.** `getVisits` also exposes
  `moz_historyvisits.id`, a local row number: not synced, renumbered by a
  profile rebuild, and absent from the live event. The URL and the millisecond
  timestamp are the only pair both paths agree on.
- **The live row is not the authoritative one.** `onVisited` carries no
  transition, no referring visit and no visit id, so those arrive from the
  backfill's `getVisits` call under the same key. Every row is re-derivable,
  which is what lets a bounded queue drop a visit without losing it.
- **`getVisits` has no time filter.** A URL visited thousands of times returns
  its whole timeline for one window, so a page past `visit_cap` is sent from
  its own last visit and the rest of that URL's timeline stays with the live
  stream.
- **`history.search` matches pages, not visits.** A page comes back when its
  _last_ visit falls in the window, so the expansion takes every visit up to the
  window end; bounding it by the window start would drop the earlier visits of a
  page reached late, whose own window is already behind the cursor.
- **The trailing repair window.** An event page can be suspended when an event
  fires. After the cursor catches up, the last `repair_hours` of history is
  re-read each sweep and the daemon's row key absorbs the duplicates.
- **The queue drops visits before tombstones.** A dropped visit or bookmark is
  re-derivable by the next sweep or the daily walk; a removal is the only trace
  that the row existed here, so it is evicted last.
- **The checkpoint moves on the ack, never on the send.** A batch that is
  refused, timed out or interrupted leaves the window in flight, and the next
  wake re-sends it.

## The wire

`POST /ingest/slurp` on the daemon, one single-stream batch per request, with
`Authorization: Bearer <key>` when a key is set. The envelope and every record
shape are specified where the daemon reads them (d204's daemon boundary and
`datalakehouse/README.md`); `wire.mjs` builds them.

The producer treats a 2xx as the ack (`accepted`, `duplicates`, `version`), a
retryable status (408, 425, 429, 5xx, transport, timeout) as "keep the batch",
and any other 4xx as a permanent reject: reposting identical bytes cannot
succeed, so the batch is recorded in the status line and dropped rather than
wedging the stream.

## Layout

| file                | role                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`     | the permission contract: history, bookmarks, storage, alarms; loopback host; event page                               |
| `background.mjs`    | listener registration, the flush/ack loop, the minute sweep and the daily bookmark walk                               |
| `history.mjs`       | live visit/title/removal rows and the oldest-first backfill pass                                                      |
| `bookmarks.mjs`     | the tree snapshot, the event rows read back whole, folder-cascade removal rows                                        |
| `queue.mjs`         | the durable per-stream queue: bounded, FIFO, acked by delete                                                          |
| `state.mjs`         | checkpoints, the adaptive batch knobs, the status line                                                                |
| `wire.mjs`          | record builders, the envelope, and the transport's three outcomes                                                     |
| `settings.mjs`      | defaults, loopback validation, the consent flag                                                                       |
| `options.html/.mjs` | the first-run consent screen, the settings form, the status report                                                    |
| `retention.mjs`     | the browser copy's retention: the prune cutoff clamped to the archive cursor, its own-removal list, the scrub cadence |

## Tests

```sh
./node-run.sh --test datalakehouse/firefox-extension/tests/*.test.mjs
```

They run in the repo sweep (`./test.sh`, whose globs reach a nested unit) and
need no browser: `tests/fake-webext.mjs` reproduces `storage.local`, `history`
and `bookmarks`, including the two behaviours that shaped the producer
(newest-first capped search, unfiltered `getVisits`), and the transport tests
start a real loopback HTTP server for the ack/reject/retry cases.

## Large real profiles

The reference profile is years old and bookmark-heavy, and Firefox Sync keeps
writing history and bookmarks into the same stores this extension reads. The
producer never calls Sync — it sees only what lands locally — but the store it
scans is being filled while it is scanned, so the design targets progress rather
than a completion time:

- the backfill window shrinks toward its floor in dense regions and grows in
  sparse ones, so a first fill spreads over many sweeps; the options page's
  cursor, accepted/duplicate counts and budget misses are the progress read;
- the bookmark walk carries at most `WALK_BUDGET` rows per sweep with a durable
  resume point, so a six-figure tree lands over several sweeps instead of one
  storage write per row in a single wake;
- a page whose timeline would flood a pass hits the row budget instead: the
  window is not advanced and the next pass searches a smaller page;
- the bounded queue turns a long outage or a huge first fill into slow progress,
  not loss — a dropped visit is re-derived by the next sweep, a dropped bookmark
  by the next walk;
- retention works on the browser's copy only and is clamped to the visit cursor:
  nothing leaves the browser before the daemon acknowledged it, and the URLs a
  pass deleted are remembered so its own removal events never mark archived
  pages as gone;
- no completion time is promised (d204 and d205: eventual consistency, no SLO),
  and no separate benchmark is planned: every pass measures itself and tunes the
  next one.

## What is not verified

Flatpak XPI installation and a session on the ESR channel. The API facts the
producer depends on were verified against mozilla-central and are recorded in
d204's verification section; throughput on a real profile is measured by the
passes themselves rather than by a benchmark.
