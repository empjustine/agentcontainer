package com.example.sbex.core;

/**
 * Order lifecycle. The names are the stored strings — both migrations carry the
 * same CHECK constraint, so a typo fails at the database, not in production.
 */
public enum OrderStatus {
	NEW,
	COMPLETED,
	CANCELLED,
	ARCHIVED
}
