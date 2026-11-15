-- One schema for both applications. Identity columns rather than sequences:
-- GENERATED ALWAYS AS IDENTITY is the portable id strategy (PostgreSQL 10+,
-- Oracle 12c+), and getGeneratedKeys reads it back the same way on both.
CREATE TABLE orders (
	id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	customer_id TEXT           NOT NULL,
	total       NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
	status      TEXT           NOT NULL DEFAULT 'NEW'
		CHECK (status IN ('NEW', 'COMPLETED', 'CANCELLED', 'ARCHIVED')),
	created_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX orders_customer_idx ON orders (customer_id);

CREATE TABLE order_totals (
	customer_id TEXT           PRIMARY KEY,
	total       NUMERIC(12, 2) NOT NULL DEFAULT 0,
	updated_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- The dedup ledger: event_id is the primary key, so the upsert's conflict
-- target is exactly the idempotency key.
CREATE TABLE processed_events (
	event_id     TEXT        PRIMARY KEY,
	processed_at TIMESTAMPTZ NOT NULL
);

-- The prepared function SimpleJdbcCall reads metadata for.
CREATE FUNCTION order_score(p_order_id BIGINT) RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
DECLARE
	v_total NUMERIC;
BEGIN
	SELECT total INTO v_total FROM orders WHERE id = p_order_id;
	RETURN COALESCE(v_total, 0);
END;
$$;

-- The prepared procedure: an OUT parameter and a bounded batch, the portable
-- alternative to an anonymous block whenever the operation takes arguments.
CREATE PROCEDURE archive_orders(
	p_before TIMESTAMPTZ,
	p_limit INTEGER,
	p_archived OUT INTEGER)
LANGUAGE plpgsql
AS $$
BEGIN
	WITH victims AS (
		SELECT id
		FROM orders
		WHERE status = 'COMPLETED' AND created_at < p_before
		ORDER BY id
		LIMIT p_limit
	)
	UPDATE orders
	SET status = 'ARCHIVED'
	WHERE id IN (SELECT id FROM victims);

	GET DIAGNOSTICS p_archived = ROW_COUNT;
END;
$$;
