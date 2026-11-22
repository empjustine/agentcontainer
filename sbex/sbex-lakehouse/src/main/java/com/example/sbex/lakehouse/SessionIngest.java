package com.example.sbex.lakehouse;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import tools.jackson.core.JsonParser;
import tools.jackson.core.JsonToken;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * POST /ingest/session: the host-side, write-only sink of docs/d181. One JSON
 * row or an array of them, keyed on the transcript's own session and entry ids,
 * appended to the spool only when the row is new.
 *
 * WHY the identity is the row's, never the spool line: the sender renames the
 * live tail to `.rm.<pid>` and a direct fold renumbers the same line on every
 * run, so a file/line key minted a new primary key each time and the warehouse
 * stored a duplicate (docs/d221). A row without an identity is keyed by the
 * SHA-256 of its canonical JSON.
 */
@Component
class SessionIngest {

	private static final Logger log = LoggerFactory.getLogger(SessionIngest.class);

	private final SessionSpool spool;
	private final LakehouseProperties properties;
	private final JsonMapper mapper;

	SessionIngest(SessionSpool spool, LakehouseProperties properties, JsonMapper mapper) {
		this.spool = spool;
		this.properties = properties;
		this.mapper = mapper;
	}

	record Ack(int accepted, int duplicates) {}

	private static final class Counters {
		private int accepted;
		private int duplicates;

		int total() {
			return accepted + duplicates;
		}
	}

	Ack ingest(InputStream body) {
		Counters counters = new Counters();
		List<String> fresh = new ArrayList<>();
		try (SessionSpool.Append append = spool.append();
				JsonParser parser = mapper.createParser(body)) {
			try {
				JsonToken first = parser.nextToken();
				if (first == JsonToken.START_ARRAY) {
					while (parser.nextToken() != JsonToken.END_ARRAY) {
						appendRow(parser.readValueAsTree(), append, fresh, counters);
					}
				} else if (first == JsonToken.START_OBJECT) {
					appendRow(parser.readValueAsTree(), append, fresh, counters);
				} else {
					throw new LakehouseProblems.BadRequestException(
						"body must be an object or an array of objects");
				}
			} catch (RuntimeException refusal) {
				// The body was refused after some rows had landed: truncate the
				// tail back to where this batch started on close, so no partial
				// batch is ever consumed.
				append.fail();
				throw refusal;
			}
		} catch (IOException cannotAppend) {
			log.error("cannot append to the spool", cannotAppend);
			throw new LakehouseProblems.StoreUnavailableException("cannot append to the spool", cannotAppend);
		}
		// Keys are recorded only after the append: marking first would let a
		// disk-full append lose the rows forever, because the replay would then be
		// answered as a duplicate (docs/d181).
		spool.remember(fresh);
		spool.fold(false);
		return new Ack(counters.accepted, counters.duplicates);
	}

	private void appendRow(JsonNode row, SessionSpool.Append append, List<String> fresh, Counters counters) {
		String key = rowKey(row, mapper);
		if (spool.seen(key, fresh)) {
			counters.duplicates++;
		} else {
			append.line(JsJson.compact(row));
			counters.accepted++;
		}
		if (counters.total() > properties.ingestMaxRows()) {
			throw new LakehouseProblems.PayloadTooLargeException(
				"too many rows (limit " + properties.ingestMaxRows() + ")");
		}
	}

	/**
	 * The row's natural identity, in the daemon's spelling. pi keeps the
	 * [entry, session_id, entry_id] key; a foreign harness carries its source, so
	 * the same id string from two harnesses is two rows (docs/d221).
	 */
	static String rowKey(JsonNode row, JsonMapper mapper) {
		if (row != null && row.isObject()) {
			String source = Json.text(row, "source");
			String sessionId = Json.text(row, "session_id");
			String id = Json.text(row, "id");
			String messageId = Json.text(row, "message_id");
			String sessionFile = Json.text(row, "session_file");
			if (source != null && !source.isEmpty() && !"pi".equals(source)) {
				if (id != null && !id.isEmpty()) {
					return json(mapper, List.of("entry", source, sessionId == null ? "" : sessionId, id));
				}
				if (messageId != null && !messageId.isEmpty()) {
					return json(mapper,
						List.of("message", source, sessionId == null ? "" : sessionId, messageId));
				}
				return json(mapper, List.of("row", source, rowHash(row)));
			}
			if (sessionId != null && !sessionId.isEmpty() && id != null && !id.isEmpty()) {
				return json(mapper, List.of("entry", sessionId, id));
			}
			if (sessionId != null && !sessionId.isEmpty()) {
				return json(mapper, List.of("session", sessionId));
			}
			if (sessionFile != null && !sessionFile.isEmpty() && id != null && !id.isEmpty()) {
				return json(mapper, List.of("entry", sessionFile, id));
			}
			if (sessionFile != null && !sessionFile.isEmpty()) {
				return json(mapper, List.of("session", sessionFile));
			}
		}
		return json(mapper, List.of("raw", rowHash(row)));
	}

	/** A spool line's identity; an unreadable line is keyed by its own bytes. */
	static String lineKey(String line, JsonMapper mapper) {
		try {
			return rowKey(mapper.readTree(line), mapper);
		} catch (RuntimeException malformed) {
			return json(mapper, List.of("raw-line", sha256(line)));
		}
	}

	/**
	 * The content identity of a row that carries no id of its own, hashed from
	 * canonical JSON (sorted keys, so a re-post with a different key order is the
	 * same row) in the reference daemon's spelling, including its number
	 * formatting — a row posted before the switch and re-posted after it must be
	 * the same row, or the warehouse stores it twice.
	 */
	static String rowHash(JsonNode row) {
		return sha256(JsJson.canonical(row));
	}

	private static String json(JsonMapper mapper, List<String> parts) {
		return mapper.writeValueAsString(parts);
	}

	private static String sha256(String value) {
		try {
			MessageDigest digest = MessageDigest.getInstance("SHA-256");
			return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
		} catch (NoSuchAlgorithmException impossible) {
			throw new IllegalStateException("SHA-256 is required", impossible);
		}
	}
}
