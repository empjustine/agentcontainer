package com.example.sbex.lakehouse;

import java.io.InputStream;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import java.util.List;
import java.util.Objects;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.JacksonException;
import tools.jackson.core.JsonParser;
import tools.jackson.core.JsonToken;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The custom slurper of docs/d204: one batch, one transaction, one ack, and the
 * dedupe identity (src, kind, key) is row identity — never the sequence mark.
 *
 * WHY the envelope is streamed and a record is not: an eight-megabyte batch is
 * one envelope with ten thousand records, and materialising the whole tree
 * would cost several times the body. Parsing to the records array and then one
 * record at a time keeps the heap cost at one record plus the counters, which
 * is the same bounded shape the daemon's json.loads traded away
 * (sbex/datalakehouse-port.md, What each protocol needs).
 *
 * WHY the transaction opens around the read: SQLite has one writer, so the
 * write lock is held for the length of the batch anyway; a slow client can
 * stretch that window, which is why the body ceiling is the bound (maxBody) and
 * not the record loop.
 */
@Component
class SlurpIngest {

	private final JdbcTemplate writer;
	private final TransactionTemplate transactions;
	private final JsonMapper mapper;
	private final SearchIndex index;
	private final Metadata metadata;

	SlurpIngest(
			@Qualifier("writerJdbc") JdbcTemplate writer, TransactionTemplate transactions,
			JsonMapper mapper, SearchIndex index, Metadata metadata) {
		this.writer = writer;
		this.transactions = transactions;
		this.mapper = mapper;
		this.index = index;
		this.metadata = metadata;
	}

	/** The fields the producer's ack reads, plus the checkpoint to echo. */
	record Ack(int accepted, int duplicates, JsonNode checkpoint) {}

	/** A bookmark row as the merge rule reads it. */
	private record BookmarkRow(
		String normUrl, String origUrl, String title, String parentId, Long position,
		String nodeType, Long dateAdded, Long dateModified) {}

	private static final int SCHEMA_VERSION = 1;

	private static final class Counters {
		private int accepted;
		private int duplicates;
	}

	Ack ingest(InputStream body) {
		Counters counters = new Counters();
		Envelope envelope = new Envelope();
		try (JsonParser parser = mapper.createParser(body)) {
			if (parser.nextToken() != JsonToken.START_OBJECT) {
				throw new LakehouseProblems.BadRequestException("body must be an object");
			}
			transactions.executeWithoutResult(status -> readEnvelope(parser, counters, envelope));
		} catch (JacksonException exception) {
			// A malformed body is the client's error, not a handler failure: the
			// same 400 the daemon answers with (docs/d204).
			throw new LakehouseProblems.BadRequestException(
				"invalid json: " + exception.getOriginalMessage(), exception);
		}
		recordSequence(envelope);
		return new Ack(counters.accepted, counters.duplicates, envelope.checkpoint);
	}

	/** The envelope fields the ack and the stream mark read. */
	private static final class Envelope {
		private String stream = "";
		private JsonNode sequence;
		private JsonNode checkpoint;
	}

	private void readEnvelope(JsonParser parser, Counters counters, Envelope envelope) {
		boolean schemaSeen = false;
		while (parser.nextToken() == JsonToken.PROPERTY_NAME) {
			String field = parser.currentName();
			parser.nextToken();
			switch (field) {
				case "schema" -> {
					if (!parser.currentToken().isNumeric()) {
						throw new LakehouseProblems.BadRequestException("schema must be a number");
					}
					int schema = parser.getIntValue();
					if (schema != SCHEMA_VERSION) {
						throw new LakehouseProblems.UnsupportedSchemaException(
							"unsupported schema " + schema + "; this daemon speaks 1");
					}
					schemaSeen = true;
				}
				case "stream" -> {
					envelope.stream = parser.getString();
				}
				case "stream_seq" -> {
					envelope.sequence = parser.readValueAsTree();
				}
				case "checkpoint" -> {
					envelope.checkpoint = parser.readValueAsTree();
				}
				case "records" -> {
					// The producer sends the schema first; a body that records
					// before its schema cannot be checked, so it is refused rather
					// than applied and then rejected (which claimed a 409 after
					// writing rows).
					if (!schemaSeen) {
						throw new LakehouseProblems.BadRequestException(
							"schema must precede records");
					}
					applyRecords(parser, counters);
				}
				default -> parser.skipChildren();
			}
		}
	}

	private void applyRecords(JsonParser parser, Counters counters) {
		if (parser.currentToken() != JsonToken.START_ARRAY) {
			throw new LakehouseProblems.BadRequestException("records must be an array");
		}
		while (parser.nextToken() != JsonToken.END_ARRAY) {
			JsonNode record = parser.readValueAsTree();
			if (record == null || !record.isObject()) {
				throw new LakehouseProblems.BadRequestException("each record must be an object");
			}
			String src = Json.textOr(record, "src", "unknown");
			String kind = Json.textOr(record, "kind", "");
			boolean fresh = switch (kind) {
				case "visit" -> visit(src, record);
				case "title" -> title(record);
				case "bookmark" -> bookmark(src, record);
				case "bookmark-removed" -> bookmarkRemoved(record);
				case "visit-removed" -> visitRemoved(record);
				case "history-cleared" -> historyCleared(record);
				case "document" -> importDocument(record);
				case "rule" -> importRule(record);
				case "click" -> importClick(record);
				default -> throw new LakehouseProblems.BadRequestException("unknown record kind: '" + kind + "'");
			};
			if (fresh) {
				counters.accepted++;
			} else {
				counters.duplicates++;
			}
		}
	}

	/**
	 * The sequence mark is recorded for observability and never used to skip a
	 * batch: a producer that resets its own sequence would otherwise be answered
	 * as duplicates forever while nothing was written (docs/d204). It is written
	 * after the batch transaction, as the daemon writes it.
	 */
	private void recordSequence(Envelope envelope) {
		JsonNode high = envelope.sequence == null ? null : envelope.sequence.get("high");
		if (high == null || !high.isNumber()) {
			return;
		}
		writer.update(
			"INSERT INTO stream(name, acked_high) VALUES(?,?)"
				+ " ON CONFLICT(name) DO UPDATE SET acked_high=excluded.acked_high",
			envelope.stream, high.asLong());
	}

	/**
	 * The presence row is the one hot read (docs/d178), so its merge rule is a
	 * correctness rule: the earliest sighting owns dt, but a later row that
	 * knows a title or a context fills the blank.
	 */
	private void presence(String norm, String url, String at, String src, String context, String title, String href) {
		writer.update(
			"INSERT INTO presence"
				+ "(norm_url, orig_url, dt, src, context, duration, locator_title, locator_href)"
				+ " VALUES(?,?,?,?,?,NULL,?,?)"
				+ " ON CONFLICT(norm_url) DO UPDATE SET"
				+ " context=COALESCE(presence.context, excluded.context),"
				+ " locator_title=COALESCE(NULLIF(presence.locator_title,''), excluded.locator_title),"
				+ " locator_href=COALESCE(presence.locator_href, excluded.locator_href)",
			norm, url, at, src, context, title, href);
	}

	private boolean visit(String src, JsonNode record) {
		String url = Json.text(record, "url");
		if (url == null || url.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("visit record without url");
		}
		String norm = CanonicalUrl.normalise(url);
		String key = visitKey(record, norm);
		Object moment = Json.moment(record, "visit_time") != null
			? Json.moment(record, "visit_time") : Json.moment(record, "dt");
		String at = Moments.store(Moments.parse(moment));
		String title = Json.text(record, "title");
		int inserted = writer.update(
			"INSERT OR IGNORE INTO visit(src, key, norm_url, orig_url, dt, context, duration,"
				+ " locator_title, locator_href, transition, page_id, visit_id, via)"
				+ " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
			src, key, norm, url, at, Json.text(record, "context"), Json.number(record, "duration"),
			title, Json.text(record, "locator_href"), Json.text(record, "transition"),
			Json.text(record, "page_id"), Json.text(record, "visit_id"), Json.text(record, "via"));
		if (inserted == 0) {
			return false;
		}
		presence(norm, url, at, src, Json.text(record, "context"), title, null);
		return true;
	}

	/**
	 * d204 leaves Firefox's visit id open, so the producer keys a visit on
	 * (raw URL, visit time); the daemon falls back to the same pair when a
	 * producer omits it, so one fact cannot land twice.
	 */
	private static String visitKey(JsonNode record, String norm) {
		String key = Json.text(record, "key");
		if (key != null && !key.isEmpty()) {
			return key;
		}
		Object moment = Json.moment(record, "visit_time") != null
			? Json.moment(record, "visit_time") : Json.moment(record, "dt");
		return norm + "@" + Moments.millis(Moments.parse(moment));
	}

	/**
	 * A page-title fact fills a blank locator, never overwrites a known title.
	 * The return value is what makes a replayed batch answer duplicates instead
	 * of fresh writes, which the producer's backoff reads.
	 */
	private boolean title(JsonNode record) {
		String url = Json.textOr(record, "url", "");
		String value = Json.textOr(record, "title", "");
		String at = Moments.store(Moments.parse(Json.moment(record, "seen_at")));
		String norm = CanonicalUrl.normalise(url);
		List<String> existing = writer.queryForList(
			"SELECT title FROM page_title WHERE norm_url = ?", String.class, norm);
		if (!existing.isEmpty() && Objects.equals(existing.get(0), value)) {
			return false;
		}
		writer.update(
			"INSERT INTO page_title(norm_url, title, seen_at) VALUES(?,?,?)"
				+ " ON CONFLICT(norm_url) DO UPDATE SET title=excluded.title, seen_at=excluded.seen_at",
			norm, value, at);
		writer.update(
			"UPDATE presence SET locator_title = ? WHERE norm_url = ? AND (locator_title IS NULL OR locator_title = '')",
			value, norm);
		return true;
	}

	/**
	 * A move or a rename is an event too: parent, position and title are facts
	 * the producer re-sends, and INSERT OR IGNORE would drop every one after the
	 * first walk. Only date_added is immutable, and the folder path stays a view
	 * over the parent chain (docs/d204).
	 */
	private boolean bookmark(String src, JsonNode record) {
		String key = Json.textOr(record, "key", "");
		if (key.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("bookmark record without key");
		}
		String url = Json.text(record, "url");
		BookmarkRow existing = writer.query(
			"SELECT norm_url, orig_url, title, parent_id, position, node_type, date_added, date_modified"
				+ " FROM bookmark WHERE src = ? AND key = ?",
			(resultSet, row) -> new BookmarkRow(
				resultSet.getString("norm_url"), resultSet.getString("orig_url"),
				resultSet.getString("title"), resultSet.getString("parent_id"),
				nullableLong(resultSet, "position"), resultSet.getString("node_type"),
				nullableLong(resultSet, "date_added"), nullableLong(resultSet, "date_modified")),
			src, key).stream().findFirst().orElse(null);
		String nodeType = Json.textOr(record, "node_type",
			existing == null ? "bookmark" : existing.nodeType());
		String norm = url != null ? CanonicalUrl.normalise(url) : existing == null ? null : existing.normUrl();
		String origUrl = url != null ? url : existing == null ? null : existing.origUrl();
		String title = Json.text(record, "title");
		if (title == null && existing != null) {
			title = existing.title();
		}
		String parentId = Json.text(record, "parent_id");
		if (parentId == null && existing != null) {
			parentId = existing.parentId();
		}
		Long position = Json.number(record, "position");
		if (position == null && existing != null) {
			position = existing.position();
		}
		Long dateAdded = Json.number(record, "date_added");
		if (existing != null) {
			// date_added is the one immutable fact: a move or a rename re-sends
			// it, and a partial event must not blank it.
			dateAdded = existing.dateAdded();
		}
		Long dateModified = Json.number(record, "date_modified");
		if (dateModified == null && existing != null) {
			dateModified = existing.dateModified();
		}
		if (existing != null && Objects.equals(existing, new BookmarkRow(
				norm, origUrl, title, parentId, position, nodeType, dateAdded, dateModified))) {
			return false;
		}
		if (existing != null) {
			writer.update(
				"UPDATE bookmark SET norm_url=?, orig_url=?, title=?, parent_id=?,"
					+ " position=?, node_type=?, date_added=?, date_modified=? WHERE src=? AND key=?",
				norm, origUrl, title, parentId, position, nodeType, dateAdded, dateModified, src, key);
		} else {
			writer.update(
				"INSERT INTO bookmark(src, key, norm_url, orig_url, title, parent_id,"
					+ " position, node_type, date_added, date_modified) VALUES(?,?,?,?,?,?,?,?,?,?)",
				src, key, norm, origUrl, title, parentId, position, nodeType, dateAdded, dateModified);
		}
		if (norm != null) {
			// A bookmark is context, never a visit (docs/d204): it enriches a
			// page a visit already made present, and never creates the mark.
			String recordTitle = Json.text(record, "title");
			writer.update(
				"UPDATE presence SET locator_title=COALESCE(NULLIF(locator_title,''), ?),"
					+ " locator_href=COALESCE(locator_href, ?) WHERE norm_url=?",
				recordTitle, url, norm);
			if (recordTitle != null && !recordTitle.isEmpty()) {
				// page_title is the derived read-time locator, so a later real
				// title event can replace it; the visit row stays append-only.
				writer.update(
					"INSERT INTO page_title(norm_url, title, seen_at) VALUES(?,?,?)"
						+ " ON CONFLICT(norm_url) DO NOTHING",
					norm, recordTitle, Moments.store(Instant.now()));
			}
		}
		return true;
	}

	/**
	 * A folder removal arrives once, with its descendants filtered out of the
	 * event, so the daemon resolves the subtree it already stores (docs/d204's
	 * onRemoved note).
	 */
	private boolean bookmarkRemoved(JsonNode record) {
		String key = Json.textOr(record, "key", "");
		if (key.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("bookmark-removed record without key");
		}
		String at = Moments.store(Moments.parse(Json.moment(record, "deleted_at")));
		String source = Json.textOr(record, "source", "bookmark");
		boolean fresh = tombstone("bookmark", key, at, source);
		JsonNode cascade = record.get("cascade");
		if (cascade != null && cascade.asBoolean(false)) {
			for (String child : writer.queryForList(
					"WITH RECURSIVE gone(key) AS ("
						+ " SELECT key FROM bookmark WHERE parent_id = ?"
						+ " UNION SELECT b.key FROM bookmark b JOIN gone g ON b.parent_id = g.key)"
						+ " SELECT key FROM gone",
					String.class, key)) {
				tombstone("bookmark", child, at, source);
			}
		}
		return fresh;
	}

	/**
	 * Firefox reports a page-level removal with no visit detail, so the mark is
	 * keyed by canonical URL and hides every visit of that page while the rows
	 * stay: a mark, not an erase (docs/d205's pending erasure).
	 */
	private boolean visitRemoved(JsonNode record) {
		String url = Json.textOr(record, "url", "");
		if (url.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("visit-removed record without url");
		}
		return tombstone("visit-removed", CanonicalUrl.normalise(url),
			Moments.store(Moments.parse(Json.moment(record, "deleted_at"))),
			Json.textOr(record, "source", "local"));
	}

	/**
	 * The user cleared history: a global mark. Expanding it into per-row deletes
	 * would destroy an append-only archive on a button press, so the retention
	 * rule owns what it means.
	 */
	private boolean historyCleared(JsonNode record) {
		return tombstone("history-cleared", "*",
			Moments.store(Moments.parse(Json.moment(record, "deleted_at"))),
			Json.textOr(record, "source", "local"));
	}

	// --- the import kinds ---------------------------------------------------
	//
	// The producer's six kinds describe live events; an existing hister cache is
	// rows captured earlier. These three carry a stored row as it was, which is
	// what makes an import lossless: the reference /api/add path stamps
	// added/updated/add_count itself, so replaying a cache through it rewrites
	// the capture time that every date query and the demotion axis depend on.

	private boolean importDocument(JsonNode record) {
		String url = Json.text(record, "url");
		if (url == null || url.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("document record without url");
		}
		String suppliedNorm = Json.text(record, "norm_url");
		// An explicit norm_url is the importer's own key and is kept verbatim, so
		// a store whose canonicalisation differs is imported without collisions;
		// without one the URL is canonicalised, as every other path does.
		String norm = suppliedNorm == null || suppliedNorm.isEmpty()
			? CanonicalUrl.normalise(url) : suppliedNorm;
		long owner = Json.numberOr(record, "owner", Json.numberOr(record, "user_id", 0));
		long now = Instant.now().getEpochSecond();
		long added = epochSeconds(record, "added", now);
		long updated = epochSeconds(record, "updated", added);
		long addCount = Json.numberOr(record, "add_count", 1);
		int inserted = writer.update(
			"INSERT OR IGNORE INTO document(owner, norm_url, url, title, text, html, favicon,"
				+ " language, label, added, updated, add_count, type, metadata)"
				+ " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			owner, norm, url, Json.text(record, "title"), Json.text(record, "text"),
			Json.text(record, "html"), Json.text(record, "favicon"), Json.text(record, "language"),
			Json.text(record, "label"), added, updated, addCount,
			Json.numberOr(record, "type", 0), metadata.normalise(record.get("metadata")));
		if (inserted == 0) {
			// First write wins: a replayed import must not bump add_count or
			// rewrite the capture time.
			return false;
		}
		if (owner == 0) {
			// The index serves the single-user face, which reads owner 0; another
			// owner's row is stored losslessly and is not searchable there.
			index.indexDocument(0, norm, added, url,
				Json.text(record, "title"), Json.text(record, "text"));
		}
		return true;
	}

	private static long epochSeconds(JsonNode record, String field, long fallback) {
		Object value = Json.moment(record, field);
		return value == null ? fallback : Moments.parse(value).getEpochSecond();
	}

	/**
	 * One rule row as the reference store keeps it: the four pattern lists
	 * newline-joined, and the alias map as a single object row. The reference
	 * daemon reads only the four names and ignores the rest, so the alias row is
	 * additive data it tolerates.
	 */
	private boolean importRule(JsonNode record) {
		String name = Json.textOr(record, "name", "");
		if (name.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("rule record without name");
		}
		JsonNode patterns = record.get("patterns");
		if (patterns == null || patterns.isNull()) {
			throw new LakehouseProblems.BadRequestException("rule record without patterns");
		}
		String stored;
		if (Daemon.ALIAS_RULE.equals(name)) {
			if (!patterns.isObject()) {
				throw new LakehouseProblems.BadRequestException("aliases must be an object");
			}
			stored = mapper.writeValueAsString(patterns);
		} else {
			List<String> values = new ArrayList<>();
			if (patterns.isArray()) {
				for (JsonNode pattern : patterns) {
					values.add(pattern.asString());
				}
			} else {
				values.add(patterns.asString());
			}
			for (String pattern : values) {
				try {
					Pattern.compile(pattern);
				} catch (PatternSyntaxException exception) {
					throw new LakehouseProblems.BadRequestException(
						name + ": " + exception.getDescription(), exception);
				}
			}
			stored = String.join("\n", values);
		}
		List<String> existing = writer.queryForList(
			"SELECT patterns FROM rule WHERE name = ?", String.class, name);
		if (!existing.isEmpty() && existing.get(0).equals(stored)) {
			return false;
		}
		writer.update(
			"INSERT INTO rule(name, patterns) VALUES(?,?)"
				+ " ON CONFLICT(name) DO UPDATE SET patterns=excluded.patterns",
			name, stored);
		return true;
	}

	/**
	 * One click row with its own timestamp. The insert is idempotent on the row's
	 * content, because the click table has no natural key to conflict on and a
	 * replayed import must not double the history.
	 */
	private boolean importClick(JsonNode record) {
		String url = Json.textOr(record, "url", "");
		if (url.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("click record without url");
		}
		long added = epochSeconds(record, "added", Instant.now().getEpochSecond());
		String title = Json.text(record, "title");
		String query = Json.text(record, "query");
		int inserted = writer.update(
			"INSERT INTO click(url, title, query, added) SELECT ?,?,?,?"
				+ " WHERE NOT EXISTS (SELECT 1 FROM click WHERE url = ? AND added = ?"
				+ " AND COALESCE(title, '') = COALESCE(?, '')"
				+ " AND COALESCE(query, '') = COALESCE(?, ''))",
			url, title, query, added, url, added, title, query);
		return inserted > 0;
	}

	/** SQLite answers a NULL INTEGER through getLong; the flag is the only signal. */
	private static Long nullableLong(ResultSet resultSet, String column) throws SQLException {
		long value = resultSet.getLong(column);
		return resultSet.wasNull() ? null : value;
	}

	/**
	 * A page or bookmark mark names one identity, so the first sighting is the
	 * fact. A history clear is a timestamp: a second clear must move the mark
	 * forward, or the visits between the two clears stay visible forever.
	 */
	private boolean tombstone(String kind, String key, String at, String source) {
		List<String> existing = writer.queryForList(
			"SELECT deleted_at FROM tombstone WHERE kind = ? AND key = ?", String.class, kind, key);
		if (!existing.isEmpty()) {
			if (!"history-cleared".equals(kind)) {
				return false;
			}
			String stored = existing.get(0);
			try {
				if (!Moments.parse(stored).isBefore(Moments.parse(at))) {
					return false;
				}
			} catch (RuntimeException unparseable) {
				// A malformed stored mark must not hide a newer clear.
				if (stored.compareTo(at) >= 0) {
					return false;
				}
			}
			writer.update(
				"UPDATE tombstone SET deleted_at = ?, source = ? WHERE kind = ? AND key = ?",
				at, source, kind, key);
			return true;
		}
		writer.update(
			"INSERT INTO tombstone(kind, key, deleted_at, source) VALUES(?,?,?,?)",
			kind, key, at, source);
		return true;
	}
}
