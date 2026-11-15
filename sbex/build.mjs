/**
 * @fileoverview build.mjs — build sbex for THIS host (the unit's own build
 * entry; docs/d083/d113 made every builder per-unit). Maven is the build
 * system — this entry only probes the toolchain so a host without a JDK fails
 * with one line naming what is missing, instead of a shell "command not
 * found" from deep inside a reactor build.
 *
 * Usage: ./node-run.sh sbex/build.mjs [maven-args...]
 * No argv runs `-B -ntp verify` (compile, test, package); argv replaces that
 * goal list verbatim, e.g. ./node-run.sh sbex/build.mjs -B -ntp -DskipTests package.
 *
 * Exit 94: no working java or mvn (the repo's "toolchain missing" code).
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const unitDir = dirname(fileURLToPath(import.meta.url));

/**
 * Whether a probe command exits 0. `java -version` writes its banner to
 * stderr, so the exit status is the only signal that works for every tool.
 * @param {string} command
 * @param {string[]} args
 * @returns {boolean}
 */
function probe(command, args) {
	return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

if (!probe("java", ["-version"])) {
	console.error(
		"sbex/build: no working java on PATH — install a JDK 21+ (sbex/README.md lists the toolchain)",
	);
	process.exit(94);
}
if (!probe("mvn", ["-version"])) {
	console.error(
		"sbex/build: no working mvn on PATH — install Maven 3.9+ (sbex/README.md lists the toolchain)",
	);
	process.exit(94);
}

const argv = process.argv.slice(2);
const goals = argv.length > 0 ? argv : ["-B", "-ntp", "verify"];
const result = spawnSync("mvn", goals, { cwd: unitDir, stdio: "inherit" });
process.exit(result.status ?? 1);
