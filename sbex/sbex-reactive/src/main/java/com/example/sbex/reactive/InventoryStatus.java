package com.example.sbex.reactive;

/**
 * The downstream's payload, kept apart from anything this app persists. It is
 * also a top-level type of its own: javac's {@code -Xlint:auxiliaryclass} calls
 * a second top-level declaration in another class's file a warning, and this
 * gate compiles with {@code -Xlint:all -Werror}.
 */
record InventoryStatus(String sku, int available) {}
