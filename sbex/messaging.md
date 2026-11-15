---
id: sbex-messaging
type: submodule-design
status: active
title: "sbex messaging: confirmed publishes and an idempotent listener"
parent: sbex
references: [d193]
tags: ["rabbitmq", "amqp", "idempotency", "spring-amqp"]
---

# Messaging: confirmed publishes and an idempotent listener

This file owns `sbex-core/…/messaging/` and the servlet listener: how a publish is proven, how a delivery becomes safe to repeat, and which knobs bound a consumer's backlog. It does not cover broker installation or cluster topology — the RabbitMQ documentation linked at the end owns those. The reader arrives with "the database and the broker must not disagree"; the answer here is an after-commit publish, a confirm log line and a dedup row in the same transaction as the business write.

## Topology, declared in code

`RabbitTopologyConfig` declares the exchange, the queue and both bindings as beans: the topology versions with the consumers that need it, and a broker wiped and redeclared from the application comes back identical. The choices carry their reasons:

- A **topic exchange** with the routing key `order.placed`: consumers bind by pattern, so a second consumer joins without a publish-side change.
- A **quorum queue** (`x-queue-type: quorum`): disk-backed and replicated, the durability choice for messages whose loss costs money. Classic queues are the memory-first alternative and the wrong default for this traffic.
- **Dead-lettering** (`x-dead-letter-exchange` plus a bound DLQ): a message rejected enough times lands somewhere inspectable instead of looping forever. Republishing with the broker's `x-death` count is how a consumer decides "poison" from "transient".
- A **JSON payload converter** (`JacksonJsonMessageConverter` over Boot's `JsonMapper`): the payload is a record contract, `@RegisterReflectionForBinding` on the same configuration keeps that contract working in a native image, and the converter speaks the same Jackson 3 the web layer does. `Jackson2JsonMessageConverter` is the Jackson 2 path and deprecated for removal — and because Boot 4 configures no `com.fasterxml…ObjectMapper` bean by default, reaching for it fails the boot rather than the build (`docs/d193`).

## Publishing: proves before trusting

A fire-and-forget `convertAndSend` is a blind write. `spring.rabbitmq.publisher-confirm-type= correlated` makes the broker answer each publish, `publisher-returns` plus `template.mandatory` make unroutable messages come back instead of vanishing, and `OrderEventPublisher` turns both answers into log lines:

- The `CorrelationData` future completes with a `Confirm` — `ack()` false is a nack with a `reason()`.
- A returned message means the exchange had no binding for the routing key: the publish reached the broker and still went nowhere.
- Either failure is an ERROR line carrying the `eventId`, the field a search starts from.

The publish itself happens in `@TransactionalEventListener(AFTER_COMMIT)`. Publishing inside the transaction would invert the order a consumer can rely on — the event may arrive before the row it describes — and a broker outage would then roll back accepted orders. The pairing that survives both failures is the outbox (see `persistence.md`), where the event row commits with the order and a relay publishes it afterwards.

## Consuming: at-least-once, made effectively-once

RabbitMQ delivers at-least-once: a crash between the database commit and the acknowledgement replays the message. `OrderPlacedConsumer` makes the replay harmless:

1. `ProcessedEventRepository.markProcessed` upserts the `eventId` — the dialect's `ON CONFLICT DO NOTHING` or `MERGE` returns 0 rows when the id exists.
2. Zero rows means a redelivery: log and return, with no second status change.
3. Non-zero rows proceed to the status update — in the SAME transaction as the dedup insert, so a crash between the two rolls both back and the redelivery starts clean.

The listener container runs that transaction with `channelTransacted = true` and the application's `PlatformTransactionManager` (`ListenerConfig`): the channel acknowledgement joins the commit, so a rollback requeues the delivery instead of acknowledging work that never happened. With `channelTransacted` off, an external transaction manager still wraps the listener while the messaging operations auto-ack — a business rollback would commit the acknowledgement anyway.

An order that never arrives is logged at ERROR rather than requeued: requeue loops forever on a genuinely lost order, and the dedup row already prevents a later redelivery from repeating the attempt.

## Bounding the backlog

Three settings in `application.yml`, each with a distinct job:

| Setting                                           | Bounds                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `listener.simple.prefetch`                        | unacked messages sitting in one consumer's channel — the per-consumer in-flight count |
| `listener.simple.concurrency` / `max-concurrency` | consumers per queue on this instance                                                  |
| the database pool (in `memory.md`)                | how fast those consumers can actually drain                                           |

A prefetch of 10 with four consumers means at most 40 unacked orders per instance — the number a crash replays, and the memory this instance holds for messages. Prefetch 1 competes for throughput; an unbounded prefetch hands one slow consumer the whole queue.

**Ordering** is the constraint these knobs interact with: one queue preserves order only as far as one consumer at a time with prefetch 1 delivers it, and competing consumers interleave. Where order matters, the routing must carry it (a partition key per order) rather than the queue alone.

## References

- [Spring AMQP — correlated publisher confirms and returns](https://docs.spring.io/spring-amqp/reference/amqp/template.html)
- [Spring AMQP — transactions](https://docs.spring.io/spring-amqp/reference/amqp/transactions.html) (the `channelTransacted` rule above)
- [Spring AMQP — listener concurrency](https://docs.spring.io/spring-amqp/reference/amqp/listener-concurrency.html)
- [RabbitMQ — channels and publisher confirms](https://www.rabbitmq.com/docs/channels)
- [RabbitMQ — consumers, prefetch and QoS](https://www.rabbitmq.com/docs/consumers)
- [RabbitMQ — quorum queues](https://www.rabbitmq.com/docs/quorum-queues) and [streams](https://www.rabbitmq.com/docs/streams) (the replay-oriented alternative to a queue of events)
