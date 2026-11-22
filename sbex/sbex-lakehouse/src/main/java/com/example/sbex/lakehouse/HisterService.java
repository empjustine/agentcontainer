package com.example.sbex.lakehouse;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The hister face: captures, the operator's indexing rules, the click log and
 * the query dialect over the cold-shaped index (docs/d205).
 *
 * The shapes here are upstream's, because the stock extension reads them; the
 * SQL is the daemon's, because the store is the same one
 * (browse-daemon.py's hister section).
 */
@Component
class HisterService {

	private static final Logger log = LoggerFactory.getLogger(HisterService.class);

	private static final Set<String> RULE_NAMES = Set.of("allow", "skip", "priority", "versioning");
	private static final int SNIPPET_SIZE = 240;
	private static final int DOCUMENT_CHUNK = 500;

	private final JdbcTemplate writer;
	private final JdbcTemplate reader;
	private final TransactionTemplate transactions;
	private final SearchIndex index;
	private final JsonMapper mapper;
	private final Metadata metadata;

	HisterService(
			@Qualifier("writerJdbc") JdbcTemplate writer, @Qualifier("readerJdbc") JdbcTemplate reader,
			TransactionTemplate transactions,
			SearchIndex index, JsonMapper mapper, Metadata metadata) {
		this.writer = writer;
		this.reader = reader;
		this.transactions = transactions;
		this.index = index;
		this.mapper = mapper;
		this.metadata = metadata;
	}

	/** A stored capture, as the index and the document JSON read it. */
	record DocumentRow(
		long owner, String normUrl, String url, String title, String text, String html,
		String favicon, String language, String label, long added, long updated,
		long addCount, long type, String metadata) {}

	// --- rules: the hister control plane ------------------------------------

	@SuppressWarnings("unchecked")
	Map<String, Object> loadRules() {
		Map<String, Object> rules = new LinkedHashMap<>();
		Map<String, List<String>> lists = new LinkedHashMap<>();
		for (String name : List.of("allow", "skip", "priority", "versioning")) {
			lists.put(name, new ArrayList<>());
		}
		Map<String, Object> aliases = new LinkedHashMap<>();
		for (Map<String, Object> row : reader.queryForList("SELECT name, patterns FROM rule")) {
			String name = (String) row.get("name");
			if (Daemon.ALIAS_RULE.equals(name)) {
				// An import stores the alias map as one object row. The reference
				// daemon never wrote this row and skips unknown names, so it stays
				// compatible in both directions.
				try {
					aliases = new LinkedHashMap<>(mapper.readValue((String) row.get("patterns"), Map.class));
				} catch (RuntimeException unreadable) {
					log.warn("stored rule aliases are not an object; serving none");
				}
				continue;
			}
			if (!lists.containsKey(name)) {
				continue;
			}
			List<String> patterns = new ArrayList<>();
			for (String pattern : ((String) row.get("patterns")).split("\n")) {
				if (!pattern.isEmpty()) {
					patterns.add(pattern);
				}
			}
			lists.put(name, patterns);
		}
		rules.putAll(lists);
		rules.put("aliases", aliases);
		return rules;
	}

	/**
	 * The extension posts each list as one space-separated form value. The
	 * patterns are compiled here so a rule the extension accepted elsewhere
	 * cannot be stored and then break every later capture or search.
	 */
	void saveRules(Map<String, String> fields) {
		Map<String, String> updates = new LinkedHashMap<>();
		for (String name : RULE_NAMES) {
			String raw = fields.get(name);
			if (raw == null) {
				continue;
			}
			List<String> patterns = new ArrayList<>();
			for (String pattern : raw.strip().split("\\s+")) {
				if (pattern.isEmpty()) {
					continue;
				}
				try {
					Pattern.compile(pattern);
				} catch (PatternSyntaxException exception) {
					throw new LakehouseProblems.BadRequestException(
						name + ": " + exception.getDescription(), exception);
				}
				patterns.add(pattern);
			}
			updates.put(name, String.join("\n", patterns));
		}
		if (updates.isEmpty()) {
			return;
		}
		transactions.executeWithoutResult(status -> updates.forEach((name, patterns) -> writer.update(
			"INSERT INTO rule(name, patterns) VALUES(?,?)"
				+ " ON CONFLICT(name) DO UPDATE SET patterns=excluded.patterns",
			name, patterns)));
	}

	/**
	 * The server-side rule check docs/d205 requires of the capture path. An
	 * allow list is a whitelist: with patterns present, a URL matching none is
	 * not captured at all.
	 */
	boolean skipped(Map<String, Object> rules, String normUrl) {
		List<String> candidates = List.of(normUrl, "https://" + normUrl);
		if (matchesAny(patterns(rules, "skip"), candidates)) {
			return true;
		}
		List<Pattern> allow = patterns(rules, "allow");
		return !allow.isEmpty() && !matchesAny(allow, candidates);
	}

	@SuppressWarnings("unchecked")
	private static List<Pattern> patterns(Map<String, Object> rules, String name) {
		List<Pattern> compiled = new ArrayList<>();
		for (String pattern : (List<String>) rules.get(name)) {
			try {
				compiled.add(Pattern.compile(pattern));
			} catch (PatternSyntaxException stored) {
				// A rule stored before validation must not take the whole search
				// down; it simply does not match.
				continue;
			}
		}
		return compiled;
	}

	private static boolean matchesAny(List<Pattern> patterns, List<String> candidates) {
		for (Pattern pattern : patterns) {
			for (String candidate : candidates) {
				if (pattern.matcher(candidate).find()) {
					return true;
				}
			}
		}
		return false;
	}

	// --- captures ----------------------------------------------------------

	/**
	 * Upsert one captured document. The stored row, not the request, is the
	 * index's input: a metadata-only re-add (the extension's label and
	 * permission paths) keeps the stored body and must keep its postings
	 * identical (docs/d205).
	 */
	int add(JsonNode payload) {
		String url = Json.text(payload, "url");
		if (url == null || url.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("missing url");
		}
		String norm = CanonicalUrl.normalise(url);
		if (skipped(loadRules(), norm)) {
			return 406;
		}
		if (truthy(Json.scalar(payload.get("sensitive")))) {
			// docs/d205 asks for 422 on sensitive content, but extraction is the
			// producer's job, so only the producer's own verdict can raise it.
			return 422;
		}
		long now = Instant.now().getEpochSecond();
		String normalisedMetadata = metadata.normalise(payload.get("metadata"));
		transactions.executeWithoutResult(status -> {
			DocumentRow existing = document(0, norm);
			long added = existing == null ? now : existing.added();
			long addCount = existing == null ? 1 : existing.addCount() + 1;
			writer.update(
				"INSERT INTO document(owner, norm_url, url, title, text, html, favicon, language,"
					+ " label, added, updated, add_count, type, metadata)"
					+ " VALUES(0,?,?,?,?,?,?,?,?,?,?,?,?,?)"
					// A re-add that carries only the URL must not erase the stored
					// body, so an empty field keeps the stored value.
					+ " ON CONFLICT(owner, norm_url) DO UPDATE SET"
					+ " url=excluded.url,"
					+ " title=COALESCE(NULLIF(excluded.title,''), document.title),"
					+ " text=COALESCE(NULLIF(excluded.text,''), document.text),"
					+ " html=COALESCE(NULLIF(excluded.html,''), document.html),"
					+ " favicon=COALESCE(NULLIF(excluded.favicon,''), document.favicon),"
					+ " language=COALESCE(NULLIF(excluded.language,''), document.language),"
					+ " label=COALESCE(NULLIF(excluded.label,''), document.label),"
					+ " updated=excluded.updated, add_count=excluded.add_count, type=excluded.type,"
					+ " metadata=COALESCE(excluded.metadata, document.metadata)",
				norm, url, Json.text(payload, "title"), Json.text(payload, "text"),
				Json.text(payload, "html"), Json.text(payload, "favicon"),
				Json.text(payload, "language"), Json.text(payload, "label"),
				added, now, addCount, Json.numberOr(payload, "type", 0), normalisedMetadata);
			DocumentRow stored = document(writer, 0, norm);
			index.indexDocument(0, norm, stored.added(), stored.url(), stored.title(), stored.text());
			writer.update(
				"INSERT OR IGNORE INTO presence"
					+ "(norm_url, orig_url, dt, src, context, duration, locator_title, locator_href)"
					+ " VALUES(?,?,?,?,?,NULL,?,?)",
				norm, url, Moments.store(Instant.now()), "hister",
				Json.text(payload, "title"), Json.text(payload, "title"), url);
		});
		return 201;
	}

	/** The producer's own verdict, in the truthiness the daemon's Python reads. */
	private static boolean truthy(Object value) {
		if (value instanceof Boolean flag) {
			return flag;
		}
		if (value instanceof Number number) {
			return number.doubleValue() != 0;
		}
		return value instanceof String text && !text.isEmpty();
	}

	boolean label(String url, String label) {
		int updated = writer.update(
			"UPDATE document SET label = ? WHERE owner = 0 AND norm_url = ?",
			label, CanonicalUrl.normalise(url));
		return updated > 0;
	}

	void history(JsonNode payload) {
		JsonNode row = payload.get("resultData") != null && payload.get("resultData").isObject()
			? payload.get("resultData") : payload;
		String url = Json.text(row, "url");
		if (url == null || url.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("history row without url");
		}
		writer.update(
			"INSERT INTO click(url, title, query, added) VALUES(?,?,?,?)",
			url, Json.text(row, "title"), Json.text(row, "query"), Instant.now().getEpochSecond());
	}

	// --- documents ---------------------------------------------------------

	DocumentRow document(long owner, String normUrl) {
		return document(reader, owner, normUrl);
	}

	/**
	 * The template is the caller's, not this method's: a read inside the add
	 * transaction must use the writer connection, because WAL readers cannot see
	 * rows that transaction has not committed yet (the row it just upserted).
	 */
	private static DocumentRow document(JdbcTemplate jdbc, long owner, String normUrl) {
		return jdbc.query(
			"SELECT * FROM document WHERE owner = ? AND norm_url = ?",
			(resultSet, row) -> documentRow(resultSet), owner, normUrl)
			.stream().findFirst().orElse(null);
	}

	Map<String, Object> documentJson(String url) {
		DocumentRow row = document(0, CanonicalUrl.normalise(url));
		return row == null ? null : documentJson(row, 0);
	}

	private static DocumentRow documentRow(ResultSet resultSet) throws SQLException {
		return new DocumentRow(
			resultSet.getLong("owner"), resultSet.getString("norm_url"), resultSet.getString("url"),
			resultSet.getString("title"), resultSet.getString("text"), resultSet.getString("html"),
			resultSet.getString("favicon"), resultSet.getString("language"), resultSet.getString("label"),
			resultSet.getLong("added"), resultSet.getLong("updated"), resultSet.getLong("add_count"),
			resultSet.getLong("type"), resultSet.getString("metadata"));
	}

	@SuppressWarnings("unchecked")
	private Map<String, Object> documentJson(DocumentRow row, double score) {
		Map<String, Object> document = new LinkedHashMap<>();
		document.put("id", row.owner() == 0 ? row.normUrl() : row.owner() + ":" + row.normUrl());
		document.put("url", row.url());
		document.put("domain", Hosts.of(row.url()).isEmpty()
			? row.normUrl().split("/")[0] : Hosts.of(row.url()));
		document.put("html", row.html() == null ? "" : row.html());
		document.put("html_key", "");
		document.put("title", row.title() == null ? "" : row.title());
		document.put("text", row.text() == null ? "" : row.text());
		document.put("favicon", row.favicon() == null ? "" : row.favicon());
		document.put("favicon_key", "");
		document.put("score", score);
		document.put("added", row.added());
		document.put("updated", row.updated());
		document.put("type", row.type());
		document.put("language", row.language() == null ? "" : row.language());
		document.put("user_id", row.owner());
		document.put("label", row.label() == null ? "" : row.label());
		document.put("add_count", row.addCount());
		Object metadata = Map.of();
		if (row.metadata() != null && !row.metadata().isEmpty()) {
			try {
				metadata = mapper.readValue(row.metadata(), Map.class);
			} catch (RuntimeException unreadable) {
				metadata = Map.of();
			}
		}
		document.put("metadata", metadata);
		document.put("processed", true);
		return document;
	}

	// --- the query dialect over the index ----------------------------------

	Map<String, Object> search(SearchQuery query) {
		long started = System.nanoTime();
		SearchQuery ranked = query.withPriority(priorityPatterns());
		List<ScoredRow> matched = matchingDocuments(ranked);
		int total = matched.size();
		List<ScoredRow> page = matched.subList(
			Math.min(ranked.offset(), total), Math.min(ranked.offset() + ranked.limit(), total));
		// Only the page's bodies are fetched: ranking, filtering and priority
		// work on the dimension columns, which is the same split a cold query
		// makes (postings and dimension first, bodies for the returned page).
		Map<Integer, DocumentRow> documents = documentsFor(page);
		List<Map<String, Object>> output = new ArrayList<>(page.size());
		for (ScoredRow item : page) {
			DocumentRow row = documents.get(item.doc());
			if (row == null) {
				continue;
			}
			Map<String, Object> document = documentJson(row, round(item.score()));
			if (!ranked.includeText()) {
				document.put("text", snippet((String) document.get("text"), ranked.terms()));
			}
			if (!ranked.includeHtml()) {
				document.put("html", "");
			}
			output.add(document);
		}
		int nextOffset = ranked.offset() + page.size();
		Map<String, Object> echoedQuery = new LinkedHashMap<>();
		echoedQuery.put("text", ranked.text());
		echoedQuery.put("limit", ranked.limit());
		echoedQuery.put("sort", ranked.sort());
		echoedQuery.put("page_key", ranked.offset() == 0 ? "" : "{\"offset\":" + ranked.offset() + "}");
		echoedQuery.put("match_all", ranked.matchAll());
		echoedQuery.put("include_html", ranked.includeHtml());
		echoedQuery.put("include_text", ranked.includeText());
		echoedQuery.put("semantic_enabled", false);
		Map<String, Object> response = new LinkedHashMap<>();
		response.put("total", total);
		response.put("query", echoedQuery);
		response.put("documents", output);
		response.put("history", List.of());
		response.put("search_duration", ((System.nanoTime() - started) / 1_000_000) + "ms");
		response.put("query_suggestion", "");
		response.put("page_key", nextOffset < total ? "{\"offset\":" + nextOffset + "}" : "");
		response.put("semantic_enabled", false);
		return response;
	}

	private List<String> priorityPatterns() {
		List<String> patterns = new ArrayList<>();
		Object stored = loadRules().get("priority");
		if (stored instanceof List<?> list) {
			for (Object pattern : list) {
				patterns.add(pattern.toString());
			}
		}
		return patterns;
	}

	/** A ranked candidate plus the dimension columns sorting and delete read. */
	private record ScoredRow(double score, int doc, String normUrl, String url, long added) {}

	/**
	 * The ranked page. Ranking touches posting rows and the dimension only, so
	 * the heap cost is the candidate set — never the document bodies — and a
	 * body is fetched for the returned page alone. A phrase is the one filter
	 * that needs the stored text, because the index carries no positions; those
	 * candidates pay one text read each and nothing else does.
	 */
	private List<ScoredRow> matchingDocuments(SearchQuery query) {
		List<SearchIndex.Candidate> candidates = index.candidates(query);
		Map<Integer, SearchIndex.DocHead> heads = index.heads(candidates);
		Map<Integer, String> texts = query.phrases().isEmpty() ? Map.of() : textsFor(heads.keySet());
		List<Pattern> priority = new ArrayList<>();
		for (String pattern : query.priority()) {
			try {
				priority.add(Pattern.compile(pattern));
			} catch (PatternSyntaxException ignored) {
				// A rule stored before save_rules validated it simply does not boost.
			}
		}
		List<ScoredRow> matched = new ArrayList<>();
		for (SearchIndex.Candidate candidate : candidates) {
			SearchIndex.DocHead head = heads.get(candidate.doc());
			if (head == null || !matchesFilters(head, query, texts)) {
				continue;
			}
			double score = candidate.score();
			if (!priority.isEmpty() && priorityMatches(priority, head)) {
				score += 100.0;
			}
			matched.add(new ScoredRow(score, head.doc(), head.normUrl(), head.url(), head.added()));
		}
		matched.sort(comparator(query.sort()));
		return matched;
	}

	private static boolean priorityMatches(List<Pattern> patterns, SearchIndex.DocHead head) {
		for (Pattern pattern : patterns) {
			if (pattern.matcher(head.url() == null ? "" : head.url()).find()
					|| pattern.matcher("https://" + head.normUrl()).find()) {
				return true;
			}
		}
		return false;
	}

	/** The full stored rows for the returned page, keyed by index document id. */
	private Map<Integer, DocumentRow> documentsFor(List<ScoredRow> page) {
		Map<Integer, DocumentRow> documents = new LinkedHashMap<>();
		List<Integer> ids = new ArrayList<>(page.size());
		for (ScoredRow item : page) {
			ids.add(item.doc());
		}
		for (int start = 0; start < ids.size(); start += DOCUMENT_CHUNK) {
			List<Integer> chunk = ids.subList(start, Math.min(start + DOCUMENT_CHUNK, ids.size()));
			String placeholders = String.join(",", java.util.Collections.nCopies(chunk.size(), "?"));
			for (Map.Entry<Integer, DocumentRow> entry : reader.query(
					"SELECT document.*, d.doc FROM document JOIN lakehouse_doc d"
						+ " ON d.owner = document.owner AND d.norm_url = document.norm_url"
						+ " WHERE d.doc IN (" + placeholders + ")",
					(resultSet, row) -> Map.entry(resultSet.getInt("doc"), documentRow(resultSet)),
					chunk.toArray())) {
				documents.put(entry.getKey(), entry.getValue());
			}
		}
		return documents;
	}

	/** The stored text of the given documents, for the phrase filter alone. */
	private Map<Integer, String> textsFor(java.util.Collection<Integer> docs) {
		Map<Integer, String> texts = new LinkedHashMap<>();
		List<Integer> ids = new ArrayList<>(docs);
		for (int start = 0; start < ids.size(); start += DOCUMENT_CHUNK) {
			List<Integer> chunk = ids.subList(start, Math.min(start + DOCUMENT_CHUNK, ids.size()));
			String placeholders = String.join(",", java.util.Collections.nCopies(chunk.size(), "?"));
			for (Map.Entry<Integer, String> entry : reader.query(
					"SELECT d.doc, document.text FROM document JOIN lakehouse_doc d"
						+ " ON d.owner = document.owner AND d.norm_url = document.norm_url"
						+ " WHERE d.doc IN (" + placeholders + ")",
					(resultSet, row) -> Map.entry(resultSet.getInt("doc"),
						resultSet.getString("text") == null ? "" : resultSet.getString("text")),
					chunk.toArray())) {
				texts.put(entry.getKey(), entry.getValue());
			}
		}
		return texts;
	}

	/**
	 * The clauses that decide whether a candidate survives. The date window is
	 * not among them: it is pushed into the candidate scan, so a demoted window
	 * is never fetched in the first place (a cold generation is an `added`
	 * window; see SearchIndex).
	 */
	private static boolean matchesFilters(
			SearchIndex.DocHead head, SearchQuery query, Map<Integer, String> texts) {
		String url = head.url() == null ? "" : head.url();
		String norm = head.normUrl() == null ? "" : head.normUrl();
		for (SearchQuery.Filter filter : query.filters()) {
			boolean ok = switch (filter.name()) {
				case "url", "id" -> {
					String wanted = filter.value().startsWith("0:")
						? filter.value().substring(2) : filter.value();
					yield CanonicalUrl.normalise(wanted).equals(norm) || wanted.equals(url)
						|| ("0:" + norm).equals(filter.value());
				}
				case "domain", "site" -> Hosts.of(url)
					.equals(filter.value().toLowerCase(Locale.ROOT).replaceAll("\\.+$", ""));
				case "title" -> (head.title() == null ? "" : head.title()).toLowerCase(Locale.ROOT)
					.contains(filter.value().toLowerCase(Locale.ROOT));
				case "label" -> (head.label() == null ? "" : head.label())
					.equalsIgnoreCase(filter.value());
				case "language" -> (head.language() == null ? "" : head.language())
					.equalsIgnoreCase(filter.value());
				default -> String.valueOf(head.type()).equals(filter.value());
			};
			if (ok == filter.negate()) {
				return false;
			}
		}
		if (!query.phrases().isEmpty()) {
			String haystack = ((head.title() == null ? "" : head.title()) + "\n"
				+ texts.getOrDefault(head.doc(), "")).toLowerCase(Locale.ROOT);
			for (String phrase : query.phrases()) {
				if (!haystack.contains(phrase.toLowerCase(Locale.ROOT))) {
					return false;
				}
			}
		}
		return true;
	}

	private static Comparator<ScoredRow> comparator(String sort) {
		Comparator<ScoredRow> byDate = Comparator
			.comparingLong(ScoredRow::added)
			.thenComparing(ScoredRow::normUrl);
		return switch (sort) {
			case "date", "added" -> byDate;
			case "-date", "-added" -> Comparator
				.comparingLong((ScoredRow item) -> -item.added())
				.thenComparing(ScoredRow::normUrl);
			default -> Comparator
				.comparingDouble((ScoredRow item) -> -item.score())
				.thenComparingLong(item -> -item.added())
				.thenComparing(ScoredRow::normUrl);
		};
	}

	private static double round(double score) {
		return Math.round(score * 1_000_000.0) / 1_000_000.0;
	}

	/**
	 * A snippet starts a third of its window before the first hit, so a match
	 * deep in a captured page still shows its surrounding words.
	 */
	private static String snippet(String text, List<String> terms) {
		if (text == null || text.isEmpty()) {
			return "";
		}
		String lower = text.toLowerCase(Locale.ROOT);
		int first = -1;
		for (String term : terms) {
			int found = lower.indexOf(term.toLowerCase(Locale.ROOT));
			if (found >= 0 && (first < 0 || found < first)) {
				first = found;
			}
		}
		int start = first < 0 ? 0 : Math.max(0, first - SNIPPET_SIZE / 3);
		return text.substring(start, Math.min(text.length(), start + SNIPPET_SIZE));
	}

	// --- delete and the click log ------------------------------------------

	/**
	 * Delete every document matching the same dialect as /search. A document is
	 * a capture, not a visit: the visit rows and the presence mark stay, and
	 * only the click history upstream also removes is cleared (docs/d205).
	 */
	Map<String, Object> delete(String queryText, boolean dryRun) {
		SearchQuery query = SearchQuery.fromParams(Map.of("q", List.of(queryText)), mapper);
		if (query.terms().isEmpty() && query.filters().isEmpty() && query.phrases().isEmpty() && !query.matchAll()) {
			throw new LakehouseProblems.BadRequestException("empty delete query");
		}
		List<ScoredRow> matched = matchingDocuments(query.withPriority(List.of()));
		Map<String, Object> result = new LinkedHashMap<>();
		if (dryRun) {
			result.put("matched", matched.size());
			return result;
		}
		transactions.executeWithoutResult(status -> {
			for (ScoredRow item : matched) {
				index.unindexDocument(item.doc());
				writer.update(
					"DELETE FROM click WHERE url=? OR url=?",
					item.url(), "https://" + item.normUrl());
				writer.update(
					"DELETE FROM document WHERE owner=0 AND norm_url=?", item.normUrl());
			}
		});
		result.put("deleted", matched.size());
		return result;
	}

	/** The config the extension reads at startup; nothing is guessed beyond it. */
	Map<String, Object> config(boolean tokenConfigured) {
		Map<String, Object> config = new LinkedHashMap<>();
		config.put("version", Daemon.VERSION);
		config.put("baseUrl", "/");
		config.put("basePath", "");
		config.put("wsUrl", "");
		config.put("title", "hister (datalakehouse)");
		config.put("subtitle", "");
		config.put("colorScheme", "auto");
		config.put("searchUrl", "");
		config.put("openResultsOnNewTab", true);
		config.put("showSuggestions", false);
		config.put("hotkeys", Map.of());
		config.put("authMode", tokenConfigured ? "token" : "none");
		config.put("authenticated", true);
		config.put("public", false);
		config.put("canWrite", true);
		config.put("canConfigure", false);
		config.put("historyEnabled", true);
		config.put("userId", 0);
		// docs/d205: semantic search is accepted on the wire and reported off.
		config.put("semanticEnabled", false);
		config.put("maxBatchBodyBytes", 8 * 1024 * 1024);
		config.put("search", Map.of("semantic", false));
		return config;
	}

	/** The host of a URL without userinfo or port, lowercased. */
	static final class Hosts {

		private Hosts() {
		}

		static String of(String url) {
			String rest = url == null ? "" : url;
			int scheme = rest.indexOf("://");
			if (scheme >= 0) {
				rest = rest.substring(scheme + 3);
			}
			int end = rest.length();
			for (int index = 0; index < rest.length(); index++) {
				char character = rest.charAt(index);
				if (character == '/' || character == '?' || character == '#') {
					end = index;
					break;
				}
			}
			String authority = rest.substring(0, end);
			int at = authority.lastIndexOf('@');
			if (at >= 0) {
				authority = authority.substring(at + 1);
			}
			if (authority.startsWith("[")) {
				int close = authority.indexOf(']');
				return close > 0 ? authority.substring(0, close + 1).toLowerCase(Locale.ROOT) : "";
			}
			int colon = authority.indexOf(':');
			if (colon >= 0) {
				authority = authority.substring(0, colon);
			}
			return authority.toLowerCase(Locale.ROOT);
		}
	}
}
