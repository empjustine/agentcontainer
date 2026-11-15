package com.example.sbex.core.db;

import com.zaxxer.hikari.HikariDataSource;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.testcontainers.containers.OracleContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * The same contract against a real Oracle XE. The image is large and the
 * engine slow to start — the reason it sits behind the same
 * disabledWithoutDocker guard as PostgreSQL rather than in a profile nobody
 * remembers to activate.
 */
@Testcontainers(disabledWithoutDocker = true)
class OraclePersistenceTest extends PersistenceContractTest {

	@Container
	static final OracleContainer ORACLE = new OracleContainer("gvenzl/oracle-xe:21-slim");

	private static HikariDataSource pool;

	@BeforeAll
	static void openPool() {
		pool = new HikariDataSource();
		pool.setJdbcUrl(ORACLE.getJdbcUrl());
		pool.setUsername(ORACLE.getUsername());
		pool.setPassword(ORACLE.getPassword());
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
		return SqlDialect.fromJdbcUrl(ORACLE.getJdbcUrl());
	}

	@Override
	protected String flywayLocation() {
		return "classpath:db/migration/oracle";
	}
}
