-- The Oracle half of the same schema. The column set and the CHECK vocabulary
-- match the PostgreSQL migration on purpose: the repositories read and write
-- one shape, and only the SQL below knows which engine it is.
CREATE TABLE orders (
	id          NUMBER(19) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	customer_id VARCHAR2(128) NOT NULL,
	total       NUMBER(12, 2) NOT NULL CHECK (total >= 0),
	status      VARCHAR2(16) DEFAULT 'NEW' NOT NULL
		CONSTRAINT orders_status_ck
		CHECK (status IN ('NEW', 'COMPLETED', 'CANCELLED', 'ARCHIVED')),
	created_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE INDEX orders_customer_idx ON orders (customer_id);

CREATE TABLE order_totals (
	customer_id VARCHAR2(128) PRIMARY KEY,
	total       NUMBER(12, 2) DEFAULT 0 NOT NULL,
	updated_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE processed_events (
	event_id     VARCHAR2(64) PRIMARY KEY,
	processed_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- The prepared function SimpleJdbcCall calls as {? = call order_score(?)}.
CREATE OR REPLACE FUNCTION order_score(p_order_id IN NUMBER) RETURN NUMBER IS
	v_total NUMBER;
BEGIN
	SELECT total INTO v_total FROM orders WHERE id = p_order_id;
	RETURN COALESCE(v_total, 0);
END;
/

-- The prepared procedure: an OUT parameter and a ROWNUM-bounded batch, the
-- Oracle counterpart of the PostgreSQL archive_orders.
CREATE OR REPLACE PROCEDURE archive_orders(
	p_before IN TIMESTAMP WITH TIME ZONE,
	p_limit IN INTEGER,
	p_archived OUT INTEGER) IS
BEGIN
	UPDATE orders
	SET status = 'ARCHIVED'
	WHERE status = 'COMPLETED'
		AND created_at < p_before
		AND id IN (
			SELECT id
			FROM (SELECT id FROM orders
			      WHERE status = 'COMPLETED' AND created_at < p_before
			      ORDER BY id) ranked
			WHERE ROWNUM <= p_limit);

	p_archived := SQL%ROWCOUNT;
END;
/
