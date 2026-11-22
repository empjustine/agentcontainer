package com.example.sbex.lakehouse;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The form body reader for the two endpoints the extension posts forms to
 * (/api/rules and /api/add). The field count is capped before parsing: a body
 * of a million tiny fields is as much a denial of service as a gigabyte one.
 */
final class Forms {

	private Forms() {
	}

	static Map<String, String> parse(String body, int maxFields) {
		Map<String, String> fields = new LinkedHashMap<>();
		if (body == null || body.isEmpty()) {
			return fields;
		}
		for (String part : body.split("&", -1)) {
			if (part.isEmpty()) {
				continue;
			}
			if (fields.size() >= maxFields) {
				throw new LakehouseProblems.PayloadTooLargeException(
					"more than " + maxFields + " form fields");
			}
			int equals = part.indexOf('=');
			String name = equals < 0 ? part : part.substring(0, equals);
			String value = equals < 0 ? "" : part.substring(equals + 1);
			String key = decode(name);
			if (!fields.containsKey(key)) {
				fields.put(key, decode(value));
			}
		}
		return fields;
	}

	private static String decode(String value) {
		try {
			return URLDecoder.decode(value, StandardCharsets.UTF_8);
		} catch (IllegalArgumentException malformed) {
			throw new LakehouseProblems.BadRequestException("invalid form body: " + malformed.getMessage(), malformed);
		}
	}
}
