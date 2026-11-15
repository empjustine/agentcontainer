package com.example.sbex.core.messaging;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * The order-placed event, serialized as JSON by the publisher and the
 * consumer. The payload is a wire contract: renaming a field here is a change
 * every consumer must already understand, which is why events live apart from
 * the HTTP model.
 *
 * @param eventId dedup key — one UUID per publication, stable across the
 * broker's redeliveries of that publication and useless as a business id
 * @param orderId the order this event is about
 * @param customerId owning customer
 * @param total order value as accepted
 * @param occurredAt publication time
 */
public record OrderPlaced(
	String eventId, long orderId, String customerId, BigDecimal total, Instant occurredAt) {}
