package com.example.sbex.core.db;

import com.example.sbex.core.AppProperties;
import com.example.sbex.core.Order;
import com.example.sbex.core.OrderNotFoundException;
import com.example.sbex.core.OrderStatus;
import com.example.sbex.core.OrderStateException;
import com.example.sbex.core.messaging.OrderPlaced;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The transaction boundary of the domain: one transaction per public method,
 * declared on the method that owns it.
 *
 * WHY this class is the boundary and not the repository: @Transactional is
 * applied through a proxy, so a call to this class's OWN method from inside
 * this class bypasses the proxy and runs without a transaction — silently,
 * until a rollback is asked why it did nothing (sbex/persistence.md).
 */
@Service
public class OrderService {

	private final OrderRepository orders;
	private final StoredProcedureGateway procedures;
	private final SqlDialect dialect;
	private final JdbcTemplate jdbc;
	private final AppProperties properties;
	private final ApplicationEventPublisher events;

	public OrderService(
		OrderRepository orders,
		StoredProcedureGateway procedures,
		SqlDialect dialect,
		JdbcTemplate jdbc,
		AppProperties properties,
		ApplicationEventPublisher events) {
		this.orders = orders;
		this.procedures = procedures;
		this.dialect = dialect;
		this.jdbc = jdbc;
		this.properties = properties;
		this.events = events;
	}

	/**
	 * Insert the order and publish the fact of it. The event is published
	 * INSIDE the transaction and delivered after commit (see
	 * OrderEventPublisher): no consumer may read a row that is not there yet,
	 * and a failed publish must not roll back an accepted order.
	 *
	 * @param customerId owning customer
	 * @param total order value
	 * @return the created order with its database identity
	 */
	@Transactional
	public Order placeOrder(String customerId, BigDecimal total) {
		long id = orders.insert(customerId, total);
		Order order = new Order(id, customerId, total, OrderStatus.NEW, Instant.now());
		events.publishEvent(
			new OrderPlaced(
				UUID.randomUUID().toString(), id, customerId, total, order.createdAt()));
		return order;
	}

	/**
	 * Cancel a new order. rollbackFor is the exception contract made
	 * explicit: a checked exception would NOT roll back by default, and this
	 * method throws one on the illegal-state path on purpose.
	 *
	 * @param id order to cancel
	 * @throws OrderNotFoundException when no such order exists
	 * @throws OrderStateException when the order already left NEW
	 */
	@Transactional(rollbackFor = OrderStateException.class)
	public void cancel(long id) {
		Order order = orders.findById(id).orElseThrow(() -> new OrderNotFoundException(id));
		if (order.status() != OrderStatus.NEW) {
			throw new OrderStateException("order " + id + " is " + order.status() + ", not NEW");
		}
		orders.updateStatus(id, OrderStatus.CANCELLED);
	}

	@Transactional(readOnly = true)
	public Order get(long id) {
		return orders.findById(id).orElseThrow(() -> new OrderNotFoundException(id));
	}

	/**
	 * readOnly reaches the driver as a hint: PostgreSQL runs the transaction
	 * read-only, other drivers may ignore it — treat it as a contract for the
	 * code, not as an enforcement by the database.
	 */
	@Transactional(readOnly = true)
	public List<Order> list(String customerId, Collection<Long> ids) {
		return orders.findByCustomer(customerId, ids);
	}

	/**
	 * Drive the vendor's anonymous block. The transaction spans the
	 * parameter setup and the block itself: the transaction-local setting the
	 * PostgreSQL block reads must live and die with this transaction.
	 */
	@Transactional
	public void reconcileTotals(String customerId) {
		dialect.reconcileTotals(jdbc, customerId);
	}

	/**
	 * One archive CALL, bounded by the configured batch size. The bound is the
	 * transaction's size — it caps lock duration and undo growth, which is
	 * what keeps a batch job predictable next to interactive traffic.
	 *
	 * @param before archive completed orders created before this instant
	 * @return rows the procedure archived
	 */
	@Transactional
	public int archiveCompleted(Instant before) {
		return procedures.archive(before, properties.archiveBatchSize());
	}

	/** Runs outside a transaction: a single metadata-backed function call. */
	public BigDecimal score(long orderId) {
		return procedures.orderScore(orderId);
	}
}
