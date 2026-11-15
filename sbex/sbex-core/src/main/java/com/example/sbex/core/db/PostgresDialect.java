package com.example.sbex.core.db;

import org.springframework.jdbc.core.JdbcTemplate;

/** PostgreSQL syntax for the shared persistence operations. */
final class PostgresDialect implements SqlDialect {

	@Override
	public String upsertProcessedEventSql() {
		return """
			INSERT INTO processed_events (event_id, processed_at)
			VALUES (:eventId, :processedAt)
			ON CONFLICT (event_id) DO NOTHING
			""";
	}

	@Override
	public void reconcileTotals(JdbcTemplate jdbc, String customerId) {
		// A DO block accepts no bind variables — that is the whole lesson of
		// this method. set_config's third argument scopes the value to the
		// CURRENT TRANSACTION, so it disappears at commit and can never leak
		// into the next borrower of this pooled connection.
		jdbc.queryForObject("SELECT set_config('sbex.customer_id', ?, true)", String.class, customerId);
		jdbc.execute(DO_RECONCILE_TOTALS);
	}

	@Override
	public String archiveProcedureSql() {
		return "CALL archive_orders(?, ?, ?)";
	}

	/*
	 * The block reads the transaction-local setting set above. The set-based
	 * equivalent is the order_totals upsert; the block form is here because
	 * production schemas carry procedural code and the question is how to
	 * drive it from JDBC, not whether to write new DO blocks (persistence.md).
	 */
	private static final String DO_RECONCILE_TOTALS = """
		DO $$
		DECLARE
			v_customer text := current_setting('sbex.customer_id');
			v_total numeric;
		BEGIN
			SELECT COALESCE(SUM(total), 0) INTO v_total
			FROM orders
			WHERE customer_id = v_customer AND status = 'COMPLETED';

			UPDATE order_totals
			SET total = v_total, updated_at = now()
			WHERE customer_id = v_customer;

			IF SQL%ROWCOUNT = 0 THEN
				INSERT INTO order_totals (customer_id, total, updated_at)
				VALUES (v_customer, v_total, now());
			END IF;
		END
		$$
		""";
}
