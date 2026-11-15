package com.example.sbex.servlet;

import com.example.sbex.core.Order;
import com.example.sbex.core.db.OrderService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import java.math.BigDecimal;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Thin controller: it validates and shapes HTTP, then delegates. No SQL, no
 * transaction, no message publication happens here — those belong to the
 * service and repository that own them (sbex/README.md).
 */
@RestController
@RequestMapping("/api/orders")
public class OrderController {

	private final OrderService orders;

	public OrderController(OrderService orders) {
		this.orders = orders;
	}

	/**
	 * The request body is its own record: the API's input shape stays stable
	 * even when the domain record gains a field, and validation runs before
	 * the service is entered.
	 */
	public record PlaceOrderRequest(
		@NotBlank String customerId, @NotNull @Positive BigDecimal total) {}

	public record ScoreResponse(long orderId, BigDecimal score) {}

	public record ArchiveResponse(int archived) {}

	@PostMapping
	public ResponseEntity<Order> place(@Valid @RequestBody PlaceOrderRequest request) {
		Order created = orders.placeOrder(request.customerId(), request.total());
		return ResponseEntity.created(URI.create("/api/orders/" + created.id())).body(created);
	}

	@GetMapping("/{id}")
	public Order get(@PathVariable long id) {
		return orders.get(id);
	}

	/** ids arrives comma-separated and required; an explicit empty value is a
	 * legal, empty selection (the repository guards the expansion). */
	@GetMapping
	public List<Order> list(@RequestParam String customerId, @RequestParam List<Long> ids) {
		return orders.list(customerId, ids);
	}

	@PostMapping("/{id}/cancel")
	public ResponseEntity<Void> cancel(@PathVariable long id) {
		orders.cancel(id);
		return ResponseEntity.noContent().build();
	}

	@GetMapping("/{id}/score")
	public ScoreResponse score(@PathVariable long id) {
		return new ScoreResponse(id, orders.score(id));
	}

	@PostMapping("/reconcile")
	public ResponseEntity<Void> reconcile(@RequestParam String customerId) {
		orders.reconcileTotals(customerId);
		return ResponseEntity.noContent().build();
	}

	@PostMapping("/archive")
	public ArchiveResponse archive(@RequestParam Instant before) {
		return new ArchiveResponse(orders.archiveCompleted(before));
	}
}
