---
id: sbex-container-image
type: submodule-design
status: active
title: "sbex container images: unpacked deployments and native appliances"
parent: sbex
tags: ["containers", "dockerfile", "native-image", "buildpacks"]
---

# Container images: unpacked deployments and native appliances

This file owns `Containerfile`: why the runtime runs an extracted deployment instead of the uber jar, how the stages are layered for cache, and how the same unit builds a native-image appliance. It does not carry the JVM flag reasoning — `memory.md` owns each flag and the measurement behind it. The reader arrives with a memory limit and a registry; the outcome is an image whose layers change only when their content does.

## Run the extracted layout, not the uber jar

Loading classes from nested jars costs startup time on every start, and it is the layout CDS and the AOT cache refuse to archive well. Spring Boot's own recommendation for production is the extracted form:

1. Extract once: `java -Djarmode=tools -jar application.jar extract` — libraries land in `lib/`, the application jar keeps the classes and references them, and the result runs as `java -jar application/my-app.jar`.
2. Split for the image instead: `extract --layers --destination extracted` produces `dependencies/`, `spring-boot-loader/`, `snapshot-dependencies/` and `application/` — the layers index the jar already carried, now as directories.

Both commands and both layouts are the [Efficient Deployments](https://docs.spring.io/spring-boot/3.5/reference/packaging/efficient.html) page's; the [Maven plugin's packaging page](https://docs.spring.io/spring-boot/3.5/maven-plugin/packaging.html) documents the layer order (least-changing content first) and how to customise it.

## The stage and layer rules this Containerfile follows

- **One pinned builder, one JRE runtime.** The builder stage carries the JDK and Maven it compiles with; the runtime stage is a JRE image — no compiler, no build tool, a smaller attack surface for a process that only runs code.
- **POMs before sources.** Dependency resolution is the expensive step that survives every source edit, so `COPY pom.xml …` then `dependency:go-offline` is its own cached layer; a source change reuses it.
- **Four `COPY` lines for four layers.** `dependencies/` changes least and sits first, `application/` changes most and sits last — each is a cache boundary, so a code change rebuilds one layer instead of the image.
- **Reproducible builds.** `project.build.outputTimestamp` makes Maven write byte-identical jars for identical inputs, so a rebuilt jar is a cache hit rather than a changed layer.
- **Non-root, and OpenShift-compatible.** A numeric `USER 1001:0` plus `chmod g=u` on the writable paths means the image runs as its fixed user here and as an arbitrary UID in group 0 under `runAsNonRoot` — the [Google container best practices](https://cloud.google.com/architecture/best-practices-for-building-containers) cover the wider list.
- **The CDS training run is a build step.** The archive is produced inside the runtime stage, so it rebuilds exactly when the application layer does (`memory.md` has the commands and the no-database caveat).
- **Logs go to stdout as JSON** when the `json` profile is active — the log driver owns transport and rotation, the application owns structure.

A [Cloud Native Buildpacks](https://docs.spring.io/spring-boot/3.5/reference/packaging/container-images/cloud-native-buildpacks.html) build (`mvn spring-boot:build-image`) is the alternative when the image should come from the build tool alone; this `Containerfile` exists because the example's layers, training run and flags are the lesson.

## Native images for appliances

A GraalVM native image is an ahead-of-time compiled executable: no JVM shipped, no class loading at startup, a small RSS from the first millisecond. It fits specialised applications — appliances, CLI tools, function-as-a-service handlers — whose configuration is known at build time. The [Spring Boot reference's native section](https://docs.spring.io/spring-boot/3.5/reference/packaging/native-image/index.html) and [Introducing GraalVM Native Images](https://docs.spring.io/spring-boot/3.5/reference/packaging/native-image/introducing-graalvm-native-images.html) state the trade precisely: static analysis from the main entry point, a fixed classpath, no lazy loading, and a closed world in which profiles and `@ConditionalOnProperty` cannot change the bean graph at runtime.

**Building one** — two documented paths, both active in this unit:

1. Buildpacks: `mvn -Pnative spring-boot:build-image` produces an image with the native executable and no JVM ([how-to](https://docs.spring.io/spring-boot/3.5/how-to/native-image/developing-your-first-application.html)).
2. Native Build Tools: `mvn -Pnative native:compile`, with the `native` profile the Spring Boot parent already wires (`process-aot` plus reachability metadata). In this multi-module build the shared module installs first — the `Containerfile`'s `native-build` stage shows both commands in order.

**What Spring adds.** The AOT pass generates bean definitions, proxies and the GraalVM hint files (reflection, resources, serialization) — which is why `@RegisterReflectionForBinding` on `RabbitTopologyConfig` is load-bearing: Jackson reflects on the payload record at runtime, and static analysis cannot see that. Third-party libraries bring their own hints from the [GraalVM reachability metadata repository](https://github.com/oracle/graalvm-reachability-metadata), consulted automatically by the `add-reachability-metadata` goal; a library missing there is the documented case for a hand-written `reflect-config.json` ([advanced topics](https://docs.spring.io/spring-boot/3.5/reference/packaging/native-image/advanced-topics.html)).

**Running one.** The `native-runtime` stage of `Containerfile` is distroless: no shell, no JVM, one executable and the CA bundle it needs ([distroless images](https://github.com/GoogleContainerTools/distroless)). Native images take few runtime options — the heap bound becomes `-Xmx` on the executable, and the flags that belong to a JVM (CDS, GC choice) stop applying. Native tests are their own goal (`-PnativeTest`), and [testing native applications](https://docs.spring.io/spring-boot/3.5/how-to/native-image/testing-native-applications.html) covers what a slice test cannot prove about a closed-world build.

**When not to.** A service that needs runtime reconfiguration, a large heap or G1-grade collection at scale stays on the JVM — where CDS and the AOT cache in `memory.md` already take most of the startup and footprint win. [Checkpoint/restore](https://docs.spring.io/spring-boot/3.5/reference/packaging/checkpoint-restore.html) is the third option: a JVM process snapshotted after warmup and restored in milliseconds, at the cost of a runtime that supports CRIU.

## References

- [Spring Boot — container images: Dockerfiles](https://docs.spring.io/spring-boot/3.5/reference/packaging/container-images/dockerfiles.html) (the layered example this unit follows)
- [Spring Boot — efficient container images](https://docs.spring.io/spring-boot/3.5/reference/packaging/container-images/efficient-images.html)
- [GraalVM — native image reference](https://www.graalvm.org/latest/reference-manual/native-image/)
- [Spring Boot — packaging for production](https://docs.spring.io/spring-boot/3.5/reference/using/packaging-for-production.html)
