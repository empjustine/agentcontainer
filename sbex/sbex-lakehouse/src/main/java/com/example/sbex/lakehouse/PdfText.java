package com.example.sbex.lakehouse;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import org.apache.commons.logging.LogFactory;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * PDF text extraction, out of process. The appender is the one component whose
 * input is an arbitrary file, so the parser gets its own JVM with a heap cap, a
 * wall clock and no network or store handle: a decompression bomb or a parser
 * crash stays in that child (docs/d205, and the daemon's PDF_WORKER).
 *
 * WHY the child's classpath is computed from the marker classes below: a
 * repackaged Spring Boot jar has no plain classpath to hand a child, but an
 * unpacked deployment, a test run and an IDE run all resolve real files. The
 * locations of the markers are the only dependency list this class needs to
 * keep exact, and a missing one is reported at startup rather than at the first
 * capture.
 */
@Component
class PdfText {

	private static final Logger log = LoggerFactory.getLogger(PdfText.class);

	/** Bytes of the child's stderr kept for the log line; a trace, not the file. */
	private static final int STDERR_CEILING = 2_000;

	/** The classes whose artifacts the worker needs; each must resolve to a file. */
	private static final List<Class<?>> MARKERS = List.of(
		PdfWorker.class,
		PDDocument.class,
		PDFTextStripper.class,
		// One class from each of pdfbox's two companion artifacts; PDFont is
		// pdfbox's own, which is why the class rather than the artifact name is
		// the marker.
		org.apache.fontbox.type1.DamagedFontException.class,
		org.apache.pdfbox.io.RandomAccessReadBuffer.class,
		LogFactory.class);

	private final LakehouseProperties properties;
	private final String classpath;

	PdfText(LakehouseProperties properties) {
		this.properties = properties;
		this.classpath = resolveClasspath();
		if (classpath == null) {
			// A repackaged Boot jar has no plain classpath to hand a child. The
			// unpacked deployment (docs/container-image.md) does, and so does a
			// test or IDE run; this line is what tells an operator which layout
			// they are in when the first capture fails.
			log.warn("PDF worker classpath unresolved (repackaged jar?); run the unpacked"
				+ " layout or set LAKEHOUSE_PDF_CLASSPATH, or /api/add_pdf answers 500");
		}
	}

	/**
	 * Extract text under the wall clock and the output ceiling. The reader
	 * answers 500 when this throws, which is upstream's shape: a document the
	 * index cannot see is not a successful capture.
	 */
	String extract(byte[] pdf) {
		List<String> command = new ArrayList<>();
		if (!properties.workerPrefix().isEmpty()) {
			command.addAll(List.of(properties.workerPrefix().strip().split("\\s+")));
		}
		command.add(javaBinary());
		command.add("-Xmx" + properties.pdfHeap());
		command.add("-XX:ActiveProcessorCount=1");
		command.add("-Djava.awt.headless=true");
		command.add("-cp");
		command.add(classpath == null ? "" : classpath);
		Path output;
		try {
			// The child writes its result to a file, not to stdout: PDFBox's own
			// logger shares stdout when a logging binding is on the child's
			// classpath, and a text field that mixes log lines into a document is
			// a silently corrupted capture. The file is also the bounded channel —
			// the read below is capped by pdfMaxText, not by whatever the parser
			// emits.
			output = Files.createTempFile("lakehouse-pdf", ".txt");
			Files.setPosixFilePermissions(output, PosixFilePermissions.fromString("rw-------"));
		} catch (IOException exception) {
			throw new ExtractionException("cannot stage the pdf worker output: " + exception.getMessage(), exception);
		}
		command.add(PdfWorker.class.getName());
		command.add(output.toString());
		Process process;
		try {
			process = new ProcessBuilder(command).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
		} catch (IOException exception) {
			deleteQuietly(output);
			throw new ExtractionException("cannot start the pdf worker: " + exception.getMessage(), exception);
		}
		try {
			ByteArrayOutputStream errors = new ByteArrayOutputStream();
			Thread writer = Thread.ofVirtual().start(() -> writeStdin(process, pdf));
			Thread drain = Thread.ofVirtual().start(() -> drain(process.getErrorStream(), 8 * 1024, errors));
			boolean exited = process.waitFor(properties.pdfTimeout().toSeconds(), TimeUnit.SECONDS);
			if (!exited) {
				process.destroyForcibly();
				throw new ExtractionException("pdf extraction timed out", null);
			}
			writer.join();
			drain.join();
			if (process.exitValue() != 0) {
				// The whole trace, not its last line: a ClassNotFound's cause is at
				// the head, and this text goes to the log, never to the client.
				String detail = errors.toString(StandardCharsets.UTF_8).strip();
				if (detail.length() > STDERR_CEILING) {
					detail = detail.substring(0, STDERR_CEILING);
				}
				throw new ExtractionException("pdf worker exited " + process.exitValue() + ": " + detail, null);
			}
			return readText(output);
		} catch (InterruptedException interrupted) {
			Thread.currentThread().interrupt();
			process.destroyForcibly();
			throw new ExtractionException("pdf extraction interrupted", interrupted);
		} finally {
			deleteQuietly(output);
		}
	}

	private static void deleteQuietly(Path file) {
		try {
			Files.deleteIfExists(file);
		} catch (IOException ignored) {
			// A temp file left behind is the deletion's failure, not the capture's.
		}
	}

	/** The child's staged text, refused if it is over the configured ceiling. */
	private String readText(Path output) {
		try {
			if (Files.size(output) > properties.pdfMaxText()) {
				throw new ExtractionException("pdf text exceeds the configured ceiling", null);
			}
			return Files.readString(output, StandardCharsets.UTF_8);
		} catch (IOException exception) {
			throw new ExtractionException("cannot read the pdf worker output: " + exception.getMessage(), exception);
		}
	}

	/** A refused extraction, mapped to the 500 upstream reports. */
	static final class ExtractionException extends RuntimeException {

		private static final long serialVersionUID = 1L;

		ExtractionException(String message, Throwable cause) {
			super(message, cause);
		}
	}

	private static void writeStdin(Process process, byte[] pdf) {
		try (OutputStream stdin = process.getOutputStream()) {
			stdin.write(pdf);
		} catch (IOException ignored) {
			// The child exited early (a malformed PDF); its stderr carries why.
		}
	}

	/** Capture the child's stderr up to a ceiling, so the log line can name its reason. */
	private static void drain(InputStream stream, int limit, ByteArrayOutputStream captured) {
		byte[] buffer = new byte[1024];
		try (InputStream input = stream) {
			int read = input.read(buffer);
			while (read > 0) {
				if (captured.size() < limit) {
					captured.write(buffer, 0, Math.min(read, limit - captured.size()));
				}
				read = input.read(buffer);
			}
		} catch (IOException ignored) {
			// The child is gone; the exit code and stdout already say how it went.
		}
	}

	private static String javaBinary() {
		return Path.of(System.getProperty("java.home"), "bin", "java").toString();
	}

	/**
	 * The child's -cp, or null when a marker resolves to a nested jar (a
	 * repackaged Boot jar), which a second JVM cannot open.
	 */
	private static String resolveClasspath() {
		String configured = System.getenv("LAKEHOUSE_PDF_CLASSPATH");
		if (configured != null && !configured.isBlank()) {
			return configured;
		}
		Set<String> entries = new LinkedHashSet<>();
		for (Class<?> marker : MARKERS) {
			try {
				var source = marker.getProtectionDomain().getCodeSource();
				if (source == null || !"file".equals(source.getLocation().getProtocol())) {
					return null;
				}
				entries.add(Path.of(source.getLocation().toURI()).toString());
			} catch (Exception unavailable) {
				return null;
			}
		}
		return String.join(java.io.File.pathSeparator, entries);
	}
}
