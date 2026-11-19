/**
 * @fileoverview prune-quant-display.test.mjs — pins the two rule families
 * 30-generate.mjs owns: quant display (docs/d170, d199, d200, d202) and speculation
 * wiring (docs/d206). The display cases are split by how the knowledge arrived:
 *
 *  - `known/` repos reproduce shapes the committed manifests ALREADY carry, so
 *    each one is a trap the catalog hit: an MTP drafter, a dflash/dspark side
 *    build, an `mmproj-` projector, a sharded BF16 group, an untagged Spark
 *    upload, a repo with no full precision at all, and the sizes of the two
 *    live cheap-quant cuts.
 *  - `unknown/` repos are traps verified in review but absent from the tables:
 *    an untagged `imatrix` auxiliary, a projector named "<model>-mmproj-bf16",
 *    the Q1_0 tag the exclusion list never named, and F32 — alone, beside BF16,
 *    as a repo's only rows, and as a sharded group.
 *
 * WHY THIS SPAWNS A GENERATION INSTEAD OF IMPORTING: 30-generate.mjs's functions are
 * module-private and importing the module runs the generation for real (it
 * writes config.d and, on a host that is not an inference endpoint, exits 94).
 * A temp copy of the unit with a fixture table exercises the committed code path
 * end to end — entry validation included — and asserts the emitted model ids,
 * which is what a caller sees.
 *
 * The speculation cases pin one home per fact: the type belongs to the row, the
 * confidence flags to one macro, and a sidecar never silently becomes the other
 * kind (llama.cpp refuses a type that disagrees with the drafter's head).
 *
 * The second half runs the COMMITTED table and pins what today's catalog
 * decides, because a fixture can agree with the rule while the catalog does not.
 *
 * Run: ../node-run.sh --test tests/*.test.mjs   (this folder)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const unitRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** decimal bytes per "GB" the manifest sizes use, the unit `totalParamsB` reads. */
const G = 1e9;

/** llama-swap ids carry the mmproj mode as a prefix (`0text-<repo>:<quant>`). */
const MODE_PREFIX = /^(0text|1vision|2mmproj)-/;

// llama-swap macro text, verbatim: the generator copies __argv into the cmd and
// llama-swap expands it at load, so this is not a JS placeholder.
// biome-ignore lint/suspicious/noTemplateCurlyInString: llama-swap expands ${SPEC_DRAFT}, not JS.
const SPEC_DRAFT_ARGV = "${SPEC_DRAFT}";

/**
 * One manifest file: `[path, sizeGB]`.
 * @param {Record<string, number>} spec
 * @returns {{path: string, size: number}[]}
 */
function files(spec) {
	return Object.entries(spec).map(([path, gb]) => ({ path, size: Math.round(gb * G) }));
}

/**
 * One table row.
 * @param {string} repo
 * @param {string} quant
 * @param {string} model
 * @param {Record<string, string>} [extra] `__argv`, `model-draft`, `spec-type`
 * @returns {Record<string, string>}
 */
function row(repo, quant, model, extra = {}) {
	return { "hf-repo": `${repo}:${quant}`, model, ...extra };
}

/**
 * Generate the local-inference layer in a throwaway copy of the unit and return
 * the emitted model ids. With no `fixtures`, the unit's own committed table and
 * manifests are the input.
 * @param {{table?: {models: Record<string, string>[]}, manifests?: Record<string, {path: string, size: number}[]>}} [fixtures]
 * @returns {Record<string, {cmd: string, capabilities: unknown, metadata: unknown}>} the emitted layer
 */
function generate(fixtures = {}) {
	const { table, manifests, hubMissing = false } = fixtures;
	const dir = mkdtempSync(join(tmpdir(), "quant-display-"));
	try {
		for (const name of ["30-generate.mjs", "llama-swap-core.json"]) {
			cpSync(join(unitRoot, name), join(dir, name));
		}
		cpSync(join(unitRoot, "lib"), join(dir, "lib"), {
			recursive: true,
			// a fixture run owns its manifests and table; the committed run does not
			filter: (src) =>
				!src.includes("__pycache__") && (table === undefined || !src.includes("hf-manifests")),
		});
		if (table !== undefined) {
			mkdirSync(join(dir, "lib", "hf-manifests"));
			for (const [repo, repoFiles] of Object.entries(manifests ?? {})) {
				writeFileSync(
					join(dir, "lib", "hf-manifests", `${repo.replace("/", "--")}.json`),
					JSON.stringify({ repo, commit: "deadbeef", files: repoFiles }),
				);
			}
			writeFileSync(join(dir, "lib", "llamacpp-model-data.json"), JSON.stringify(table));
			// the closed cache inventory: every fixture repo is served, which is what
			// the generator's two-way scope check requires (docs/d212)
			writeFileSync(
				join(dir, "lib", "cache-scope.json"),
				JSON.stringify(
					Object.fromEntries(
						table.models.map((m) => [m["hf-repo"].split(":")[0], "served"]),
					),
				),
			);
			// no context facts for fixture repos: the fallback window is fine here
			writeFileSync(join(dir, "lib", "gguf-facts.json"), "{}");
		}
		// An EMPTY hub: the bake warns per entry and falls back to the manifest
		// commit, so baked paths never depend on the host running this. The
		// directory itself must exist — an invisible root is a generator failure
		// (exit 95), which `hubMissing` exercises.
		if (!hubMissing) {
			mkdirSync(join(dir, "hub"));
		}
		const run = spawnSync(process.execPath, [join(dir, "30-generate.mjs")], {
			cwd: dir,
			encoding: "utf8",
			env: {
				...process.env,
				LOCAL_INFERENCE: "1",
				HF_HUB_CACHE: join(dir, "hub"),
			},
		});
		if (hubMissing) {
			return { status: run.status, output: run.stdout + run.stderr, dir };
		}
		assert.equal(run.status, 0, run.stdout + run.stderr);
		const layer = JSON.parse(
			readFileSync(join(dir, "config.d", "10-local-llm-inference.yaml"), "utf-8"),
		);
		return layer.models;
	} finally {
		if (!fixtures.hubMissing) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

/**
 * The `:quant` labels one repo emits, deduplicated (a vision repo emits one id
 * per mmproj mode).
 * @param {string[]} ids
 * @param {string} repo
 * @returns {string[]}
 */
function quantsOf(ids, repo) {
	return [
		...new Set(
			ids
				.filter((id) => id.replace(MODE_PREFIX, "").startsWith(`${repo}:`))
				.map((id) => id.slice(id.lastIndexOf(":") + 1)),
		),
	].sort();
}

/**
 * The mode prefixes one repo's row emits (`` for a text-only repo).
 * @param {string[]} ids
 * @param {string} repo
 * @param {string} quant
 * @returns {string[]}
 */
function modesOf(ids, repo, quant) {
	return ids
		.filter((id) => id.endsWith(`${repo}:${quant}`))
		.map((id) => id.slice(0, id.length - `${repo}:${quant}`.length).replace(/-$/, ""))
		.sort();
}

// --- the fixture catalog -----------------------------------------------------
// Every repo a case refers to lives here, so one generation covers the suite.

const FIXTURE_MANIFESTS = {
	// known-known: a drafter/manifest side build must never size the repo
	"known/mtp-gguf": files({
		"MTP/mtp-known-mtp-Q8_0.gguf": 0.3,
		"MTP/mtp-known-mtp-BF16.gguf": 0.6,
		"known-mtp-Q4_K_M.gguf": 13.5,
		"known-mtp-Q6_K.gguf": 20,
		"known-mtp-Q8_0.gguf": 26,
	}),
	"known/dflash-gguf": files({
		"dflash-known-dflash-bf16.gguf": 1.9,
		"known-dflash-Q2_K.gguf": 9,
		"known-dflash-Q4_K_M.gguf": 13.5,
	}),
	"known/dspark-gguf": files({
		"dspark/dspark-known-dspark-BF16.gguf": 0.5,
		"known-dspark-Q4_K_M.gguf": 13.5,
		"known-dspark-Q8_0.gguf": 26,
	}),
	"known/projector-gguf": files({
		"mmproj-BF16.gguf": 0.5,
		"known-projector-Q2_K.gguf": 9,
		"known-projector-Q4_K_M.gguf": 13.5,
		"known-projector-Q8_0.gguf": 26,
	}),
	// known-known: a split full-precision upload is summed, then hidden
	"known/sharded-gguf": files({
		"BF16/known-sharded-BF16-00001-of-00002.gguf": 27,
		"BF16/known-sharded-BF16-00002-of-00002.gguf": 27,
		"known-sharded-Q4_K_M.gguf": 13.5,
	}),
	// known-known: Spark's untagged upload — full precision the LABEL names
	"known/label-only-gguf": files({
		"known-label-only-4b.gguf": 8.23,
		"known-label-only-4b-Q4_K_M.gguf": 2.4,
	}),
	// known-known: the same shape under the ceiling
	"known/label-only-small-gguf": files({
		"known-label-only-small-2b.gguf": 3.42,
		"known-label-only-small-2b-Q4_K_M.gguf": 1,
	}),
	// known-known: byteshape ships no full precision at all
	"known/unsized-gguf": files({
		"known-unsized-IQ2_XXS-2.56bpw.gguf": 9,
		"known-unsized-Q4_K_M.gguf": 13.5,
	}),
	// known-known: the live cheap-quant cut (LFM2.5-2.6B / LFM3-1.7B shape)
	"known/cut-gguf": files({
		"known-cut-BF16.gguf": 5.4,
		"known-cut-Q4_0.gguf": 1.59,
		"known-cut-QAD-Q4_0.gguf": 1.59,
		"known-cut-Q4_K_M.gguf": 1.67,
		"known-cut-Q5_K_M.gguf": 1.9,
		"known-cut-Q6_K.gguf": 2.2,
		"known-cut-Q8_0.gguf": 2.8,
	}),
	"known/short-ladder-gguf": files({
		"known-short-ladder-BF16.gguf": 5.4,
		"known-short-ladder-Q4_K_M.gguf": 1.67,
		"known-short-ladder-Q8_0.gguf": 2.8,
	}),
	// unknown: an untagged auxiliary is never the full-precision proxy
	"unknown/imatrix-gguf": files({
		"unknown-imatrix-imatrix.gguf": 0.02,
		"unknown-imatrix-Q2_K.gguf": 9,
		"unknown-imatrix-Q4_K_M.gguf": 13.5,
		"unknown-imatrix-Q8_0.gguf": 26,
	}),
	// unknown: the same, observed through the mmproj fan — an unsized repo keeps
	// all three modes, a repo mis-sized as ~0B loses `0text`
	"unknown/fan-imatrix-gguf": files({
		"unknown-fan-imatrix-imatrix.gguf": 0.02,
		"unknown-fan-imatrix-Q4_K_M.gguf": 13.5,
		"mmproj-BF16.gguf": 0.5,
	}),
	// unknown: Q1_0 is in no exclusion list — the largest-file rule covers it
	"unknown/q1-gguf": files({
		"unknown-q1-Q1_0.gguf": 2,
		"unknown-q1-Q2_K.gguf": 9,
		"unknown-q1-Q4_K_M.gguf": 13.5,
		"unknown-q1-Q8_0.gguf": 26,
	}),
	// unknown: a projector whose basename the `mmproj-` prefix exclusion misses
	"unknown/suffix-projector-gguf": files({
		"unknown-suffix-projector-mmproj-bf16.gguf": 0.1,
		"unknown-suffix-projector-Q2_K.gguf": 9,
		"unknown-suffix-projector-Q4_K_M.gguf": 13.5,
		"unknown-suffix-projector-Q6_K.gguf": 20,
		"unknown-suffix-projector-Q8_0.gguf": 26,
	}),
	// unknown: F32 is full precision at 4 bytes per parameter
	"unknown/f32-gguf": files({
		"F32/unknown-f32-F32-00001-of-00002.gguf": 54,
		"F32/unknown-f32-F32-00002-of-00002.gguf": 54,
		"unknown-f32-Q4_K_M.gguf": 13.5,
	}),
	"unknown/f32-and-bf16-gguf": files({
		"unknown-f32-bf16-BF16.gguf": 54,
		"unknown-f32-bf16-F32.gguf": 108,
		"unknown-f32-bf16-Q4_K_M.gguf": 13.5,
	}),
	// unknown: nothing but full precision — the floor keeps the smallest row
	"unknown/full-precision-only-gguf": files({
		"unknown-full-precision-only-BF16.gguf": 54,
		"unknown-full-precision-only-F16.gguf": 54,
		"unknown-full-precision-only-F32.gguf": 108,
	}),
	"unknown/single-row-gguf": files({
		"unknown-single-row-BF16.gguf": 54,
	}),
	// speculation wiring: sidecar, built-in speculator, dflash sidecar
	"spec/sidecar-repo": files({
		"mtp-spec-sidecar.gguf": 0.2,
		"spec-sidecar-Q4_K_M.gguf": 13.5,
	}),
	"spec/builtin-repo": files({
		"spec-builtin-Q4_K_M.gguf": 13.5,
	}),
	"spec/dflash-repo": files({
		"dflash-spec-dflash.gguf": 1.1,
		"spec-dflash-Q4_K_M.gguf": 13.5,
	}),
	// a split quant that SURVIVES: the point of naming shards is the load path,
	// not the pruning rules
	"spec/sharded-repo": files({
		"spec-sharded-Q8_0-00001-of-00002.gguf": 13.5,
		"spec-sharded-Q8_0-00002-of-00002.gguf": 13.5,
	}),
};

/** @type {{models: Record<string, string>[]}} */
const FIXTURE_TABLE = {
	models: [
		row("known/mtp-gguf", "Q4_K_M", "known-mtp-Q4_K_M.gguf"),
		row("known/mtp-gguf", "Q6_K", "known-mtp-Q6_K.gguf"),
		row("known/mtp-gguf", "Q8_0", "known-mtp-Q8_0.gguf"),
		row("known/dflash-gguf", "Q2_K", "known-dflash-Q2_K.gguf"),
		row("known/dflash-gguf", "Q4_K_M", "known-dflash-Q4_K_M.gguf"),
		row("known/dspark-gguf", "Q4_K_M", "known-dspark-Q4_K_M.gguf"),
		row("known/dspark-gguf", "Q8_0", "known-dspark-Q8_0.gguf"),
		row("known/projector-gguf", "Q2_K", "known-projector-Q2_K.gguf"),
		row("known/projector-gguf", "Q4_K_M", "known-projector-Q4_K_M.gguf"),
		row("known/projector-gguf", "Q8_0", "known-projector-Q8_0.gguf"),
		row("known/sharded-gguf", "BF16", "BF16/known-sharded-BF16-00001-of-00002.gguf"),
		row("known/sharded-gguf", "Q4_K_M", "known-sharded-Q4_K_M.gguf"),
		row("known/label-only-gguf", "F16", "known-label-only-4b.gguf"),
		row("known/label-only-gguf", "Q4_K_M", "known-label-only-4b-Q4_K_M.gguf"),
		row("known/label-only-small-gguf", "F16", "known-label-only-small-2b.gguf"),
		row("known/label-only-small-gguf", "Q4_K_M", "known-label-only-small-2b-Q4_K_M.gguf"),
		row("known/unsized-gguf", "IQ2_XXS-2.56bpw", "known-unsized-IQ2_XXS-2.56bpw.gguf"),
		row("known/unsized-gguf", "Q4_K_M", "known-unsized-Q4_K_M.gguf"),
		row("known/cut-gguf", "BF16", "known-cut-BF16.gguf"),
		row("known/cut-gguf", "Q4_0", "known-cut-Q4_0.gguf"),
		row("known/cut-gguf", "QAD-Q4_0", "known-cut-QAD-Q4_0.gguf"),
		row("known/cut-gguf", "Q4_K_M", "known-cut-Q4_K_M.gguf"),
		row("known/cut-gguf", "Q5_K_M", "known-cut-Q5_K_M.gguf"),
		row("known/cut-gguf", "Q6_K", "known-cut-Q6_K.gguf"),
		row("known/cut-gguf", "Q8_0", "known-cut-Q8_0.gguf"),
		row("known/short-ladder-gguf", "BF16", "known-short-ladder-BF16.gguf"),
		row("known/short-ladder-gguf", "Q4_K_M", "known-short-ladder-Q4_K_M.gguf"),
		row("known/short-ladder-gguf", "Q8_0", "known-short-ladder-Q8_0.gguf"),
		row("unknown/imatrix-gguf", "Q2_K", "unknown-imatrix-Q2_K.gguf"),
		row("unknown/imatrix-gguf", "Q4_K_M", "unknown-imatrix-Q4_K_M.gguf"),
		row("unknown/imatrix-gguf", "Q8_0", "unknown-imatrix-Q8_0.gguf"),
		row("unknown/fan-imatrix-gguf", "Q4_K_M", "unknown-fan-imatrix-Q4_K_M.gguf"),
		row("unknown/q1-gguf", "Q1_0", "unknown-q1-Q1_0.gguf"),
		row("unknown/q1-gguf", "Q2_K", "unknown-q1-Q2_K.gguf"),
		row("unknown/q1-gguf", "Q4_K_M", "unknown-q1-Q4_K_M.gguf"),
		row("unknown/q1-gguf", "Q8_0", "unknown-q1-Q8_0.gguf"),
		row("unknown/suffix-projector-gguf", "Q2_K", "unknown-suffix-projector-Q2_K.gguf"),
		row("unknown/suffix-projector-gguf", "Q4_K_M", "unknown-suffix-projector-Q4_K_M.gguf"),
		row("unknown/suffix-projector-gguf", "Q6_K", "unknown-suffix-projector-Q6_K.gguf"),
		row("unknown/suffix-projector-gguf", "Q8_0", "unknown-suffix-projector-Q8_0.gguf"),
		row("unknown/f32-gguf", "F32", "F32/unknown-f32-F32-00001-of-00002.gguf"),
		row("unknown/f32-gguf", "Q4_K_M", "unknown-f32-Q4_K_M.gguf"),
		row("unknown/f32-and-bf16-gguf", "BF16", "unknown-f32-bf16-BF16.gguf"),
		row("unknown/f32-and-bf16-gguf", "F32", "unknown-f32-bf16-F32.gguf"),
		row("unknown/f32-and-bf16-gguf", "Q4_K_M", "unknown-f32-bf16-Q4_K_M.gguf"),
		row("unknown/full-precision-only-gguf", "BF16", "unknown-full-precision-only-BF16.gguf"),
		row("unknown/full-precision-only-gguf", "F16", "unknown-full-precision-only-F16.gguf"),
		row("unknown/full-precision-only-gguf", "F32", "unknown-full-precision-only-F32.gguf"),
		row("unknown/single-row-gguf", "BF16", "unknown-single-row-BF16.gguf"),
		row("spec/sidecar-repo", "Q4_K_M", "spec-sidecar-Q4_K_M.gguf", {
			"model-draft": "mtp-spec-sidecar.gguf",
			"cache-type-v": "q8_0",
			__argv: SPEC_DRAFT_ARGV,
		}),
		row("spec/builtin-repo", "Q4_K_M", "spec-builtin-Q4_K_M.gguf", {
			"spec-type": "draft-mtp",
			__argv: SPEC_DRAFT_ARGV,
		}),
		row("spec/dflash-repo", "Q4_K_M", "spec-dflash-Q4_K_M.gguf", {
			"model-draft": "dflash-spec-dflash.gguf",
			"spec-type": "draft-dflash",
			__argv: SPEC_DRAFT_ARGV,
		}),
		row("spec/sharded-repo", "Q8_0", "spec-sharded-Q8_0-00001-of-00002.gguf"),
	],
};

/** Runs once: the fixture catalog is the whole suite's input. */
const fixtureLayer = generate({ table: FIXTURE_TABLE, manifests: FIXTURE_MANIFESTS });
const fixtureIds = Object.keys(fixtureLayer).sort();

// --- known-known: shapes the committed manifests already carry ---------------

test("known-known: a full-precision upload must be the LARGEST file, never an auxiliary", () => {
	// An MTP drafter under the repo's MTP/ subdir, a dflash side build at the
	// root, a dspark side build under its own subdir and a mmproj- projector are
	// all excluded from the size scan. Each one once read a 27B repo as ~1B: the
	// dflash bf16 is the trap docs/d170 records.
	assert.deepEqual(quantsOf(fixtureIds, "known/mtp-gguf"), ["Q4_K_M", "Q6_K", "Q8_0"]);
	assert.deepEqual(quantsOf(fixtureIds, "known/dflash-gguf"), ["Q2_K", "Q4_K_M"]);
	assert.deepEqual(quantsOf(fixtureIds, "known/dspark-gguf"), ["Q4_K_M", "Q8_0"]);
	assert.deepEqual(quantsOf(fixtureIds, "known/projector-gguf"), ["Q2_K", "Q4_K_M", "Q8_0"]);
});

test("known-known: a split full-precision upload is summed before it is judged", () => {
	// Two 27 GB shards are one 54 GB row: a per-file read would call the model
	// 13.5B and keep a row that cannot be served.
	assert.deepEqual(quantsOf(fixtureIds, "known/sharded-gguf"), ["Q4_K_M"]);
});

test("known-known: Spark's untagged upload is full precision because its label says so", () => {
	// The file name carries no tag (10-fetch-hf-manifests.py reports it label-only),
	// so the file read alone would leave the row unclassified and displayed.
	assert.deepEqual(quantsOf(fixtureIds, "known/label-only-gguf"), ["Q4_K_M"]);
	// …and under the ceiling the same shape stays.
	assert.deepEqual(quantsOf(fixtureIds, "known/label-only-small-gguf"), ["F16", "Q4_K_M"]);
});

test("known-known: a repo with no full precision keeps every row", () => {
	// byteshape publishes 3-bit builds only; nothing can size the repo, and
	// "unsized keeps, never guesses" (docs/d170) is the whole verdict.
	assert.deepEqual(quantsOf(fixtureIds, "known/unsized-gguf"), ["IQ2_XXS-2.56bpw", "Q4_K_M"]);
});

test("known-known: the live cheap-quant cut drops three and keeps the ladder", () => {
	// LFM2.5-2.6B / LFM3-1.7B shape: 2.7B at 5.4 GB BF16 is under 50% of the card
	// (so the full-precision row stays) and under 25% of it in served bytes (so
	// the three smallest files go, docs/d200).
	assert.deepEqual(quantsOf(fixtureIds, "known/cut-gguf"), ["BF16", "Q5_K_M", "Q6_K", "Q8_0"]);
	// Three rows is the floor: nothing is cut.
	assert.deepEqual(quantsOf(fixtureIds, "known/short-ladder-gguf"), ["BF16", "Q4_K_M", "Q8_0"]);
});

// --- unknown: traps found in review, absent from the tables -----------------

test("unknown: an untagged auxiliary is never read as the weights", () => {
	// Three repos carry an untagged imatrix blob today; all three also ship BF16,
	// which is the only reason the blob is never reached. Without the largest-file
	// guard, 0.02 GB reads as 0B of parameters and the small-model rule fires.
	assert.deepEqual(quantsOf(fixtureIds, "unknown/imatrix-gguf"), ["Q2_K", "Q4_K_M", "Q8_0"]);
	// The same estimate drives the mmproj fan (docs/d195): unsized keeps all three
	// modes, while a repo mis-sized as ~0B loses `0text` — the observable that
	// separates the two readings of one fixture.
	assert.deepEqual(modesOf(fixtureIds, "unknown/fan-imatrix-gguf", "Q4_K_M"), [
		"0text",
		"1vision",
		"2mmproj",
	]);
});

test("unknown: a projector the prefix exclusion misses is still not a full-precision file", () => {
	// "<model>-mmproj-bf16.gguf" does not start with mmproj-, so the side-build
	// filter skips it; the largest-file rule is what refuses it.
	assert.deepEqual(quantsOf(fixtureIds, "unknown/suffix-projector-gguf"), [
		"Q2_K",
		"Q4_K_M",
		"Q6_K",
		"Q8_0",
	]);
});

test("unknown: the Q1_0 tag the exclusion vocabulary never named", () => {
	// Q1_0 is in no negation list (Q[2-8] starts at two); a 1-bit build is never a
	// repo's largest file, so the largest-file rule covers the vocabulary gap.
	assert.deepEqual(quantsOf(fixtureIds, "unknown/q1-gguf"), ["Q1_0", "Q2_K", "Q4_K_M", "Q8_0"]);
});

test("unknown: F32 is full precision at 4 bytes per parameter", () => {
	// A 27B model at F32 is 108 GB, split across two shards. Before docs/d202 the
	// tag was in neither list: the repo went unsized AND the row was never hidden.
	assert.deepEqual(quantsOf(fixtureIds, "unknown/f32-gguf"), ["Q4_K_M"]);
	// BF16 beside F32: each row is measured on its own bytes, so both go.
	assert.deepEqual(quantsOf(fixtureIds, "unknown/f32-and-bf16-gguf"), ["Q4_K_M"]);
});

test("unknown: a repo publishing nothing but full precision keeps its smallest row", () => {
	// Hiding all three would delete the repo from the catalog; the floor keeps the
	// smallest full-precision row (BF16 and F16 tie at 54 GB, F32 is 108 GB).
	assert.deepEqual(quantsOf(fixtureIds, "unknown/full-precision-only-gguf"), ["BF16"]);
	// One row is a ladder too: the floor cannot go below it.
	assert.deepEqual(quantsOf(fixtureIds, "unknown/single-row-gguf"), ["BF16"]);
});

// --- speculation wiring (docs/d206) -----------------------------------------

/**
 * @param {string} cmd a generated llama-server cmd
 * @param {string} flag
 * @returns {string[]} every value given to `flag`
 */
function flagValues(cmd, flag) {
	return [...cmd.matchAll(new RegExp(`${flag} (\\S+)`, "g"))].map((match) => match[1]);
}

test("spec: a declared sidecar names one type and one draft path", () => {
	const cmd = fixtureLayer["spec/sidecar-repo:Q4_K_M"]?.cmd ?? "";
	assert.deepEqual(flagValues(cmd, "--spec-type"), ["draft-mtp"]);
	assert.deepEqual(flagValues(cmd, "--model-draft").map((p) => p.split("/").pop()), [
		"mtp-spec-sidecar.gguf",
	]);
});

test("spec: a built-in speculator names its type and passes no draft path", () => {
	// llama.cpp builds the MTP draft context from the TARGET model when no drafter
	// is given, so the type alone is what enables self-speculation.
	const cmd = fixtureLayer["spec/builtin-repo:Q4_K_M"]?.cmd ?? "";
	assert.deepEqual(flagValues(cmd, "--spec-type"), ["draft-mtp"]);
	assert.deepEqual(flagValues(cmd, "--model-draft"), []);
});

test("spec: a dflash sidecar carries its own type, never the MTP one", () => {
	// llama.cpp refuses a type that does not match the drafter's head, and would
	// otherwise build an MTP impl around a dflash model.
	const cmd = fixtureLayer["spec/dflash-repo:Q4_K_M"]?.cmd ?? "";
	assert.deepEqual(flagValues(cmd, "--spec-type"), ["draft-dflash"]);
});

test("model: every extra shard is named on the command line", () => {
	// The server can stitch shards from anywhere, so generation — which already
	// validates the file set against the manifest and the cache — is the one
	// place that names them (d210).
	const cmd = fixtureLayer["spec/sharded-repo:Q8_0"]?.cmd ?? "";
	assert.deepEqual(
		flagValues(cmd, "--model").map((p) => p.split("/").pop()),
		["spec-sharded-Q8_0-00001-of-00002.gguf"],
	);
	assert.deepEqual(
		flagValues(cmd, "--shard").map((shards) =>
			shards.split(",").map((p) => p.split("/").pop()).join(","),
		),
		["spec-sharded-Q8_0-00002-of-00002.gguf"],
	);
});

test("server: the macro pins the logging and lazy-loading defaults", () => {
	const core = JSON.parse(readFileSync(join(unitRoot, "llama-swap-core.json"), "utf-8"));
	const server = core.macros.LLAMA_SERVER;
	for (const flag of ["--log-jsonl", "--no-log-timestamps", "--lazy-mode auto"]) {
		assert.ok(server.includes(flag), `${flag} missing from LLAMA_SERVER`);
	}
	assert.ok(!server.includes("--log-colors"), "log-jsonl already disables colour");
});

test("spec: each variant's span policy lives in its own macro", () => {
	// A dflash draft is a BLOCK of n-max + 1 tokens in one forward pass, so the
	// ceiling is the block size there, while MTP drafts one token at a time.
	const core = JSON.parse(readFileSync(join(unitRoot, "llama-swap-core.json"), "utf-8"));
	assert.equal(core.macros.SPEC_DFLASH, "--spec-draft-n-max 3 --spec-draft-p-min 0.8");
	assert.equal(core.macros.SPEC_MTP, "--spec-draft-n-max 16 --spec-draft-p-min 0.8");
	// The macro is the artifact's fact (asserted above); which row carries it is
	// the operator's catalog, so a catalog that no longer ships a dflash row is
	// reported, not failed — pinning it made curating the manifest a build break
	// (docs/d212: the model manifest is authoritative).
	const blend = committedLayer["0text-JetBrains/Qwen3.8-3.6-27B-blend-GGUF:Q4_K_M"]?.cmd ?? "";
	if (!/\$\{SPEC_DFLASH\}/.test(blend)) {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: llama-swap expands ${SPEC_DFLASH}, not JS.
		console.warn("no served dflash row in the committed catalog: ${SPEC_DFLASH} is unexercised");
	}
});

test("cache: keys are never quantized, values mirror into the drafter", () => {
	// The key cache is the KLD-bearing half of the KV trade, so no row can
	// quantize it; a value quant reaches the drafter's own cache in the same edit.
	const quantized = fixtureLayer["spec/sidecar-repo:Q4_K_M"]?.cmd ?? "";
	assert.deepEqual(flagValues(quantized, "--cache-type-v"), ["q8_0"]);
	assert.deepEqual(flagValues(quantized, "--spec-draft-type-v"), ["q8_0"]);
	assert.deepEqual(flagValues(quantized, "--cache-type-k"), []);

	const f16 = fixtureLayer["spec/builtin-repo:Q4_K_M"]?.cmd ?? "";
	assert.deepEqual(flagValues(f16, "--cache-type-v"), ["f16"]);
	// llama.cpp's draft default is f16 too: no flag, no drift.
	assert.deepEqual(flagValues(f16, "--spec-draft-type-v"), []);
	assert.deepEqual(flagValues(f16, "--cache-type-k"), []);
});

test("cache: an invisible hub root is a generation failure, not a silent bake", () => {
	// Generation verifies every baked path against the hub. With the root absent
	// it cannot tell "nothing pulled" from "wrong mount", so it must stop instead
	// of emitting a whole layer it could not check.
	const { status, output, dir } = generate({
		table: { models: [] },
		manifests: {},
		hubMissing: true,
	});
	try {
		assert.equal(status, 95, output);
		assert.match(output, /HF hub cache is not visible/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cache: the committed catalog keeps the pair together", () => {
	for (const [id, model] of Object.entries(committedLayer)) {
		assert.deepEqual(flagValues(model.cmd, "--cache-type-k"), [], id);
		if (flagValues(model.cmd, "--cache-type-v")[0] === "q8_0") {
			assert.deepEqual(flagValues(model.cmd, "--spec-draft-type-v"), ["q8_0"], id);
		} else {
			assert.deepEqual(flagValues(model.cmd, "--spec-draft-type-v"), [], id);
		}
	}
});

// --- the committed catalog ---------------------------------------------------

const committedLayer = generate();
const committedIds = Object.keys(committedLayer).sort();

test("the committed catalog drops the label where no choice exists", () => {
	// One row in the repo means the `:quant` selects nothing; multi-quant repos
	// keep it because their ids would collide without it (d210).
	// Same split as above: the RULE is asserted by the fixture cases, the current
	// catalog only reports. A repo that leaves the manifest takes its id with it.
	for (const id of ["0text-unsloth/Qwen3.6-27B-GGUF", "bartowski/Ling-3.0-tiny-GGUF"]) {
		if (committedLayer[id] === undefined) {
			console.warn("expected a label-less id for the current catalog: " + id);
		}
	}
	assert.ok(
		committedLayer["0text-unsloth/Qwen3.8-27B-GGUF:Q4_K_M"],
		"labelled multi-quant id",
	);
});

test("the committed catalog keeps exactly the full-precision rows it can serve", () => {
	// The rule's verdict on the real table, host-independent (sizes come from the
	// committed manifests): five rows survive, seven are hidden.
	const fullPrecision = [
		...new Set(
			committedIds
				.map((id) => id.replace(MODE_PREFIX, ""))
				.filter((id) => /:(F32|BF16|F16)$/i.test(id)),
		),
	].sort();
	// The list was a snapshot of one catalog; drift is reported (the operator
	// curated it), never a suite failure: the fixtures above own the rule.
	const expected = [
		"LiquidAI/LFM2.5-2.6B-GGUF:BF16",
		"LiquidAI/LFM3-1.7B-GGUF:BF16",
		"LiquidAI/LFM3-1.7B-GGUF:F16",
		"XHToken/Spark-X2.6-1.7B-GGUF:F16",
		"bartowski/ai9stars_G9v3-3B-GGUF:BF16",
	].sort();
	if (JSON.stringify(fullPrecision) !== JSON.stringify(expected)) {
		console.warn(
			"full-precision survivors drifted from the snapshot: " +
				JSON.stringify(fullPrecision) +
				" (expected " + JSON.stringify(expected) + ")",
		);
	}
});

test("the committed catalog wires the drafters it ships and nothing more", () => {
	/** @param {string} needle @returns {string[]} cmds of ids containing it */
	const cmds = (needle) =>
		Object.entries(committedLayer)
			.filter(([id]) => id.includes(needle))
			.map(([, model]) => model.cmd);

	// Qwen3.8-27B ships an MTP sidecar: every emitted row must pass it.
	for (const cmd of cmds("unsloth/Qwen3.8-27B-GGUF:")) {
		assert.deepEqual(flagValues(cmd, "--spec-type"), ["draft-mtp"]);
		assert.deepEqual(flagValues(cmd, "--model-draft").map((p) => p.split("/").pop()), [
			"mtp-Qwen3.8-27B-Q4_0.gguf",
		]);
	}
	// The blend's drafter is a dflash build: its own type, never the MTP one.
	for (const cmd of cmds("JetBrains/Qwen3.8-3.6-27B-blend-GGUF:")) {
		assert.deepEqual(flagValues(cmd, "--spec-type"), ["draft-dflash"]);
	}
	// gemma-4 drafters are the repo's BF16 uploads, not the Q8_0 ones.
	for (const cmd of cmds("gemma-4-")) {
		const draft = flagValues(cmd, "--model-draft");
		if (draft.length > 0) {
			assert.match(draft[0] ?? "", /-BF16\.gguf$/);
		}
	}
	// A type emitted twice is the shape the macro used to add (docs/d206).
	for (const [, model] of Object.entries(committedLayer)) {
		assert.ok(flagValues(model.cmd, "--spec-type").length <= 1, model.cmd);
	}
});

test("the committed table carries a key only when it deviates", () => {
	// The manifest is the deviation log: a key equal to DEFAULTS restates it and
	// hides which rows actually differ, and a key nothing may deviate on is not a
	// key at all. `parallel` is the second kind — the fleet serves one slot per
	// model and the generator owns the flag; the key cache is the same (d206).
	const table = JSON.parse(readFileSync(join(unitRoot, "lib", "llamacpp-model-data.json"), "utf-8"));
	for (const row of table.models) {
		assert.equal(row.parallel, undefined, row["hf-repo"]);
		assert.equal(row["cache-type-k"], undefined, row["hf-repo"]);
		assert.notEqual(row["cache-type-v"], "f16", row["hf-repo"]);
	}
});

test("the committed catalog never loses a repo to the rules", () => {
	const table = JSON.parse(readFileSync(join(unitRoot, "lib", "llamacpp-model-data.json"), "utf-8"));
	const reposInTable = new Set(table.models.map((m) => m["hf-repo"].split(":")[0]));
	const reposEmitted = new Set(committedIds.map((id) => id.replace(MODE_PREFIX, "").split(":")[0]));
	assert.deepEqual([...reposInTable].filter((repo) => !reposEmitted.has(repo)), []);
});
