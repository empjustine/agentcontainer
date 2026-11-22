-- The search index: derived state, rebuildable from `document`, and shaped so a
-- cold demotion is a row-group copy rather than a redesign (docs/d205's
-- cold-shaped search, sbex/cold-persistence.md).
--
-- The seam is deliberate, and it is what makes the service a drop-in for the
-- Python daemon rather than a one-way migration: `lakehouse-schema.sql` holds
-- the tables both implementations share, the daemon keeps its own index under
-- its own names, and the four tables below are prefixed `lakehouse_` with the
-- mark in `meta['lakehouse.index_schema']`. Either implementation therefore
-- opens a store the other wrote, rebuilds only its own derived index and leaves
-- the other's untouched: no migration, and no shared table whose shape has to
-- agree. `SearchIndex.ensureIndex` drops and rebuilds exactly these four when
-- their shape changes.
--
-- WHY a posting row names an integer document id and not a URL: a cold posting
-- row is (term, doc, field, tf), so a Parquet rewrite is a straight copy sorted
-- by term, a compressed row group holds no repeated URL text, and the document
-- dimension is written once beside it. The hot store also stops paying for the
-- same URL on every term of every document.
CREATE TABLE IF NOT EXISTS lakehouse_doc(
  doc INTEGER PRIMARY KEY AUTOINCREMENT,
  owner INTEGER NOT NULL,
  norm_url TEXT NOT NULL,
  length INTEGER NOT NULL,
  added INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS lakehouse_doc_url ON lakehouse_doc(owner, norm_url);
-- `added` is the demotion axis: a cold generation is a sealed `added` window,
-- so a date-bounded ("latest history") query prunes generations instead of
-- reading them, and this index is what makes the hot half of that prune a range
-- scan rather than a table scan.
CREATE INDEX IF NOT EXISTS lakehouse_doc_added ON lakehouse_doc(added);

-- The posting list: sorted by term, no positions, one row per (term, doc,
-- field). A phrase is a candidate filter over the stored body, never an index
-- lookup, which is the price of the row layout a columnar store keeps.
CREATE TABLE IF NOT EXISTS lakehouse_posting(
  term TEXT NOT NULL, doc INTEGER NOT NULL, field INTEGER NOT NULL, tf INTEGER NOT NULL,
  PRIMARY KEY(term, doc, field)) WITHOUT ROWID;
-- The delete path and a re-index find one document's postings by its id.
CREATE INDEX IF NOT EXISTS lakehouse_posting_doc ON lakehouse_posting(doc);

-- The term dictionary, sorted, carrying only the document frequency BM25 needs.
CREATE TABLE IF NOT EXISTS lakehouse_term(term TEXT PRIMARY KEY, doc_freq INTEGER NOT NULL);

-- The corpus parameters BM25 divides by, maintained on index and unindex
-- instead of recomputed with a full scan on every query. A cold generation
-- records the same two numbers beside its row groups, so a merged hot+cold
-- query can score both halves with one set of aggregates.
CREATE TABLE IF NOT EXISTS lakehouse_stats(
  id INTEGER PRIMARY KEY CHECK (id = 0),
  documents INTEGER NOT NULL,
  length_sum INTEGER NOT NULL);
INSERT OR IGNORE INTO lakehouse_stats(id, documents, length_sum) VALUES(0, 0, 0);
