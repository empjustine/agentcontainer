package com.example.sbex.reactive;

import static org.hamcrest.Matchers.hasSize;
import static org.mockito.Mockito.when;

import com.example.sbex.core.Order;
import com.example.sbex.core.OrderStatus;
import java.math.BigDecimal;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.reactive.WebFluxTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.reactive.server.WebTestClient;
import reactor.core.publisher.Mono;

/**
 * The reactive slice test: same assertions as the servlet one, expressed
 * through WebTestClient. Validation, status codes and problem documents are
 * identical across the two stacks — this test exists to show that they are
 * (sbex/servlet-vs-reactive.md).
 */
@WebFluxTest(OrderApi.class)
class OrderApiTest {

	@Autowired
	private WebTestClient client;

	@MockitoBean
	private OrderQueries queries;

	@Test
	void placeReturnsCreatedWithLocation() {
		Order created = new Order(7L, "alice", new BigDecimal("10.00"), OrderStatus.NEW, Instant.now());
		when(queries.place("alice", new BigDecimal("10.00"))).thenReturn(Mono.just(created));

		client.post()
			.uri("/api/orders")
			.contentType(MediaType.APPLICATION_JSON)
			.bodyValue("""
				{"customerId":"alice","total":10.00}
				""")
			.exchange()
			.expectStatus().isCreated()
			.expectHeader().location("/api/orders/7")
			.expectBody().jsonPath("$.id").isEqualTo(7);
	}

	@Test
	void invalidBodyIsAProblemDocumentWithFieldErrors() {
		client.post()
			.uri("/api/orders")
			.contentType(MediaType.APPLICATION_JSON)
			.bodyValue("""
				{"customerId":"","total":-1}
				""")
			.exchange()
			.expectStatus().isBadRequest()
			.expectBody()
			// The field order follows the binding, not the record: assert the
			// customer error exists rather than its position.
			.jsonPath("$.fieldErrors[?(@.field == 'customerId')]").value(hasSize(1));
	}
}
