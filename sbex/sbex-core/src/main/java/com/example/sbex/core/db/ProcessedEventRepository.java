package com.example.sbex.core.db;

import java.time.Instant;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * The dedup ledger: one row per event id, written in the SAME transaction as
 * the business effect the event authorises. That pairing is the whole
 * idempotency story — a redelivery finds the row, writes no row, and the
 * caller skips (sbex/messaging.md).
 */
@Repository
public class ProcessedEventRepository {

	private final NamedParameterJdbcTemplate jdbc;
	private final SqlDialect dialect;

	public ProcessedEventRepository(NamedParameterJdbcTemplate jdbc, SqlDialect dialect) {
		this.jdbc = jdbc;
		this.dialect = dialect;
	}

	/**
	 * @return true when this delivery was the first to record the event;
	 * false means a redelivery arrived and the caller must do nothing
	 */
	public boolean markProcessed(String eventId, Instant processedAt) {
		int written =
			jdbc.update(
				dialect.upsertProcessedEventSql(),
				Map.of("eventId", eventId, "processedAt", Timestamps.fromInstant(processedAt)));
		return written > 0;
	}
}
