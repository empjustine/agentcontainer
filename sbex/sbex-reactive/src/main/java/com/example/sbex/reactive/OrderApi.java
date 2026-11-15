package com.example.sbex.reactive;

import com.example.sbex.core.Order;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import java.math.BigDecimal;
import java.net.URI;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/**
 * The same resource as the servlet controller, expressed in Mono. Validation,
 * status codes and problem responses behave identically — what differs is
 * that nothing here blocks while waiting for an answer.
 */
@RestController
@RequestMapping("/api/orders")
public class OrderApi {

	private final OrderQueries orders;

	public OrderApi(OrderQueries orders) {
		this.orders = orders;
	}

	public record PlaceOrderRequest(
		@NotBlank String customerId, @NotNull @Positive BigDecimal total) {}

	@PostMapping
	public Mono<ResponseEntity<Order>> place(@Valid @RequestBody PlaceOrderRequest request) {
		return orders
			.place(request.customerId(), request.total())
			.map(
				created ->
					ResponseEntity.created(URI.create("/api/orders/" + created.id()))
						.body(created));
	}

	@GetMapping("/{id}")
	public Mono<Order> get(@PathVariable long id) {
		return orders.get(id);
	}

	@GetMapping
	public Mono<List<Order>> list(@RequestParam String customerId, @RequestParam List<Long> ids) {
		return orders.list(customerId, ids);
	}
}
