package com.example.sbex.lakehouse;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * The JSON spelling the reference session daemon produces, for the two places
 * where bytes are the contract:
 *
 * - the spool line, which the shell sender hands to the warehouse verbatim
 *   (docs/d221), so a row the reference wrote and a row this service wrote must
 *   be the same text;
 * - the canonical row JSON a key is hashed from, which is what makes a row
 *   posted before the switch and re-posted after it the same row.
 *
 * The serializer is hand-written rather than a Jackson generator because two
 * JavaScript rules are not settings: numbers print through ECMAScript's
 * Number::toString (Node parses every literal to a double, so `1.0` is `1` and
 * a value past 2^53 prints its rounded double), and control characters escape
 * with a lowercase hex (`\u000b`), where Jackson writes `\u000B`. Either
 * difference changes the hash and the stored line.
 *
 * Known residual: the JDK's shortest-decimal printing disagrees with ECMAScript
 * for a few extreme subnormals (`Double.toString(5e-324)` is `4.9E-324`,
 * ECMAScript prints `5e-324`). No session row carries one.
 */
final class JsJson {

	private JsJson() {
	}

	/** The input's own key order, as JSON.stringify keeps it. */
	static String compact(JsonNode node) {
		StringBuilder out = new StringBuilder(256);
		writeValue(node, out, false);
		return out.toString();
	}

	/** Sorted keys, for an identity that must not depend on field order. */
	static String canonical(JsonNode node) {
		StringBuilder out = new StringBuilder(256);
		writeValue(node, out, true);
		return out.toString();
	}

	private static void writeValue(JsonNode node, StringBuilder out, boolean sorted) {
		if (node == null || node.isNull()) {
			out.append("null");
			return;
		}
		if (node.isObject()) {
			List<Map.Entry<String, JsonNode>> entries = new ArrayList<>(node.properties());
			if (sorted) {
				entries.sort(Comparator.comparing(Map.Entry::getKey));
			}
			out.append('{');
			for (int index = 0; index < entries.size(); index++) {
				if (index > 0) {
					out.append(',');
				}
				out.append(jsString(entries.get(index).getKey())).append(':');
				writeValue(entries.get(index).getValue(), out, sorted);
			}
			out.append('}');
			return;
		}
		if (node.isArray()) {
			out.append('[');
			for (int index = 0; index < node.size(); index++) {
				if (index > 0) {
					out.append(',');
				}
				writeValue(node.get(index), out, sorted);
			}
			out.append(']');
			return;
		}
		if (node.isString()) {
			out.append(jsString(node.asString()));
			return;
		}
		if (node.isNumber()) {
			out.append(number(node.asDouble()));
			return;
		}
		if (node.isBoolean()) {
			out.append(node.asBoolean() ? "true" : "false");
			return;
		}
		out.append(jsString(node.asString("")));
	}

	/**
	 * JSON.stringify's string rule: the two mandatory escapes, the five shortcut
	 * escapes, the lowercase four-hex control escape for the rest, a lone
	 * surrogate with its own escape, and every other character raw.
	 */
	private static String jsString(String value) {
		StringBuilder out = new StringBuilder(value.length() + 2);
		out.append('"');
		for (int index = 0; index < value.length(); index++) {
			char character = value.charAt(index);
			switch (character) {
				case '"' -> out.append("\\\"");
				case '\\' -> out.append("\\\\");
				case '\b' -> out.append("\\b");
				case '\f' -> out.append("\\f");
				case '\n' -> out.append("\\n");
				case '\r' -> out.append("\\r");
				case '\t' -> out.append("\\t");
				default -> {
					if (character < 0x20 || loneSurrogate(value, index)) {
						out.append(String.format("\\u%04x", (int) character));
					} else {
						out.append(character);
					}
				}
			}
		}
		return out.append('"').toString();
	}

	/** A surrogate with no partner, which ECMAScript's well-formed output escapes. */
	private static boolean loneSurrogate(String value, int index) {
		char character = value.charAt(index);
		if (Character.isHighSurrogate(character)) {
			return index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1));
		}
		if (Character.isLowSurrogate(character)) {
			return index == 0 || !Character.isHighSurrogate(value.charAt(index - 1));
		}
		return false;
	}

	/**
	 * ECMAScript's Number::toString for a finite double: the shortest decimal
	 * that round-trips, rendered in the notation the spec fixes for its
	 * magnitude.
	 */
	static String number(double value) {
		if (value == 0) {
			return "0";
		}
		if (value < 0) {
			return "-" + number(-value);
		}
		String printed = Double.toString(value);
		int exponentAt = printed.indexOf('E');
		String mantissa = exponentAt < 0 ? printed : printed.substring(0, exponentAt);
		int exponent = exponentAt < 0 ? 0 : Integer.parseInt(printed.substring(exponentAt + 1));
		int dot = mantissa.indexOf('.');
		String digits = dot < 0 ? mantissa : mantissa.substring(0, dot) + mantissa.substring(dot + 1);
		int pointPosition = (dot < 0 ? mantissa.length() : dot) + exponent;
		int leading = 0;
		while (leading < digits.length() - 1 && digits.charAt(leading) == '0') {
			leading++;
			pointPosition--;
		}
		digits = digits.substring(leading);
		int end = digits.length();
		while (end > 1 && digits.charAt(end - 1) == '0') {
			end--;
		}
		digits = digits.substring(0, end);
		int length = digits.length();
		int position = pointPosition;
		if (length <= position && position <= 21) {
			return digits + "0".repeat(position - length);
		}
		if (0 < position && position <= 21) {
			return digits.substring(0, position) + "." + digits.substring(position);
		}
		if (-6 < position && position <= 0) {
			return "0." + "0".repeat(-position) + digits;
		}
		int scientific = position - 1;
		String head = length > 1 ? digits.charAt(0) + "." + digits.substring(1) : digits.substring(0, 1);
		return head + "e" + (scientific >= 0 ? "+" : "-") + Math.abs(scientific);
	}
}
