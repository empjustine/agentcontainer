package com.example.sbex.lakehouse;

/**
 * A host:port pair as the daemon's environment variables spell it. Parsing
 * here, not in a framework setter, is what lets a bad value fail the boot with
 * the variable's name in the message.
 *
 * @param host the bind host; a bracketed IPv6 literal keeps its brackets
 * @param port the bind port
 */
record Addresses(String host, int port) {

	private static final java.util.Set<String> LOOPBACK_HOSTS =
		java.util.Set.of("127.0.0.1", "::1", "localhost", "[::1]");

	static Addresses parse(String address, String property) {
		int separator = address.lastIndexOf(':');
		if (separator <= 0) {
			throw new IllegalArgumentException(property + "=" + address + " (want host:port): no port");
		}
		String host = address.substring(0, separator).trim();
		String port = address.substring(separator + 1).trim();
		try {
			int value = Integer.parseInt(port);
			if (value < 0 || value > 65_535) {
				throw new IllegalArgumentException(property + "=" + address + " (want host:port): port outside 0-65535");
			}
			return new Addresses(host, value);
		} catch (NumberFormatException exception) {
			throw new IllegalArgumentException(property + "=" + address + " (want host:port): bad port", exception);
		}
	}

	/**
	 * Loopback is where the daemon assumes any local process can already reach
	 * the route, so a missing key is tolerable there and nowhere else
	 * (browse-daemon.py's check_bind, the agent route's fail-closed rule).
	 */
	boolean isLoopback() {
		return LOOPBACK_HOSTS.contains(host);
	}
}
