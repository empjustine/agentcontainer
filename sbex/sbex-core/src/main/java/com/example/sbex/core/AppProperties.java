package com.example.sbex.core;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * The `sbex.*` surface as one validated record: the JVM reads a typed value,
 * and a missing or nonsensical setting fails the boot with the property name
 * instead of surfacing on the first request that touches it.
 *
 * @param archiveBatchSize rows one archive CALL may move — bounds the
 * transaction's size, which is what bounds its lock footprint and duration
 * @param eventsExchange topic exchange the order events publish to
 */
@ConfigurationProperties(prefix = "sbex")
@Validated
public record AppProperties(@Min(1) int archiveBatchSize, @NotBlank String eventsExchange) {}
