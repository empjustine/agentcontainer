package com.example.sbex.core.db;

import java.math.BigDecimal;
import java.sql.CallableStatement;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import javax.sql.DataSource;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.SimpleJdbcCall;
import org.springframework.stereotype.Component;

/**
 * Prepared procedure and function calls — the alternative to anonymous blocks
 * whenever the operation takes arguments. The split is deliberate: the CALL
 * text is the only vendor-specific part (the dialect supplies it), while bind
 * and OUT-parameter handling is one JDBC shape for both engines.
 */
@Component
public class StoredProcedureGateway {

	private final JdbcTemplate jdbc;
	private final SqlDialect dialect;
	private final SimpleJdbcCall orderScore;

	public StoredProcedureGateway(JdbcTemplate jdbc, SqlDialect dialect, DataSource dataSource) {
		this.jdbc = jdbc;
		this.dialect = dialect;
		// Built once: SimpleJdbcCall reads function metadata from the database
		// on first execution, and a per-call instance would pay that round trip
		// on every score lookup.
		this.orderScore = new SimpleJdbcCall(dataSource).withFunctionName("order_score");
	}

	/**
	 * archive_orders(before, limit, archived OUT) as a prepared CALL.
	 *
	 * @param before archive completed orders created before this instant
	 * @param limit maximum rows the procedure may move in one transaction
	 * @return the procedure's OUT count of archived rows
	 */
	public int archive(Instant before, int limit) {
		return jdbc.execute(
			(ConnectionCallback<Integer>)
				connection -> {
					try (CallableStatement call = connection.prepareCall(dialect.archiveProcedureSql())) {
						call.setTimestamp(1, Timestamp.from(before));
						call.setInt(2, limit);
						call.registerOutParameter(3, Types.INTEGER);
						call.execute();
						return call.getInt(3);
					}
				});
	}

	/**
	 * order_score(order_id) as a prepared FUNCTION through SimpleJdbcCall:
	 * the call text comes from database metadata, so no vendor branch exists
	 * in this method at all. A driver that cannot read function metadata is
	 * the documented case for withoutProcedureColumnMetaData().
	 *
	 * @param orderId order to score
	 * @return the stored function's value
	 */
	public BigDecimal orderScore(long orderId) {
		return orderScore.executeFunction(BigDecimal.class, orderId);
	}
}
