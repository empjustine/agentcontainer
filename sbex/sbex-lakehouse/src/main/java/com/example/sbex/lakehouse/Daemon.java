package com.example.sbex.lakehouse;

/**
 * The version every ack, /status and /api/config reports. One constant because
 * the producer's retry logic treats a versioned ack as durable, and a second
 * spelling would let the two faces disagree about which build answered.
 */
final class Daemon {

	static final String VERSION = "0.1.0";

	/**
	 * The `rule` row that carries the alias map. The reference schema has no
	 * column for it and its daemon skips unknown names, so an import stores it
	 * as one row in the shared table and both sides keep working.
	 */
	static final String ALIAS_RULE = "aliases";

	private Daemon() {
	}
}
