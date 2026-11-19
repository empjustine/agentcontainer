---
id: d219
type: module-design
status: active
title: "d219 — Java static analysis without a SonarQube server: Checkstyle, PMD and SpotBugs as Maven plugins"
parent: sbex
references: [sbex, sbex-static-analysis, d193, d122, d137, d139]
tags: ["java", "static-analysis", "sonarqube", "maven", "lint", "sbex"]
---

# d219 — Java static analysis without a SonarQube server

**Status: landed.** `./lint.sh` gained an sbex leg that runs a Maven profile
binding Checkstyle, PMD, SpotBugs and javac's own `-Xlint:all -Werror`. The
rule files live in `sbex/`; there is no server, no database and no scanner
upload.

## Problem

The QA sweep covers shell (shellcheck), JavaScript/TypeScript (biome, oxlint,
knip, tsc), Python (ruff, ty), Go (golangci-lint), Markdown (oxfmt) and JSON.
Java was the gap: sbex had a Maven enforcer for the toolchain and a JUnit suite
for behaviour, and nothing that read the code for defects.

The obvious name in Java static analysis is SonarQube, and it is the wrong
shape for a repository sweep. SonarQube is a service: a JVM, a PostgreSQL, a
volume, and a scanner that uploads a report. The community edition has no
branch/PR analysis; the dashboard is the product, and a dashboard is not a gate
a lint script can run per host. Requiring an instance would put a daemon in
front of every Java change, which is the one thing the other language legs do
not do.

## Decision

**Four serverless checks, all inside the build, under an opt-in Maven
profile:**

- **javac** with `-Xlint:all -Werror` — the compiler's own bug patterns
  (deprecation, unchecked, serial, fallthrough, this-escape).
- **Checkstyle** at `validate` — a curated structural rule set (imports,
  braces, equality, switch shape, empty catch), not the google/sun style
  configuration, which reports over a thousand formatting findings on this unit.
- **PMD** at `verify` — the bug-pattern, best-practice, concurrency,
  performance and security categories; the source-level half of what Sonar's
  Java analyzer reports.
- **SpotBugs** at `verify` — bytecode bug patterns (null paths,
  representation leaks, resource obligations) with a waiver filter.

**One unit entry, one lint leg.** `sbex/lint.mjs` probes the toolchain and
runs `sbex` with `-Pstatic verify`; `./lint.sh` calls it after the Go leg
and skips loudly without a JDK/Maven, the same posture as golangci-lint.

**The rule sets live beside the code** (`checkstyle.xml`,
`pmd-ruleset.xml`, `spotbugs-exclude.xml`), because a folder is a copy unit
(d113): a copied-out sbex carries the rules, as estige carries `.golangci.yml`.
A waiver is a line in that file with its reason, never a `@SuppressWarnings`
scattered through the classes.

**The toolchain pins are in `dev-tools.sh`** (d139): JDK 21 and Maven 3.9.16,
acquired on demand and not part of `DEV_TOOLS_ALL` — no other unit needs them.
The analyzers themselves are Maven plugins pinned in `sbex/pom.xml`, so the
plugin set moves with the pom, not with a second tool table.

## Consequences

- **The first Java lint run downloads** the JDK/Maven (mise) and the Maven
  plugin/dependency set into `~/.m2`. After that the gate reads the tree and
  the cache. It is a dependency fetch, not subject data, so the offline
  contract `./freshness.sh` owns (d122) is untouched — the same posture the
  Go suite's module resolution already had.
- **A host without a JDK or Maven skips the leg loudly.** A green sweep on such
  a host does not mean Java was checked; the log line is the signal (the Go
  leg's rule).
- **No history, no UI, no quality-gate configuration.** The exit status is the
  gate and the review is the git diff. A dashboard can consume the plugins'
  reports later if one is ever required.
- **No taint analysis.** The commercial Sonar editions and dedicated SAST
  tools own that; this gate is pattern-based.
- **Formatting is out of scope.** There is no Spotless/google-java-format step;
  the unit's tab style is deliberate and a formatter would rewrite the example
  for no analysis gain.
- **New findings fail the build.** The baseline is green, and the waivers are
  the four PMD rule families and two SpotBugs patterns recorded in
  `sbex/static-analysis.md` with reasons.

## Alternatives rejected

- **A SonarQube (CE) instance.** A service, a database and a volume, plus a
  scanner upload; no branch/PR analysis in the free edition, and a dashboard is
  not a lint gate. It would also be the only language leg that needs a daemon.
- **Error Prone.** The strongest compile-time analyzer, but it needs compiler
  flags, `--add-exports` and an annotation-processor classpath, and it
  overlaps PMD's error-prone category. It is the next step if a bug class is
  missed, not the first tool for an example.
- **Standalone PMD/Checkstyle/SpotBugs CLI distributions.** Each is another
  acquisition path and loses the build's classpath; the Maven plugins reuse one
  toolchain and pin the analyzers in the pom.
- **Spotless/google-java-format.** A formatter, not a bug finder; it would
  reformat the unit and consume the gate's attention with style churn.
- **Semgrep, CodeQL or Infer.** Different models (rule language, database
  build, daemon/credentials); each is a project of its own and none is a
  per-language leg of this sweep today.
- **OWASP dependency-check.** Useful, but it wants the NVD feed and network on
  every run; that belongs to the freshness gate, not here.

## References

- `sbex/static-analysis.md` (id `sbex-static-analysis`) — the unit doc: the
  stack, the measured baseline, waivers, and how to extend it.
- `docs/d193-spring-boot-4-1-migration.md` — the Spring Boot/Java pin the
  analyzers run against.
- `docs/d122` — the offline contract only `./freshness.sh` may cross.
- `docs/d137`, `docs/d139` — the pin posture and the one install path.
- `sbex/lint.mjs`, `sbex/pom.xml` (the `static` profile), `./lint.sh` —
  the mechanics.
