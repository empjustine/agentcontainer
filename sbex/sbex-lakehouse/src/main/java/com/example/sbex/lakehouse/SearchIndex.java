package com.example.sbex.lakehouse;

import jakarta.annotation.PostConstruct;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.support.EncodedResource;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The cold-shaped inverted index of docs/d205: a term dictionary and posting
 * lists sorted by term, with no positions.
 *
 * WHY this shape and not SQLite FTS5: the index has to survive the move to
 * Parquet. A dictionary plus a term-sorted posting list is the shape
 * ClickHouse's full-text index uses for slow storage, and a Parquet rewrite
 * keeps it as row groups sorted by term. No positions are stored in v1, so a
 * phrase is a candidate filter rather than an index lookup; that is the price
 * of the cold-friendly row layout, and the results are deliberately naive.
 *
 * WHY a posting row names an integer document id: a cold posting row is
 * (term, doc, field, tf), so the demotion is a straight copy and a compressed
 * row group repeats no URL text. The document dimension (`lakehouse_doc`) is
 * written beside it, and the hot store stops paying the same URL once per term
 * per document. `lakehouse_doc.added` is the demotion axis: a generation is a
 * sealed time window, and a date-bounded query prunes windows instead of
 * reading them.
 *
 * The whole of this state is derived from `document` and rebuildable: the
 * schema lives in `lakehouse-index.sql`, and a shape change is a mark mismatch
 * that drops and rebuilds it (the producer keeps sending wire schema 1).
 */
@Component
class SearchIndex {

	/** Bumped when the posting layout changes; a mismatch clears and rebuilds. */
	private static final int INDEX_SCHEMA = 2;

	private static final String INDEX_SCRIPT = "lakehouse-index.sql";

	static final int FIELD_URL = 0;
	static final int FIELD_TITLE = 1;
	static final int FIELD_TEXT = 2;
	private static final double[] FIELD_WEIGHT = { 3.0, 2.0, 1.0 };

	private static final double BM25_K1 = 1.2;
	private static final double BM25_B = 0.75;
	private static final int TERM_PREFIX_LIMIT = 64;
	private static final int DOCUMENT_CHUNK = 500;
	private static final int REBUILD_BATCH = 500;

	private static final Logger log = LoggerFactory.getLogger(SearchIndex.class);

	private static final Pattern TERM = Pattern.compile("\\w+", Pattern.UNICODE_CHARACTER_CLASS);

	/**
	 * Bleve's standard analyzer drops English stopwords; the same list keeps
	 * the posting list small without a stemmer (naive v1, docs/d205).
	 */
	private static final Set<String> STOPWORDS = Set.of(
		"a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
		"he", "her", "his", "i", "if", "in", "into", "is", "it", "its", "me", "my", "no", "not",
		"of", "on", "or", "our", "she", "so", "than", "that", "the", "their", "them", "then",
		"there", "these", "they", "this", "to", "was", "we", "were", "what", "when", "where",
		"which", "who", "will", "with", "you", "your");

	private final JdbcTemplate writer;
	private final JdbcTemplate reader;
	private final TransactionTemplate transactions;

	SearchIndex(
			@Qualifier("writerJdbc") JdbcTemplate writer, @Qualifier("readerJdbc") JdbcTemplate reader,
			TransactionTemplate transactions) {
		this.writer = writer;
		this.reader = reader;
		this.transactions = transactions;
	}

	/** A posting-list candidate: what the ranking produced, before any fetch. */
	record Candidate(double score, int doc, String normUrl) {}

	/** The dimension row plus the small document columns filters and sorting read. */
	record DocHead(
		int doc, String normUrl, String url, String title, String label, String language,
		long type, long added) {}

	/**
	 * Create the index's tables, then rebuild them when their shape changed.
	 *
	 * Runs at bean creation, before Tomcat opens a port, so no request can read a
	 * half-built index. The rebuild is one writer transaction: it is the one
	 * moment a partly rebuilt index would otherwise be visible.
	 */
	@PostConstruct
	void ensureIndex() {
		runIndexScript();
		Integer mark = mark();
		if (mark != null && mark == INDEX_SCHEMA) {
			return;
		}
		dropIndexTables();
		runIndexScript();
		rebuild();
		setMark();
		Map<String, Object> stats = statistics();
		log.info("search index rebuilt (schema {}): {} document(s), {} term(s) indexed",
			INDEX_SCHEMA, stats.get("documents"), lengthSum());
	}

	/** The analyzer: lowercased word runs, singletons and stopwords dropped. */
	static List<String> analyse(String text) {
		List<String> terms = new ArrayList<>();
		if (text == null || text.isEmpty()) {
			return terms;
		}
		Matcher matcher = TERM.matcher(text);
		while (matcher.find()) {
			String term = matcher.group().toLowerCase(java.util.Locale.ROOT);
			if (term.length() > 1 && !STOPWORDS.contains(term)) {
				terms.add(term);
			}
		}
		return terms;
	}

	// --- indexing ----------------------------------------------------------

	/**
	 * Index one stored document. The caller passes the row it stored, not the
	 * request: a metadata-only re-add keeps the old body, and its postings must
	 * stay identical (docs/d205).
	 *
	 * Must run inside the caller's write transaction: minting the document id
	 * reads `last_insert_rowid()`, which is a property of the connection the
	 * insert used.
	 *
	 * @param added the document's immutable capture time, in epoch seconds; the
	 *     demotion axis a cold generation is cut from
	 */
	void indexDocument(long owner, String normUrl, long added, String url, String title, String text) {
		Map<String, int[]> counts = new LinkedHashMap<>();
		countField(counts, FIELD_URL, url);
		countField(counts, FIELD_TITLE, title);
		countField(counts, FIELD_TEXT, text);
		long length = 0;
		for (int[] fields : counts.values()) {
			for (int frequency : fields) {
				length += frequency;
			}
		}
		Integer doc = docOf(owner, normUrl);
		if (doc == null) {
			writer.update(
				"INSERT INTO lakehouse_doc(owner, norm_url, length, added) VALUES(?,?,?,?)",
				owner, normUrl, length, added);
			doc = lastRowId();
			bumpStats(1, length);
		} else {
			// A re-index replaces this document's postings, so the old ones leave
			// the dictionary before the new ones arrive, and the length delta is
			// what the corpus average moves by.
			unindexPostings(doc);
			Long previous = lengthOf(doc);
			writer.update("UPDATE lakehouse_doc SET length = ? WHERE doc = ?", length, doc);
			bumpStats(0, length - (previous == null ? 0 : previous));
		}
		for (Map.Entry<String, int[]> entry : counts.entrySet()) {
			for (int field = 0; field < entry.getValue().length; field++) {
				int frequency = entry.getValue()[field];
				if (frequency == 0) {
					continue;
				}
				writer.update(
					"INSERT INTO lakehouse_posting(term, doc, field, tf) VALUES(?,?,?,?)",
					entry.getKey(), doc, field, frequency);
			}
			writer.update(
				"INSERT INTO lakehouse_term(term, doc_freq) VALUES(?,1)"
					+ " ON CONFLICT(term) DO UPDATE SET doc_freq=doc_freq+1",
				entry.getKey());
		}
	}

	/** Remove a document from the index by its id. */
	void unindexDocument(int doc) {
		unindexPostings(doc);
		Long length = lengthOf(doc);
		writer.update("DELETE FROM lakehouse_doc WHERE doc = ?", doc);
		bumpStats(-1, -(length == null ? 0 : length));
	}

	/** The index id of a stored document, or null when it is not indexed. */
	Integer docOf(long owner, String normUrl) {
		List<Integer> ids = reader.queryForList(
			"SELECT doc FROM lakehouse_doc WHERE owner = ? AND norm_url = ?", Integer.class, owner, normUrl);
		return ids.isEmpty() ? null : ids.get(0);
	}

	private void unindexPostings(int doc) {
		for (String term : writer.queryForList(
				"SELECT DISTINCT term FROM lakehouse_posting WHERE doc = ?", String.class, doc)) {
			writer.update("UPDATE lakehouse_term SET doc_freq = doc_freq - 1 WHERE term = ?", term);
			writer.update("DELETE FROM lakehouse_term WHERE term = ? AND doc_freq <= 0", term);
		}
		writer.update("DELETE FROM lakehouse_posting WHERE doc = ?", doc);
	}

	private static void countField(Map<String, int[]> counts, int field, String value) {
		for (String term : analyse(value)) {
			counts.computeIfAbsent(term, unused -> new int[FIELD_WEIGHT.length])[field]++;
		}
	}

	/** The id the insert just minted; only valid on the connection that inserted. */
	private Integer lastRowId() {
		return writer.queryForObject("SELECT last_insert_rowid()", Integer.class);
	}

	private Long lengthOf(int doc) {
		List<Long> lengths = reader.queryForList(
			"SELECT length FROM lakehouse_doc WHERE doc = ?", Long.class, doc);
		return lengths.isEmpty() ? null : lengths.get(0);
	}

	/**
	 * Move the corpus parameters. Clamped at zero: a rebuilt or hand-repaired
	 * store must not answer a negative average to every later query.
	 */
	private void bumpStats(int documents, long length) {
		writer.update(
			"UPDATE lakehouse_stats SET documents = MAX(0, documents + ?),"
				+ " length_sum = MAX(0, length_sum + ?) WHERE id = 0",
			documents, length);
	}

	private Map<String, Object> statistics() {
		List<Map<String, Object>> rows = reader.queryForList(
			"SELECT documents, length_sum FROM lakehouse_stats WHERE id = 0");
		return rows.isEmpty() ? Map.of("documents", 0, "length_sum", 0) : rows.get(0);
	}

	private long lengthSum() {
		Object value = statistics().get("length_sum");
		return value == null ? 0 : ((Number) value).longValue();
	}

	// --- reading -----------------------------------------------------------

	/**
	 * The candidates a query ranks, already pruned by its date window.
	 *
	 * A generation is an `added` window, so pushing the bound into this scan is
	 * what keeps a "latest history" query from touching a demoted window: the
	 * same predicate selects generations in a cold query and rows here. The
	 * score map and the matched-term sets are bounded by candidates, never by
	 * document bodies; bodies are fetched only for the page the caller returns.
	 */
	List<Candidate> candidates(SearchQuery query) {
		List<Candidate> candidates = new ArrayList<>();
		if (query.terms().isEmpty()) {
			// The match-all shape: every indexed document, still window-pruned.
			String sql = "SELECT doc, norm_url FROM lakehouse_doc WHERE owner = 0" + window(query, "added");
			for (Map<String, Object> row : reader.queryForList(sql, windowArgs(query).toArray())) {
				candidates.add(new Candidate(0.0, ((Number) row.get("doc")).intValue(),
					(String) row.get("norm_url")));
			}
			return candidates;
		}
		double documents = 0;
		double lengthSum = 0;
		Map<String, Object> stats = statistics();
		if (!stats.isEmpty()) {
			Object count = stats.get("documents");
			Object sum = stats.get("length_sum");
			documents = count == null ? 0 : ((Number) count).doubleValue();
			lengthSum = sum == null ? 0 : ((Number) sum).doubleValue();
		}
		double average = documents == 0 || lengthSum == 0 ? 1.0 : lengthSum / documents;
		Map<Integer, Double> scores = new LinkedHashMap<>();
		Map<Integer, String> urls = new LinkedHashMap<>();
		Map<Integer, Set<Integer>> matched = new LinkedHashMap<>();
		List<String> terms = query.terms();
		for (int position = 0; position < terms.size(); position++) {
			List<String> expanded = expand(terms.get(position));
			if (expanded.isEmpty()) {
				return List.of();
			}
			for (String databaseTerm : expanded) {
				List<Map<String, Object>> termRows = reader.queryForList(
					"SELECT doc_freq FROM lakehouse_term WHERE term = ?", databaseTerm);
				long frequency = termRows.isEmpty()
					? 0 : ((Number) termRows.get(0).get("doc_freq")).longValue();
				if (frequency == 0) {
					continue;
				}
				double idf = Math.log(1.0 + (documents - frequency + 0.5) / (frequency + 0.5));
				List<Object> args = new ArrayList<>();
				args.add(databaseTerm);
				args.addAll(windowArgs(query));
				for (Map<String, Object> row : reader.queryForList(
						"SELECT p.doc, p.field, p.tf, d.length, d.norm_url FROM lakehouse_posting p"
							+ " JOIN lakehouse_doc d ON d.doc = p.doc"
							+ " WHERE p.term = ? AND d.owner = 0" + window(query, "d.added"),
						args.toArray())) {
					int doc = ((Number) row.get("doc")).intValue();
					double tf = ((Number) row.get("tf")).doubleValue();
					double length = ((Number) row.get("length")).doubleValue();
					if (length == 0) {
						length = 1.0;
					}
					double denominator = tf + BM25_K1 * (1.0 - BM25_B + BM25_B * length / average);
					int field = ((Number) row.get("field")).intValue();
					double fieldScore = FIELD_WEIGHT[field] * idf * (tf * (BM25_K1 + 1.0) / denominator);
					scores.merge(doc, fieldScore, Double::sum);
					urls.putIfAbsent(doc, (String) row.get("norm_url"));
					matched.computeIfAbsent(doc, unused -> new LinkedHashSet<>()).add(position);
				}
			}
		}
		for (Map.Entry<Integer, Double> entry : scores.entrySet()) {
			if (matched.get(entry.getKey()).size() == terms.size()) {
				candidates.add(new Candidate(entry.getValue(), entry.getKey(), urls.get(entry.getKey())));
			}
		}
		return candidates;
	}

	/** The dimension rows for a candidate set, in chunks the driver can bind. */
	Map<Integer, DocHead> heads(List<Candidate> candidates) {
		Map<Integer, DocHead> heads = new LinkedHashMap<>();
		List<Integer> ids = new ArrayList<>(candidates.size());
		for (Candidate candidate : candidates) {
			ids.add(candidate.doc());
		}
		for (int start = 0; start < ids.size(); start += DOCUMENT_CHUNK) {
			List<Integer> chunk = ids.subList(start, Math.min(start + DOCUMENT_CHUNK, ids.size()));
			String placeholders = String.join(",", Collections.nCopies(chunk.size(), "?"));
			String sql = "SELECT d.doc, d.norm_url, d.added, document.url, document.title,"
				+ " document.label, document.language, document.type"
				+ " FROM lakehouse_doc d JOIN document ON document.owner = d.owner"
				+ " AND document.norm_url = d.norm_url WHERE d.doc IN (" + placeholders + ")";
			for (Map<String, Object> row : reader.queryForList(sql, chunk.toArray())) {
				int doc = ((Number) row.get("doc")).intValue();
				heads.put(doc, new DocHead(
					doc,
					(String) row.get("norm_url"),
					(String) row.get("url"),
					(String) row.get("title"),
					(String) row.get("label"),
					(String) row.get("language"),
					((Number) row.get("type")).longValue(),
					((Number) row.get("added")).longValue()));
			}
		}
		return heads;
	}

	/**
	 * A trailing '*' expands through the dictionary's contiguous range, which is
	 * the one range scan the cold layout was chosen for.
	 */
	private List<String> expand(String term) {
		if (!term.endsWith("*") || term.length() < 2) {
			return List.of(term);
		}
		String prefix = term.substring(0, term.length() - 1);
		return reader.queryForList(
			"SELECT term FROM lakehouse_term WHERE term >= ? AND term < ? ORDER BY term LIMIT ?",
			String.class, prefix, prefix + "\uffff", TERM_PREFIX_LIMIT);
	}

	/** The date window as SQL for one column, so hot and cold prune identically. */
	private static String window(SearchQuery query, String column) {
		StringBuilder clause = new StringBuilder(64);
		if (query.dateFrom() != null) {
			clause.append(" AND ").append(column).append(" >= ?");
		}
		if (query.dateTo() != null) {
			clause.append(" AND ").append(column).append(" <= ?");
		}
		return clause.toString();
	}

	private static List<Object> windowArgs(SearchQuery query) {
		List<Object> args = new ArrayList<>(2);
		if (query.dateFrom() != null) {
			args.add(query.dateFrom());
		}
		if (query.dateTo() != null) {
			args.add(query.dateTo());
		}
		return args;
	}

	// --- the index's own schema --------------------------------------------

	private void runIndexScript() {
		writer.execute((ConnectionCallback<Void>) connection -> {
			ScriptUtils.executeSqlScript(
				connection,
				new EncodedResource(new ClassPathResource(INDEX_SCRIPT), StandardCharsets.UTF_8));
			return null;
		});
	}

	/**
	 * Drop the derived tables. Only these: the store's own tables
	 * (lakehouse-schema.sql) are the daemon's and are never rebuilt from here.
	 */
	private void dropIndexTables() {
		for (String table : List.of("lakehouse_posting", "lakehouse_doc", "lakehouse_stats", "lakehouse_term")) {
			writer.execute("DROP TABLE IF EXISTS " + table);
		}
	}

	/**
	 * Rebuild from the documents table in one transaction, in id order. The
	 * batch cursor is a rowid window, so a store far larger than the heap still
	 * rebuilds with one batch resident.
	 */
	private void rebuild() {
		transactions.executeWithoutResult(status -> {
			long cursor = 0;
			while (true) {
				List<Map<String, Object>> batch = writer.queryForList(
					"SELECT rowid AS rid, norm_url, url, title, text, added FROM document"
						+ " WHERE owner = 0 AND rowid > ? ORDER BY rowid LIMIT " + REBUILD_BATCH,
					cursor);
				if (batch.isEmpty()) {
					return;
				}
				for (Map<String, Object> row : batch) {
					cursor = ((Number) row.get("rid")).longValue();
					indexDocument(0, (String) row.get("norm_url"),
						((Number) row.get("added")).longValue(), (String) row.get("url"),
						(String) row.get("title"), (String) row.get("text"));
				}
			}
		});
	}

	private Integer mark() {
		List<String> values = reader.queryForList(
			"SELECT value FROM meta WHERE key = 'lakehouse.index_schema'", String.class);
		if (values.isEmpty()) {
			return null;
		}
		try {
			return Integer.valueOf(values.get(0));
		} catch (NumberFormatException unreadable) {
			return null;
		}
	}

	private void setMark() {
		writer.update(
			"INSERT INTO meta(key, value) VALUES('lakehouse.index_schema', ?)"
				+ " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			Integer.toString(INDEX_SCHEMA));
	}
}
