package com.example.sbex.core.messaging;

import com.example.sbex.core.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.ReturnedMessage;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Publishes order events after the transaction commits, then waits — without
 * blocking — for the broker's answer. Both failure directions are logged at
 * ERROR with the event id: a confirm is the only proof a publish happened,
 * and a silently dropped message is the failure a log line exists to catch
 * (sbex/messaging.md).
 */
@Component
public class OrderEventPublisher {

	private static final Logger log = LoggerFactory.getLogger(OrderEventPublisher.class);

	private final RabbitTemplate rabbit;
	private final AppProperties properties;

	public OrderEventPublisher(RabbitTemplate rabbit, AppProperties properties) {
		this.rabbit = rabbit;
		this.properties = properties;
	}

	/**
	 * AFTER_COMMIT, not AFTER_COMPLETION: the row must exist before any
	 * consumer can be asked to work on it. fallbackExecution keeps the
	 * listener firing when no transaction is active (a manual publish path),
	 * so the event never disappears without a trace.
	 */
	@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
	public void onOrderPlaced(OrderPlaced event) {
		CorrelationData correlation = new CorrelationData(event.eventId());
		rabbit.convertAndSend(properties.eventsExchange(), "order.placed", event, correlation);
		correlation
			.getFuture()
			.whenComplete(
				(confirm, failure) -> {
					if (failure != null) {
						log.error(
							"publish failed orderId={} eventId={}",
							event.orderId(),
							event.eventId(),
							failure);
					} else if (!confirm.ack()) {
						log.error(
							"broker nacked eventId={} reason={}",
							event.eventId(),
							confirm.reason());
					} else {
						// mandatory + publisher-returns: an unroutable message comes
						// back here instead of being dropped by the broker. Read it
						// once: a second call may observe a different object (or null).
						ReturnedMessage returned = correlation.getReturned();
						if (returned != null) {
							log.error(
								"unroutable eventId={} routingKey={}",
								event.eventId(),
								returned.getRoutingKey());
						}
					}
				});
	}
}
