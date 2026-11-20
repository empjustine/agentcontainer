---
id: sbex-optimisation-findings
type: submodule-design
status: draft
title: "Optimisation findings: heap bounds, response compression, Jackson reflection and AOT"
parent: sbex
references:
  [
    sbex-memory,
    sbex-persistence-engines,
    sbex-sqlite-replication,
    sbex-datalakehouse-port,
    sbex-non-functional-testing,
    sbex-java-and-tooling,
    d193,
  ]
tags: ["performance", "heap", "streaming", "compression", "jackson", "aot", "findings"]
---

# Optimisation findings: heap bounds, compression, Jackson and AOT

This note is the catalogue behind the example's performance claims. It covers what bounds heap in each engine and access mode, which compression the container applies, and what the Jackson 3 line offers beyond reflection. It is not a benchmark report and not a task list: each finding carries a state — applied, fits, or outside. The example is a pattern showcase rather than a running service, so a finding that does not fit a toy endpoint still belongs in the record. The reader is an engineer taking these patterns elsewhere, and arrives knowing the modules and the two stacks.

## Status

Draft: research complete, nothing in this note is enforced by code or a test beyond the points marked `applied`. Measurements named as verified were taken against the pinned artifacts of this tree (Spring Boot 4.1.2, Jackson 3.1.7, Spring Framework 7, Tomcat 11.0.27, Netty/Reactor Netty from the same BOM, SQLite 3.46.1 for the statements).

## How to read the states

| State     | Meaning                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| `applied` | the pattern is in the example and a reader can point at the file                                |
| `fits`    | the pattern belongs in the example's scope and is not there yet                                 |
| `partial` | one shape of the pattern is in the example and the general case is not                          |
| `outside` | a real best practice the example cannot host (it has no load, no cluster, no throughput target) |

## Re-scored for the lakehouse port

The states above were written against the order toy. The lakehouse port ([sbex-datalakehouse-port](datalakehouse-port.md)) turns the example into a long-running local daemon over a growing archive, and six verdicts move with it.

| Item                                | Was       | Is             | Why the scope change decides it                                                                                                          |
| ----------------------------------- | --------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| native memory, allocators, off-heap | `outside` | `fits`         | DuckDB's buffer manager, SQLite's page cache and Parquet writes live outside the heap, so `-Xmx` stops describing the process            |
| allocation-free row writing         | `outside` | `fits`         | visit and session exports run over millions of rows, where a formatter per row is the cost that matters                                  |
| protobuf, Avro, gRPC                | `outside` | `fits` (spool) | the sandbox spool and the archive are the hops a binary format pays for; the browser protocols stay JSON because the extensions fix them |
| AOT and native image                | `outside` | `fits`         | a single-host daemon trades build complexity for footprint and start-up, and its payload records are already hinted                      |
| zstd responses                      | `outside` | `outside`      | the API is loopback, so compression spends CPU on bytes that never touch a network; the archive transfer is where zstd earns its place   |
| per-query heap bounds               | `partial` | `applied`      | the read faces and the exports are the streaming consumers the bound was written for                                                     |

Two more movements belong to the sibling notes rather than this catalogue. The SQLite leg of the engine matrix stops being hypothetical, and the replication note's Litestream and `sqlite3_rsync` comparison stops being a plan for an empty store. ClickHouse's expensive leg also earns a second justification there: the browsing index is cold-shaped by construction, so a column store is a candidate for postings rather than for the order toy.

## Heap: four bounds and where each lives

Rows reach JVM memory through a statement, a mapping, a concurrency slot and the heap itself, and each has its own control.

| Bound            | Control                                                          | State in the example                                  |
| ---------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| Statement result | `fetchSize`, driver streaming flag, `setMaxRows`, `LIMIT`        | partial: the streaming report, no fetch size          |
| Mapping          | `RowCallbackHandler` steps; `RowMapper`-`List` materialises      | `applied` (`OrderRepository.streamCompleted`)         |
| Concurrency      | pool size, MVC async executor, `spring.r2dbc.pool.max-size`      | `applied` (`maximum-pool-size`, `WebConfig` executor) |
| JVM              | `-Xmx`, `-XX:MaxDirectMemorySize`, `-XX:+ExitOnOutOfMemoryError` | `applied` (the Containerfile flag set)                |

`JdbcTemplate` exposes the first two as template-level knobs — `setFetchSize(int)`, `setMaxRows(int)`, `setQueryTimeout(int)` — which is the difference between a policy and a habit: a template with a row ceiling cannot be talked into an unbounded response by a caller.

## Per engine and access mode

| Engine         | Blocking read                                                                                                                                                     | Reactive read                                                                                                                | Bound outside the heap                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **PostgreSQL** | cursors only with `autocommit=false`, `fetchSize>0` and a forward-only result; otherwise the driver "silently falls back to fetching the whole ResultSet at once" | `r2dbc-postgresql` `fetchSize` defaults to `0` = unlimited; a cursor needs a non-zero value and lives inside the transaction | —                                                                                                                                                      |
| **SQLite**     | the callback shape steps the native cursor; `setFetchSize` is a row limit, not a transfer buffer                                                                  | no driver                                                                                                                    | page cache is native: `cache_size` defaults to `-2000` = 2,048,000 bytes per open file; `soft_heap_limit` and `mmap_size` bound SQLite's own allocator |
| **DuckDB**     | streaming is opt-in: `jdbc_stream_results=true`, else the driver materialises; chunked and Arrow reads exist                                                      | no driver                                                                                                                    | `memory_limit` defaults to 80% of RAM and applies only to the buffer manager; `threads` multiplies it                                                  |
| **ClickHouse** | the server streams rows; return size is capped server-side by `max_result_rows`/`max_result_bytes`, reachable as `clickhouse_setting_*` properties                | `clickhouse-r2dbc` streams under the same server caps                                                                        | —                                                                                                                                                      |

Two findings are easy to miss and both cost containers. SQLite and DuckDB put their working set in **native** memory, so `-Xmx` does not bound them and the container limit is the real ceiling. And "we stream" is false on three of the four engines until a flag is set: PostgreSQL needs the fetch size _inside_ a transaction, SQLite needs the callback shape, DuckDB needs `jdbc_stream_results`, ClickHouse needs a server-side row cap.

## Enforcing the bound

1. Take the JVM bound from [sbex-memory](memory.md), whose flag set already ends the process on an out-of-memory failure instead of degrading.
2. Declare the fetch size on the template and the streaming flag in configuration; a per-call argument is a habit and drifts.
3. Cap concurrency as a product: pool size times rows buffered per cursor is the heap a burst can reach, and the async executor bounds how many streams are alive at once.
4. Prove it with a test that streams a large result under a small heap (`-Xmx64m`, surefire `argLine`) and asserts the response completes. [sbex-non-functional-testing](non-functional-testing.md) proves the async executor bound; the query path has no such proof yet.
5. Measure with JFR (`jdk.ObjectAllocationSample`), `jcmd <pid> GC.class_histogram` for the live set, and `-XX:NativeMemoryTracking=summary` when a driver's native share is the suspect.

## Per-row allocation

A streaming loop is only as bounded as its per-row work. `ReportController.writeRow` formats each row with `"%d,%s,%s,%s%n".formatted(...)`, which builds a formatter and a string per row, and `ORDER_ROW` allocates an `Order` record, a `BigDecimal` and a `Timestamp`. A report path over a million rows pays that a million times, which is what the lakehouse export makes routine. `fits`: the pattern is a projection of primitives plus a reusable `StringBuilder`, or a CSV writer that owns its buffer.

## Compression: what the container applies

Boot exposes five properties — `enabled`, `mime-types`, `additional-mime-types`, `min-response-size` (2 KB by default), `excluded-user-agents` — and no choice of algorithm.

| Stack            | What actually compresses                                                                | Algorithms available                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Servlet (Tomcat) | `GzipOutputFilter` only, whatever the properties say                                    | gzip. Tomcat 11.0.27 carries no zstd or brotli output filter; `noCompressionEncodings` only prevents double compression                                         |
| Reactive (Netty) | Boot's `CompressionCustomizer` maps the same properties onto Reactor Netty's `compress` | gzip through the property; Reactor Netty also offers `GzipOption`, `DeflateOption`, `BrotliOption`, `ZstdOption`, `SnappyOption` through `compressOptions(...)` |

So the answer to "is Boot using something as good as zstd" is no: it applies **gzip**, and zstd needs one of three routes.

- **A Netty customizer.** Reactor Netty selects the algorithm through `compressOptions(HttpCompressionOption...)`, and Netty's zstd and brotli encoders are optional dependencies — `com.github.luben:zstd-jni`, or `com.aayushatharva.brotli4j` plus a per-architecture native artifact. That is a `NettyServerCustomizer` bean in the reactive application, with two new vetted dependencies and a native library per platform. `outside` for the loopback API, and the honest shape for the archive transfer over a network.
- **Precompressed resources.** Tomcat's `DefaultServlet` serves a `.br` or `.gz` file found beside the original when the client advertises the encoding, behind a `precompressed` flag. The format list is configurable as `encoding=extension` pairs, so `.zst` is a supported extension to register. This compresses static assets at build time, not JSON responses. `fits`.
- **A proxy or CDN in front.** The usual deployment answer, and it keeps the application out of the algorithm business. `outside` a single-host example.

On the wire, `zstd` is a registered HTTP content coding (RFC 8878) with real browser reach: Chrome and Edge from 123, Firefox from 126, and no Safari support. A service cannot choose it unilaterally — the `Accept-Encoding` negotiation decides — which is why the proxy route negotiates for the whole estate. For JSON, gzip is within a few percent of zstd on typical record payloads; the gain from zstd is CPU at equal ratio, not a step change in bytes. `outside` a container with no traffic.

## Jackson: views, parameter names, bytecode, AOT

### `MapperFeature.DEFAULT_VIEW_INCLUSION`

The feature still exists in Jackson 3 (`tools.jackson.databind.MapperFeature`), so `objectMapper.disable(MapperFeature.DEFAULT_VIEW_INCLUSION)` compiles unchanged — but its **default flipped to `false`** in the 3 line (verified by calling `enabledByDefault()` on the pinned `jackson-databind` 3.1.7). Two consequences:

- In Jackson 3 the call is redundant against the default: with a view active, unannotated properties are already left out.
- The migration hazard runs the other way: a Jackson 2 codebase that relied on the old `true` default has to _enable_ the feature to keep its output.

Boot still binds it — `spring.jackson.mapper` is typed `Map<MapperFeature, Boolean>`, so `spring.jackson.mapper.default-view-inclusion=true` resolves by enum name. Jackson 3 mappers are immutable after `build()`, so the setting is a builder feature (`JsonMapper.builder().disable(...)`) or a property, never a post-construction `configure` call.

### `@JsonCreator`, `@JsonProperty` and the `-parameters` flag

Jackson 3 reads the class file's `MethodParameters` attribute directly — the string is in `AnnotatedClass` — and there is no `tools.jackson.module:jackson-module-parameter-names` artifact. The compiler flag is therefore the switch, and Boot's parent already sets `<parameters>true</parameters>`. Records carry their component names without it.

That reframes the annotations: they buy a **contract**, not speed. `@JsonCreator`/`@JsonProperty` fix a name, a default or an immutable constructor; the reflection they supposedly avoid happens once per type either way, because the resolved `BeanSerializer`/`BeanDeserializer` is cached on the mapper. Their real value in this stack is AOT and native: a bean the introspector can resolve without guessing is a bean whose hints can be generated.

### Afterburner, Blackbird, and what they cost

- `tools.jackson.module:jackson-module-afterburner` and `tools.jackson.module:jackson-module-blackbird` both exist for the Jackson 3 line, both are published at the pinned **3.1.7**, and `jackson-bom` 3.1.7 — which the Boot BOM imports — manages both. Either is therefore a version-less dependency here, and availability is not the reason to leave it out; the measured gain is.
- Conceptually they are two generations of the same idea. Afterburner generates serializers and deserializers as bytecode, described in its README as eliminating most of the remaining data-binding overhead. Blackbird replaces that with `LambdaMetafactory` accessors, then with JDK ClassFile API hidden classes on the 3 line. Blackbird's own documentation carries the caveat that generated accessors pin the target's ClassLoader, so many mappers in one JVM end in metaspace pressure.
- Gain is in the range of a few percent to roughly a fifth of serialization time, and only for large object graphs. `outside`: a record with four fields, serialized once per request, is not where it pays.

### AOT and native

Boot contributes `JacksonAutoConfigurationRuntimeHints` and the `JacksonMixinModule` AOT processors, and the application adds `@RegisterReflectionForBinding` for each payload record — which the example already does for `OrderPlaced`, and which is why the same publisher works under `-Pnative`. Spring AOT plus CDS moves startup and footprint, not steady-state throughput; native image moves footprint and start-up again, at the price of build complexity. `applied` (native profile), `outside` (a throughput argument).

## JSON payload: the levers beyond annotation-shuffling

| Lever                                                                                 | Effect                                                                                                                                                                                                                          | State     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| One shared `JsonMapper`                                                               | one serializer cache, one configuration; `RabbitTopologyConfig` already injects Boot's bean                                                                                                                                     | `applied` |
| Serialize to the response stream                                                      | Spring's converters call `writeValue(OutputStream)`; only application code creates a `String`                                                                                                                                   | `applied` |
| Return `Flux<T>` instead of `Mono<List<T>>`                                           | Spring 7's `AbstractJacksonEncoder.encode(Publisher…)` writes elements through a `SequenceWriter`, so the array streams                                                                                                         | `fits`    |
| Fast number parsing                                                                   | Jackson 3.1.7 has `USE_FAST_DOUBLE_PARSER` and `USE_FAST_BIG_NUMBER_PARSER` **on by default** (verified) — the old advice is obsolete                                                                                           | `applied` |
| CBOR or Smile media types                                                             | Boot 4.1 auto-configures a `CborMapper` (`CborConfiguration`), Spring 7 ships `JacksonCborEncoder`/`JacksonSmileEncoder`, and `jackson-bom` 3.1.7 manages `jackson-dataformat-cbor`; binary payloads skip field-name repetition | `fits`    |
| Drop the Rabbit type header                                                           | `JacksonJsonMessageConverter` defaults to `DefaultClassMapper`, whose field is `__TypeId__` — a fully-qualified class name per message; short ids or a `defaultType` remove it, `setCreateMessageIds(false)` keeps a UUID out   | `fits`    |
| Bound the codec buffers                                                               | Boot 4 names it `spring.http.codecs.max-in-memory-size` (not Boot 3's `spring.codec.*`); the failure mode of the default is `DataBufferLimitException`                                                                          | `fits`    |
| Bound the log encoder                                                                 | `LoggingEventAsyncDisruptorAppender` has a fixed ring buffer (`ringBufferSize`, 8192 by default), so logging JSON cannot grow unbounded                                                                                         | `fits`    |
| Protobuf, Avro or gRPC for the broker message contract                                | removes text parsing entirely, at the cost of a schema and a broker contract change                                                                                                                                             | `outside` |
| Compile-time serializers (`avaje-jsonb`, `DSL-JSON`, `jsoniter`)                      | generate codecs ahead of time, no runtime reflection; a third-party dependency and a codegen step                                                                                                                               | `outside` |
| Allocation-free transport plumbing (jemalloc, off-heap buffers, direct-buffer sizing) | moves the fight from heap to native memory, which is where DuckDB, SQLite and the Parquet writer put their working sets                                                                                                         | `fits`    |

## Measuring any of it

1. Take a baseline with JFR: `jfr start --settings=profile` on the endpoint, then read `jdk.ObjectAllocationSample` for the top allocation sites.
2. Read the live set with `jcmd <pid> GC.class_histogram` after a warm-up run, not after a cold one.
3. Compare bytes on the wire with `curl -w '%{size_download}' -H 'Accept-Encoding: gzip'`, and again without the header.
4. Compare the shapes side by side — `Mono<List<Order>>` against `Flux<Order>`, `query` against `queryForList` — with a large fixture, because the difference is invisible at ten rows.
5. Keep the numbers next to the flag that produced them: a claim without its `-Xmx`, pool size and row count is not a measurement.

## References

- Spring Boot 4.1: [HTTP compression](https://docs.spring.io/spring-boot/4.1/how-to/webserver.html), [reactive codecs](https://docs.spring.io/spring-boot/4.1/reference/web/reactive.html); configuration metadata read from `spring-boot-web-server`, `spring-boot-jackson` and `spring-boot-http-codec` 4.1.2
- Spring Framework 7: `JdbcTemplate` (`setFetchSize`, `setMaxRows`), `AbstractJacksonEncoder.encode(Publisher…)`, `JacksonCborEncoder`, `JacksonSmileEncoder`
- pgjdbc: [cursors and fetch size](https://jdbc.postgresql.org/documentation/query/) · r2dbc-postgresql: [`fetchSize`](https://github.com/pgjdbc/r2dbc-postgresql)
- SQLite: [`cache_size`, `soft_heap_limit`, `mmap_size`](https://sqlite.org/pragma.html) · DuckDB: [result handling](https://duckdb.org/docs/2.0/clients/java/result_handling), [limits](https://duckdb.org/docs/2.0/operations_manual/limits) · ClickHouse: [JDBC driver](https://clickhouse.com/docs/integrations/language-clients/java/jdbc), [query complexity settings](https://clickhouse.com/docs/operations/settings/query-complexity)
- Tomcat 11: [HTTP connector compression](https://tomcat.apache.org/tomcat-11.0-doc/config/http.html), [DefaultServlet `precompressed`](https://tomcat.apache.org/tomcat-11.0-doc/default-servlet.html) · Netty: `netty-codec-compression` optional `zstd-jni` and `brotli4j` · RFC 8878 (zstd) with browser support from [caniuse](https://caniuse.com/zstd)
- Jackson: `MapperFeature` and `StreamReadFeature` defaults read from `jackson-databind`/`jackson-core` 3.1.7; [Afterburner](https://github.com/FasterXML/jackson-modules-base/tree/master/afterburner), [Blackbird](https://github.com/FasterXML/jackson-modules-base/tree/master/blackbird)
- Spring AMQP: [message converters](https://docs.spring.io/spring-amqp/reference/amqp/message-converters.html) · logstash-logback-encoder: [async appenders](https://github.com/logstash/logstash-logback-encoder#async-appenders)
- Sibling notes: [sbex-memory](memory.md), [sbex-persistence-engines](persistence-engines.md), [sbex-sqlite-replication](sqlite-replication.md)
