/**
 * @fileoverview generate.mjs — the coding-agent folder driver: it runs the
 * two by-harness generators (pi + opencode) in place, installs the static
 * settings.json, refreshes the models.dev catalog, and installs the
 * generated artifacts (container hosts AND Termux; d041 ported the former
 * generate.sh shell 1:1 into node). Intermediates live in a per-run output
 * dir under RUN_DIR; docs/d072 retired the scratch staging of code, lib
 * modules and caches (see the output-dir block below).
 *
 * Profile, detected at runtime — only the committed-snapshot copy-back and
 * the opencode stage actually branch on it; everything else, the models.dev
 * refresh included, is identical:
 *   Termux (PREFIX under /data/data/com.termux): system node (Termux's
 *     bionic build; pi's own engines enforce the >= 22.19 floor when it
 *     launches) and secrets arriving as plain environment, via the explicit
 *     chain (./environment.sh ./npm-run.sh coding-agent generate). The committed snapshot is
 *     not consumed here — pi reads the agent dir directly, which is why the
 *     copy-back is container-only (docs/d059).
 *   Everywhere else (host or inside the coding-agent container): stages run
 *     via process.execPath (the same pinned node ./npm-run.sh resolved through
 *     ./node-run.sh), and secrets are expected ALREADY IN the environment by
 *     the caller (the launcher is exec'd through
 *     ./environment.sh and forwards the vault env through the workload_env
 *     allowlist).
 *
 * Probes, catalog fetches, and the artifacts themselves all address each
 * upstream's canonical URL and reach the edge through the environment proxy
 * (NODE_USE_ENV_PROXY + HTTP(S)_PROXY, docs/d074/d108) — no base URL is
 * involved anywhere in generation or installation.
 * @see route-probe.mjs for the probe/candidate plumbing.
 *
 * Generators, one per coding agent (the broad BY-AGENT merge that supersedes
 * docs/d037's narrow verdict):
 *   generate-pi-coding-agent.mjs -> all pi artifacts: the model-*.json layers,
 *                                    merged models.json, and the operator's
 *                                    hardcoded default pair overlay (docs/d036)
 *   generate-opencode.mjs        -> opencode config (skipped on Termux
 *                                    without OPENCODE_CONFIG_DIR)
 *
 * Outputs are installed into TWO places (there is no separate install step):
 * the pi agent dir — the LIVE dir in every environment, bare host and
 * in-container alike — and, on container hosts, this dir's own committed
 * snapshot (models.json + model-*.json): the CANONICAL form (real upstream
 * URLs, docs/d070) that a regeneration's git diff reviews (docs/d041).
 * Overwriting whatever pi left in the agent dir is deliberate: pi
 * re-persists its own runtime fields on the next run, and the committed
 * snapshot is the source of truth for everything else. mcp.json is the one
 * MERGE rather than a replace — this dir is shared with the host pi, and a
 * clobber would delete the operator's own servers (docs/d061). A read-only
 * scriptDir only warns.
 *
 * Env overrides:
 *   PI_CODING_AGENT_DIR  install dir (default ~/.pi/agent) — pi's own
 *                        agent-dir env var, so an install target and the pi
 *                        that later reads it can never diverge
 *   OPENCODE_CONFIG_DIR  opencode's config-dir install target (default
 *                    ${XDG_CONFIG_HOME:-$HOME/.config}/opencode) — upstream's
 *                    documented custom config directory (config.mdx:
 *                    searched like `.opencode`, loaded after the global
 *                    config so it overrides) and the dir coding-agent/run.mjs
 *                    mounts rw into the sandbox (docs/d065). The install hits
 *                    BOTH this host dir and the committed opencode.jsonc;
 *                    Termux skips the opencode stage unless this is set
 *   (no URL-shaping env: artifacts carry the fact-table upstream verbatim,
 *   docs/d070/d108. PEER_BASE_URL(S), REVERSE_PROXY_BASE_URLS and the other
 *   retired peer/proxy names are DEAD env: nothing in the tree reads them
 *   (docs/d071, d108))
 *   RUN_DIR          base dir for the per-run output dir the generators write
 *                    their layers and merged artifacts into (default $TMPDIR,
 *                    falling back to $PREFIX/tmp on Termux, /tmp elsewhere) —
 *                    this script's dir may be a read-only mount
 *   MODELS_DEV_RELAY_URL  catalog fetch override (default = the canonical
 *                    models.dev URL via the environment proxy, empty
 *                    disables — docs/d108)
 */

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serializeArtifact, writeArtifact } from "./lib/artifact.mjs";
import { logError, logInfo, logWarn, setLogTool } from "./lib/log.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

/**
 * Run one generator as a child process (one harness's crash never aborts the
 * other), and a stage failure is a warn-and-continue exactly like the shell's
 * `|| log_warn`. `env` is the stage's complete environment — the driver does
 * not mutate its own.
 * @param {string} script absolute path
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean} success
 */
function runStage(script, args, env) {
	const r = spawnSync(process.execPath, [script, ...args], {
		stdio: "inherit",
		env,
	});
	if (r.status !== 0) {
		logWarn("stage failed", {
			script: script.split("/").pop(),
			exit: r.status,
		});
		return false;
	}
	return true;
}

/**
 * Read a models.json-shaped file; an unreadable/invalid layer counts as ZERO
 * providers (an empty map is a valid cascade outcome, and the count — not
 * the file's existence — is the install guard; formerly count-providers.
 * mjs's contract, absorbed here when its shell caller died — docs/d041).
 * @param {string} path
 * @returns {Record<string, { models?: unknown[], baseUrl?: string }>}
 */
function providersOf(path) {
	try {
		return JSON.parse(readFileSync(path, "utf-8")).providers ?? {};
	} catch {
		return {};
	}
}

/**
 * Read an mcp.json-shaped file, reporting — never throwing — an unreadable or
 * invalid one. `null` means "leave the file alone": the agent dir is shared
 * with the host pi, and a merge cannot preserve servers it cannot read
 * (docs/d061).
 * @param {string} path
 * @returns {{ mcpServers?: Record<string, unknown> } | null}
 */
function readMcpConfig(path) {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		logError("mcp.json is not valid JSON — leaving it untouched", {
			path,
			error: String(err),
		});
		return null;
	}
}

/**
 * Mirror the freshly generated models.json and its model-*.json layers into
 * the committed snapshot dir — identical in URL form to what the agent dir
 * gets (docs/d041/d070/d108: generation emits real upstream URLs and no
 * install-time rewrite exists). Without this copy-back
 * `./npm-run.sh coding-agent generate` refreshes only the agent dir, so the
 * committed coding-agent/models.json stays frozen: the artifact a review
 * reads would keep an old generation. Container hosts only (docs/d059). A
 * read-only snapshot dir (e.g. a copied folder mounted ro) is expected and
 * only warns.
 * @param {string} modelsOut the merged models.json just installed
 * @param {string} outDir this run's output dir — the only place the fresh
 *   layers exist before this copy-back
 * @param {string} snapshotDir the committed snapshot dir (this script's dir)
 * @returns {void}
 */
function refreshCommittedSnapshot(modelsOut, outDir, snapshotDir) {
	const committedModels = join(snapshotDir, "models.json");
	try {
		if (modelsOut !== committedModels) {
			copyFileSync(modelsOut, committedModels);
			for (const name of readdirSync(outDir)) {
				if (/^model-.*\.json$/.test(name)) {
					copyFileSync(join(outDir, name), join(snapshotDir, name));
				}
			}
		}
		logInfo("committed snapshot refreshed", { path: snapshotDir });
	} catch (err) {
		logWarn("committed snapshot refresh skipped (read-only dir?)", {
			path: snapshotDir,
			error: err,
		});
	}
}

/**
 * Install settings.json into the agent dir, FIRST, so it lands even if every
 * generator stage fails. Best-effort pre-overwrite insurance (compare/rollback
 * a bad generate), NOT a preservation contract: the agent dir's copies are
 * generated ephemeral files and pi re-persists its runtime fields itself.
 * An incomplete generator tree (a consumer copied only some of this dir's
 * inputs) is reported at error level because it is never expected, but
 * non-fatal on purpose: the caller's staged settings.json is already in place
 * and nothing else depends on this file.
 * @param {string} from the generator tree's committed settings.json
 * @param {string} to the agent dir's settings.json
 * @returns {void}
 */
function installSettings(from, to) {
	if (!existsSync(from)) {
		logError("settings.json source missing — keeping the agent dir's copy", {
			path: from,
			agentSettings: to,
		});
		return;
	}
	if (existsSync(to)) {
		copyFileSync(
			to,
			`${to}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`,
		);
	}
	writeArtifact(to, readFileSync(from, "utf-8"));
	logInfo("settings.json installed", { path: to });
}

/**
 * Merge the committed default MCP servers UNDER the operator's set. The agent
 * dir is the HOST's real dir, shared with the host pi (docs/d054), so unlike
 * settings.json this file cannot be clobbered: the operator's MCP servers
 * exist only there. Committed entries are DEFAULTS — an existing entry with
 * the same name wins, so a hand-written definition or a deliberate
 * `"enabled": false` survives the install (docs/d061).
 * @param {string} source the committed mcp.json
 * @param {string} target the agent dir's mcp.json
 * @returns {void}
 */
function installMcp(source, target) {
	if (!existsSync(source)) {
		// Same non-fatal contract as the settings source: a consumer that
		// copied only part of this dir keeps the mcp.json already in place
		// rather than dropping MCP config over a missing input.
		logError("mcp.json source missing — keeping the agent dir's copy", {
			path: source,
			agentMcp: target,
		});
		return;
	}
	const defaults = readMcpConfig(source)?.mcpServers ?? {};
	const current = existsSync(target) ? readMcpConfig(target) : {};
	if (current === null) {
		return;
	}
	const mcpServers = { ...defaults, ...current.mcpServers };
	// Tabs so the installed copy stays byte-diffable against the committed
	// file this repo lints (biome; d050's determinism in spirit).
	writeArtifact(
		target,
		`${JSON.stringify({ ...current, mcpServers }, null, "\t")}\n`,
	);
	logInfo("mcp.json installed", {
		path: target,
		servers: Object.keys(mcpServers),
	});
}

/**
 * Install the merged models.json into the agent dir and log what landed.
 * d063 §3: a successful generation ALWAYS emits providers (the local
 * llama-swap layer plus the pi-native cloud rows), so an empty map is a
 * broken generation — neither installing it nor keeping a stale
 * direct-routing one is acceptable. The generated file is canonical (real
 * upstreams, docs/d070) and the copy that lands in the agent dir is
 * byte-identical in meaning: the reverse proxy that used to require a route
 * form there is deprecated as insecure (docs/d108), so there is no
 * install-time rewrite left to run.
 * @param {string} modelsOut the generated models.json
 * @param {string} agentDir the live pi agent dir
 * @returns {number} providers installed (0 = the caller must abort)
 */
function installModels(modelsOut, agentDir) {
	const providers = providersOf(modelsOut);
	if (Object.keys(providers).length === 0) {
		return 0;
	}
	const installed = /** @type {any} */ (
		JSON.parse(readFileSync(modelsOut, "utf-8"))
	);
	const target = join(agentDir, "models.json");
	if (existsSync(target)) {
		copyFileSync(
			target,
			`${target}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`,
		);
	}
	writeArtifact(target, serializeArtifact(installed));
	for (const [id, provider] of Object.entries(providersOf(target))) {
		logInfo("provider override", {
			provider: id,
			models: (provider.models ?? []).length,
			baseUrl: provider.baseUrl ?? "",
		});
	}
	logInfo("models.json installed", {
		path: target,
		providers: Object.keys(providers).length,
		backup: "kept alongside",
	});
	return Object.keys(providers).length;
}

/**
 * Install opencode's config into BOTH the host config dir (the sandbox's
 * mount source, docs/d065) and this dir's committed snapshot. Both carry the
 * same canonical URL form (docs/d070/d108): the host copy is what the sandbox
 * mounts, the committed copy is the reviewed git diff, so it refreshes on
 * every host that runs this stage, Termux included.
 * @param {string} generated the generator's output file
 * @param {string} hostDir opencode's config dir on this host
 * @param {string} snapshotDir the committed snapshot dir (this script's dir)
 * @returns {void}
 */
function installOpencode(generated, hostDir, snapshotDir) {
	// Best-effort .bak insurance, same as the settings/models installs above:
	// generated ephemeral files, not a preservation contract.
	const installed = /** @type {any} */ (
		JSON.parse(readFileSync(generated, "utf-8"))
	);
	mkdirSync(hostDir, { recursive: true });
	const host = join(hostDir, "opencode.json");
	if (existsSync(host)) {
		copyFileSync(
			host,
			`${host}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`,
		);
	}
	writeArtifact(host, serializeArtifact(installed));
	logInfo("opencode config installed", { path: host });

	// The committed snapshot: warn-only on a read-only dir, like
	// refreshCommittedSnapshot.
	try {
		copyFileSync(generated, join(snapshotDir, "opencode.jsonc"));
		logInfo("committed opencode snapshot refreshed", {
			path: join(snapshotDir, "opencode.jsonc"),
		});
	} catch (err) {
		logWarn("committed opencode snapshot refresh skipped (read-only dir?)", {
			path: join(snapshotDir, "opencode.jsonc"),
			error: err,
		});
	}
}

/**
 * THE entry point: reads the environment and argv, then runs every stage in
 * order. All side effects of this driver live here or in the helpers it
 * calls with explicit arguments.
 * @returns {Promise<void>}
 */
async function main() {
	setLogTool("coding-agent/generate");

	// A stage that dies on an uncaught throw (missing input, EROFS write, typo)
	// must end the run with a structured line naming where it died — not just a
	// raw stack trace — so the caller can quote the real cause instead of
	// "generate failed". Deliberate exits below use process.exit directly.
	let currentStage = "startup";
	process.on("uncaughtException", (err) => {
		logError("generate aborted — later stages did not run", {
			stage: currentStage,
			error: String(err?.stack ?? err),
		});
		process.exit(1);
	});

	const env = process.env;
	const termux = Boolean(env.PREFIX?.includes("com.termux"));
	/**
	 * pi's own agent-dir env var IS the override: the installer must write
	 * exactly the dir a pi launched with this env reads, so the two can't
	 * diverge. (A separate AGENT_DIR alias was removed: two names for one
	 * target allowed AGENT_DIR≠PI_CODING_AGENT_DIR silent mismatches —
	 * config installed where pi never looks.)
	 */
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? "", ".pi", "agent");
	/**
	 * The script's own dir may be a read-only mount, so the output dir lives
	 * in TMPDIR ($PREFIX/tmp on Termux).
	 */
	const runDir =
		env.RUN_DIR ??
		env.TMPDIR ??
		(termux ? join(env.PREFIX ?? "/data/data/com.termux/files/usr", "tmp") : tmpdir());

	mkdirSync(runDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	logInfo("profile", {
		profile: termux ? "termux" : "container-host",
		agentDir,
		runDir,
	});

	currentStage = "output-dir";

	// --- per-run output dir --------------------------------------------------
	// Everything the generators WRITE lands here: the model-*.json layers, the
	// merged models.json, the default-model overlay, opencode.json —
	// PI_LAYER_DIR is how each generator learns where the layers belong. They
	// run IN PLACE from scriptDir: docs/d072 retired the d023 scratch staging,
	// which existed for a read-only /opt tree that d056 has already stopped
	// mounting, and what generation still writes next to its own sources — the
	// committed layer/snapshot copy-back — is best-effort and warn-only by
	// contract (docs/d039; the facts caches it also wrote are gone, docs/d191).
	// The dir is per run (mkdtemp) so two generations cannot publish into each
	// other, and it is the only source the committed copy-back reads: every
	// artifact write is tmp+rename inside this dir (lib/artifact.mjs) and the
	// copy-back runs only after the whole generation succeeded, so a failed run
	// publishes nothing.
	const outDir = mkdtempSync(join(runDir, "pi-models-gen-"));

	currentStage = "settings-install";
	installSettings(join(scriptDir, "settings.json"), join(agentDir, "settings.json"));

	currentStage = "mcp-install";
	installMcp(join(scriptDir, "mcp.json"), join(agentDir, "mcp.json"));

	currentStage = "models-json";

	// --- models.json ---------------------------------------------------------
	// The models.dev catalog is FETCHED for this run and kept in the run's
	// output dir — there is no committed copy and no fallback to one
	// (docs/d191). The fetch is not best-effort any more: the catalog is where
	// every row's prices, limits and display names come from, so a host that
	// cannot reach it has no business writing layers that would claim
	// otherwise. Fail closed, like a failed provider row (docs/d063).
	const catalogOut = join(outDir, "models.dev.api.json");
	const generatorEnv = { ...env, PI_LAYER_DIR: outDir };
	if (!runStage(join(scriptDir, "refresh-models-dev.mjs"), [catalogOut], generatorEnv)) {
		logError("models.dev catalog unavailable — aborting (nothing generated)", {
			script: "refresh-models-dev.mjs",
		});
		process.exit(1);
	}
	logInfo("models.dev catalog fetched", { path: catalogOut });

	logInfo("generating pi config (layers + merge + default overlay)");
	// One generator, one process: generate-pi-coding-agent.mjs runs the local
	// GGUF layer, the cloud layers (docs/d037 override-only + full rows), the
	// layer merge, and the operator default-model overlay internally, each
	// stage isolated so one failure does not take the rest down (the same
	// contract the former per-stage child processes had). Its default stage
	// reads the settings file installed above.
	const piEnv = {
		...generatorEnv,
		PI_SETTINGS: join(agentDir, "settings.json"),
		PI_MODELS_JSON: join(outDir, "models.json"),
		PI_DEFAULT_MODEL_JSON: join(outDir, "default-model.json"),
	};
	// Seed the run's layer dir from the committed layers so a layer the
	// generator writes nothing for still merges the set the reviewed snapshot
	// describes — no generator reads history from that dir any more
	// (docs/d190 retired d064's stale-preserve, which did). The retired staging
	// made this copy part of every run too (docs/d072).
	for (const name of readdirSync(scriptDir)) {
		if (/^model-.*\.json$/.test(name)) {
			copyFileSync(join(scriptDir, name), join(outDir, name));
		}
	}
	// d063 fail closed: a failed pi generator means its layers were not
	// written — there is no committed-artifact fallback any more (d070 §6
	// retired SKIP_GEN; installing one raw would ship canonical URLs).
	if (!runStage(join(scriptDir, "generate-pi-coding-agent.mjs"), [], piEnv)) {
		logError("pi generator failed — aborting (nothing merged)", {
			script: "generate-pi-coding-agent.mjs",
		});
		process.exit(1);
	}

	const modelsOut = join(outDir, "models.json");
	if (!existsSync(modelsOut)) {
		logError("pi generator produced no models.json — aborting (docs/d070 §6)", {
			path: modelsOut,
		});
		process.exit(1);
	}

	currentStage = "default-model";

	// --- default model: the pi generator's default stage returned the
	// operator's hardcoded defaultProvider/defaultModel from the settings
	// source, as is (docs/d036 — the default is an OPERATOR DECISION, not a
	// probed fact). It ran with the rest of the pi stages; this block merges
	// its overlay into the installed settings.json (independent of the
	// models.json install).
	const overlay = join(outDir, "default-model.json");
	if (existsSync(overlay)) {
		const defaultModel = JSON.parse(readFileSync(overlay, "utf-8"));
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		if (defaultModel.defaultProvider) {
			settings.defaultProvider = defaultModel.defaultProvider;
		}
		if (defaultModel.defaultModel) {
			settings.defaultModel = defaultModel.defaultModel;
		}
		writeArtifact(
			join(agentDir, "settings.json"),
			`${JSON.stringify(settings, null, 2)}\n`,
		);
		logInfo("settings.json updated with default model config", {
			path: join(agentDir, "settings.json"),
		});
	} else {
		logWarn("pi generator produced no default-model overlay");
	}

	currentStage = "models-install";
	const installed = installModels(modelsOut, agentDir);
	if (installed === 0) {
		logError("0 providers generated — refusing to install (docs/d063)", {
			action: "abort",
			modelsJson: modelsOut,
		});
		process.exit(1);
	}
	if (!termux && modelsOut !== join(scriptDir, "models.json")) {
		refreshCommittedSnapshot(modelsOut, outDir, scriptDir);
	}

	currentStage = "opencode-config";

	// --- opencode config -----------------------------------------------------
	// Upstream loads the provider overlay when asked. The consumer knob is
	// upstream's documented OPENCODE_CONFIG_DIR (config.mdx "Custom
	// directory"; verified against 1.18.30): a directory loaded AFTER the
	// global config and .opencode, so its settings override theirs. NOT
	// upstream's OPENCODE_CONFIG — that is the config-FILE override, and a
	// directory value is silently ignored (probe: file content takes effect,
	// dir value doesn't). NOT XDG_CONFIG_HOME either (first cut here): it works
	// upstream, but it is a standard var every XDG tool reads — scoping the
	// override to opencode's own knob keeps other tools on the host default.
	//
	// The install mirrors what this script does for pi's settings/models.json
	// (docs/d054, docs/d065): generate into a per-run COPY of the committed
	// overlay — the copy is the write target, and a fresh output dir carries no
	// history for the generator to fall back on (docs/d190) — then on success
	// install BOTH the host config dir (the dir the launcher mounts rw into the
	// sandbox) and this dir's committed opencode.jsonc. Termux skips the stage
	// entirely (pi-only path) unless OPENCODE_CONFIG_DIR is set.
	const ocHostDir =
		env.OPENCODE_CONFIG_DIR ??
		join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? "", ".config"), "opencode");
	let ocOut = "";
	if (!termux || env.OPENCODE_CONFIG_DIR) {
		ocOut = join(outDir, "opencode.json");
		const ocCommitted = join(scriptDir, "opencode.jsonc");
		if (existsSync(ocCommitted)) {
			copyFileSync(ocCommitted, ocOut);
		}
	}
	if (ocOut && existsSync(join(scriptDir, "generate-opencode.mjs"))) {
		// d063 fail closed, same as the pi generator above: a half-written
		// overlay would leave a stale provider map in the committed opencode.jsonc.
		if (!runStage(join(scriptDir, "generate-opencode.mjs"), [ocOut], generatorEnv)) {
			logError("opencode generator failed — aborting (nothing written)", {
				script: "generate-opencode.mjs",
			});
			process.exit(1);
		}
		installOpencode(ocOut, ocHostDir, scriptDir);
	}

	rmSync(outDir, { recursive: true, force: true });
	logInfo("done", { agentDir });
}

if (import.meta.main) {
	main().catch((err) => {
		logError("generate failed", { error: String(err?.stack ?? err) });
		process.exit(1);
	});
}
