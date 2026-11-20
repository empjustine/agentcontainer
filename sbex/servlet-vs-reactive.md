---
id: sbex-servlet-vs-reactive
type: submodule-design
status: active
title: "sbex web stacks: the blocking and non-blocking paths done well"
parent: sbex
tags: ["webflux", "tomcat", "netty", "virtual-threads"]
---

# Web stacks: the blocking and non-blocking paths done well

This file owns the choice between `sbex-servlet` and `sbex-reactive`, and what optimising each one actually means. Both applications serve the same resources from the same core, so everything a reader compares is the stack's behaviour rather than the business logic's. It does not restate the APIs — `README.md` maps them — nor the memory flags both stacks share, which live in `memory.md`.

## The choice

- **Blocking on servlet, with virtual threads**, for a request/response service whose work is a database round trip: the code reads top to bottom, exceptions propagate normally, and the capacity limit is one number — the connection pool.
- **Reactive on Netty**, when the work is many slow independent waits — downstream HTTP calls, long-lived streams — and one platform thread per waiting request would cost more than the container has. The payoff is cheap concurrency; the price is that every call in the chain must stay non-blocking.
- The wrong reason to pick either is fashion, and the wrong reason to pick reactive is throughput on a database-bound service: both stacks spend the same time waiting for the same database, and the reactive one pays for that flexibility in indirection.

## The blocking path, done well

- **Virtual threads on** (`spring.threads.virtual.enabled=true`). Each request's stack becomes heap-allocated, so Tomcat's `threads.max` stops being the concurrency cap — hundreds of requests blocked on the database no longer cost hundreds of megabytes of platform stacks.
- **The bounds that remain are stated.** `server.tomcat.max-connections` and `accept-count` bound what the connector accepts; the Hikari pool bounds what the database will serve; `WebConfig`'s bounded executor bounds streaming requests. Virtual threads remove the thread-count limit, not the need for limits.
- **Large responses stream.** `ReportController` writes rows through `StreamingResponseBody` as the cursor yields them — a report's heap cost is one row, not the result set. The stream bounds the write side only; the read side is bounded by the cursor and its fetch size (`persistence.md`), and a `queryForList` behind a streamed write has already materialised the report.
- **Shutdown drains.** `server.shutdown=graceful` with a lifecycle timeout lets in-flight requests finish when the container stops; a cut connection mid-transaction is what graceful drain exists to avoid.

The one rule for this stack: blocking is allowed everywhere, because the thread blocking is disposable — but the pools are the capacity, so they are sized first.

**What the stack cannot do is backpressure.** The connector admits requests up to `max-connections` and `accept-count` whatever the database can serve, so a burst of large responses grows queued-plus-active work and the failure lands as a garbage-collection storm shared by every request. The only brake in blocking mode is the client's socket: a writer thread waits on a slow reader after the bytes exist. [sbex-resource-isolation](resource-isolation.md) owns the answer — bounded concurrency per work class and an early `503` — because that is admission policy, not a stack setting.

## The reactive path, done well

- **The event loop never blocks.** A blocking JDBC call on a Netty event-loop thread fails loudly (`Blocking operations are not allowed`) when it can, and silently starves every other connection when a driver tolerates it. The rule is absolute: no JDBC, no `Thread.sleep`, no synchronous file or network IO on the event loop.
- **The offload pattern, in one shape.** `OrderQueries` wraps each blocking call as `Mono.fromCallable(...).subscribeOn(Schedulers.boundedElastic())`. Because the callable runs on one scheduler thread from first statement to last commit, the thread-bound transaction manager works exactly as it does on the servlet stack — a transaction that hops threads cannot exist, and this is the whole reason the `subscribeOn` sits outside the callable rather than around individual queries.
- **The offload pool is bounded too.** `Schedulers.boundedElastic()` caps its threads and its pending queue; `reactor.schedulers.defaultBoundedElasticSize` and `reactor.schedulers.defaultBoundedElasticQueueSize` (both `-D` properties) set the caps explicitly instead of leaving them to a CPU-count multiple the container's CPU quota may not match. Reactor 3.8 also takes `reactor.schedulers.defaultBoundedElasticOnVirtualThreads`, which moves the pooled work onto virtual threads — the same trade as the servlet stack's, and one to measure rather than assume.
- **The client's pool is bounded at construction.** `DownstreamClient` starts from Boot's auto-configured `WebClient.Builder` — the one carrying the observation registry, so the outbound call is a child span (`observability.md`) — and narrows it with a `ConnectionProvider` that has a `maxConnections`, a `pendingAcquireMaxCount`, idle and life times and a connect timeout: a slow downstream then fails the acquire instead of queueing unbounded demand into memory. A `timeout` on the response turns slowness into a `TimeoutException` — an error signal, never a null, which is why the advice in `ApiAdvice` can map it to 504.
- **Backpressure is the flow's own contract.** A `Flux` downstream of a bounded source carries demand: the streaming endpoints emit as fast as the consumer asks. The place backpressure stops on its own is the offload queue between a blocking source and the reactive chain — that queue is what `reactor.schedulers.defaultBoundedElasticQueueSize` bounds.

**Transactions and R2DBC.** The shared `OrderService` is JdbcTemplate plus `DataSourceTransactionManager`, driven through the offload. A fully reactive persistence stack instead uses R2DBC with its own reactive transaction manager and `@Transactional` on `Mono`-returning methods — a different persistence API, not a setting. This example keeps one persistence layer on purpose: the question the user usually arrives with is how to run existing JDBC code under WebFlux, and the answer is the offload shape above.

## Identical everywhere else

Validation, status codes, RFC 9457 problem documents, the typed configuration and the actuator surface are the same in both applications — the two `@RestControllerAdvice` classes differ only in which exceptions can arrive. `OrderApiTest` mirrors `OrderControllerTest` assertion for assertion: the stacks differ in scheduling, not in contract.

## References

- [Spring Boot reference — Spring MVC](https://docs.spring.io/spring-boot/4.1/reference/web/servlet.html) and [Spring WebFlux](https://docs.spring.io/spring-boot/4.1/reference/web/reactive.html)
- [Spring Boot reference — graceful shutdown](https://docs.spring.io/spring-boot/4.1/reference/web/graceful-shutdown.html)
- [Spring Framework — WebFlux](https://docs.spring.io/spring-framework/reference/7.0/web/webflux/)
- [R2DBC](https://r2dbc.io/) (the reactive persistence contract, not used here)
