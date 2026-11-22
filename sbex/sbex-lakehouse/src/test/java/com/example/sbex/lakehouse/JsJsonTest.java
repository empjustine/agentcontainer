package com.example.sbex.lakehouse;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/**
 * The agent leg's bytes are a contract: the spool line is stored verbatim by the
 * warehouse, and the row key is a hash of the row. The reference daemon parses
 * every number to a double and prints it with ECMAScript's rules, so these pairs
 * were taken from `node -e 'JSON.stringify(x)'`.
 */
class JsJsonTest {

	@Test
	void formatsNumbersAsEcmaScriptDoes() {
		assertEquals("0", JsJson.number(0));
		assertEquals("1", JsJson.number(1.0));
		assertEquals("-1", JsJson.number(-1.0));
		assertEquals("123.45", JsJson.number(123.45));
		assertEquals("0.0012", JsJson.number(0.0012));
		assertEquals("1e-7", JsJson.number(1e-7));
		assertEquals("0.000001", JsJson.number(1e-6));
		assertEquals("100000000000000000000", JsJson.number(1e20));
		assertEquals("1e+21", JsJson.number(1e21));
		assertEquals("1e+22", JsJson.number(1e22));
		assertEquals("9007199254740992", JsJson.number(9007199254740993.0));
		assertEquals("1.5e+300", JsJson.number(1.5e300));
		assertEquals("0.1", JsJson.number(0.1));
		assertEquals("100", JsJson.number(100.0));
	}

	@Test
	void escapesControlCharactersAsJavaScriptDoes() {
		JsonMapper mapper = JsonMapper.shared();
		// Taken from node: JSON.stringify of these controls keeps them as
		// lowercase U+00XX escapes.
		assertEquals("\"\\u0001\\u000b\\u001f\"",
			JsJson.compact(mapper.readTree("\"\\u0001\\u000b\\u001f\"")));
	}

	@Test
	void compactKeepsInputOrderAndCanonicalSorts() {
		JsonMapper mapper = JsonMapper.shared();
		assertEquals("{\"b\":1,\"a\":[true,null]}",
			JsJson.compact(mapper.readTree("{\"b\":1.0,\"a\":[true,null]}")));
		assertEquals("{\"a\":[true,null],\"b\":1}",
			JsJson.canonical(mapper.readTree("{\"b\":1.0,\"a\":[true,null]}")));
	}
}
