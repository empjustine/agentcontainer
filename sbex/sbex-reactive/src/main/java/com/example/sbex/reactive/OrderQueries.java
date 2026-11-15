package com.example.sbex.reactive;

import com.example.sbex.core.Order;
import com.example.sbex.core.db.OrderService;
import java.math.BigDecimal;
import java.util.List;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * The bridge between the reactive web layer and the blocking core. Each call
 * becomes a Mono that executes on the bounded-elastic scheduler, so a
 * transactional method runs start-to-commit on ONE of those threads — a
 * transaction cannot hop threads, and the event loop must never be the thread
 * that holds a database connection (sbex/servlet-vs-reactive.md).
 */
@Service
public class OrderQueries {

	private final OrderService orders;

	public OrderQueries(OrderService orders) {
		this.orders = orders;
	}

	public Mono<Order> place(String customerId, BigDecimal total) {
		return Mono.fromCallable(() -> orders.placeOrder(customerId, total))
			.subscribeOn(Schedulers.boundedElastic());
	}

	public Mono<Order> get(long id) {
		return Mono.fromCallable(() -> orders.get(id))
			.subscribeOn(Schedulers.boundedElastic());
	}

	public Mono<List<Order>> list(String customerId, List<Long> ids) {
		return Mono.fromCallable(() -> orders.list(customerId, ids))
			.subscribeOn(Schedulers.boundedElastic());
	}
}
