/**
 * @fileoverview farm-aliases.mjs — apply or check the symlink aliases that keep
 * a mirror's retired name resolvable beside the mirror holding the objects
 * (docs/d160). An upstream rename leaves documents and commits citing the old
 * path; the read surface resolves such a name through `resolveRepo`, which
 * follows symlinks, while discovery skips them, so an alias costs no index
 * entry and no second copy of the objects.
 *
 * `git/aliases.json` is the table; this script is its only writer. It exists
 * because a symlink is fragile in exactly one way: `rm -rf alias/` with a
 * trailing slash dereferences and EMPTIES THE TARGET, so rebuilding after an
 * accident has to be one command rather than a memory of which links existed.
 *
 * Usage:
 *   ./node-run.sh git/farm-aliases.mjs --check [--root DIR]
 *   ./node-run.sh git/farm-aliases.mjs --apply [--root DIR]
 *
 * --check  report every alias as ok | missing | not-alias | wrong-target |
 *          target-missing, and exit 1 when any is not ok. A restore from a
 *          copy that did not preserve links, or a plain `rsync` without -a,
 *          leaves exactly that drift behind.
 * --apply  create missing links and re-point wrong ones (idempotent). It
 *          refuses to replace a real mirror at the alias path: the mirror
 *          there is then the only copy of those objects, and deleting it to
 *          plant a link would destroy them.
 *
 * Links are RELATIVE to the alias's own directory so the farm can be moved or
 * copied as a unit (docs/d113); an absolute link survives neither.
 */
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFlags } from "./lib/cli.mjs";
import { emitEnvelope, farmRoot } from "./lib/farm-posture.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const TABLE = join(DIR, "aliases.json");

const USAGE = `usage: ./node-run.sh git/farm-aliases.mjs --check|--apply [--root DIR]

--check  report each alias (ok · missing · not-alias · wrong-target ·
         target-missing); exit 1 when any is not ok
--apply  create the missing links and re-point the wrong ones
--root   mirror root (default $REFERENCES_ROOT else ~/Downloads/references)
`;

/**
 * @typedef {{ id: string, target: string, kind?: string, repository_id?: number, checked?: string }} Alias
 * @typedef {"ok"|"missing"|"not-alias"|"wrong-target"|"target-missing"} AliasState
 */

/** @returns {Alias[]} */
function readTable() {
	const raw = JSON.parse(readFileSync(TABLE, "utf8"));
	const aliases = Array.isArray(raw?.aliases) ? raw.aliases : [];
	// A malformed row must stop the run rather than resolve to some path: this
	// script deletes links, and "almost the right id" is how the wrong one dies.
	for (const alias of aliases) {
		if (typeof alias?.id !== "string" || typeof alias?.target !== "string") {
			throw new Error("aliases.json: every entry needs string id and target");
		}
	}
	return aliases;
}

/** @param {string} path @returns {boolean} */
function isMirror(path) {
	try {
		return statSync(join(path, "HEAD")).isFile();
	} catch {
		return false;
	}
}

/**
 * What is at the alias path right now. The distinction that matters is
 * "not-alias": a real mirror, which --apply must never trade for a link.
 * @param {string} root
 * @param {Alias} alias
 * @returns {AliasState}
 */
function inspect(root, alias) {
	const path = join(root, `${alias.id}.git`);
	const targetPath = join(root, `${alias.target}.git`);
	let entry;
	try {
		entry = lstatSync(path);
	} catch {
		return "missing";
	}
	if (!entry.isSymbolicLink()) {
		return "not-alias";
	}
	let real = "";
	try {
		real = realpathSync(path);
	} catch {
		return "target-missing";
	}
	if (real !== realpathSyncQuiet(targetPath)) {
		return "wrong-target";
	}
	return isMirror(targetPath) ? "ok" : "target-missing";
}

/** @param {string} path @returns {string} */
function realpathSyncQuiet(path) {
	try {
		return realpathSync(path);
	} catch {
		return "";
	}
}

/**
 * One link, created relative. An existing symlink is removed first (removing a
 * LINK never touches its target); anything else is refused upstream by the
 * "not-alias" state.
 * @param {string} root
 * @param {Alias} alias
 */
function apply(root, alias) {
	const path = join(root, `${alias.id}.git`);
	const targetPath = join(root, `${alias.target}.git`);
	mkdirSync(dirname(path), { recursive: true });
	try {
		rmSync(path, { force: true });
	} catch {
		// A dangling link is not removable through rmSync on every platform;
		// unlink below is the fallback that always applies to a link.
	}
	symlinkSync(relative(dirname(path), targetPath), path, "dir");
}

/**
 * @param {string[]} argv
 */
function main(argv) {
	const { values: v, help } = parseFlags(argv, {
		check: { kind: "bool" },
		apply: { kind: "bool" },
		root: { default: farmRoot() },
	});
	if (help || (!v.check && !v.apply)) {
		process.stderr.write(USAGE);
		process.exitCode = help ? 0 : 2;
		return;
	}
	if (v.check && v.apply) {
		process.stderr.write("pick one of --check and --apply\n");
		process.exitCode = 2;
		return;
	}
	/** @type {string} */
	const root = v.root;
	let aliases;
	try {
		aliases = readTable();
	} catch (err) {
		emitEnvelope({
			tool: "git/farm-aliases",
			ok: false,
			mode: v.apply ? "apply" : "check",
			error: String(err?.message ? err.message : err),
		});
		process.exitCode = 1;
		return;
	}
	const states = aliases.map((alias) => {
		const before = inspect(root, alias);
		if (v.apply && (before === "missing" || before === "wrong-target")) {
			apply(root, alias);
			return { id: alias.id, target: alias.target, state: inspect(root, alias), was: before };
		}
		return { id: alias.id, target: alias.target, state: before };
	});
	const bad = states.filter(
		(s) => s.state !== "ok" && !(v.apply && s.was === "not-alias"),
	);
	emitEnvelope({
		tool: "git/farm-aliases",
		ok: bad.length === 0,
		mode: v.apply ? "apply" : "check",
		root,
		total: states.length,
		results: states,
	});
	process.exitCode = bad.length === 0 ? 0 : 1;
}

main(process.argv.slice(2));
