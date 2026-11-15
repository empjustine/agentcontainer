---
id: sbex-observability
type: submodule-design
status: active
title: "sbex observability: end-to-end traces, correlated logs and OpenTelemetry practice"
parent: sbex
references: [d193]
tags: ["opentelemetry", "tracing", "logging", "micrometer", "otlp"]
---

# Observability: end-to-end traces, correlated logs and OpenTelemetry practice

This file designs the telemetry path for the sbex applications: one trace that crosses HTTP, the database and the broker, with every log line carrying the same identifier, produced through Spring Boot's supported route (Micrometer Tracing over the OpenTelemetry SDK) and exported over OTLP. It does not cover metric semantics beyond what the actuator exposes (`README.md` owns that) or vendor setup — the backend is chosen after the pipeline exists. The reader is wiring tracing and logging into a Boot service and wants the application to match OpenTelemetry's own guidance, not just to emit spans.

## One pipeline, Boot's supported path

One dependency, version-managed by the Boot BOM:

- `org.springframework.boot:spring-boot-starter-opentelemetry` — Boot's OpenTelemetry starter: the Micrometer Tracing bridge over the OTel SDK, the OTLP exporter and the OTLP metrics registry behind one auto-configuration. Assembling `micrometer-tracing-bridge-otel` and `opentelemetry-exporter-otlp` by hand is the pre-starter route, and it leaves the observation and propagation wiring to the caller (`docs/d193`).

Then the properties, each verified against Boot's configuration metadata:

| Property                                                | Role                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `management.tracing.sampling.probability`               | head sampling — **the default is 0.1**, so a demo trace is one in ten until it is raised                                                                                                                                                             |
| `management.opentelemetry.tracing.sampler`              | which sampler decides (`always-on`, `always-off`, `trace-id-ratio`, `parent-based-always-on`, `parent-based-always-off`); the default is parent-based with a ratio leaf, so a decision that travels with the context is a setting, not an assumption |
| `management.tracing.propagation.type`                   | which context formats are produced and consumed; W3C Trace Context is the interoperable choice and worth pinning explicitly                                                                                                                          |
| `management.tracing.baggage.*`                          | which baggage fields are allowed in, correlated into logs, or promoted to span tags                                                                                                                                                                  |
| `management.opentelemetry.tracing.export.otlp.endpoint` | the collector's endpoint for spans                                                                                                                                                                                                                   |
| `management.opentelemetry.logging.export.otlp.endpoint` | the same destination for log records, behind `management.logging.export.otlp.enabled`                                                                                                                                                                |
| `management.otlp.metrics.export.url`                    | the same destination for metrics — Micrometer's own OTLP registry keeps its property name                                                                                                                                                            |
| `management.opentelemetry.resource-attributes.*`        | the resource block attached to every signal; merged with `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME`, and the property wins                                                                                                                   |

The application never speaks to a backend: it exports to an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/), which batches, routes, adds resource context and (for tail decisions) samples. Swapping the vendor behind the collector then costs no code change.

## Propagation across every hop

- **HTTP in and out** is instrumented by the observation API Boot wires by default — server and client spans form one trace without a line of instrumentation code, provided the client comes from Boot's auto-configured `WebClient.Builder`/`RestClient.Builder`. A client built from the static factory carries no observation registry and starts an orphan trace with nothing to say so, which is why `DownstreamClient` takes the builder (`servlet-vs-reactive.md`).
- **The broker hop** is the one that usually breaks: Spring AMQP's Micrometer observation injects the context into published message headers and extracts it on delivery, so the listener continues the producer's trace instead of starting an orphan ([Spring AMQP's observation page](https://docs.spring.io/spring-amqp/reference/amqp/receiving-messages/micrometer-observation.html)).
- **Baggage** (the allowed `management.tracing.baggage.*` fields) is the channel for request-scoped values that must reach logs or downstream services; it is opt-in field by field because every field is network overhead and a potential leak.

The join key is the `traceId`: it appears in every span and, as the next section makes it, in every log line.

## Spans follow the boundaries, not the code

- **Instrument at boundaries** — HTTP, database, messaging — where the frameworks already observe. A service class stays free of `Span.current()` calls; the sbex controllers and services are unchanged because the instrumentation wraps them.
- **Names are low-cardinality**: the route pattern (`/api/orders/{id}`), never the raw URL with its ids — an unbounded span name is an unbounded metrics cardinality bill.
- **Errors are span status plus an exception event**, not a free-text message: `ERROR` status is what backends and tail samplers filter on.
- **Attributes follow the [semantic conventions](https://opentelemetry.io/docs/concepts/semantic-conventions/)** — the versioned vocabulary for `http`, `db`, `messaging` — so a backend can group what it receives. Two rules follow from the conventions themselves: database statements are recorded without bound values (PII and cardinality), and identifiers that identify one request (order id, customer id) belong in events or baggage, never in the name.
- The authority for all of this is the [OpenTelemetry specification](https://opentelemetry.io/docs/specs/otel/) and the convention catalogue, not any vendor's blog.

## Sampling and export

- **Head sampling** is the probability above: parent-based, so the decision travels with the context and downstream services honour it. The 0.1 default is right for busy production traffic and wrong for a demo or an SLO investigation — raise it deliberately rather than discovering the gap mid-incident.
- **Tail sampling** lives in the collector: keep errors, keep slow traces, sample the routine ones — decisions that need the whole trace and therefore cannot be made at the first span.
- **Export is batched and asynchronous** with a bounded queue: telemetry must never block a request path, and on a memory-constrained pod the queue bound is part of the footprint budget.
- **Resource attributes** (`service.name` from `spring.application.name`, environment, instance) are attached to every signal, through `management.opentelemetry.resource-attributes` or the `OTEL_*` environment surface — a trace without them is a span with nowhere to group.

## Logs join the trace

Two levels, and a deployment picks one:

1. **Correlation by identifier** — the default for sbex: the `json` profile writes one JSON object per line, the MDC carries `traceId` and `spanId`, and a log line therefore contains the key that joins it to its span. `logging.pattern.correlation` is the property for pattern layouts; the Logstash encoder picks the MDC up on its own.
2. **Logs as the third signal** — Boot exports log records over OTLP (`management.opentelemetry.logging.export.otlp.*`, enabled by default), so the collector receives traces, metrics and logs on one pipeline and correlates them server-side.

The same rule binds logs and span attributes: no secrets, no PII — the convention that keeps a log line safe is the convention that keeps an attribute safe.

## The practice checklist

1. Use the Boot-managed bridge and exporter; hand-rolled SDK wiring is where drift starts.
2. Pin W3C propagation so every service speaks the same context format.
3. Attach resource attributes to all three signals before anything else (`management.opentelemetry.resource-attributes`).
4. Name spans from route patterns and set status from outcomes.
5. Take attributes from the semantic conventions; statements without values; ids out of names.
6. Decide sampling on purpose — remember the 0.1 default.
7. Export through a collector, batched, with bounded queues.
8. Keep instrumentation at the boundaries; keep business code clean.
9. Correlate logs by `traceId` — identifier first, OTLP export second.
10. Prove it end to end once: send one request, find its span, its database child span, the broker continuation, and the log lines that share its `traceId`.

## References

- [OpenTelemetry — traces](https://opentelemetry.io/docs/concepts/signals/traces/), [sampling](https://opentelemetry.io/docs/concepts/sampling/) and [context propagation](https://opentelemetry.io/docs/concepts/context-propagation/)
- [OpenTelemetry — Java](https://opentelemetry.io/docs/languages/java/) and the [specification](https://opentelemetry.io/docs/specs/otel/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) (the `traceparent` header)
- [Spring Boot reference — observability](https://docs.spring.io/spring-boot/4.1/reference/actuator/observability.html)
- [Spring AMQP — Micrometer observation](https://docs.spring.io/spring-amqp/reference/amqp/receiving-messages/micrometer-observation.html)
