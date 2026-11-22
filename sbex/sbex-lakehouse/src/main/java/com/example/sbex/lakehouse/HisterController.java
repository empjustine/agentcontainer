package com.example.sbex.lakehouse;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The hister face's routes (docs/d205). The controller validates and shapes
 * HTTP; the service owns the store, the index and the rules, and the port check
 * already refused a request that came in on the Promnesia listener.
 */
@RestController
@RequestMapping("/api")
class HisterController {

	private static final Logger log = LoggerFactory.getLogger(HisterController.class);

	private final HisterService hister;
	private final PdfText pdfText;
	private final LakehouseProperties properties;
	private final JsonMapper mapper;

	HisterController(
			HisterService hister, PdfText pdfText, LakehouseProperties properties, JsonMapper mapper) {
		this.hister = hister;
		this.pdfText = pdfText;
		this.properties = properties;
		this.mapper = mapper;
	}

	@GetMapping("/config")
	Map<String, Object> config() {
		return hister.config(!properties.browseToken().isEmpty());
	}

	/**
	 * Upstream's single-user mode answers 200 with no body (its
	 * UserHandling branch is off); the extension treats that as user 0. A
	 * synthetic user_id made it believe the server had accounts.
	 */
	@GetMapping("/profile")
	ResponseEntity<Void> profile() {
		return ResponseEntity.ok().build();
	}

	@GetMapping("/rules")
	Map<String, Object> rules() {
		return hister.loadRules();
	}

	@PostMapping("/rules")
	ResponseEntity<Void> saveRules(HttpServletRequest request) throws IOException {
		hister.saveRules(Forms.parse(body(request), properties.maxFormFields()));
		return ResponseEntity.ok().build();
	}

	/**
	 * GET answers the document, HEAD is the extension's "already indexed"
	 * probe: 200 or 404 is the whole contract there, and Spring drops the body
	 * of a HEAD response on its own.
	 */
	@RequestMapping(value = "/document", method = { RequestMethod.GET, RequestMethod.HEAD })
	Object document(@RequestParam(required = false) String url) {
		if (url == null || url.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("missing url");
		}
		Map<String, Object> document = hister.documentJson(url);
		if (document == null) {
			throw new LakehouseProblems.NotFoundException("document not found");
		}
		return document;
	}

	@PostMapping("/add")
	ResponseEntity<Void> add(HttpServletRequest request) throws IOException {
		String contentType = request.getContentType() == null ? "" : request.getContentType();
		JsonNode payload = contentType.contains("json")
			? Bodies.json(request, mapper)
			: mapper.valueToTree(Forms.parse(body(request), properties.maxFormFields()));
		return ResponseEntity.status(hister.add(payload)).build();
	}

	/**
	 * A PDF is decoded under the ceiling before it is read, then extracted in a
	 * child JVM. Upstream fails the capture when the index cannot see the
	 * document, and so does this route: a 500 with an extraction-error type.
	 */
	@PostMapping("/add_pdf")
	ResponseEntity<Void> addPdf(HttpServletRequest request) throws IOException {
		JsonNode payload = Bodies.json(request, mapper);
		JsonNode document = payload.get("document");
		if (document == null || !document.isObject()) {
			throw new LakehouseProblems.BadRequestException("missing document field");
		}
		JsonNode encoded = payload.get("pdf");
		if (encoded == null || !encoded.isString() || encoded.asString().isEmpty()) {
			throw new LakehouseProblems.BadRequestException("missing pdf field");
		}
		String base64 = encoded.asString();
		// Check the encoded length before decoding: b64decode of a
		// declared-gigabyte string allocates the whole payload first.
		if (base64.length() > (properties.maxPdfBytes() * 4L / 3L) + 8L) {
			throw new LakehouseProblems.PayloadTooLargeException(
				"pdf exceeds " + properties.maxPdfBytes() + " bytes");
		}
		byte[] data;
		try {
			data = Base64.getDecoder().decode(base64);
		} catch (IllegalArgumentException exception) {
			throw new LakehouseProblems.BadRequestException(
				"pdf must be base64-encoded: " + exception.getMessage(), exception);
		}
		if (data.length > properties.maxPdfBytes()) {
			throw new LakehouseProblems.PayloadTooLargeException(
				"pdf exceeds " + properties.maxPdfBytes() + " bytes");
		}
		String text;
		try {
			text = pdfText.extract(data);
		} catch (PdfText.ExtractionException failure) {
			// The parser's words stay in the log: a response body is not the
			// place for a library trace, but the extraction failure is the
			// capture's failure, so it keeps upstream's 5xx.
			log.error("pdf extraction", failure);
			throw new LakehouseProblems.ExtractionFailedException("pdf text extraction failed", failure);
		}
		if (text.isEmpty()) {
			throw new LakehouseProblems.ExtractionFailedException("pdf contains no extractable text");
		}
		Map<String, Object> added = metadataWithPdfBytes(document, data.length);
		added.put("type", 2);
		added.put("text", text);
		added.put("html", "");
		return ResponseEntity.status(hister.add(mapper.valueToTree(added))).build();
	}

	@SuppressWarnings("unchecked")
	private Map<String, Object> metadataWithPdfBytes(JsonNode document, int bytes) {
		Map<String, Object> added = mapper.convertValue(document, Map.class);
		Map<String, Object> metadata = new LinkedHashMap<>();
		Object raw = added.get("metadata");
		if (raw instanceof Map<?, ?> map) {
			map.forEach((key, value) -> metadata.put(String.valueOf(key), value));
		} else if (raw instanceof String text && !text.isEmpty()) {
			try {
				JsonNode parsed = mapper.readTree(text);
				if (parsed.isObject()) {
					metadata.putAll(mapper.convertValue(parsed, Map.class));
				}
			} catch (RuntimeException notJson) {
				metadata.put("raw", text);
			}
		}
		metadata.put("pdf_bytes", bytes);
		added.put("metadata", metadata);
		return added;
	}

	@PostMapping("/label")
	Map<String, Object> label(HttpServletRequest request) throws IOException {
		JsonNode payload = Bodies.json(request, mapper);
		String url = Json.text(payload, "url");
		if (url == null || url.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("missing url");
		}
		String label = Json.textOr(payload, "label", "");
		if (!hister.label(url, label)) {
			throw new LakehouseProblems.NotFoundException("document not found");
		}
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("ok", true);
		return result;
	}

	/**
	 * Upstream's /api/delete is a query, not a URL: the extension sends
	 * url:"..." and domain:…, and the same dialect /search parses decides what
	 * goes. A document is a capture, not a visit, so visits stay.
	 */
	@PostMapping("/delete")
	Map<String, Object> delete(HttpServletRequest request) throws IOException {
		JsonNode payload = Bodies.json(request, mapper);
		String query = Json.textOr(payload, "query", "");
		if (query.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("missing query");
		}
		return hister.delete(query, truthy(payload.get("dry_run")));
	}

	@PostMapping("/history")
	ResponseEntity<Void> history(HttpServletRequest request) throws IOException {
		hister.history(Bodies.json(request, mapper));
		return ResponseEntity.status(HttpStatus.CREATED).build();
	}

	/**
	 * Upstream serves both, but the hister extension calls neither (docs/d205),
	 * and the web UI is out of scope, so the deferral is answered instead of a
	 * guessed model.
	 */
	@GetMapping({ "/versions", "/facets" })
	ProblemDetail deferred(HttpServletRequest request) {
		return LakehouseProblems.problem(HttpStatus.NOT_IMPLEMENTED, "not-implemented",
			"Not implemented", request.getRequestURI() + " is not built (docs/d205)");
	}

	private static boolean truthy(JsonNode value) {
		if (value == null || value.isNull()) {
			return false;
		}
		if (value.isBoolean()) {
			return value.asBoolean();
		}
		if (value.isNumber()) {
			return value.asDouble() != 0;
		}
		if (value.isArray()) {
			return value.size() > 0;
		}
		return !value.asString().isEmpty();
	}

	private static String body(HttpServletRequest request) throws IOException {
		try (InputStream input = request.getInputStream()) {
			return new String(input.readAllBytes(), StandardCharsets.UTF_8);
		}
	}
}
