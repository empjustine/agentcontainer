---
id: sbex-modulith-events
type: submodule-design
status: draft
title: "sbex Spring Modulith events: requirements for the registry, listeners and externalization"
parent: sbex
depends-on: [sbex-resource-isolation, sbex-tenant-fairness, sbex-queue-operations]
references:
  [
    sbex,
    sbex-messaging,
    sbex-observability,
    sbex-resource-isolation,
    sbex-tenant-fairness,
    sbex-queue-operations,
    d193,
  ]
tags:
  [
    "spring-modulith",
    "application-events",
    "outbox",
    "event-registry",
    "requirements",
    "jms",
    "amqp",
  ]
---

# Spring Modulith events: requirements for the registry, listeners and externalization

This file specifies how the work-class, per-subject and queue/DLQ requirements apply to Spring Modulith's Application Events system. It separates the in-process path, where an event drives a transactional or asynchronous listener through the Event Publication Registry, from the externalized path, where the event leaves the process through AMQP, JMS, Kafka or Spring Messaging. It is a requirements and comparison document, not an implementation; sbex does not use Spring Modulith. The reader is an engineer deciding whether a modulith's events can reuse the isolation and operations design or need a different control plane.

## Status

Draft, unbuilt. No Spring Modulith dependency exists in sbex. The requirements apply to a modulith variant; the RabbitMQ and JMS comparison applies to the externalized path.

## What Modulith supplies

### In-process listeners

The application publishes a domain event through Spring's ApplicationEventPublisher. A transactional listener runs after the publishing transaction commits; an asynchronous listener runs on an executor. Spring Modulith's ApplicationModuleListener is the composed default: TransactionalEventListener, Async and Transactional with propagation REQUIRES_NEW. The listener therefore runs on a different thread, in a new transaction and, for a database-backed listener, on a new database connection.

The event is in-process. There is no broker queue, no consumer group, no prefetch, no delivery acknowledgement and no network hop. The executor and the database are the resources that the listener consumes. A publication outside a transaction has no after-commit phase; the deployment must publish inside a transaction or set a defined fallback, or the listener is skipped.

### The publication registry

The Event Publication Registry is a persistent ledger. It stores one row per event and listener pair, not one row per event. The row carries the event serialization, listener id, event type, publication date, completion date, status, completion attempts and last resubmission date.

The registry exists so a listener that never runs or never completes can be found and resubmitted. It is the in-process at-least-once mechanism, and it is not a broker. It provides status, resubmission, abandonment and staleness, but it does not provide consumer groups, prefetch, queue pause, dead-letter exchange or broker queue statistics.

### Externalization

An event annotated with Externalized can leave the process through a broker module: spring-modulith-events-amqp, -jms, -kafka or -messaging. The registry guards the externalization, so a failed send can be resubmitted.

The native externalization is an asynchronous transactional listener. The Spring Modulith documentation warns that it lacks critical features of a full outbox. An outbox mode is available, selected with spring.modulith.events.externalization.mode=outbox and backed by JobRunr or Namastack; that mode is the stronger guarantee and the one to choose when the externalized event must not be lost.

### Observability

Spring Modulith publishes module.events.published and a per-event counter, and it can create Micrometer spans for module interaction. The registry adds publication and completion timestamps and a completion-attempt count. None of these is a broker queue-depth or consumer metric.

## Which previous concerns apply

The concerns do not disappear; they move from the broker to the executor, the registry table and the database pool. The table below separates the in-process path from the externalized path.

| Concern                        | In-process Application Events                                                      | Externalized events to a broker                        |
| ------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Work-class priority            | Applies; no built-in priority; the executor is the scheduler                       | Applies at the producer and again at the broker        |
| Per-subject fairness           | Applies; custom executor and per-subject cap                                       | Applies at the producer and at the broker              |
| Database connections           | Applies strongly; REQUIRES_NEW opens a transaction and connection per listener     | Applies at the producer; the consumer has its own pool |
| Incoming and outgoing HTTP     | Applies when a listener calls HTTP; same per-class pools and per-subject bulkheads | Applies on both sides                                  |
| Pending depth and backpressure | Registry rows, executor queue and DB table size                                    | Broker queue plus the registry                         |
| Dead letter                    | FAILED and ABANDONED publications plus resubmission                                | Broker DLX or provider DLQ plus the registry           |
| Pause and resume               | Executor or listener stop; no per-event pause                                      | Broker queue pause or listener stop                    |
| Glass pane                     | Registry table and the registry APIs; custom UI                                    | Broker management console plus the registry            |
| Manual dequeue and requeue     | Resubmit a publication; no move to another queue                                   | Broker replay plus registry resubmission               |
| Throughput                     | module.events.published and completion rates                                       | Broker rates plus application rates                    |
| Latency                        | publication_date to completion_date; no broker latency                             | Broker queue age plus application timestamps           |
| Audit, RBAC and four-eyes      | Custom                                                                             | Custom plus broker administration                      |
| Ordering                       | No guarantee across async listeners; custom executor or single listener            | Broker ordering or partition                           |

The short answer is: the resource-isolation and per-subject fairness requirements apply in full to the in-process path, while the queue/DLQ glass-pane requirements apply only as a registry console. The broker queue requirements apply again when the event is externalized.

## The registry as a queue and DLQ analog

### What the registry records

The event_publication table is the durable record. The exact schema depends on the store, but the JDBC store carries:

- id
- listener_id
- event_type
- serialized_event
- publication_date
- completion_date
- status
- completion_attempts
- last_resubmission_date

The status is one of PUBLISHED, PROCESSING, COMPLETED, FAILED, RESUBMITTED or ABANDONED. A publication is per listener: an event with three listeners has three rows, and each row can fail and be resubmitted independently.

### What the registry APIs provide

- CompletedEventPublications lists completed rows and purges them immediately or older than a duration. Completed rows remain by default, so an unmanaged registry grows without bound.
- IncompleteEventPublications resubmits rows matching a predicate, older than a duration or matching ResubmissionOptions. ResubmissionOptions carries a batch size, a maximum in-flight count and a filter; those are the registry's backpressure controls.
- FailedEventPublications resubmits only failed rows.
- AbandonedEventPublications lists and purges abandoned rows. An AbandonPolicy decides when a repeatedly failing publication becomes abandoned instead of resubmitted.
- The staleness monitor marks rows stuck in PUBLISHED, PROCESSING or RESUBMITTED as FAILED after configured durations. Without it, a crashed listener leaves a row stuck forever.

### Queue depth and DLQ mapping

The registry is the queue-depth and DLQ analog, not a queue:

- Queue depth is the count of rows by status, by listener and by age. The table size is the backlog, and an unbounded completed set is a leak.
- A DLQ is the FAILED and ABANDONED set. There is no dead-letter exchange; a failed row stays in place and is resubmitted, and an abandoned row is the terminal quarantine.
- Manual dequeue is a resubmission, not a broker get and ack. The event is already serialized in the database; resubmission calls the listener again.
- Manual purge is CompletedEventPublications purge or AbandonedEventPublications delete; there is no queue purge.
- Pause is an executor or listener stop; there is no per-publication pause.
- At-least-once delivery is the contract. A crash after the listener side effect and before the completion write produces a duplicate; the listener needs an idempotency key or a dedup table.

### Registry growth and retention

The registry is a database table on the hot path. The requirements are:

- completed rows are purged on a schedule; the retention is a deployment decision
- failed and abandoned rows have a retention and an alert on age and count
- the table has an index for status and completion date; the store's own schema does
- a large backlog is not read in one query; resubmission uses a batch size and a maximum in-flight count
- the registry write is part of the publishing transaction budget; a high event rate costs database writes even before any listener runs

## Fairness and priority

### The executor is the in-process queue

An async listener runs on the application's task executor. That executor is a queue, and it has the same failure modes as a thread pool: an unbounded queue, a virtual-thread executor without a concurrency limit, a slow listener holding a thread, and a low-priority listener delaying a high-priority one.

Spring Modulith supplies no per-event priority and no fair scheduler. Order on a listener orders listeners, not events. The executor is effectively first-in, first-out; one noisy module or one subject can fill it.

The requirements from resource-isolation.md apply:

- a bounded executor per work class, with a rejection policy
- a per-subject concurrency and pending-depth cap
- a fair queue or weighted dispatch across subjects
- a deadline, so an expired event is not started
- a per-subject global cap across event types

The in-process equivalent of a sharded job queue is a set of executors or a fair dispatcher keyed by the quota key. A single global executor cannot provide it.

### The new transaction is a new connection

ApplicationModuleListener uses REQUIRES_NEW. Every listener invocation opens a transaction and, if it touches the database, checks out a connection. A burst of events from one subject can take every connection in the class pool, exactly as a burst of HTTP requests can. The per-class database pools, the per-request connection budget and the per-subject concurrency cap from tenant-fairness.md apply without change.

A listener that opens a second transaction or a nested connection multiplies the cost. The same rule applies: a request or event budget of one connection, and no REQUIRES_NEW inside the listener unless the budget accounts for it.

### Ordering

An async listener has no ordering guarantee across events or across listeners. A subject's events can run concurrently and complete out of order. If order matters, the deployment needs one of:

- a single listener with concurrency one for that subject or aggregate
- a per-subject executor with one worker
- a partition key carried to a broker after externalization
- an aggregate version check in the listener

The registry does not order resubmissions. A resubmitted event can run beside a newer event.

### Event ownership

The event must carry the quota key and work class from the authenticated producer, exactly as a job does. The listener must validate the owner metadata and must not trust an event body field. A system-generated event uses a named system principal.

The per-subject pending depth is the count of registry rows for that owner and class. That count is a database query, not a broker statistic. A top-K report is the bounded form; a per-subject metric label is forbidden.

## Externalization to JMS and AMQP

### The broker path

Externalized events use a broker module. The target is a topic, exchange or queue, and the routing key is broker-specific; JMS does not support routing keys, AMQP does. The earlier comparison in queue-operations.md applies to this path: Spring JMS plus the provider's administration API, or Spring AMQP plus the RabbitMQ management API.

The broker path inherits the broker queue requirements:

- priority and fair share at the broker
- DLX or provider DLQ
- queue depth, throughput and latency
- manual replay and requeue
- pause and purge
- consumer prefetch and concurrency

The in-process registry does not inherit those features. It is the producer-side ledger.

### Native externalization and outbox mode

The native externalization is an asynchronous listener that sends the event and marks the publication complete. The Spring Modulith documentation warns that it lacks critical outbox features. The outbox mode, selected in configuration and backed by JobRunr or Namastack, is the stronger option when the event must survive a crash between the business commit and the broker send.

The requirements are:

- the deployment names the externalization mode
- the native mode is not described as a full outbox
- the outbox mode is the default for an event whose loss costs money
- the registry row and the broker send have one owner for retries; a retry in both layers is a retry storm
- the event id is the idempotency key on both sides
- a broker acceptance followed by a registry completion failure produces a duplicate; the consumer deduplicates

### JMS and AMQP differences

The previous comparison applies unchanged:

- Spring JMS externalization uses JmsTemplate and the provider's destination; no routing key.
- Spring AMQP externalization uses RabbitTemplate and an exchange with a routing key.
- JMS selectors and message groups have no AMQP equivalent.
- RabbitMQ DLX, priority and per-queue management have no JMS equivalent.
- The console remains provider-specific; the registry is the one provider-neutral part.

## Observability and the registry glass pane

### Metrics and spans

Spring Modulith supplies module.events.published and a per-event counter, with module and event type tags. It can create spans for module interaction. The registry supplies publication date, completion date, status and completion attempts.

The deployment adds:

- completed and failed rates per listener and event type
- publication to completion latency, p50, p95 and p99
- registry depth by status and age
- resubmission rate and completion attempts
- executor queue depth and active count
- per-subject top-K, hashed and bounded

### A registry console

A queue-operations-style glass pane over the registry can provide:

- list publications by status, listener, event type, owner hash and age
- inspect the serialized event with redaction and a payload-size limit
- resubmit a failed or incomplete publication with a reason and an idempotency key
- purge completed or abandoned publications with a two-person confirmation
- show completion attempts and last resubmission date
- audit every read of the serialized event and every resubmission or purge

The console API and UI requirements from queue-operations.md apply, with these substitutions: publication instead of message, listener instead of queue, resubmit instead of requeue, completed or abandoned purge instead of queue purge. There is no consumer count, prefetch or broker queue pause to show.

## Requirements

### Functional requirements

| Id        | Requirement                                                                                | Verification                                         |
| --------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| FR-MOD-01 | The event carries the validated owner and work class; the listener ignores body fields     | A forged owner is ignored or rejected                |
| FR-MOD-02 | The async executor is bounded per work class, with a rejection policy                      | A burst rejects or queues within the bound           |
| FR-MOD-03 | Per-subject event concurrency and pending depth are enforced                               | One subject cannot fill every listener slot          |
| FR-MOD-04 | REQUIRES_NEW connections count against the class pool and the subject budget               | The database pool stays inside the budget            |
| FR-MOD-05 | Completed publications are purged on a schedule                                            | The table does not grow without bound                |
| FR-MOD-06 | Failed and abandoned publications have a retention and an alert                            | Age and count are visible                            |
| FR-MOD-07 | Resubmission uses a batch size and a maximum in-flight count                               | A large failure set does not flood the executor      |
| FR-MOD-08 | Staleness marks stuck publications as failed                                               | A killed listener does not leave a row stuck forever |
| FR-MOD-09 | The deployment names the externalization mode; the native mode is not called a full outbox | The configuration and the runbook agree              |
| FR-MOD-10 | The externalized path reuses the broker requirements in queue-operations.md                | The broker DLQ, queue stats and replay are specified |
| FR-MOD-11 | Event listeners are idempotent or carry an idempotency key                                 | A duplicate event causes no second side effect       |
| FR-MOD-12 | The registry console redacts payloads and audits every resubmission and purge              | A payload scan and an audit check                    |
| FR-MOD-13 | Resubmission and purge require the operator role and a reason                              | A viewer or unauthenticated request is refused       |
| FR-MOD-14 | The deployment defines ordering per aggregate or subject                                   | An ordering test passes                              |
| FR-MOD-15 | Event metrics do not carry the raw subject                                                 | A metric scrape                                      |
| FR-MOD-16 | A pause or stop of the executor or listener is scoped and audited                          | A pause test                                         |

### Non-functional requirements

| Id         | Requirement                                                                 | Verification                               |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| NFR-MOD-01 | The in-process path adds no broker hop                                      | A trace shows the listener on the executor |
| NFR-MOD-02 | The registry write and listener transaction stay inside the database budget | A load test                                |
| NFR-MOD-03 | The registry console reads are paginated and bounded                        | A large-registry test                      |
| NFR-MOD-04 | The executor and registry state are observable                              | Metrics and a dashboard                    |
| NFR-MOD-05 | A listener failure does not lose the publication                            | A crash test                               |
| NFR-MOD-06 | A duplicate delivery is harmless with the idempotency contract              | A replay test                              |
| NFR-MOD-07 | The externalized path has one retry owner                                   | A fault injection                          |
| NFR-MOD-08 | The registry schema is migrated and indexed                                 | A migration check                          |
| NFR-MOD-09 | The console payload is redacted                                             | A sensitive-fixture scan                   |
| NFR-MOD-10 | The behavior is documented for both the in-process and externalized paths   | A design review                            |

### Acceptance criteria

| Id        | Scenario                                                        | Expected result                                                                                     |
| --------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| AC-MOD-01 | One subject publishes 1,000 events; the subject cap is 2        | At most 2 listeners run; the rest are queued or refused; another subject proceeds                   |
| AC-MOD-02 | A listener throws after the side effect                         | The publication is FAILED; resubmission does not duplicate the side effect with the idempotency key |
| AC-MOD-03 | A publication exceeds the abandon policy                        | It becomes ABANDONED; it is listed and purgeable with audit                                         |
| AC-MOD-04 | The registry has 1,000,000 completed rows                       | The purge job removes the old rows; reads stay paginated                                            |
| AC-MOD-05 | The executor is saturated                                       | The producer receives backpressure; the event is not silently lost                                  |
| AC-MOD-06 | An externalized event is sent and the registry completion fails | The consumer sees a duplicate; it is deduplicated by the event id                                   |
| AC-MOD-07 | A viewer opens a publication payload                            | The request is refused; the audit records the attempt                                               |
| AC-MOD-08 | A listener opens a second transaction                           | The connection budget shows the second connection; the pool stays inside its class                  |
| AC-MOD-09 | Two events for one aggregate run concurrently                   | The aggregate version check rejects the stale one, or the executor serializes them                  |
| AC-MOD-10 | A stuck publication is older than the staleness threshold       | It is marked FAILED and becomes resubmittable                                                       |

## Customizations and overrides

Spring Modulith supplies the registry, the states, resubmission, abandonment, staleness, externalization and event metrics. Most of the queue-management work is not a Spring override; it is a separate control plane and a set of configuration choices.

| Area                   | Built-in                                                                      | Configuration                                                     | Custom                                      |
| ---------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| Listener execution     | ApplicationModuleListener, TransactionalEventListener, async and REQUIRES_NEW | Executor, async configurer, transaction manager                   | Per-class and per-subject fair executor     |
| Registry lifecycle     | Status, resubmission, abandonment, staleness                                  | Store, completion mode, staleness durations, resubmission options | Retention, alerting, operation audit        |
| Externalization        | Externalized, AMQP/JMS/Kafka/Messaging modules                                | Mode, target, routing                                             | Outbox mode integration and retry ownership |
| Priority and fairness  | None                                                                          | Separate executors per class                                      | Per-subject fair queue, deadline, aging     |
| Queue glass pane       | Registry APIs and event metrics                                               | Read roles, retention                                             | UI, API, RBAC, four-eyes, payload redaction |
| Latency and throughput | Event counters and spans                                                      | Meter registry                                                    | Per-listener and per-subject percentiles    |
| DLQ analog             | FAILED, ABANDONED and resubmission                                            | AbandonPolicy, staleness                                          | Quarantine policy, replay rate, audit       |

The extension points are the registry store, the resubmission and abandonment APIs, the abandon policy, the externalization transport, the event metrics customizer and the observation convention. A subclass of the listener container is not the normal customization point.

Counted by feature: the registry and the outbox are largely built-in; the bounded/fair executor, per-subject quota, queue console, audit, payload redaction and latency are largely custom. The externalized path reuses the JMS/AMQP comparison and the queue-operations requirements; the in-process path does not.

## Alternatives rejected

- **Treat the registry as a broker queue.** It has no consumer group, prefetch, dead-letter exchange or broker queue statistics. It is a database ledger.
- **Use one global async executor.** One module or subject fills it; the work-class separation is lost.
- **Auto-resubmit every failed publication.** A poison event becomes a retry storm; use the abandon policy, resubmission bounds and a reason.
- **Rely on Order for event priority.** Order orders listeners, not events.
- **Use the native externalization for a money event without an outbox.** The documentation warns it lacks full outbox guarantees.
- **Keep completed publications forever.** The table grows without bound and the registry slows.
- **Put the raw subject in an event metric.** The cardinality and the privacy cost are both unacceptable.
- **Pause the whole executor to pause one listener.** The scope is wider than the incident; use a per-listener or per-class executor.

## Open decisions

- Whether sbex adopts Spring Modulith at all.
- The registry store and its retention.
- Native externalization or outbox mode for each externalized event.
- One executor per work class or one fair dispatcher.
- The abandon policy and the quarantine threshold.
- The scope of the registry console and its role model.
- The ordering key for aggregates that need order.

## References

- [Spring Modulith — events](https://docs.spring.io/spring-modulith/reference/events.html)
- [Spring Modulith — production-ready observability](https://docs.spring.io/spring-modulith/reference/production-ready.html)
- [Spring Modulith — configuration properties](https://docs.spring.io/spring-modulith/reference/appendix.html)
- [Spring Framework 7.0 — transaction-bound events](https://docs.spring.io/spring-framework/reference/7.0/data-access/transaction/event.html)
- [Spring Framework 7.0 — asynchronous execution](https://docs.spring.io/spring-framework/reference/7.0/integration/scheduling.html#scheduling-annotation-support-async)
- [Spring Boot 4.1 — task execution and scheduling](https://docs.spring.io/spring-boot/4.1/reference/features/task-execution-and-scheduling.html)
- [Spring AMQP — listener container](https://docs.spring.io/spring-amqp/reference/amqp/receiving-messages/async-consumer.html), [publisher confirms](https://docs.spring.io/spring-amqp/reference/amqp/template.html) and [transactions](https://docs.spring.io/spring-amqp/reference/amqp/transactions.html)
- [Spring Framework 7.0 — JMS](https://docs.spring.io/spring-framework/reference/7.0/integration/jms.html)
- [RabbitMQ — HTTP API reference](https://www.rabbitmq.com/docs/http-api-reference) and [management](https://www.rabbitmq.com/docs/management)
- [Spring Modulith project](https://github.com/spring-projects/spring-modulith)
