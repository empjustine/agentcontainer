---
id: sbex-memory
type: submodule-design
status: active
title: "sbex memory: heap bounds, CDS and the AOT cache"
parent: sbex
tags: ["jvm", "heap", "cds", "aot", "footprint"]
---

# Memory: heap bounds, CDS and the AOT cache

This file owns the footprint story: which JVM numbers a RAM-constrained container must set, which failures must end the process, and how CDS and the AOT cache cut both startup time and steady-state memory. It does not size the database pool or the messaging backlog — those are bounded in `messaging.md` and the `application.yml` files — nor the per-pod limit itself: `pod-sizing.md` owns the sweep that picks it. The reader arrives with a memory limit and a RSS graph; the procedure at the end turns both into a reviewed set of flags.

The flag set itself lives in the `Containerfile`'s `ENTRYPOINT`, beside a one-line reason each — this file carries the reasoning and the measurement behind the numbers.

## Size the heap for the container

- Set `-XX:MaxRAMPercentage` rather than `-Xmx`: the heap ceiling becomes a share of the **container** limit, so raising the limit in the orchestrator re-sizes the heap without an image rebuild. The [java man page's container support](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html) owns the flag and its units.
- Leave headroom for what is not heap: metaspace, thread stacks, direct buffers, code cache and the GC's own structures all sit outside `MaxRAMPercentage`. A heap at 70% of the limit with the rest unbounded is not a bounded process.
- Measure instead of guessing: run with `-XX:NativeMemoryTracking=summary` and read `jcmd <pid> VM.native_memory summary` — the [man page documents both](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html), and the summary separates heap from the regions a heap-only view hides.

## Bound everything that is not heap

| Region                 | Flag or setting                                                  | Why it is bounded here                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class metadata         | `-XX:MaxMetaspaceSize=256m`                                      | a class leak fails fast instead of growing RSS past the limit ([man page](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html))                                                    |
| Direct buffers         | `-XX:MaxDirectMemorySize=128m`                                   | Tomcat's and Netty's pooled direct buffers sit outside the heap and otherwise escape `MaxRAMPercentage` (same man page)                                                                           |
| Platform thread stacks | `-Xss`, virtual threads                                          | a stack per request is the old cost; `spring.threads.virtual.enabled=true` moves request stacks onto the heap, which is what makes a thread pool bound unnecessary (see `servlet-vs-reactive.md`) |
| Database connections   | `spring.datasource.hikari.maximum-pool-size`                     | every connection is a server-side backend; the pool, not the thread count, is the capacity limit                                                                                                  |
| MVC async requests     | `WebConfig`'s bounded executor                                   | Spring MVC's default async executor is unbounded, one thread per streaming request                                                                                                                |
| Reactor's elastic pool | `reactor.schedulers.defaultBoundedElasticSize` (a `-D` property) | the offload pool in `servlet-vs-reactive.md` defaults to a multiple of the CPU count — a number worth setting deliberately in a container                                                         |

## Fail fast, keep the evidence

- `-XX:+ExitOnOutOfMemoryError` ends the process on the first `OutOfMemoryError`. A JVM that survives an OOM allocates nowhere and serves nothing; the orchestrator's restart is the recovery path, and the liveness probe in `application.yml` is what triggers it.
- `-XX:+HeapDumpOnOutOfMemoryError` with `-XX:HeapDumpPath=/var/dumps` (created and made writable in the `Containerfile`) keeps the evidence. A dump costs roughly the heap in disk space, so the volume's size is part of the decision.
- `-XX:+DisableExplicitGC` stops third-party `System.gc()` calls — RMI's distributed garbage collector being the usual one — from forcing a full collection in a small heap ([man page](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html)).

## Garbage collection

The G1 collector the JVM defaults to is the right default at this scale: it already targets a pause goal and needs no tuning before measurement says otherwise. The [GC tuning guide](https://docs.oracle.com/en/java/javase/21/gctuning/) is the reference for when measurement does — and the first tuning step is a log, not a flag: `-Xlog:gc*` writes GC events to stdout, where the container's log driver owns rotation, and a pause histogram beats any remembered recommendation.

## CDS and the AOT cache

Class Data Sharing maps app classes from a file instead of loading them, cutting both startup time and the class-metadata footprint; on Java 25 and above the [AOT cache (JEP 483)](https://openjdk.org/jeps/483) supersedes [Class Data Sharing](https://docs.oracle.com/en/java/javase/21/vm/class-data-sharing.html), and Spring Boot recommends the AOT cache wherever the JVM supports it. Both need the same two steps, and both need the **extracted** deployment layout first — the nested-jar layout is not what the training run archives (see `container-image.md`).

1. Extract the jar (once, at build time):

   ```sh
   java -Djarmode=tools -jar application.jar extract
   ```

2. Run a training run that exits as soon as the context is refreshed:

   ```sh
   # CDS
   java -XX:ArchiveClassesAtExit=application.jsa -Dspring.context.exit=onRefresh -jar application.jar
   # AOT cache (Java 25+)
   java -XX:AOTCacheOutput=app.aot -Dspring.context.exit=onRefresh -jar application.jar
   ```

3. Start every later process from the archive:

   ```sh
   java -XX:SharedArchiveFile=application.jsa -jar application.jar   # CDS
   java -XX:AOTCache=app.aot -jar application.jar                   # AOT cache
   ```

The archive is valid as long as the application's classes do not change — a rebuilt jar means a rebuilt archive, which is why the `Containerfile` performs the training run as a `RUN` step of the runtime stage: the archive rebuilds exactly when the application layer does. A training run at build time has no database and no broker, so that one command runs with `SPRING_FLYWAY_ENABLED=false` and the listener auto-start off; the datasource itself connects lazily and never opens during the run.

The commands above are the Spring Boot reference's own — [Class Data Sharing](https://docs.spring.io/spring-boot/3.5/reference/packaging/class-data-sharing.html) carries both variants, and [Efficient Deployments](https://docs.spring.io/spring-boot/3.5/reference/packaging/efficient.html) carries the extraction step.

## AOT processing on the JVM

Spring's AOT processing does for the application context what the native image does at build time: bean definitions, conditions and proxies are computed once and shipped as code. It is a separate switch from CDS and it composes with it:

1. Build with the `native` profile so the jar carries the AOT-generated sources: `mvn -Pnative package`.
2. Start with `java -Dspring.aot.enabled=true -jar application.jar`.

The restrictions are the price: the classpath is fixed at build time, beans cannot change at runtime, and profile-specific or `@ConditionalOnProperty` configuration that would alter the bean graph is out. An appliance whose configuration is known at image-build time pays nothing for that; a service that adds a feature flag per deployment does. [Ahead-of-Time Processing With the JVM](https://docs.spring.io/spring-boot/3.5/reference/packaging/aot.html) is the owning reference.

## Startup and steady state

- `spring.main.lazy-initialization=true` builds beans on first use: less startup work and less peak memory, at the cost of moving every configuration failure to the first request that touches it — against the fail-fast posture above, so it is a deliberate trade for a mostly-idle appliance, not a default.
- `-XX:+AlwaysPreTouch` touches every heap page at startup: the process pays once, in startup time, and then never takes a page fault mid-request ([man page](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html)). In a container it also makes the RSS honest at time zero, which is what a limit check reads.

## Measurement procedure

1. Run the application with `-XX:NativeMemoryTracking=summary` and `-Xlog:gc*` against the real container limit.
2. Drive the representative load and read `jcmd <pid> VM.native_memory summary` — subtract heap, metaspace and direct buffers to find what the flags above still leave open.
3. Set each bound in the table to the measured peak plus headroom, and let `ExitOnOutOfMemoryError` turn the next surprise into a restart with a dump rather than a slow death.
4. Re-run the CDS training run after any flag or classpath change — an archive built against different classes is not a smaller JVM, it is a wrong one.
