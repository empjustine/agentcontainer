package com.example.sbex.lakehouse;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.List;
import org.apache.catalina.connector.Connector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.tomcat.TomcatWebServerFactory;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The listener topology (sbex/datalakehouse-port.md): one application, three
 * connectors. The hister port is the primary connector — the one
 * `server.tomcat.*` binds — and the other two are additional connectors in the
 * same Tomcat, because a second process would be a second SQLite writer and a
 * second heap.
 *
 * The additional connectors carry their own protocol handler, so their thread
 * ceiling is set here rather than inherited: an unbounded handler on the
 * Promnesia port would be exactly the denial of service the daemon's bounded
 * worker pool existed to prevent.
 */
@Configuration(proxyBeanMethods = false)
class ListenerConfig {

	private static final Logger log = LoggerFactory.getLogger(ListenerConfig.class);

	@Bean
	TomcatServletWebServerFactory tomcatFactory(LakehouseProperties properties, ExtraConnectors extra) {
		Addresses hister = Addresses.parse(properties.histerAddress(), "BROWSE_HISTER_ADDR");
		requireKeyOrLoopback(hister, "BROWSE_HISTER_ADDR", properties.browseToken());
		requireKeyOrLoopback(
			Addresses.parse(properties.promnesiaAddress(), "BROWSE_PROMNESIA_ADDR"),
			"BROWSE_PROMNESIA_ADDR", properties.browseToken());
		requireKeyOrLoopback(
			Addresses.parse(properties.agentAddress(), "AGENT_INGEST_ADDR"),
			"AGENT_INGEST_ADDR", properties.ingestToken());
		TomcatServletWebServerFactory factory = new TomcatServletWebServerFactory(hister.port());
		factory.setAddress(address(hister, "BROWSE_HISTER_ADDR"));
		factory.addAdditionalConnectors(extra.promnesia(), extra.agent());
		return factory;
	}

	/**
	 * A non-loopback bind with no key exposes the write faces to the network, so
	 * it is a startup refusal rather than a warning. The browse faces' reads stay
	 * unauthenticated even with a key — the stock Promnesia client cannot carry
	 * one — which the second line reports once.
	 */
	private static void requireKeyOrLoopback(Addresses address, String property, String token) {
		if (address.isLoopback()) {
			return;
		}
		if (token == null || token.isEmpty()) {
			throw new IllegalStateException(property + " binds a non-loopback address without a token;"
				+ " refusing to expose unauthenticated writes");
		}
		log.warn("warning: {} binds {}; reads stay unauthenticated", property, address.host());
	}

	/**
	 * The two non-primary connectors, kept as beans so their bound ports can be
	 * read after start: a connector bound to port 0 only knows its port once
	 * Tomcat has opened it, and the surface filter routes on that port.
	 */
	@Bean
	ExtraConnectors extraConnectors(LakehouseProperties properties) {
		Addresses promnesia = Addresses.parse(properties.promnesiaAddress(), "BROWSE_PROMNESIA_ADDR");
		Addresses agent = Addresses.parse(properties.agentAddress(), "AGENT_INGEST_ADDR");
		return new ExtraConnectors(
			connector(promnesia, properties.maxWorkers()),
			connector(agent, properties.maxWorkers()));
	}

	private static Connector connector(Addresses address, int maxWorkers) {
		Connector connector = new Connector(TomcatWebServerFactory.DEFAULT_PROTOCOL);
		connector.setPort(address.port());
		connector.setProperty("address", address.host());
		// Bind during start, not construction: a connector must not take a port
		// while the context is still being assembled.
		connector.setProperty("bindOnInit", "false");
		connector.setProperty("maxThreads", String.valueOf(maxWorkers));
		return connector;
	}

	private static InetAddress address(Addresses address, String property) {
		try {
			return InetAddress.getByName(address.host());
		} catch (UnknownHostException exception) {
			throw new IllegalArgumentException(property + "=" + address.host() + ": unknown host", exception);
		}
	}

	/** The additional connectors, in surface order. */
	record ExtraConnectors(Connector promnesia, Connector agent) {

		List<Connector> all() {
			return List.of(promnesia, agent);
		}
	}
}
