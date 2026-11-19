#!/usr/bin/env node
/**
 * @fileoverview lint.mjs — the unit's static-analysis entry (docs/d219): one
 * exit status for the serverless Java gate. It runs the Maven `static` profile,
 * which binds Checkstyle at validate, PMD and SpotBugs at verify, and adds
 * javac's own `-Xlint:all -Werror`. There is no SonarQube server and no scanner
 * upload: the rule files beside this file are the rule set, and the exit code
 * is the gate.
 *
 * WHY verify and not the analyzer goals directly: SpotBugs reads bytecode, so
 * the reactor must compile first and the sibling modules must be on the
 * classpath. verify is the phase in which all three analyzers have run.
 *
 * Usage: ./node-run.sh sbex/lint.mjs
 * Exit 94: no working java or mvn (the repo's "toolchain missing" code).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const unitDir = dirname(fileURLToPath(import.meta.url));

// WHY the env overrides: this script runs under ./node-run.sh, whose mise
// branch (docs/d138) rebuilds PATH from node's own tool set — a java/mvn a
// caller prepended to PATH is gone by the time the child runs. JAVA_HOME
// survives (env, not PATH), so the sweep hands both paths through env instead
// of relying on PATH; a direct run with the toolchain on PATH still works.
const javaBin = process.env.JAVA_HOME
	? join(process.env.JAVA_HOME, "bin", "java")
	: "java";
const mvnBin = process.env.SBEX_MVN || "mvn";

/**
 * Whether a probe command exits 0. java -version writes its banner to stderr,
 * so the exit status is the only signal that works for every tool.
 * @param {string} command
 * @param {string[]} args
 * @returns {boolean}
 */
function probe(command, args) {
	return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

if (!probe(javaBin, ["-version"])) {
	console.error(
		"sbex/lint: no working java on PATH — install a JDK 21+ (./dev-tools.sh java)",
	);
	process.exit(94);
}
if (!probe(mvnBin, ["-version"])) {
	console.error(
		"sbex/lint: no working mvn on PATH — install Maven 3.9+ (./dev-tools.sh maven)",
	);
	process.exit(94);
}

// -DskipTests: sbex/tests/run.sh owns the tests; the analyzers still read the
// test sources (Checkstyle/PMD include them) and SpotBugs reads main bytecode.
const result = spawnSync(
	mvnBin,
	["-B", "-ntp", "-DskipTests", "-Pstatic", "verify"],
	{ cwd: unitDir, stdio: "inherit" },
);
process.exit(result.status ?? 1);

