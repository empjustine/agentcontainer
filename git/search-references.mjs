/**
 * @fileoverview search-references.mjs — cross-repo / cross-branch search over
 * the bare reference farm, the layer `non-bare-issues.md` deferred as
 * "Serving (future)". Design and rationale: docs/d043.
 *
 * Three subcommands, one engine (Zoekt in the official container image):
 *
 *   index  — discover bare mirrors (git-lib.mjs), run one `zoekt-git-index`
 *            container per mirror, --jobs wide, into an index dir that is a
 *            SIBLING of the farm (never inside it: a shard written under a
 *            mirror's working tree is exactly the layout the mirror work
 *            deleted — see non-bare-issues.md).
 *   serve  — run `zoekt-webserver` over that index dir on a host port. The
 *            coding-agent runner already uses `workload_network host`, so the
 *            container reaches this without any bind mount and therefore
 *            without podman's `z,U` relabel walk (the whole point of d043).
 *   query  — POST `<server>/api/search` when a server is up, else one-shot the
 *            `zoekt` CLI container. JSON or `repo:path:line:` text out.
 *
 * Why one container invocation PER mirror and not one for the whole farm:
 * zoekt-git-index sets `opts.RepositoryDescription.Name` from the first repo
 * when it is empty and never resets it, so a multi-repo invocation indexes
 * every repo under the first repo's name (verified against upstream source).
 * The container start cost is noise next to indexing a real repo.
 *
 * Why the container image and not a host `go install`: Zoekt ships no prebuilt
 * release binaries, and the repo already requires a container tool for every
 * other runtime (build.mjs). The image is multi-arch amd64+arm64. See d043.
 *
 * Env:
 *   REFERENCES_ROOT     farm root (default ~/Downloads/references)
 *   REFERENCES_INDEX    index dir (default ~/Downloads/references-index)
 *   ZOEKT_IMAGE         engine image (default ghcr.io/sourcegraph/zoekt:latest)
 *   CONTAINER_TOOL      podman|docker override (else PATH probe)
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import {
	DEFAULT_MAX_DEPTH,
	DEFAULT_ROOT,
	filterByGlobs,
	findBareMirrors,
	logError,
	logInfo,
	logWarn,
	pool,
	setLogTool,
} from "./git-lib.mjs";

setLogTool("git/search-references");

/**
 * Where index shards live when `--index` is not given. A sibling of the farm,
 * for the same reason `DEFAULT_DEST` is: never write into a tree the farm
 * walk or a future `--delete-originals` touches.
 */
export const DEFAULT_INDEX =
	process.env.REFERENCES_INDEX ??
	join(homedir(), "Downloads", "references-index");

/** Multi-arch OCI image carrying zoekt-git-index / zoekt-webserver / zoekt. */
export const DEFAULT_IMAGE =
	process.env.ZOEKT_IMAGE ?? "ghcr.io/sourcegraph/zoekt:latest";

/** Where the farm and the index are mounted inside the engine container. */
const FARM_MOUNT = "/refs";
const INDEX_MOUNT = "/data/index";

/** @returns {string|null} the container runtime, or null when none is present. */
function containerTool() {
	if (process.env.CONTAINER_TOOL) return process.env.CONTAINER_TOOL;
	for (const tool of ["podman", "docker"]) {
		if (spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0) {
			return tool;
		}
	}
	return null;
}

/**
 * Run a command to completion, streaming stdout/stderr through. Returns the
 * exit code (engine failures are reported per repo by the caller, not thrown).
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<number>}
 */
function run(cmd, args) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: "inherit" });
		child.on("close", (code) => resolve(code ?? 1));
		child.on("error", (err) => {
			logError("spawn failed", { cmd, error: err.message });
			resolve(127);
		});
	});
}

/**
 * Container argv common to every subcommand: the farm read-only at /refs, the
 * index read-write at /data/index, engine image last.
 * @param {string} tool
 * @param {string} root
 * @param {string} index
 * @returns {string[]}
 */
function containerBase(tool, root, index) {
	return [
		tool,
		"run",
		"--rm",
		"-v",
		`${root}:${FARM_MOUNT}:ro`,
		"-v",
		`${index}:${INDEX_MOUNT}`,
		DEFAULT_IMAGE,
	];
}

/**
 * Translate a host mirror path into its `/refs/...` path inside the engine
 * container.
 * @param {string} root
 * @param {string} repo
 * @returns {string}
 */
function containerRepoPath(root, repo) {
	return `${FARM_MOUNT}/${relative(root, repo)}`;
}

/**
 * @typedef {object} IndexOptions
 * @property {string} root
 * @property {string} index
 * @property {number} jobs
 * @property {number} maxDepth
 * @property {string} branches
 * @property {string[]} only
 * @property {string[]} exclude
 * @property {boolean} all
 * @property {boolean} dryRun
 */

/**
 * Index one mirror. `-repo_cache` is what makes Zoekt name the repo by its path
 * under the farm (`github.com/owner/repo`) instead of by basename, so the
 * `repo:` filter is the path a human already knows.
 * @param {string} repo
 * @param {IndexOptions} o
 * @param {string} tool
 * @returns {Promise<boolean>}
 */
async function indexOne(repo, o, tool) {
	const argv = containerBase(tool, o.root, o.index).concat([
		"zoekt-git-index",
		"-index",
		INDEX_MOUNT,
		"-repo_cache",
		FARM_MOUNT,
		// Mirrors have no submodule object stores (non-bare-issues.md); recursing
		// would only emit a warning per repo.
		"-submodules=false",
		"-branches",
		o.branches,
		containerRepoPath(o.root, repo),
	]);
	if (o.dryRun) {
		logInfo("would index", { repo, argv: argv.join(" ") });
		return true;
	}
	const code = await run(argv[0], argv.slice(1));
	if (code !== 0) {
		logWarn("index failed — shard left as-is", { repo, code });
		return false;
	}
	logInfo("indexed", { repo, branches: o.branches });
	return true;
}

/**
 * @param {string[]} argv
 * @returns {IndexOptions}
 */
function parseIndexArgs(argv) {
	/** @type {IndexOptions} */
	const o = {
		root: DEFAULT_ROOT,
		index: DEFAULT_INDEX,
		jobs: 4,
		maxDepth: DEFAULT_MAX_DEPTH,
		branches: "HEAD",
		only: [],
		exclude: [],
		all: false,
		dryRun: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		switch (a) {
			case "--root":
				o.root = /** @type {string} */ (argv[++i]);
				break;
			case "--index":
				o.index = /** @type {string} */ (argv[++i]);
				break;
			case "--jobs":
				o.jobs = Number(argv[++i]);
				break;
			case "--max-depth":
				o.maxDepth = Number(argv[++i]);
				break;
			case "--branches":
				o.branches = /** @type {string} */ (argv[++i]);
				break;
			case "--only":
				o.only.push(/** @type {string} */ (argv[++i]));
				break;
			case "--exclude":
				o.exclude.push(/** @type {string} */ (argv[++i]));
				break;
			case "--all":
				o.all = true;
				break;
			case "--dry-run":
				o.dryRun = true;
				break;
			default:
				throw new Error(`unknown flag: ${a} (try --help)`);
		}
	}
	return o;
}

/** @param {string[]} argv */
async function cmdIndex(argv) {
	const o = parseIndexArgs(argv);
	if (!existsSync(o.root)) {
		throw new Error(`reference root not found: ${o.root}`);
	}
	// Indexing is OPT-IN, one interesting repo at a time (docs/d043). A blanket
	// farm index multiplies the whole 73 GB by every branch and is almost never
	// what is wanted — the farm is a long tail and only a few repos are ever
	// searched deeply. `--all` is the explicit escape hatch, never the default.
	if (o.only.length === 0 && !o.all) {
		logWarn(
			"nothing selected — indexing is opt-in; pass --only GLOB (or --all for the whole farm)",
			{ root: o.root },
		);
		return;
	}
	const tool = containerTool();
	if (!tool && !o.dryRun) {
		throw new Error(
			"no podman or docker on PATH — the engine runs as a container (docs/d043)",
		);
	}
	// dry-run is the review/test path on a host with no container tool: the
	// argv shape is the thing being inspected, so borrow a placeholder name.
	const engine = tool ?? "podman";

	const discovered = findBareMirrors(o.root, o.maxDepth);
	const rels = discovered.map((p) => relative(o.root, p));
	const kept = new Set(filterByGlobs(rels, o.only, o.exclude));
	const repos = discovered.filter((p) => kept.has(relative(o.root, p)));

	logInfo("discovered bare mirrors", {
		root: o.root,
		count: repos.length,
		skippedByFilter: discovered.length - repos.length,
		jobs: o.jobs,
		branches: o.branches,
		index: o.index,
		all: o.all ? 1 : 0,
		dryRun: o.dryRun ? 1 : 0,
	});
	if (repos.length === 0) {
		logWarn("no bare mirrors found — run ./git/migrate.sh first", {
			root: o.root,
		});
		return;
	}

	if (!o.dryRun) mkdirSync(o.index, { recursive: true });

	const results = await pool(repos, o.jobs, (repo) =>
		indexOne(repo, o, engine),
	);
	const failed = results.filter((ok) => !ok).length;
	logInfo("index summary", {
		mirrors: repos.length,
		ok: repos.length - failed,
		failed,
	});
	if (failed) process.exitCode = 1;
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, index: string, port: number, dryRun: boolean }}
 */
function parseServeArgs(argv) {
	const o = {
		root: DEFAULT_ROOT,
		index: DEFAULT_INDEX,
		port: 6070,
		dryRun: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		switch (argv[i]) {
			case "--root":
				o.root = /** @type {string} */ (argv[++i]);
				break;
			case "--index":
				o.index = /** @type {string} */ (argv[++i]);
				break;
			case "--port":
				o.port = Number(argv[++i]);
				break;
			case "--dry-run":
				o.dryRun = true;
				break;
			default:
				throw new Error(`unknown flag: ${argv[i]} (try --help)`);
		}
	}
	return o;
}

/** @param {string[]} argv */
async function cmdServe(argv) {
	const o = parseServeArgs(argv);
	if (!existsSync(o.index)) {
		throw new Error(`index dir not found: ${o.index} (run index first)`);
	}
	const tool = containerTool();
	if (!tool && !o.dryRun) {
		throw new Error("no podman or docker on PATH (docs/d043)");
	}
	const engine = tool ?? "podman";
	// `-p 6070:6070` on the host network namespace is what lets the agent
	// container (workload_network host) reach the server WITHOUT mounting the
	// farm — the mount-free property is the reason this layer exists.
	const argvOri = containerBase(engine, o.root, o.index).concat([
		"-p",
		`${o.port}:${o.port}`,
		"zoekt-webserver",
		"-index",
		INDEX_MOUNT,
		"-listen",
		`:${o.port}`,
	]);
	if (o.dryRun) {
		process.stdout.write(`${argvOri.join(" ")}\n`);
		return;
	}
	logInfo("serving reference search", {
		port: o.port,
		index: o.index,
		image: DEFAULT_IMAGE,
	});
	// exec-style: the container IS the server process; forwarding signal/exit
	// keeps `./git/search-references.sh serve` a normal long-running command.
	const code = await run(argvOri[0], argvOri.slice(1));
	process.exitCode = code;
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, index: string, query: string,
 *   server: string, port: number, num: number, json: boolean, list: boolean }}
 */
function parseQueryArgs(argv) {
	const o = {
		root: DEFAULT_ROOT,
		index: DEFAULT_INDEX,
		query: "",
		server: process.env.ZOEKT_SERVER ?? "",
		port: Number(process.env.ZOEKT_PORT ?? 6070),
		num: 50,
		json: false,
		list: false,
	};
	const positional = [];
	for (let i = 0; i < argv.length; i += 1) {
		switch (argv[i]) {
			case "--root":
				o.root = /** @type {string} */ (argv[++i]);
				break;
			case "--index":
				o.index = /** @type {string} */ (argv[++i]);
				break;
			case "--server":
				o.server = /** @type {string} */ (argv[++i]);
				break;
			case "--port":
				o.port = Number(argv[++i]);
				break;
			case "--num":
				o.num = Number(argv[++i]);
				break;
			case "--json":
				o.json = true;
				break;
			case "--list":
				o.list = true;
				break;
			default:
				positional.push(argv[i]);
		}
	}
	o.query = positional.join(" ");
	return o;
}

/**
 * Query a running webserver's JSON API. The server returns Zoekt's standard
 * `{Result:{Files:[{Repository,Branches,FileName,Matches:[{LineNumber,
 * LineMatches:[{Line}]}]}]}}` shape; the agent-facing projection keeps repo,
 * branch, path and the matched line.
 * @param {{ server: string, query: string, num: number }} o
 * @returns {Promise<object>}
 */
async function queryServer(o) {
	const base = /^https?:\/\//.test(o.server) ? o.server : `http://${o.server}`;
	const url = `${base.replace(/\/$/, "")}/api/search?q=${encodeURIComponent(
		o.query,
	)}&num=${o.num}`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`search server ${res.status} ${res.statusText}`);
	}
	return /** @type {Promise<object>} */ (res.json());
}

/**
 * One-shot container query for when no server is running: `zoekt` reads the
 * index dir directly. `-jsonl` is the machine format; `-l` lists files only.
 * @param {string} tool
 * @param {{ root: string, index: string, query: string, num: number,
 *   json: boolean, list: boolean }} o
 * @returns {Promise<number>}
 */
async function queryOneShot(tool, o) {
	const argv = containerBase(tool, o.root, o.index).concat([
		"zoekt",
		"-index_dir",
		INDEX_MOUNT,
		...(o.list ? ["-l"] : []),
		...(o.json ? ["-jsonl"] : []),
		o.query,
	]);
	return run(argv[0], argv.slice(1));
}

/** @param {string[]} argv */
async function cmdQuery(argv) {
	const o = parseQueryArgs(argv);
	if (!o.query) throw new Error("empty query");

	if (o.server) {
		// A configured-but-unreachable server should not be fatal when the index
		// is on this host: degrade to the one-shot path rather than fail the query.
		try {
			const data = await queryServer(o);
			if (o.json) {
				process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
				return;
			}
			const files = /** @type {any[]} */ (
				/** @type {any} */ (data).Result?.Files ?? []
			);
			for (const f of files) {
				for (const m of f.Matches ?? []) {
					for (const lm of m.LineMatches ?? []) {
						process.stdout.write(
							`${f.Repository}:${f.FileName}:${m.LineNumber}:${(lm.Line ?? "").trimEnd()}\n`,
						);
					}
				}
			}
			return;
		} catch (err) {
			logWarn("search server unreachable — falling back to one-shot", {
				server: o.server,
				error: /** @type {Error} */ (err).message,
			});
		}
	}

	// Only the one-shot path needs the engine; a reachable server is queried
	// with plain fetch and never needs a container tool on this host.
	const tool = containerTool();
	if (!tool) throw new Error("no podman or docker on PATH (docs/d043)");
	process.exitCode = await queryOneShot(tool, o);
}

/** @param {string[]} argv */
async function main(argv) {
	const [sub, ...rest] = argv;
	if (!sub || sub === "-h" || sub === "--help") {
		process.stdout.write(
			"usage: ./git/search-references.sh <index|serve|query> [flags]\n\n" +
				"  index [--only GLOB]... [--all] [--root DIR] [--index DIR] [--jobs N]\n" +
				"        [--max-depth N] [--branches REFS] [--exclude GLOB]... [--dry-run]\n" +
				"        (indexing is opt-in: --only selects repos; --all is the explicit farm-wide build)\n" +
				"  serve [--root DIR] [--index DIR] [--port N] [--dry-run]\n" +
				"  query 'PATTERN [repo:...] [branch:...]' [--server URL] [--num N]\n" +
				"        [--json] [--list] [--root DIR] [--index DIR]\n",
		);
		return;
	}
	switch (sub) {
		case "index":
			await cmdIndex(rest);
			break;
		case "serve":
			await cmdServe(rest);
			break;
		case "query":
			await cmdQuery(rest);
			break;
		default:
			throw new Error(`unknown subcommand: ${sub} (try --help)`);
	}
}

await main(process.argv.slice(2)).catch((err) => {
	logError("search-references aborted", {
		error: /** @type {Error} */ (err)?.message ?? String(err),
	});
	process.exit(1);
});
