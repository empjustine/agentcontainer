package com.example.sbex.lakehouse;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Promnesia's URL canonicaliser, ported from the vendored cannon.py (MIT,
 * (c) 2018 Dmitrii Gerasimov) that docs/d172 and docs/d176 pin.
 *
 * WHY a faithful port rather than a "better" normaliser: /visited answers only
 * when both sides fold a URL to the same key. The stock extension ships the
 * upstream Python, so a Java rule that differs by one trailing slash answers
 * "not seen" for a page the extension has already captured. The tables below
 * are upstream's, including the bug-compatible parts (a port survives domain
 * folding, a spec's keep order decides the query order), and the differential
 * fixture in CanonicalUrlTest is the guard against drift.
 */
final class CanonicalUrl {

	/** Domain prefixes folded to the desktop spelling, in upstream's order. */
	private static final List<String[]> DOMAIN_SUBSTITUTIONS = List.of(
		new String[] { "m.youtube.", "youtube." },
		new String[] { "studio.youtube.", "youtube." },
		new String[] { "mobile.twitter.", "twitter." },
		new String[] { "m.twitter.", "twitter." },
		new String[] { "nitter.net", "twitter.com" },
		new String[] { "m.reddit.", "reddit." },
		new String[] { "old.reddit.", "reddit." },
		new String[] { "i.reddit.", "reddit." },
		new String[] { "pay.reddit.", "reddit." },
		new String[] { "np.reddit.", "reddit." },
		new String[] { "m.facebook.", "facebook." },
		new String[] { "getpocket.", "app.getpocket." });

	/**
	 * The query keys kept when no site spec applies, in the order they are
	 * re-emitted: upstream keeps 'id', thread and post markers and drops the
	 * rest, because dropping too much is what a user notices.
	 */
	private static final List<String> DEFAULT_KEEP = List.of("id", "t", "p");

	/**
	 * Per-site keep lists. A spec's order is significant: youtube's
	 * `?v=…&t=…` must stay in that order for a re-canonicalised URL to equal
	 * the one the extension produced. Upstream's per-site removal sets are not
	 * carried: the default is already "drop", so only a keep list changes an
	 * outcome.
	 */
	private static final Map<String, Spec> SPECS = Map.ofEntries(
		Map.entry("youtube.com", Spec.keep("v", "t", "list")),
		Map.entry("github.com", Spec.keep("q")),
		Map.entry("facebook.com", Spec.keep("fbid", "story_fbid")),
		Map.entry("physicstravelguide.com", Spec.keepAll()),
		Map.entry("wikipedia.org", Spec.keepAll()),
		Map.entry("scottaaronson.com", Spec.keep("p")),
		Map.entry("urbandictionary.com", Spec.keep("term")),
		Map.entry("ycombinator.com", Spec.keep("id")),
		Map.entry("play.google.com", Spec.keep("id")),
		Map.entry("answers.yahoo.com", Spec.keep("qid")),
		Map.entry("isfdb.org", Spec.keepAll()));

	private static final Spec DEFAULT_SPEC = Spec.keep();

	/** Archive.org keeps the archived page, not the archive's own timestamp. */
	private static final Pattern ARCHIVE_ORG =
		Pattern.compile("web\\.archive\\.org/web/(?<timestamp>\\d+)/(?<rest>.*)");

	/** Google's AMP wrapper is the same page; upstream strips the prefix. */
	private static final Pattern GOOGLE_AMP = Pattern.compile("google\\..*/amp/s/");

	private static final String YOUTUBE_SHORT_HOST = "youtu.be";
	private static final String YOUTUBE_HOST = "youtube.com";
	private static final String TWITTER_HOST = "twitter.com";
	private static final String TWITTER_HOME = "/home";
	private static final String TWITTER_EXPLORE = "/explore";

	private static final Pattern YOUTU_BE = Pattern.compile("(?<id>[^/]+)");
	private static final Pattern YOUTUBE_EMBED = Pattern.compile("embed/(?<id>[^/]+)");

	private CanonicalUrl() {
	}

	/**
	 * The one normalisation every path uses. An unparseable URL answers itself:
	 * a visited check for it must say "not seen" rather than fold it into some
	 * other page's key.
	 */
	static String normalise(String raw) {
		String url = raw == null ? "" : raw;
		try {
			return canonify(url);
		} catch (RuntimeException exception) {
			return url.strip();
		}
	}

	private static String canonify(String raw) {
		String url = prenormalise(clean(raw));
		Parts parts = split(url);
		if (parts.scheme().isEmpty()) {
			// Without a scheme the authority is not parsed out of the path, so
			// the daemon and upstream both retry with a dummy one.
			parts = split("http://" + url);
		}
		if (parts.netloc().indexOf('[') >= 0 && parts.netloc().indexOf(']') < 0) {
			// An unclosed IPv6 literal is urlsplit's own ValueError upstream.
			throw new IllegalArgumentException("invalid IPv6 URL");
		}
		String noProtocol = parts.netloc() + parts.path() + parts.query() + parts.fragment();
		Matcher archive = ARCHIVE_ORG.matcher(noProtocol);
		if (archive.matches()) {
			return canonify(archive.group("rest"));
		}
		List<Pair> query = parseQuery(parts.query());
		// Upstream folds the domain before its rewrite rules, so mobile.twitter's
		// timeline and the desktop one land on the same canonical URL.
		Transform transformed = transform(canonifyDomain(parts.netloc()), parts.path(), query);
		String domain = transformed.netloc();
		String path = transformed.path();
		List<Pair> pairs = transformed.query();
		Transform rewritten = hackerNews(domain, path, pairs);
		domain = rewritten.netloc();
		path = rewritten.path();
		pairs = rewritten.query();
		Spec spec = spec(domain);
		List<OrderedPair> kept = new ArrayList<>();
		for (Pair pair : pairs) {
			int order = spec.keepOrder(pair.key());
			if (order >= 0) {
				kept.add(new OrderedPair(order, pair.key(), pair.value()));
			}
		}
		kept.sort((left, right) -> {
			if (left.order() != right.order()) {
				return Integer.compare(left.order(), right.order());
			}
			int key = left.key().compareTo(right.key());
			return key != 0 ? key : left.value().compareTo(right.value());
		});
		String encodedQuery = encodeQuery(kept);
		String quotedPath = quotePath(path);
		String unsplit = domain + quotedPath + (encodedQuery.isEmpty() ? "" : "?" + encodedQuery);
		return unsplit.endsWith("/") ? unsplit.substring(0, unsplit.length() - 1) : unsplit;
	}

	/**
	 * Upstream's two URL-rewrite rules: a video's embed and short link fold to
	 * one watch URL, and a Twitter timeline's two spellings fold to one.
	 */
	private static Transform transform(String netloc, String path, List<Pair> query) {
		if (YOUTUBE_SHORT_HOST.equals(netloc)) {
			Matcher match = YOUTU_BE.matcher(stripLeadingSlash(path));
			if (match.matches()) {
				List<Pair> extended = new ArrayList<>(query);
				extended.add(new Pair("v", match.group("id")));
				return new Transform("youtube.com", "/watch", extended);
			}
		}
		if (YOUTUBE_HOST.equals(netloc)) {
			Matcher match = YOUTUBE_EMBED.matcher(stripLeadingSlash(path));
			if (match.matches()) {
				List<Pair> extended = new ArrayList<>(query);
				extended.add(new Pair("v", match.group("id")));
				return new Transform("youtube.com", "/watch", extended);
			}
		}
		if (TWITTER_HOST.equals(netloc) && (TWITTER_HOME.equals(path) || TWITTER_EXPLORE.equals(path))) {
			return new Transform(TWITTER_HOST, "", List.of());
		}
		return new Transform(netloc, path, query);
	}

	/**
	 * Upstream's get_spec2: a Hacker News item link carries the real URL in its
	 * `?site=`, and the canonical URL is that target, not the wrapper.
	 */
	private static Transform hackerNews(String domain, String path, List<Pair> query) {
		if (!"news.ycombinator.com".equals(domain) || !path.startsWith("/from")) {
			return new Transform(domain, path, query);
		}
		String site = null;
		for (Pair pair : query) {
			if ("site".equals(pair.key()) && site == null) {
				site = pair.value();
			}
		}
		return site == null ? new Transform(domain, path, query) : new Transform(site, "", List.of());
	}

	/**
	 * The spec that owns a domain, found by walking up its suffixes: a spec on
	 * youtube.com also owns m.youtube.com after domain folding and any
	 * subdomain upstream did not fold.
	 */
	private static Spec spec(String domain) {
		String[] labels = domain.split("\\.");
		String suffix = "";
		for (int index = labels.length - 1; index >= 0; index--) {
			suffix = suffix.isEmpty() ? labels[index] : labels[index] + "." + suffix;
			Spec spec = SPECS.get(suffix);
			if (spec != null) {
				return spec;
			}
		}
		return DEFAULT_SPEC;
	}

	private static String clean(String url) {
		String withoutUnsafe = url.replace("\t", "").replace("\r", "").replace("\n", "");
		return stripControls(withoutUnsafe);
	}

	/** urlsplit strips leading and trailing C0 controls and spaces. */
	private static String stripControls(String value) {
		int start = 0;
		int end = value.length();
		while (start < end && value.charAt(start) <= ' ') {
			start++;
		}
		while (end > start && value.charAt(end - 1) <= ' ') {
			end--;
		}
		return value.substring(start, end);
	}

	private static String prenormalise(String url) {
		String withoutAmp = GOOGLE_AMP.matcher(url).replaceAll("");
		if (withoutAmp.indexOf('?') < 0) {
			// A Google Takeout URL can carry '&'-only query parameters, which
			// urlsplit reads as part of the path.
			int first = withoutAmp.indexOf('&');
			if (first >= 0) {
				return withoutAmp.substring(0, first) + "?" + withoutAmp.substring(first + 1);
			}
		}
		return withoutAmp;
	}

	/** The subset of urlsplit this port needs: scheme, authority, path, query, fragment. */
	private record Parts(String scheme, String netloc, String path, String query, String fragment) {}

	private static Parts split(String url) {
		String scheme = "";
		String rest = url;
		int colon = url.indexOf(':');
		if (colon > 0) {
			String candidate = url.substring(0, colon);
			if (!candidate.isEmpty() && Character.isLetter(candidate.charAt(0))) {
				boolean valid = true;
				for (int index = 1; index < candidate.length(); index++) {
					char character = candidate.charAt(index);
					if (!(Character.isLetterOrDigit(character) || character == '+' || character == '-' || character == '.')) {
						valid = false;
						break;
					}
				}
				if (valid) {
					scheme = candidate.toLowerCase(java.util.Locale.ROOT);
					rest = url.substring(colon + 1);
				}
			}
		}
		String netloc = "";
		if (rest.startsWith("//")) {
			int end = rest.length();
			for (int index = 2; index < rest.length(); index++) {
				char character = rest.charAt(index);
				if (character == '/' || character == '?' || character == '#') {
					end = index;
					break;
				}
			}
			netloc = rest.substring(2, end);
			rest = rest.substring(end);
		}
		String fragment = "";
		int hash = rest.indexOf('#');
		if (hash >= 0) {
			fragment = rest.substring(hash + 1);
			rest = rest.substring(0, hash);
		}
		String query = "";
		int question = rest.indexOf('?');
		if (question >= 0) {
			query = rest.substring(question + 1);
			rest = rest.substring(0, question);
		}
		return new Parts(scheme, netloc, rest, query, fragment);
	}

	/** A decoded query parameter, kept in wire order until the spec re-orders it. */
	private record Pair(String key, String value) {}

	private record OrderedPair(int order, String key, String value) {}

	private record Transform(String netloc, String path, List<Pair> query) {}

	private static List<Pair> parseQuery(String query) {
		List<Pair> pairs = new ArrayList<>();
		if (query.isEmpty()) {
			return pairs;
		}
		for (String part : query.split("&", -1)) {
			if (part.isEmpty()) {
				continue;
			}
			int equals = part.indexOf('=');
			String key = equals < 0 ? part : part.substring(0, equals);
			String value = equals < 0 ? "" : part.substring(equals + 1);
			// parse_qsl decodes '+' as space before percent-decoding; upstream
			// then re-encodes every kept value, so the space is round-tripped.
			pairs.add(new Pair(unquote(key.replace("+", " ")), unquote(value.replace("+", " "))));
		}
		return pairs;
	}

	private static String encodeQuery(List<OrderedPair> pairs) {
		StringBuilder encoded = new StringBuilder();
		for (OrderedPair pair : pairs) {
			if (!encoded.isEmpty()) {
				encoded.append('&');
			}
			encoded.append(quote(pair.key())).append('=').append(quote(pair.value()));
		}
		return encoded.toString();
	}

	/**
	 * A path segment that is already partially encoded is decoded first, so a
	 * '%20' and a space fold to the same spelling rather than double-encoding.
	 */
	private static String quotePath(String path) {
		String[] segments = path.split("/", -1);
		StringBuilder quoted = new StringBuilder();
		for (int index = 0; index < segments.length; index++) {
			if (index > 0) {
				quoted.append('/');
			}
			String segment = segments[index];
			if (segment.indexOf('%') >= 0 || segment.indexOf('+') >= 0) {
				segment = unquote(segment);
			}
			quoted.append(quote(segment));
		}
		return quoted.toString();
	}

	private static final char[] HEX_DIGITS = "0123456789ABCDEF".toCharArray();

	/** Python's quote(safe=''): unreserved characters survive, everything else is %XX. */
	private static String quote(String value) {
		byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
		StringBuilder encoded = new StringBuilder(bytes.length);
		for (byte raw : bytes) {
			int character = raw & 0xFF;
			if ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
				|| (character >= '0' && character <= '9') || character == '_' || character == '.' || character == '-' || character == '~') {
				encoded.append((char) character);
			} else {
				encoded.append('%').append(HEX_DIGITS[character >> 4]).append(HEX_DIGITS[character & 0xF]);
			}
		}
		return encoded.toString();
	}

	/** Python's unquote: percent pairs decode, an invalid pair stays literal. */
	private static String unquote(String value) {
		if (value.indexOf('%') < 0) {
			return value;
		}
		ByteArrayOutputStream bytes = new ByteArrayOutputStream(value.length());
		int index = 0;
		while (index < value.length()) {
			char character = value.charAt(index);
			int high = character == '%' && index + 1 < value.length() ? hex(value.charAt(index + 1)) : -1;
			int low = high >= 0 && index + 2 < value.length() ? hex(value.charAt(index + 2)) : -1;
			if (high >= 0 && low >= 0) {
				bytes.write(high * 16 + low);
				index += 3;
			} else {
				int codePoint = value.codePointAt(index);
				byte[] encoded = new String(Character.toChars(codePoint)).getBytes(StandardCharsets.UTF_8);
				bytes.write(encoded, 0, encoded.length);
				index += Character.charCount(codePoint);
			}
		}
		return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
	}

	private static int hex(char character) {
		if (character >= '0' && character <= '9') {
			return character - '0';
		}
		if (character >= 'a' && character <= 'f') {
			return character - 'a' + 10;
		}
		if (character >= 'A' && character <= 'F') {
			return character - 'A' + 10;
		}
		return -1;
	}

	private static String stripLeadingSlash(String path) {
		return path.startsWith("/") ? path.substring(1) : path;
	}

	private static String canonifyDomain(String domain) {
		String folded = domain;
		for (String prefix : List.of("www.", "amp.")) {
			if (folded.startsWith(prefix)) {
				folded = folded.substring(prefix.length());
			}
		}
		for (String[] substitution : DOMAIN_SUBSTITUTIONS) {
			if (folded.startsWith(substitution[0])) {
				return substitution[1] + folded.substring(substitution[0].length());
			}
		}
		return folded;
	}

	/** A site's query policy: keep nothing, keep listed keys in order, or keep all. */
	private record Spec(boolean all, List<String> keys) {

		static Spec keepAll() {
			return new Spec(true, List.of());
		}

		static Spec keep(String... keys) {
			return new Spec(false, Arrays.asList(keys));
		}

		/**
		 * The emission order of a key, or -1 when the spec drops it. A key in both
		 * the default list and the site's takes the site's position, which is
		 * upstream's dict-comprehension overwrite and what keeps youtube's
		 * `?v=…&t=…` in that order.
		 */
		int keepOrder(String key) {
			if (all) {
				return 1;
			}
			List<String> order = new ArrayList<>(DEFAULT_KEEP);
			order.addAll(keys);
			java.util.Map<String, Integer> positions = new java.util.HashMap<>();
			for (int index = 0; index < order.size(); index++) {
				positions.put(order.get(index), index);
			}
			Integer position = positions.get(key);
			return position == null ? -1 : position;
		}
	}
}
