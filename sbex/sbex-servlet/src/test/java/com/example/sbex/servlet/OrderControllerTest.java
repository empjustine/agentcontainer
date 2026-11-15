package com.example.sbex.servlet;

import static org.hamcrest.Matchers.hasSize;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.example.sbex.core.Order;
import com.example.sbex.core.OrderNotFoundException;
import com.example.sbex.core.OrderStatus;
import com.example.sbex.core.db.OrderService;
import java.math.BigDecimal;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * A slice test: only MVC beans load, the service is a mock, and the
 * datasource, broker and migrations stay out of the test. That is what keeps
 * a controller test fast enough to run on every change — the integration
 * story lives in sbex-core's contract tests instead (sbex/README.md).
 */
@WebMvcTest(OrderController.class)
class OrderControllerTest {

	@Autowired
	private MockMvc mvc;

	@MockitoBean
	private OrderService orders;

	@Test
	void placeReturnsCreatedWithLocation() throws Exception {
		Order created = new Order(7L, "alice", new BigDecimal("10.00"), OrderStatus.NEW, Instant.now());
		when(orders.placeOrder("alice", new BigDecimal("10.00"))).thenReturn(created);

		mvc.perform(
				post("/api/orders")
					.contentType(MediaType.APPLICATION_JSON)
					.content("""
						{"customerId":"alice","total":10.00}
						"""))
			.andExpect(status().isCreated())
			.andExpect(header().string("Location", "/api/orders/7"))
			.andExpect(jsonPath("$.id").value(7));
	}

	@Test
	void invalidBodyIsAProblemDocumentWithFieldErrors() throws Exception {
		mvc.perform(
				post("/api/orders")
					.contentType(MediaType.APPLICATION_JSON)
					.content("""
						{"customerId":"","total":-1}
						"""))
			.andExpect(status().isBadRequest())
			.andExpect(jsonPath("$.fieldErrors[?(@.field == 'customerId')]").value(hasSize(1)));
	}

	@Test
	void unknownOrderIsA404ProblemDocument() throws Exception {
		when(orders.get(404L)).thenThrow(new OrderNotFoundException(404L));

		mvc.perform(get("/api/orders/404"))
			.andExpect(status().isNotFound())
			.andExpect(jsonPath("$.detail").value("order 404 not found"));
	}
}
