---
id: d193
type: module-design
status: active
title: "d193 — sbex on Spring Boot 4.1.2: the migration, and the changes that were not renames"
parent: sbex
references: [sbex, spec-graph-standard]
tags: ["spring-boot", "migration", "dependencies", "sbex"]
---

# d193 — sbex on Spring Boot 4.1.2

This record is the account of moving `sbex` from its Spring Boot 3.5.16 pin onto 4.1.2, which was the current stable patch when the move happened. It carries what broke, why each break was invisible to the compiler or to the previous doc set, the versions the new pin resolves, and the evidence that the moved tree works. It is not a property reference — the unit's own docs state the rules and link the vendor page that owns each one (`spec-graph-standard`) — and it is not a recommendation to move any other tree. The reader is an engineer taking a Boot service across the 3.x→4.x line, or one asking why the example's docs name 4.1 facts where they used to name 3.5 ones.

## Problem

The 3.5.16 pin was not unsupported: at the time of the record Boot published 3.5.16, 4.0.9 and 4.1.2 as its supported lines. It was superseded. The example's job is to teach the current line, and every `docs.spring.io` link carried `/3.5/` so that the prose, the code and the reference described one release — a property worth keeping, which is what made the pin a single visible decision rather than a scatter of stale links.

Bumping it exposed three kinds of rot at once:

- **breaks that compile.** Boot 4 auto-configures Jackson 3; a Jackson 2 `ObjectMapper` parameter builds cleanly and then refuses to start, because no such bean exists.
- **breaks that fail the build.** Testcontainers 2 renamed every module; the Boot 4 slice-test annotations and their starters moved out of `spring-boot-starter-test`; one AMQP auto-configuration class changed package.
- **claims that were never true.** Three properties in the docs and the two `application.yml` files did not exist on any Boot version, so they bound nowhere and silently left a default in force.

A fourth class is what makes this a migration rather than a rename: Boot 4 restructured where behaviour lives (the OTLP configuration namespace, the reactive HTTP clients, the native-image floor), so a doc that merely renamed a property would still describe the wrong component.

## Decision

The unit pins Spring Boot 4.1.2 and Java 21. The living docs describe that one release — no per-claim version columns and no forked per-version doc tree — and this record owns the deltas and the versions. The code, the two `application.yml` files, the `Containerfile` and the reference links moved in the same change, so the tree never carried a mixed-generation state.

## What broke, and what it took

| Break                                        | Symptom                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Testcontainers 2 module rename               | `'dependencies.dependency.version' for org.testcontainers:junit-jupiter:jar is missing` at project read — the bare `junit-jupiter`/`postgresql`/`oracle-xe` artifacts stop at 1.x | `testcontainers-junit-jupiter`, `testcontainers-postgresql`, `testcontainers-oracle-xe`, versions still from the BOM's `testcontainers-bom` import                                                                                                                                  |
| Jackson 3 is the configured mapper           | compiles, then `Parameter 0 of method payloadConverter ... required a bean of type 'com.fasterxml.jackson.databind.ObjectMapper' that could not be found`                         | `JacksonJsonMessageConverter` over Boot's `tools.jackson.databind.json.JsonMapper`, and the `tools.jackson.core:jackson-databind` dependency. `Jackson2JsonMessageConverter` is deprecated for removal; `spring-boot-jackson2` is the compat module that would restore the old bean |
| `CorrelationData.Confirm` became a record    | `isAck()` and `getReason()` deprecated for removal, warnings only                                                                                                                 | `ack()` and `reason()`                                                                                                                                                                                                                                                              |
| Slice tests left the test starter            | `org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest` does not exist                                                                                               | `org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest` plus `spring-boot-starter-webmvc-test`; `org.springframework.boot.webflux.test.autoconfigure.WebFluxTest` plus `spring-boot-starter-webflux-test`                                                                   |
| AMQP auto-configuration moved                | `package org.springframework.boot.autoconfigure.amqp does not exist`                                                                                                              | `org.springframework.boot.amqp.autoconfigure.SimpleRabbitListenerContainerFactoryConfigurer`                                                                                                                                                                                        |
| `WebClient.Builder` left the webflux starter | `required a bean of type 'org.springframework.web.reactive.function.client.WebClient$Builder'` at boot                                                                            | `spring-boot-starter-webclient`, and `DownstreamClient` now clones that builder so the call is observed and the trace context propagates                                                                                                                                            |
| `spring-boot-starter-web` deprecated         | silent; the POM description names the successor                                                                                                                                   | `spring-boot-starter-webmvc`                                                                                                                                                                                                                                                        |
| OTLP configuration namespace moved           | properties bind nowhere                                                                                                                                                           | `spring-boot-starter-opentelemetry` with `management.opentelemetry.tracing.export.otlp.*`, `management.opentelemetry.logging.export.otlp.*` and `management.opentelemetry.resource-attributes.*`; metrics keep `management.otlp.metrics.export.url`                                 |
| Native floor rose                            | a `ghcr.io/graalvm/native-image-community:21` stage builds against an unsupported floor                                                                                           | GraalVM 25 and above; the `Containerfile` pins `:25`                                                                                                                                                                                                                                |
| The CDS page was folded away                 | `/spring-boot/4.1/reference/packaging/class-data-sharing.html` answers 404                                                                                                        | `memory.md` points at `reference/packaging/aot-cache.html`, which carries both variants                                                                                                                                                                                             |

## Three properties that never existed

The bump did not cause these, and no version bump would have fixed them:

- `spring.datasource.hikari.maximum-lifetime` (`application.yml`, both apps) is not Hikari's name and never was: the property is `max-lifetime`. The intended ten-minute connection cap bound nowhere, so the pool ran at Hikari's thirty-minute default.
- `management.otlp.metrics.endpoint` was wrong on 3.5 too; Micrometer's OTLP registry takes `management.otlp.metrics.export.url`.
- `reactor.schedulers.defaultBoundedElasticMaxPendingCapacity` does not exist; Reactor's bound on the offload queue is `defaultBoundedElasticQueueSize` (`servlet-vs-reactive.md`).

Two prose typos were corrected in the same pass: `spring.jpa.auto` for `spring.jpa.hibernate.ddl-auto`, and `@DataJptest` for `@DataJpaTest`, which now lives in `org.springframework.boot.data.jpa.test.autoconfigure`.

## What did not change

The claims that survived the move are worth as much as the breaks, because they are the ones the example is about:

- Every property the docs and YAMLs use other than the four above exists in the 4.1 metadata: the Hikari pool, `spring.flyway.locations` with the `{vendor}` placeholder, `fail-on-missing-locations`, the Rabbit confirms/returns/listener settings, `spring.threads.virtual.enabled`, `spring.mvc.problemdetails.enabled` and its WebFlux twin, `server.shutdown`/`server.tomcat.*`, the actuator probe and exposure keys, `logging.pattern.correlation`, `spring.main.lazy-initialization`.
- `ProblemDetailsExceptionHandler` still extends `ResponseEntityExceptionHandler`, so it still claims framework exceptions and the `HIGHEST_PRECEDENCE` reason in `README.md` stands.
- `channelTransacted` keeps its meaning (a deferred messaging transaction when the flag is on, auto-ack when it is off), and Spring AMQP's observation still carries context across the broker hop.
- `DataClassRowMapper` and `JdbcClient` are both in Framework 7.0.10; `@ConfigurationProperties` records still bind by constructor; `-parameters` is still enabled by the parent.
- `-Djarmode=tools ... extract --layers` still yields `dependencies/`, `spring-boot-loader/`, `snapshot-dependencies/` and `application/`; `-Dspring.context.exit=onRefresh` still ends a training run; `mvn -Pnative package` still runs `process-aot` on an ordinary JDK, and `-Dspring.aot.enabled=true` still boots the result.
- The `-Djava.version=17` trap reproduces: the enforcer reads the JVM system property, reports 17 on a 21 run and fails the build, exactly as `java-and-tooling.md` says.
- Maven Wrapper 3.3.4 was current at the time of the record and enforcer 3.7.0 was the newest plugin; neither pin needed a move.

## Verification

The move was accepted on evidence, not on a diff review:

1. `mvn clean test` on 4.1.2 — build success; core 13 tests (10 skipped, the two container-backed classes with no runtime), servlet 3, reactive 2.
2. Both applications started against an unreachable database with Flyway and the listener disabled: Tomcat announced itself and `Started ServletApplication in 2.5 s`, Netty and `Started ReactiveApplication in 2.8 s`.
3. The `Containerfile` path ran by hand: layer extraction, a CDS training run that exited 0 and produced a 59 MB archive, and a restart from that archive in 1.4 s.
4. On a JDK 25 runtime, `-XX:AOTCacheOutput` produced an 82 MB AOT cache, which is the option `memory.md` leaves for the Java 25 matrix row.
5. `mvn -Dmaven.compiler.release=17 test` stayed green, so the release-17 row of the level matrix is the checked claim, not a remembered one.
6. The failing boot was captured verbatim before the fix (`Parameter 0 of method payloadConverter …`) and is the reason `messaging.md` names the Jackson 2 trap explicitly instead of just renaming the converter.

## The versions behind the pin

Framework 7.0.10, Spring AMQP 4.1.2, Jackson 3.1.7 (with the Jackson 2 line still managed at 2.21.7), Hikari 7.0.2, Flyway 12.4.0, Testcontainers 2.0.5, Tomcat 11.0.27, JUnit 6.0.3, Mockito 5.23.0, pgjdbc 42.7.14, ojdbc11 23.26.3.0.0, logback 1.5.38, Micrometer 1.17.2, Micrometer Tracing 1.7.2, OpenTelemetry 1.62.0, native-build-tools 1.1.14. Two versions sit outside the BOM: `logstash-logback-encoder` stays at 8.1 (9.0 is published; 8.1 emits JSON under logback 1.5.38, which is what the `json` profile needs), and the base images are the JDK 21 Temurin and Maven 3.9 pair the `Containerfile` pins.

These numbers live here rather than in the prose: a doc that states a dependency version is a doc that rots on the next patch, while the property names and the component choices above stay true across the line.

## Staying on 3.5.x

A service that must stay on Boot 3.5 keeps the old shape of every row in the break table: `junit-jupiter`/`postgresql`/`oracle-xe` coordinates, the `org.springframework.boot.test.autoconfigure.*` slice annotations with `spring-boot-starter-test` alone, `Jackson2JsonMessageConverter` with the Jackson 2 mapper, `isAck()`/`getReason()`, `spring-boot-starter-web`, `management.otlp.*` for traces and logs, GraalVM 21 for native builds, and `/3.5/` reference links. What it must not do is mix the two shapes: the pair `Jackson2JsonMessageConverter` with a Jackson 3 mapper, or `spring-boot-starter-webmvc` with the old slice annotations, fails in ways the build does not mention.

## Alternatives rejected

- **Forked per-version doc trees.** Eight docs would become sixteen nodes with two homes for every claim, and the fork would be half fiction: the reactor, the POM and the `Containerfile` are one tree and can only describe one release.
- **Version amends inline at each point.** A living document that says "3.5: this, 4.1: that" pays the reader for history in every table and edits every row again on the next bump; the dated form of that history is this record.
- **Keeping the 3.5.16 pin.** Defensible on support grounds and wrong for an example whose subject is current practice — the reference set would keep teaching a superseded Jackson, a superseded starter name and a superseded OTLP namespace.

## Consequences

The next bump is one POM edit plus a re-check of this record's table, because the version numbers and the migration deltas have one home. Two follow-ups are deliberately left out: a Java 25 runtime image, which would replace the CDS training run with an AOT cache (the `memory.md` matrix already says so), and the `logstash-logback-encoder` 9.0 upgrade, which is a separate compatibility question from the Boot line.
