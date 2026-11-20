---
id: sbex-tenant-fairness
type: submodule-design
status: draft
title: "sbex tenant fairness: per-subject quotas on the work-class model"
parent: sbex
depends-on: [sbex-resource-isolation]
references:
  [sbex, sbex-resource-isolation, sbex-messaging, sbex-persistence, sbex-observability, d193]
tags:
  ["jwt", "multi-tenancy", "fairness", "rate-limiting", "bulkhead", "quotas", "jms", "requirements"]
---

# Tenant fairness: per-subject quotas on the work-class model

This file specifies how one authenticated subject is prevented from consuming a whole work class's database connections, request slots, queue consumers or outbound connections. It layers per-subject rate, concurrency, pending-depth and fair-share limits on the work-class model in resource-isolation.md. It is a requirements and specification document: it defines the identity, quota model, enforcement points, failure modes, configuration contract and acceptance tests, not the implementation. It does not cover token issuance, authentication protocol details, billing, bot detection or the queue operations console; queue-operations.md owns that console.

## Status

Draft, unbuilt. No code implements this specification. The requirement identifiers are the unit of review; an implementation is conformant when every must-statement and acceptance criterion is met.

## Problem

A work-class cap is global. It stops the service from accepting more work than the class can serve, but it does not distinguish the subjects inside the class. One subject can open every request, submit every job or hold every outbound connection in the class, and every other subject waits behind it.

The failure is not one large request. It is many ordinary requests from one subject: 100 parallel HTTP calls, 1,000 queued jobs, 50 slow streams, or a loop that opens a new request as each previous one finishes. Each request is individually acceptable; the aggregate is a denial of service against everyone else.

A per-subject layer is the missing control. It must compose with the class cap rather than replace it: the class cap protects the service, and the subject cap protects the other subjects.

## Scope and non-goals

In scope:

- HTTP requests on the servlet and reactive stacks, after authentication.
- Jobs submitted to the job queues, including their producer and consumer sides.
- Subjects identified by a validated JWT, with a tenant or client hierarchy.
- Per-subject rate, concurrency, pending-depth and fair-share limits.
- Multi-replica enforcement and the failure modes of a shared quota store.
- Observability, audit and acceptance tests.

Out of scope:

- JWT issuance, key rotation and identity-provider operation.
- Billing, plan entitlement and commercial quota products.
- Per-IP, per-device or bot-detection limits, except as a separate outer layer.
- The queue and DLQ operations console; queue-operations.md owns it.
- The work-class priorities themselves; resource-isolation.md owns them.

## Identity: the quota principal

### Key derivation

A JWT subject is unique within its issuer, not across issuers (RFC 7519, section 4.1.2). The quota key must therefore include the issuer:

    quota_key = (iss, sub)

A multi-tenant deployment extends the key with the tenant claim:

    quota_key = (iss, tenant_id, sub)

The exact key is a policy decision. The requirements are:

- The deployment must validate the JWT signature, issuer, audience, expiration and not-before time before any quota decision.
- The deployment must derive the key from validated claims only. It must never trust a subject from a request header, a query parameter, a request body or an unverified token.
- The deployment must reject a request with no subject claim, or apply a named limited default. It must never map a missing subject to an unlimited quota.
- The deployment must treat the subject as case-sensitive and opaque. It must not normalize, trim or case-fold the value.
- The deployment must not use the token identifier (jti), the token itself, an email address or a username as the quota key. Token rotation must not reset a subject's quota, and a mutable profile attribute must not split or merge a subject's usage.

Spring Boot's OAuth2 resource-server configuration supplies the validated JWT and a configurable principal claim. The default principal claim is sub; a deployment with a different claim sets spring.security.oauth2.resourceserver.jwt.principal-claim-name and records the choice in its quota-key contract.

### Machine identities and shared accounts

The subject claim can identify a user, a client or a service. A service account is one quota principal, however many pods or tokens it uses. A shared service account therefore needs its own cap, and a deployment that wants per-client fairness must use the client identifier (azp or client_id) or a dedicated tenant claim.

A token can be minted for a short-lived job or a delegated user. The quota key follows the subject claim, not the token lifetime. A delegation model must state whether the delegate or the delegator owns the quota; the default is the subject that appears in the token presented to the service.

### Hierarchy

A deployment with tenants applies the limits at two levels:

    tenant_limit = min(tenant_cap, class_cap)
    subject_limit = min(subject_cap, tenant_remaining, class_remaining)

The tenant cap stops one tenant's many subjects from taking the class. The subject cap stops one subject inside the tenant. The effective limit is the minimum of the class, tenant and subject limits.

A deployment without tenants uses the subject limit alone and treats the tenant as a single implicit tenant.

### Privacy

The raw subject can be personal data. The requirements are:

- Metrics and logs carry a salted hash of the quota key, not the raw subject.
- The audit record can carry the raw subject, under a separate access control and retention policy.
- Error responses carry the quota decision and a retry time, not the subject, tenant or token.
- The hash salt is stable for the metric retention window and is not exposed to clients.

## The quota model

### Four independent limits

A single limit is not enough. The four limits below protect different resources, and all four must hold.

| Limit                 | What it protects                                                       | State per subject                   | Refusal           |
| --------------------- | ---------------------------------------------------------------------- | ----------------------------------- | ----------------- |
| Arrival rate          | CPU, network, request churn, database query rate                       | Token bucket: tokens, last refill   | 429               |
| In-flight concurrency | Database connections, request threads, consumers, outbound connections | Counter or semaphore                | 429 or 503        |
| Pending depth         | Broker disk, heap, queue age, backlog                                  | Pending count per subject and class | 429 at enqueue    |
| Fair share            | Other subjects' access to the class                                    | Active subject set, weights, floors | Queue, 429 or 503 |

The effective per-subject limit for a class is:

    effective = min(class_limit, tenant_limit, subject_limit, fair_share_limit)

The class limit is the global cap from resource-isolation.md. The tenant and subject limits are this document's layer. The fair-share limit is dynamic and depends on the other active subjects.

### Why all four limits

Each limit alone leaves a hole:

- A rate limit without a concurrency limit lets a slow request hold a connection for as long as it waits. The subject stays under its request rate and still owns the pool.
- A concurrency limit without a rate limit lets a subject churn short requests, consuming CPU and database query capacity without holding a connection.
- A concurrency limit without a pending-depth limit lets a subject queue an unbounded job backlog in the broker or the heap.
- All three without a fair share let one subject use the whole class cap while other subjects are active. The cap is respected; the other subjects are still starved.
- A fair share without a cap lets a subject borrow all idle capacity and then hold it when another subject arrives. The arriving subject waits for the whole borrow to drain.

### Admission order

The admission gate acquires permits in a fixed order and releases them in reverse order. The order must be documented and enforced by one component, or two code paths will deadlock differently.

    subject rate token -> subject concurrency permit -> tenant permit -> class permit

The subject permits come first so a subject that is over its own limit cannot hold a class permit while it waits. The class permit comes last because it is the shared, scarcest resource. Every acquisition is bounded by a wait deadline; a thread must not hold a permit while it waits without a bound.

A sequential permit order is a deadlock and head-of-line hazard when the tenant and class caps interact: a subject can hold a shared tenant permit while it waits for a class permit. The preferred mechanism is one reservation under one lock, or one fair-queue scheduler, that checks every predicate and reserves every slot atomically. If the implementation uses sequential permits, it must prove that no subject can hold a shared tenant or class permit while waiting for a narrower one. That proof depends on the caps and the number of active subjects, not on a fixed ordering rule. The contract is the predicate, not the mechanism:

- A request is admitted only when its subject rate, subject concurrency, tenant and class limits all allow it.
- A request never holds a class permit while it waits for a subject limit.
- A request releases every permit it acquired, including on cancellation, timeout and error.

A request that needs more than one database connection must declare a connection budget. The default is one connection per request. A request that opens a second transaction with REQUIRES_NEW or a nested connection takes a second connection from the same class pool and must count against the subject's concurrency and the per-request budget. A deployment that cannot bound the connections per request cannot guarantee the pool cap.

### Fair share

Fair share has two policies, and the deployment must name the one it uses per class.

Strict cap: the subject can never hold more than its share, even when it is the only active subject.

    share = floor(class_capacity * max_share)
    share = max(share, min_floor)
    share = min(share, max_ceiling)

max_ceiling is an optional absolute cap; the effective ceiling is the smaller of the fractional share and the absolute cap.

Contention-aware cap: a subject can use idle capacity, but when another subject is waiting, new acquisitions are limited to the computed share. Existing requests are not preempted; the arriving subject waits for a connection to be released.

Borrowing: idle capacity is borrowed by a subject, and the borrower must yield at the next admission boundary when the owner returns. Borrowing is acceptable for batch work and dangerous for interactive work, because the yield is not immediate.

The default recommendation is:

- Interactive classes use a strict cap. The latency SLO is the reason the class exists, and a borrower cannot be preempted mid-request.
- Batch classes can use contention-aware caps or borrowing. A batch job yields between bounded work units, and the existing archive batch size is the yield boundary.
- Every active subject gets a floor of at least one connection, one request slot or one consumer, provided the sum of floors does not exceed the class capacity. The boot-time budget check must reject a configuration whose floors exceed capacity.

A fair share can be implemented as weighted fair queueing or deficit round robin over per-subject queues. The weights follow the subject's tier within the class; the work-class priority already separates the classes. The scheduler must skip empty queues, cap the in-flight work per subject, and age a request that waits longer than the class's maximum wait.

### Worked numbers

The numbers below are illustrative. They belong in the pool-budget and quota-budget checks, not in prose that pretends to be a measurement.

| Resource             | Class capacity | Subject cap | Fair share     | Consequence                                                                               |
| -------------------- | -------------- | ----------- | -------------- | ----------------------------------------------------------------------------------------- |
| Database connections | 10             | 2           | 20 percent     | One subject holds at most 2; five subjects can progress; a sixth waits or is refused      |
| HTTP admission       | 20             | 4           | 20 percent     | One subject holds at most 4 request slots; 100 parallel calls leave 96 waiting or refused |
| Job workers          | 8              | 2           | 25 percent     | One subject holds at most 2 workers; a 1,000-job backlog cannot occupy the other 6        |
| Outbound connections | 64             | 8           | 12.5 percent   | One subject holds at most 8 connections to a downstream                                   |
| Job pending depth    | 1,000 total    | 100         | Not applicable | The 101st queued job from one subject is refused at enqueue                               |

The database row is the direct answer to the connection question: a subject cannot use all connections because its concurrency cap is lower than the pool and its fair share is a fraction of the pool. The request that would use the third connection waits or receives 429.

## HTTP enforcement

### Placement

The gate runs after authentication and before the controller. The servlet stack uses a filter ordered after the security filter chain; the reactive stack uses a WebFilter after the security web filter chain. The gate must not run before authentication, because an unauthenticated request has no trustworthy subject.

The gate performs these steps in order:

1. Read the validated subject, tenant and work class.
2. Check the subject's arrival-rate token.
3. Acquire the subject's concurrency permit with the class's wait deadline.
4. Acquire the tenant and class permits.
5. Run the request.
6. Release every permit in reverse order, including on timeout, cancellation and error.

A refusal at step 2 or 3 is a subject quota refusal: 429. A refusal at step 4 is a class capacity refusal: 503. A request that would exceed both returns the subject refusal, because the subject's own quota is the actionable limit.

### Asynchronous and streaming requests

The permit must be held until the response completes, not until the controller method returns. The servlet stack releases the permit in an AsyncListener on complete, error and timeout, or in a wrapper around the streaming body. The reactive stack releases it in doFinally on the response chain. A permit released when the request thread returns lets a slow client hold an unbounded number of streams while the subject's counter shows one.

A long-lived connection, a websocket or a server-sent event stream counts as one in-flight request for the whole life of the connection. A separate per-subject cap for long-lived connections is allowed and recommended; it must not be the same counter as short requests, or one idle websocket can exhaust the short-request quota.

### Request-level budgets

The per-request connection budget is part of the concurrency limit. A request that starts a second transaction, a nested connection or a parallel database query takes more than one connection from the class pool; the subject's permit must account for it, or the pool can be exhausted by a few requests that each hold several connections.

The same rule applies to outbound HTTP. A request that fans out to several downstream calls holds one connection per concurrent call; the subject's outbound bulkhead must count the calls, not the parent request.

### Response contract

A subject quota refusal returns 429 Too Many Requests with a Retry-After header. The response body is an RFC 9457 problem document with:

- type: a stable URI such as https://sbex.example/problems/subject-quota
- title: a short human-readable title
- status: 429
- detail: the limit that was hit, without the raw subject
- retryAfter: the same value as the header, in seconds

A class capacity refusal returns 503 Service Unavailable with Retry-After and a problem type such as https://sbex.example/problems/overloaded. The two responses must be distinguishable, because a client retries a subject quota after a longer delay and treats a class refusal as a shared service condition.

The deployment can send the IETF RateLimit header fields (RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset) in addition to Retry-After. They are advisory; the 429 status and Retry-After are the contract. The IETF document is a draft at the time of this specification, so the deployment must not make a client depend on the header names without a versioned contract.

### Priority interaction

The subject limit applies inside the work class. A CRITICAL subject gets the CRITICAL class's capacity, not the whole service's capacity, and it still has a subject cap. A subject cannot use the CRITICAL class to escape its own limit.

A single subject can hold at most its share of the CRITICAL class, its share of the INTERACTIVE class and its share of the BACKGROUND class; the sum across classes must also be capped by a per-subject global limit. Without the global limit, a subject can take one share of every class and still dominate the process.

## Job enforcement

### Job ownership

Every job carries an owner: the quota key of the subject that caused the job. The owner is derived from the authenticated request that enqueued the job, not from a request body field. If a job is created by a scheduler or an internal process, the owner is a named system principal with its own quota, not the last user who touched the data.

The job metadata must carry:

- issuer and subject, or a signed reference to the quota key
- tenant, when the deployment has tenants
- work class
- creation time and maximum age
- job type
- idempotency key
- replay marker and replay count, when the job is a replay

The consumer must validate the owner metadata against the trusted producer or the signed envelope. A job that arrives with no owner is a producer defect; the consumer must route it to a named system quota or a quarantine queue, not to an unlimited quota.

### Producer limits

The enqueue path enforces the subject's arrival rate and pending depth. A subject with 1,000 pending jobs cannot add the 1,001st; the producer returns 429 or a deferred response with a retry time. The pending count is per subject per class, and the deployment can add a per-tenant count.

The pending count must be durable enough to survive a pod restart. An in-memory count that resets on deploy lets a subject refill the queue after every rollout. The broker's queue depth is the durable count when the queues are per type; a per-subject count needs a store or a header-based aggregate.

### Consumer fairness

A single subject's jobs must not occupy every worker. The consumer side enforces:

- a per-subject in-flight cap, strictly lower than the class worker count
- a fair dispatch order across subjects
- a maximum age, so a stale job is not started
- a per-subject pending check before the job starts, so a backlog that grew while the consumer was down does not start all at once

The queue topology determines how much fairness the broker can provide. The table below is the decision surface.

| Topology                                                   | Fairness                                                | Cost                                   | Use                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| One FIFO queue for all subjects                            | None; one subject's backlog at the head blocks the rest | Lowest                                 | Never for a multi-subject queue                              |
| One queue per job type                                     | Fair across types, not across subjects inside a type    | Low                                    | The baseline from resource-isolation.md                      |
| Sharded queues by hash of the quota key                    | A hot subject hits one shard; other shards continue     | A fixed number of queues and consumers | The default for a multi-subject job type                     |
| One queue per subject                                      | Strong fairness                                         | Queue explosion and broker overhead    | Only for a contracted, bounded tenant set                    |
| Database job table with SKIP LOCKED and a per-subject rank | Strong fairness and a queryable audit                   | Database load and a schema             | A deployment that already owns the job state in the database |

RabbitMQ does not provide a native fair queue keyed by an arbitrary message header. A deployment that uses RabbitMQ must choose a sharded topology or a dispatcher that reads per-subject queues in a fair order. Increasing prefetch does not create fairness; a large prefetch lets one consumer hold a batch from one subject and delay the rest.

The per-subject in-flight cap must be lower than the number of workers that serve the class. If the class has eight workers and one subject can hold eight, the subject can occupy the class; a cap of two leaves six for the rest. The fair-share limit is a second guard for the case where many subjects are active.

### Dead letter interaction

A DLQ is per job type, not per subject. A subject does not get a private DLQ; the message headers carry the owner for triage. The DLQ replay path uses a system principal with its own rate limit, and the replayed job keeps the original owner for accounting and priority. A replay must not bypass the subject's in-flight cap once the job starts; the replay rate is limited separately so an operator cannot turn a repair into a new flood.

## JMS and AMQP portability

Spring JMS and Spring AMQP both supply the publish, consume and listener-lifecycle primitives that carry an owner header, but neither supplies a per-subject fair scheduler. JMS selectors and message groups, and AMQP headers and priority, are routing primitives; they filter or order messages, they do not enforce a rate, a concurrency cap, a pending-depth cap or a fair share.

The quota layer therefore sits above both stacks. The job topology stays provider-specific: a JMS provider needs its own queue and DLQ configuration, and RabbitMQ needs the sharded-queue or dispatcher topology in this document. A provider-neutral quota model is possible; a provider-neutral queue topology is not.

## Distributed enforcement

A per-instance limit is not a global limit. With R replicas, a local cap of N allows up to N times R concurrent operations across the service. The deployment must state which of the following it uses:

- Local only: each replica enforces N; the global ceiling is N times R. The failure mode is a fixed overcommit; the capacity budget must include it.
- Shared store: a Redis or database counter enforces the global limit. The store is on the hot path and becomes a dependency; the deployment must define its failure mode.
- Gateway: an API gateway or service mesh enforces the arrival rate and coarse quota; the application enforces the concurrency and fair share locally.
- Sticky routing: a consistent hash sends a subject to one replica, so a local cap is effectively a global cap for that subject. Rescheduling, scaling and pod failure move the subject and require a handoff.

The recommended composition is a gateway for coarse arrival-rate quotas, a shared store for tenant and subject concurrency where the limit must be global, and local fair-share and queue-depth limits as the backstop. A shared store that fails must not fail every request; the local limits continue, and the deployment records the degraded mode.

The failure mode is per limit, not global:

| Limit               | Shared store unavailable                   | Rationale                                      |
| ------------------- | ------------------------------------------ | ---------------------------------------------- |
| Arrival rate        | Fall back to the local rate, mark degraded | A missing rate limit must not stop all traffic |
| Subject concurrency | Fall back to the local cap, mark degraded  | The local cap is a safe lower bound            |
| Tenant concurrency  | Fall back to the local cap, mark degraded  | The local cap cannot exceed the tenant cap     |
| Queue depth         | Fail closed                                | An unbounded backlog is worse than a refusal   |
| Fair share          | Fall back to the last known shares         | A stale share is better than no fairness       |

The clock for a token bucket is monotonic per instance; a shared store uses the store's server time or a bounded clock skew. The deployment must document the skew and the refill behavior at the boundary.

A rolling update runs old and new pods together for the duration of the surge. The per-instance cap must be computed for the surge count, or the budget check must include the surge factor, as resource-isolation.md requires for database connections.

## State and cardinality

Per-subject state is unbounded by default. A public issuer can mint a large number of subjects, and an in-memory map of subject to token bucket grows without limit. The requirements are:

- The state store has a maximum entry count, a time-to-live and an eviction policy.
- An evicted active subject starts a fresh bucket; the deployment must accept that a long-idle subject loses its burst credit and that an active subject is not evicted while it holds a permit.
- A sharded queue topology has a fixed shard count chosen at deployment time; the hash includes the issuer and the subject.
- Metrics never carry the raw subject. The metric label is a salted hash or a bounded tenant label; a per-subject breakdown is a separate top-K report, not a metric.
- A top-K report is bounded by count and retention; a full per-subject table is an audit query, not a dashboard.

## Configuration contract

The configuration keys below are the contract. The implementation must bind them to a validated configuration record and fail the boot on an invalid value.

| Key                                           | Meaning                                | Default                            | Validation                                       |
| --------------------------------------------- | -------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| sbex.quota.key.claims                         | Ordered claims that form the quota key | iss, sub                           | Must include iss and sub, or a named tenant key  |
| sbex.quota.key.tenant-claim                   | Tenant claim name                      | none                               | Optional; when set, the tenant hierarchy applies |
| sbex.quota.key.unknown-policy                 | Behavior for a missing subject         | reject                             | reject or a named limited default                |
| sbex.quota.hash.salt                          | Salt for metric and log hashes         | required                           | Non-empty; not a secret shared with clients      |
| sbex.quota.class.CLASS.subject.max-concurrent | In-flight subject cap                  | class-specific                     | At least 1; less than the class concurrency      |
| sbex.quota.class.CLASS.subject.rate           | Subject arrival rate                   | class-specific                     | Positive; unit per second or minute              |
| sbex.quota.class.CLASS.subject.burst          | Token bucket capacity                  | class-specific                     | At least 1                                       |
| sbex.quota.class.CLASS.subject.pending-depth  | Pending job or request count           | class-specific                     | At least 1                                       |
| sbex.quota.class.CLASS.subject.max-share      | Maximum fraction of the class          | 0.2 for interactive, 0.5 for batch | Greater than 0; at most 1                        |
| sbex.quota.class.CLASS.subject.max-ceiling    | Absolute per-subject cap               | class capacity                     | At least min-floor                               |
| sbex.quota.class.CLASS.subject.min-floor      | Guaranteed share for an active subject | 1                                  | At least 1; the sum of floors must fit the class |
| sbex.quota.class.CLASS.subject.borrow-idle    | Allow idle capacity borrowing          | false for interactive              | Boolean                                          |
| sbex.quota.class.CLASS.subject.max-wait       | Maximum admission wait                 | class-specific                     | Not greater than the request deadline            |
| sbex.quota.store                              | local, redis, gateway or hybrid        | local                              | Named value                                      |
| sbex.quota.fail-mode                          | Degraded behavior                      | local                              | Named value; queue depth fails closed            |

The boot-time validation must check:

- each max-share is greater than 0 and at most 1
- each min-floor is not greater than its max-share ceiling
- the sum of the subject floors does not exceed the class capacity
- a subject cap does not exceed the class cap
- a tenant cap does not exceed the class cap
- a shared-store configuration has a documented failure mode
- the unknown-subject policy is never unlimited

A break-glass override can raise one subject's limit for a bounded time. The override must require an authenticated operator, a reason, an expiration, and an audit record. The override must not disable the class cap, the queue-depth limit or the DLQ limit.

## Observability and audit

The quota layer must expose:

- admitted, refused and degraded counters, tagged by work class and reason
- in-flight and pending gauges, tagged by work class and tenant (never by raw subject)
- admission wait time, by work class
- token bucket remaining, by work class and a bounded subject bucket
- fair-share value and active subject count, by work class
- shared-store latency and error rate
- top-K subjects by refusal, by in-flight and by pending depth

A raw subject in a metric label is forbidden: it is unbounded cardinality and personal data. The top-K report is a bounded query over an audit store or a time-series store with a retention policy.

The audit record for a quota decision carries the hashed key, the tenant, the work class, the limit, the observed value, the decision, the retry time and the request or job identifier. It does not carry the token, the raw subject or the payload. A configuration change or a break-glass override is an audit event with the operator identity and the reason.

Alert on:

- a subject at its cap for a sustained window
- a refusal rate above the class baseline
- a tenant at its cap
- a shared-store error rate
- a queue depth at its cap
- a fair-share value that stays at the floor while subjects wait

## Documentation deliverables

The implementation is not complete without these documents:

- this requirements specification, with the requirement identifiers
- a quota-key contract: claims, tenant hierarchy, unknown-subject policy and hash salt
- a per-class quota table: rate, burst, concurrency, pending depth, share, floor and wait
- a client error contract: 429 and 503 problem types, Retry-After and the optional RateLimit headers
- a failure-mode matrix: local, gateway, shared store and degraded behavior per limit
- a metric dictionary: names, labels, cardinality and retention
- a test plan derived from the acceptance criteria, plus the load and fault tests
- an operations runbook: override, degraded mode and alert response

## Requirements

### Functional requirements

| Id       | Requirement                                                                                                                                                            | Verification                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| FR-TF-01 | Derive the quota key from validated issuer and subject claims; reject a missing subject under the configured policy                                                    | A token with no sub is rejected; two issuers with the same sub are distinct                  |
| FR-TF-02 | Ignore subject, tenant and priority headers that are not backed by the validated token                                                                                 | A spoofed header does not change the quota key or the decision                               |
| FR-TF-03 | Enforce an arrival-rate token bucket per subject per class                                                                                                             | A burst above the bucket returns 429 with Retry-After                                        |
| FR-TF-04 | Enforce an in-flight concurrency cap per subject per class                                                                                                             | A subject never holds more than the cap in flight                                            |
| FR-TF-05 | Enforce a pending-depth cap per subject per class                                                                                                                      | A subject cannot enqueue beyond the cap                                                      |
| FR-TF-06 | Enforce a fair share with a floor and a ceiling per class; under contention no subject exceeds its share, and a borrowing policy yields at the next admission boundary | An active subject receives at least the floor; no subject exceeds its share under contention |
| FR-TF-07 | Apply the tenant cap and the subject cap in a hierarchy                                                                                                                | One tenant cannot take the class; one subject cannot take the tenant                         |
| FR-TF-08 | Return 429 for a subject quota and 503 for a class capacity                                                                                                            | The status, Retry-After and problem type differ                                              |
| FR-TF-09 | Hold a permit until an async or streaming response completes                                                                                                           | A slow stream holds one permit, not zero                                                     |
| FR-TF-10 | Derive job ownership from the authenticated producer, not the job body                                                                                                 | A forged owner in the body is ignored or rejected                                            |
| FR-TF-11 | Enforce per-subject job concurrency, pending depth and fair dispatch                                                                                                   | One subject's 1,000 jobs do not occupy every worker                                          |
| FR-TF-12 | State the local, gateway, shared-store or sticky-routing enforcement mode                                                                                              | The deployment document names the global ceiling                                             |
| FR-TF-13 | Define the degraded mode per limit                                                                                                                                     | A store outage does not disable the queue-depth limit                                        |
| FR-TF-14 | Bound the quota state with a size, TTL and eviction policy                                                                                                             | A synthetic high-cardinality load does not grow memory without limit                         |
| FR-TF-15 | Hash the subject in metrics and logs; keep the raw subject only in audit                                                                                               | A metric scrape contains no raw subject                                                      |
| FR-TF-16 | Audit configuration changes, overrides and quota decisions                                                                                                             | The audit record has operator, reason, time and decision                                     |
| FR-TF-17 | Bound a break-glass override by operator, reason and expiry                                                                                                            | An expired override stops applying                                                           |
| FR-TF-18 | Validate the quota configuration at boot                                                                                                                               | An over-budget floor or an unlimited default fails the boot                                  |
| FR-TF-19 | Rate-limit a DLQ replay separately and keep the original owner                                                                                                         | A replay cannot become a new subject flood                                                   |
| FR-TF-20 | Never map an unknown subject to an unlimited quota                                                                                                                     | The unknown policy is reject or a named limited default                                      |

### Non-functional requirements

| Id        | Requirement                                                    | Verification                                             |
| --------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| NFR-TF-01 | The local quota decision adds at most 2 ms at p99              | A benchmark with a warm bucket and a warm permit         |
| NFR-TF-02 | Quota state is bounded in memory and in the store              | A load test with many synthetic subjects                 |
| NFR-TF-03 | A shared-store outage degrades; it does not fail every request | A fault injection on the store                           |
| NFR-TF-04 | The quota layer does not become a single point of failure      | A replica failure and a store failure are separate tests |
| NFR-TF-05 | The quota decisions are reproducible under a fixed clock       | A token-bucket test with a fixed clock                   |
| NFR-TF-06 | The subject key is never logged raw outside the audit store    | A log scan                                               |
| NFR-TF-07 | The configuration is validated at boot and on change           | A bad value fails with the property name                 |
| NFR-TF-08 | The behavior is identical on the servlet and reactive stacks   | A shared acceptance suite for both                       |
| NFR-TF-09 | The behavior is testable without a real identity provider      | A test token or a signed fixture                         |
| NFR-TF-10 | The limit semantics are documented for clients                 | A stable problem type and Retry-After contract           |

### Acceptance criteria

| Id       | Scenario                                                                                   | Expected result                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| AC-TF-01 | One subject sends 100 parallel HTTP requests; the subject cap is 2 and the class cap is 20 | At most 2 are in flight; the rest receive 429 within the admission deadline; another subject's p99 stays inside its SLO |
| AC-TF-02 | One subject submits 1,000 jobs; the subject pending cap is 100 and the worker cap is 2     | 100 are queued, 900 are refused; at most 2 run; another subject's 10 jobs complete inside the SLO                       |
| AC-TF-03 | Two issuers mint the same sub                                                              | The two subjects have separate quotas                                                                                   |
| AC-TF-04 | A client sends a forged subject header                                                     | The header is ignored; the validated token's subject is used                                                            |
| AC-TF-05 | The shared quota store is unavailable                                                      | The local caps apply; the service returns 429/503, not 500                                                              |
| AC-TF-06 | A token is rotated for the same subject                                                    | The quota continues from the same bucket; the rotation does not reset it                                                |
| AC-TF-07 | A streaming response runs for 60 seconds                                                   | The subject holds one permit for the whole stream                                                                       |
| AC-TF-08 | A quota decision is logged and scraped                                                     | The metric and log carry a hash, not the raw subject                                                                    |
| AC-TF-09 | An operator raises a subject limit for 10 minutes                                          | The override applies for 10 minutes, is audited, and expires                                                            |
| AC-TF-10 | A DLQ replay runs at the operator's rate                                                   | The replay is rate-limited and the original owner is recorded                                                           |

## Alternatives rejected

- **Per-IP limits only.** A subject behind a shared NAT, a mobile network or a proxy shares an IP with many other subjects; the limit punishes the wrong principal. IP limits can sit outside this layer, not replace it.
- **Per-token limits.** Token rotation and multiple sessions would reset or multiply the quota. The subject is the stable identity.
- **One global limit.** The class cap already exists; a global subject limit does not stop one subject from taking a class.
- **Thread priority or request priority only.** A higher thread priority does not free a connection and does not stop a subject from holding every permit.
- **A client-supplied priority or quota header.** A public caller can claim any value; the quota key comes from the validated token.
- **One queue per subject for every subject.** Queue and consumer state grow with the subject population; a bounded shard count or a database claim query is safer.
- **Local limits only with no stated global ceiling.** The deployment silently allows N times R; the budget must state the overcommit.
- **Fail-open for every limit.** A queue-depth limit that fails open turns a store outage into an unbounded backlog.
- **A per-subject connection pool for every subject.** The database cannot carry a pool per user; the subject cap and fair share are the scalable form.

## Open decisions

- Strict cap or contention-aware cap for each work class.
- Local, gateway, shared store or hybrid enforcement for each limit.
- The shard count for job queues and the hash salt.
- The tenant claim and the delegated-user ownership rule.
- The top-K report retention and the audit retention.
- Whether a subject's cross-class total is a separate cap or the sum of the class caps.

## References

- [RFC 7519 — JWT, section 4.1.2](https://www.rfc-editor.org/rfc/rfc7519#section-4.1.2) (sub is unique within an issuer)
- [Spring Security — OAuth2 resource server JWT](https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/jwt.html)
- [Spring Boot 4.1 — OAuth2 resource server](https://docs.spring.io/spring-boot/4.1/reference/security/oauth2.html)
- [RFC 2697 — single-rate token bucket](https://www.rfc-editor.org/rfc/rfc2697) and [RFC 2698 — two-rate token bucket](https://www.rfc-editor.org/rfc/rfc2698)
- [Linux tc-drr(8) — deficit round robin](https://man7.org/linux/man-pages/man8/tc-drr.8.html)
- [RFC 6585 — 429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585) and [RFC 9110 — 503 Service Unavailable](https://www.rfc-editor.org/rfc/rfc9110.html#name-503-service-unavailable)
- [RFC 9457 — problem details](https://www.rfc-editor.org/rfc/rfc9457.html)
- [IETF RateLimit header fields draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)
- [Resilience4j — bulkhead](https://resilience4j.readme.io/docs/bulkhead) (the concurrency primitive, when the implementation uses it)
- [Bucket4j](https://bucket4j.com/) (the token-bucket primitive, when the implementation uses it)
- [RabbitMQ — consumers and prefetch](https://www.rabbitmq.com/docs/consumers) (why a large prefetch defeats fair dispatch)
