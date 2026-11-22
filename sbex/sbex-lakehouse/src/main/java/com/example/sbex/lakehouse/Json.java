package com.example.sbex.lakehouse;

import tools.jackson.databind.JsonNode;

/**
 * The record readers the streaming ingest uses. One record is a small tree
 * (the envelope is streamed, the record is not), so these helpers only make
 * the absent-versus-empty distinction explicit: a record's title may be
 * missing (keep the stored one) or empty (a real, blank title), and the
 * bookmark merge rule depends on telling them apart.
 */
final class Json {

	private Json() {
	}

	/** A string field, or null when it is absent or JSON null. */
	static String text(JsonNode node, String field) {
		JsonNode value = node == null ? null : node.get(field);
		return value == null || value.isNull() ? null : value.asString();
	}

	/** A string field for a producer's own default ('' becomes the fallback). */
	static String textOr(JsonNode node, String field, String fallback) {
		String value = text(node, field);
		return value == null || value.isEmpty() ? fallback : value;
	}

	/** The value as the time parser reads it: absent, number or text. */
	static Object moment(JsonNode node, String field) {
		JsonNode value = node == null ? null : node.get(field);
		if (value == null || value.isNull()) {
			return null;
		}
		return scalar(value);
	}

	/** A number as a Long, or null for anything else. */
	static Long number(JsonNode node, String field) {
		JsonNode value = node == null ? null : node.get(field);
		if (value == null || !value.isNumber()) {
			return null;
		}
		return value.asLong();
	}

	static long numberOr(JsonNode node, String field, long fallback) {
		Long value = number(node, field);
		return value == null ? fallback : value;
	}

	/** A JSON scalar as the Java value the time parser and the store take. */
	static Object scalar(JsonNode value) {
		if (value == null || value.isNull()) {
			return null;
		}
		if (value.isNumber()) {
			return value.asDouble();
		}
		if (value.isBoolean()) {
			return value.asBoolean();
		}
		return value.asString();
	}
}
