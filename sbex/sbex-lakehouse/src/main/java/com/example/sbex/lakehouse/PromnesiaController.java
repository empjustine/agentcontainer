package com.example.sbex.lakehouse;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The Promnesia face (docs/d205): /status, /visited, /visits and
 * /search_around. (/search lives in SearchController because the two protocols
 * share that path.) Each envelope is streamed; see PromnesiaService.
 */
@RestController
class PromnesiaController {

	private final PromnesiaService promnesia;
	private final LakehouseProperties properties;
	private final JsonMapper mapper;

	PromnesiaController(PromnesiaService promnesia, LakehouseProperties properties, JsonMapper mapper) {
		this.promnesia = promnesia;
		this.properties = properties;
		this.mapper = mapper;
	}

	@GetMapping("/status")
	Map<String, Object> status() {
		return promnesia.status();
	}

	@GetMapping(value = "/visited", produces = MediaType.APPLICATION_JSON_VALUE)
	StreamingResponseBody visitedGet(HttpServletRequest request, HttpServletResponse response) {
		Map<String, List<String>> params = SearchController.params(request);
		List<String> urls = new ArrayList<>();
		urls.addAll(params.getOrDefault("urls", List.of()));
		urls.addAll(params.getOrDefault("url", List.of()));
		return visited(urls, response);
	}

	@PostMapping(value = "/visited", produces = MediaType.APPLICATION_JSON_VALUE)
	StreamingResponseBody visitedPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
		JsonNode body = Bodies.json(request, mapper);
		JsonNode urls = body.get("urls");
		if (urls == null || urls.isNull()) {
			throw new LakehouseProblems.BadRequestException("urls must be an array");
		}
		if (!urls.isArray()) {
			throw new LakehouseProblems.BadRequestException("urls must be an array");
		}
		List<String> values = new ArrayList<>(urls.size());
		for (JsonNode url : urls) {
			values.add(url.isNull() ? "" : url.asString());
		}
		return visited(values, response);
	}

	private StreamingResponseBody visited(List<String> urls, HttpServletResponse response) {
		if (urls.size() > properties.maxVisitedUrls()) {
			throw new LakehouseProblems.PayloadTooLargeException(
				"more than " + properties.maxVisitedUrls() + " urls");
		}
		response.setContentType(MediaType.APPLICATION_JSON_VALUE);
		return output -> promnesia.streamVisited(urls, output);
	}

	@GetMapping(value = "/visits", produces = MediaType.APPLICATION_JSON_VALUE)
	StreamingResponseBody visitsGet(HttpServletRequest request, HttpServletResponse response) {
		String url = SearchController.params(request).getOrDefault("url", List.of("")).get(0);
		response.setContentType(MediaType.APPLICATION_JSON_VALUE);
		return output -> promnesia.streamVisits(url, output);
	}

	@PostMapping(value = "/visits", produces = MediaType.APPLICATION_JSON_VALUE)
	StreamingResponseBody visitsPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
		JsonNode body = Bodies.json(request, mapper);
		JsonNode url = body.get("url");
		response.setContentType(MediaType.APPLICATION_JSON_VALUE);
		String value = url == null ? "" : SearchController.text(url);
		return output -> promnesia.streamVisits(value, output);
	}

	@GetMapping(value = "/search_around", produces = MediaType.APPLICATION_JSON_VALUE)
	StreamingResponseBody aroundGet(HttpServletRequest request, HttpServletResponse response) {
		Map<String, List<String>> params = SearchController.params(request);
		String timestamp = params.getOrDefault("timestamp", List.of("")).get(0);
		return around(timestamp, response);
	}

	@PostMapping(value = "/search_around", produces = MediaType.APPLICATION_JSON_VALUE)
	StreamingResponseBody aroundPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
		JsonNode body = Bodies.json(request, mapper);
		JsonNode timestamp = body.get("timestamp");
		return around(timestamp == null ? "" : SearchController.text(timestamp), response);
	}

	private StreamingResponseBody around(String timestamp, HttpServletResponse response) {
		if (timestamp.isEmpty()) {
			throw new LakehouseProblems.BadRequestException("missing timestamp");
		}
		double centre;
		try {
			centre = Double.parseDouble(timestamp);
		} catch (NumberFormatException exception) {
			throw new LakehouseProblems.BadRequestException("bad timestamp: '" + timestamp + "'", exception);
		}
		if (!Double.isFinite(centre)) {
			throw new LakehouseProblems.BadRequestException("timestamp must be finite");
		}
		response.setContentType(MediaType.APPLICATION_JSON_VALUE);
		double centreValue = centre;
		return output -> promnesia.streamSearchAround(centreValue, output);
	}
}
