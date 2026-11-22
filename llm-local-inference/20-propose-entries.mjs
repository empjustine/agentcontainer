/**
 * @fileoverview 20-propose-entries.mjs — the manifest-authoring aid: model entries
 * the cache scope declares but the model manifest does not, printed as a
 * lib/llamacpp-model-data.json fragment.
 *
 * Input is the two committed files the decision needs: lib/cache-scope.json
 * (which repos are audit-only, i.e. kept in scope and served by nothing) and
 * each repo's committed manifest (what it ships). Output is {"models": [...]}
 * with TAB indentation, exactly the shape and formatting of the manifest file,
 * so a reviewed block pastes in as-is.
 *
 * WHY no display rules here: the manifest is the raw record of every quant
 * (pruning keeps a repo's declared pair, docs/d200), so proposing the raw set
 * is the honest offer — 30-generate.mjs applies the display rules when it curates,
 * and config.d shows what survived. Filtering here would pre-empt that decision
 * and duplicate the rules.
 *
 * The ONE field a human must supply is the ":quant" label: it is a naming
 * choice (QAD-Q4_0 vs Q4_0), so this tool derives the trailing quant token from
 * the filename and 10-fetch-hf-manifests.py --print-plan audits whatever gets
 * written. An entry needs only hf-repo + model (d210) — but drop the label
 * when the repo holds no other row: then it selects nothing, and the served id
 * loses the suffix too.
 *
 * Stdout is the fragment; log lines go to stderr. No flags: this is the whole
 * job (docs/d212).
 *
 * Usage: ./node-run.sh llm-local-inference/20-propose-entries.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { exitCodeOf, failure } from "./lib/failure.mjs";
import { logError, logInfo, setLogStream, setLogTool } from "./lib/log.mjs";
import { GGUF_SHARD_RE, mainGgufSizes } from "./lib/model-entries.mjs";

/**
 * The quant token a filename ends with, at a token boundary — the same shapes
 * the table's labels use (Q4_K_M, UD-Q2_K_XL, IQ1_M, BF16). Last match wins:
 * gemma-4-31B-it-UD-Q2_K_XL.gguf must not label itself "Q2_K_XL" or "31B".
 * @type {RegExp}
 */
const QUANT_TOKEN_RE =
	/(?:^|[-.])((?:UD-)?(?:IQ\d[A-Z0-9_]*|Q\d[A-Z0-9_]*|TQ\d[A-Z0-9_]*|MXFP4[A-Z0-9_]*|NVFP4[A-Z0-9_]*|BF16|F16|F32|FP8)(?:-\d+(?:\.\d+)?bpw)?)\.[Gg][Gg][Uu][Ff]$/g;

/**
 * @param {string} model de-sharded or shard-1 GGUF path
 * @returns {string} the label to write after ":"
 */
function quantLabel(model) {
	const base = model.split("/").pop() ?? model;
	/** @type {RegExpExecArray|null} */
	let last = null;
	for (const m of base.matchAll(QUANT_TOKEN_RE)) {
		last = m;
	}
	if (last?.[1]) {
		return last[1];
	}
	return base.replace(GGUF_SHARD_RE, "").replace(/\.gguf$/i, "");
}

/**
 * The shard-1 filename an entry must name, from the de-sharded manifest key: a
 * whole upload is its own name, a split one is reconstructed at 00001.
 * @param {Array<{path: string}>} files repo manifest files
 * @param {string} key de-sharded path
 * @returns {string}
 */
function shardOneName(files, key) {
	const candidates = files
		.map((f) => f.path)
		.filter((path) => path.replace(GGUF_SHARD_RE, ".gguf") === key);
	const whole = candidates.find((p) => !GGUF_SHARD_RE.test(p));
	if (whole !== undefined) {
		return whole;
	}
	const first = candidates.find((p) => /-00001-of-/.test(p));
	return first ?? key;
}

/**
 * @param {string} libDir this folder's own lib/
 * @param {string} repo "org/repo"
 * @returns {Record<string, string>[]} entries this repo could serve
 */
function entriesFor(libDir, repo) {
	const path = join(libDir, "hf-manifests", `${repo.replace("/", "--")}.json`);
	if (!existsSync(path)) {
		// The scope line is a declaration; without a repo manifest nothing can be
		// proposed for it, and 10-fetch-hf-manifests.py is the fix (docs/d212).
		logInfo("no committed repo manifest — run 10-fetch-hf-manifests.py --repo", { repo });
		return [];
	}
	/** @type {{files: Array<{path: string, size: number}>}} */
	const manifest = JSON.parse(readFileSync(path, "utf-8"));
	return [...mainGgufSizes(manifest.files).keys()].map((key) => {
		const model = shardOneName(manifest.files, key);
		return { "hf-repo": `${repo}:${quantLabel(key)}`, model };
	});
}

/**
 * @param {string} libDir this folder's own lib/
 * @returns {Record<string, string>[]} every proposed entry, repo-sorted
 */
function propose(libDir) {
	/** @type {Record<string, string>} */
	const scope = JSON.parse(
		readFileSync(join(libDir, "cache-scope.json"), "utf-8"),
	);
	/** @type {Record<string, string>[]} */
	const entries = [];
	for (const repo of Object.keys(scope).sort()) {
		if (scope[repo] !== "audit-only") {
			continue;
		}
		entries.push(...entriesFor(libDir, repo));
	}
	return entries;
}

/**
 * The fragment is tab-indented to match lib/llamacpp-model-data.json, so a
 * reviewed block pastes into the models array without reformatting.
 * @param {Record<string, string>[]} entries
 * @returns {string}
 */
function render(entries) {
	return `${JSON.stringify({ models: entries }, null, "\t")}\n`;
}

/**
 * THE entry point: reads argv/env and writes the fragment to stdout.
 * @returns {void}
 */
function main() {
	setLogTool("llm-local-inference/propose-entries");
	// d215: no accepted arguments. Ignoring argv would run the full effect
	// anyway: a stray --help once provisioned the whole catalog.
	if (process.argv.length > 2) {
		throw failure("usage: 20-propose-entries.mjs   # takes no arguments", 64);
	}
	// stdout carries the fragment, so the log lines move beside it (log.mjs's
	// setLogStream exists for exactly this).
	setLogStream(process.stderr);

	const libDir = join(dirname(fileURLToPath(import.meta.url)), "lib");
	const proposed = propose(libDir);
	process.stdout.write(render(proposed));
	logInfo("proposal written", {
		entries: proposed.length,
		repos: new Set(proposed.map((e) => String(e["hf-repo"]).split(":")[0])).size,
	});
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		// One handler (docs/d225 R3): log once, set the status, return.
		const exitCode = exitCodeOf(error);
		if (exitCode === undefined) {
			logError("proposal failed", {
				error: String(
					error instanceof Error ? (error.stack ?? error.message) : error,
				),
			});
			process.exitCode = 1;
		} else {
			// exitCodeOf only answers for this tree's own Error construct (d045).
			const failure = /** @type {{message: string, fields?: Record<string, unknown>}} */ (
				error
			);
			logError(failure.message, failure.fields ?? {});
			process.exitCode = exitCode;
		}
	}
}

