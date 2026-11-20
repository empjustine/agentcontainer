---
id: sbex-queue-operations
type: submodule-design
status: draft
title: "sbex queue operations: requirements for a queue and DLQ glass pane"
parent: sbex
depends-on: [sbex-messaging, sbex-resource-isolation]
references:
  [sbex, sbex-messaging, sbex-observability, sbex-resource-isolation, sbex-tenant-fairness, d193]
tags:
  ["rabbitmq", "jms", "spring-amqp", "dlq", "operations", "observability", "requirements", "audit"]
---

# Queue operations: requirements for a queue and DLQ glass pane

This file specifies the queue operations console for sbex's RabbitMQ topology: the RIB-like glass pane for queue statistics, throughput, latency, dead-letter contents and manual dequeue and requeue. It is a requirements and contract document, not an implementation. It defines the actors, use cases, data, functional and non-functional requirements, permissions, audit, safety rules and acceptance tests. It does not cover broker installation, job business semantics or per-subject fairness; resource-isolation.md and tenant-fairness.md own those.

## Status

Draft, unbuilt. No code implements this specification. RIB is proprietary; this document treats its feature list as the requirement baseline, not its data model, API or user interface.

## Problem

Operators need to see what the queues are doing and to act when a queue or a dead-letter queue needs attention. The RabbitMQ management UI exposes statistics and a message-get action, but a governed operation needs more: a role model, a reason and an audit record for every mutation, a production-safe move instead of a troubleshooting get, a bounded bulk workflow, and a clear statement of what the broker can and cannot report.

The failure modes are operational. A bulk requeue that silently loses messages is worse than no requeue. A purge that runs before the consumers stop leaves unacknowledged messages behind. A peek loop on a quorum queue can advance a delivery counter until a message dead-letters from inspection alone. A console that polls the broker too aggressively becomes the incident.

The glass pane is read-mostly, audited and narrow. It is not a general broker administration tool.

## Scope and non-goals

In scope:

- RabbitMQ 4.x queues: classic, quorum and stream metadata.
- Queue and dead-letter queue statistics, throughput, latency and age.
- Message inspection, filtering, pagination and export of metadata.
- Manual dequeue, requeue, move, discard and purge workflows.
- Pause and resume of consumption, with the scope stated.
- Role-based access, four-eyes controls, audit and operation journal.
- The console API and UI contract, and the acceptance tests.

Out of scope:

- RabbitMQ cluster installation, upgrades, node repair and partition handling.
- User, vhost, permission and policy administration, except the console's own role mapping.
- Editing message payloads or arbitrary headers.
- Job business logic, retry policy and per-job circuit breaking; resource-isolation.md owns those.
- Per-subject fairness and quota decisions; tenant-fairness.md owns those.
- A JMS-provider abstraction for RIB or other brokers. The contract targets RabbitMQ; another broker needs its own adapter.

## Actors and roles

| Role          | Reads                                                       | Mutates                                          | Broker privilege                                                    | Notes                                                          |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| Viewer        | Queue list, detail, stats, aggregate metadata, audit        | Nothing                                          | Monitoring tag plus read permission on the vhost                    | No message get and no payload; a get is a delivery, not a read |
| Operator      | Everything a viewer reads plus message metadata and payload | Requeue, move, discard, pause, resume            | Management tag plus read, write and configure on the queue patterns | No purge, delete or policy change                              |
| Administrator | Everything an operator reads and does                       | Purge, delete queue, bulk destructive operations | Administrator or policymaker plus vhost permissions                 | Four-eyes for purge and delete                                 |
| Auditor       | Audit records and metadata                                  | Nothing                                          | No broker credential                                                | Reads the console audit store, not the broker                  |
| Service       | Nothing                                                     | Nothing                                          | The application's own least-privilege user                          | Never shared with the console                                  |

The console uses its own broker user, not the application's user and not a human administrator's personal user. Normal RabbitMQ permissions still apply to a monitoring or administrator tag; a tag does not grant access to a queue the user cannot read.

The role mapping is a deployment contract. A deployment that cannot give the console a least-privilege broker user must not deploy the console.

## Use cases

| Id       | Actor         | Goal                                                                         |
| -------- | ------------- | ---------------------------------------------------------------------------- |
| UC-QO-01 | Viewer        | List queues and see which are growing, idle, unhealthy or have a DLQ backlog |
| UC-QO-02 | Viewer        | Open one queue and read depth, consumers, rates, age and policy              |
| UC-QO-03 | Viewer        | Compare throughput and latency for a queue over a time window                |
| UC-QO-04 | Viewer        | Inspect dead-letter messages and filter by reason, type, age or message id   |
| UC-QO-05 | Operator      | Requeue selected dead-letter messages to their source queue                  |
| UC-QO-06 | Operator      | Move selected messages to an explicit exchange and routing key               |
| UC-QO-07 | Operator      | Discard selected messages after review                                       |
| UC-QO-08 | Operator      | Pause and resume consumption for one queue                                   |
| UC-QO-09 | Administrator | Purge a queue or delete it after a two-person confirmation                   |
| UC-QO-10 | Auditor       | Read the audit trail for an operation                                        |
| UC-QO-11 | Operator      | Export a bounded message list or a statistics window                         |
| UC-QO-12 | Viewer        | See data freshness and whether the broker view is degraded                   |

## Data requirements

### Queue identity and configuration

The console must show:

- virtual host, queue name and queue type
- durable, auto-delete and exclusive flags
- node and state
- policy and effective policy definition
- queue arguments, including the dead-letter exchange, dead-letter routing key, delivery limit, maximum length, overflow and message TTL
- creation time, when the broker exposes it

### Depth and capacity

The console must show, per queue:

- total messages (ready plus unacknowledged)
- ready messages and unacknowledged messages
- message bytes ready and unacknowledged
- persistent, in-memory and paged-out counts where the broker exposes them
- memory used by the queue process
- consumers and consumer utilisation
- the configured maximum length and overflow behavior, when present
- the percentage of the maximum length and the percentage of the maximum bytes

The console must not infer a maximum from a policy it cannot read. A missing limit is "unbounded", not "healthy".

### Throughput

The console must show, per queue and per time window:

- publish rate
- deliver rate
- acknowledgement rate
- confirm rate
- redelivery rate
- unroutable drop and return rate
- consumer count and consumer utilisation

The source is the broker's message statistics counters and the management or Prometheus surface. Rates are deltas over a window, not a single counter value. The console must show the window and the sample time. A rate computed from a counter reset must be marked as a reset, not as a negative rate.

### Latency

The broker does not report per-message latency. The console must distinguish three measurements:

- Queue wait: the time between publish and the first delivery. This needs a publish timestamp in the message or an application-level observation.
- Processing: the time between delivery and acknowledgement. This needs a consumer-level timer.
- End-to-end: the time between publish and acknowledgement. This is the sum, or a single application timer.

The console must show p50, p95 and p99 over a named window, not only a mean. A mean hides the tail that an operator is looking for. A queue without timestamps must show "not measured", not a fabricated zero.

The oldest ready message age is a separate signal. The broker exposes the head message timestamp when it can; the console must label the value as an estimate when the queue is paged out or the timestamp is absent.

### Consumers

The console must show the consumer count, the consumer utilisation and the consumers' prefetch where the broker exposes it. A queue with zero consumers and a growing ready count is the first health signal. A queue with consumers and a low utilisation points to prefetch, a slow handler or a blocked connection.

### Dead-letter contents

The console must show, per selected message:

- message id, correlation id, timestamp, priority and delivery mode
- exchange and routing key
- redelivered flag and delivery count, where the broker exposes it
- payload preview, content type and size
- application headers
- the dead-letter history: reason, queue, exchange, routing keys, count and time for each event
- the first and last death queue, reason and exchange
- the exception headers a recoverer adds, when present

The payload preview must be bounded by bytes and must support text and base64. The console must not render arbitrary content as HTML. A download is a separate permission and a separate audit event.

### Per-type and per-subject views

A per-type view is free when the queues are per type, as resource-isolation.md recommends. A per-subject view is not free: the broker does not aggregate by an arbitrary header, and a per-subject metric label is unbounded cardinality. The console must show a bounded top-K report from the application's metrics or audit store, not a full per-subject table on the broker dashboard.

### History and freshness

The console must show the sample time and the freshness of every value. A cached dashboard can show a value that is older than the incident. A stale value is not a healthy value.

The console must not poll the broker on a schedule that competes with the application. Queue list reads use the low-cost list surface where possible; detailed per-queue reads are on demand or at a slower interval. The Prometheus surface is the time-series source; the management API is the drill-down source.

## Functional requirements

| Id       | Requirement                                                                                  | Verification                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| FR-QO-01 | List queues with depth, consumers, type, state, policy and DLQ flag                          | The list matches the broker for a fixture                                                                      |
| FR-QO-02 | Show one queue's depth, capacity, consumers, rates, age and policy                           | The detail matches the broker and the policy                                                                   |
| FR-QO-03 | Show throughput rates over a named window                                                    | A counter delta produces the expected rate; a reset is marked                                                  |
| FR-QO-04 | Show queue wait, processing and end-to-end latency percentiles, or "not measured"            | A fixture with timestamps produces the percentiles; a fixture without timestamps shows not measured            |
| FR-QO-05 | Show the oldest ready message age and label an estimate                                      | The head timestamp and the queue age agree                                                                     |
| FR-QO-06 | Show consumers, utilisation and prefetch                                                     | The consumer view matches the broker                                                                           |
| FR-QO-07 | Show a DLQ list and a DLQ detail with the same depth and rate fields                         | The DLQ view is not a separate, weaker view                                                                    |
| FR-QO-08 | Inspect a bounded page of messages without removing them                                     | A peek leaves the ready count unchanged; the delivery-count side effect is shown                               |
| FR-QO-09 | Filter messages by reason, queue, time, message id, correlation id, job type or subject hash | A bounded filter returns the expected page                                                                     |
| FR-QO-10 | Requeue selected messages to their source exchange and routing key                           | The message is published with confirms and the original is acknowledged; a publish failure leaves the original |
| FR-QO-11 | Move selected messages to an explicit exchange and routing key                               | The destination receives the message; the source loses it only after a confirmed publish                       |
| FR-QO-12 | Discard selected messages after a confirmation                                               | The message is removed; the audit records the payload hash                                                     |
| FR-QO-13 | Purge a queue only after consumers stop and a two-person confirmation                        | Ready messages are removed; unacknowledged messages are not silently counted as purged                         |
| FR-QO-14 | Pause and resume consumption with the scope stated                                           | A pause stops delivery; a resume restarts it; no message is lost                                               |
| FR-QO-15 | Run a bulk operation as a background job with progress and cancellation                      | The operation id reports progress and a partial result                                                         |
| FR-QO-16 | Provide a dry run for every destructive operation                                            | The dry run reports counts and targets, and changes nothing                                                    |
| FR-QO-17 | Make every mutating request idempotent by an Idempotency-Key                                 | A retry returns the same operation, not a second move                                                          |
| FR-QO-18 | Serialize mutating operations per queue                                                      | A second operation receives 409 until the first completes                                                      |
| FR-QO-19 | Audit every read of payload and every mutation                                               | The audit has actor, role, time, reason, queue, message id, counts and result                                  |
| FR-QO-20 | Enforce the role matrix on every endpoint                                                    | A viewer cannot get a message; an operator cannot purge                                                        |
| FR-QO-21 | Export a bounded statistics window or message list                                           | The export has the same redaction and permission rules                                                         |
| FR-QO-22 | Show broker and console health, and a degraded read mode                                     | A broker API failure shows stale data with a timestamp, not an empty queue                                     |
| FR-QO-23 | Use a production-safe move path, not the management get endpoint, for bulk                   | A bulk move with the management get disabled still works through the AMQP client                               |
| FR-QO-24 | Bound every page, preview, export and bulk batch                                             | A large DLQ cannot exhaust the console memory or the broker                                                    |
| FR-QO-25 | Record the operation journal before the first mutation and after the last                    | A console restart during a bulk operation can report the partial result                                        |

## Safety and atomicity

### Read paths

A statistics read is safe. A message read is not: the management get endpoint is a delivery, not a passive read. It is documented for development and troubleshooting, and a quorum queue can advance a delivery counter. The console must:

- use get with ack_requeue_true only for a bounded peek
- fetch a small count and never loop on the same queue
- show the delivery-count field and a warning when the queue is quorum
- prefer a dedicated read-only consumer or a mirrored stream for repeated inspection
- never use get in a polling dashboard

A payload read is an audit event. The audit records the message id and the payload hash, not the payload.

### Data protection

The console must not persist message payloads. A preview is rendered from the broker response and discarded. The audit stores message identifiers and payload hashes, not payloads. An export of message metadata carries the same redaction rules as the screen. A payload download is a separate permission, a separate audit event and a separate retention decision.

### Requeue, move and discard

The three operations are different and the console must not conflate them:

- Requeue in place: get with ack_requeue_true returns the message to the same queue, which for a DLQ is the DLQ. It is not a replay to the source. It can advance the delivery count.
- Replay to source: read the message, publish it to the source exchange and routing key with publisher confirms and mandatory routing, then acknowledge the original. It is not atomic; a crash after the publish and before the acknowledge produces a duplicate. The operation is at-least-once, not exactly once.
- Discard: get with ack_requeue_false removes the message. It is irreversible.

A move to an explicit destination follows the replay rule. The source exchange and routing key come from the message properties and the dead-letter history; the console must show the chosen destination before the operation and must not guess when the history is ambiguous.

The publish must use publisher confirms and the mandatory flag. A return or a nack means the message was not routed; the original must not be acknowledged. The operation journal records the message id, the destination, the confirm result and the original acknowledgement result. A duplicate is acceptable only when the consumer is idempotent; the console must state that condition.

### Purge and delete

A purge removes ready messages. It does not remove unacknowledged messages held by consumers. The console must pause or stop the consumers first, show the ready and unacknowledged counts, and require a typed confirmation, a reason and a second approver. A delete removes the queue and is a separate administrator operation with the same controls.

The console must offer a quarantine alternative to purge: move the messages to a quarantine queue or a stream with a retention limit, then purge only after the export is confirmed.

### Pause and resume

RabbitMQ's documented HTTP API does not expose a per-queue pause in the surface this specification targets. Pause is therefore an application-control action: stop the listener containers for the queue, or suspend listeners node-wide when the scope is explicitly node-wide. The console must show the scope, the affected consumers and the unacknowledged count, and must not claim that the broker queue is paused when only the application consumers are stopped.

If a deployed broker version adds a per-queue pause, the console can use it, but the audit and the scope statement remain. A pause must not drop messages; a resume must not start a duplicate consumer.

### Concurrency and operation journal

One mutating operation runs per queue at a time. The console acquires a lease keyed by the virtual host and queue, checks the queue's message and consumer counts against the values in the confirmation, and rejects the operation with 409 or 412 when the queue changed. A bulk operation holds the lease for its whole life.

The operation journal is an append-only record with a state machine: requested, validated, executing, partially failed, succeeded, failed or cancelled. The journal is written before the first mutation and updated after each batch. A console restart can resume or report the partial result; it must never silently restart a destructive batch.

### Bulk operations

A bulk requeue, move or discard runs as a background operation with:

- a bounded batch size
- a rate limit
- progress by message count and byte count
- a partial-failure list
- a cancel that stops after the current batch
- a result that separates succeeded, skipped, duplicated and failed

A full scan of a large DLQ through the management API is forbidden. The operation uses a bounded consumer or a paged read; the page size and the batch size are separate limits.

## API contract

The console API is a backend-for-frontend. The browser never holds broker credentials.

| Method | Path                                         | Purpose                              | Role                      |
| ------ | -------------------------------------------- | ------------------------------------ | ------------------------- |
| GET    | /api/queues                                  | Queue list with summary fields       | Viewer                    |
| GET    | /api/queues/{vhost}/{queue}                  | Queue detail and policy              | Viewer                    |
| GET    | /api/queues/{vhost}/{queue}/stats            | Throughput and latency over a window | Viewer                    |
| GET    | /api/queues/{vhost}/{queue}/messages         | Bounded message page with filters    | Operator                  |
| GET    | /api/operations/{id}                         | Operation progress and result        | Operator                  |
| POST   | /api/queues/{vhost}/{queue}/messages/requeue | Replay selected messages to source   | Operator                  |
| POST   | /api/queues/{vhost}/{queue}/messages/move    | Move selected messages               | Operator                  |
| POST   | /api/queues/{vhost}/{queue}/messages/discard | Discard selected messages            | Operator                  |
| POST   | /api/queues/{vhost}/{queue}/pause            | Stop consumption with scope          | Operator                  |
| POST   | /api/queues/{vhost}/{queue}/resume           | Resume consumption                   | Operator                  |
| POST   | /api/queues/{vhost}/{queue}/purge            | Purge ready messages                 | Administrator, two-person |
| DELETE | /api/queues/{vhost}/{queue}                  | Delete the queue                     | Administrator, two-person |
| GET    | /api/audit                                   | Audit query                          | Auditor                   |

Every mutating request carries:

- an Idempotency-Key
- a reason
- a dry-run flag, default true for destructive operations
- the expected message count or queue version
- a confirmation token for purge and delete

A bulk request returns 202 with an operation id. A synchronous single-message operation can return 200 with the result. A conflict returns 409; a failed precondition returns 412; a quota or rate refusal returns 429; a broker or console dependency failure returns 503. A problem document follows RFC 9457 and never includes the payload or the raw subject.

## UI requirements

The UI must:

- sort and filter the queue list by depth, age, consumers, DLQ flag and state
- show a data-freshness timestamp on every panel
- show a DLQ badge and a one-click filter to the DLQ
- pause auto-refresh while a mutation is in progress
- present a review screen with the queue, filter, count, destination and confirmation before a mutation
- show the operation progress and the partial-failure list
- link every operation to its audit record
- never render a message payload as HTML or execute a payload link
- hide a destructive action until the role permits it, and still enforce the role on the server
- support keyboard navigation and a readable contrast, because an operator uses it during an incident

## Non-functional requirements

| Id        | Requirement                                                                  | Verification                                    |
| --------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| NFR-QO-01 | Queue list p99 under 500 ms for a 1,000-queue fixture                        | A load test against a representative broker     |
| NFR-QO-02 | Data freshness at most 10 seconds for the live panels                        | A timestamp comparison                          |
| NFR-QO-03 | A mutating request is accepted within 1 second; the work runs asynchronously | A latency test                                  |
| NFR-QO-04 | The audit write is durable before a destructive operation starts             | A crash test between audit and mutation         |
| NFR-QO-05 | The console does not degrade broker or application throughput                | A broker load test with and without the console |
| NFR-QO-06 | A broker API failure shows stale data, not an empty queue                    | A fault injection                               |
| NFR-QO-07 | A console outage does not affect the application or the broker               | A shutdown test                                 |
| NFR-QO-08 | A bulk operation is bounded in memory, broker load and rate                  | A large-DLQ fixture                             |
| NFR-QO-09 | The console holds no broker administrator credential in the browser          | A credential scan and a network trace           |
| NFR-QO-10 | Payload, subject and token data are redacted from logs and metrics           | A log and metric scan                           |
| NFR-QO-11 | The audit record is immutable and retained for at least one year             | A retention policy check                        |
| NFR-QO-12 | Message payloads are not stored by the console; previews are transient       | A storage scan                                  |

## Documentation deliverables

The console is not complete without these documents:

- this requirements specification, with the requirement identifiers
- an OpenAPI contract for the console API, including the idempotency and precondition headers
- a provider adapter contract for the JMS administration API and the RabbitMQ management API
- a data dictionary for queue, consumer, message and metric fields
- a permission matrix mapping each console role to the broker tag and vhost permission
- an operator runbook for inspect, pause, replay, move, discard, purge and broker outage
- a recovery runbook for the operation journal and a partially completed bulk operation
- an acceptance test plan with fixtures, a large DLQ and fault injection
- an architecture decision record for build-versus-buy, move semantics, pause scope, retention and two-person approval
- a UI copy deck for destructive confirmations, because the wording is a safety control

## RIB feature mapping

| RIB glass-pane feature | Requirement        | RabbitMQ surface and constraint                                                                  |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| Queue statistics       | FR-QO-01, FR-QO-02 | GET /api/queues and /api/queues/{vhost}/{name}; the detail is the drill-down                     |
| Throughput             | FR-QO-03           | message_stats counters and rates; Prometheus for time series                                     |
| Latency                | FR-QO-04           | Not a broker metric; application timestamps and Micrometer observations                          |
| DLQ contents           | FR-QO-08, FR-QO-09 | Get is troubleshooting only; a dedicated AMQP consumer is the production path                    |
| Manual dequeue         | FR-QO-12           | Acknowledge without requeue; irreversible and audited                                            |
| Manual requeue         | FR-QO-10, FR-QO-11 | Republish with confirms, then acknowledge the original; at-least-once                            |
| Pause and resume       | FR-QO-14           | No documented per-queue broker pause in the target API; stop the application listener containers |
| Purge                  | FR-QO-13           | DELETE /api/queues/{vhost}/{name}/contents; ready messages only                                  |
| Audit                  | FR-QO-19           | Console journal and audit store; not a broker feature                                            |

## Spring JMS and Spring AMQP

Spring JMS is an application API over a JMS provider; Spring AMQP is an application API over AMQP and, in practice, RabbitMQ. Neither is a queue management API. The console sits above the provider's management surface, and the listener and template abstractions sit below it.

### Feature split

| Feature                               | Spring JMS                                               | Spring AMQP / RabbitMQ                                                          | Where the work sits                                                   |
| ------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Publish and consume                   | JmsTemplate, @JmsListener                                | RabbitTemplate, @RabbitListener                                                 | Built-in                                                              |
| Listener concurrency                  | DefaultMessageListenerContainer concurrency              | SimpleRabbitListenerContainerFactory concurrency                                | Configuration                                                         |
| Pause and resume                      | JmsListenerEndpointRegistry and container stop and start | RabbitListenerEndpointRegistry and container stop and start                     | Built-in application control; broker queue pause is provider-specific |
| Local transactions                    | JmsTransactionManager, sessionTransacted                 | RabbitTransactionManager, channelTransacted                                     | Built-in                                                              |
| Cross-resource transactions           | JTA and XA-capable JMS connection factory                | No XA with the database; outbox or best-effort synchronization                  | Custom                                                                |
| Message priority                      | JMSPriority 0-9, provider mapping                        | MessageProperties priority, RabbitMQ queue semantics                            | Configuration; fair share custom                                      |
| Selectors and filtering               | JMS selector                                             | No AMQP selector; headers exchange or stream filter                             | JMS built-in; AMQP custom routing                                     |
| Retry and backoff                     | ErrorHandler plus Spring Retry or provider redelivery    | RetryInterceptorBuilder and a recoverer                                         | JMS custom; AMQP built-in                                             |
| DLQ routing                           | Provider dead-letter or backout configuration            | Dead-letter exchange and recoverer                                              | JMS provider configuration; AMQP configuration                        |
| DLQ inspection                        | QueueBrowser and JmsTemplate.browse with provider limits | RabbitTemplate receive or execute, or the management get                        | Broker primitive plus custom UI                                       |
| Manual requeue and move               | Receive, send and commit; no standard move               | Get, publish with confirms, acknowledge; no standard move                       | Custom                                                                |
| Purge                                 | Provider administration                                  | AmqpAdmin.purgeQueue or the HTTP DELETE                                         | JMS custom; AMQP built-in primitive                                   |
| Queue statistics                      | Provider administration                                  | AmqpAdmin.getQueueInfo is limited; HTTP API and Prometheus are the full surface | Custom console                                                        |
| Throughput                            | Provider counters                                        | RabbitMQ message_stats and Prometheus                                           | Collector plus custom UI                                              |
| Latency                               | Not in JMS                                               | Not in the broker or Spring                                                     | Custom application instrumentation                                    |
| Per-subject fairness                  | Not provided; selectors and groups only                  | Not provided; headers and priority only                                         | Custom                                                                |
| RBAC, audit and four-eyes             | Not provided                                             | Not provided                                                                    | Custom                                                                |
| Operation journal and idempotent move | Not provided                                             | Not provided                                                                    | Custom                                                                |

Counted by feature rather than by effort: publish and consume, concurrency, local transactions, listener lifecycle and the priority primitive are built-in or configuration in both stacks. DLQ routing and retry are provider or Spring configuration on RabbitMQ, and provider configuration plus custom glue on JMS. Queue statistics, throughput, latency, requeue, audit and per-subject fairness are custom or provider-specific in both. The console is the custom half.

### Overrides and customizations

The listener and template layers are configured through extension points, not through large subclass trees:

- Spring JMS: JmsListenerContainerFactory, ErrorHandler, MessageConverter, TaskExecutor, BackOff, DestinationResolver, SessionAwareMessageListener and the JmsTemplate callbacks.
- Spring AMQP: SimpleRabbitListenerContainerFactory, MessageRecoverer, FatalExceptionStrategy, RabbitListenerConfigurer, RabbitAdmin, RabbitTemplate callbacks and MessagePostProcessor.

The console is a separate control plane. It is not a Spring JMS or Spring AMQP feature, and most of it is custom in both cases: the role model, audit, operation journal, redaction, pagination, two-person approval, API, UI, idempotent move and rate limits. RabbitMQ supplies more management primitives than a generic JMS provider, and Spring AMQP supplies AmqpAdmin plus the DLX and retry pieces; neither supplies a glass pane.

A JMS deployment still needs a provider-specific management adapter. A JMS QueueBrowser is not a management API: it cannot purge a queue, requeue a message to another destination or report rates. The same split applies to the data: RabbitMQ exposes queue counters and rates through one management API, while a JMS provider exposes its own administration API, if any.

The RabbitMQ JMS client is a separate JMS adapter over AMQP 1.0. It does not make the RabbitMQ management API a JMS API, and its feature coverage for selectors, transactions, XA and dead-lettering must be checked against its own matrix. The native Spring AMQP path is the one sbex uses.

The practical split is therefore: the application contract can be portable across Spring JMS and Spring AMQP, but the queue management console cannot. A deployment that needs both keeps the domain and job contract portable and implements two adapters: Spring JMS plus the provider's administration API, and Spring AMQP plus the RabbitMQ management API. The per-subject quota layer sits above both.

## Acceptance tests

| Id       | Scenario                                                       | Expected result                                                                          |
| -------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| AC-QO-01 | A fixture queue with known counts                              | The list and detail match the broker counts                                              |
| AC-QO-02 | A fixture with known publish and ack counters                  | The rates equal the counter delta over the window                                        |
| AC-QO-03 | A fixture with and without timestamps                          | Percentiles appear with timestamps; "not measured" appears without them                  |
| AC-QO-04 | A peek of five messages on a quorum queue                      | The ready count is unchanged; the delivery-count side effect is visible; no loop occurs  |
| AC-QO-05 | A replay whose publish confirms                                | The source receives one message and the original is acknowledged                         |
| AC-QO-06 | A replay whose publish is nacked or returned                   | The original remains in the DLQ; the operation reports the failure                       |
| AC-QO-07 | A replay whose acknowledgement fails after a confirmed publish | The operation reports a possible duplicate; the idempotency key protects the consumer    |
| AC-QO-08 | A purge with a viewer or one approver                          | The request is refused; the audit records the refusal                                    |
| AC-QO-09 | A viewer attempts a message get or a purge                     | The request is refused by the server                                                     |
| AC-QO-10 | A payload containing HTML and a script                         | The UI renders text, not executable content                                              |
| AC-QO-11 | A DLQ with 100,000 messages                                    | The page, export and bulk operation stay within the bounds; no full scan                 |
| AC-QO-12 | Two operators act on the same queue                            | The second receives 409 or 412; no interleaved purge                                     |
| AC-QO-13 | The broker API is down                                         | The console shows stale data with a timestamp and a degraded banner                      |
| AC-QO-14 | The console is down                                            | The application consumers and the broker continue                                        |
| AC-QO-15 | A pause is requested                                           | The scope is shown; consumers stop; no message is lost; resume restarts                  |
| AC-QO-16 | The console restarts during a bulk operation                   | The operation journal reports the partial result; no destructive batch restarts silently |

## Alternatives rejected

- **The RabbitMQ management UI alone.** It has no role-separated audit, no four-eyes control, no production-safe bulk move and no payload redaction contract.
- **Scripts with a broker administrator credential.** They are unaudited, over-privileged and impossible to review at incident speed.
- **An automatic DLQ replay consumer.** It loops a poison message and creates a new flood; replay is an operator decision.
- **Purge before consumers stop.** Unacknowledged messages remain and the operator believes the queue is empty.
- **The management get endpoint for bulk moves.** It is documented for troubleshooting and is inefficient for production; a dedicated AMQP client with confirms is the contract.
- **Payload or header editing in the console.** It breaks signatures, idempotency and the audit chain.
- **A queue per subject for the DLQ.** Queue and consumer state grow with the subject population; a bounded shard or a header is safer.
- **A full per-subject dashboard on broker metrics.** The label cardinality is unbounded; a top-K report or an audit query is the bounded form.
- **A broker-wide pause as the only pause.** It stops every queue, not the one under investigation.

## Open decisions

- Build the console or wrap the management UI with a governed backend.
- The operation journal store and its retention.
- The two-person approval mechanism and its timeout.
- The per-tenant isolation of the console and its audit.
- Whether streams are first-class in the console or only a DLQ retention target.
- The pause scope when the application has several listener containers for one queue.
- The exact broker permission required for get, purge and publish on the deployed RabbitMQ version; the deployment must test each action with the console's own user.

## References

- [RabbitMQ — HTTP API reference](https://www.rabbitmq.com/docs/http-api-reference)
- [RabbitMQ — management plugin](https://www.rabbitmq.com/docs/management) and [access control](https://www.rabbitmq.com/docs/access-control)
- [RabbitMQ — monitoring](https://www.rabbitmq.com/docs/monitoring) and [Prometheus](https://www.rabbitmq.com/docs/prometheus)
- [RabbitMQ — dead-lettering](https://www.rabbitmq.com/docs/dlx)
- [RabbitMQ — consumers and prefetch](https://www.rabbitmq.com/docs/consumers)
- [Spring AMQP — listener container](https://docs.spring.io/spring-amqp/reference/amqp/receiving-messages/async-consumer.html), [publisher confirms](https://docs.spring.io/spring-amqp/reference/amqp/template.html) and [transactions](https://docs.spring.io/spring-amqp/reference/amqp/transactions.html)
- [Spring Framework 7.0 — JMS](https://docs.spring.io/spring-framework/reference/7.0/integration/jms.html) and [Spring Boot 4.1 — JMS](https://docs.spring.io/spring-boot/4.1/reference/messaging/jms.html)
- [RabbitMQ JMS client](https://github.com/rabbitmq/rabbitmq-jms-client)
- [RFC 9457 — problem details](https://www.rfc-editor.org/rfc/rfc9457.html), [RFC 6585 — 429](https://www.rfc-editor.org/rfc/rfc6585) and [RFC 9110 — 503](https://www.rfc-editor.org/rfc/rfc9110.html#name-503-service-unavailable)
- [OpenID Connect Core — ID token](https://openid.net/specs/openid-connect-core-1_0.html#IDToken) (the console's SSO contract)
