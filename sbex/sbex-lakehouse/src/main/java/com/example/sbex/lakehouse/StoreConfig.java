package com.example.sbex.lakehouse;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.io.IOException;
import java.sql.SQLException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.support.EncodedResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The store: one writer connection and a small read pool over the same SQLite
 * file. SQLite admits a single writer, so pinning the writer to one connection
 * turns contention into a wait inside the pool instead of SQLITE_BUSY under a
 * transaction; WAL lets the read faces proceed during that write
 * (sbex/persistence-engines.md, SQLite).
 *
 * WHY two pools and not one: a request that holds the only connection to write
 * and then reads the same store would deadlock the pool, and the read faces
 * outnumber the writer by orders of magnitude. Two pools state the split the
 * daemon's one write lock made implicit (_write_lock in browse-daemon.py).
 */
@Configuration(proxyBeanMethods = false)
class StoreConfig {

	private static final Logger log = LoggerFactory.getLogger(StoreConfig.class);

	/**
	 * The writer pool, and the store's schema, created in the same bean factory
	 * so no request can reach the store before the tables exist. The directory
	 * and file are made private here because browsing history is the user's:
	 * a 0755 directory and 0644 database are readable by every local user.
	 */
	@Bean(destroyMethod = "close")
	@Primary
	HikariDataSource dataSource(LakehouseProperties properties) throws IOException, SQLException {
		Path store = Path.of(properties.store()).toAbsolutePath();
		prepareDirectory(store);
		HikariDataSource dataSource = pool(properties.store(), 1, "lakehouse-writer");
		try (var connection = dataSource.getConnection()) {
			ScriptUtils.executeSqlScript(
				connection,
				new EncodedResource(new ClassPathResource("lakehouse-schema.sql"), StandardCharsets.UTF_8));
		}
		makePrivate(store);
		// The WAL and shared-memory sidecars are created by the driver beside the
		// store, and Java has no umask to inherit the daemon's 077: with a
		// caller-chosen directory such as /tmp they would otherwise be
		// world-readable while holding the same history.
		makePrivate(Path.of(store + "-wal"));
		makePrivate(Path.of(store + "-shm"));
		log.info("store={} writer=1 reader={}", store, properties.readerPoolSize());
		return dataSource;
	}

	/**
	 * The read faces' pool. The daemon bounded concurrent handlers at
	 * BROWSE_MAX_WORKERS; this is the same bound one layer down, where the
	 * scarce resource (a SQLite read cursor) actually is.
	 */
	@Bean(destroyMethod = "close")
	HikariDataSource readerDataSource(LakehouseProperties properties) {
		return pool(properties.store(), properties.readerPoolSize(), "lakehouse-reader");
	}

	@Bean
	JdbcTemplate writerJdbc(@Qualifier("dataSource") DataSource dataSource) {
		return new JdbcTemplate(dataSource);
	}

	@Bean
	JdbcTemplate readerJdbc(@Qualifier("readerDataSource") DataSource dataSource) {
		return new JdbcTemplate(dataSource);
	}

	/**
	 * The writer's transaction manager is explicit because `@Transactional` must
	 * not pick a connection out of the read pool: a transaction on a reader
	 * would take a write lock on a pool that outnumbers the writer's.
	 */
	@Bean
	PlatformTransactionManager transactionManager(@Qualifier("dataSource") DataSource dataSource) {
		return new DataSourceTransactionManager(dataSource);
	}

	/**
	 * The batch writer the ingest uses. A TransactionTemplate rather than
	 * `@Transactional` because the transaction must open around the request body
	 * the streaming ingest reads, and the parser is not a bean method's
	 * argument.
	 */
	@Bean
	TransactionTemplate transactionTemplate(PlatformTransactionManager transactionManager) {
		return new TransactionTemplate(transactionManager);
	}

	private static HikariDataSource pool(String store, int size, String name) {
		HikariConfig config = new HikariConfig();
		// journal_mode=WAL and busy_timeout are pragmas the driver applies per
		// connection; keeping them in the URL is what makes every pooled
		// connection carry the same settings.
		config.setJdbcUrl("jdbc:sqlite:" + Path.of(store).toAbsolutePath() + "?journal_mode=WAL&busy_timeout=10000");
		config.setMaximumPoolSize(size);
		config.setMinimumIdle(size);
		config.setPoolName(name);
		config.setConnectionTimeout(10_000);
		return new HikariDataSource(config);
	}

	/**
	 * The daemon tightens only its own default directory: chmod on a
	 * caller-chosen parent such as /tmp is not this process's decision.
	 * A failure is reported and left to the pool: opening the store then fails
	 * with the filesystem's own words, which is the step that owns it.
	 */
	private static void prepareDirectory(Path store) {
		Path directory = java.util.Objects.requireNonNull(store.getParent(), "store directory");
		try {
			Files.createDirectories(directory);
			Path name = directory.getFileName();
			if (name != null && "agent-warehouse".equals(name.toString())) {
				Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
			}
		} catch (IOException exception) {
			log.warn("cannot prepare store directory {}: {}", directory, exception.toString());
		}
	}

	private static void makePrivate(Path store) {
		try {
			Files.setPosixFilePermissions(store, PosixFilePermissions.fromString("rw-------"));
		} catch (IOException ignored) {
			// A store on a filesystem without POSIX modes keeps its mode; the
			// daemon's umask covered this case and Java has no umask to set.
		}
	}
}
