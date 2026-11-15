package com.example.sbex.core.db;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.sbex.core.Order;
import com.example.sbex.core.OrderStatus;
import java.math.BigDecimal;
import java.time.Instant;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The contract both engines must satisfy, written once and executed twice.
 * Each subclass hands in a container-backed DataSource; every assertion here
 * therefore runs against PostgreSQL and against Oracle — the same
 * repositories, the same gateway, two implementations of SqlDialect
 * (sbex/persistence.md).
 *
 * WHY a contract class instead of two similar test classes: the point of the
 * example is that the SQL is the only difference, and a duplicated test body
 * would let the two engines drift apart without anything saying so.
 */
abstract class PersistenceContractTest {

	protected abstract DataSource dataSource();

	protected abstract SqlDialect dialect();

	protected abstract String flywayLocation();

	private JdbcTemplate jdbc;
	private OrderRepository orders;
	private ProcessedEventRepository events;
	private StoredProcedureGateway procedures;
	private SqlDialect dialect;

	@BeforeEach
	void migrateAndWire() {
		DataSource dataSource = dataSource();
		Flyway.configure()
			.dataSource(dataSource)
			.locations(flywayLocation())
			.load()
			.migrate();
		// Containers are static and outlive the test methods, so each test
		// starts from an empty schema rather than from its predecessor's rows.
		jdbc = new JdbcTemplate(dataSource);
		jdbc.update("TRUNCATE TABLE orders");
		jdbc.update("TRUNCATE TABLE order_totals");
		jdbc.update("TRUNCATE TABLE processed_events");

		dialect = dialect();
		NamedParameterJdbcTemplate named = new NamedParameterJdbcTemplate(dataSource);
		orders = new OrderRepository(jdbc, named);
		events = new ProcessedEventRepository(named, dialect);
		procedures = new StoredProcedureGateway(jdbc, dialect, dataSource);
	}

	@Test
	void insertAssignsAnIdentityAndRoundTrips() {
		long id = orders.insert("alice", new BigDecimal("12.50"));

		Order order = orders.findById(id).orElseThrow();
		assertThat(order.customerId()).isEqualTo("alice");
		assertThat(order.total()).isEqualByComparingTo("12.50");
		assertThat(order.status()).isEqualTo(OrderStatus.NEW);
		assertThat(order.createdAt()).isNotNull();
	}

	@Test
	void redeliveredEventWritesNoSecondRow() {
		Instant processedAt = Instant.parse("2026-01-02T03:04:05Z");

		assertThat(events.markProcessed("evt-1", processedAt)).isTrue();
		assertThat(events.markProcessed("evt-1", processedAt)).isFalse();
	}

	@Test
	void archiveProcedureMovesABoundedBatchAndReportsItsCount() {
		long id = orders.insert("bob", new BigDecimal("10.00"));
		orders.updateStatus(id, OrderStatus.COMPLETED);

		int archived = procedures.archive(Instant.now().plusSeconds(60), 10);

		assertThat(archived).isEqualTo(1);
		assertThat(orders.findById(id).orElseThrow().status()).isEqualTo(OrderStatus.ARCHIVED);
	}

	@Test
	void reconcileBlockWritesTheRunningTotal() {
		long id = orders.insert("carol", new BigDecimal("7.00"));
		orders.updateStatus(id, OrderStatus.COMPLETED);

		// A transaction, not a bare call: the PostgreSQL block reads a
		// transaction-local setting, which is also the boundary production
		// uses — the totals read and the row they land in move together.
		new TransactionTemplate(new DataSourceTransactionManager(dataSource()))
			.executeWithoutResult(status -> dialect.reconcileTotals(jdbc, "carol"));

		BigDecimal total =
			jdbc.queryForObject(
				"SELECT total FROM order_totals WHERE customer_id = ?", BigDecimal.class, "carol");
		assertThat(total).isEqualByComparingTo("7.00");
	}

	@Test
	void functionCallScoresAnOrderThroughMetadata() {
		long id = orders.insert("dave", new BigDecimal("3.25"));

		assertThat(procedures.orderScore(id)).isEqualByComparingTo("3.25");
		assertThat(procedures.orderScore(999_999L)).isEqualByComparingTo("0");
	}
}
