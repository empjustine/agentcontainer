/**
 * @fileoverview model-sizes.mjs — derive each model's on-disk footprint from
 * the committed HF manifests (fallback: the local HF cache) and order
 * `lib/llamacpp-model-data.json` cheapest-first (docs/d053).
 *
 * Why this exists: the table's order used to come from
 * `local-llm/generate_vram_fit_tables.py --update-model-data`, a measured
 * decode-speed sort. That sort depends on the external
 * `gdevenyi/huggingface-estimate` checkout, a GPU preset, a VRAM budget and
 * the ctx/batch set — none of which are properties of a model — so the
 * committed order churned on host/preset changes and no consumer could read
 * "how big is this model" without re-deriving it. Footprint is intrinsic,
 * offline and cheap, and is the rough "how expensive to run" proxy the
 * ordering wants.
 *
 * Footprint = main GGUF (ALL shards) + `mmproj` + `model-draft`, summed as
 * exact bytes and emitted in SI GB (decimal 1e9) because the number measures
 * storage/network, not RAM (docs/d053). The same bytes are what a runner must
 * load, so it doubles as a rough RAM/VRAM figure; it is NOT the resident set
 * (KV cache + activations remain the estimator's job,
 * docs/gguf-vram-fit-estimates.md).
 *
 * Sources: committed `lib/hf-manifests/<org>--<repo>.json` first (host
 * independent, but can be stale), the local HF cache second (exact for what
 * this host will serve, but only holds pulled quants). An entry that resolves
 * in neither is a hard error, never a silent zero or a dropped record.
 *
 * R5 (docs/d053): a summary of cached model GGUFs with no table entry goes to
 * stderr. The table is hand-curated and owned by this folder (docs/d025), and
 * the cache cannot supply an entry's `hf-repo:quant` tag, `ctx-size` cap,
 * `__argv` macro or `active-b.json` slug — so this warns and never adds.
 *
 * Determinism (docs/d050): exact bytes are summed first, converted once, and
 * rounded to a fixed 3 decimals; the array is sorted by that rounded value
 * with a code-unit tie-break; no timestamps, no locale, no filesystem-order
 * dependence. A rerun over unchanged inputs is byte-identical.
 *
 * Usage:
 *   ./llm-local-inference/model-sizes.sh            # rewrite the table
 *   ./llm-local-inference/model-sizes.sh --check    # exit 1 if a rerun would differ
 *   ./llm-local-inference/model-sizes.sh --verbose  # list cache-only files
 *   DRY_RUN=1 ./llm-local-inference/model-sizes.sh  # preview, do not replace
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared infra is resolved through the LIB_DIR convention (docs/d023) so the
 * script works both in place and when staged next to the generators.
 * @type {string}
 */
const LIB_DIR =
	process.env.LIB_DIR ?? fileURLToPath(new URL("../lib", import.meta.url));
const { logError, logInfo, logWarn, setLogStream, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { writeArtifact } = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);

setLogTool("model-sizes");
// stdout is reserved for a future machine-readable report; the table is the
// payload and it is written to a file (docs/d045).
setLogStream("stderr");

const MODEL_DATA = join(LIB_DIR, "llamacpp-model-data.json");
const MANIFEST_DIR = join(LIB_DIR, "hf-manifests");

/** Decimal GB — the measuring prefix for storage/network (docs/d053). */
const GB = 1e9;
/** Footprint is a rough proxy; 3 decimals keeps ties rare without pretending to exactness. */
const GB_DECIMALS = 3;
/** `<stem>-00001-of-00003.gguf` — the llama.cpp split-GGUF convention. */
const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
/** Sidecars are never "models" for the R5 cache-only scan (scan_cache_coverage.py's classifier). */
const SIDECAR_PREFIXES = [
	"mmproj",
	"mtp-",
	"eagle3-",
	"dflash-",
	"dspark-",
	"imatrix",
];
/** Component keys in the emitted `size-parts`, in footprint order. */
const COMPONENT_KEYS = ["model", "mmproj", "model-draft"];

/**
 * Code-unit order, never `localeCompare`: output bytes must not depend on the
 * host locale (docs/d050).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** @param {string} repo `org/name` @returns {string} */
const cacheDirName = (repo) => `models--${repo.replace("/", "--")}`;
/** @param {string} repo @returns {string} */
const manifestPath = (repo) =>
	join(MANIFEST_DIR, `${repo.replace("/", "--")}.json`);
/**
 * `hf-repo` carries the quant after the colon; only the repo part is a lookup key.
 * @param {string} hfRepo
 * @returns {string}
 */
const repoOf = (hfRepo) => hfRepo.split(":")[0];

/** @returns {string} HF hub cache root, matching the Python tools' resolution. */
function cacheRoot() {
	if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
	const home =
		process.env.HF_HOME ??
		join(
			process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
			"huggingface",
		);
	return join(home, "hub");
}

/** @param {string} name @returns {boolean} */
function isSidecar(name) {
	const base = name.split("/").pop() ?? name;
	return SIDECAR_PREFIXES.some((prefix) => base.startsWith(prefix));
}

/** @param {string} name @returns {boolean} */
function isModelGguf(name) {
	return name.endsWith(".gguf") && !isSidecar(name);
}

/**
 * @param {string} prefix shard stem, e.g. `UD-Q4_K_XL/Qwen3.8-27B-UD-Q4_K_XL`
 * @param {number} expected the `of-NNNNN` count
 * @returns {RegExp}
 */
function shardSiblingRe(prefix, expected) {
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`^${escaped}-\\d{5}-of-${String(expected).padStart(5, "0")}\\.gguf$`,
		"i",
	);
}

/**
 * The committed listing for one repo, or `null` when it has no manifest.
 * @param {string} repo
 * @returns {Map<string, number> | null} `path -> bytes`
 */
function manifestIndex(repo) {
	const file = manifestPath(repo);
	if (!existsSync(file)) return null;
	const doc = JSON.parse(readFileSync(file, "utf-8"));
	/** @type {Map<string, number>} */
	const index = new Map();
	for (const f of doc.files ?? []) {
		if (typeof f.path === "string" && typeof f.size === "number") {
			index.set(f.path, f.size);
		}
	}
	return index.size > 0 ? index : null;
}

/**
 * Every file in one repo's cache snapshots, keyed by forward-slash relative
 * path so it matches the manifest shape. Snapshot commits are walked in
 * sorted order and the first occurrence of a path wins, so a repo with more
 * than one cached revision still yields a stable map. `statSync` follows the
 * HF cache's blob symlinks, so the value is the real blob size.
 * @param {string} repo
 * @returns {Map<string, number> | null} `path -> bytes`
 */
function cacheIndex(repo) {
	const snapshots = join(cacheRoot(), cacheDirName(repo), "snapshots");
	if (!existsSync(snapshots)) return null;
	/** @type {Map<string, number>} */
	const index = new Map();
	for (const commit of readdirSync(snapshots).sort()) {
		const root = join(snapshots, commit);
		if (!statSync(root).isDirectory()) continue;
		walk(root, "");
	}
	return index.size > 0 ? index : null;

	/**
	 * @param {string} dir
	 * @param {string} rel
	 * @returns {void}
	 */
	function walk(dir, rel) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full, childRel);
			} else if (!index.has(childRel)) {
				index.set(childRel, statSync(full).size);
			}
		}
	}
}

/**
 * Resolve one declared file (`model` / `mmproj` / `model-draft`) to bytes.
 *
 * A shard name resolves to the SUM of its siblings, never just the referenced
 * `00001` file — an exact-match fast path there silently under-counts a
 * 100+ GiB model to a few MB (docs/d053). A source only wins when it carries
 * the full declared shard count, so an incomplete manifest falls through to
 * the cache instead of producing a short sum.
 *
 * @param {object} args
 * @param {string} args.repo
 * @param {string} args.name declared filename (may carry a subdir)
 * @param {Map<string, number> | null} args.manifest
 * @param {Map<string, number> | null} args.cache
 * @returns {{bytes: number, source: "manifest" | "cache"}}
 * @throws {Error} when neither source resolves the file
 */
function resolveComponent({ repo, name, manifest, cache }) {
	const shard = SHARD_RE.exec(name);
	if (shard) {
		const prefix = shard[1];
		const expected = Number(shard[3]);
		const re = shardSiblingRe(prefix, expected);
		/** @type {string[]} */
		const partial = [];
		for (const [source, index] of /** @type {const} */ ([
			["manifest", manifest],
			["cache", cache],
		])) {
			if (!index) continue;
			const sizes = [...index]
				.filter(([path]) => re.test(path))
				.map(([, size]) => size);
			if (sizes.length === expected) {
				return { bytes: sizes.reduce((sum, size) => sum + size, 0), source };
			}
			if (sizes.length > 0) {
				partial.push(`${source} has ${sizes.length}/${expected} shards`);
			}
		}
		const detail = partial.length > 0 ? ` (${partial.join("; ")})` : "";
		throw new Error(`cannot resolve all shards of ${name} in ${repo}${detail}`);
	}
	const fromManifest = manifest?.get(name);
	if (fromManifest !== undefined)
		return { bytes: fromManifest, source: "manifest" };
	const fromCache = cache?.get(name);
	if (fromCache !== undefined) return { bytes: fromCache, source: "cache" };
	throw new Error(`cannot resolve ${name} in ${repo} from manifest or cache`);
}

/**
 * @param {number} bytes
 * @returns {number} SI GB rounded to the fixed precision
 */
function toGb(bytes) {
	return Number((bytes / GB).toFixed(GB_DECIMALS));
}

/**
 * Walk the cache and report model GGUFs the table does not reference, split
 * into zero-coverage repos and extra quants in listed repos (R5). A summary
 * is the default because a host can carry dozens of extra quants per repo;
 * `--verbose` lists them.
 * @param {Record<string, unknown>[]} models
 * @param {boolean} verbose
 * @returns {void}
 */
function reportCacheOnly(models, verbose) {
	/** @type {Map<string, {paths: Set<string>, shards: Set<string>}>} */
	const referenced = new Map();
	for (const entry of models) {
		const repo = repoOf(String(entry["hf-repo"]));
		const ref = referenced.get(repo) ?? { paths: new Set(), shards: new Set() };
		referenced.set(repo, ref);
		for (const key of COMPONENT_KEYS) {
			const name = entry[key];
			if (typeof name !== "string") continue;
			const shard = SHARD_RE.exec(name);
			if (shard) ref.shards.add(shard[1]);
			else ref.paths.add(name);
		}
	}

	/** @type {string[]} */
	const zeroCoverage = [];
	/** @type {Array<{repo: string, files: string[]}>} */
	const extras = [];
	const root = cacheRoot();
	if (!existsSync(root)) {
		logWarn("HF cache root absent — skipping cache-only scan", { cache: root });
		return;
	}
	for (const dir of readdirSync(root).sort()) {
		if (!dir.startsWith("models--")) continue;
		const repo = dir.slice("models--".length).replace("--", "/");
		const index = cacheIndex(repo);
		if (!index) continue;
		const files = [...index.keys()].filter(isModelGguf);
		if (files.length === 0) continue;
		if (!referenced.has(repo)) {
			zeroCoverage.push(repo);
			continue;
		}
		const ref = /** @type {{paths: Set<string>, shards: Set<string>}} */ (
			referenced.get(repo)
		);
		const missing = files.filter((path) => {
			if (ref.paths.has(path)) return false;
			const shard = SHARD_RE.exec(path);
			return !(shard && ref.shards.has(shard[1]));
		});
		if (missing.length > 0) extras.push({ repo, files: missing });
	}

	const extraCount = extras.reduce((sum, e) => sum + e.files.length, 0);
	if (zeroCoverage.length > 0 || extraCount > 0) {
		logWarn("cache GGUFs absent from the model table (warn-only, docs/d053)", {
			zero_coverage_repos: zeroCoverage.length,
			repos_with_extras: extras.length,
			extra_files: extraCount,
		});
	}
	if (zeroCoverage.length > 0) {
		logWarn("repos with zero table coverage", { repos: zeroCoverage });
	}
	if (verbose) {
		for (const { repo, files } of extras) {
			logInfo("listed repo with extra cached quants", { repo, files });
		}
	}
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>[]}
 */
function asModels(value) {
	if (!Array.isArray(value))
		throw new Error("model table has no `models` array");
	return /** @type {Record<string, unknown>[]} */ (value);
}

function main() {
	const flags = new Set(process.argv.slice(2));
	for (const flag of flags) {
		if (flag !== "--check" && flag !== "--verbose") {
			throw new Error(`unknown argument: ${flag}`);
		}
	}
	const checkOnly = flags.has("--check");

	const doc = JSON.parse(readFileSync(MODEL_DATA, "utf-8"));
	const models = asModels(doc.models);

	/** @type {string[]} */
	const failures = [];
	/** @type {string[]} */
	const fallbacks = [];

	for (const entry of models) {
		const hfRepo = String(entry["hf-repo"]);
		const repo = repoOf(hfRepo);
		const manifest = manifestIndex(repo);
		const cache = cacheIndex(repo);
		/** @type {Record<string, number>} */
		const parts = {};
		let total = 0;
		for (const key of COMPONENT_KEYS) {
			const name = entry[key];
			if (typeof name !== "string") continue;
			try {
				const { bytes, source } = resolveComponent({
					repo,
					name,
					manifest,
					cache,
				});
				parts[key] = toGb(bytes);
				total += bytes;
				if (source === "cache") fallbacks.push(`${hfRepo}: ${name}`);
			} catch (err) {
				failures.push(err instanceof Error ? err.message : String(err));
			}
		}
		if (Object.keys(parts).length === 0) continue;
		entry["size-gb"] = toGb(total);
		entry["size-parts"] = parts;
	}

	if (failures.length > 0) {
		for (const failure of failures)
			logError("unresolved model file", { detail: failure });
		throw new Error(`${failures.length} model file(s) could not be resolved`);
	}

	models.sort(
		(a, b) =>
			Number(a["size-gb"]) - Number(b["size-gb"]) ||
			byCodeUnit(String(a["hf-repo"]), String(b["hf-repo"])) ||
			byCodeUnit(String(a.model), String(b.model)),
	);

	const text = `${JSON.stringify(doc, null, "\t")}\n`;

	reportCacheOnly(models, flags.has("--verbose"));

	if (checkOnly) {
		const current = readFileSync(MODEL_DATA, "utf-8");
		if (current !== text) {
			logError("model table is stale — rerun without --check", {
				path: MODEL_DATA,
			});
			process.exit(1);
		}
		logInfo("model table is up to date", { entries: models.length });
		return;
	}

	const written = writeArtifact(MODEL_DATA, text);
	const smallest = models[0];
	const largest = models[models.length - 1];
	logInfo("wrote size-ordered model table", {
		path: written,
		entries: models.length,
		smallest_gb: smallest?.["size-gb"],
		smallest: smallest?.["hf-repo"],
		largest_gb: largest?.["size-gb"],
		largest: largest?.["hf-repo"],
		cache_fallbacks: fallbacks.length,
	});
	if (fallbacks.length > 0) {
		logWarn(
			"model files resolved from the local cache, not a committed manifest",
			{
				files: fallbacks.length,
			},
		);
	}
}

try {
	main();
} catch (err) {
	logError("model-sizes failed", { error: err });
	process.exit(1);
}
