/**
 * @fileoverview Pins the enumeration that decides codemode2's surface (docs/d194):
 * the two corpus parsers, the class order, the attack projection, and the
 * invariants that hold offline over the committed surface and projection.
 *
 * WHY the corpora are fixtures here: the real mirrors live on the farm, so a
 * suite that read them would be a network test. The fixtures reproduce the two
 * shapes that carry the meaning — GTFOBins' contexts (including a context's own
 * extra field) and LOLBAS's per-command Category — and the committed JSON files
 * are checked for the properties that must survive regeneration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	attacksFor,
	parseGtfobins,
	parseLolbas,
	posixClass,
	unprivilegedFunctions,
	windowsClass,
} from "../enumerate.mjs";

/**
 * @typedef {{ command: string, strategy: string, grants: string[], allow: string[], deny: string[], corpus: string[], categories: string[], note?: string }} Row
 * @typedef {{ posix: Row[], windows: Row[], denied: Array<{ os: string, family: string[], reason: string }> }} Surface
 * @typedef {{ name: string, corpus: string | null, functions: string[], categories: string[], class: string }} ProjectionRow
 * @typedef {{ command: string, function: string, code: string }} Attack
 * @typedef {{
 *   sources: {
 *     gtfobins: { files: number, canonical: number, aliases: number },
 *     lolbas: { categories: Record<string, number> }
 *   },
 *   functions: Record<string, { total: number, unprivileged: number }>,
 *   classes: { posix: Record<string, number>, windows: Record<string, number> },
 *   posix: ProjectionRow[],
 *   windows: ProjectionRow[]
 * }} Taxonomy
 */

/** @param {string} name @returns {unknown} */
function committed(name) {
	return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
}

const ENTRY = [
	"---",
	"functions:",
	"  file-read:",
	"  - code: |-",
	"      tool /path/to/input-file",
	"    contexts:",
	"      sudo:",
	"      suid:",
	"      unprivileged:",
	"  shell:",
	"  - code: |-",
	"      tool -c '/bin/sh'",
	"    comment: |-",
	"      A comment is not a context.",
	"    contexts:",
	"      sudo:",
	"      suid:",
	"        shell: true",
	"  command:",
	"  - code: tool inline-arg",
	"...",
].join("\n");

test("a GTFOBins entry parses functions, contexts and code", () => {
	const entry = parseGtfobins(ENTRY);
	assert.deepEqual([...entry.functions.keys()], ["file-read", "shell", "command"]);
	const read = entry.functions.get("file-read");
	assert.deepEqual([...(read?.contexts ?? [])].sort(), ["sudo", "suid", "unprivileged"]);
	assert.equal(read?.examples[0]?.code, "tool /path/to/input-file");
	const shell = entry.functions.get("shell");
	assert.deepEqual([...(shell?.contexts ?? [])].sort(), ["sudo", "suid"]);
	assert.equal(shell?.examples[0]?.code, "tool -c '/bin/sh'");
	const inline = entry.functions.get("command");
	assert.equal(inline?.examples[0]?.code, "tool inline-arg");
	assert.deepEqual([...(inline?.contexts ?? [])], []);
});

test("an alias entry carries no functions", () => {
	const entry = parseGtfobins("---\nalias: mawk\n...\n");
	assert.equal(entry.alias, "mawk");
	assert.equal(entry.functions.size, 0);
});

test("unprivileged reachability follows the context default", () => {
	const entry = parseGtfobins(ENTRY);
	assert.deepEqual(unprivilegedFunctions(entry), ["command", "file-read"]);
});

test("LOLBAS categories are read per command and deduplicated", () => {
	const source = [
		"---",
		"Name: Tool.exe",
		"Commands:",
		"  - Command: tool.exe -x {URL}",
		"    Category: Download",
		"  - Command: tool.exe -y {PATH}",
		"    Category: Download",
		"  - Command: tool.exe -z",
		"    Category: Execute",
		"---",
	].join("\n");
	assert.deepEqual(parseLolbas(source), ["Download", "Execute"]);
});

test("the class order is severity, not alphabet", () => {
	assert.equal(posixClass(["file-read", "shell"]), "shell");
	assert.equal(posixClass(["file-read", "download"]), "transfer");
	assert.equal(posixClass(["file-read", "file-write"]), "write");
	assert.equal(posixClass(["file-read"]), "read");
	assert.equal(posixClass([]), "privileged");
	assert.equal(windowsClass(["ADS", "Execute"]), "exec");
	assert.equal(windowsClass(["Copy"]), "transfer");
	assert.equal(windowsClass(["ADS"]), "other");
});

test("the attack projection keeps only the functions the surface refuses", () => {
	const entry = parseGtfobins(ENTRY);
	const attacks = attacksFor({ posix: [{ command: "tool", grants: ["fs.read"] }] }, new Map([["tool", entry]]));
	assert.deepEqual(
		attacks.map((attack) => /** @type {{ function: string }} */ (attack).function),
		["command", "shell"],
	);
	assert.equal(/** @type {{ code: string }} */ (attacks[1]).code, "tool -c '/bin/sh'");
});

test("no surface command asks for a withheld grant", () => {
	const surface = /** @type {Surface} */ (committed("surface.json"));
	for (const row of [...surface.posix, ...surface.windows]) {
		for (const grant of row.grants) {
			assert.ok(!["net", "exec"].includes(grant), `${row.command} asks for ${grant}`);
			assert.ok(["fs.read", "fs.write", "env", "clock"].includes(grant), `${row.command}: unknown grant ${grant}`);
		}
	}
});

test("the surface is one table with no command in two places", () => {
	const surface = /** @type {Surface} */ (committed("surface.json"));
	for (const group of [surface.posix, surface.windows]) {
		const names = group.map((row) => row.command);
		assert.equal(new Set(names).size, names.length, "duplicate command in one OS surface");
	}
	/** @type {Array<[string, Row[]]>} */
	const groups = [
		["posix", surface.posix],
		["windows", surface.windows],
	];
	for (const [os, own] of groups) {
		const surfaced = new Set(own.map((row) => row.command));
		const denied = surface.denied.filter((row) => row.os === os).flatMap((row) => row.family);
		for (const name of denied) {
			assert.ok(!surfaced.has(name), `${name} is both surfaced and denied on ${os}`);
		}
	}
});

test("every command declares a strategy, a grant, and its flags", () => {
	const surface = /** @type {Surface} */ (committed("surface.json"));
	for (const row of [...surface.posix, ...surface.windows]) {
		assert.ok(["reimplement", "broker"].includes(row.strategy), row.command);
		assert.ok(row.grants.length > 0, `${row.command} declares no grant`);
		for (const flag of [...row.allow, ...row.deny]) {
			assert.match(
				flag,
				/^(-{1,2}[\w-]+|\/[\w]+|[A-Za-z]+|[a-z]+\/\/\/[a-z]+)$/,
				`${row.command}: not a flag or construct: ${flag}`,
			);
		}
		assert.deepEqual(
			row.allow.filter((flag) => row.deny.includes(flag)),
			[],
			`${row.command} allows and refuses the same flag`,
		);
	}
});

test("the projection and the surface agree", () => {
	const taxonomy = /** @type {Taxonomy} */ (committed("taxonomy.json"));
	const surface = /** @type {Surface} */ (committed("surface.json"));
	const attacks = /** @type {Attack[]} */ (committed("attack-corpus.json"));
	const corpusFunctions = new Set(Object.keys(taxonomy.functions));
	const row = new Map([...taxonomy.posix, ...taxonomy.windows].map((entry) => [entry.name, entry]));
	for (const item of surface.posix) {
		assert.ok(row.has(item.command), `no projection row for ${item.command}`);
		for (const fn of item.corpus) {
			assert.ok(corpusFunctions.has(fn), `${item.command}: unknown corpus function ${fn}`);
		}
	}
	const categoryVocabulary = new Set(Object.keys(taxonomy.sources.lolbas.categories));
	for (const item of surface.windows) {
		assert.ok(row.has(item.command), `no projection row for ${item.command}`);
		for (const category of item.categories) {
			assert.ok(categoryVocabulary.has(category), `${item.command}: unknown LOLBAS category ${category}`);
		}
	}
	for (const attack of attacks) {
		assert.ok(row.has(attack.command), `attack for an unknown command ${attack.command}`);
		assert.ok(corpusFunctions.has(attack.function), `${attack.command}: unknown function ${attack.function}`);
		assert.ok(attack.code.length > 0, `${attack.command}: empty probe`);
	}
});

test("the committed counts stay self-consistent", () => {
	const taxonomy = /** @type {Taxonomy} */ (committed("taxonomy.json"));
	const gtfobins = taxonomy.sources.gtfobins;
	assert.equal(gtfobins.files, gtfobins.canonical + gtfobins.aliases);
	assert.equal(
		Object.values(taxonomy.classes.posix).reduce((sum, count) => sum + count, 0),
		taxonomy.posix.length,
	);
	for (const functions of Object.values(taxonomy.functions)) {
		assert.ok(functions.unprivileged <= functions.total, "unprivileged exceeds total");
	}
});
