package com.example.sbex.core.db;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

/**
 * The vendor branch that has no database behind it: which syntax a URL
 * selects is decided at startup, and this test pins both selections plus the
 * refusal case — the whole dialect surface that runs without a container.
 */
class SqlDialectTest {

	@Test
	void postgresUrlSelectsPostgresSyntax() {
		SqlDialect dialect = SqlDialect.fromJdbcUrl("jdbc:postgresql://db:5432/sbex");

		assertThat(dialect).isInstanceOf(PostgresDialect.class);
		assertThat(dialect.upsertProcessedEventSql()).contains("ON CONFLICT");
		assertThat(dialect.archiveProcedureSql()).startsWith("CALL ");
	}

	@Test
	void oracleUrlSelectsOracleSyntax() {
		SqlDialect dialect = SqlDialect.fromJdbcUrl("jdbc:oracle:thin:@db:1521:sbex");

		assertThat(dialect).isInstanceOf(OracleDialect.class);
		assertThat(dialect.upsertProcessedEventSql()).contains("MERGE");
		assertThat(dialect.archiveProcedureSql()).startsWith("{call ");
	}

	@Test
	void unsupportedEngineFailsAtStartupNotAtFirstQuery() {
		assertThatThrownBy(() -> SqlDialect.fromJdbcUrl("jdbc:mysql://db/sbex"))
			.isInstanceOf(IllegalStateException.class)
			.hasMessageContaining("jdbc:postgresql");
	}
}
