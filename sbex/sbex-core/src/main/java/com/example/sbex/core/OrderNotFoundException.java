package com.example.sbex.core;

import java.io.Serial;

/** Raised when an order id has no row; the HTTP layer maps it to 404. */
public class OrderNotFoundException extends RuntimeException {

	@Serial private static final long serialVersionUID = 1L;

	public OrderNotFoundException(long id) {
		super("order " + id + " not found");
	}
}
