-- The browsing store, ported from datalakehouse/browse-daemon.py's SCHEMA.
-- The tables are the daemon's, column for column, so an existing store opens
-- without a migration; the wire's schema number is separate (docs/d205).
--
-- visit and bookmark are keyed (src, key), which IS the (src, kind, key)
-- dedupe identity of docs/d204: the table a row lands in names its kind, so a
-- re-sent batch is absorbed without a second index. presence is the one
-- complete resident structure (docs/d178) and is written in the same
-- transaction as the row that proves it.
CREATE TABLE IF NOT EXISTS visit(
  src TEXT NOT NULL, key TEXT NOT NULL,
  norm_url TEXT NOT NULL, orig_url TEXT NOT NULL,
  dt TEXT NOT NULL, context TEXT, duration REAL,
  locator_title TEXT, locator_href TEXT,
  transition TEXT, page_id TEXT, visit_id TEXT, via TEXT,
  PRIMARY KEY(src, key));
CREATE INDEX IF NOT EXISTS visit_norm ON visit(norm_url);
CREATE INDEX IF NOT EXISTS visit_dt ON visit(dt);

-- A bookmark carries its parent guid and index, not a folder path: the path is
-- a view derived from the parent chain the producer sends (docs/d204), and
-- storing it would go stale on every move.
CREATE TABLE IF NOT EXISTS bookmark(
  src TEXT NOT NULL, key TEXT NOT NULL,
  norm_url TEXT, orig_url TEXT,
  title TEXT, parent_id TEXT, position INTEGER, node_type TEXT,
  date_added INTEGER, date_modified INTEGER,
  PRIMARY KEY(src, key));
CREATE INDEX IF NOT EXISTS bookmark_parent ON bookmark(parent_id);

-- A title fact is keyed on the page guid and belongs to the page, not a visit
-- (docs/d204): a title learned later must not invent a visit, but the sidebar
-- should show it, so it lands here and backs the presence locator.
CREATE TABLE IF NOT EXISTS page_title(
  norm_url TEXT PRIMARY KEY, title TEXT, seen_at TEXT);

CREATE TABLE IF NOT EXISTS tombstone(
  kind TEXT NOT NULL, key TEXT NOT NULL,
  deleted_at TEXT NOT NULL, source TEXT,
  PRIMARY KEY(kind, key));

CREATE TABLE IF NOT EXISTS presence(
  norm_url TEXT PRIMARY KEY, orig_url TEXT NOT NULL,
  dt TEXT NOT NULL, src TEXT NOT NULL, context TEXT, duration REAL,
  locator_title TEXT, locator_href TEXT);

CREATE TABLE IF NOT EXISTS document(
  owner INTEGER NOT NULL, norm_url TEXT NOT NULL,
  url TEXT NOT NULL, title TEXT, text TEXT, html TEXT, favicon TEXT,
  language TEXT, label TEXT, added INTEGER NOT NULL, updated INTEGER NOT NULL,
  add_count INTEGER NOT NULL DEFAULT 1, type INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  PRIMARY KEY(owner, norm_url));

CREATE TABLE IF NOT EXISTS rule(name TEXT PRIMARY KEY, patterns TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS click(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL, title TEXT, query TEXT, added INTEGER NOT NULL);

-- The producer's per-stream high-water mark. It is recorded, never trusted to
-- skip a batch: a producer that resets its own sequence (a storage wipe, a
-- reinstall) would otherwise be answered as duplicates forever while nothing
-- was written. Row identity (src, kind, key) is the authority.
CREATE TABLE IF NOT EXISTS stream(name TEXT PRIMARY KEY, acked_high INTEGER NOT NULL);

-- The store's own migration mark, separate from the wire's schema number: an
-- upgrade that changes the index shape clears and rebuilds the postings, while
-- the producer keeps sending schema 1.
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
