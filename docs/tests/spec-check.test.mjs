/**
 * @fileoverview Pins the spec-graph gate's behaviour (docs/d140): every check
 * that docs/spec-graph-standard.md states, one fixture per finding code, plus
 * the two facts a reader of the gate relies on — the COMMITTED tree is clean,
 * and the CLI's exit status is 0/1.
 *
 * WHY fixtures build strings instead of files: a check that reads the real tree
 * cannot be pointed at a broken one, and a temp tree per case would make this
 * suite the slowest thing in the sweep for no extra coverage. The one exception
 * is the CLI test, which exists because the exit status IS the gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkGraph, checkTree, isModuleNode, parseFrontmatter } from "../spec-check.mjs";

/**
 * @param {string} path
 * @param {string[]} frontmatterLines
 * @returns {{ path: string, folder: string, source: string }}
 */
function doc(path, frontmatterLines) {
	const cut = path.lastIndexOf("/");
	return {
		path,
		folder: cut === -1 ? "" : path.slice(0, cut),
		source: `---\n${frontmatterLines.join("\n")}\n---\n\nbody\n`,
	};
}

/** @param {{ path: string, folder: string, source: string }[]} docs @returns {string[]} */
function codes(docs) {
	return checkGraph(docs).map((finding) => finding.code);
}

/**
 * The smallest graph the contract accepts: a root, the system map, one module
 * node and one doc hanging off it.
 * @returns {{ path: string, folder: string, source: string }[]}
 */
function cleanTree() {
	return [
		doc("docs/requirements.md", [
			"id: goal",
			"type: goal-and-requirements",
			"status: active",
			'title: "the goal"',
		]),
		doc("docs/architecture.md", [
			"id: architecture",
			"type: architecture-design",
			"status: active",
			'title: "the map"',
			"parent: goal",
		]),
		doc("unit/DESIGN.md", [
			"id: unit",
			"type: module-design",
			"status: active",
			'title: "the unit"',
			"parent: architecture",
		]),
		doc("unit/topic.md", [
			"id: unit-topic",
			"type: module-design",
			"status: active",
			'title: "a topic"',
			"parent: unit",
			"references: [architecture]",
		]),
	];
}

test("the minimal well-formed graph is clean", () => {
	assert.deepEqual(codes(cleanTree()), []);
});

test("a note without frontmatter is not a node", () => {
	const docs = [...cleanTree(), { path: "unit/NOTES.md", folder: "unit", source: "# notes\n" }];
	assert.deepEqual(codes(docs), []);
});

test("the vocabulary is closed: type and status", () => {
	const docs = cleanTree();
	const topic = docs[3];
	assert.ok(topic);
	topic.source = topic.source
		.replace("type: module-design", "type: decision")
		.replace("status: active", "status: implemented");
	assert.deepEqual(codes(docs).sort(), ["status-unknown", "type-unknown"]);
});

test("status is required and title is required", () => {
	const docs = cleanTree();
	const topic = docs[3];
	assert.ok(topic);
	topic.source = "---\nid: unit-topic\ntype: module-design\nparent: unit\n---\n\nbody\n";
	assert.deepEqual(codes(docs).sort(), ["status-missing", "title-missing"]);
});

test("an id is unique, well-spelled, and never a suffixed record handle", () => {
	const dup = [...cleanTree(), doc("unit/again.md", ["id: unit-topic", "type: module-design", "status: active", "title: x", "parent: unit"])];
	assert.deepEqual(codes(dup), ["id-duplicate"]);

	const bad = [
		...cleanTree(),
		doc("unit/bad.md", ["id: d090b", "type: module-design", "status: active", "title: x", "parent: unit"]),
		doc("unit/worse.md", ["id: Two_Words", "type: module-design", "status: active", "title: x", "parent: unit"]),
	];
	assert.deepEqual(codes(bad), ["id-spelling", "id-spelling"]);
});

test("id without type (or type without id) is a half node", () => {
	const docs = [
		...cleanTree(),
		doc("unit/half.md", ["id: half", "status: active", "title: x"]),
		doc("unit/half2.md", ["type: module-design", "status: active", "title: x"]),
	];
	assert.deepEqual(codes(docs), ["half-node", "half-node"]);
});

test("an unquoted value containing ': ' truncates in YAML and is refused", () => {
	const docs = [
		...cleanTree(),
		doc("unit/colon.md", [
			"id: unit-colon",
			"type: module-design",
			"status: active",
			"title: the gate: it truncates",
			"parent: unit",
		]),
	];
	assert.deepEqual(codes(docs), ["value-unquoted"]);
});

test("every edge field resolves to an id", () => {
	const docs = cleanTree();
	const topic = docs[3];
	assert.ok(topic);
	topic.source = topic.source.replace("references: [architecture]", "references: [architecture, nowhere]");
	assert.deepEqual(codes(docs), ["edge-unresolved"]);
});

test("a parent is a code unit — never a record, never a plain doc", () => {
	const docs = [
		...cleanTree(),
		doc("docs/d001-something.md", ["id: d001", "type: architecture-design", "status: active", "title: r", "parent: architecture"]),
		doc("unit/onto-record.md", ["id: unit-record", "type: module-design", "status: active", "title: x", "parent: d001"]),
		doc("unit/dangling.md", ["id: unit-dangling", "type: module-design", "status: active", "title: x", "parent: nothing"]),
	];
	assert.deepEqual(codes(docs).sort(), ["parent-not-a-unit", "parent-unresolved"]);
});

test("a module-design doc belongs to a module, or to the archive if it is finished", () => {
	const parked = [
		...cleanTree(),
		doc("docs/d002-parked.md", ["id: d002", "type: module-design", "status: active", "title: r", "parent: architecture"]),
	];
	assert.deepEqual(codes(parked), ["parent-level"]);

	const archived = [
		...cleanTree(),
		doc("docs/archive/old-study.md", ["id: old-study", "type: module-design", "status: done", "title: r", "parent: architecture"]),
	];
	assert.deepEqual(codes(archived), []);
});

test("a submodule hangs off its module, and a submodule's docs hang off the submodule", () => {
	const docs = [
		...cleanTree(),
		doc("unit/SUB.md", ["id: unit-sub", "type: submodule-design", "status: active", "title: s", "parent: unit"]),
		doc("unit/sub-topic.md", ["id: unit-sub-topic", "type: module-design", "status: active", "title: t", "parent: unit-sub"]),
	];
	assert.deepEqual(codes(docs), []);
});

test("d117: a living doc sits in the folder of the node its parent names", () => {
	const docs = [
		...cleanTree(),
		doc("docs/misfiled.md", ["id: misfiled", "type: module-design", "status: active", "title: t", "parent: unit"]),
	];
	assert.deepEqual(codes(docs), ["placement"]);
});

test("a module node's id is its folder name", () => {
	const docs = cleanTree();
	const frontDoor = docs[2];
	assert.ok(frontDoor);
	frontDoor.source = frontDoor.source.replace("id: unit", "id: unit-renamed");
	// Two findings, and both are true: the front door no longer names its folder,
	// and the doc that hung off it now points at an id nothing claims.
	assert.deepEqual(codes(docs), ["module-node", "parent-unresolved"]);
});

test("a parent cycle is reported once per node in it", () => {
	const docs = [
		doc("docs/architecture.md", ["id: architecture", "type: architecture-design", "status: active", "title: m", "parent: goal"]),
		doc("docs/requirements.md", ["id: goal", "type: goal-and-requirements", "status: active", "title: g", "parent: architecture"]),
	];
	// Both members of the cycle are reported (the chain returns to the other one
	// from each side), plus the goal-must-have-no-parent rule it also violates.
	assert.deepEqual(codes(docs), ["parent-cycle", "parent-cycle", "parent-level"]);
});

test("parseFrontmatter reads flow lists, block lists and quoted scalars", () => {
	const parsed = parseFrontmatter(
		'---\nid: x\ntype: module-design\nreferences: [a, "b"]\ndepends-on:\n  - c\ntitle: "a: b"\n---\n\nbody\n',
	);
	assert.deepEqual(parsed.lists.references, ["a", "b"]);
	assert.deepEqual(parsed.lists["depends-on"], ["c"]);
	assert.equal(parsed.fields.title, '"a: b"');
	assert.equal(parsed.unterminated, false);
	assert.equal(parseFrontmatter("---\nid: x\n").unterminated, true);
});

test("isModuleNode is the front door rule, not any module-design doc", () => {
	const frontDoor = doc("unit/DESIGN.md", []);
	const parked = doc("docs/d002.md", []);
	assert.equal(
		isModuleNode({ path: frontDoor.path, folder: frontDoor.folder, id: "unit", type: "module-design", status: "active", title: "t", parent: "architecture" }),
		true,
	);
	assert.equal(
		isModuleNode({ path: parked.path, folder: parked.folder, id: "d002", type: "module-design", status: "active", title: "t", parent: "architecture" }),
		false,
	);
});

test("every node hangs off a code unit, except the root and the vendored spec", () => {
	const orphan = [
		...cleanTree(),
		doc("unit/orphan.md", ["id: unit-orphan", "type: module-design", "status: active", "title: t"]),
	];
	assert.deepEqual(codes(orphan), ["parent-missing"]);

	// The one node with no parent by design: its package nodes ship with the
	// workflow package, so an edge here would dangle (d111).
	const vendored = [
		...cleanTree(),
		doc(".agents/skills/SPEC.md", [
			"id: submodule-workflow-skills",
			"type: submodule-design",
			"status: active",
			"title: t",
		]),
	];
	assert.deepEqual(codes(vendored), []);
});

test("the whole .agents/ subtree is exempt from the parent rule, not one file", () => {
	// The exemption is the subtree, not `.agents/skills/SPEC.md`: the reason an
	// edge would dangle is that the package ships elsewhere, and a vendored
	// package may add a node of its own later.
	const docs = [
		...cleanTree(),
		doc(".agents/vendor/EXTRA.md", [
			"id: vendor-extra",
			"type: module-design",
			"status: active",
			'title: "t"',
		]),
	];
	assert.deepEqual(codes(docs), []);
});

test("the walk skips the disposable and tool-owned trees, and nothing else", () => {
	// The gate's blind spot, pinned: the ThinkRail tools index `.venv/` and
	// `.thinkrail/` (they skip only node_modules), so a spec-shaped file there is
	// a node this walk never sees. Skipping them stays right — a rebuilt venv must
	// not change the gate's verdict — but the asymmetry is deliberate, not a slip.
	const root = mkdtempSync(join(tmpdir(), "spec-check-walk-"));
	const broken = "---\nid: Two_Words\ntype: decision\n---\n";
	for (const skipped of ["node_modules", ".venv", ".thinkrail", ".git"]) {
		mkdirSync(join(root, skipped, "deep"), { recursive: true });
		writeFileSync(join(root, skipped, "deep", "BROKEN.md"), broken);
	}
	assert.deepEqual(checkTree(root), []);

	// …and a file just outside those trees is read, so the skip is a list and not
	// a broken walk.
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "BROKEN.md"), broken);
	assert.deepEqual(
		checkTree(root).map((finding) => finding.path),
		["docs/BROKEN.md", "docs/BROKEN.md", "docs/BROKEN.md", "docs/BROKEN.md", "docs/BROKEN.md"],
	);
});

test("the committed tree satisfies the contract", () => {
	const root = fileURLToPath(new URL("../../", import.meta.url));
	assert.deepEqual(checkTree(root), []);
});

test("the CLI exits 1 on findings and 0 on a clean tree", () => {
	const cli = fileURLToPath(new URL("../spec-check.mjs", import.meta.url));
	const clean = mkdtempSync(join(tmpdir(), "spec-check-clean-"));
	writeFileSync(
		join(clean, "requirements.md"),
		"---\nid: goal\ntype: goal-and-requirements\nstatus: active\ntitle: g\n---\n",
	);
	writeFileSync(
		join(clean, "architecture.md"),
		"---\nid: architecture\ntype: architecture-design\nstatus: active\ntitle: m\nparent: goal\n---\n",
	);
	const dirty = mkdtempSync(join(tmpdir(), "spec-check-dirty-"));
	mkdirSync(join(dirty, "unit"));
	writeFileSync(
		join(dirty, "unit", "DESIGN.md"),
		"---\nid: unit\ntype: decision\nstatus: implemented\ntitle: m\nparent: architecture\n---\n",
	);
	const cleanRun = spawnSync(process.execPath, [cli, clean], { encoding: "utf8" });
	assert.equal(cleanRun.status, 0, cleanRun.stdout + cleanRun.stderr);
	const dirtyRun = spawnSync(process.execPath, [cli, dirty], { encoding: "utf8" });
	assert.equal(dirtyRun.status, 1, dirtyRun.stdout + dirtyRun.stderr);
	assert.match(dirtyRun.stdout, /type-unknown/);
});
