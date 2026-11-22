package com.example.sbex.lakehouse;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Locale;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

/**
 * The one place a request meets the rules every surface shares: which
 * protocol its port answers, the extension CORS grant, the static key on the
 * write faces, the body ceiling, and the one log line per request. Routing,
 * logging, auth and error mapping in one filter is what keeps a second copy of
 * any of them from appearing on a route (browse-daemon.py's _dispatch).
 *
 * WHY the key gates writes only: the stock Promnesia extension has no field to
 * carry one and the default bind is loopback, so gating its reads would lock
 * the sidebar out of its own data. The operator who binds wider takes the key
 * as the network secret, and the Agent route — whose whole boundary is the
 * write gate — fails closed instead.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
class SurfaceFilter extends OncePerRequestFilter {

	/** The request attribute controllers read to learn which protocol they answer. */
	static final String SURFACE_ATTRIBUTE = "lakehouse.surface";

	private static final String OPTIONS = "OPTIONS";

	private static final Logger log = LoggerFactory.getLogger(SurfaceFilter.class);

	/** The daemon's write faces, in the order its _WRITE_PATHS lists them. */
	private static final List<String> WRITE_PATHS = List.of(
		"/ingest/slurp", "/api/add", "/api/add_pdf", "/api/delete", "/api/label", "/api/rules", "/api/history");

	/**
	 * Safari preflights every extension fetch; Firefox and Chrome exempt it.
	 * The headers hister's own server allows are echoed so the stock extension
	 * needs no different server on either browser.
	 */
	private static final List<String> EXTENSION_ORIGINS =
		List.of("moz-extension://", "safari-web-extension://", "chrome-extension://");

	private static final String ALLOW_HEADERS =
		"Content-Type, X-Access-Token, X-Hister-Public, X-CSRF-Token, Authorization";

	/**
	 * An echoed header is attacker-controlled unless it is validated: a CR/LF in
	 * an Origin or in the requested header list is a response-splitting attempt.
	 * The accepted shapes are exactly what a WebExtension origin and a CORS
	 * header list look like, so nothing legitimate is lost.
	 */
	private static final java.util.regex.Pattern EXTENSION_ORIGIN_VALUE =
		java.util.regex.Pattern.compile("[a-z][a-z0-9-]*-extension://[A-Za-z0-9._-]+");
	private static final java.util.regex.Pattern HEADER_TOKEN_LIST =
		java.util.regex.Pattern.compile("[A-Za-z0-9!#$%&'*+.^_`|~-]+(\\s*,\\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+)*");

	private final SurfacePorts ports;
	private final LakehouseProperties properties;
	private final JsonMapper mapper;

	SurfaceFilter(SurfacePorts ports, LakehouseProperties properties, JsonMapper mapper) {
		this.ports = ports;
		this.properties = properties;
		this.mapper = mapper;
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		long started = System.nanoTime();
		String path = stripTrailingSlash(request.getRequestURI());
		Surface surface = ports.of(request.getLocalPort());
		if (surface == null) {
			problem(response, LakehouseProblems.notFound("unknown listener port"));
			return;
		}
		request.setAttribute(SURFACE_ATTRIBUTE, surface);
		cors(request, response);
		try {
			if (OPTIONS.equals(request.getMethod())) {
				// A preflight never carries the key: the browser sends it on the
				// real request, so requiring it here would fail every cross-origin
				// POST.
				response.setStatus(HttpStatus.NO_CONTENT.value());
				return;
			}
			if (!answers(surface, path)) {
				problem(response, LakehouseProblems.notFound("unknown path on " + surface + ": " + path));
				return;
			}
			if (!authorised(surface, path, request)) {
				problem(response, LakehouseProblems.problem(
					HttpStatus.UNAUTHORIZED, "unauthorized", "Unauthorized", "missing or bad token"));
				return;
			}
			if (declaredLength(request) > ceiling(surface)) {
				problem(response, LakehouseProblems.problem(
					HttpStatus.CONTENT_TOO_LARGE, "payload-too-large", "Payload too large",
					"body exceeds " + ceiling(surface) + " bytes"));
				return;
			}
			chain.doFilter(new LimitedRequest(request, ceiling(surface)), response);
		} finally {
			// A streaming read face commits its body on another thread, so this
			// line reports the status the route chose (200 for an accepted
			// export), and a mid-stream store failure is the stream's own error,
			// logged where it happens.
			log.info("{} {} {} {}ms", request.getMethod(), path, response.getStatus(),
				(System.nanoTime() - started) / 1_000_000);
		}
	}

	/** Each listener answers only its own protocol's paths (docs/d205). */
	private static boolean answers(Surface surface, String path) {
		return switch (surface) {
			case HISTER -> "/search".equals(path) || "/ingest/slurp".equals(path) || path.startsWith("/api/")
				|| path.startsWith("/actuator/");
			case PROMNESIA -> "/status".equals(path) || "/visited".equals(path) || "/visits".equals(path)
				|| "/search".equals(path) || "/search_around".equals(path) || path.startsWith("/actuator/");
			case AGENT -> "/ingest/session".equals(path) || path.startsWith("/actuator/");
		};
	}

	private boolean authorised(Surface surface, String path, HttpServletRequest request) {
		if (!"POST".equals(request.getMethod())) {
			return true;
		}
		if (surface == Surface.AGENT) {
			return matches(request.getHeader("X-Ingest-Token"), properties.ingestToken());
		}
		if (!WRITE_PATHS.contains(path)) {
			return true;
		}
		String given = request.getHeader("X-Access-Token");
		if (given == null || given.isEmpty()) {
			String authorization = request.getHeader("Authorization");
			given = authorization != null && authorization.toLowerCase(Locale.ROOT).startsWith("bearer ")
				? authorization.substring(7)
				: "";
		}
		return matches(given, properties.browseToken());
	}

	/**
	 * A length-independent, prefix-independent compare: plain equals leaks the
	 * position of the first wrong byte to anyone measuring a wide bind.
	 */
	private static boolean matches(String given, String expected) {
		String key = expected == null ? "" : expected;
		if (key.isEmpty()) {
			return true;
		}
		return MessageDigest.isEqual(
			(given == null ? "" : given).getBytes(StandardCharsets.UTF_8), key.getBytes(StandardCharsets.UTF_8));
	}

	private int ceiling(Surface surface) {
		return surface == Surface.AGENT ? properties.ingestMaxBody() : properties.maxBody();
	}

	private static long declaredLength(HttpServletRequest request) {
		String header = request.getHeader("Content-Length");
		if (header == null || header.isEmpty()) {
			return -1;
		}
		try {
			return Long.parseLong(header);
		} catch (NumberFormatException exception) {
			throw new LakehouseProblems.BadRequestException("invalid content-length", exception);
		}
	}

	private void cors(HttpServletRequest request, HttpServletResponse response) {
		String origin = request.getHeader("Origin");
		if (origin == null || !EXTENSION_ORIGIN_VALUE.matcher(origin).matches()
				|| EXTENSION_ORIGINS.stream().noneMatch(origin::startsWith)) {
			return;
		}
		response.setHeader("Access-Control-Allow-Origin", origin);
		response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
		String requested = request.getHeader("Access-Control-Request-Headers");
		response.setHeader("Access-Control-Allow-Headers",
			requested != null && HEADER_TOKEN_LIST.matcher(requested).matches() ? requested : ALLOW_HEADERS);
		response.setHeader("Access-Control-Max-Age", "600");
		response.setHeader("Vary", "Origin");
	}

	private void problem(HttpServletResponse response, ProblemDetail problem) throws IOException {
		response.setStatus(problem.getStatus());
		response.setContentType("application/problem+json");
		mapper.writeValue(response.getOutputStream(), problem);
	}

	private static String stripTrailingSlash(String path) {
		String stripped = path;
		while (stripped.length() > 1 && stripped.endsWith("/")) {
			stripped = stripped.substring(0, stripped.length() - 1);
		}
		return stripped;
	}

	/**
	 * The body ceiling applied while the body is read, not only from its
	 * declared length: a chunked or lying client must not be able to force an
	 * unbounded allocation. The daemon's ceilings are the same numbers.
	 */
	private static final class LimitedRequest extends HttpServletRequestWrapper {

		private final int limit;
		private ServletInputStream stream;

		LimitedRequest(HttpServletRequest request, int limit) {
			super(request);
			this.limit = limit;
		}

		@Override
		public ServletInputStream getInputStream() throws IOException {
			if (stream == null) {
				stream = new LimitedInputStream(super.getInputStream(), limit);
			}
			return stream;
		}

		@Override
		public BufferedReader getReader() throws IOException {
			return new BufferedReader(new InputStreamReader(getInputStream(), StandardCharsets.UTF_8));
		}
	}

	private static final class LimitedInputStream extends ServletInputStream {

		private final ServletInputStream delegate;
		private final int limit;
		private long consumed;

		LimitedInputStream(ServletInputStream delegate, int limit) {
			this.delegate = delegate;
			this.limit = limit;
		}

		@Override
		public int read() throws IOException {
			int value = delegate.read();
			count(value < 0 ? 0 : 1);
			return value;
		}

		@Override
		public int read(byte[] buffer, int offset, int length) throws IOException {
			int count = delegate.read(buffer, offset, length);
			count(count < 0 ? 0 : count);
			return count;
		}

		@Override
		public int available() throws IOException {
			return delegate.available();
		}

		@Override
		public void close() throws IOException {
			delegate.close();
		}

		@Override
		public boolean isFinished() {
			return delegate.isFinished();
		}

		@Override
		public boolean isReady() {
			return delegate.isReady();
		}

		@Override
		public void setReadListener(ReadListener listener) {
			delegate.setReadListener(listener);
		}

		private void count(int bytes) {
			consumed += bytes;
			if (consumed > limit) {
				throw new LakehouseProblems.PayloadTooLargeException("body exceeds " + limit + " bytes");
			}
		}
	}
}
