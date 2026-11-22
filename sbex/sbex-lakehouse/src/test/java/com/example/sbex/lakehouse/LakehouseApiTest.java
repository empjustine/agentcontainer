package com.example.sbex.lakehouse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * The conformance floor, over real HTTP: the same shapes the unit's shell suite
 * asserts against the daemon (slurp and ack counts, the Promnesia envelopes,
 * the hister read and write faces, CORS, the RFC 9457 bodies, the surface rule)
 * plus the session route's diode behaviour.
 *
 * WHY a live server on three connectors rather than a MockMvc slice: the
 * contract under test is the port-to-protocol rule and the wire shapes the
 * stock extensions read. A slice has neither a local port nor an async stream.
 */
@SpringBootTest(
	webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
	properties = {
		"lakehouse.hister-address=127.0.0.1:0",
		"lakehouse.promnesia-address=127.0.0.1:0",
		"lakehouse.agent-address=127.0.0.1:0",
		"lakehouse.token=secret",
		"lakehouse.agent-token=agents",
	})
class LakehouseApiTest {

	private static final Path HOME = createTempDirectory();

	private static final HttpClient HTTP = HttpClient.newHttpClient();

	private static final String PDF = "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2Jq"
		+ "CjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwg"
		+ "L1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jl"
		+ "c291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0MCA+"
		+ "PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDIwIDEwMCBUZCAoSGVsbG8gUERGKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUg"
		+ "MCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4"
		+ "cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAow"
		+ "MDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMzMSAwMDAwMCBuIAp0cmFpbGVyCjw8"
		+ "IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQwMQolJUVPRgo=";

	@Autowired
	SurfacePorts ports;

	@Autowired
	@org.springframework.beans.factory.annotation.Qualifier("writerJdbc")
	JdbcTemplate writer;

	@Autowired
	SearchIndex index;

	@DynamicPropertySource
	static void store(DynamicPropertyRegistry registry) {
		registry.add("lakehouse.store", () -> HOME.resolve("browse.sqlite").toString());
		registry.add("lakehouse.spool", () -> HOME.resolve("spool.ndjson").toString());
	}

	private static Path createTempDirectory() {
		try {
			return Files.createTempDirectory("lakehouse-test");
		} catch (IOException exception) {
			throw new IllegalStateException(exception);
		}
	}

	private String url(Surface surface) {
		return "http://127.0.0.1:" + ports.port(surface);
	}

	private HttpResponse<String> call(String method, String origin, String path, String body, String token)
			throws IOException, InterruptedException {
		HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(origin + path))
			.timeout(java.time.Duration.ofSeconds(30));
		if (body != null) {
			request.header("content-type", "application/json");
			request.method(method, HttpRequest.BodyPublishers.ofString(body));
		} else {
			request.method(method, HttpRequest.BodyPublishers.noBody());
		}
		if (token != null) {
			// Both names are sent: the browse faces read X-Access-Token and the
			// session route reads X-Ingest-Token (its own boundary), and each
			// ignores the other's header.
			request.header("X-Access-Token", token);
			request.header("X-Ingest-Token", token);
		}
		return HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
	}

	private HttpResponse<String> post(String origin, String path, String body, String token)
			throws IOException, InterruptedException {
		return call("POST", origin, path, body, token);
	}

	@Test
	void slurpBatchIsIdempotentAndPromnesiaReadsIt() throws Exception {
		String origin = url(Surface.HISTER);
		String promnesia = url(Surface.PROMNESIA);
		String envelope = """
			{"schema":1,"producer":"agentcontainer-slurp/0.1.0","stream":"visit",
			 "stream_seq":{"low":1,"high":4,"acked":0},"checkpoint":{"cursor":"b2"},
			 "records":[
			  {"src":"firefox-history","kind":"visit","key":"j1","url":"https://www.example.com/post?id=7",
			   "visit_time":1712345678901,"title":"A Post","via":"backfill"},
			  {"src":"firefox-history","kind":"visit","key":"j2","url":"https://mobile.twitter.com/foo/status/1",
			   "visit_time":1712345690000,"title":"A Tweet","via":"live"},
			  {"src":"firefox-history","kind":"visit","key":"j3","url":"https://removed.example/gone",
			   "visit_time":1712345695000,"title":"Gone","via":"live"},
			  {"src":"firefox-bookmarks","kind":"bookmark","key":"jf1","node_type":"folder","title":"Reading",
			   "parent_id":"root________","position":0,"date_added":1712345000000}]}
			""";
		assertEquals(401, post(origin, "/ingest/slurp", envelope, null).statusCode());
		HttpResponse<String> first = post(origin, "/ingest/slurp", envelope, "secret");
		assertEquals(200, first.statusCode());
		assertTrue(first.body().contains("\"accepted\":4"), first.body());
		assertTrue(first.body().contains("\"cursor\":\"b2\""), first.body());
		HttpResponse<String> replay = post(origin, "/ingest/slurp", envelope, "secret");
		assertTrue(replay.body().contains("\"accepted\":0"), replay.body());
		assertTrue(replay.body().contains("\"duplicates\":4"), replay.body());
		assertEquals(409, post(origin, "/ingest/slurp",
			"{\"schema\":9,\"stream\":\"visit\",\"records\":[]}", "secret").statusCode());

		String visited = post(promnesia, "/visited",
			"{\"urls\":[\"https://mobile.twitter.com/foo/status/1\",\"https://never.example/\"]}", null).body();
		assertTrue(visited.contains("\"normalised_url\":\"twitter.com/foo/status/1\""), visited);
		assertTrue(visited.contains("null"), visited);
		// IXDTF's numeric-offset form: the extension slices six characters off
		// the end, so a bracketed zone annotation would break it.
		assertTrue(visited.matches("(?s).*\"dt\":\"\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[+-]\\d{2}:\\d{2}\""
			+ ".*"), visited);

		// A bookmark is context, never a visited mark.
		String bookmarkOnly = post(promnesia, "/visited",
			"{\"urls\":[\"https://www.example.com/post?id=7\"]}", null).body();
		assertTrue(bookmarkOnly.contains("A Post"), bookmarkOnly);

		String removals = """
			{"schema":1,"stream":"tombstone","records":[
			 {"src":"firefox-history","kind":"visit-removed","key":"https://removed.example/gone",
			  "url":"https://removed.example/gone","deleted_at":1712345700000,"source":"local"}]}
			""";
		assertEquals(200, post(origin, "/ingest/slurp", removals, "secret").statusCode());
		assertTrue(post(promnesia, "/visits", "{\"url\":\"https://removed.example/gone\"}", null)
			.body().contains("\"visits\":[]"));
		assertTrue(post(promnesia, "/visited", "{\"urls\":[\"https://removed.example/gone\"]}", null)
			.body().contains("Gone"));
	}

	@Test
	void histerCaptureSearchAndDelete() throws Exception {
		String origin = url(Surface.HISTER);
		assertEquals(200, call("GET", origin, "/api/profile", null, null).statusCode());
		assertFalse(call("GET", origin, "/api/profile", null, null).body().contains("user_id"));

		assertEquals(401, post(origin, "/api/add", "{\"url\":\"https://x.example/\"}", null).statusCode());
		assertEquals(201, post(origin, "/api/add",
			"{\"url\":\"https://news.example/story\",\"title\":\"Story\",\"text\":\"body text\"}",
			"secret").statusCode());
		assertEquals(201, post(origin, "/api/add", "{\"url\":\"https://news.example/story\"}", "secret")
			.statusCode());
		assertEquals(200, call("HEAD", origin, "/api/document?url=https://news.example/story", null, null)
			.statusCode());
		assertEquals(404, call("HEAD", origin, "/api/document?url=https://news.example/other", null, null)
			.statusCode());
		String document = call("GET", origin, "/api/document?url=https://news.example/story", null, null).body();
		assertTrue(document.contains("body text"), document);
		assertTrue(document.contains("\"title\":\"Story\""), document);

		assertTrue(call("GET", origin, "/search?q=body", null, null).body()
			.contains("https://news.example/story"));
		assertTrue(call("GET", origin, "/search?q=title%3AStory", null, null).body()
			.contains("https://news.example/story"));
		assertTrue(call("GET", origin, "/search?q=domain%3Anews.example", null, null).body()
			.contains("https://news.example/story"));
		assertTrue(call("GET", origin, "/search?q=%22body%20text%22", null, null).body()
			.contains("https://news.example/story"));
		assertTrue(call("GET", origin, "/search?q=bo*", null, null).body()
			.contains("https://news.example/story"));
		assertTrue(call("GET", origin, "/search?q=body%20surelynotpresent", null, null).body()
			.contains("\"total\":0"));
		assertTrue(call("GET", origin, "/search?q=*", null, null).body()
			.contains("https://news.example/story"));
		assertEquals(200, post(origin, "/search", "{\"text\":\"body\"}", null).statusCode());

		assertEquals(200, post(origin, "/api/rules", "skip=news.example", "secret").statusCode());
		assertTrue(call("GET", origin, "/api/rules", null, null).body()
			.contains("\"skip\":[\"news.example\"]"));
		assertEquals(406, post(origin, "/api/add", "{\"url\":\"https://news.example/blocked\"}", "secret")
			.statusCode());
		assertEquals(400, post(origin, "/api/rules", "skip=(unclosed", "secret").statusCode());

		assertTrue(post(origin, "/api/label",
			"{\"url\":\"https://news.example/story\",\"label\":\"read-later\"}", "secret")
			.body().contains("\"ok\":true"));
		assertTrue(call("GET", origin, "/api/document?url=https://news.example/story", null, null).body()
			.contains("\"label\":\"read-later\""));
		assertEquals(404, post(origin, "/api/label",
			"{\"url\":\"https://nope.example/\",\"label\":\"x\"}", "secret").statusCode());

		assertTrue(post(origin, "/api/delete", "{\"query\":\"domain:news.example\",\"dry_run\":true}",
			"secret").body().contains("\"matched\":1"));
		assertTrue(post(origin, "/api/delete", "{\"query\":\"url:\\\"https://news.example/story\\\"\"}",
			"secret").body().contains("\"deleted\":1"));
		assertEquals(404, call("HEAD", origin, "/api/document?url=https://news.example/story", null, null)
			.statusCode());
		assertTrue(call("GET", origin, "/search?q=body", null, null).body().contains("\"total\":0"));

		assertEquals(201, post(origin, "/api/history",
			"{\"url\":\"https://news.example/story\",\"title\":\"Story\",\"query\":\"q\"}", "secret")
			.statusCode());
		assertTrue(call("GET", origin, "/api/versions?url=https://a.example/", null, null).body()
			.contains("not built"));
	}

	@Test
	void pdfCaptureStoresExtractedText() throws Exception {
		String origin = url(Surface.HISTER);
		HttpResponse<String> added = post(origin, "/api/add_pdf",
			"{\"document\":{\"url\":\"https://files.example/doc.pdf\",\"title\":\"Doc\"},"
				+ "\"pdf\":\"" + PDF + "\"}", "secret");
		assertEquals(201, added.statusCode(), added.body());
		assertTrue(call("GET", origin, "/api/document?url=https://files.example/doc.pdf", null, null).body()
			.contains("Hello PDF"));
		assertTrue(call("GET", origin, "/search?q=Hello", null, null).body()
			.contains("https://files.example/doc.pdf"));
		// A malformed PDF is a 500 and the daemon survives it.
		assertEquals(500, post(origin, "/api/add_pdf",
			"{\"document\":{\"url\":\"https://files.example/bad.pdf\"},\"pdf\":\"bm90IGEgcGRm\"}",
			"secret").statusCode());
		assertEquals(200, call("GET", url(Surface.PROMNESIA), "/status", null, null).statusCode());
	}

	@Test
	void surfacesAndProblemDocuments() throws Exception {
		String hister = url(Surface.HISTER);
		String promnesia = url(Surface.PROMNESIA);
		assertEquals(404, call("GET", promnesia, "/api/config", null, null).statusCode());
		assertEquals(404, call("GET", hister, "/status", null, null).statusCode());

		HttpResponse<String> problem = post(hister, "/api/add", "{}", "secret");
		assertEquals(400, problem.statusCode());
		assertTrue(problem.headers().firstValue("content-type").orElse("")
			.contains("application/problem+json"));
		assertTrue(problem.body().contains("https://agentcontainer.example/problems/interface-error"));
		assertTrue(problem.body().contains("\"title\":\"Interface error\""));

		HttpResponse<String> preflight = call("OPTIONS", hister, "/api/add", null, null);
		assertEquals(204, preflight.statusCode());
		HttpRequest preflightRequest = HttpRequest.newBuilder(URI.create(hister + "/api/add"))
			.method("OPTIONS", HttpRequest.BodyPublishers.noBody())
			.header("Origin", "moz-extension://abc")
			.header("Access-Control-Request-Headers", "content-type, x-access-token")
			.build();
		HttpResponse<String> cors = HTTP.send(preflightRequest, HttpResponse.BodyHandlers.ofString());
		assertEquals("moz-extension://abc",
			cors.headers().firstValue("Access-Control-Allow-Origin").orElse(""));
		assertTrue(cors.headers().firstValue("Access-Control-Allow-Headers").orElse("")
			.contains("x-access-token"));

		// A body over the ceiling is refused before it is read into the heap.
		String oversized = " ".repeat(9 * 1024 * 1024);
		assertEquals(413, post(hister, "/ingest/slurp", oversized, "secret").statusCode());
	}

	@Test
	void sessionRouteIsADiode() throws Exception {
		String agent = url(Surface.AGENT);
		String rows = """
			[{"source":"pi","session_id":"s1","id":"e1","payload":{"b":1,"a":2}},
			 {"session_id":"s1","id":"e2","payload":"text"}]
			""";
		assertEquals(401, post(agent, "/ingest/session", rows, null).statusCode());
		HttpResponse<String> first = post(agent, "/ingest/session", rows, "agents");
		assertEquals(200, first.statusCode());
		assertTrue(first.body().contains("\"accepted\":2"), first.body());
		HttpResponse<String> replay = post(agent, "/ingest/session", rows, "agents");
		assertTrue(replay.body().contains("\"accepted\":0"), replay.body());
		assertTrue(replay.body().contains("\"duplicates\":2"), replay.body());

		List<String> lines = Files.readAllLines(HOME.resolve("spool.ndjson"));
		assertEquals(2, lines.size());
		assertTrue(lines.get(0).contains("\"session_id\":\"s1\""));

		assertEquals(405, call("GET", agent, "/ingest/session", null, "agents").statusCode());
		assertEquals(404, post(agent, "/other", "{}", "agents").statusCode());
	}

	/**
	 * The demotion contract, asserted where it is visible: a date-bounded query
	 * prunes the candidate scan (a cold generation is an \u0060added\u0060 window),
	 * postings name integer document ids, and the corpus parameters are
	 * maintained rather than recomputed by a full scan.
	 */
	@Test
	void dateWindowPrunesAndTheIndexStaysConsistent() throws Exception {
		String origin = url(Surface.HISTER);
		long now = java.time.Instant.now().getEpochSecond();
		assertEquals(201, post(origin, "/api/add",
			"{\"url\":\"https://window.example/p\",\"title\":\"Window\",\"text\":\"windowbody\"}",
			"secret").statusCode());
		assertTrue(call("GET", origin, "/search?q=windowbody&date_from=" + (now - 60), null, null).body()
			.contains("\"total\":1"));
		assertTrue(call("GET", origin, "/search?q=windowbody&date_from=" + (now + 3600), null, null).body()
			.contains("\"total\":0"));
		assertTrue(call("GET", origin, "/search?q=windowbody&date_to=" + (now - 3600), null, null).body()
			.contains("\"total\":0"));
		assertTrue(call("GET", origin, "/search?q=*&date_from=" + (now + 3600), null, null).body()
			.contains("\"total\":0"));

		Integer doc = writer.queryForObject(
			"SELECT doc FROM lakehouse_doc WHERE norm_url = 'window.example/p'", Integer.class);
		assertTrue(doc != null && doc > 0, "the document has an index id");
		assertTrue(writer.queryForObject(
			"SELECT count(*) FROM lakehouse_posting WHERE doc = ? AND term = 'windowbody'", Integer.class, doc) > 0,
			"the posting names the document id");
		assertEquals(0, writer.queryForObject(
			"SELECT count(*) FROM lakehouse_posting WHERE doc NOT IN (SELECT doc FROM lakehouse_doc)", Integer.class));
		assertTrue(writer.queryForObject("SELECT documents FROM lakehouse_stats WHERE id = 0", Long.class) > 0);
		assertTrue(writer.queryForObject("SELECT length_sum FROM lakehouse_stats WHERE id = 0", Long.class) > 0);
	}

	/**
	 * The index is derived state: losing its mark rebuilds it from the stored
	 * documents, which is the same input a Parquet demotion reads.
	 */
	@Test
	void rebuildRestoresTheIndexFromStoredDocuments() throws Exception {
		String origin = url(Surface.HISTER);
		assertEquals(201, post(origin, "/api/add",
			"{\"url\":\"https://rebuild.example/p\",\"title\":\"Rebuild\",\"text\":\"rebuildbody\"}",
			"secret").statusCode());
		writer.update("DELETE FROM meta WHERE key = 'lakehouse.index_schema'");
		index.ensureIndex();
		assertTrue(call("GET", origin, "/search?q=rebuildbody", null, null).body()
			.contains("https://rebuild.example/p"));
		assertEquals(0, writer.queryForObject(
			"SELECT count(*) FROM lakehouse_posting WHERE doc NOT IN (SELECT doc FROM lakehouse_doc)", Integer.class));
	}

	/**
	 * The two implementations share one store, not one index. The Python
	 * daemon's `posting`/`doc_length` tables and its `meta.fts_schema` mark must
	 * survive this service's rebuild untouched, which is what makes the switch
	 * between them a rebuild of derived state rather than a migration.
	 */
	@Test
	void leavesTheDaemonsOwnIndexUntouched() {
		writer.execute("CREATE TABLE IF NOT EXISTS posting(term TEXT NOT NULL, owner INTEGER NOT NULL,"
			+ " norm_url TEXT NOT NULL, field INTEGER NOT NULL, tf INTEGER NOT NULL,"
			+ " PRIMARY KEY(term, owner, norm_url, field)) WITHOUT ROWID");
		writer.execute("CREATE TABLE IF NOT EXISTS doc_length(owner INTEGER NOT NULL,"
			+ " norm_url TEXT NOT NULL, length INTEGER NOT NULL, PRIMARY KEY(owner, norm_url)) WITHOUT ROWID");
		writer.update("INSERT OR IGNORE INTO posting(term, owner, norm_url, field, tf)"
			+ " VALUES('daemonterm', 0, 'daemon.example/p', 2, 1)");
		writer.update("INSERT INTO meta(key, value) VALUES('fts_schema', '1')"
			+ " ON CONFLICT(key) DO UPDATE SET value = '1'");
		writer.update("DELETE FROM meta WHERE key = 'lakehouse.index_schema'");
		index.ensureIndex();
		assertEquals(1, writer.queryForObject(
			"SELECT count(*) FROM posting WHERE term = 'daemonterm'", Integer.class));
		assertEquals("1", writer.queryForObject(
			"SELECT value FROM meta WHERE key = 'fts_schema'", String.class));
	}

	/**
	 * The import kinds carry a stored row as it was: capture time, update time,
	 * add count, label, type, metadata, HTML and the source's own key survive,
	 * the rules (including the alias map the reference store has no column for)
	 * round-trip, and a replay is idempotent instead of bumping the counters.
	 */
	@Test
	void importPreservesStoredRowsAndIsIdempotent() throws Exception {
		String origin = url(Surface.HISTER);
		String envelope = """
			{"schema":1,"stream":"import","records":[
			 {"src":"import","kind":"document","url":"https://imported.example/a",
			  "norm_url":"imported.example/a","title":"Imported","text":"importedpayload",
			  "html":"<p>importedpayload</p>","favicon":"https://imported.example/f.ico",
			  "language":"en","label":"archive","type":2,"owner":0,
			  "added":1600000000,"updated":1600000100,"add_count":7,
			  "metadata":{"source":"hister"}},
			 {"src":"import","kind":"rule","name":"aliases","patterns":{"gh":"github.com"}},
			 {"src":"import","kind":"rule","name":"priority","patterns":["github\\\\.com"]},
			 {"src":"import","kind":"click","url":"https://imported.example/a","title":"Imported",
			  "query":"imported","added":1600000200}]}
			""";
		HttpResponse<String> first = post(origin, "/ingest/slurp", envelope, "secret");
		assertEquals(200, first.statusCode());
		assertTrue(first.body().contains("\"accepted\":4"), first.body());
		String document = call("GET", origin, "/api/document?url=https://imported.example/a", null, null).body();
		assertTrue(document.contains("\"added\":1600000000"), document);
		assertTrue(document.contains("\"updated\":1600000100"), document);
		assertTrue(document.contains("\"add_count\":7"), document);
		assertTrue(document.contains("\"label\":\"archive\""), document);
		assertTrue(document.contains("\"type\":2"), document);
		assertTrue(document.contains("\"metadata\":{\"source\":\"hister\"}"), document);
		assertTrue(document.contains("<p>importedpayload</p>"), document);
		// The capture time is the query window and the demotion axis.
		assertTrue(call("GET", origin, "/search?q=importedpayload&date_to=1600000100", null, null).body()
			.contains("imported.example/a"));
		assertTrue(call("GET", origin, "/search?q=importedpayload&date_to=1599999999", null, null).body()
			.contains("\"total\":0"));
		assertEquals(1600000000L, writer.queryForObject(
			"SELECT added FROM lakehouse_doc WHERE norm_url = 'imported.example/a'", Long.class));
		String rules = call("GET", origin, "/api/rules", null, null).body();
		assertTrue(rules.contains("\"aliases\":{\"gh\":\"github.com\"}"), rules);
		assertTrue(rules.contains("\"priority\":[\"github\\\\.com\"]"), rules);
		assertEquals(1, writer.queryForObject(
			"SELECT count(*) FROM click WHERE url = 'https://imported.example/a'", Integer.class));

		HttpResponse<String> replay = post(origin, "/ingest/slurp", envelope, "secret");
		assertTrue(replay.body().contains("\"accepted\":0"), replay.body());
		assertTrue(replay.body().contains("\"duplicates\":4"), replay.body());
		assertEquals(1, writer.queryForObject(
			"SELECT count(*) FROM click WHERE url = 'https://imported.example/a'", Integer.class));
		assertEquals(1600000100L, writer.queryForObject(
			"SELECT updated FROM document WHERE norm_url = 'imported.example/a'", Long.class));
	}

	@Test
	void canonicalIdentityIsOrderIndependent() {
		var mapper = tools.jackson.databind.json.JsonMapper.shared();
		assertEquals(
			SessionIngest.rowKey(mapper.readTree("{\"session_id\":\"s\",\"id\":\"e\",\"a\":1}"), mapper),
			SessionIngest.rowKey(mapper.readTree("{\"id\":\"e\",\"a\":1,\"session_id\":\"s\"}"), mapper));
		assertEquals(
			SessionIngest.rowHash(mapper.readTree("{\"a\":1,\"b\":[1,2]}")),
			SessionIngest.rowHash(mapper.readTree("{\"b\":[1,2],\"a\":1}")));
		// The reference daemon hashes the JSON.parse shape, so a float and the
		// integer it equals are one row, and a value past 2^53 hashes as the
		// rounded double. Without this a row posted before the switch and
		// re-posted after it would land in the warehouse twice.
		assertEquals(
			SessionIngest.rowHash(mapper.readTree("{\"n\":1}")),
			SessionIngest.rowHash(mapper.readTree("{\"n\":1.0}")));
		assertEquals(
			SessionIngest.rowHash(mapper.readTree("{\"n\":9007199254740993}")),
			SessionIngest.rowHash(mapper.readTree("{\"n\":9007199254740992}")));
	}
}
