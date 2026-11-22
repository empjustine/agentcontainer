package com.example.sbex.lakehouse;

import java.io.OutputStream;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.core.JsonGenerator;
import tools.jackson.databind.json.JsonMapper;

/**
 * The Promnesia face, pinned from upstream's server.py: the visit envelope, the
 * batch visited check and the visit search (docs/d205).
 *
 * WHY every read streams: a visited check carries up to five thousand URLs and
 * a page's visit list is unbounded, so the envelope is written as the cursor
 * yields rows. The heap cost of an export is one row, not the result set — the
 * same rule sbex/servlet-vs-reactive.md states for the report endpoint.
 */
@Component
class PromnesiaService {

	private static final Logger log = LoggerFactory.getLogger(PromnesiaService.class);

	private static final int VISITED_FETCH = 200;
	private static final int SEARCH_LIMIT = 500;

	/**
	 * A removed page hides its visits, but the presence row survives: "have I
	 * seen this URL" stays true for an archive, and only the visit list answers
	 * a deletion (docs/d204's append-only rule, docs/d205's pending erasure).
	 */
	private static final String VISIT_SELECT =
		"SELECT visit.*, COALESCE(NULLIF(visit.locator_title, ''), page_title.title) AS effective_title"
			+ " FROM visit LEFT JOIN page_title ON page_title.norm_url = visit.norm_url";

	/**
	 * A global clear hides every visit up to its timestamp, while the rows and
	 * the presence mark stay. julianday() compares instants, so an older row
	 * stored with a numeric offset is not hidden by lexical accident.
	 */
	private static final String VISIBLE_VISIT =
		" AND NOT EXISTS (SELECT 1 FROM tombstone t"
			+ " WHERE t.kind='visit-removed' AND t.key = visit.norm_url)"
			+ " AND NOT EXISTS (SELECT 1 FROM tombstone t"
			+ " WHERE t.kind='history-cleared' AND t.key = '*'"
			+ " AND julianday(visit.dt) <= julianday(t.deleted_at))";

	private static final String VISITS_PREDICATE =
		" WHERE (visit.norm_url = ? OR (visit.context IS NOT NULL"
			+ " AND substr(visit.norm_url, 1, ?) = ? AND visit.norm_url != ?))";

	private static final String SEARCH_PREDICATE =
		" WHERE (visit.norm_url LIKE ? ESCAPE '\\'"
			+ " OR visit.orig_url LIKE ? ESCAPE '\\'"
			+ " OR visit.context LIKE ? ESCAPE '\\'"
			+ " OR COALESCE(NULLIF(visit.locator_title, ''), page_title.title) LIKE ? ESCAPE '\\')";

	private final JdbcTemplate reader;
	private final LakehouseProperties properties;
	private final JsonMapper mapper;

	PromnesiaService(@Qualifier("readerJdbc") JdbcTemplate reader, LakehouseProperties properties, JsonMapper mapper) {
		this.reader = reader;
		this.properties = properties;
		this.mapper = mapper;
	}

	// --- /visits, /search, /search_around -----------------------------------

	void streamVisits(String url, OutputStream output) {
		String norm = CanonicalUrl.normalise(url);
		streamEnvelope(url, norm, output, statement -> {
			statement.setString(1, norm);
			statement.setInt(2, norm.length());
			statement.setString(3, norm);
			statement.setString(4, norm);
		}, VISITS_PREDICATE + VISIBLE_VISIT + " ORDER BY julianday(visit.dt)");
	}

	void streamSearch(String text, OutputStream output) {
		String needle = "%" + escapeLike(text.strip()) + "%";
		streamEnvelope(text, text.strip(), output, statement -> {
			for (int index = 1; index <= 4; index++) {
				statement.setString(index, needle);
			}
		}, SEARCH_PREDICATE + VISIBLE_VISIT + " ORDER BY julianday(visit.dt) DESC LIMIT " + SEARCH_LIMIT);
	}

	void streamSearchAround(double timestamp, OutputStream output) {
		Instant centre = Instant.ofEpochSecond((long) timestamp);
		String start = Moments.store(centre.minusSeconds(3 * 3600));
		String end = Moments.store(centre.plusSeconds(120));
		// Upstream answers with this literal placeholder URL and its extension
		// ignores the envelope's URL fields here, so mirroring keeps a stock
		// client's logs identical.
		streamEnvelope("http://dummy.org", "http://dummy.org", output, statement -> {
			statement.setString(1, start);
			statement.setString(2, end);
		}, " WHERE julianday(visit.dt) BETWEEN julianday(?) AND julianday(?)"
			+ VISIBLE_VISIT + " ORDER BY julianday(visit.dt)");
	}

	/** The statement binder a predicate needs, so one envelope writer serves three reads. */
	@FunctionalInterface
	private interface Binder {
		void bind(PreparedStatement statement) throws SQLException;
	}

	private void streamEnvelope(
			String originalUrl, String normalisedUrl, OutputStream output, Binder binder, String tail) {
		try (JsonGenerator json = mapper.createGenerator(output)) {
			json.writeStartObject();
			json.writeName("original_url");
			json.writeString(originalUrl);
			json.writeName("normalised_url");
			json.writeString(normalisedUrl);
			json.writeName("visits");
			json.writeStartArray();
			reader.execute((ConnectionCallback<Void>) connection -> {
				streamRows(connection, VISIT_SELECT + tail, binder, json);
				return null;
			});
			json.writeEndArray();
			json.writeEndObject();
		}
	}

	private void streamRows(Connection connection, String sql, Binder binder, JsonGenerator json)
			throws SQLException {
		try (PreparedStatement statement = connection.prepareStatement(sql)) {
			binder.bind(statement);
			// The cursor is the bound, not a fetch buffer: sqlite-jdbc reads a
			// row at a time and the writer is already producing JSON into the
			// response while the read continues.
			statement.setFetchSize(VISITED_FETCH);
			try (ResultSet rows = statement.executeQuery()) {
				while (rows.next()) {
					writeVisit(json, rows, true);
				}
			}
		}
	}

	private void writeVisit(JsonGenerator json, ResultSet row, boolean hasEffectiveTitle) throws SQLException {
		json.writeStartObject();
		json.writeName("dt");
		json.writeString(Moments.promnesia(Moments.parse(row.getString("dt"))));
		String src = row.getString("src");
		json.writeName("src");
		json.writeString(src == null || src.isEmpty() ? "unnamed" : src);
		json.writeName("context");
		json.writeString(row.getString("context"));
		json.writeName("duration");
		double duration = row.getDouble("duration");
		if (row.wasNull()) {
			json.writeNull();
		} else {
			json.writeNumber(duration);
		}
		json.writeName("locator");
		json.writeStartObject();
		json.writeName("title");
		json.writeString(hasEffectiveTitle ? row.getString("effective_title") : row.getString("locator_title"));
		json.writeName("href");
		json.writeString(row.getString("locator_href"));
		json.writeEndObject();
		json.writeName("original_url");
		json.writeString(row.getString("orig_url"));
		json.writeName("normalised_url");
		json.writeString(row.getString("norm_url"));
		json.writeEndObject();
	}

	// --- /visited ----------------------------------------------------------

	/**
	 * A presence row wins; a captured document answers when no visit exists yet
	 * (the hister extension posts content and the slurper may lag behind it).
	 * The array is written one answer at a time, never built.
	 */
	void streamVisited(List<String> urls, OutputStream output) {
		try (JsonGenerator json = mapper.createGenerator(output)) {
			json.writeStartArray();
			for (String raw : urls) {
				String norm = CanonicalUrl.normalise(raw);
				writePresence(json, norm);
			}
			json.writeEndArray();
		}
	}

	private void writePresence(JsonGenerator json, String norm) {
		List<Map<String, Object>> presence = reader.queryForList(
			"SELECT * FROM presence WHERE norm_url = ?", norm);
		if (!presence.isEmpty()) {
			Map<String, Object> row = presence.get(0);
			json.writeStartObject();
			json.writeName("dt");
			json.writeString(Moments.promnesia(Moments.parse((String) row.get("dt"))));
			json.writeName("src");
			Object src = row.get("src");
			json.writeString(src == null || src.toString().isEmpty() ? "unnamed" : src.toString());
			json.writeName("context");
			json.writeString((String) row.get("context"));
			json.writeName("duration");
			Object duration = row.get("duration");
			if (duration == null) {
				json.writeNull();
			} else {
				json.writeNumber(((Number) duration).doubleValue());
			}
			json.writeName("locator");
			json.writeStartObject();
			json.writeName("title");
			json.writeString((String) row.get("locator_title"));
			json.writeName("href");
			json.writeString((String) row.get("locator_href"));
			json.writeEndObject();
			json.writeName("original_url");
			json.writeString((String) row.get("orig_url"));
			json.writeName("normalised_url");
			json.writeString(norm);
			json.writeEndObject();
			return;
		}
		List<Map<String, Object>> documents = reader.queryForList(
			"SELECT * FROM document WHERE norm_url = ? ORDER BY owner LIMIT 1", norm);
		if (documents.isEmpty()) {
			json.writeNull();
			return;
		}
		Map<String, Object> document = documents.get(0);
		String title = (String) document.get("title");
		String url = (String) document.get("url");
		json.writeStartObject();
		json.writeName("dt");
		json.writeString(Moments.promnesia(Instant.ofEpochSecond(((Number) document.get("added")).longValue())));
		json.writeName("src");
		json.writeString("hister");
		json.writeName("context");
		json.writeString(title);
		json.writeName("duration");
		json.writeNull();
		json.writeName("locator");
		json.writeStartObject();
		json.writeName("title");
		json.writeString(title);
		json.writeName("href");
		json.writeString(url);
		json.writeEndObject();
		json.writeName("original_url");
		json.writeString(url);
		json.writeName("normalised_url");
		json.writeString(norm);
		json.writeEndObject();
	}

	// --- /status -----------------------------------------------------------

	/**
	 * /status answers even when the store is broken, with the failure in stats:
	 * the extension's own liveness probe must not depend on the store it is
	 * probing (docs/d205).
	 */
	Map<String, Object> status() {
		Map<String, Object> stats = new LinkedHashMap<>();
		try {
			stats.put("total_visits", count("SELECT count(*) FROM visit"));
			stats.put("documents", count("SELECT count(*) FROM document"));
			stats.put("tombstones", count("SELECT count(*) FROM tombstone"));
		} catch (DataAccessException exception) {
			log.error("status store", exception);
			stats = new LinkedHashMap<>();
			stats.put("ERROR", "store error");
		}
		Map<String, Object> response = new LinkedHashMap<>();
		response.put("version", Daemon.VERSION);
		response.put("db", properties.store());
		response.put("stats", stats);
		return response;
	}

	private long count(String sql) {
		Long count = reader.queryForObject(sql, Long.class);
		return count == null ? 0 : count;
	}

	/** Escape LIKE metacharacters: a literal search for 100% is not a wildcard. */
	private static String escapeLike(String value) {
		return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
	}
}
