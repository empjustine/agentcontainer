---
id: sbex-static-analysis
type: submodule-design
status: active
title: "sbex static analysis: the serverless Java gate (Checkstyle, PMD, SpotBugs, javac)"
parent: sbex
references: [d219, d193, sbex-java-and-tooling]
tags: ["java", "static-analysis", "checkstyle", "pmd", "spotbugs", "sonarqube", "maven"]
---

# Static analysis: the serverless Java gate

This file owns the static-analysis stack sbex runs: the analyzers, their phases and rule files, what a waiver means, and what a SonarQube deployment would and would not add. It does not own the build or test procedure (README.md) or the Spring Boot/Java pins (d193, pom.xml). The reader arrives wanting to run the gate, add a rule, or justify the absent dashboard.

## The stack

| Gate      | Tool                                       | Phase    | Rule source                 | What it catches                                                  |
| --------- | ------------------------------------------ | -------- | --------------------------- | ---------------------------------------------------------------- |
| Compiler  | javac `-Xlint:all -Werror`                 | compile  | `static` profile in pom.xml | deprecation, unchecked, serial, fallthrough, this-escape         |
| Structure | Checkstyle (maven-checkstyle-plugin 3.6.0) | validate | `checkstyle.xml`            | imports, braces, equality, switch shape, empty catch             |
| Source    | PMD (maven-pmd-plugin 3.28.0)              | verify   | `pmd-ruleset.xml`           | bug patterns, best practices, concurrency, performance, security |
| Bytecode  | SpotBugs (spotbugs-maven-plugin 4.10.5.0)  | verify   | `spotbugs-exclude.xml`      | null paths, representation leaks, resource obligations           |

All four run under the opt-in `static` Maven profile, so the ordinary build and the test sweep are unchanged and the gate is one command:

```sh
./node-run.sh sbex/lint.mjs                 # the unit entry; needs java/mvn on PATH (the sweep supplies them)
(cd sbex && mvn -Pstatic verify)            # the same thing by hand
```

`./lint.sh` runs the unit entry as its Java leg. The rule files live here, beside the code, for the copy-unit reason (d113): a copied-out sbex carries its rules, as estige carries `.golangci.yml`.

## Why not SonarQube

- **It is a service, not an analyzer.** SonarQube Community Build needs a JVM, a PostgreSQL database and a persistent volume, and the scanner uploads a report to it. A per-host, per-run lint sweep cannot require an instance; the requirement is exactly what this gate avoids.
- **The free edition has no branch/PR analysis.** The per-change quality gate — the part that makes Sonar useful in review — is a commercial feature; the free edition analyzes a branch and shows a dashboard.
- **The dashboard is not the gate.** The open rule engines Sonar's Java analyzer grew out of are the ones this unit runs. What a server adds is rule metadata, history, cross-project aggregation and (commercially) taint analysis. Here the quality gate is the process exit status, and the review is the git diff.
- **If a dashboard is ever required**, the plugins already emit their reports under `target/` (XML/HTML); a server can consume them later. Nothing in this stack prevents that.

## The measured baseline at landing

- **Checkstyle (curated): 0.** The rule set is the structural subset, not `google_checks.xml`: that configuration reports over a thousand findings on this unit for tab indentation and javadoc that are not this tree's style, and a gate nobody can turn green is noise.
- **PMD: 18 across the reactor.** Four were fixed: a missing `serialVersionUID` on both exception classes, and two field/method name collisions (`StoredProcedureGateway.orderScore`, `PersistenceContractTest.dialect`). The rest are four waived rule families, each with the reason in `pmd-ruleset.xml`: `GuardLogStatement` (parameterized SLF4J needs no guard), `UnitTestContainsTooManyAsserts` (a contract test asserts one scenario), `UnitTestShouldIncludeAssert` (MockMvc asserts through `andExpect`) and `TestClassWithoutTestCases` (the abstract contract base; the subclasses inherit the `@Test`s).
- **SpotBugs: nine.** One was a real bug: `OrderEventPublisher` called `correlation.getReturned()` twice, so a null return could be dereferenced on the second call; it now reads the message once into a local and null-checks that. The other eight are waived in `spotbugs-exclude.xml`: seven `EI_EXPOSE_REP2` findings on constructor-injected framework beans, and one `OBL_UNSATISFIED_OBLIGATION_EXCEPTION_EDGE` where a `PreparedStatementCreator` hands the statement to `JdbcTemplate`, which closes it.
- **javac: two deprecation warnings**, both from Testcontainers 2 moving `PostgreSQLContainer`; fixed, so `-Werror` stays on. A future JDK or dependency deprecation is then a review decision, not a warning nobody reads.

## Waivers

A finding is fixed first. A waiver is a line in the rule file with the reason beside it — an `exclude` in `pmd-ruleset.xml` or a `Match` in `spotbugs-exclude.xml` — never a `@SuppressWarnings` at the call site. One home for the decision means the next reader sees the whole set, and a waiver cannot hide inside a class. Narrow it where the analyzer allows: a bug pattern plus class beats a whole-type exclusion.

## Acquisition and the offline posture

- `./lint.sh` resolves the pinned JDK 21 and Maven from `dev-tools.sh` on a dev host, or the host binaries elsewhere; no toolchain means a loud skip, the same posture as the Go leg.
- The Maven plugins and the project's dependencies resolve from Maven Central on the first run and stay in `~/.m2`. The gate then reads the tree and that cache. A dependency fetch is not subject data, so this does not cross the offline contract `./freshness.sh` owns (d122).
- The first run on a clean host downloads the JDK/Maven (mise) and the plugin set; the cost is paid once and is visible in the tool's own log.

## Extending

- **A PMD rule:** add or narrow a category reference in `pmd-ruleset.xml`, rerun, and only then commit it — a rule that floods the tree is a rule nobody keeps.
- **A SpotBugs plugin** such as FindSecBugs: a `pluginList` entry in the `static` profile, then rerun; waivers still go to the filter. It is not here at landing because SpotBugs' own security patterns run and nothing needed the extra set.
- **Error Prone** is the next tool to consider if a bug class is missed: it runs inside javac and needs compiler flags plus `--add-exports`. It overlaps PMD's error-prone category, which is why the example starts without it (d219 records the choice).

## What this is not

- **Not a formatter.** There is no google-java-format or Spotless step; the unit's tab style is deliberate and reformatting the example is a separate decision.
- **Not a security review.** The security rules catch a class of mistakes, not taint flows; a vulnerability scan of the dependency tree (OWASP dependency-check) is a network/NVD concern that belongs with `./freshness.sh`.
- **Not a replacement for the tests.** `tests/run.sh` owns behaviour; this gate reads the test sources as another input and gives a second, independent opinion.
