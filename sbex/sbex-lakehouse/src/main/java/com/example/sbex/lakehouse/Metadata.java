package com.example.sbex.lakehouse;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * A capture's metadata in the one object form the reference store keeps: the
 * producer's content script sends a JSON *string*, a hand-written client sends
 * an object, and the daemon stores the object compactly (`json.dumps` with the
 * compact separators). Jackson's default output is that same compact object
 * text, so a row this service writes is the row the reference would have
 * written.
 */
@Component
final class Metadata {

	private final JsonMapper mapper;

	Metadata(JsonMapper mapper) {
		this.mapper = mapper;
	}

	/** The compact object JSON, or null when the producer sent nothing. */
	String normalise(JsonNode metadata) {
		if (metadata == null || metadata.isNull() || (metadata.isString() && metadata.asString().isEmpty())) {
			return null;
		}
		JsonNode value = metadata;
		if (metadata.isString()) {
			try {
				value = mapper.readTree(metadata.asString());
			} catch (RuntimeException notJson) {
				Map<String, Object> raw = new LinkedHashMap<>();
				raw.put("raw", metadata.asString());
				value = mapper.valueToTree(raw);
			}
		}
		return mapper.writeValueAsString(value);
	}
}
