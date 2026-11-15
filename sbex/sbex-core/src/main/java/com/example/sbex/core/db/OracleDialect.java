package com.example.sbex.core.db;

import java.sql.CallableStatement;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;

/** Oracle syntax for the shared persistence operations. */
final class OracleDialect implements SqlDialect {

	@Override
	public String upsertProcessedEventSql() {
		return """
			MERGE INTO processed_events t
			USING (SELECT :eventId AS event_id FROM dual) s
			ON (t.event_id = s.event_id)
			WHEN NOT MATCHED THEN
				INSERT (event_id, processed_at) VALUES (s.event_id, :processedAt)
			""";
	}

	@Override
	public void reconcileTotals(JdbcTemplate jdbc, String customerId) {
		// CallableStatement is the JDBC shape of an anonymous PL/SQL block:
		// :1-style binds (repeated occurrences are ONE parameter) and a single
		// round trip. This is the contrast with PostgresDialect: Oracle blocks
		// take bindings, DO blocks do not.
		jdbc.execute((ConnectionCallback<Void>) connection -> {
			try (CallableStatement block = connection.prepareCall(RECONCILE_TOTALS_BLOCK)) {
				block.setString(1, customerId);
				block.execute();
			}
			return null;
		});
	}

	@Override
	public String archiveProcedureSql() {
		return "{call archive_orders(?, ?, ?)}";
	}

	private static final String RECONCILE_TOTALS_BLOCK = """
		BEGIN
			UPDATE order_totals
			SET total = (SELECT COALESCE(SUM(total), 0) FROM orders
			             WHERE customer_id = :1 AND status = 'COMPLETED'),
			    updated_at = SYSTIMESTAMP
			WHERE customer_id = :1;

			IF SQL%ROWCOUNT = 0 THEN
				INSERT INTO order_totals (customer_id, total, updated_at)
				VALUES (:1, (SELECT COALESCE(SUM(total), 0) FROM orders
				             WHERE customer_id = :1 AND status = 'COMPLETED'),
				        SYSTIMESTAMP);
			END IF;
		END
		""";
}
