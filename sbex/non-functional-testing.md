---
id: sbex-non-functional-testing
type: submodule-design
status: active
title: "sbex non-functional testing: what proves the limits, timeouts and one-line structured logging"
parent: sbex
references: [sbex, sbex-observability, d193]
tags: ["testing", "non-functional", "load", "concurrency", "queues", "logging", "jwt", "fairness"]
---

# Non-functional testing: limits, isolation, timeouts and log shape

This file owns the **test strategy** for sbex's non-functional properties: which mechanism a property needs, what a deterministic test of it looks like, and how the structured-logging contract is proved. It does not own the mechanisms: `resource-isolation.md`, `tenant-fairness.md` and `queue-operations.md` are the designs, and they are **draft and unbuilt** — that split is the first thing this file states, because a test cannot assert a limit that does not exist.

## What is implemented, and what is not

| Property                                            | Mechanism today                                                                                   | Testable now?                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------- |
| HTTP connection ceiling + virtual threads           | `server.tomcat.max-connections/accept-count/connection-timeout`, `spring.threads.virtual.enabled` | Yes (config-bound slice)        |
| MVC async executor                                  | `WebConfig`: core 2, max 8, queue 64                                                              | Yes                             |
| Database pool                                       | Hikari 10 (servlet) / 6 (reactive), 3 s acquire timeout, leak detection                           | Yes                             |
| Rabbit listener concurrency, prefetch, transactions | `concurrency=2..4`, `prefetch=10`, `channelTransacted=true`                                       | Yes (Testcontainers RabbitMQ)   |
| Rabbit topology, dead-letter exchange and DLQ       | quorum queue with `x-dead-letter-exchange`, DLX binding, DLQ                                      | Yes (rabbitmqctl / RabbitAdmin) |
| Publisher confirms, returns, mandatory              | correlated confirms, `publisher-returns`, `mandatory`                                             | Yes (broker + a mock)           |
| Reactive downstream pool, connect/response timeouts | WebClient: 64 connections, 128 pending, 2 s connect, 2 s response                                 | Yes (local HTTP stub)           |
| Graceful shutdown                                   | `server.shutdown=graceful`, 20 s lifecycle timeout                                                | Yes (process-level, optional)   |
| Structured logging (JSONL)                          | `logback-spring.xml` json profile + LogstashEncoder, Containerfile sets the profile               | **Yes — tests added**           |
| Per-subject quotas, JWT identity, fair share        | none (draft)                                                                                      | **No — implement first**        |
| Work classes, admission gate, per-class pools       | none (draft)                                                                                      | **No — implement first**        |
| Per-job queues, delivery limit, breakers            | none (draft)                                                                                      | **No — implement first**        |
| Queue length limits, overflow policy, pause/resume  | none (draft)                                                                                      | **No — implement first**        |
| Queue/DLQ operations console                        | none (draft)                                                                                      | **No — implement first**        |

The remaining sections give the harness for each row, in that order.

The design documents already carry the same verdict in their own `## Status` section — `resource-isolation.md`, `tenant-fairness.md`, `queue-operations.md` and `modulith-events.md` each say "Draft, unbuilt" — and the isolation design's "The example's gaps" lists seven structural ones. What follows is the **concrete form** of that status, found while writing this plan:

- **The outbound wait is still Reactor's 45 s default.** `DownstreamClient` sets `maxConnections`, `pendingAcquireMaxCount`, the connect timeout and a Reactor `timeout`, but not `pendingAcquireTimeout`; the isolation design's 2 s wait is not wired.
- **Overload still reads as a server fault.** A Hikari acquire timeout, a downstream timeout and a rejected MVC task reach the generic 500 path; the 503 + `Retry-After` mapping is design-only.
- **The reactive offload is shared.** `OrderQueries` sends every blocking call to `boundedElastic()`; no per-class scheduler exists.
- **The queue has topology but no limits.** The quorum/DLX/DLQ bindings exist; `x-max-length`/`x-overflow`, an explicit `x-delivery-limit` and retry advice do not, so a poison message relies on the broker default and blocks the one queue behind it.
- **There is no subject to quota.** No security/JWT dependency exists, so the fairness design has no code seam yet.
- **There is no tracing starter.** `traceId`/`spanId` never enter the MDC; the log format is proved with MDC values the test sets, and trace correlation is pending with the observability design.
- **There is no Modulith dependency**; `modulith-events.md` says the same.

## The JWT-subject question is not a thread question

A servlet application with virtual threads does not cap request threads: one subject can open thousands of requests without exhausting platform threads, and a test that counts `Thread` objects proves nothing. What one subject can monopolise is the **scarce resource behind the threads** — Hikari connections, downstream connections, the MVC async executor, CPU — or an explicit **per-subject semaphore**. The acceptance test therefore pins the scarce resource and asserts two things at once:

1. subject A holds at most its cap (permits, in-flight requests, or connections), and
2. subject B is still admitted inside its deadline (the floor), while A's excess is rejected with `429`/`503` — not with a timeout that looks like a server fault.

That test is the failing test until the tenant-fairness design is implemented. Writing it first is useful: it states the invariant, and it fails on the shared pool for the right reason.

## Deterministic harness rules

- **Latches, not sleeps.** A blocking test handler waits on a `CountDownLatch`/`Semaphore`; the test releases it and asserts with `Awaitility` for the eventual condition. Wall-clock sleeps make a gate flaky on a loaded host.
- **Assert invariants, not throughput.** "max concurrent ≤ cap", "the other class completed", "the permit was held until onComplete", "the status is 429 with Retry-After". Throughput numbers belong to the sizing sweep, not a passing test.
- **One assertion per bound.** A test that saturates everything and asserts "the service is up" passes on a shared pool and proves nothing.
- **Fixed clocks for token buckets.** Inject `Clock`; use a mutable test clock. For reactive timeouts use `StepVerifier.withVirtualTime`, not a real 2 s wait.
- **No blocking on an event loop.** For the reactive app, `reactor-test`'s `StepVerifier` plus (optionally) BlockHound in tests; a blocking call inside a `map` is a defect even when the test passes.
- **Containers are opt-in and guarded.** `@Testcontainers(disabledWithoutDocker = true)` as the persistence tests already do; pin images; one static container per class.
- **Keep the load tests out.** A k6/Gatling run against a built jar is a measurement (`pod-sizing.md`), not a unit test; it needs a host with the toolchain and must not join `test.sh`. The deterministic tests above are the gate.

## What each implemented bound needs

| Test (proposed)         | Setup                                                                                    | Assertion                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ConnectionCeilingTest` | `@SpringBootTest(webEnvironment=RANDOM_PORT)` with `max-connections=2`; hold two sockets | The third request waits or is refused at the configured timeout; other traffic does not turn the ceiling into a 500       |
| `AsyncExecutorTest`     | A test endpoint returning `StreamingResponseBody` held by a latch; max 2, queue 1        | Two active streams, one queued, the next rejected; the rejection is 503 once the admission mapping lands                  |
| `DatabasePoolTest`      | Hold every Hikari connection via a test endpoint; fire one more                          | Active count stays at the max; the extra request fails at `connection-timeout`; `hikaricp.connections.pending` is visible |
| `ListenerPrefetchTest`  | Testcontainers RabbitMQ; block the consumer with a latch; publish 50                     | Unacked per consumer ≤ prefetch, consumers ≤ max-concurrency, no message lost                                             |
| `DeadLetterTest`        | Publish a message the listener always rejects; wait for the delivery limit               | The message lands in `.sbex.orders.events.dlq`; the DLX binding is as declared; no infinite requeue                       |
| `PublisherConfirmTest`  | Broker confirms an unroutable mandatory publish (and a mocked nack)                      | The error path is exercised and logged once; a rolled-back transaction publishes nothing                                  |
| `TopologyContractTest`  | Testcontainers RabbitMQ; declare from the application                                    | Queue is quorum, carries the DLX arguments, and the DLQ binding resolves                                                  |
| `OutboundPoolTest`      | A local `HttpServer` stub with latches; 64 held responses, then one more                 | The 65th waits at `pendingAcquireTimeout` (set it; Reactor's default is 45 s) and then fails fast                         |
| `OutboundTimeoutTest`   | A stub that sleeps past 2 s                                                              | The call completes with a timeout error, the connection returns to the pool, and the caller maps it to 504                |
| `GracefulShutdownTest`  | Run the jar, start a slow stream, send SIGTERM                                           | The stream completes within the shutdown phase; new connections are refused                                               |
| `BlockHoundTest`        | Reactive app tests with BlockHound                                                       | No blocking call on a Netty event-loop thread; a deliberate violation fails the test                                      |

These use the existing test stack: JUnit 5, Spring Boot test slices, Testcontainers, `Awaitility`, `SimpleMeterRegistry`, and a JDK `HttpServer` stub (no new HTTP-mock dependency). Testcontainers RabbitMQ is the one added module (`org.testcontainers:testcontainers-rabbitmq`, version from the Boot BOM).

## What the draft designs must build before their tests can pass

- **Tenant fairness**: the validated JWT claims (issuer, subject), the four limits (rate, in-flight, pending depth, fair share), the hierarchy, the admission order, the 429/503 contract, the local/shared enforcement mode, bounded state. Then `FairnessAdmissionTest`, `NoisyNeighbourTest`, `QuotaStateBoundTest`, `ConfigValidationTest`, and the shared servlet/reactive acceptance suite the design's AC-TF table describes. A signed-token fixture (or `spring-security-test`'s JWT post-processor) keeps the test independent of an identity provider; a fixed clock makes the bucket reproducible.
- **Resource isolation**: `WorkClass` + `WorkContext` at every entry point, the admission gate, per-class executor/scheduler/Hikari pools, the boot-time budget check, and the 503 mapping. The design's own test table is the backlog: `PoolBudgetTest`, `AdmissionTest`, `NoisyNeighbourTest`, `AsyncPermitTest`, `DownstreamPoolTest`.
- **Per-job queues and breakers**: split queues and containers, per-type DLX/DLQ, the delivery limit and queue length limit, retry advice, the park/pause policy, replay as an operator action. Then `PoisonJobTest`, `BreakerPauseTest`, `DlqReplayTest`.
- **Queue operations**: the console is a separate service/UI; its AC-QO suite (fixture counts, confirmed replay, purge refusal, bulk bounds, concurrent operators) is an API/UI test suite, not an application test. It needs a broker fixture and a role model before any of it can run.

The tests named in those documents are the acceptance criteria; this file adds only the harness rules and the "which row is testable now" split.

## Structured logging: the contract and its proof

**The chosen shape is JSON Lines**, not logfmt: the `json` profile wires `LogstashEncoder`, the Containerfile sets `SPRING_PROFILES_ACTIVE=json`, and every event is one JSON object on one stdout line. The non-json profile is a readable local pattern and is never the container contract.

What the line contains, and why each field exists:

| Field                                                          | Source                            | Why                                                                                                       |
| -------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@timestamp`, `level`, `logger_name`, `thread_name`, `message` | LogstashEncoder                   | The searchable minimum; no agent parses a pattern in the container                                        |
| MDC keys (`traceId`, `spanId`, subject hash)                   | Logback MDC                       | The join key to the trace and the quota audit; a raw subject never rides here (tenant-fairness NFR-TF-06) |
| `stack_trace`                                                  | LogstashEncoder (throwable)       | The exception stays inside the line; a shipper cannot split it                                            |
| No second line                                                 | escaping of `\n`, `\t` in strings | One event = one line, including a multi-line message or trace                                             |

**Proof added in this tree:** `StructuredLoggingTest` in each application (`sbex-servlet` and `sbex-reactive`) boots a child JVM with the shipped `logback-spring.xml` and the `json` profile, then asserts:

- exactly **one** physical line per event for an INFO event whose message contains a newline, and for a WARN event carrying an exception;
- every line parses as a JSON object with the expected `level`, `logger_name` and `message`;
- the MDC keys ride as top-level fields (`traceId`, `subjectHash`);
- the stack trace is the `stack_trace` string field and no raw `\tat ...` line appears on stdout.

The child JVM is the mechanism, not an accident: Logback is JVM-global, so a test JVM that initialized the human pattern for an earlier class would ignore a profile switch made in-process. The child boots Spring with the shipped config and the profile, which makes the assertion about the real configuration in any run order.

**"Ensure" as a gate, not only a test:** the static-analysis profile's PMD `bestpractices` category already carries `SystemPrintln` and `AvoidPrintStackTrace`, so a new `System.out.print` or `printStackTrace()` fails `./lint.sh`'s Java leg. The tests above prove the encoder; the rule closes the bypass.

Two checks stay deliberately out of the default suite:

- **End-to-end shipment**: run the built jar with the `json` profile and pipe stdout through `jq -e .` per line (plus "no line starts with whitespace"). It is a five-line smoke script for a host that runs the jar; the slice tests already assert the same encoder contract without a boot.
- **Trace correlation**: `traceId`/`spanId` appear only when the OpenTelemetry starter of `observability.md` lands. Today the tests set MDC explicitly to prove the field path; the design's step 10 ("prove it end to end once") is the test to add with that dependency.

**If logfmt were chosen instead**, the same tests apply with a different parser: one `key=value` line per event, values quoted/escaped so a newline cannot split it, and the exception as an escaped field. `logstash-logback-encoder` emits JSON only, so logfmt would need a small custom `Encoder` (or a carefully escaped `PatternLayout`) plus a parser in the test. There is no reason to carry two shapes: the container contract is JSONL, and a second encoder would be a second contract.

## What to add to the build

- `sbex-core` test scope: `org.testcontainers:testcontainers-rabbitmq` (the one added module; `Awaitility` already rides the Boot test starter).
- No HTTP mock library: a JDK `com.sun.net.httpserver.HttpServer` with latches is enough for the downstream stub (and keeps the dependency surface small).
- `reactor-test` is already present through the WebFlux test stack; `blockhound` is optional and test-only.
- When fairness lands: `spring-security-test` plus `spring-security-oauth2-jose` (or a local key pair) for signed-token fixtures.

## Order of work

1. Add the RabbitMQ test module and the topology/listener tests; they prove bounds that already exist.
2. Add the pool/async/downstream tests and fix the gaps they expose (the pending-acquire timeout, the 503 mappings).
3. Implement work classes and the admission gate; the noisy-neighbour test is the one that justifies the design.
4. Implement tenant fairness; run the shared servlet/reactive acceptance suite with a fixed clock and signed-token fixtures.
5. Keep the load/SLO measurements (pod-sizing) outside `test.sh`; they validate shares, not correctness.
