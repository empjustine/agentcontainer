package com.example.sbex.core;

import java.io.Serial;

/**
 * Raised when an operation is legal SQL but illegal for the order's current
 * state. A CHECK constraint cannot express this rule, so it lives in the
 * service — and it is checked, which is why OrderService.cancel declares
 * rollbackFor: checked exceptions do not roll back by default.
 */
public class OrderStateException extends RuntimeException {

	@Serial private static final long serialVersionUID = 1L;

	public OrderStateException(String message) {
		super(message);
	}
}
