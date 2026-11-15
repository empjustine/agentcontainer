---
id: sbex
type: module-design
status: active
title: "sbex: a Spring Boot best-practice example for constrained containers"
parent: architecture
tags: ["spring-boot", "java", "example", "containers", "messaging"]
---

# sbex: a Spring Boot best-practice example

sbex is a worked Spring Boot example whose subject is doing the ordinary things well: a shared persistence and messaging core, one blocking and one non-blocking application, and a deployment shaped for RAM-constrained containers. It is not a production service — authentication, schema evolution past the first migration and business depth are out of scope on purpose. The reader is an engineer picking patterns for a Spring Boot service; every claim in these files points at the vendor document that owns it. The example pins Spring Boot 3.5.x and Java 21, and every `docs.spring.io` link carries the matching `/3.5/` path so the code and its references describe the same release.

## Requirement to file

| Concern                                                  | Where it lives                                              |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| Spring Boot project conventions                          | this file, every `pom.xml`, `application.yml`               |
| Heap and footprint on a small container                  | `memory.md`, `Containerfile`                                |
| Servlet and reactive done optimally                      | `servlet-vs-reactive.md`, `sbex-servlet/`, `sbex-reactive/` |
| Transactions and JdbcTemplate over Oracle and PostgreSQL | `persistence.md`, `sbex-core/…/db/`, both migrations        |
| RabbitMQ publishing and consuming                        | `messaging.md`, `sbex-core/…/messaging/`                    |
| Container builds, unpacked deployments                   | `container-image.md`, `Containerfile`                       |
| AOT, CDS and the AOT cache                               | `memory.md` (the CDS section)                               |
| Native images for appliance builds                       | `container-image.md` (the native section)                   |
| Records, Jackson streaming, Maven wrapper and toolchains | `java-and-tooling.md`                                       |
| Which Java level each feature needs (17/21/25)           | `java-and-tooling.md` (the level matrix)                    |
| Per-pod heap limit vs throughput (Pareto frontier)       | `pod-sizing.md`                                             |
| End-to-end tracing and correlated logs                   | `observability.md`                                          |

## The modules

| Module          | What it is                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sbex-core`     | The shared half: domain records, JdbcTemplate repositories, the vendor dialect, Flyway migrations, Rabbit topology and the after-commit publisher. No web types. |
| `sbex-servlet`  | Tomcat, virtual threads, JdbcTemplate on the request thread, the Rabbit listener, a streaming report endpoint.                                                   |
| `sbex-reactive` | Netty, WebClient with a bounded pool, the blocking core offloaded to the bounded-elastic scheduler.                                                              |

The two applications depend on the core and nothing on each other: the point of the split is that one implementation of the domain serves both stacks, so the differences a reader compares are the stacks' and not the business logic's.

## Build, test and run

Prerequisites: a JDK 21 or newer, Maven 3.9 or newer, and a container runtime for the integration tests. `sbex/tests/run.sh` reports a loud skip when the JDK is absent, the same posture the repository's Go suite takes.

1. Build the reactor from the repository root:

   ```sh
   ./node-run.sh sbex/build.mjs
   ```

   The direct equivalent is `mvn -f sbex/pom.xml verify`; `build.mjs` only probes the toolchain first so a missing JDK fails with one line.

2. Point the application at a database and a broker. The `application.yml` files carry `localhost` defaults and take overrides from the environment — `SBEX_DB_URL`, `SBEX_DB_USER`, `SBEX_DB_PASSWORD`, `SBEX_AMQP_HOST` — and no secret is written down anywhere in the tree.
3. Start one of the built jars:

   ```sh
   java -jar sbex/sbex-servlet/target/sbex-servlet-1.0.0-SNAPSHOT.jar
   java -jar sbex/sbex-reactive/target/sbex-reactive-1.0.0-SNAPSHOT.jar
   ```

4. Build the container image (the context is this folder, because `.dockerignore` and the `COPY` paths assume it):

   ```sh
   cd sbex && podman build -f Containerfile .
   ```

5. Run the test sweep for this unit:

   ```sh
   sh sbex/tests/run.sh
   ```

   `./test.sh` at the repository root reaches the same script through its `*/tests/*.sh` glob. The persistence contract tests need a container runtime and disable themselves without one; the dialect and the slice tests always run.

## Conventions the code follows

- **Configuration is typed and validated.** `AppProperties` is a `@ConfigurationProperties` record with `@Min`/`@NotBlank` constraints, so a bad value fails the boot with the property name instead of the first request that reads it. Every operator-owned value in `application.yml` is an environment variable with a local fallback.
- **Errors are RFC 9457 problem documents.** `spring.mvc.problemdetails.enabled` covers the default error path; each application's `@RestControllerAdvice` maps the domain exceptions to 404/409/400/500 and carries `HIGHEST_PRECEDENCE`, because Boot's auto-configured problem-details advice also claims framework exceptions such as a validation failure. Database words stay in the log — a `SQLException` in a response body leaks schema.
- **The layers keep their jobs.** Controllers validate and shape HTTP, `OrderService` owns the transactions, repositories own the SQL, and the vendor's syntax is behind one interface. No layer reaches around another.
- **Tests match the layer.** `@WebMvcTest`/`@WebFluxTest` slices for controllers with mocked services, a pure unit test for the vendor selection, and one contract test class executed against real PostgreSQL and real Oracle containers (Testcontainers, `disabledWithoutDocker`).
- **Logs are structured in the container.** Activate the `json` profile (`SPRING_PROFILES_ACTIVE=json`) and LogstashEncoder writes one JSON object per line for the log driver to ship; without the profile the pattern stays readable on a terminal. `observability.md` carries the trace and log-correlation design that makes those lines joinable.
- **The deployment is operable.** Actuator exposes `health,info,metrics`, the probe endpoints are enabled for liveness and readiness, `server.shutdown=graceful` drains in-flight work, and the JVM flags in the `Containerfile` are the documented set for a bounded heap.

## Reading path

1. `persistence.md` — transactions, JdbcTemplate and the two engines.
2. `messaging.md` — confirms, idempotency and the listener transaction.
3. `servlet-vs-reactive.md` — which stack, and what optimising each one means.
4. `memory.md` — heap bounds, CDS and the AOT cache.
5. `container-image.md` — unpacked deployments and native images.
6. `java-and-tooling.md` — records, streaming, Maven tooling and the Java level matrix.
7. `pod-sizing.md` — the heap limit and throughput frontier per replica.
8. `observability.md` — traces, correlated logs and the OpenTelemetry path.

## Toolchain notes

The build runs on the host's JDK and Maven (the repository's `./dev-tools.sh` is the install path for host toolchains). A project that must build on hosts without Maven ships the [Maven Wrapper](https://maven.apache.org/wrapper/) instead — the same pin this example gets from its container images.
