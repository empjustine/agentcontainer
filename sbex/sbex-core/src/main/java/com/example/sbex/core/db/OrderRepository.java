package com.example.sbex.core.db;

import com.example.sbex.core.Order;
import com.example.sbex.core.OrderStatus;
import java.math.BigDecimal;
import java.sql.PreparedStatement;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Consumer;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.PreparedStatementCreator;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

/**
 * All order SQL in one place: named parameters make every statement readable
 * at the call site, IN lists expand from a collection, and no concatenation of
 * user input exists to find (sbex/persistence.md).
 */
@Repository
public class OrderRepository {

	private static final RowMapper<Order> ORDER_ROW =
		(rs, rowNum) -> new Order(
			rs.getLong("id"),
			rs.getString("customer_id"),
			rs.getBigDecimal("total"),
			OrderStatus.valueOf(rs.getString("status")),
			rs.getTimestamp("created_at").toInstant());

	private final JdbcTemplate jdbc;
	private final NamedParameterJdbcTemplate named;

	/** Both templates are auto-configured and share one DataSource: the plain
	 * one for the generated-key insert, the named one for every query with
	 * parameters. */
	public OrderRepository(JdbcTemplate jdbc, NamedParameterJdbcTemplate named) {
		this.jdbc = jdbc;
		this.named = named;
	}

	/**
	 * Insert with a generated key. The column-name form of prepareStatement
	 * maps to RETURNING on both engines: PostgreSQL returns just that column,
	 * Oracle rewrites it to RETURNING id INTO.
	 *
	 * @return the identity the database assigned
	 */
	public long insert(String customerId, BigDecimal total) {
		KeyHolder keys = new GeneratedKeyHolder();
		jdbc.update(
			(PreparedStatementCreator) connection -> {
				PreparedStatement statement =
					connection.prepareStatement(
						"INSERT INTO orders (customer_id, total, status) VALUES (?, ?, 'NEW')",
						new String[] { "id" });
				statement.setString(1, customerId);
				statement.setBigDecimal(2, total);
				return statement;
			},
			keys);
		Number key = keys.getKey();
		if (key == null) {
			throw new IllegalStateException("insert returned no generated key");
		}
		return key.longValue();
	}

	public Optional<Order> findById(long id) {
		return named
			.query(
				"SELECT id, customer_id, total, status, created_at FROM orders WHERE id = :id",
				Map.of("id", id),
				ORDER_ROW)
			.stream()
			.findFirst();
	}

	/**
	 * One statement for a customer's rows. The IN list is expanded by the
	 * template — the N+1 shape (a query per id) does not exist in this class.
	 */
	public List<Order> findByCustomer(String customerId, Collection<Long> ids) {
		if (ids.isEmpty()) {
			// An empty expansion would be `IN ()`, a syntax error on both
			// engines; an empty selection is an empty result, not a query.
			return List.of();
		}
		return named.query(
			"""
			SELECT id, customer_id, total, status, created_at
			FROM orders
			WHERE customer_id = :customerId AND id IN (:ids)
			ORDER BY id
			""",
			Map.of("customerId", customerId, "ids", ids),
			ORDER_ROW);
	}

	/**
	 * @return how many rows changed — 0 means the order was already in that
	 * state, which callers treat as success rather than as a conflict
	 */
	public int updateStatus(long id, OrderStatus status) {
		// status.name(), not the enum: both drivers would otherwise receive a
		// Java object they have no bind mapping for.
		return named.update(
			"UPDATE orders SET status = :status WHERE id = :id",
			Map.of("id", id, "status", status.name()));
	}

	/**
	 * Stream completed rows to a consumer instead of materialising a List.
	 * The heap cost is one row regardless of how many match — the shape a
	 * report endpoint must have on a constrained container.
	 *
	 * @param before only rows created before this instant
	 * @param consumer receives rows in id order
	 */
	public void streamCompleted(Instant before, Consumer<Order> consumer) {
		named.query(
			"""
			SELECT id, customer_id, total, status, created_at
			FROM orders
			WHERE status = 'COMPLETED' AND created_at < :before
			ORDER BY id
			""",
			Map.of("before", Timestamps.fromInstant(before)),
			(RowCallbackHandler)
				rs -> {
					while (rs.next()) {
						consumer.accept(ORDER_ROW.mapRow(rs, rs.getRow()));
					}
				});
	}
}
