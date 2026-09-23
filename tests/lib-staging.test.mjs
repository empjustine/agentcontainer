/**
 * @fileoverview lib-staging.test.mjs — guards the two EXPLICIT lib/ staging
 * lists (coding-agent/generate.mjs's scratch-lib copy loop and coding-agent/
 * run.sh's /opt/lib mounts). Both lists are hand-maintained, and a module
 * missing from either costs EVERY generator an ERR_MODULE_NOT_FOUND instead
 * of one clear line — this exact failure has happened twice: artifact.mjs
 * itself (see run.sh's comment) and canonical-json.mjs when d050 added it
 * (docs/d050). The test derives what must be staged from the code: every
 * `${LIB_DIR}/x.mjs` reference in coding-agent/'s generators, plus the
 * transitive closure of those modules' own relative runtime imports.
 *
 * Run: node --test   (discovers tests/*.test.mjs from the repo root)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ p) => readFileSync(p, "utf8");

/** @returns {Set<string>} modules referenced as `${LIB_DIR}/x.mjs` */
function collectLibDirRefs() {
	/** @type {Set<string>} */
	const refs = new Set();
	const genDir = join(repoRoot, "coding-agent");
	for (const f of readdirSync(genDir).filter((n) => n.endsWith(".mjs"))) {
		for (const m of read(join(genDir, f)).matchAll(/\$\{LIB_DIR\}\/([\w.-]+\.mjs)/g)) {
			refs.add(/** @type {string} */ (m[1]));
		}
	}
	return refs;
}

/**
 * Runtime sibling imports (`from "./x.mjs"`) of a staged lib module — the
 * transitive edge d050's canonical-json.mjs rode in on: no generator names
 * it, but artifact.mjs imports it, so it must be staged all the same.
 * @param {string} libFile
 * @returns {string[]}
 */
function siblingImports(libFile) {
	const path = join(repoRoot, "lib", libFile);
	if (!existsSync(path)) return [];
	return [...read(path).matchAll(/from\s+["']\.\/([\w.-]+\.mjs)["']/g)].map((m) =>
		String(m[1]),
	);
}

/** @returns {Set<string>} transitive closure: LIB_DIR refs + their imports */
function requiredStagedModules() {
	const required = collectLibDirRefs();
	// Fixed-point expansion: lib modules currently import siblings directly,
	// but the closure must not assume depth 1 if that ever changes.
	let grew = true;
	while (grew) {
		grew = false;
		for (const f of [...required]) {
			for (const dep of siblingImports(f)) {
				if (!required.has(dep)) {
					required.add(dep);
					grew = true;
				}
			}
		}
	}
	return required;
}

test("scratch staging loop carries every module the generators import (transitively)", () => {
	const src = read(join(repoRoot, "coding-agent", "generate.mjs"));
	// The lib copy loop is the only `for (const f of [...])` with an inline
	// array literal (the generator list is the identifier GENERATORS).
	const match = src.match(/for \(const f of (\[[^\]]*\])\) \{/);
	assert.ok(match, "staging loop with inline array not found in generate.mjs");
	/** @type {string[]} */
	const staged = JSON.parse(/** @type {string} */ (match[1]));

	for (const mod of requiredStagedModules()) {
		assert.ok(
			staged.includes(mod),
			`lib/${mod} is imported by the generators but missing from ` +
				`generate.mjs's staging list — every staged run would crash`,
		);
	}
});

test("run.sh mounts carry every module the generators import (transitively)", () => {
	const src = read(join(repoRoot, "coding-agent", "run.sh"));
	const mounted = new Set(
		[...src.matchAll(/workload_ro "\$REPO_ROOT\/lib\/([\w.-]+)"/g)].map((m) =>
			String(m[1]),
		),
	);

	for (const mod of requiredStagedModules()) {
		assert.ok(
			mounted.has(mod),
			`lib/${mod} is imported by the generators but run.sh does not ` +
				`mount it — the in-container run would crash`,
		);
	}
});
