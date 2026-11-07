/**
 * @fileoverview The spec-graph contract, enforced mechanically (docs/d140).
 *
 * WHAT: walks every Markdown file in the tree (minus the tool-owned scratch
 * directories), reads its frontmatter, and reports every violation of
 * docs/spec-graph-standard.md that a machine can decide — the vocabulary, the
 * required fields, id spelling and uniqueness, the nesting rules, the d117
 * file/edge agreement, and the YAML quoting trap that silently drops a node
 * out of the graph.
 *
 * WHY it exists: the ThinkRail validator checks three things (duplicate ids,
 * dangling links, parent cycles) and is silent about everything else, so the
 * vocabulary drifted unnoticed — seven records carried `type: decision` and
 * `status: implemented` until a reader happened to grep — and the standard's
 * own hand-maintained nesting roster went stale. This file is the part of the
 * contract a human should not have to re-derive with a grep pipeline.
 *
 * USAGE: `./node-run.sh docs/spec-check.mjs [root]` — the gate leg in lint.sh.
 * Exit 0 clean, 1 findings, 2 cannot read the tree. Findings are plain lines on
 * stdout (path, code, sentence) because a gate's output is meant to be read and
 * diffed, not parsed; the JSON-stream convention (docs/d045) is for tools whose
 * output IS a payload.
 *
 * The rules and their boundaries are documented in docs/spec-graph-standard.md's
 * "Mechanical enforcement" section — this file is the executable half of that
 * contract, and docs/tests/spec-check.test.mjs pins the behaviour of both.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The five types — scope, not genre. @type {readonly string[]} */
const TYPES = [
	"goal-and-requirements",
	"architecture-design",
	"module-design",
	"submodule-design",
	"task-spec",
];

/** The five lifecycle values. @type {readonly string[]} */
const STATUSES = ["draft", "active", "stale", "done", "deprecated"];

/** Fields whose values are id lists, not prose. @type {readonly string[]} */
const EDGE_FIELDS = ["depends-on", "references", "implements"];

/**
 * Directories that hold no repository source: git internals, the installed npm
 * and python trees, and ThinkRail's scratch folder (its task-specs are real
 * nodes, but they are the tool's, not this tree's — the standard excludes them
 * so a checkout without the tooling sees the same tree).
 *
 * NOT the set the ThinkRail tools use: measured against the tooling (d140's
 * amendment), they skip `node_modules` and index `.venv/` and `.thinkrail/`
 * along with every other tree, `.gitignore` or not. Skipping those two stays
 * right — a rebuilt venv must not change the gate's verdict — so the
 * disagreement is a deliberate blind spot the standard names, not a slip to fix
 * by widening this list.
 * @type {readonly string[]}
 */
const SKIP_DIRS = [".git", "node_modules", ".venv", ".thinkrail"];

/** Statuses that may park a module-design doc at the system level: archived work. @type {readonly string[]} */
const ARCHIVED_STATUSES = ["done", "deprecated"];

/**
 * @typedef {object} Doc
 * @property {string} path repo-relative, forward slashes
 * @property {string} folder the directory the file sits in, repo-relative
 * @property {string} source markdown contents
 */

/**
 * @typedef {object} SpecNode
 * @property {string} path
 * @property {string} folder
 * @property {string} id
 * @property {string} type
 * @property {string} [status] absent, not "undefined" — `optional()` keeps the two apart
 * @property {string} [title]
 * @property {string} [parent]
 */

/**
 * @typedef {object} Finding
 * @property {string} path file the finding belongs to
 * @property {string} code stable identifier — the gate's own vocabulary
 * @property {string} message one sentence a reader can act on
 */

/**
 * A property that only exists when a value is present: `exactOptionalPropertyTypes`
 * (tsconfig.json) distinguishes "absent" from "present and undefined", and a
 * frontmatter field genuinely is absent, not undefined.
 * @template T
 * @param {string} key
 * @param {T | undefined} value
 * @returns {Record<string, T>}
 */
function optional(key, value) {
	return value === undefined ? {} : { [key]: value };
}

/**
 * Reads the leading `---` block. A file without one is not a node (a note); an
 * opening marker with no closer is a finding in itself, because every other
 * reader would swallow the whole document as frontmatter.
 * @param {string} source file contents
 * @returns {{ fields: Record<string, string>, lists: Record<string, string[]>, unterminated: boolean }}
 */
export function parseFrontmatter(source) {
	/** @type {Record<string, string>} */
	const fields = {};
	/** @type {Record<string, string[]>} */
	const lists = {};
	const lines = source.split("\n");
	if (lines[0]?.trim() !== "---") { return { fields, lists, unterminated: false }; }

	let end = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index]?.trim() === "---") {
			end = index;
			break;
		}
	}
	if (end === -1) { return { fields, lists, unterminated: true }; }

	/** @type {string | undefined} */
	let currentKey;
	for (const line of lines.slice(1, end)) {
		if (line.trim() === "") { continue; }
		const pair = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
		if (pair?.[1] !== undefined) {
			currentKey = pair[1];
			fields[currentKey] = pair[2] ?? "";
			continue;
		}
		const item = /^[ \t]*-[ \t]+(.*)$/.exec(line);
		if (item?.[1] !== undefined && currentKey !== undefined) {
			lists[currentKey] = [...(lists[currentKey] ?? []), unquote(item[1])];
		}
	}
	for (const [key, raw] of Object.entries(fields)) {
		const trimmed = raw.trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			lists[key] = trimmed
				.slice(1, -1)
				.split(",")
				.map((part) => unquote(part))
				.filter((part) => part !== "");
		}
	}
	return { fields, lists, unterminated: false };
}

/**
 * Strips one layer of matching quotes. Only the outer pair: a title with an
 * apostrophe is not a quoting problem, a value containing `: ` is.
 * @param {string} raw
 * @returns {string}
 */
function unquote(raw) {
	const trimmed = raw.trim();
	const quoted =
		(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1);
	return quoted ? trimmed.slice(1, -1) : trimmed;
}

/**
 * A value carrying `": "` but no quotes truncates at that colon in every YAML
 * reader — the node leaves the graph with a green exit code (the standard's
 * "Two hard rules").
 * @param {string} raw
 * @returns {boolean}
 */
function hasUnquotedColon(raw) {
	const trimmed = raw.trim();
	if (trimmed.startsWith('"') || trimmed.startsWith("'")) { return false; }
	return trimmed.includes(": ");
}

/** @param {string} value @returns {boolean} */
function isRecordId(value) {
	return /^d\d+$/.test(value);
}

/**
 * A bare `dNNN` handle or lowercase kebab-case. Letter-suffixed record handles
 * are refused on purpose (the standard's "Colliding numbers"): `d090b` invents
 * a namespace nobody designed.
 * @param {string} id @returns {boolean}
 */
function isWellFormedId(id) {
	// A `d`-prefixed id commits to the record namespace, where the handle is
	// exactly three digits: `d090b` passes the kebab-case test and still invents
	// the second namespace the standard forbids, so the prefix decides first.
	if (/^d[0-9]/.test(id)) { return /^d[0-9]{3}$/.test(id); }
	return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id);
}

/** @param {string} path @returns {boolean} */
function isUnderDocs(path) {
	return path.startsWith("docs/");
}

/** @param {string} path @returns {string} */
function folderOf(path) {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? "" : path.slice(0, cut);
}

/** @param {string} path @returns {number} */
function depthOf(path) {
	return path.split("/").length;
}

/**
 * Collects the repo's Markdown, skipping tool-owned trees. Sorted so findings
 * are stable across runs — a gate whose output shuffles is a gate nobody reads
 * twice.
 * @param {string} root absolute path
 * @returns {string[]} repo-relative paths with forward slashes
 */
export function walkMarkdown(root) {
	/** @type {string[]} */
	const found = [];
	/**
	 * @param {string} dir absolute
	 * @returns {void}
	 */
	const walk = (dir) => {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
			left.name < right.name ? -1 : 1,
		);
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (SKIP_DIRS.includes(entry.name)) { continue; }
				walk(join(dir, entry.name));
				continue;
			}
			if (!entry.name.endsWith(".md")) { continue; }
			found.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
		}
	};
	walk(root);
	return found;
}

/**
 * The whole contract, decided from the documents alone — no filesystem, so a
 * test can hand it a two-file tree and a fixture cannot leak into the real one.
 * @param {Doc[]} docs
 * @returns {Finding[]}
 */
export function checkGraph(docs) {
	/** @type {Finding[]} */
	const findings = [];
	/** @type {{ path: string, edge: string, target: string }[]} */
	const unresolvedEdges = [];
	/** @type {SpecNode[]} */
	const nodes = [];
	/** @type {Map<string, SpecNode>} */
	const byId = new Map();

	/**
	 * @param {string} path @param {string} code @param {string} message
	 * @returns {void}
	 */
	const report = (path, code, message) => {
		findings.push({ path, code, message });
	};

	for (const doc of docs) {
		const { fields, lists, unterminated } = parseFrontmatter(doc.source);
		if (unterminated) {
			report(doc.path, "frontmatter-unterminated", "opening '---' with no closing '---'");
			continue;
		}
		for (const [key, raw] of Object.entries(fields)) {
			if (hasUnquotedColon(raw)) {
				report(
					doc.path,
					"value-unquoted",
					`${key}: the value contains ": " and is unquoted — every YAML reader truncates it there`,
				);
			}
		}
		const id = fields.id === undefined ? undefined : unquote(fields.id);
		const type = fields.type === undefined ? undefined : unquote(fields.type);
		if (id === undefined && type === undefined) { continue; }
		if (id === undefined || type === undefined) {
			report(
				doc.path,
				"half-node",
				id === undefined
					? "carries 'type' but no 'id' — invisible to the graph while still claiming a shape"
					: "carries 'id' but no 'type' — invisible to the graph while still claiming an identity",
			);
			continue;
		}
		/** @type {SpecNode} */
		const node = {
			path: doc.path,
			folder: doc.folder,
			id,
			type,
			...optional("status", fields.status === undefined ? undefined : unquote(fields.status)),
			...optional("title", fields.title === undefined ? undefined : unquote(fields.title)),
			...optional("parent", fields.parent === undefined ? undefined : unquote(fields.parent)),
		};
		nodes.push(node);
		const first = byId.get(id);
		if (first !== undefined) {
			report(doc.path, "id-duplicate", `id '${id}' is also claimed by ${first.path}`);
			continue;
		}
		byId.set(id, node);
		if (!isWellFormedId(id)) {
			report(doc.path, "id-spelling", `id '${id}' is neither a bare dNNN handle nor lowercase kebab-case`);
		}
		if (!TYPES.includes(type)) {
			report(doc.path, "type-unknown", `type '${type}' is not one of the five types`);
		}
		if (node.status === undefined) {
			report(doc.path, "status-missing", "no 'status' — the lifecycle is part of the contract");
		} else if (!STATUSES.includes(node.status)) {
			report(doc.path, "status-unknown", `status '${node.status}' is not one of the five statuses`);
		}
		if (node.title === undefined || node.title.trim() === "") {
			report(doc.path, "title-missing", "no 'title' — every node carries a human sentence");
		}
		for (const edge of EDGE_FIELDS) {
			for (const target of lists[edge] ?? []) {
				unresolvedEdges.push({ path: doc.path, edge, target });
			}
		}
	}

	// Edge targets resolve after the whole tree is read: a doc may legitimately
	// point forward at a node that sorts later.
	for (const { path, edge, target } of unresolvedEdges) {
		if (!byId.has(target)) {
			report(path, "edge-unresolved", `${edge}: '${target}' resolves to no node`);
		}
	}

	const moduleIds = nodes.filter((node) => isModuleNode(node)).map((node) => node.id);
	const submoduleIds = nodes.filter((node) => node.type === "submodule-design").map((node) => node.id);
	for (const node of nodes) {
		checkNesting({ node, byId, moduleIds, submoduleIds, report });
	}
	for (const node of nodes) {
		checkCycle({ node, byId, report });
	}

	return findings.sort((left, right) =>
		left.path === right.path
			? left.code < right.code
				? -1
				: 1
			: left.path < right.path
				? -1
				: 1,
	);
}

/**
 * A module node is a folder's front door: module-design, parented to
 * architecture, id = folder name, file at the folder's root. Which file carries
 * it (README.md here, DESIGN.md there) is each unit's choice — the standard
 * spells that out because "which of the two is the node" was ambiguous.
 * @param {SpecNode} node @returns {boolean}
 */
export function isModuleNode(node) {
	// A module node sits at a UNIT folder's root — never in docs/, which is the
	// file layout a record's `parent` edge points across (d117's "the edge wins").
	return (
		node.type === "module-design" &&
		node.parent === "architecture" &&
		node.folder !== "" &&
		node.folder !== "docs" &&
		!node.folder.includes("/") &&
		depthOf(node.path) === 2
	);
}

/**
 * The nesting rules: a parent is a code unit, and the parent's level matches
 * the child's type (the standard's "Nesting: the expected shape"), plus d117's
 * parent-edge/filesystem agreement.
 * @param {object} args
 * @param {SpecNode} args.node
 * @param {Map<string, SpecNode>} args.byId
 * @param {string[]} args.moduleIds
 * @param {string[]} args.submoduleIds
 * @param {(path: string, code: string, message: string) => void} args.report
 * @returns {void}
 */
function checkNesting({ node, byId, moduleIds, submoduleIds, report }) {
	if (isModuleNode(node)) {
		if (node.id !== node.folder) {
			report(node.path, "module-node", `module node id '${node.id}' must equal its folder '${node.folder}'`);
		}
		return;
	}
	if (isRecordId(node.id) && !isUnderDocs(node.path)) {
		report(node.path, "placement", "a decision record lives under docs/");
	}
	if (node.type === "goal-and-requirements") {
		if (node.parent !== undefined) {
			report(node.path, "parent-level", "the graph root takes no parent");
		}
		return;
	}
	if (node.parent === undefined) {
		// Two exemptions, both spelled out in the standard: the graph root has no
		// parent, and the one VENDORED node does not either (its package nodes
		// ship with the workflow package, so an edge here would dangle — d111).
		if (node.id !== "goal" && !node.path.startsWith(".agents/")) {
			report(node.path, "parent-missing", "no 'parent' — every node but the root hangs off a code unit");
		}
		return;
	}

	const parentNode = byId.get(node.parent);
	if (parentNode === undefined) {
		report(node.path, "parent-unresolved", `parent '${node.parent}' resolves to no node`);
		return;
	}
	const isUnit =
		node.parent === "goal" ||
		node.parent === "architecture" ||
		moduleIds.includes(node.parent) ||
		submoduleIds.includes(node.parent);
	if (!isUnit) {
		report(
			node.path,
			"parent-not-a-unit",
			`parent '${node.parent}' is not a code unit (goal, architecture, a module node or a submodule node)`,
		);
		return;
	}
	if (node.type === "architecture-design" && node.parent !== "architecture" && node.parent !== "goal") {
		report(node.path, "parent-level", `architecture-design hangs off '${node.parent}', not architecture`);
	}
	if (
		node.type === "module-design" &&
		!moduleIds.includes(node.parent) &&
		!submoduleIds.includes(node.parent)
	) {
		// Archived investigations have no module left to hang from (the standard
		// says to read that list rather than sweep it) — and only those.
		const archivedParking =
			node.parent === "architecture" &&
			node.path.startsWith("docs/archive/") &&
			node.status !== undefined &&
			ARCHIVED_STATUSES.includes(node.status);
		if (!archivedParking) {
			report(
				node.path,
				"parent-level",
				`module-design hangs off '${node.parent}' — a module or submodule node, not the system level`,
			);
		}
	}
	if (node.type === "submodule-design" && !moduleIds.includes(node.parent)) {
		report(node.path, "parent-level", `submodule-design hangs off '${node.parent}', not a module node`);
	}

	// d117's parent-edge rule: the file sits beside the node its parent names.
	// Records are the documented exception — the d0XX log lives in docs/ and its
	// edges, not its paths, carry the scope.
	if (isRecordId(node.id)) { return; }
	const parentFolder = parentNode.folder;
	if (parentFolder !== "" && !node.path.startsWith(`${parentFolder}/`)) {
		report(
			node.path,
			"placement",
			`sits outside '${parentFolder}/', the folder of the '${node.parent}' it belongs to`,
		);
	}
}

/**
 * A parent cycle makes the whole graph unreadable. The ThinkRail validator
 * reports it, but a checkout without the tooling must find it too.
 * @param {object} args
 * @param {SpecNode} args.node
 * @param {Map<string, SpecNode>} args.byId
 * @param {(path: string, code: string, message: string) => void} args.report
 * @returns {void}
 */
function checkCycle({ node, byId, report }) {
	/** @type {Set<string>} */
	const seen = new Set([node.id]);
	let cursor = node.parent === undefined ? undefined : byId.get(node.parent);
	while (cursor !== undefined) {
		if (seen.has(cursor.id)) {
			report(node.path, "parent-cycle", `parent chain returns to '${cursor.id}'`);
			return;
		}
		seen.add(cursor.id);
		cursor = cursor.parent === undefined ? undefined : byId.get(cursor.parent);
	}
}

/**
 * Reads the tree and runs the checks.
 * @param {string} root absolute path
 * @returns {Finding[]}
 */
export function checkTree(root) {
	const docs = walkMarkdown(root).map((path) => ({
		path,
		folder: folderOf(path),
		source: readFileSync(join(root, path), "utf8"),
	}));
	return checkGraph(docs);
}

/**
 * @param {string} root
 * @param {Finding[]} findings
 * @returns {number} exit status
 */
function reportFindings(root, findings) {
	if (findings.length === 0) {
		console.log(`spec graph: ${root} — clean`);
		return 0;
	}
	for (const finding of findings) {
		console.log(`${finding.path}: [${finding.code}] ${finding.message}`);
	}
	console.log(`spec graph: ${findings.length} finding(s) — docs/spec-graph-standard.md owns the rules`);
	return 1;
}

/**
 * @param {string[]} argv
 * @returns {void}
 */
function main(argv) {
	const root = argv[0] ?? process.cwd();
	try {
		process.exitCode = reportFindings(root, checkTree(root));
	} catch (error) {
		console.error(`spec-check: cannot read ${root}: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	}
}

// `import.meta.main`, not an `import.meta.url === pathToFileURL(argv[1])`
// comparison: node realpaths the module URL but keeps argv[1]'s spelling, so a
// gate invoked by an absolute path through a symlink skipped main() and exited
// 0 as if the tree were clean.
if (import.meta.main) {
	main(process.argv.slice(2));
}
