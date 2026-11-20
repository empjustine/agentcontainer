---
id: sbex-resource-isolation
type: submodule-design
status: draft
title: "sbex resource isolation: priority classes, hard and soft pools, and per-job circuit breaking"
parent: sbex
references:
  [
    sbex,
    sbex-messaging,
    sbex-persistence,
    sbex-memory,
    sbex-observability,
    sbex-pod-sizing,
    sbex-servlet-vs-reactive,
    d193,
  ]
tags:
  [
    "priority",
    "backpressure",
    "bulkhead",
    "circuit-breaker",
    "dead-letter",
    "rabbitmq",
    "hikari",
    "reactor-netty",
  ]
---

# Resource isolation: priority classes, pools and per-job circuit breaking

This file is the design for keeping one class of work from consuming the service's threads, connections, queue consumers and downstream connections. It covers priority classes, hard and soft pools across the database, HTTP and AMQP, and the per-job-type circuit breaker and dead-letter topology for a mixed queue. It does not cover authentication, capacity measurement or broker installation: the route table and the authenticated principal supply the class, `pod-sizing.md` measures the shares, and the RabbitMQ documentation owns the broker. The reader is an engineer adding a background job, a report endpoint or a second traffic class to sbex, or diagnosing a service where one class starved the rest.

## Status

Draft, unbuilt. No code in sbex implements this design. The sections name the changes, the configuration surface and the tests that prove each bound. The numbers are starting points for the sweep in `pod-sizing.md`, not measurements.

## The example's gaps

The existing tree has seven gaps this design closes:

- **The task executor is either absent or shared.** `WebConfig` registers a `ThreadPoolTaskExecutor`, which is an `Executor`; Boot's `applicationTaskExecutor` backs off, so an `@Async` method has no deliberately sized executor and may share the MVC async pool (2/8/64) or fall back to an unbounded `SimpleAsyncTaskExecutor` ([Spring Boot task execution](https://docs.spring.io/spring-boot/4.1/reference/features/task-execution-and-scheduling.html)). The reactive application has no custom `Executor`, so Boot auto-configures a `ThreadPoolTaskExecutor` with an unbounded queue; eight core threads service the backlog and `max-size` never grows. `spring.task.execution.mode=force` plus an explicit limit, or a named `AsyncConfigurer` executor, is what makes the bound visible.
- **The MVC async pool is shared.** `WebConfig` gives every streaming report the same 2/8/64 platform pool. A slow client holds one of eight threads; a burst fills the 64-slot queue, and `TaskRejectedException` reaches the generic 500 path.
- **The reactive offload is global.** `OrderQueries` sends every blocking call to the shared `Schedulers.boundedElastic()`. A background query waiting on a row lock occupies a scheduler thread that an interactive read also needs.
- **The database pool is one pool.** Each application has one Hikari pool (10 connections on the servlet app, 6 on the reactive app). Archive, reconcile and report work share it with order placement and reads.
- **The listener has no rejection policy.** The one container uses `prefetch=10`, `concurrency=2` to `4`, the default `defaultRequeueRejected=true`, and no retry advice. A database failure requeues the delivery and occupies a consumer until the quorum queue's delivery limit (20 by default since RabbitMQ 4.0) dead-letters it. The dead-letter exchange exists, but nothing chooses between retry, dead-letter and pause.
- **Overload reads as a server fault.** `ApiExceptionHandler` and `ApiAdvice` map every `DataAccessException` and `TransactionException` to 500. A Hikari pool timeout, a real SQL error and a rejected async task are indistinguishable to the caller, so a client cannot retry a shed request.
- **Shutdown drains HTTP, not async work.** `server.shutdown=graceful` drains in-flight requests, but `spring.task.execution.shutdown.await-termination` is unset. The executor can be cut with tasks still queued.

## The failure this design prevents

One work class consumes a resource that every class shares. The resource can be a request thread, a database connection, a broker consumer, an outbound HTTP connection, or the heap a queue occupies. The failure has three shapes:

- **Monopoly.** A batch job takes every database connection, and an interactive read waits behind it.
- **Head-of-line blocking.** A poison message at the front of a mixed queue occupies the consumer, and the fast messages behind it wait.
- **Retry storm.** A failing dependency turns one delivery into a loop that consumes the consumer's whole time budget.

The design uses three controls, in this order: a **class** that names the work, a **bound** that caps what the class can take, and a **breaker** that stops a failing class from consuming its bound.

## The priority model

### Classify work at the entry point

A `WorkClass` is fixed at the point where work enters the process: the HTTP route, the queue the message arrived on, or the scheduler that started the job. It is not read from a request body and not inferred inside the service.

| Class         | Traffic                     | Message priority | Database share | Admission permits | Maximum wait |
| ------------- | --------------------------- | ---------------- | -------------- | ----------------- | ------------ |
| `CRITICAL`    | Place or cancel an order    | 9                | 2              | 4                 | 0 ms         |
| `INTERACTIVE` | Get, list or score an order | 6                | 4              | 8                 | 100 ms       |
| `BACKGROUND`  | Report export, order event  | 3                | 3              | 6                 | 1 s          |
| `BATCH`       | Archive, reconcile, cleanup | 0                | 1              | 2                 | 5 s          |

The database shares sum to the servlet application's existing 10-connection pool; the reactive application scales the same proportions to its 6. The admission permits are roughly twice the database share: a short queue absorbs a burst, and the wait is the longest a request may sit before the handler returns 503. The numbers are a budget, not a tuning: a class that is often capped while a lower class is idle needs a new share, not a larger global pool.

A single class can be routed from the route table at first:

- `POST /api/orders` and `POST /api/orders/{id}/cancel` are `CRITICAL`.
- `GET /api/orders/**` is `INTERACTIVE`.
- `GET /api/reports/**` and the `OrderPlaced` consumer are `BACKGROUND`.
- `POST /api/orders/archive` and `POST /api/orders/reconcile` are `BATCH`.

A production service derives the class from the authenticated principal or a tenant claim after authentication. A gateway can add a signed class header over mTLS or an HMAC; a public client cannot.

The shared module owns the class and the context:

```java
public enum WorkClass {
    CRITICAL(9), INTERACTIVE(6), BACKGROUND(3), BATCH(0);

    private final int messagePriority;

    WorkClass(int messagePriority) { this.messagePriority = messagePriority; }
    public int messagePriority() { return messagePriority; }
}

public final class WorkContext {
    private static final ThreadLocal<WorkClass> CURRENT = new ThreadLocal<>();

    public static void set(WorkClass workClass) { CURRENT.set(workClass); }
    public static WorkClass current() { return CURRENT.get(); }
    public static void clear() { CURRENT.remove(); }
}
```

A `ThreadLocal` is correct for the servlet stack and for the blocking core while it runs on one thread. It is wrong for a reactive chain that hops event-loop threads; the reactive stack carries the class in the Reactor Context and sets the `ThreadLocal` only inside the blocking callable that runs on the bounded scheduler.

Every async boundary must copy the class explicitly. A `TaskDecorator` around the executors is the one place:

```java
static TaskDecorator copyWorkClass() {
    return task -> {
        WorkClass captured = WorkContext.current();
        return () -> {
            WorkClass previous = WorkContext.current();
            WorkContext.set(captured);
            try {
                task.run();
            } finally {
                if (previous == null) {
                    WorkContext.clear();
                } else {
                    WorkContext.set(previous);
                }
            }
        };
    };
}
```

The same decorator must also copy the MDC map, so a job's log lines keep their trace and job fields. Boot 4.1's `spring.task.execution.propagate-context` carries the framework's observation context, not this `ThreadLocal`; the decorator remains the place that carries the class. `observability.md` owns the trace fields; this design adds only `workClass` and `jobType` as bounded tags.

### Priority is reserved capacity, not a header

A priority is a claim on capacity. A high-priority request that shares a pool with low-priority work still waits behind it, so the claim is only real when it is a **reserved share**:

- **Hard share:** the class has its own bounded resource, such as a Hikari pool, a listener container, an executor or a `ConnectionProvider`. The class cannot take another class's share.
- **Soft share:** the class has a permit cap in front of a shared resource. The cap prevents one class from taking the whole resource, but a class can still wait behind another class inside the shared pool. The soft share is cheaper and weaker.

The design uses hard shares for the resources that are scarce and slow to release (database connections, queue consumers, outbound connections) and soft shares for the ones that are already bounded by the container (incoming connections, in-process queue slots).

A client-supplied priority header is not an authority. A public caller can claim `CRITICAL`; the class comes from the route table, the authenticated principal, or a gateway signature. The example has no authentication, so the route table is the placeholder and the production note is explicit.

### What priority is not

Four mechanisms look like priority and are not:

- **Thread priority.** `Thread.setPriority` is a scheduling hint that the JVM and OS can ignore; virtual threads are scheduled by the JDK's carrier pool, not by a priority queue.
- **HTTP/2 priority.** The HTTP/2 priority signal schedules response streams on one connection; it does not schedule the server-side work that produces them.
- **RabbitMQ consumer priority.** The `x-priority` consumer argument chooses which consumer receives deliveries when several are active. It does not make one job type faster than another ([RabbitMQ consumer priorities](https://www.rabbitmq.com/docs/consumer-priority)).
- **Bean order.** `@Order` and `@Priority` order advice and components; they do not order requests.

### Give every class a floor

Strict priority starves the low classes. A batch job that never runs grows a backlog, and the backlog then floods the system when the high-priority traffic pauses. Every class gets a floor:

- The database shares in the table above are floors as well as caps: `BATCH` always has one connection.
- A separate queue with its own consumer is a stronger floor than a message priority, because the consumer is not competing for the same delivery slot.
- RabbitMQ 4.0 through 4.2 quorum queues implement a two-bucket priority mix at a 2:1 high-to-normal ratio for exactly this reason; RabbitMQ 4.3 adds strict 32-level priorities, and a strict priority queue can starve a low level ([RabbitMQ priorities](https://www.rabbitmq.com/docs/priority)).
- A low-priority job has a maximum age. A job older than the age is rejected or parked, not started late; a stale report is not worth the capacity it consumes.

### Set the message priority

A message's priority is a property on the publish, not a queue argument. The publisher sets it from the same table:

```java
rabbit.convertAndSend(exchange, routingKey, event, message -> {
    message.getMessageProperties().setPriority(workClass.messagePriority());
    return message;
});
```

A quorum queue honors the full 0-31 range strictly in RabbitMQ 4.3 and above. RabbitMQ 4.0 through 4.2 map the value to two buckets (0-4 normal, above 4 high) at a 2:1 ratio, so only two of the four classes survive; split the queue for the classes that need separation. A classic queue needs `x-max-priority` (1-255, with 2-4 recommended) and keeps a sub-queue per level; the sample's quorum queue ignores the argument ([RabbitMQ priorities](https://www.rabbitmq.com/docs/priority)). The four values in the table fit a quorum queue; a classic queue with the recommended two to four levels collapses the classes. A priority orders only ready messages: a consumer with a large prefetch holds a batch of low-priority messages before the high-priority one is eligible, which is why a priority queue runs with a small prefetch.

### Deadlines turn priority into a bound

A queued request that has already missed its deadline must be rejected before it starts. A priority queue without a deadline starts work that the caller has abandoned, which is worse than shedding it.

- **HTTP:** the gateway or the filter carries a deadline; the admission gate checks it before acquiring a permit and after the wait.
- **Jobs:** every job carries `createdAt` and `maxAge`; the consumer checks the age before the transaction starts and parks or drops a stale job.
- **Database:** `statement_timeout` and `lock_timeout` are the real bounds on a blocking JDBC call; a `Mono.timeout` cannot cancel a JDBC driver that is waiting on a lock.
- **Downstream HTTP:** `responseTimeout` bounds the read, and a Reactor `timeout` bounds the whole chain; the second is the deadline, the first is the network guard.

## Hard and soft pools

### Two kinds of bound

| Resource            | Hard bound                                                             | Soft bound                                                       | What the hard bound costs                                                                             |
| ------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Database connection | A separate `DataSource` and Hikari pool per class                      | One pool plus a per-class semaphore or Resilience4j bulkhead     | More server-side backends; a connection is idle in one pool while another pool waits                  |
| Incoming HTTP       | A separate connector and port per class, or a separate Netty server    | `maxConnections`, `acceptCount` and a per-class admission filter | A second port, a second certificate, and a client that must choose the right one                      |
| Outgoing HTTP       | A separate Reactor Netty `ConnectionProvider` per downstream and class | One provider plus a bulkhead and a short `pendingAcquireTimeout` | More connections to the downstream; a per-host pool is already the default                            |
| Queue consumption   | A separate listener container, task executor and prefetch per queue    | One container with a shared concurrency and prefetch             | More threads and more broker consumers; the hard bound is the only one that isolates a poison message |
| Queue publication   | A separate `ConnectionFactory` and `RabbitTemplate` per class          | The shared channel cache plus a per-class semaphore              | More AMQP connections; channels are cheaper than connections and usually enough                       |
| In-process jobs     | A separate executor per class                                          | One executor plus a per-class semaphore                          | More threads; with virtual threads the cost is the permit, not the stack                              |

The rule of thumb: **a hard bound owns the supply, a soft bound owns the demand.** A soft bound on a shared pool cannot reserve capacity, because another class can hold every connection before the permit is checked. The design uses hard bounds for the supply and soft admission in front of them, so a class is capped twice: once by its permits and once by its pool.

### Database connections

The database is the resource every class shares, and Hikari has no priority and no per-class fairness. A single pool gives every class the same unprioritised wait, and `connectionTimeout` (3 s in the example) is the only bound on that wait. Two changes follow.

**Give each class its own pool.** A routing `DataSource` keeps one `JdbcTemplate` and one transaction manager while each class checks out from its own Hikari pool:

```java
final class WorkClassRoutingDataSource extends AbstractRoutingDataSource {
    @Override
    protected Object determineCurrentLookupKey() {
        return WorkContext.current();
    }
}
```

The routing key is read at connection checkout, which is the start of the transaction. The context must therefore be set before the transaction begins. A `@Transactional` listener method starts its transaction before the method body, so the listener sets the class in a non-transactional wrapper and calls a transactional service, or an outer interceptor sets it before the transactional proxy. A filter or a job runner sets it before the controller or service call; a `@Transactional` method called from inside the same bean bypasses the proxy and is the existing trap in `persistence.md`.

Each pool carries its own Hikari settings:

| Class         | `maximum-pool-size` | `minimum-idle` | `connection-timeout` | Other                                                                           |
| ------------- | ------------------- | -------------- | -------------------- | ------------------------------------------------------------------------------- |
| `CRITICAL`    | 2                   | 2              | 500 ms               | `leak-detection-threshold=10000`, `max-lifetime=600000`, `keepalive-time=60000` |
| `INTERACTIVE` | 4                   | 4              | 500 ms               | The same lifetimes                                                              |
| `BACKGROUND`  | 3                   | 3              | 3 s                  | The same lifetimes                                                              |
| `BATCH`       | 1                   | 1              | 3 s                  | The same lifetimes; one transaction per batch item                              |

A fixed pool (`minimum-idle` equal to `maximum-pool-size`) avoids a spike that has to open connections while the database is already busy; Hikari's own sizing guidance recommends a fixed pool ([HikariCP](https://github.com/brettwooldridge/HikariCP#configuration-knobs-baby)). A short `connectionTimeout` on `CRITICAL` is deliberate: a fast 503 beats a three-second wait that ends in a 500.

**Cap the supply at the database too.** The application pool is the first bound; the database is the backstop. A rolling update runs old and new pods together, and an autoscaler can add replicas faster than the database can accept connections. The budget is:

```text
(sum of the class pools) × replicas × rollout surge + admin headroom ≤ database max_connections
```

PostgreSQL carries a per-role connection limit and per-role timeouts:

```sql
ALTER ROLE sbex_critical CONNECTION LIMIT 6;
ALTER ROLE sbex_critical SET statement_timeout = '2s';
ALTER ROLE sbex_critical SET lock_timeout = '1s';
ALTER ROLE sbex_critical SET idle_in_transaction_session_timeout = '10s';
```

Oracle carries the same idea in a profile and in Resource Manager: `SESSIONS_PER_USER`, `CPU_PER_CALL` and `IDLE_TIME` on the class's user, with a consumer group for CPU and I/O. The database-side cap is a backstop against a pool bug, not a substitute for the application pools.

A separate database user per class is the strongest form: the pool, the timeout and the connection limit are all named together, and a leaked connection is attributable to one class. The cost is four sets of credentials and four grants; the example can start with one user and four pools, then split the users when the database enforces the budget.

**Row locks are not pool locks.** Separate pools do not stop a batch update from holding a row that an interactive update needs. Keep every transaction short, use `SKIP LOCKED` for a batch claim, and set `lock_timeout` so a blocked statement fails at the step that owns it. The existing `archiveBatchSize` is the right shape: one bounded call per transaction.

### Incoming HTTP

Tomcat and Netty bound connections, not requests, and neither has a request priority queue.

**Tomcat with virtual threads.** `server.tomcat.max-connections` caps open connections and `server.tomcat.accept-count` caps the OS accept backlog. `server.tomcat.threads.max` has no effect when virtual threads are enabled, so it is not the concurrency bound ([Spring Boot server properties](https://docs.spring.io/spring-boot/4.1/appendix/application-properties/index.html)). The bound that remains is the connection cap plus the admission filter. A 200-connection cap with a 10-connection database pool lets 200 requests wait on 10 connections; the admission filter is what turns that wait into a fast 503.

A per-class admission filter acquires a permit before the controller and releases it after the response completes. The class comes from the route table or the authenticated principal:

```java
WorkClass workClass = router.classify(request);
if (!admission.tryAcquire(workClass, Duration.ofMillis(100))) {
    // 503 with Retry-After; do not queue indefinitely and do not return 500.
    throw new ServiceOverloadedException(workClass);
}
WorkContext.set(workClass);
try {
    chain.doFilter(request, response);
} finally {
    WorkContext.clear();
    admission.release(workClass);
}
```

The `finally` is correct for a synchronous request and wrong for a streaming or async one: the request thread returns before the stream finishes, so the permit is released while the response still holds a connection. Release the permit in an `AsyncListener` (`onComplete`, `onError`, `onTimeout`) or wrap the `StreamingResponseBody` so the release runs when the stream closes. The existing `ReportController` is exactly the case that exposes this bug.

**Netty.** `HttpServer.maxConnections` caps concurrent TCP connections; HTTP/2 streams over one connection are not counted separately, so a per-request admission `WebFilter` is the application-level per-request bound ([Reactor Netty HTTP server](https://projectreactor.io/docs/netty/release/reference/http-server.html#connection-limit)). The customizer is a `WebServerFactoryCustomizer<NettyReactiveWebServerFactory>`:

```java
factory.addServerCustomizers(server -> server.maxConnections(200));
```

The reactive filter carries the class in the Reactor Context and releases the permit in `doFinally`:

```java
return chain.filter(exchange)
    .contextWrite(context -> context.put(WorkClass.class, workClass))
    .doFinally(signal -> admission.release(workClass));
```

**A separate connector is the hard version.** A second Tomcat connector on an internal port, or a second Netty server, gives `CRITICAL` its own `maxConnections`, `acceptCount` and TLS identity. The cost is a second port and a client that must use it; a gateway can route internal traffic there. The soft filter is enough when the classes share a public endpoint and the only goal is to stop one class from taking the connection cap.

**Overload is 503, not 500.** A full admission gate, a full pool, a rejected task and an open breaker all mean "try later", not "the server is broken". Return 503 with `Retry-After`, and a RFC 9457 problem document with a stable `type` such as `https://sbex.example/problems/overloaded` ([RFC 9110, 503](https://www.rfc-editor.org/rfc/rfc9110.html#name-503-service-unavailable)). Reserve 429 for a per-client quota; a server-wide overload is 503.

### Outgoing HTTP

Reactor Netty's `ConnectionProvider` is the outbound pool. `HttpClient.create()` uses a shared provider with 500 connections and 1000 pending acquires per host, and a 45-second `pendingAcquireTimeout`; those defaults are sized for a shared event loop, not a container ([Reactor Netty connection pool](https://projectreactor.io/docs/netty/release/reference/http-client.html#connection-pool)). A per-downstream provider is the hard bound:

```java
ConnectionProvider pool = ConnectionProvider.builder("inventory")
    .maxConnections(64)
    .pendingAcquireMaxCount(128)
    .pendingAcquireTimeout(Duration.ofSeconds(2))
    .maxIdleTime(Duration.ofSeconds(30))
    .maxLifeTime(Duration.ofMinutes(5))
    .evictInBackground(Duration.ofSeconds(30))
    .metrics(true)
    .build();
```

`maxConnections` is per host pool, `pendingAcquireMaxCount` bounds the waiters, and `pendingAcquireTimeout` bounds the wait. A slow downstream then fails the acquire instead of queueing demand into memory. Add `HttpClient.responseTimeout` for the network read bound, `ChannelOption.CONNECT_TIMEOUT_MILLIS` for the connect, and a Reactor `timeout` for the whole chain; the three fail at different steps and surface as different exceptions ([Reactor Netty HTTP client timeouts](https://projectreactor.io/docs/netty/release/reference/http-client.html#timeout-configuration)).

A `Bulkhead` per class in front of the call caps concurrent requests even when the pool has idle connections. A `CircuitBreaker` per downstream stops the calls when the downstream is failing. Order the decorators once and document it; Resilience4j's recommended order is `Retry ( CircuitBreaker ( RateLimiter ( TimeLimiter ( Bulkhead ( Function ) ) ) ) )`, so each retry re-enters the breaker and the permit is released between attempts. Configure the retry to ignore `CallNotPermittedException`, or an open breaker waits through the backoff before it fails fast ([Resilience4j](https://resilience4j.readme.io/docs/getting-started-2)). A `TimeLimiter` alone does not cancel a blocking JDBC call; the database statement timeout is the real bound.

The `WebClient` needs three more bounds: `maxInMemorySize` on the codecs (the default 256 KB is a heap bound), `exchangeToMono` plus `releaseBody` when the body is not consumed (a leaked body holds a connection), and `dispose()` on the provider at shutdown. The existing `DownstreamClient` already narrows the builder and the pool; the change is one provider per downstream and the timeout pair.

### Queue consumption and publication

**Consumption is a pool of consumers.** Each consumer holds one unacked delivery (with `prefetch=1`) and one executor slot. A shared container with `prefetch=10` and four consumers lets one poison message occupy one consumer for up to 20 deliveries; a per-queue container with `prefetch=1` and its own executor gives the other queue its own slots. The hard bound is a separate `SimpleRabbitListenerContainerFactory`, `TaskExecutor`, `prefetchCount` and `concurrency` per queue; the soft bound is the same settings on one container, which is not isolation.

A per-type factory:

```java
@Bean
SimpleRabbitListenerContainerFactory jobAContainerFactory(
        SimpleRabbitListenerContainerFactoryConfigurer configurer,
        ConnectionFactory connectionFactory,
        @Qualifier("jobAExecutor") TaskExecutor executor,
        JobFailurePolicy failurePolicy) {
    SimpleRabbitListenerContainerFactory factory = new SimpleRabbitListenerContainerFactory();
    configurer.configure(factory, connectionFactory);
    factory.setTaskExecutor(executor);
    factory.setPrefetchCount(1);
    factory.setConcurrentConsumers(1);
    factory.setMaxConcurrentConsumers(2);
    factory.setDefaultRequeueRejected(false);
    factory.setAdviceChain(
        RetryInterceptorBuilder.stateless()
            .maxRetries(3)
            .backOffOptions(1_000, 2.0, 10_000)
            .recoverer(failurePolicy.recoverer("job.a"))
            .build());
    return factory;
}
```

The listener names the factory and the queue: `@RabbitListener(id = "job-a", containerFactory = "jobAContainerFactory", queues = "sbex.jobs.a")`. `defaultRequeueRejected=false` plus a `RejectAndDontRequeueRecoverer` sends an exhausted delivery to the dead-letter exchange; a `RepublishMessageRecoverer` republishes and acks, which introduces a duplicate window between the republish and the ack and therefore needs an idempotency key ([Spring AMQP error handling](https://docs.spring.io/spring-amqp/reference/amqp/resilience-recovering-from-errors-and-broker-failures.html)).

The queue length limit is the broker-side backpressure. A quorum queue supports `x-max-length`, `x-max-length-bytes` and `x-overflow=reject-publish` (but not `reject-publish-dlx`); with publisher confirms, a full queue nacks the publish instead of silently dropping it ([RabbitMQ quorum queues](https://www.rabbitmq.com/docs/quorum-queues)). The publisher maps that nack to a 503 or a deferred job, not to a retry loop.

**Publication is a channel cache, not a connection pool.** `CachingConnectionFactory` shares one connection by default and caches 25 channels; `channelCheckoutTimeout` bounds the wait for a channel, and `channelRpcTimeout` bounds the RPC. The Boot defaults leave `channel-rpc-timeout` at 10 minutes, which is a long time to hold a request thread; set it to a few seconds. Publisher confirms are asynchronous; a caller that waits on `correlation.getFuture().get(timeout)` holds a request thread, and the after-commit publisher must not do that on the event loop. Use the outbox when the publish must be as durable as the row, as `persistence.md` already says.

### In-process jobs and virtual threads

**The default task executor is a trap under virtual threads.** When `spring.threads.virtual.enabled=true` and the executor is auto-configured, Boot's `applicationTaskExecutor` is a `SimpleAsyncTaskExecutor`; the pool properties have no effect. `spring.task.execution.simple.concurrency-limit` is the bound, and `reject-tasks-when-limit-reached=true` makes a full executor reject instead of blocking the caller ([Spring Boot task execution](https://docs.spring.io/spring-boot/4.1/reference/features/task-execution-and-scheduling.html)). That auto-configuration backs off when any `Executor` bean exists, and `WebConfig`'s `mvcAsyncExecutor` is one; a servlet deployment that wants the auto-configured virtual-thread executor sets `spring.task.execution.mode=force`, or declares a named `AsyncConfigurer` executor with the same bound. The reactive application has no virtual threads, so its auto-configuration is a `ThreadPoolTaskExecutor`; set `spring.task.execution.pool.max-size` and `queue-capacity`, because the default queue is unbounded. A blocking submission is a hidden queue; a rejection is a visible 503.

**A shared executor is a shared pool.** Give `BACKGROUND` and `BATCH` their own executors with a small core and a bounded queue, and give the MVC async reports their own. When the queue is full, reject; do not use `CallerRunsPolicy` on a request thread or an event loop, because the low-priority task then runs on the high-priority thread and inverts the priority it was meant to protect.

**A priority queue needs platform threads and a bound.** `ThreadPoolTaskExecutor` creates a `LinkedBlockingQueue` for a positive `queueCapacity` and a `SynchronousQueue` otherwise; it has no priority queue setting. A subclass can override the protected `createQueue(int)` and return a bounded priority queue, and the tasks can implement `Comparable` by class and sequence number. `PriorityBlockingQueue` is unbounded, so the queue needs its own capacity check; without it, the executor grows until the heap does. The virtual-thread scheduler has no priority queue; a bounded executor in front of it is a gate, not an ordering. Use platform threads with a priority queue when strict order matters, and virtual threads with a per-class concurrency limit when memory matters more.

**Scheduling is a one-thread pool by default.** `spring.task.scheduling.pool.size` is 1, so one long `@Scheduled` job blocks every other scheduled job. Give each class a scheduler (`@Scheduled(scheduler = "batchScheduler")`) or set the pool size, and put the batch scheduler on its own thread. With virtual threads, the scheduler is a `SimpleAsyncTaskScheduler`; `spring.task.scheduling.simple.concurrency-limit` is its bound.

### Check the budget at boot

A budget that lives only in a document drifts. A validated configuration record makes an over-budget deployment fail at startup with the property name, the same posture as `AppProperties`:

```java
@ConfigurationProperties("sbex.pool-budget")
@Validated
public record PoolBudget(
        @Min(1) int critical,
        @Min(1) int interactive,
        @Min(1) int background,
        @Min(1) int batch,
        @Min(1) int replicas,
        @Min(0) int headroom,
        @Min(1) int databaseMaxConnections) {

    @AssertTrue(message = "class pools exceed database max_connections")
    public boolean isWithinDatabaseLimit() {
        int total = critical + interactive + background + batch;
        return total * replicas + headroom <= databaseMaxConnections;
    }
}
```

Register the record with `@EnableConfigurationProperties(PoolBudget.class)` so the constraint runs at startup. The record does not know about a rolling update; add the surge factor to `replicas` or cap the deployment's `maxSurge`. An autoscaler multiplies the pools, so the maximum replica count is part of the budget, not an operational afterthought.

### Configuration starting points

| Surface                     | Key                                                            | Starting value    |
| --------------------------- | -------------------------------------------------------------- | ----------------- |
| Task executor mode          | `spring.task.execution.mode`                                   | `force` (servlet) |
| Virtual-thread executor     | `spring.task.execution.simple.concurrency-limit`               | 16                |
| Virtual-thread rejection    | `spring.task.execution.simple.reject-tasks-when-limit-reached` | `true`            |
| Executor shutdown           | `spring.task.execution.shutdown.await-termination`             | `true`            |
| Executor shutdown period    | `spring.task.execution.shutdown.await-termination-period`      | `20s`             |
| Platform executor max       | `spring.task.execution.pool.max-size`                          | 16                |
| Platform executor queue     | `spring.task.execution.pool.queue-capacity`                    | 128               |
| Scheduler limit             | `spring.task.scheduling.simple.concurrency-limit`              | 4                 |
| MVC async pool              | `WebConfig` core/max/queue                                     | 2/8/64, per class |
| Tomcat connections          | `server.tomcat.max-connections`                                | 200               |
| Tomcat accept queue         | `server.tomcat.accept-count`                                   | 50                |
| Tomcat connection timeout   | `server.tomcat.connection-timeout`                             | 20s               |
| Netty connections           | `HttpServer.maxConnections` customizer                         | 200               |
| Netty connection timeout    | `server.netty.connection-timeout`                              | 20s               |
| Hikari critical             | `sbex.datasource.critical.hikari.maximum-pool-size`            | 2                 |
| Hikari interactive          | `sbex.datasource.interactive.hikari.maximum-pool-size`         | 4                 |
| Hikari background           | `sbex.datasource.background.hikari.maximum-pool-size`          | 3                 |
| Hikari batch                | `sbex.datasource.batch.hikari.maximum-pool-size`               | 1                 |
| Hikari critical wait        | `...critical.hikari.connection-timeout`                        | 500ms             |
| Hikari interactive wait     | `...interactive.hikari.connection-timeout`                     | 500ms             |
| Hikari background wait      | `...background.hikari.connection-timeout`                      | 3s                |
| Hikari batch wait           | `...batch.hikari.connection-timeout`                           | 3s                |
| Rabbit prefetch             | `spring.rabbitmq.listener.simple.prefetch`                     | 1                 |
| Rabbit concurrency          | `spring.rabbitmq.listener.simple.concurrency`                  | 1                 |
| Rabbit max concurrency      | `spring.rabbitmq.listener.simple.max-concurrency`              | 2                 |
| Rabbit requeue              | `spring.rabbitmq.listener.simple.default-requeue-rejected`     | `false`           |
| Rabbit retry                | `spring.rabbitmq.listener.simple.retry.enabled`                | `true`            |
| Rabbit retry count          | `...retry.max-retries`                                         | 3                 |
| Rabbit retry backoff        | `...retry.initial-interval` / `multiplier` / `max-interval`    | 1s / 2 / 10s      |
| Rabbit listener observation | `spring.rabbitmq.listener.simple.observation-enabled`          | `true`            |
| Rabbit template observation | `spring.rabbitmq.template.observation-enabled`                 | `true`            |
| Rabbit connection timeout   | `spring.rabbitmq.connection-timeout`                           | 2s                |
| Rabbit channel RPC          | `spring.rabbitmq.channel-rpc-timeout`                          | 5s                |
| Rabbit channel cache        | `spring.rabbitmq.cache.channel.size`                           | 25                |
| Rabbit channel checkout     | `spring.rabbitmq.cache.channel.checkout-timeout`               | 1s                |
| Outbound pool               | `maxConnections` / `pendingAcquireMaxCount`                    | 64 / 128          |
| Outbound wait               | `pendingAcquireTimeout`                                        | 2s                |
| Outbound read               | `HttpClient.responseTimeout`                                   | 2s                |
| Outbound connect            | `CONNECT_TIMEOUT_MILLIS`                                       | 2000              |
| Bounded elastic             | `reactor.schedulers.defaultBoundedElasticSize`                 | 16                |
| Bounded elastic queue       | `reactor.schedulers.defaultBoundedElasticQueueSize`            | 256               |

The virtual-thread rows and the platform pool rows are alternatives: virtual threads use the concurrency limit, platform threads use the pool max and queue. The servlet application's `WebConfig` `Executor` makes Boot back off, so `spring.task.execution.mode=force` is part of the change; the reactive application leaves the auto-configured platform executor in place. The table is a starting point for one deployment shape; the load test in [Tests that prove isolation](#tests-that-prove-isolation) moves the shares, not the structure.

## Mixed queues and per-job circuit breaking

### Two failure shapes

A mixed queue and a shared worker fail differently:

- **One queue, several job types.** A poison `job-a` at the head is delivered to the consumer before `job-b` behind it. With `prefetch=10`, the consumer may hold ten `job-a` messages and retry them all; `job-b` waits for the batch.
- **One worker, several queues.** A single `@RabbitListener(queues = { "job.a", "job.b" })` is one container with one `concurrency` and one executor. A poison `job-a` occupies a consumer slot that `job-b` also needs. RabbitMQ's consumer priority does not separate job types; it chooses between consumers of the same queue.

The first fix is structural: **one queue per job type, one container and one executor per queue**. The second fix is a breaker that stops a failing type from consuming its slots. A breaker alone cannot fix a mixed queue, and a split queue without a breaker still lets one type exhaust its own consumers.

### Split the queue before adding a breaker

A per-type queue gives the broker the isolation the application cannot fake:

- `sbex.jobs.a` and `sbex.jobs.b` are separate quorum queues, each with its own dead-letter binding, delivery limit and length limit.
- Each queue has its own `SimpleRabbitListenerContainerFactory`, `TaskExecutor` and `@RabbitListener(id = ...)`.
- Each publisher uses a routing key that names the type (`job.a`, `job.b`) and a topic exchange. The dead-letter exchange is a topic exchange with a binding per type, so a dead letter keeps its original routing key and lands in the right DLQ.
- The queue length limit is the per-type backpressure. When `sbex.jobs.a` is full, publishes to `job.a` are nacked; publishes to `job.b` still succeed.

If one mixed queue is unavoidable, the minimum is `prefetch=1`, a per-message delivery limit, and a consumer that rejects rather than requeues. That bounds one poison message but still gives `job-b` only the slots left after `job-a`; the split is the real fix.

### Key the breaker by job type

A circuit breaker per job type is a map from a bounded `jobType` to a state machine. Resilience4j's core module gives the state machine, the half-open probe and the metrics without the Spring AOP layer; the registry creates an instance per type at runtime, which is the granularity a consumer needs ([Resilience4j circuit breaker](https://resilience4j.readme.io/docs/circuitbreaker)). The dependency is the `resilience4j-circuitbreaker` and `resilience4j-bulkhead` core modules, pinned in the parent's dependency table as `logstash-logback-encoder` is; the `resilience4j-spring-boot4` starter exists, but its AOP annotations name breakers at compile time, while a consumer needs one per runtime job type.

```java
CircuitBreaker forJob(String jobType) {
    return registry.circuitBreaker(jobType, CircuitBreakerConfig.custom()
        .slidingWindowSize(20)
        .minimumNumberOfCalls(10)
        .failureRateThreshold(50)
        .slowCallDurationThreshold(Duration.ofSeconds(2))
        .slowCallRateThreshold(50)
        .waitDurationInOpenState(Duration.ofSeconds(30))
        .permittedNumberOfCallsInHalfOpenState(1)
        .automaticTransitionFromOpenToHalfOpenEnabled(true)
        .recordExceptions(TransientJobException.class, TimeoutException.class)
        .ignoreExceptions(BusinessRejection.class, PoisonJobException.class)
        .build());
}
```

Three choices in that configuration matter:

- **`minimumNumberOfCalls` is high enough that one bad message does not open the type, and low enough that a systemic failure opens it before the queue drains.** Ten calls over a twenty-call window is a starting point.
- **Slow calls count too.** A job that hangs on a lock or a downstream call consumes a slot without throwing; a failure-rate-only breaker never sees it.
- **The breaker ignores deterministic poison and business rejections.** Those are per-message problems; the message's delivery limit and the dead-letter queue own them. The breaker is for the class-level problem: the dependency is down, the job code is broken for every message, or the failure rate says the class cannot make progress.

### Classify the failure, then choose park or pause

A breaker's open action is not "throw". The action depends on why the type is failing:

| Failure                | Example                                                                  | Per-message action                              | Per-type action                         |
| ---------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------- |
| Deterministic poison   | Schema mismatch, deserialisation failure, a bug that rejects every input | Reject after 0-1 retries; dead-letter           | Do not open; the message is the problem |
| Transient dependency   | Connection refused, pool acquire timeout, downstream 503                 | Retry with backoff, then dead-letter or requeue | Open; pause the type's container        |
| Business rejection     | Unknown order, illegal state                                             | Ack and record; not a failure of the type       | Do not open                             |
| Systemic class failure | A deploy broke every `job-a` handler                                     | Dead-letter after the retry budget              | Open; pause the type and alert          |

The open action has two forms:

- **Park.** Reject the delivery with `AmqpRejectAndDontRequeueException`; the broker dead-letters it. This is correct for a message or a class whose work cannot succeed without a change and whose payload must be kept. It consumes one delivery per message while the breaker is open, so it is not a way to stop a flood.
- **Pause.** Stop the type's listener container. The unacked delivery is requeued, and the remaining messages stay in the queue; the container takes no new work until the half-open probe. This is correct for a dependency outage: the broker is the backlog, and the consumer must not drain it into a DLQ.

The breaker sits inside the listener's retry advice, and the retry ignores `CallNotPermittedException`; otherwise the open breaker is retried and the pause never happens. A pause must come from a control path, not from inside the handler that is holding the consumer. Stop the container from a small control scheduler, or use `container.stop(callback)`; stopping inline waits for the consumer and can deadlock the listener thread. The half-open probe restarts the container with `prefetch=1` for one delivery; a success closes the breaker and restores concurrency, a failure reopens it.

```java
try {
    breaker.executeRunnable(() -> handle(job));
} catch (CallNotPermittedException open) {
    switch (failurePolicy(jobType)) {
        case PARK -> throw new AmqpRejectAndDontRequeueException("job type open", open);
        case PAUSE -> controlScheduler.execute(() ->
            registry.getListenerContainer(containerId).stop());
    }
}
```

The breaker state is local to the instance. A per-message poison reaches every replica and each replica's delivery limit and DLQ handle it; a systemic dependency failure reaches every replica and each replica pauses its own container. A cluster-wide breaker needs a shared store (a database row or Redis) and adds a network dependency to the failure path; build it only when a local pause is demonstrably insufficient. The broker's per-queue state is already shared, which is why the queue split is the first line.

### The dead letter queue is the sink, not the breaker

A dead-letter queue does not break a circuit. It is where a message goes after a rejection, an expiry, a length overflow or a delivery limit. The circuit breaker is the state machine that decides to stop calling a failing function; the dead-letter queue is the parking lot that keeps the evidence. The two compose, and the composition is what answers the scenario in the question:

1. The broker's **delivery limit** is the per-message breaker. A quorum queue counts failed deliveries and dead-letters the message after the limit; RabbitMQ 4.0 defaults the limit to 20, and a job queue can set `x-delivery-limit=5` to free a consumer sooner ([RabbitMQ quorum queues: poison messages](https://www.rabbitmq.com/docs/quorum-queues)).
2. The **retry advice** is the per-delivery budget. It retries a transient exception in-process a few times, then rejects; it does not retry a deterministic poison.
3. The **per-type circuit breaker** is the class-level guard. It opens when the type's failure rate or slow-call rate says the dependency or the code is broken, and its pause action frees the consumer slots for the other type.
4. The **dead-letter queue** is the sink for messages that exhausted the first two. It holds them for triage and replay; it does not decide anything.

The scenario in the question becomes: `job-a-1` fails deterministically, its retry budget is exhausted, and the broker dead-letters it to `sbex.jobs.a.dlq`; `job-b-1` is on its own queue, container and executor and completes while that happens. If `job-a` fails because its dependency is down, the per-type breaker opens and pauses only `job-a`'s container; `job-a`'s messages stay in its queue, and `job-b` never loses a slot.

### Topology for per-type dead letters

The existing topology declares one dead-letter exchange and one DLQ, and sets `x-dead-letter-routing-key` to the queue name. That is correct for one job type and wrong for a mixed one: the fixed routing key collapses every type into one DLQ.

A per-type topology keeps the original routing key and routes on it:

```java
@Bean
Queue jobAQueue() {
    return QueueBuilder.durable("sbex.jobs.a")
        .withArgument("x-queue-type", "quorum")
        .withArgument("x-delivery-limit", 5)
        .withArgument("x-max-length", 10_000)
        .withArgument("x-overflow", "reject-publish")
        .withArgument("x-dead-letter-exchange", "sbex.jobs.dlx")
        // No x-dead-letter-routing-key: the original job.a routing key is
        // kept, so the topic DLX routes to the per-type DLQ.
        .build();
}
```

The dead-letter exchange is a durable topic exchange; `job.a` binds to `sbex.jobs.a.dlq`, `job.b` to `sbex.jobs.b.dlq`. A mixed queue that publishes with per-type routing keys and no fixed dead-letter routing key also routes correctly. A headers exchange would need the job type as a header and is more awkward to inspect than the routing key.

The DLQ itself needs a bound:

- `x-queue-type=quorum` for the same durability as the source queue.
- `x-max-length` and `x-max-length-bytes` with `x-overflow=drop-head`; a quorum queue does not support `reject-publish-dlx`, so the oldest evidence is dropped when the DLQ is full. A stream is the retention-oriented alternative: it keeps a bounded history on disk and does not pretend to be a work queue ([RabbitMQ streams](https://www.rabbitmq.com/docs/streams)).
- `x-message-ttl` if the payload has a retention limit; a DLQ with no limit is a disk DoS.
- A monitor on depth and oldest age; a DLQ nobody reads is a silent data loss.

The `x-death` header is the triage record: `reason` is `rejected`, `expired`, `maxlen` or `delivery_limit`; `count` is how many times the message was dead-lettered from that queue for that reason; `queue` and `routing-keys` name the source; `x-first-death-*` and `x-last-death-*` survive multiple dead-letterings ([RabbitMQ dead-lettering](https://www.rabbitmq.com/docs/dlx)). A quorum queue also exposes `x-delivery-count` on a redelivery; that is the delivery count, not the dead-letter count, and the two answer different questions.

### Replay is an operator action

A consumer on the DLQ that republishes automatically is a loop with extra steps. Replay is a deliberate action after the cause is fixed:

- A small operator tool or endpoint reads the DLQ, filters by `x-first-death-reason` and `x-death.count`, republishes to the source exchange with a `replay-count` header, and rate-limits the batch.
- The replayed message goes through the source queue, the retry advice and the breaker again; it does not go straight to the handler.
- The idempotency key is the job id, not the delivery id. A job that is not idempotent is not safe to replay; the DLQ is then an archive, not a retry queue.
- A replay that fills the source queue is a new overload; check the queue length limit and pause the replay before the broker rejects the publishes.
- A message that fails the same way after a replay goes back to the DLQ with an incremented `replay-count`; a quarantine threshold stops the loop.

The existing `ProcessedEventRepository` makes the order event replay-safe. A job type needs the same ledger: a row keyed by the job id and the side effect, written in the same transaction as the side effect. `persistence.md` owns the transaction boundary; this design only names the requirement.

### A worked sequence

The sequence below is the acceptance scenario for the design:

1. `job-a-1` arrives on `sbex.jobs.a`; the consumer starts a transaction, the handler throws a deterministic `SchemaViolation`.
2. The retry advice retries once (a deterministic failure is not worth three attempts), then `RejectAndDontRequeueRecoverer` rejects the delivery. The broker dead-letters it to `sbex.jobs.a.dlq` with `x-first-death-queue=sbex.jobs.a` and `x-first-death-reason=rejected`.
3. `job-b-1` arrives on `sbex.jobs.b`. Its container, executor, database pool and outbound pool are separate; it completes while `job-a`'s retry and dead-letter happen.
4. `job-a-2` through `job-a-10` fail the same way. The per-type breaker ignores the deterministic poison, so it does not open; each message follows its own retry-and-dead-letter path. The DLQ depth alarm fires.
5. An operator fixes the schema or the handler, inspects the DLQ, and replays the messages at a bounded rate. The replay goes through the source queue and the same guards.
6. If the failures were transient instead, the breaker records them, opens after the failure rate crosses the threshold, and pauses `job-a`'s container. `job-a`'s messages stay in the queue; `job-b` keeps its slots. After the open window, the half-open probe starts the container with `prefetch=1`; one success closes the breaker, one failure reopens it.

## Observability

A bound that is not measured is a guess. Add these signals before tuning the shares:

| Signal                                                                                | What it proves                                                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `hikaricp.connections.active` / `.pending` / `.timeout` tagged by pool                | Each class stays inside its database share; a pending count is the queue in front of the database |
| `reactor.netty.connection.provider.pending.connections` / `.pending.connections.time` | The outbound pool is saturated before it becomes an out-of-memory error                           |
| `sbex.work.inflight` tagged by `workClass`                                            | The admission gate matches the actual concurrency                                                 |
| `sbex.work.rejected` tagged by `workClass` and `reason`                               | Shedding is happening, and why                                                                    |
| `sbex.work.wait` tagged by `workClass`                                                | Time spent in admission, before the handler                                                       |
| `sbex.jobs.retry.count` tagged by `jobType`                                           | A retry storm before it fills the queue                                                           |
| `sbex.jobs.dlq.depth` and `sbex.jobs.dlq.oldest.age`                                  | Parked work is growing or ageing                                                                  |
| Resilience4j circuit-breaker state and call counters                                  | A type is open, half-open or closed                                                               |
| RabbitMQ queue depth and oldest message age                                           | The broker backlog, per type                                                                      |
| JVM thread count and virtual-thread count                                             | The executor bound is real, not nominal                                                           |

The tags stay bounded: `workClass`, `jobType`, `queue` and `pool`. A tenant id or a job id in a metric tag is a cardinality bomb. Logs carry `workClass` and `jobType` in the MDC; `observability.md` owns the trace fields and the JSON profile.

Alert on saturation, not on averages: a pool with pending acquires, an admission gate rejecting `CRITICAL`, a breaker open for more than one window, a DLQ whose oldest message is older than the retention target, and a queue whose oldest message is older than the class's maximum age.

## Tests that prove isolation

The tests read only their own module, as the repo's unit rule requires. The container-backed tests use the existing Testcontainers setup.

| Test                 | Setup                                                             | Assertion                                                                                                               |
| -------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PoolBudgetTest`     | A configuration with the class pools and a database maximum       | The budget fits, and an over-budget configuration fails the boot                                                        |
| `AdmissionTest`      | Exhaust a class's permits                                         | 503 with `Retry-After`, not 500, and no handler invocation                                                              |
| `NoisyNeighbourTest` | Saturate `BACKGROUND` with a blocking handler; call `CRITICAL`    | `CRITICAL` succeeds within its deadline; `BACKGROUND` is shed; the Hikari active count stays inside each pool           |
| `PoisonJobTest`      | Publish a `job-a` that always throws and a `job-b` that completes | `job-b` completes, `job-a` lands in `sbex.jobs.a.dlq` after its delivery limit, and no further `job-a` delivery is made |
| `BreakerPauseTest`   | A transient failure for `job-a`                                   | Only `job-a`'s container stops; `job-b` continues; the half-open probe takes one message                                |
| `AsyncPermitTest`    | A streaming report whose client reads slowly                      | The admission permit is held until `onComplete`, not released when the request thread returns                           |
| `DownstreamPoolTest` | A downstream that stalls                                          | The outbound pool fails at `pendingAcquireTimeout`; the caller gets 503/504, not an unbounded queue                     |
| `DlqReplayTest`      | Replay a job with the same job id                                 | The side effect happens once, and the replay count is recorded                                                          |

The noisy-neighbour test is the one that justifies the design. It must hold the high-priority class's latency target while the low-priority class is saturated, and it must fail when the two classes share one pool. A test that only measures throughput passes on a shared pool and proves nothing.

## Implementation order

1. **Measure and budget.** Add the per-class metrics and the `PoolBudget` record; record the baseline p99, pool pending and queue age. The budget fails the boot before any behavior changes.
2. **Bound the unbounded surfaces.** Force the auto-configured executor and set its concurrency limit and rejection, or set the platform pool max and queue; set the scheduler limit, the executor shutdown await, the Hikari connection timeouts, the outbound `pendingAcquireTimeout` and the Rabbit retry settings. This is the cheapest DoS fix and needs no split.
3. **Add the class and the admission gate.** Add `WorkClass`, `WorkContext`, the filter/`WebFilter`, the `TaskDecorator` and the 503 mapping. Every entry point sets a class; no resource is split yet.
4. **Split the queues and the consumers.** One queue, container, executor and prefetch per job type; per-type DLX bindings and DLQs; the delivery limit and queue length limit. Run the poison test.
5. **Split the database pools.** Add the routing `DataSource`, the per-class Hikari pools and the database-side role limits. Run the noisy-neighbour test with the database saturated.
6. **Add the per-type breaker.** Wire the registry, the failure classification and the park/pause policy; add the half-open probe. Run the breaker test.
7. **Tune the shares.** Move only the shares, not the structure, using the load test from `pod-sizing.md`; the budget check keeps the next deployment honest.

## Anti-patterns

- **One global breaker.** A failure in one job type stops every type; key the breaker by the type that can fail independently.
- **A DLQ with an automatic retry consumer.** The poison loops through the DLQ and back; replay is an operator action.
- **A client-supplied priority header.** A public caller claims `CRITICAL` and takes the reserved capacity.
- **`CallerRunsPolicy` on a request thread or an event loop.** The low-priority task runs on the high-priority thread and inverts the priority.
- **An unbounded `LinkedBlockingQueue` or `PriorityBlockingQueue`.** The queue grows until the heap does; bound the queue or gate the submission.
- **A single `@RabbitListener(queues = { "a", "b" })`.** One container, one concurrency and one executor for two failure domains.
- **`defaultRequeueRejected=true` with a poison message.** The message requeues until the broker's delivery limit, holding a consumer.
- **Dead-lettering a transient failure.** A dependency outage fills the DLQ with work that would have succeeded later; pause the type instead.
- **A `Mono.timeout` as the only database timeout.** It cancels the Reactor subscription, not the JDBC statement; set `statement_timeout`.
- **A virtual-thread executor without a concurrency limit.** `applicationTaskExecutor` is unbounded under `spring.threads.virtual.enabled`; the pool properties do not apply.
- **A per-class pool that exceeds the database budget.** Four pools times three replicas times a rolling surge is the number that matters, not one pool.
- **A priority queue with strict order and no floor.** The low class never runs, its backlog grows, and it floods when the high class pauses.

## Related layers

- tenant-fairness.md adds the per-subject rate, concurrency, pending-depth and fair-share caps that stop one JWT subject from taking a class's capacity.
- queue-operations.md specifies the queue and dead-letter console: statistics, throughput, latency, message inspection and the manual requeue workflow.

## References

- [Spring Boot 4.1 — task execution and scheduling](https://docs.spring.io/spring-boot/4.1/reference/features/task-execution-and-scheduling.html)
- [Spring Boot 4.1 — AMQP](https://docs.spring.io/spring-boot/4.1/reference/messaging/amqp.html) and [application properties](https://docs.spring.io/spring-boot/4.1/appendix/application-properties/index.html)
- [Spring Boot 4.1 — SQL data sources](https://docs.spring.io/spring-boot/4.1/reference/data/sql.html) and [HTTP clients](https://docs.spring.io/spring-boot/4.1/reference/io/rest-client.html)
- [Spring Boot 4.1 — servlet](https://docs.spring.io/spring-boot/4.1/reference/web/servlet.html), [reactive](https://docs.spring.io/spring-boot/4.1/reference/web/reactive.html) and [graceful shutdown](https://docs.spring.io/spring-boot/4.1/reference/web/graceful-shutdown.html)
- [Spring Framework 7.0 — task execution and scheduling](https://docs.spring.io/spring-framework/reference/7.0/integration/scheduling.html)
- [Spring AMQP 4.1 — asynchronous consumers](https://docs.spring.io/spring-amqp/reference/amqp/receiving-messages/async-consumer.html), [listener concurrency](https://docs.spring.io/spring-amqp/reference/amqp/listener-concurrency.html) and [connections](https://docs.spring.io/spring-amqp/reference/amqp/connections.html)
- [Spring AMQP 4.1 — recovering from errors](https://docs.spring.io/spring-amqp/reference/amqp/resilience-recovering-from-errors-and-broker-failures.html) and [transactions](https://docs.spring.io/spring-amqp/reference/amqp/transactions.html)
- [RabbitMQ — priorities](https://www.rabbitmq.com/docs/priority), [consumer priorities](https://www.rabbitmq.com/docs/consumer-priority) and [consumers](https://www.rabbitmq.com/docs/consumers)
- [RabbitMQ — quorum queues](https://www.rabbitmq.com/docs/quorum-queues), [dead-lettering](https://www.rabbitmq.com/docs/dlx) and [queue limits](https://www.rabbitmq.com/docs/limits)
- [RabbitMQ — streams](https://www.rabbitmq.com/docs/streams) (the retention-oriented DLQ)
- [HikariCP — configuration](https://github.com/brettwooldridge/HikariCP#configuration-knobs-baby) and [pool sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)
- [Reactor Netty — HTTP client connection pool](https://projectreactor.io/docs/netty/release/reference/http-client.html#connection-pool) and [HTTP server connection limit](https://projectreactor.io/docs/netty/release/reference/http-server.html#connection-limit)
- [Resilience4j — circuit breaker](https://resilience4j.readme.io/docs/circuitbreaker), [bulkhead](https://resilience4j.readme.io/docs/bulkhead) and [decorator order](https://resilience4j.readme.io/docs/getting-started-2)
- [Tomcat 11 — HTTP connector](https://tomcat.apache.org/tomcat-11.0-doc/config/http.html) (`maxConnections`, `acceptCount`)
- [Java 21 — virtual threads](https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html)
- [PostgreSQL — ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html) and [statement_timeout](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-STATEMENT-TIMEOUT)
- [Oracle 23 — CREATE PROFILE](https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/CREATE-PROFILE.html)
- [RFC 9110 — 503 Service Unavailable](https://www.rfc-editor.org/rfc/rfc9110.html#name-503-service-unavailable) and [RFC 9457 — problem details](https://www.rfc-editor.org/rfc/rfc9457.html)
