package com.example.sbex.lakehouse;

import com.example.sbex.lakehouse.ListenerConfig.ExtraConnectors;
import java.util.Map;
import org.springframework.boot.tomcat.TomcatWebServer;
import org.springframework.boot.web.server.WebServer;
import org.springframework.boot.web.server.servlet.context.ServletWebServerApplicationContext;
import org.springframework.stereotype.Component;

/**
 * Which protocol a port answers. Resolved on every lookup instead of cached at
 * startup because a connector bound to port 0 (the tests') only knows its port
 * after Tomcat has opened it.
 *
 * WHY the port is the routing key at all: the Promnesia client cannot carry a
 * key and the two protocols own disjoint paths, so the port is what keeps a
 * hister path from answering on the Promnesia face.
 */
@Component
class SurfacePorts {

	private final ServletWebServerApplicationContext context;
	private final ExtraConnectors connectors;

	SurfacePorts(ServletWebServerApplicationContext context, ExtraConnectors connectors) {
		this.context = context;
		this.connectors = connectors;
	}

	/** The surface a request arrived on, or null when the port is not ours. */
	Surface of(int localPort) {
		for (Map.Entry<Surface, Integer> entry : boundPorts().entrySet()) {
			if (entry.getValue() == localPort) {
				return entry.getKey();
			}
		}
		return null;
	}

	/** The bound port of a surface, for the startup line and the tests. */
	int port(Surface surface) {
		return boundPorts().get(surface);
	}

	Map<Surface, Integer> boundPorts() {
		WebServer server = context.getWebServer();
		if (server == null) {
			throw new IllegalStateException("the web server is not started yet");
		}
		int hister = server instanceof TomcatWebServer tomcat ? tomcat.getPort() : server.getPort();
		return Map.of(
			Surface.HISTER, hister,
			Surface.PROMNESIA, connectors.promnesia().getLocalPort(),
			Surface.AGENT, connectors.agent().getLocalPort());
	}
}
