package com.example.sbex.lakehouse;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.channels.Channels;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/**
 * The session leg's transport (docs/d181, docs/d217): an append-only NDJSON
 * tail, a durable dedupe ledger, and the one shared sender.
 *
 * WHY the tail is appended by path and never through a held file handle: the
 * sender freezes the tail by renaming it (`spool.rm.<pid>`), so a process
 * holding the old inode would keep writing a file nobody reads. Every append
 * opens the path.
 *
 * WHY the ledger is a SQLite table and not a set: a restart must not forget
 * every key and re-append rows. The key is recorded only after the line is
 * appended — recording it first would let a disk-full append lose the row
 * forever, because the replay would then be answered as a duplicate.
 */
@Component
final class SessionSpool {

	private static final Logger log = LoggerFactory.getLogger(SessionSpool.class);

	/** The sender's exit for "another sender holds the lock": busy, not failed. */
	private static final int SENDER_BUSY = 75;

	private final LakehouseProperties properties;
	private final JsonMapper mapper;
	private final Path spool;
	private final Path ledgerPath;
	private final Connection ledger;
	private final ScheduledExecutorService timer;
	private volatile boolean sending;
	private volatile long retryAt;
	private final java.util.concurrent.atomic.AtomicReference<Process> activeChild =
		new java.util.concurrent.atomic.AtomicReference<>();
	private volatile boolean shuttingDown;

	SessionSpool(LakehouseProperties properties, JsonMapper mapper) throws IOException, SQLException {
		this.properties = properties;
		this.mapper = mapper;
		this.spool = Path.of(properties.spool()).toAbsolutePath();
		this.ledgerPath = spool.resolveSibling("seen.sqlite");
		this.timer = Executors.newSingleThreadScheduledExecutor(runnable -> {
			Thread thread = new Thread(runnable, "spool-fold");
			thread.setDaemon(true);
			return thread;
		});
		prepareDirectory(spool);
		repairPartialTail(spool);
		this.ledger = DriverManager.getConnection("jdbc:sqlite:" + ledgerPath);
		try (Statement statement = ledger.createStatement()) {
			statement.execute("PRAGMA journal_mode=WAL");
			statement.execute("PRAGMA synchronous=NORMAL");
			statement.execute("PRAGMA busy_timeout=10000");
			statement.execute("CREATE TABLE IF NOT EXISTS seen(key TEXT PRIMARY KEY)");
		}
	}

	/**
	 * Every start reseeds from every tail the sender still globs, so a ledger
	 * that missed a line after a crash repairs itself. The scan is streamed line
	 * by line: startup memory is one line, not a hundreds-of-MiB backlog.
	 */
	@PostConstruct
	void start() {
		seed();
		try {
			try (Statement statement = ledger.createStatement()) {
				statement.execute("PRAGMA optimize");
				statement.execute("VACUUM");
				statement.execute("PRAGMA wal_checkpoint(TRUNCATE)");
			}
			log.info("dedupe ledger vacuumed ({} keys)", keys());
		} catch (SQLException upkeep) {
			log.warn("ledger upkeep failed ({}); continuing", upkeep.getMessage());
		}
		for (Path file : List.of(spool, ledgerPath,
				Path.of(ledgerPath + "-wal"), Path.of(ledgerPath + "-shm"))) {
			makePrivate(file);
		}
		log.info("spool={} max_bytes={} sender={}", spool, properties.spoolMaxBytes(),
			properties.spoolSender().isEmpty() ? "off" : properties.spoolSender());
		// Startup is the one moment nobody is appending, so a tail an earlier run
		// left is folded before it grows further, over the ceiling or not. An
		// empty tail is left alone, as the reference daemon does.
		fold(pendingBytes() > 0);
	}

	@PreDestroy
	void stop() {
		shuttingDown = true;
		timer.shutdownNow();
		Process child = activeChild.get();
		if (child != null && child.isAlive()) {
			// A fold is a child writing to the warehouse; let it finish so the
			// sender removes its own lock rather than leaving it stale.
			child.onExit().orTimeout(5, TimeUnit.SECONDS);
		}
		try {
			ledger.close();
		} catch (SQLException ignored) {
			// The process is going away; the kernel closes it.
		}
	}

	// --- the tail ----------------------------------------------------------

	/** One batch's append; closing it flushes, and a failed batch truncates. */
	final class Append implements AutoCloseable {

		private final long start;
		private final FileChannel channel;
		private final BufferedWriter writer;
		private volatile boolean rolledBack;

		private Append() throws IOException {
			// ONE handle answers both questions: `start` is the size of the very
			// file this batch appends to, and a refused batch truncates that same
			// handle. Sizing the path first left the two describing different files
			// whenever rotation renamed the spool in between, and the rollback then
			// truncated a tail it never wrote (docs/d228).
			this.channel = FileChannel.open(spool, StandardOpenOption.CREATE,
				StandardOpenOption.WRITE, StandardOpenOption.APPEND);
			this.start = channel.size();
			this.writer = new BufferedWriter(Channels.newWriter(channel, StandardCharsets.UTF_8));
			makePrivate(spool);
		}

		void line(String json) {
			try {
				writer.write(json);
				writer.write("\n");
			} catch (IOException exception) {
				throw new UncheckedIOException(exception);
			}
		}

		/**
		 * Mark the batch refused: closing then truncates the tail back to where
		 * the batch started, so no partial row is ever consumed.
		 */
		void fail() {
			rolledBack = true;
		}

		@Override
		public void close() {
			try {
				// Flush, then truncate, then close: the buffered lines must reach the
				// channel before the truncate, and closing first would take the handle
				// the truncate needs with it.
				writer.flush();
				if (rolledBack) {
					channel.truncate(start);
				}
				writer.close();
			} catch (IOException exception) {
				throw new UncheckedIOException(exception);
			}
		}
	}

	Append append() throws IOException {
		return new Append();
	}

	/** Whether a row identity is already recorded, or already in this batch. */
	boolean seen(String key, List<String> freshKeys) {
		if (freshKeys.contains(key)) {
			return true;
		}
		try (PreparedStatement statement = ledger.prepareStatement("SELECT 1 FROM seen WHERE key = ?")) {
			statement.setString(1, key);
			try (ResultSet rows = statement.executeQuery()) {
				if (rows.next()) {
					return true;
				}
			}
		} catch (SQLException failure) {
			// A broken ledger is the one place the safe direction is to answer
			// "not seen" (the warehouse's first-write-wins absorbs the duplicate)
			// and to say so.
			log.error("cannot read the dedupe ledger; treating the row as new", failure);
			return false;
		}
		freshKeys.add(key);
		return false;
	}

	/** Record the keys only after the append: the append is the durable act. */
	void remember(List<String> keys) {
		if (keys.isEmpty()) {
			return;
		}
		try {
			ledger.setAutoCommit(false);
			try (PreparedStatement statement = ledger.prepareStatement("INSERT OR IGNORE INTO seen(key) VALUES(?)")) {
				for (String key : keys) {
					statement.setString(1, key);
					statement.addBatch();
				}
				statement.executeBatch();
			}
			ledger.commit();
		} catch (SQLException failure) {
			log.error("cannot record dedupe keys; a replay may duplicate the spool line", failure);
		} finally {
			try {
				ledger.setAutoCommit(true);
			} catch (SQLException ignored) {
				// The connection is single-writer and this is the only writer.
			}
		}
	}

	private void seed() {
		List<Path> tails = new ArrayList<>();
		tails.add(spool);
		Path directory = java.util.Objects.requireNonNull(spool.getParent(), "spool directory");
		String base = java.util.Objects.requireNonNull(spool.getFileName(), "spool file name").toString();
		try (Stream<Path> files = Files.list(directory)) {
			files.filter(file -> {
				Path name = file.getFileName();
				return name != null && name.toString().startsWith(base + ".rm.");
			}).forEach(tails::add);
		} catch (IOException unreadable) {
			log.warn("cannot list {} for frozen tails: {}", directory, unreadable.getMessage());
		}
		List<String> keys = new ArrayList<>();
		for (Path tail : tails) {
			try (var lines = Files.lines(tail, StandardCharsets.UTF_8)) {
				lines.forEach(line -> {
					if (!line.isBlank()) {
						keys.add(SessionIngest.lineKey(line, mapper));
					}
				});
			} catch (NoSuchFileException rotated) {
				// Rotation renamed the tail between the listing and the open: the keys
				// it held were seeded on a previous start, and a warn here would
				// report routine upkeep as a fault (docs/d228).
				log.debug("frozen tail {} rotated before it could be seeded", tail);
			} catch (IOException | UncheckedIOException unreadable) {
				log.warn("cannot seed from {}: {}", tail, unreadable.getMessage());
			}
		}
		remember(keys);
	}

	private long keys() throws SQLException {
		try (Statement statement = ledger.createStatement();
				ResultSet rows = statement.executeQuery("SELECT count(*) FROM seen")) {
			return rows.next() ? rows.getLong(1) : 0;
		}
	}

	private void repairPartialTail(Path file) throws IOException {
		try (var channel = FileChannel.open(file, StandardOpenOption.READ)) {
			// The handle answers the size, so a tail that is absent, empty or emptied
			// between open and position is the same "nothing to repair" — no stat of
			// the path decides it (docs/d228).
			long size = channel.size();
			if (size == 0) {
				return;
			}
			channel.position(size - 1);
			var last = java.nio.ByteBuffer.allocate(1);
			channel.read(last);
			if (last.get(0) != (byte) '\n') {
				Files.writeString(file, "\n", StandardCharsets.UTF_8, StandardOpenOption.APPEND);
				log.warn("{} ended mid-line; appended a newline so the partial row is reported",
					file);
			}
		} catch (NoSuchFileException absent) {
			// The spool is created by the first append, and rotation may rename it at
			// any moment: there is nothing here to repair (docs/d228).
			log.debug("{} rotated before its partial tail could be repaired", file);
		}
	}

	// --- the fold ----------------------------------------------------------

	/**
	 * Fold the tail when it is over the ceiling, or whenever asked (startup). The
	 * sender is the shared shell script, so the daemon, an operator run and the
	 * sync's direct leg contend on the same `<spool>.lock`; a second sender exits
	 * 75 and that is busy, not a failure.
	 */
	void fold(boolean foldAnyTail) {
		String sender = properties.spoolSender();
		if (shuttingDown || sending || sender.isEmpty() || properties.spoolMaxBytes() <= 0
				|| properties.warehouseToken().isEmpty()) {
			return;
		}
		if (System.currentTimeMillis() < retryAt) {
			armRetry();
			return;
		}
		long pending = pendingBytes();
		if (!foldAnyTail && pending < properties.spoolMaxBytes()) {
			return;
		}
		sending = true;
		long bytesAtStart = pending;
		log.info("spool is {} bytes, folding it into the warehouse", pending);
		Process child;
		try {
			child = new ProcessBuilder("bash", sender, "--spool", spool.toString())
				.inheritIO().start();
		} catch (IOException cannotStart) {
			sending = false;
			log.error("cannot run the sender {}: {}", sender, cannotStart.getMessage());
			backOff();
			return;
		}
		activeChild.set(child);
		child.onExit().thenAccept(finished -> {
			sending = false;
			activeChild.set(null);
			if (shuttingDown) {
				return;
			}
			// Measure what is left instead of subtracting what this process
			// counted: a fold freezes the old tail and a new append creates a new
			// one, and a failed fold leaves the whole tail behind.
			long remaining = pendingBytes();
			int code = finished.exitValue();
			if (code == 0) {
				log.info("spool folded ({} bytes remain)", remaining);
				if (remaining < bytesAtStart) {
					fold(false);
				} else if (remaining > 0) {
					log.warn("spool folded but {} bytes remain; not folding again until the next append",
						remaining);
				}
			} else if (code == SENDER_BUSY) {
				log.warn("another sender holds the spool lock; retrying in {}",
					properties.spoolSendRetry());
				backOff();
			} else {
				log.error("spool send failed ({}); spool kept, retrying in {}", code,
					properties.spoolSendRetry());
				backOff();
			}
		});
	}

	private void backOff() {
		retryAt = System.currentTimeMillis() + properties.spoolSendRetry().toMillis();
		armRetry();
	}

	/**
	 * A failed fold ends in this timer, not in the next POST: an idle daemon
	 * would otherwise leave the tail growing while the backoff expired silently.
	 */
	private void armRetry() {
		long delay = Math.max(0, retryAt - System.currentTimeMillis()) + 10;
		try {
			timer.schedule(() -> fold(false), delay, TimeUnit.MILLISECONDS);
		} catch (java.util.concurrent.RejectedExecutionException ignored) {
			// The daemon is stopping; the tail waits for the next run.
		}
	}

	/** Bytes pending across the live tail and every frozen one. */
	long pendingBytes() {
		long total = 0;
		Path directory = java.util.Objects.requireNonNull(spool.getParent(), "spool directory");
		String base = java.util.Objects.requireNonNull(spool.getFileName(), "spool file name").toString();
		try (Stream<Path> files = Files.list(directory)) {
			for (Path file : files.toList()) {
				Path fileName = file.getFileName();
				String name = fileName == null ? "" : fileName.toString();
				if (name.equals(base) || name.startsWith(base + ".rm.")) {
					total += Files.size(file);
				}
			}
		} catch (IOException unreadable) {
			log.warn("cannot measure the spool: {}", unreadable.getMessage());
		}
		return total;
	}

	private static void prepareDirectory(Path file) throws IOException {
		Path directory = java.util.Objects.requireNonNull(file.getParent(), "spool directory");
		Files.createDirectories(directory);
		Path name = directory.getFileName();
		if (name != null && "agent-warehouse".equals(name.toString())) {
			Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
		}
	}

	private static void makePrivate(Path file) {
		try {
			Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
		} catch (IOException ignored) {
			// A filesystem without POSIX modes keeps its mode; Java has no umask.
		}
	}
}
