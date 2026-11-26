package com.example.sbex.reactive;

import io.netty.channel.ChannelOption;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.netty.http.client.HttpClient;
import reactor.netty.resources.ConnectionProvider;
import reactor.core.publisher.Mono;

/**
 * The one outbound HTTP client, with its connection pool bounded at
 * construction. WebClient is not a configuration file: the pool defaults
 * (500 connections, a wide pending queue) are sized for a shared event loop,
 * and a container needs the client to fail fast when the downstream is slow
 * instead of queueing until memory runs out (sbex/servlet-vs-reactive.md).
 */
@Component
public class DownstreamClient {

	private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(2);
	private static final Duration RESPONSE_TIMEOUT = Duration.ofSeconds(2);

	private final WebClient client;

	/**
	 * Boot's auto-configured WebClient.Builder, cloned and narrowed: it carries
	 * the observation registry, which is what makes the outbound call a child
	 * span and what injects the trace context into the request. A WebClient
	 * built from the static WebClient.builder() loses both, silently, and no
	 * client-side instrumentation appears to say so (sbex/observability.md).
	 *
	 * @param builder the prototype builder Boot wires
	 * @param baseUrl the downstream this application proxies
	 */
	public DownstreamClient(WebClient.Builder builder, @Value("${sbex.inventory-url}") String baseUrl) {
		ConnectionProvider pool =
			ConnectionProvider.builder("inventory")
				.maxConnections(64)
				.pendingAcquireMaxCount(128)
				.maxIdleTime(Duration.ofSeconds(30))
				.maxLifeTime(Duration.ofMinutes(5))
				.build();
		// The connect timeout is a channel option on the client, not a pool
		// setting: the pool bounds how many connections exist, this bounds how
		// long establishing one may take.
		HttpClient http =
			HttpClient.create(pool)
				.option(ChannelOption.CONNECT_TIMEOUT_MILLIS, (int) CONNECT_TIMEOUT.toMillis());
		this.client =
			builder
				.clone()
				.baseUrl(baseUrl)
				.clientConnector(new ReactorClientHttpConnector(http))
				.build();
	}

	/**
	 * @param sku stock keeping unit to look up
	 * @return the downstream answer, or an error the caller maps: a slow
	 * downstream surfaces as TimeoutException, a refusal as
	 * WebClientResponseException — both are onError signals, never nulls
	 */
	public Mono<InventoryStatus> status(String sku) {
		return client
			.get()
			.uri("/stock/{sku}", sku)
			.retrieve()
			.bodyToMono(InventoryStatus.class)
			.timeout(RESPONSE_TIMEOUT);
	}
}
