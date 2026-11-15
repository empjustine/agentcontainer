package com.example.sbex.core.db;

import java.sql.Timestamp;
import java.time.Instant;

/**
 * The one place a java.time value becomes a JDBC bind. Explicit conversion:
 * both drivers bind Timestamp without surprises, while setObject(Instant)
 * support differs by driver version — a difference that belongs to no query.
 */
final class Timestamps {

	private Timestamps() {}

	static Timestamp fromInstant(Instant instant) {
		return Timestamp.from(instant);
	}
}
