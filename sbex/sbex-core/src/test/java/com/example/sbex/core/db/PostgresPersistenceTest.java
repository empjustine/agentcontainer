package com.example.sbex.core.db;

import com.zaxxer.hikari.HikariDataSource;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * The contract against a real PostgreSQL. The container is skipped loudly
 * when no container runtime answers (Testcontainers' own guard), so the
 * suite stays green on a host that has none — and never pretends it ran.
 */
@Testcontainers(disabledWithoutDocker = true)
class PostgresPersistenceTest extends PersistenceContractTest {

	@Container
	static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16-alpine");

	private static HikariDataSource pool;

	@BeforeAll
	static void openPool() {
		pool = new HikariDataSource();
		pool.setJdbcUrl(POSTGRES.getJdbcUrl());
		pool.setUsername(POSTGRES.getUsername());
		pool.setPassword(POSTGRES.getPassword());
	}

	@AfterAll
	static void closePool() {
		pool.close();
	}

	@Override
	protected DataSource dataSource() {
		return pool;
	}

	@Override
	protected SqlDialect dialect() {
		return SqlDialect.fromJdbcUrl(POSTGRES.getJdbcUrl());
	}

	@Override
	protected String flywayLocation() {
		return "classpath:db/migration/postgresql";
	}
}
