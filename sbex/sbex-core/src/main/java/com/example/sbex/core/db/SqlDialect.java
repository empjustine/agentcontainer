package com.example.sbex.core.db;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.boot.jdbc.DatabaseDriver;

/**
 * The vendor-specific half of persistence, chosen once from the JDBC URL.
 * Everything above this interface stays engine-neutral; everything below is
 * where PostgreSQL and Oracle syntax lives (sbex/persistence.md).
 *
 * WHY one interface per concern instead of vendor if-branches in the
 * repositories: each engine's syntax sits in one file, so adding or dropping
 * an engine is a class, not a grep across every query.
 */
public interface SqlDialect {

	/**
	 * INSERT that ignores an already-processed event id. The update count is
	 * the idempotency signal: 0 rows written means a redelivery.
	 *
	 * @return SQL with :eventId and :processedAt named parameters
	 */
	String upsertProcessedEventSql();

	/**
	 * Reconcile one customer's running total inside an anonymous block — the
	 * construct legacy schemas carry and the reason a JDBC caller has to know
	 * two dialects at all. Oracle takes bind variables; a PostgreSQL DO block
	 * takes none, so the value travels as a transaction-local setting instead.
	 *
	 * @param jdbc template bound to the caller's transaction
	 * @param customerId customer whose totals are recomputed
	 */
	void reconcileTotals(JdbcTemplate jdbc, String customerId);

	/**
	 * The CALL statement for archive_orders(before, limit, archived OUT) —
	 * `{call ...}` on Oracle, `CALL ...` on PostgreSQL.
	 */
	String archiveProcedureSql();

	/**
	 * Pick the dialect from the URL without opening a connection: startup
	 * stays free of database I/O, which is what lets a CDS/AOT training run
	 * and a boot against a reachable-or-not database both reach their own
	 * failure point instead of dying in the pool.
	 *
	 * @param jdbcUrl the configured spring.datasource.url
	 * @throws IllegalStateException for any engine this example does not ship
	 */
	static SqlDialect fromJdbcUrl(String jdbcUrl) {
		DatabaseDriver driver = DatabaseDriver.fromJdbcUrl(jdbcUrl);
		if (driver == DatabaseDriver.POSTGRESQL) {
			return new PostgresDialect();
		}
		if (driver == DatabaseDriver.ORACLE) {
			return new OracleDialect();
		}
		// The URL itself stays out of the message: JDBC URLs embed credentials.
		throw new IllegalStateException(
			"sbex supports jdbc:postgresql and jdbc:oracle URLs only");
	}
}
