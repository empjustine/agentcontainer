package com.example.sbex.lakehouse;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.LinkedHashMap;
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
 * /search is one path with two protocols (docs/d205): a `url` parameter is
 * Promnesia's visit search, anything else is the hister query dialect. The port
 * the request arrived on decides which controller is allowed to answer, so this
 * controller is the only place the shared path needs the branch.
 */
@RestController
class SearchController {

	private final HisterService hister;
	private final PromnesiaService promnesia;
	private final JsonMapper mapper;

	SearchController(HisterService hister, PromnesiaService promnesia, JsonMapper mapper) {
		this.hister = hister;
		this.promnesia = promnesia;
		this.mapper = mapper;
	}

	@GetMapping(value = "/search", produces = MediaType.APPLICATION_JSON_VALUE)
	Object searchGet(HttpServletRequest request, HttpServletResponse response) {
		Map<String, List<String>> params = params(request);
		if (surface(request) == Surface.PROMNESIA && params.containsKey("url")) {
			return promnesiaSearch(first(params.get("url")), response);
		}
		return hister.search(SearchQuery.fromParams(params, mapper));
	}

	@PostMapping(value = "/search", produces = MediaType.APPLICATION_JSON_VALUE)
	Object searchPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
		JsonNode body = Bodies.json(request, mapper);
		if (surface(request) == Surface.PROMNESIA) {
			JsonNode url = body.get("url");
			if (url != null) {
				return promnesiaSearch(text(url), response);
			}
		}
		return hister.search(SearchQuery.fromBody(body, mapper));
	}

	private StreamingResponseBody promnesiaSearch(String text, HttpServletResponse response) {
		response.setContentType(MediaType.APPLICATION_JSON_VALUE);
		return output -> promnesia.streamSearch(text, output);
	}

	private static Surface surface(HttpServletRequest request) {
		return (Surface) request.getAttribute(SurfaceFilter.SURFACE_ATTRIBUTE);
	}

	/** The first value of each query parameter, as the daemon reads them. */
	static Map<String, List<String>> params(HttpServletRequest request) {
		Map<String, List<String>> params = new LinkedHashMap<>();
		request.getParameterMap().forEach((key, values) -> params.put(key, List.of(values)));
		return params;
	}

	private static String first(List<String> values) {
		return values == null || values.isEmpty() ? "" : values.get(0);
	}

	/** A JSON value as the daemon's str(): an array means its first element. */
	static String text(JsonNode value) {
		if (value == null || value.isNull()) {
			return "";
		}
		JsonNode scalar = value.isArray() ? (value.size() == 0 ? null : value.get(0)) : value;
		return scalar == null || scalar.isNull() ? "" : scalar.asString();
	}
}
