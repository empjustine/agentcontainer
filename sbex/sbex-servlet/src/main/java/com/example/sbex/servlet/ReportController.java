package com.example.sbex.servlet;

import com.example.sbex.core.Order;
import com.example.sbex.core.db.OrderRepository;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.io.UncheckedIOException;
import java.time.Instant;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

/**
 * A report that streams. The alternative — a List of every matching row,
 * mapped to CSV in one pass — puts the whole result set in the heap at once;
 * here the cost is one Order no matter how many rows match
 * (sbex/memory.md).
 */
@RestController
public class ReportController {

	private final OrderRepository orders;

	public ReportController(OrderRepository orders) {
		this.orders = orders;
	}

	@GetMapping(value = "/api/reports/completed.csv", produces = MediaType.TEXT_PLAIN_VALUE)
	public StreamingResponseBody completedCsv(@RequestParam Instant before) {
		return output ->
			orders.streamCompleted(
				before,
				order -> writeRow(output, order));
	}

	private static void writeRow(OutputStream output, Order order) {
		try {
			output.write(
				("%d,%s,%s,%s%n".formatted(
					order.id(), order.customerId(), order.total(), order.status()))
					.getBytes(StandardCharsets.UTF_8));
		} catch (IOException exception) {
			// The row consumer is unchecked on purpose: a failed write must
			// abort the stream, and UncheckedIOException is how a checked one
			// reaches the async request machinery.
			throw new UncheckedIOException(exception);
		}
	}
}
