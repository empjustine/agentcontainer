---
id: sbex-java-and-tooling
type: submodule-design
status: active
title: "sbex java and tooling: records, streaming, Maven and the Java level each feature needs"
parent: sbex
references: [d193]
tags: ["java", "records", "jackson", "maven", "toolchains", "native-image"]
---

# Java and tooling: records, streaming, Maven and the Java level each feature needs

This file records four findings about a Spring Boot 4.1 service: records are the first-class data carrier on both sides of the wire, Jackson streaming is invisible until the payload is large, Maven pinning and toolchains are unchanged as mechanisms, and each JVM feature in that stack names its Java level. It does not size heaps (`memory.md`), size pods (`pod-sizing.md`) or wire telemetry (`observability.md`). The reader is choosing a Java level for a new or existing Boot service and wants to know what the choice costs.

## Records carry the data

| Direction       | Mechanism                                                                                   | Note                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| HTTP in and out | Constructor binding for `@RequestBody` records, validation annotations on record components | worked in `OrderController` and `OrderApi`                                                                             |
| Row → record    | `DataClassRowMapper` (Spring 5.3, still in Framework 7.0)                                   | matches record constructor parameters to column names; needs `-parameters`, which `spring-boot-starter-parent` enables |
| Record → binds  | `BeanPropertySqlParameterSource` names records in its constructor contract                  | the input half of the same story                                                                                       |
| Configuration   | `@ConfigurationProperties` records, validated at boot                                       | `AppProperties`                                                                                                        |

Two honest caveats. `DataClassRowMapper`'s own javadoc says it is "designed to provide convenience rather than high performance" — name-matched reflection against metadata, so a hot path keeps the explicit one-line `RowMapper` lambda this repository uses. And the mapping is by **name**, not by position: a column that misses its constructor parameter becomes `null` unless the query says otherwise, which is the same silent-failure class `BeanPropertyRowMapper` has with setters.

Between `JdbcTemplate` and JPA sits `JdbcClient` (Spring 6.1, Boot 3.2, still in Framework 7): the fluent `query(...).param(...).mapping(...)` form over the same engine and the same transaction manager. Above that, `spring-data-jdbc` gives repository ergonomics with records as immutable aggregates when the object graph, not the SQL, is the model.

## Jackson streams without ceremony

- **The ordinary path already streams.** MVC's converter drives a `JsonGenerator` into the response stream; the heap cost of a response is the object graph, never the document. Records removed the remaining ceremony — no getters, no parameter-names module (Jackson has supported records since 2.12).
- **Large outputs** have three supported shapes: `StreamingResponseBody` or an SSE emitter where the application owns the generator loop (the `ReportController` pattern), WebFlux `Flux`/SSE responses encoded element by element, and `ObjectMapper.writeValues`/`MappingIterator` for chunked or NDJSON output.
- **Large inputs** are `ObjectMapper.getFactory().createParser(stream)` plus `readValues` — short and imperative.
- **What remains painful is inherent to streaming**, not to Jackson: the status line is committed before the first element, flush discipline belongs to the writer, and MVC has no declarative "bind this query as a stream" facility.
- **Two Jackson lines are managed; one is configured.** Boot 4 auto-configures Jackson 3 (`tools.jackson.*`) and still manages the Jackson 2 line (`com.fasterxml.*`) so an unmigrated library keeps resolving; `spring-boot-jackson2` is the compatibility module that keeps a Jackson 2 `ObjectMapper` bean on offer. Jackson 3 declares a Java 17 baseline, so the switch costs no Java level. The trap is that both lines compile: a parameter typed `com.fasterxml…ObjectMapper`, or a `Jackson2JsonMessageConverter` (deprecated for removal), fails at startup rather than at build time because no such bean exists by default (`docs/d193`).

## Maven pinning, toolchains and native builds

**The wrapper** (Apache Maven Wrapper, 3.3.4) remains the standard way to pin Maven per repository — and remains optional: Spring Boot's own repository ships no `mvnw` and pins Maven in CI instead, and sbex pins it in its builder image. The rule is "Maven is pinned somewhere", not "the wrapper is mandatory".

**Toolchains** keep their one job: the JVM Maven _runs on_ is decoupled from the JDK the _plugins_ use (compiler javac, surefire's forked test JVM) through `~/.m2/toolchains.xml`, matched by version and vendor. Maven does not download JDKs — a version manager installs them and the file points at them. Boot does not wire toolchains: `maven.compiler.release` cross-compiles with the build JDK's `ct.sym`, so a second JDK earns its keep only for compiling or testing on a _real_ target JDK, or when Maven itself must run on a different JVM.

One trap found while verifying: overriding the build target with `-Djava.version=17` also overwrites the JVM's own `java.version` system property, which the enforcer reads — the rule then reports "JDK is version 17" while running on 21. Override `-Dmaven.compiler.release=17` instead, or change the POM property.

**Native builds and toolchains work together.** The GraalVM Native Maven Plugin (1.1.14, the version Boot 4.1.2 manages) injects Maven's `ToolchainManager` into every goal — verified in its `plugin.xml` — and otherwise resolves GraalVM from `GRAALVM_HOME`, a `JAVA_HOME` that is itself a GraalVM distribution, or `native-image` on `PATH`, failing with a named reason when none applies. So a build can compile and test on Temurin through a toolchain and hand only `native:compile` a GraalVM. `spring-boot:process-aot` runs on the build JVM (any JDK 17+), and `spring-boot:build-image -Pnative` sidesteps the whole question because buildpacks compile inside a container. The native floor is higher than the JVM's: Boot 4.1.2 supports GraalVM 25 and above, so a toolchain that compiles on Temurin 21 still hands `native:compile` a GraalVM 25 (`container-image.md` pins that image).

## The Java level each feature needs

| Feature                                            | Level        | Note                                                                                                                     |
| -------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Records, text blocks, `instanceof` patterns        | 15–16        | fine on any supported Boot level                                                                                         |
| Spring Boot 4.1.2 baseline                         | 17           | `java.version` in the parent POM; the runtime supports up to Java 27                                                     |
| Jackson 3 baseline                                 | 17           | stated in its own build                                                                                                  |
| sbex source and tests                              | 17           | `mvn -Dmaven.compiler.release=17 test` compiles every module and runs the suite green                                    |
| Virtual threads (`spring.threads.virtual.enabled`) | 21           | no backport; on 17 the servlet stack returns to platform threads and `server.tomcat.threads.max` becomes the bound again |
| Pattern matching for `switch`                      | 21           | deliberately unused — `SqlDialect` uses if-chains                                                                        |
| AOT cache (JEP 483)                                | 25           | on 17 and 21 the classic CDS training run in `memory.md` is the available tool                                           |
| Maven Wrapper, toolchains                          | JDK-agnostic | Maven 3.9 runs on 17; Maven 4 requires 17+                                                                               |

The support-window point stands regardless of the table: each distribution publishes its own EOL dates (Oracle's support and licensing tables differ from Temurin's builds), and 17's window closes before 21's. The practical reading is that 17 is a _compatibility target_ — compile to it with `--release 17` from a newer JDK — while new deployments take 21 (virtual threads) or 25 (AOT cache).

## References

- [Spring Boot reference — SQL databases](https://docs.spring.io/spring-boot/4.1/reference/data/sql.html) (JdbcTemplate, JdbcClient, JPA)
- [Spring Boot — Maven plugin packaging](https://docs.spring.io/spring-boot/4.1/maven-plugin/packaging.html) and [native image](https://docs.spring.io/spring-boot/4.1/reference/packaging/native-image/index.html)
- [Apache Maven Wrapper](https://maven.apache.org/wrapper/)
- [GraalVM Native Build Tools](https://github.com/graalvm/native-build-tools) (the plugin whose toolchain injection is cited above)
- [Spring Boot — efficient deployments](https://docs.spring.io/spring-boot/4.1/reference/packaging/efficient.html)
