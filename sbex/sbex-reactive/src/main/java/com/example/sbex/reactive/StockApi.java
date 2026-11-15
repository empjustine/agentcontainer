package com.example.sbex.reactive;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/**
 * A thin proxy onto the inventory service: the endpoint exists so the
 * WebClient's pooling, timeout and error propagation are visible on a real
 * route rather than in a test only.
 */
@RestController
@RequestMapping("/api/stock")
public class StockApi {

	private final DownstreamClient inventory;

	public StockApi(DownstreamClient inventory) {
		this.inventory = inventory;
	}

	@GetMapping("/{sku}")
	public Mono<InventoryStatus> get(@PathVariable String sku) {
		return inventory.status(sku);
	}
}
