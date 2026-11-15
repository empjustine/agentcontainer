package com.example.sbex.core;

/** Raised when an order id has no row; the HTTP layer maps it to 404. */
public class OrderNotFoundException extends RuntimeException {

	public OrderNotFoundException(long id) {
		super("order " + id + " not found");
	}
}
