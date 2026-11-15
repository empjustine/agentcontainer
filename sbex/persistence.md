---
id: sbex-persistence
type: submodule-design
status: active
title: "sbex persistence: transactions, JdbcTemplate and two engines"
parent: sbex
tags: ["jdbc", "transactions", "oracle", "postgresql", "flyway"]
---

# Persistence: transactions, JdbcTemplate and two engines

This file owns the `sbex-core/…/db/` package: where the transaction boundary sits, which JdbcTemplate shapes the repositories use, and how one codebase drives PostgreSQL and Oracle. It does not cover JPA beyond the closing section, nor connection-pool sizing — `memory.md` owns the pool numbers. The reader arrives with a schema and a question about transactions; the migration files and the contract tests are the worked answers.

## The transaction boundary

`OrderService` is the boundary: one `@Transactional` method per unit of work, declared on the method that owns it.

- The default propagation `REQUIRED` joins an existing transaction or opens one — `placeOrder` inserts and publishes, and both leave together.
- `rollbackFor` names the exception contract explicitly. A checked exception does **not** roll back by default, which is why `cancel` declares `rollbackFor = OrderStateException.class` rather than relying on the rule.
- `readOnly = true` reaches the driver as a hint: PostgreSQL runs the transaction read-only, other drivers may ignore it. Treat it as a contract on the code, not as enforcement by the database.
- A call to a `@Transactional` method from inside the same bean bypasses the proxy and runs without a transaction — silently. Keep the boundary methods callable from outside, or route internal calls through `TransactionTemplate`.
- `TransactionTemplate` is the programmatic form for a loop that needs its own transaction per item: each iteration's transaction is short, its locks release early, and the connection returns to the pool between items instead of being held across thousands of writes.
- Every transaction costs a pooled connection for its duration. `REQUIRES_NEW` opens a second one — on a container-sized pool of ten, a handful of concurrent `REQUIRES_NEW` calls is the whole pool.

After the commit, `OrderEventPublisher` fires the broker publish through `@TransactionalEventListener(AFTER_COMMIT)`: the row exists before any consumer can be asked to work on it, and a failed publish cannot roll back an accepted order. When the publish must be as durable as the row itself, the stronger pattern is the [transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) — write the event in the same transaction, relay it after commit.

## JdbcTemplate shapes the repositories use

- **Named parameters.** `NamedParameterJdbcTemplate` makes every statement readable at the call site, and `IN (:ids)` expands a collection into one statement — the N+1 shape (a query per id) has nowhere to appear. An empty collection is guarded before the expansion, because `IN ()` is a syntax error on both engines.
- **Records as rows.** An explicit `RowMapper` builds the `Order` record in one constructor call. `BeanPropertyRowMapper` is the shorter alternative and the quieter failure: a column that misses its property maps to `null` with no error.
- **Generated keys.** `prepareStatement(sql, new String[] { "id" })` is the portable insert: PostgreSQL returns that column, Oracle rewrites the call to `RETURNING id INTO`. Identity columns (`GENERATED ALWAYS AS IDENTITY`) are what make both sides agree — the strategy is portable where sequences are not.
- **Streaming reads.** `streamCompleted` walks a `ResultSet` into a consumer instead of materialising a `List`, so a report over a million rows costs one `Order` of heap. Fetch size belongs here too: PostgreSQL only streams a cursor when the connection is outside autocommit — that is, inside the transaction `@Transactional(readOnly = true)` already opened — while Oracle honours `setFetchSize` as an array-size hint.

## One schema, two engines

The vendor's syntax lives behind `SqlDialect`, chosen once from the JDBC URL without opening a connection — startup stays free of database I/O, which is what lets a CDS training run and a boot against an unreachable database each reach their own failure point.

| Concern          | PostgreSQL                                   | Oracle                                                |
| ---------------- | -------------------------------------------- | ----------------------------------------------------- |
| Redelivery guard | `INSERT … ON CONFLICT (event_id) DO NOTHING` | `MERGE … WHEN NOT MATCHED THEN INSERT`                |
| Anonymous block  | `DO $$ … $$` — **no bind variables**         | `BEGIN … END` with `:1` binds via `CallableStatement` |
| Procedure call   | `CALL archive_orders(?, ?, ?)`               | `{call archive_orders(?, ?, ?)}`                      |
| Bounded update   | `LIMIT` inside a CTE                         | `ROWNUM` over an ordered inline view                  |

Two gotchas are worth the space they take:

1. **A PostgreSQL DO block takes no parameters.** `PostgresDialect.reconcileTotals` therefore writes the value with `set_config('sbex.customer_id', ?, true)` — the third argument scopes it to the current transaction, so it dies with the transaction and can never leak into the next borrower of a pooled connection. The Oracle block binds the same value directly. When new procedural code is under one's control, a stored procedure with parameters is the portable choice and the anonymous block stays reserved for what SQL cannot express.
2. **Anonymous blocks and procedures are prepared calls, not strings to interpolate.** The gateway builds `CallableStatement` objects, registers the `OUT` parameter and binds values — no concatenation of user input exists in this package to find.

`StoredProcedureGateway` shows both call styles: the procedure through a hand-built `CallableStatement` (the `OUT` count is the return value), and the function through `SimpleJdbcCall`, which reads the function's metadata from the database so the call text needs no vendor branch at all. A driver that cannot read function metadata is the documented case for `withoutProcedureColumnMetaData()`.

## Migrations

Flyway runs before the application serves anything, with `spring.flyway.locations=classpath:db/migration/{vendor}` — the `{vendor}` placeholder picks `postgresql` or `oracle` from the JDBC URL, so one location pattern drives two schema histories. `fail-on-missing-locations` turns a mistyped vendor into a failed boot rather than an unmigrated database. The migrations live in `sbex-core` so both applications migrate the same schema, and `spring.jpa.hibernate.ddl-auto`-style runtime DDL has no place in the example: schema changes are versioned files, reviewed as code ([Flyway's documentation](https://documentation.red-gate.com/flyway)).

## JPA, when the object graph is the model

JPA stays out of this example because the queries here are set-based and the row shape is the model — JdbcTemplate shows the mechanics the question is about. JPA earns its place when the domain is an object graph with relationships, lazy loading and identity maps: `spring-boot-starter-data-jpa` adds Hibernate on top of the same `DataSource` and the same transaction manager, so `@Transactional` semantics above apply unchanged, and `@DataJpaTest` (`org.springframework.boot.data.jpa.test.autoconfigure`) gives the repository slice its own fast test. The trade it makes is explicit: schema and query control move behind the ORM, and the heap cost of a persistence context is one more thing `memory.md` has to budget for. The reference is [Spring Data JPA's documentation](https://docs.spring.io/spring-data/jpa/reference/).

## References

- [Spring Boot reference — SQL databases](https://docs.spring.io/spring-boot/4.1/reference/data/sql.html) (JdbcTemplate, JdbcClient, JPA)
- [Spring Boot how-to — database initialization](https://docs.spring.io/spring-boot/4.1/how-to/data-initialization.html) (the `{vendor}` placeholder)
- [Spring Framework — JDBC access](https://docs.spring.io/spring-framework/reference/7.0/data-access/jdbc.html) and [declarative transactions](https://docs.spring.io/spring-framework/reference/7.0/data-access/transaction.html)
- [PostgreSQL — PL/pgSQL](https://www.postgresql.org/docs/current/plpgsql.html) and [INSERT … ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html)
- [Oracle — PL/SQL language reference](https://docs.oracle.com/en/database/oracle/oracle-database/23/lnpls/toc.htm) and [JDBC developer's guide](https://docs.oracle.com/en/database/oracle/oracle-database/23/jjdbc/toc.htm)
- [Testcontainers](https://java.testcontainers.org/) (the contract tests' container runtime)
