package com.example.sbex.lakehouse;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The small query dialect /search and /api/delete share (docs/d205, Search):
 * terms, quoted phrases, field:value filters, sort:, limit:, date bounds and
 * match-all.
 *
 * WHY not hister's full Bleve query-string language: the stock extension sends
 * a handful of shapes and the delete action sends url:"…" or domain:…; a full
 * parser would answer queries no client sends while drifting from the ones it
 * does. Every clause below maps to one index or document column.
 *
 * @param text the raw query text, echoed back
 * @param terms analysed terms; a trailing '*' is a prefix expansion
 * @param phrases quoted phrases, matched as candidate filters
 * @param filters field:value clauses, each HNEGATED by a leading '-'
 * @param matchAll the literal '*' form, which scans the documents table
 * @param sort "", "date", "-date", "added" or "-added"
 * @param limit the page size the caller asked for, before clamping
 * @param offset the page start
 * @param dateFrom inclusive epoch-seconds lower bound on added
 * @param dateTo inclusive epoch-seconds upper bound on added
 * @param includeText whether the full body is returned instead of a snippet
 * @param includeHtml whether the stored HTML is returned
 * @param priority the operator's boost patterns, from the stored rules
 */
record SearchQuery(
		String text,
		List<String> terms,
		List<String> phrases,
		List<Filter> filters,
		boolean matchAll,
		String sort,
		Integer limit,
		int offset,
		Long dateFrom,
		Long dateTo,
		boolean includeText,
		boolean includeHtml,
		List<String> priority) {

	static final int DEFAULT_LIMIT = 20;
	static final int MAX_LIMIT = 100;
	static final int MAX_TERMS = 16;

	private static final String MATCH_ALL_TOKEN = "*";
	private static final String SORT_FIELD = "sort";
	private static final String LIMIT_FIELD = "limit";

	private static final Set<String> FILTER_NAMES =
		Set.of("url", "domain", "site", "title", "label", "language", "type", "id");

	/** One field:value clause; a negated clause must not match. */
	record Filter(String name, String value, boolean negate) {}

	/** The mutable result of tokenising, before the params merge. */
	private record Parsed(
		List<String> terms, List<String> phrases, List<Filter> filters, boolean matchAll,
		String sort, java.util.OptionalInt limit) {}

	SearchQuery withPriority(List<String> patterns) {
		return new SearchQuery(text, terms, phrases, filters, matchAll, sort, limit, offset,
			dateFrom, dateTo, includeText, includeHtml, patterns);
	}

	/** The GET shape: query parameters, whose 'query' entry may carry a JSON object. */
	static SearchQuery fromParams(Map<String, List<String>> params, JsonMapper mapper) {
		Map<String, String> scalars = new LinkedHashMap<>();
		params.forEach((key, values) -> {
			if (!values.isEmpty()) {
				scalars.put(key, values.get(0));
			}
		});
		return build(scalars, jsonObject(scalars.get("query"), mapper), mapper);
	}

	/** The POST shape: an object body, whose 'query' field may be an object or a string. */
	static SearchQuery fromBody(JsonNode body, JsonMapper mapper) {
		Map<String, String> scalars = new LinkedHashMap<>();
		if (body != null) {
			body.properties().forEach(entry -> {
				JsonNode value = entry.getValue();
				if (value != null && !value.isNull() && !value.isObject()) {
					scalars.put(entry.getKey(), scalarText(value));
				}
			});
		}
		JsonNode queryObject = body == null ? null : jsonObject(body.get("query"), mapper);
		return build(scalars, queryObject, mapper);
	}

	/**
	 * The dialect itself. shlex.split's quoting is kept because a producer's
	 * phrase carries spaces, and a bare URL (the extension's older delete
	 * action) becomes an exact url: filter rather than a parse failure.
	 */
	private static Parsed parse(String text) {
		List<String> tokens = tokenize(text == null ? "" : text);
		if (tokens.size() == 1
				&& (tokens.get(0).toLowerCase(Locale.ROOT).startsWith("http://")
					|| tokens.get(0).toLowerCase(Locale.ROOT).startsWith("https://"))) {
			tokens = List.of("url:" + tokens.get(0));
		}
		List<String> terms = new ArrayList<>();
		List<String> phrases = new ArrayList<>();
		List<Filter> filters = new ArrayList<>();
		boolean matchAll = false;
		String sort = "";
		java.util.OptionalInt parsedLimit = java.util.OptionalInt.empty();
		for (String token : tokens) {
			boolean negate = token.startsWith("-");
			String body = negate ? token.substring(1) : token;
			if (body.isEmpty()) {
				continue;
			}
			if (MATCH_ALL_TOKEN.equals(body)) {
				matchAll = true;
				continue;
			}
			int colon = body.indexOf(':');
			if (colon > 0) {
				String name = body.substring(0, colon).toLowerCase(Locale.ROOT);
				String value = body.substring(colon + 1);
				if (SORT_FIELD.equals(name)) {
					sort = value;
					continue;
				}
				if (LIMIT_FIELD.equals(name)) {
					try {
						parsedLimit = java.util.OptionalInt.of(Integer.parseInt(value));
					} catch (NumberFormatException exception) {
						throw new LakehouseProblems.BadRequestException("bad limit '" + value + "'", exception);
					}
					continue;
				}
				if (FILTER_NAMES.contains(name) && !value.isEmpty()) {
					filters.add(new Filter(name, value, negate));
					continue;
				}
			}
			if (body.indexOf(' ') >= 0) {
				String phrase = body.strip();
				phrases.add(phrase);
				for (String term : SearchIndex.analyse(phrase)) {
					if (!terms.contains(term)) {
						terms.add(term);
					}
				}
				continue;
			}
			if (body.endsWith("*")) {
				String stem = String.join("", SearchIndex.analyse(body.substring(0, body.length() - 1)));
				if (!stem.isEmpty() && !terms.contains(stem + "*")) {
					terms.add(stem + "*");
				}
				continue;
			}
			for (String term : SearchIndex.analyse(body)) {
				if (!terms.contains(term)) {
					terms.add(term);
				}
			}
		}
		List<String> capped = terms.size() > MAX_TERMS ? new ArrayList<>(terms.subList(0, MAX_TERMS)) : terms;
		return new Parsed(capped, phrases, filters, matchAll, sort, parsedLimit);
	}

	private static SearchQuery build(Map<String, String> scalars, JsonNode queryObject, JsonMapper mapper) {
		String text = firstNonNull(value(scalars, queryObject, "text"), value(scalars, queryObject, "q"));
		Parsed parsed = parse(text == null ? "" : text);
		boolean matchAll = parsed.matchAll() || truthy(value(scalars, queryObject, "match_all"));
		String sort = value(scalars, queryObject, "sort");
		if (sort == null) {
			sort = "";
		}
		int offset = 0;
		String pageKey = value(scalars, queryObject, "page_key");
		if (pageKey != null && !pageKey.isEmpty()) {
			offset = pageOffset(pageKey, mapper);
		}
		String offsetValue = value(scalars, queryObject, "offset");
		if (offsetValue != null && !offsetValue.isEmpty()) {
			try {
				offset = Integer.parseInt(offsetValue.trim());
			} catch (NumberFormatException exception) {
				throw new LakehouseProblems.BadRequestException("bad offset '" + offsetValue + "'", exception);
			}
		}
		offset = Math.max(0, offset);
		String limitValue = value(scalars, queryObject, "limit");
		int limit;
		if (limitValue == null || limitValue.isEmpty()) {
			limit = parsed.limit().isPresent() ? parsed.limit().getAsInt() : DEFAULT_LIMIT;
		} else {
			try {
				limit = Integer.parseInt(limitValue.trim());
			} catch (NumberFormatException exception) {
				throw new LakehouseProblems.BadRequestException("bad limit '" + limitValue + "'", exception);
			}
		}
		limit = Math.max(1, Math.min(MAX_LIMIT, limit));
		return new SearchQuery(
			text == null ? "" : text,
			parsed.terms(),
			parsed.phrases(),
			parsed.filters(),
			matchAll,
			sort,
			limit,
			offset,
			dateBound(value(scalars, queryObject, "date_from"), false),
			dateBound(value(scalars, queryObject, "date_to"), true),
			truthy(value(scalars, queryObject, "include_text")),
			truthy(value(scalars, queryObject, "include_html")),
			List.of());
	}

	/** A scalar from the query object, overridden by the same-named parameter. */
	private static String value(Map<String, String> scalars, JsonNode queryObject, String name) {
		if (scalars.containsKey(name)) {
			return scalars.get(name);
		}
		if (queryObject == null) {
			return null;
		}
		JsonNode node = queryObject.get(name);
		if (node == null || node.isNull()) {
			return null;
		}
		return scalarText(node);
	}

	private static String scalarText(JsonNode node) {
		if (node.isArray()) {
			return node.size() == 0 ? null : scalarText(node.get(0));
		}
		if (node.isNull()) {
			return null;
		}
		return node.asString();
	}

	/** page_key is the paging cursor: {"offset":N}, or a bare integer. */
	private static int pageOffset(String pageKey, JsonMapper mapper) {
		String trimmed = pageKey.trim();
		if (trimmed.startsWith("{")) {
			JsonNode decoded = readTree(trimmed, mapper);
			if (decoded != null && decoded.isObject()) {
				JsonNode offset = decoded.get("offset");
				if (offset != null && offset.isNumber()) {
					return offset.asInt();
				}
			}
			return 0;
		}
		try {
			return Integer.parseInt(trimmed);
		} catch (NumberFormatException exception) {
			throw new LakehouseProblems.BadRequestException("bad page_key '" + pageKey + "'", exception);
		}
	}

	/**
	 * A date bound compares instants: a plain day is widened to its start or
	 * end in UTC, because the store keeps UTC and a lexical compare of a
	 * local-day string would sort the wrong instant.
	 */
	private static Long dateBound(String value, boolean end) {
		if (value == null || value.isEmpty()) {
			return null;
		}
		String trimmed = value.trim();
		if (isDigits(trimmed)) {
			return Long.parseLong(trimmed);
		}
		try {
			LocalDate day = LocalDate.parse(trimmed.length() > 10 ? trimmed.substring(0, 10) : trimmed);
			Instant at = end
				? day.atTime(LocalTime.MAX).toInstant(ZoneOffset.UTC)
				: day.atStartOfDay().toInstant(ZoneOffset.UTC);
			return at.getEpochSecond();
		} catch (DateTimeParseException unparseable) {
			return null;
		}
	}

	private static boolean isDigits(String text) {
		if (text.isEmpty()) {
			return false;
		}
		for (int index = 0; index < text.length(); index++) {
			if (!Character.isDigit(text.charAt(index))) {
				return false;
			}
		}
		return true;
	}

	private static boolean truthy(String value) {
		return "1".equals(value) || "true".equalsIgnoreCase(value);
	}

	private static String firstNonNull(String first, String second) {
		return first == null ? second : first;
	}

	/** The nested query object, when the caller sent one as a string or an object. */
	private static JsonNode jsonObject(JsonNode node, JsonMapper mapper) {
		if (node == null || node.isNull()) {
			return null;
		}
		if (node.isObject()) {
			return node;
		}
		return jsonObject(node.asString(), mapper);
	}

	private static JsonNode jsonObject(String text, JsonMapper mapper) {
		if (text == null || text.strip().isEmpty()) {
			return null;
		}
		String trimmed = text.strip();
		if (!trimmed.startsWith("{")) {
			return null;
		}
		JsonNode parsed = readTree(trimmed, mapper);
		return parsed != null && parsed.isObject() ? parsed : null;
	}

	private static JsonNode readTree(String text, JsonMapper mapper) {
		try {
			return mapper.readTree(text);
		} catch (RuntimeException exception) {
			throw new LakehouseProblems.BadRequestException(
				"invalid query json: " + exception.getMessage(), exception);
		}
	}

	/**
	 * A tiny shlex: whitespace separates, single and double quotes group, and a
	 * backslash escapes the next character outside single quotes. An unbalanced
	 * quote is a 400, as shlex raises.
	 */
	static List<String> tokenize(String text) {
		List<String> tokens = new ArrayList<>();
		StringBuilder token = new StringBuilder();
		boolean started = false;
		char quote = 0;
		int index = 0;
		while (index < text.length()) {
			char character = text.charAt(index);
			index++;
			if (quote != 0) {
				if (character == quote) {
					quote = 0;
				} else if (character == '\\' && quote == '"' && index < text.length()) {
					token.append(text.charAt(index));
					index++;
				} else {
					token.append(character);
				}
			} else if (character == '\\' && index < text.length()) {
				token.append(text.charAt(index));
				index++;
				started = true;
			} else if (character == '"' || character == '\'') {
				quote = character;
				started = true;
			} else if (Character.isWhitespace(character)) {
				if (started) {
					tokens.add(token.toString());
					token.setLength(0);
					started = false;
				}
			} else {
				token.append(character);
				started = true;
			}
		}
		if (quote != 0) {
			throw new LakehouseProblems.BadRequestException("invalid query: no closing quotation");
		}
		if (started) {
			tokens.add(token.toString());
		}
		return tokens;
	}
}
