package com.example.sbex.lakehouse;

import java.net.URI;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * The one error shape of docs/d204 and docs/d205: an RFC 9457 problem
 * document whose type is a stable slug, so a client branches on the type and
 * not on prose, and whose detail never carries the store's own words (a table
 * or SQL fragment in a body is a schema leak).
 *
 * The slugs are the daemon's, because the stock extensions and the shell
 * conformance suite already read them.
 */
@RestControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE)
class LakehouseProblems {

	static final String PROBLEM_BASE = "https://agentcontainer.example/problems/";

	private static final Logger log = LoggerFactory.getLogger(LakehouseProblems.class);

	/** A request the route refused on its own values (400, interface-error). */
	static class BadRequestException extends RuntimeException {

		private static final long serialVersionUID = 1L;

		BadRequestException(String message) {
			super(message);
		}

		BadRequestException(String message, Throwable cause) {
			super(message, cause);
		}
	}

	/** A body or field count above the configured ceiling (413). */
	static class PayloadTooLargeException extends BadRequestException {

		private static final long serialVersionUID = 1L;

		PayloadTooLargeException(String message) {
			super(message);
		}

		PayloadTooLargeException(String message, Throwable cause) {
			super(message, cause);
		}
	}

	/**
	 * A producer wire schema this daemon does not speak (409). The producer
	 * treats it as a permanent reject: a retry of the same bytes cannot
	 * succeed, so the producer must be upgraded instead.
	 */
	static class UnsupportedSchemaException extends RuntimeException {

		private static final long serialVersionUID = 1L;

		UnsupportedSchemaException(String message) {
			super(message);
		}
	}

	/** A store the request needed and could not reach (500, store-error). */
	static class StoreUnavailableException extends RuntimeException {

		private static final long serialVersionUID = 1L;

		StoreUnavailableException(String message) {
			super(message);
		}

		StoreUnavailableException(String message, Throwable cause) {
			super(message, cause);
		}
	}

	/** A capture whose text the index cannot see (500, extraction-error). */
	static class ExtractionFailedException extends RuntimeException {

		private static final long serialVersionUID = 1L;

		ExtractionFailedException(String message) {
			super(message);
		}

		ExtractionFailedException(String message, Throwable cause) {
			super(message, cause);
		}
	}

	/** A named thing the store does not hold (404, not-found). */
	static class NotFoundException extends RuntimeException {

		private static final long serialVersionUID = 1L;

		NotFoundException(String message) {
			super(message);
		}
	}

	/** A face or path this listener does not answer (404, not-found). */
	static ProblemDetail notFound(String detail) {
		return problem(HttpStatus.NOT_FOUND, "not-found", "Not found", detail);
	}

	/** The shared builder, also used by the surface filter's own refusals. */
	static ProblemDetail problem(HttpStatus status, String slug, String title, String detail) {
		ProblemDetail problem = ProblemDetail.forStatusAndDetail(status, detail);
		problem.setType(URI.create(PROBLEM_BASE + slug));
		problem.setTitle(title);
		return problem;
	}

	@ExceptionHandler(BadRequestException.class)
	ProblemDetail badRequest(BadRequestException exception) {
		return problem(HttpStatus.BAD_REQUEST, "interface-error", "Interface error", exception.getMessage());
	}

	@ExceptionHandler(PayloadTooLargeException.class)
	ProblemDetail payloadTooLarge(PayloadTooLargeException exception) {
		return problem(HttpStatus.CONTENT_TOO_LARGE, "payload-too-large", "Payload too large", exception.getMessage());
	}

	@ExceptionHandler(UnsupportedSchemaException.class)
	ProblemDetail unsupportedSchema(UnsupportedSchemaException exception) {
		return problem(HttpStatus.CONFLICT, "unsupported-schema", "Unsupported schema", exception.getMessage());
	}

	@ExceptionHandler(NotFoundException.class)
	ProblemDetail notFound(NotFoundException exception) {
		return problem(HttpStatus.NOT_FOUND, "not-found", "Not found", exception.getMessage());
	}

	@ExceptionHandler(StoreUnavailableException.class)
	ProblemDetail storeUnavailable(StoreUnavailableException exception) {
		log.error("store unavailable: {}", exception.getMessage());
		return problem(HttpStatus.INTERNAL_SERVER_ERROR, "store-error", "Store error",
			"the store could not answer");
	}

	@ExceptionHandler(ExtractionFailedException.class)
	ProblemDetail extractionFailed(ExtractionFailedException exception) {
		return problem(HttpStatus.INTERNAL_SERVER_ERROR, "extraction-error", "Extraction failed",
			exception.getMessage());
	}

	@ExceptionHandler(MissingServletRequestParameterException.class)
	ProblemDetail missingParameter(MissingServletRequestParameterException exception) {
		return problem(HttpStatus.BAD_REQUEST, "interface-error", "Interface error",
			"missing " + exception.getParameterName());
	}

	/**
	 * The store's words stay in the log. Every method here is a read except the
	 * ingest transaction, which the surface's own transaction rolls back; a
	 * caller gets the slug, never the driver's message.
	 */
	/**
	 * A method the route does not answer is the daemon's own 405, not the
	 * framework's: the route list is the contract, and a caller that posts to a
	 * GET-only path must see the same document shape as every other refusal.
	 */
	@ExceptionHandler(HttpRequestMethodNotSupportedException.class)
	ProblemDetail methodNotAllowed(HttpRequestMethodNotSupportedException exception) {
		return problem(HttpStatus.METHOD_NOT_ALLOWED, "method-not-allowed", "Method not allowed",
			exception.getMethod() + " is not answered here");
	}

	/** An unknown path under an allowed prefix is a 404, not a stack trace. */
	@ExceptionHandler(NoResourceFoundException.class)
	ProblemDetail noResource(NoResourceFoundException exception) {
		return notFound("unknown path: " + exception.getResourcePath());
	}

	@ExceptionHandler(DataAccessException.class)
	ProblemDetail store(DataAccessException exception) {
		log.error("store failure", exception);
		return problem(HttpStatus.INTERNAL_SERVER_ERROR, "store-error", "Store error",
			"the store could not answer");
	}

	/**
	 * A handler bug is a 500 and a log line, never a stack trace in a body:
	 * this is the same request boundary the daemon's _dispatch draws.
	 */
	@ExceptionHandler(Exception.class)
	ProblemDetail internal(Exception exception) {
		log.error("request failed", exception);
		return problem(HttpStatus.INTERNAL_SERVER_ERROR, "internal-error", "Internal error",
			"the request failed");
	}
}
