package com.example.sbex.reactive;

import com.example.sbex.core.OrderNotFoundException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.TransactionException;
import org.springframework.web.bind.support.WebExchangeBindException;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import java.util.Map;
import java.util.concurrent.TimeoutException;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * The reactive twin of the servlet advice: same RFC 9457 shapes, same status
 * codes. What changes is the exception set — a downstream timeout arrives as
 * an onError signal from the client chain, and anything this advice does not
 * name falls through to Boot's default problem response.
 *
 * HIGHEST_PRECEDENCE: Boot's auto-configured reactive
 * ProblemDetailsExceptionHandler also claims framework exceptions and would
 * render its generic problem document instead of this one. The validation
 * exception is WebExchangeBindException — WebFlux's answer to the servlet
 * stack's MethodArgumentNotValidException, and the reason this advice names
 * it instead.
 */
@RestControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE)
public class ApiAdvice {

	private static final Logger log = LoggerFactory.getLogger(ApiAdvice.class);

	@ExceptionHandler(OrderNotFoundException.class)
	public ProblemDetail notFound(OrderNotFoundException exception) {
		return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, exception.getMessage());
	}

	@ExceptionHandler(WebExchangeBindException.class)
	public ProblemDetail invalid(WebExchangeBindException exception) {
		ProblemDetail problem =
			ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "request failed validation");
		problem.setProperty(
			"fieldErrors",
			exception.getFieldErrors().stream()
				.map(
					error ->
						Map.of(
							"field",
							error.getField(),
							"message",
							error.getDefaultMessage() == null ? "invalid" : error.getDefaultMessage()))
				.toList());
		return problem;
	}

	// Both families: a dead connection inside a query is a DataAccessException,
	// the same dead connection at @Transactional entry is a
	// CannotCreateTransactionException — a TransactionException. The caller
	// sees one shape either way (the servlet advice maps the same pair).
	@ExceptionHandler({ DataAccessException.class, TransactionException.class })
	public ProblemDetail database(Exception exception) {
		log.error("database failure", exception);
		return ProblemDetail.forStatusAndDetail(
			HttpStatus.INTERNAL_SERVER_ERROR, "database failure");
	}

	// A refusal to connect is the other downstream failure: 502, with the
	// cause in the log and nothing about the downstream's layout in the body.
	@ExceptionHandler(WebClientRequestException.class)
	public ProblemDetail badGateway(WebClientRequestException exception) {
		log.error("downstream unreachable", exception);
		return ProblemDetail.forStatusAndDetail(
			HttpStatus.BAD_GATEWAY, "downstream unreachable");
	}

	@ExceptionHandler(TimeoutException.class)
	public ProblemDetail timedOut(TimeoutException exception) {
		// The timeout's message names the internal operation; the caller gets
		// the fact of the timeout and nothing about the downstream's layout.
		log.error("downstream timeout", exception);
		return ProblemDetail.forStatusAndDetail(
			HttpStatus.GATEWAY_TIMEOUT, "downstream timed out");
	}
}
