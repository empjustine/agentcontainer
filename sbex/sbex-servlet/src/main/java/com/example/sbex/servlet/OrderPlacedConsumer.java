package com.example.sbex.servlet;

import com.example.sbex.core.OrderStatus;
import com.example.sbex.core.db.OrderRepository;
import com.example.sbex.core.db.ProcessedEventRepository;
import com.example.sbex.core.messaging.OrderPlaced;
import com.example.sbex.core.messaging.RabbitTopologyConfig;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * The one consumer in the example: an at-least-once broker meets a
 * transactional database, and idempotency is what makes the difference
 * invisible (sbex/messaging.md).
 */
@Component
public class OrderPlacedConsumer {

	private static final Logger log = LoggerFactory.getLogger(OrderPlacedConsumer.class);

	private final OrderRepository orders;
	private final ProcessedEventRepository events;

	public OrderPlacedConsumer(OrderRepository orders, ProcessedEventRepository events) {
		this.orders = orders;
		this.events = events;
	}

	/**
	 * One delivery, one transaction: the dedup insert and the status change
	 * commit together, so a crash between them rolls both back and the
	 * redelivery starts clean. A redelivery that finds event_id present writes
	 * nothing and returns.
	 */
	@RabbitListener(queues = RabbitTopologyConfig.ORDERS_QUEUE)
	@Transactional
	public void onOrderPlaced(OrderPlaced event) {
		if (!events.markProcessed(event.eventId(), Instant.now())) {
			log.info(
				"duplicate delivery ignored eventId={} orderId={}",
				event.eventId(),
				event.orderId());
			return;
		}
		if (orders.updateStatus(event.orderId(), OrderStatus.COMPLETED) == 0) {
			// Requeue would loop forever on an order that never arrives, so the
			// anomaly is logged loudly instead — the dedup row keeps any later
			// redelivery from repeating it.
			log.error(
				"event has no updatable order eventId={} orderId={}",
				event.eventId(),
				event.orderId());
		}
	}
}
