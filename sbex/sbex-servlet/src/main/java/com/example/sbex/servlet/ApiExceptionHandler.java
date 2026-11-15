package com.example.sbex.servlet;

import com.example.sbex.core.OrderNotFoundException;
import com.example.sbex.core.OrderStateException;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.TransactionException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * One RFC 9457 shape for every failure the API can produce. Clients get a
 * stable problem document; the database's own words stay in the log, because
 * a SQLException handed to a caller leaks schema and query structure
 * (sbex/README.md).
 *
 * HIGHEST_PRECEDENCE is load-bearing: with spring.mvc.problemdetails.enabled,
 * Boot's auto-configured ProblemDetailsExceptionHandler also claims framework
 * exceptions (MethodArgumentNotValidException among them) and would render its
 * generic problem document instead of this one. An equal, unspecified order
 * left the outcome to bean discovery order.
 */
@RestControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE)
public class ApiExceptionHandler {

	private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

	@ExceptionHandler(OrderNotFoundException.class)
	public ProblemDetail notFound(OrderNotFoundException exception) {
		return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, exception.getMessage());
	}

	@ExceptionHandler(OrderStateException.class)
	public ProblemDetail conflict(OrderStateException exception) {
		return ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, exception.getMessage());
	}

	@ExceptionHandler(MethodArgumentNotValidException.class)
	public ProblemDetail invalid(MethodArgumentNotValidException exception) {
		ProblemDetail problem =
			ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "request failed validation");
		problem.setProperty(
			"fieldErrors",
			exception.getBindingResult().getFieldErrors().stream()
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

	// Both families, because the failure surfaces at whichever layer owns it:
	// a dead connection inside a query is a DataAccessException, the same dead
	// connection at @Transactional entry is a CannotCreateTransactionException
	// — a TransactionException, and a caller must not see the difference.
	@ExceptionHandler({ DataAccessException.class, TransactionException.class })
	public ProblemDetail database(Exception exception) {
		log.error("database failure", exception);
		return ProblemDetail.forStatusAndDetail(
			HttpStatus.INTERNAL_SERVER_ERROR, "database failure");
	}
}
