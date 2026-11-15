package com.example.sbex.core;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * The order aggregate as the HTTP and message layers see it. A record: every
 * field is final, the JDBC row mapping is one constructor call, and Jackson
 * serializes it without getters to invent.
 *
 * @param id database-generated identity
 * @param customerId owning customer
 * @param total order value, never negative (a CHECK constraint enforces it too)
 * @param status lifecycle state, see {@link OrderStatus}
 * @param createdAt write time as the database recorded it
 */
public record Order(
	long id,
	String customerId,
	BigDecimal total,
	OrderStatus status,
	Instant createdAt) {}
