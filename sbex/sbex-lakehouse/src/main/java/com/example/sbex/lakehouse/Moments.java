package com.example.sbex.lakehouse;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;

/**
 * The time boundary every face shares: producers send epoch milliseconds, a
 * producer may send seconds or ISO text, and the store keeps one zone.
 *
 * WHY storage is UTC: the read faces compare these values (a history clear
 * hides every visit up to its timestamp), and a lexical comparison of
 * "+02:00" against "+00:00" is a different instant that sorts in the wrong
 * place. The conversion back to the host zone is {@link #promnesia}'s job,
 * not storage's.
 *
 * WHY storage is ISO text and not an epoch integer: the daemon's schema is
 * the store's contract (sbex/datalakehouse-port.md, Storage) and an existing
 * browse.sqlite opens with its rows intact.
 */
final class Moments {

	/** Fixed width so a lexical compare inside one zone is also a time compare. */
	private static final DateTimeFormatter STORAGE =
		DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSSSSSxxx").withZone(ZoneOffset.UTC);

	/**
	 * IXDTF's numeric-offset form, in the host's zone. The stock Promnesia
	 * extension parses this field with Date.parse and slices six characters off
	 * the end, so a bracketed [Zone] annotation would break it; the offset form
	 * keeps both of the extension's fields correct (docs/d205).
	 */
	private static final DateTimeFormatter PROMNESIA_FORMAT =
		DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ssxxx").withZone(ZoneId.systemDefault());

	/** Firefox sends epoch milliseconds; below 1e11 the value is seconds. */
	private static final double MILLISECOND_THRESHOLD = 1e11;

	private Moments() {
	}

	/** A producer value as an instant: absent means now, as the daemon reads it. */
	static Instant parse(Object value) {
		if (value == null || "".equals(value)) {
			return Instant.now();
		}
		if (value instanceof Number number) {
			return fromEpoch(number.doubleValue());
		}
		String text = value.toString().trim();
		if (text.isEmpty()) {
			return Instant.now();
		}
		if (isDigits(text)) {
			return fromEpoch(Double.parseDouble(text));
		}
		// IXDTF may carry a bracketed [Zone] annotation; the offset already
		// fixes the instant, and the parser knows only the offset part.
		int bracket = text.lastIndexOf('[');
		if (text.endsWith("]") && bracket > 0) {
			text = text.substring(0, bracket).strip();
		}
		if (text.endsWith("Z") || text.endsWith("z")) {
			text = text.substring(0, text.length() - 1) + "+00:00";
		}
		try {
			return OffsetDateTime.parse(text).toInstant();
		} catch (DateTimeParseException ignored) {
			try {
				return LocalDateTime.parse(text).toInstant(ZoneOffset.UTC);
			} catch (DateTimeParseException unparseable) {
				throw new LakehouseProblems.BadRequestException("invalid timestamp: " + value, unparseable);
			}
		}
	}

	/** Epoch milliseconds of an instant, which is how a visit key is minted. */
	static long millis(Instant instant) {
		return instant.toEpochMilli();
	}

	/** The store's spelling: UTC, fixed microseconds, explicit +00:00. */
	static String store(Instant instant) {
		return STORAGE.format(instant.truncatedTo(ChronoUnit.MICROS));
	}

	/** The Promnesia wire spelling: host wall clock plus its numeric offset. */
	static String promnesia(Instant instant) {
		return PROMNESIA_FORMAT.format(instant.truncatedTo(ChronoUnit.SECONDS));
	}

	private static Instant fromEpoch(double value) {
		double seconds = value > MILLISECOND_THRESHOLD ? value / 1000.0 : value;
		return Instant.ofEpochMilli((long) (seconds * 1000.0));
	}

	private static boolean isDigits(String text) {
		String digits = text.replaceFirst("\\.", "");
		if (digits.isEmpty()) {
			return false;
		}
		for (int index = 0; index < digits.length(); index++) {
			if (!Character.isDigit(digits.charAt(index))) {
				return false;
			}
		}
		return true;
	}
}
