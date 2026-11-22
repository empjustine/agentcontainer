package com.example.sbex.lakehouse;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * The canonicaliser is the contract /visited answers against: the daemon and
 * the stock extension must normalise a URL identically, or a visited link
 * reports unvisited. These pairs are the tracked shapes from the unit's shell
 * suite plus the upstream rewrite rules this port has to keep.
 */
class CanonicalUrlTest {

	@Test
	void foldsTheTrackedShapes() {
		assertEquals("twitter.com/foo/status/1",
			CanonicalUrl.normalise("https://mobile.twitter.com/foo/status/1?s=20"));
		assertEquals("example.com/a/b/?id=5",
			CanonicalUrl.normalise("http://www.example.com/a/b/?utm_source=x&id=5"));
		assertEquals("example.com", CanonicalUrl.normalise("https://example.com/"));
	}

	@Test
	void appliesUpstreamRewriteRules() {
		assertEquals("youtube.com/watch?v=abc", CanonicalUrl.normalise("https://youtu.be/abc"));
		assertEquals("youtube.com/watch?v=abc", CanonicalUrl.normalise("https://www.youtube.com/embed/abc"));
		assertEquals("twitter.com", CanonicalUrl.normalise("https://mobile.twitter.com/home"));
		assertEquals("twitter.com/x/y", CanonicalUrl.normalise("https://nitter.net/x/y"));
		assertEquals("example.com/post",
			CanonicalUrl.normalise("web.archive.org/web/20200101000000/example.com/post"));
		assertEquals("example.com/a", CanonicalUrl.normalise("https://news.ycombinator.com/from?site=example.com%2Fa"));
	}

	@Test
	void keepsTheSiteQueryOrder() {
		assertEquals("youtube.com/watch?v=abc&t=10",
			CanonicalUrl.normalise("https://www.youtube.com/watch?t=10&v=abc&feature=x"));
	}

	@Test
	void dropsTheFragmentAndUnknownQueryKeys() {
		assertEquals("example.com/a", CanonicalUrl.normalise("https://example.com/a#frag"));
		assertEquals("example.com/a?id=", CanonicalUrl.normalise("https://example.com/a?utm_medium=mail&id="));
	}
}
