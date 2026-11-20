/**
 * @fileoverview curation.test.mjs — pins the curated model manifests and the
 * closed cache scope: the two committed artifacts provisioning reads.
 *
 * Cases:
 *  - a pruned entry contributes no file, a projector the model manifest never
 *    names is resolved from the repo manifest and IS planned;
 *  - a sharded model is curated as every shard plus its optional split index;
 *  - an audit-only repo gets no curated file at all (it serves nothing) while
 *    the authoring aid still proposes its entries, shard 1 named;
 *  - the scope is closed and checked in BOTH directions: an entry without a
 *    line, a served line without entries, an audit-only line with entries, and
 *    an unknown mode each stop generation instead of passing silently.
 *
 * The fixture run has no hub cache on purpose: curation is a projection of
 * committed inputs, and the baked paths only warn (docs/d197).
 *
 * Run: ../node-run.sh --test tests/*.test.mjs   (this folder)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const unitRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const G = 1e9;

/** @param {Record<string, number>} spec path -> GB @returns {{path: string, size: number}[]} */
const files = (spec) =>
	Object.entries(spec).map(([path, gb]) => ({ path, size: Math.round(gb * G) }));

const servedFiles = files({
	"a-Q4_K_M.gguf": 6,
	"a-BF16.gguf": 20,
	"mmproj-BF16.gguf": 1,
});
const shardedFiles = files({
	"s-BF16-00001-of-00002.gguf": 5,
	"s-BF16-00002-of-00002.gguf": 5,
	"s-BF16-00001-of-00002.gguf.index.json": 0.001,
});

const manifests = {
	"acme/served-GGUF": servedFiles,
	"acme/sharded-GGUF": shardedFiles,
	"acme/audit-GGUF": servedFiles,
};

const modelData = {
	models: [
		{ "hf-repo": "acme/served-GGUF:Q4_K_M", model: "a-Q4_K_M.gguf" },
		{ "hf-repo": "acme/served-GGUF:BF16", model: "a-BF16.gguf" },
		{ "hf-repo": "acme/sharded-GGUF:BF16", model: "s-BF16-00001-of-00002.gguf" },
	],
};

const scope = {
	"acme/served-GGUF": "served",
	"acme/sharded-GGUF": "served",
	"acme/audit-GGUF": "audit-only",
};

/**
 * Build a throwaway copy of the unit with fixture inputs.
 * @param {{table?: unknown, scope?: Record<string, string>}} overrides
 * @returns {string} the fixture unit root
 */
function fixture(overrides = {}) {
	const dir = mkdtempSync(join(tmpdir(), "curation-"));
	for (const name of ["30-generate.mjs", "20-propose-entries.mjs", "llama-swap-core.json"]) {
		cpSync(join(unitRoot, name), join(dir, name));
	}
	cpSync(join(unitRoot, "lib"), join(dir, "lib"), {
		recursive: true,
		filter: (src) => !src.includes("__pycache__") && !src.includes("hf-manifests"),
	});
	mkdirSync(join(dir, "lib", "hf-manifests"));
	for (const [repo, repoFiles] of Object.entries(manifests)) {
		writeFileSync(
			join(dir, "lib", "hf-manifests", `${repo.replace("/", "--")}.json`),
			JSON.stringify({ repo, commit: "deadbeef", files: repoFiles }),
		);
	}
	writeFileSync(join(dir, "lib", "llamacpp-model-data.json"), JSON.stringify(overrides.table ?? modelData));
	writeFileSync(join(dir, "lib", "cache-scope.json"), JSON.stringify(overrides.scope ?? scope));
	writeFileSync(join(dir, "lib", "gguf-facts.json"), "{}");
	mkdirSync(join(dir, "hub"));
	return dir;
}

/**
 * @param {string} dir fixture root
 * @param {string} script entry filename
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function run(dir, script) {
	return spawnSync(process.execPath, [join(dir, script)], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, LOCAL_INFERENCE: "1", HF_HUB_CACHE: join(dir, "hub") },
	});
}

/**
 * @param {string} dir fixture root
 * @param {string} repo "org/repo"
 * @returns {Record<string, any>}
 */
function curated(dir, repo) {
	return JSON.parse(
		readFileSync(join(dir, "lib", "curated", `${repo.replace("/", "--")}.json`), "utf-8"),
	);
}

test("curation plans the pruned file set and the resolved projector", () => {
	const dir = fixture();
	try {
		const result = run(dir, "30-generate.mjs");
		assert.equal(result.status, 0, result.stdout + result.stderr);

		const served = curated(dir, "acme/served-GGUF");
		assert.deepEqual(served.files, ["a-Q4_K_M.gguf", "mmproj-BF16.gguf"]);
		assert.deepEqual(served.entries, ["acme/served-GGUF:Q4_K_M"]);
		assert.equal(served.bytes, 7 * G);
		assert.equal(served.manifestCommit, "deadbeef");

		const sharded = curated(dir, "acme/sharded-GGUF");
		assert.deepEqual(sharded.files, [
			"s-BF16-00001-of-00002.gguf",
			"s-BF16-00002-of-00002.gguf",
		]);
		assert.deepEqual(sharded.optional, ["s-BF16-00001-of-00002.gguf.index.json"]);

		// an audit-only repo serves nothing, so it has no curated file
		assert.equal(existsSync(join(dir, "lib", "curated", "acme--audit-GGUF.json")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config.d references only files the curated manifest declares", () => {
	// The projector is the trap this pins: it is a REPO fact (resolveEntryFiles),
	// never a model-manifest key, so a curated file derived from the row alone
	// would leave --mmproj pointing at a file 70-prune-cache.py treats as
	// undeclared and erases (docs/d218).
	const dir = fixture();
	try {
		const result = run(dir, "30-generate.mjs");
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const layer = JSON.parse(
			readFileSync(join(dir, "config.d", "10-local-llm-inference.yaml"), "utf-8"),
		);
		const guest = "/home/ubuntu/.cache/huggingface/hub/";
		let referenced = 0;
		for (const entry of Object.values(layer.models)) {
			for (const path of String(entry.cmd).split(" ").filter((t) => t.startsWith(guest))) {
				const parts = path.slice(guest.length).split("/");
				const repoDir = parts[0];
				const file = parts.slice(3).join("/");
				if (repoDir === undefined || file === "") { continue; }
				const repo = repoDir.replace(/^models--/, "").replace("--", "/");
				referenced += 1;
				const rec = curated(dir, repo);
				const declared = new Set([...rec.files, ...rec.optional]);
				assert.ok(
					declared.has(file),
					`config.d references ${repo}/${file}, which its curated manifest omits`,
				);
			}
		}
		assert.ok(referenced > 0, "the fixture must emit at least one served file");
		assert.ok(
			curated(dir, "acme/served-GGUF").files.includes("mmproj-BF16.gguf"),
			"the resolved projector must be curated",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a curated file disappears when its repo stops serving", () => {
	const dir = fixture();
	try {
		assert.equal(run(dir, "30-generate.mjs").status, 0);
		assert.equal(existsSync(join(dir, "lib", "curated", "acme--sharded-GGUF.json")), true);

		// drop the only sharded entry and flip the mode in the same edit
		writeFileSync(
			join(dir, "lib", "llamacpp-model-data.json"),
			JSON.stringify({ models: modelData.models.filter((m) => !m["hf-repo"].startsWith("acme/sharded")) }),
		);
		writeFileSync(
			join(dir, "lib", "cache-scope.json"),
			JSON.stringify({ ...scope, "acme/sharded-GGUF": "audit-only" }),
		);
		const again = run(dir, "30-generate.mjs");
		assert.equal(again.status, 0, again.stdout + again.stderr);
		assert.equal(existsSync(join(dir, "lib", "curated", "acme--sharded-GGUF.json")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the authoring aid proposes raw entries for audit-only repos", () => {
	const dir = fixture();
	try {
		const result = run(dir, "20-propose-entries.mjs");
		assert.equal(result.status, 0, result.stderr);
		/** @type {{models: Record<string, string>[]}} */
		const proposed = JSON.parse(result.stdout);
		const repos = new Set(proposed.models.map((m) => String(m["hf-repo"]).split(":")[0]));
		assert.deepEqual([...repos], ["acme/audit-GGUF"]);
		// one entry per servable quant, the shard-1 filename, the quant label
		assert.deepEqual(proposed.models.map((m) => m["hf-repo"]), [
			"acme/audit-GGUF:Q4_K_M",
			"acme/audit-GGUF:BF16",
		]);
		assert.deepEqual(proposed.models.map((m) => m.model), ["a-Q4_K_M.gguf", "a-BF16.gguf"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unknown scope mode is refused", () => {
	const dir = fixture({ scope: { ...scope, "acme/served-GGUF": "serbed" } });
	try {
		const result = run(dir, "30-generate.mjs");
		assert.notEqual(result.status, 0);
		assert.match(result.stdout + result.stderr, /declares unknown mode/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("scope/manifest disagreement is reported, never enforced", () => {
	// The manifest is authoritative: curating it DOWN (or UP) must never be
	// blocked by the inventory file that was derived from it (docs/d212).
	const cases = [
		{
			name: "entry without a line",
			scope: { "acme/served-GGUF": "served", "acme/audit-GGUF": "audit-only" },
			table: modelData,
			message: /no cache-scope line/,
		},
		{
			name: "served without entries",
			scope: { ...scope, "acme/empty-GGUF": "served" },
			table: modelData,
			message: /nothing is curated for it/,
		},
		{
			name: "audit-only with entries",
			scope: { ...scope, "acme/served-GGUF": "audit-only" },
			table: modelData,
			message: /the manifest wins/,
		},
	];
	for (const testCase of cases) {
		const dir = fixture({ table: testCase.table, scope: testCase.scope });
		try {
			const result = run(dir, "30-generate.mjs");
			assert.equal(result.status, 0, `${testCase.name}: ${result.stdout}${result.stderr}`);
			assert.match(result.stdout + result.stderr, testCase.message, testCase.name);
			// and the manifest still won: the served repo is curated
			assert.equal(existsSync(join(dir, "lib", "curated", "acme--served-GGUF.json")), true, testCase.name);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

