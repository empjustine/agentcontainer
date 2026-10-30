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
 *     chain (./lib/environment.sh ./generate.sh). The committed snapshot is
 *     not consumed here — pi reads the agent dir directly, which is why the
 *     copy-back is container-only (docs/d059).
 *   Everywhere else (host or inside the coding-agent container): stages run
 *     via process.execPath (the same pinned node the generate.sh shim
 *     resolved through lib/node-run.sh), and secrets are expected ALREADY IN
 *     the environment by the caller (run.sh is exec'd through
 *     lib/environment.sh and forwards the vault env through the workload_env
 *     allowlist).
 *
 * Route probes and install-time substitution go through the vault-sourced
 * $REVERSE_PROXY_BASE_URLS (comma/newline multi-hop candidates — see
 * route-probe.mjs; the one base env this repo reads, docs/d071).
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
 *                    config so it overrides) and the dir coding-agent/run.sh
 *                    mounts rw into the sandbox (docs/d065). The install hits
 *                    BOTH this host dir and the committed opencode.jsonc;
 *                    Termux skips the opencode stage unless this is set
 *   REVERSE_PROXY_BASE_URLS  required for generation (route probes) and
 *                    for the install-time route substitution (docs/d070 §3/
 *                    §7): the first candidate's base is what installed
 *                    artifacts get. Loaded from the vault via the explicit
 *                    chain (./lib/environment.sh <script>); the vault also
 *                    sets the retired PEER_BASE_URL(S) for outside
 *                    compatibility, never read here (docs/d071 §1).
 *                    settings.json/mcp.json installs need no base and stay
 *                    unconditional.
 *   RUN_DIR          base dir for the per-run output dir the generators write
 *                    their layers and merged artifacts into (default $TMPDIR,
 *                    falling back to $PREFIX/tmp on Termux, /tmp elsewhere) —
 *                    this script's dir may be a read-only mount
 *   MODELS_DEV_JSON  models.dev catalog (default ../lib/models.dev.api.json —
 *                    the shared vendored catalog, see docs/d023)
 *   MODELS_DEV_RELAY_URL  catalog relay override (default = the
 *                    REVERSE_PROXY_BASE_URLS host-form route chain, empty
 *                    disables — fetch chain in docs/d027, d063 §5 as
 *                    amended)
 */

import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
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

// Route substitution at install (docs/d070 §3): the same derivation the
// probes build, keyed by provider id through the shared fact table.
import {
	reverseProxyBaseUrl,
	reverseProxyBaseUrls,
	routeUrlFromCanonical,
} from "./route-probe.mjs";
// The artifact walker + d070 verifier: the ONE implementation of the URL-form
// rule, shared with run.sh's launch check and tests/artifact-urls.test.mjs.
import {
	installedViolations,
	rewriteProviderUrls,
} from "./check-routed-artifacts.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const LIB_DIR = process.env.LIB_DIR ?? join(repoRoot, "lib");
const { logError, logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { serializeArtifact, writeArtifact } =
	/** @type {typeof import("../lib/artifact.mjs")} */ (
		await import(`${LIB_DIR}/artifact.mjs`)
	);
setLogTool("coding-agent/generate");

// --- structured abort reporting -------------------------------------------
// A stage that dies on an uncaught throw (missing input, EROFS write, typo)
// must end the run with a structured line naming where it died — not just a
// raw stack trace — so the caller can quote the real cause instead of
// "generate failed". Deliberate exits above use process.exit directly.
let currentStage = "startup";
process.on("uncaughtException", (err) => {
	logError("generate aborted — later stages did not run", {
		stage: currentStage,
		error: String(err?.stack ?? err),
	});
	process.exit(1);
});

// --- profile + env ----------------------------------------------------------
const termux = Boolean(process.env.PREFIX?.includes("com.termux"));
/**
 * pi's own agent-dir env var IS the override: the installer must write
 * exactly the dir a pi launched with this env reads, so the two can't
 * diverge. (A separate AGENT_DIR alias was removed: two names for one
 * target allowed AGENT_DIR≠PI_CODING_AGENT_DIR silent mismatches —
 * config installed where pi never looks.)
 * @type {string}
 */
const agentDir =
	process.env.PI_CODING_AGENT_DIR ??
	join(process.env.HOME ?? "", ".pi", "agent");
/**
 * default_run_dir port (lib/workload-runtime.sh): the script's own dir may be
 * a read-only mount, so the output dir lives in TMPDIR ($PREFIX/tmp on Termux).
 * @type {string}
 */
const runDir =
	process.env.RUN_DIR ??
	process.env.TMPDIR ??
	(termux
		? join(process.env.PREFIX ?? "/data/data/com.termux/files/usr", "tmp")
		: tmpdir());
const modelsDevJson =
	process.env.MODELS_DEV_JSON ?? join(repoRoot, "lib", "models.dev.api.json");

// Generator runner: the two by-harness generators are CLIs (spawned child
// processes, so one harness's crash never aborts the other), and a stage
// failure is a warn-and-continue exactly like the shell's `|| log_warn`.
// Inside the pi generator the former pi stages are isolated in-process by its
// own runStage, so this spawn is the only cross-process boundary left.
/**
 * @param {string} script absolute path
 * @param {string[]} [args]
 * @returns {boolean} success
 */
function runStage(script, args = []) {
	const r = spawnSync(process.execPath, [script, ...args], {
		stdio: "inherit",
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

// --- route substitution (docs/d070) -----------------------------------------
/**
 * Canonical artifact in, installed route form out (docs/d070 §3): every
 * provider URL goes through routeUrlFromCanonical keyed by provider id
 * through the fact table — never by string-matching the URL — and the result
 * must pass the SHARED verifier (§5) before anything is written. Walker and
 * check are check-routed-artifacts.mjs's own, so the substitution cannot
 * drift from the rule that guards it, and a provider id the fact table does
 * not know aborts the install instead of shipping one URL's guess.
 * @param {unknown} doc parsed CANONICAL artifact, rewritten in place
 * @param {string} base the FIRST configured reverse-proxy base (d070 §4:
 *   availability never selects a URL)
 * @param {string} label artifact being installed (error context)
 * @returns {void}
 * @throws {Error} on a fact-table miss or a URL that escaped substitution
 */
function installRouted(doc, base, label) {
	rewriteProviderUrls(doc, (factId, url) =>
		routeUrlFromCanonical(base, factId, url),
	);
	const violations = installedViolations(doc, base);
	if (violations.length > 0) {
		throw new Error(`${label}: ${violations.join("; ")} (docs/d070 §5)`);
	}
}

/**
 * The base installed artifacts are routed under (d070 §3/§4): the FIRST
 * configured candidate, required — settings/mcp installs above already
 * happened unconditionally, but a models install without a base cannot
 * substitute routes and must fail loudly rather than write canonical URLs
 * into a host config dir.
 * @param {string} label stage name for the error line
 * @returns {string} the base, no trailing slash
 */
function requireInstallBase(label) {
	if (reverseProxyBaseUrls().length === 0) {
		logError(
			"no REVERSE_PROXY_BASE_URLS — cannot substitute client routes (docs/d070); load the vault env via ./lib/environment.sh",
			{ stage: label },
		);
		process.exit(1);
	}
	return reverseProxyBaseUrl();
}

/**
 * Mirror the freshly generated models.json and its model-*.json layers into
 * this script's own dir — the committed CANONICAL snapshot (docs/d041 +
 * d070 §3: the generators emit real upstream URLs, so this copy-back stays
 * canonical while the agent-dir install gets the routed form). Without this
 * copy-back `./generate.sh` refreshes
 * only the agent dir, so the committed coding-agent/models.json stays frozen:
 * the artifact a review reads and the next run's stale-preserve input would
 * both keep an old generation. Container hosts only (docs/d059). A read-only
 * scriptDir (e.g. a copied folder mounted ro) is
 * expected and only warns.
 * @param {string} modelsOut the merged models.json just installed
 * @param {string} outDir this run's output dir — the only place the fresh
 *   layers exist before this copy-back
 * @returns {void}
 */
function refreshCommittedSnapshot(modelsOut, outDir) {
	const committedModels = join(scriptDir, "models.json");
	try {
		if (modelsOut !== committedModels) {
			copyFileSync(modelsOut, committedModels);
			for (const name of readdirSync(outDir)) {
				if (/^model-.*\.json$/.test(name)) {
					copyFileSync(join(outDir, name), join(scriptDir, name));
				}
			}
		}
		logInfo("committed snapshot refreshed", { path: scriptDir });
	} catch (err) {
		logWarn("committed snapshot refresh skipped (read-only dir?)", {
			path: scriptDir,
			error: err,
		});
	}
}

mkdirSync(runDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
logInfo("profile", {
	profile: termux ? "termux" : "container-host",
	agentDir,
	runDir,
});

currentStage = "output-dir";

// --- per-run output dir ----------------------------------------------------
// Everything the generators WRITE lands here: the model-*.json layers, the
// merged models.json, the default-model overlay, opencode.json — PI_LAYER_DIR
// is how the pi generator learns where the layers belong. They run IN PLACE
// from scriptDir: docs/d072 retired the d023 scratch staging, which existed
// for a read-only /opt tree that d056 has already stopped mounting (the
// runner carries zero generator support), and what generation still writes
// next to its own sources — the committed layer/snapshot copy-back and the
// facts caches — is best-effort and warn-only by contract (docs/d021, d039).
// The dir is per run (mkdtemp) so two generations cannot publish into each
// other, and it is the only source the committed copy-back reads: every
// artifact write is tmp+rename inside this dir (lib/artifact.mjs) and the
// copy-back runs only after the whole generation succeeded, so a failed run
// publishes nothing.
const outDir = mkdtempSync(join(runDir, "pi-models-gen-"));
process.env.PI_LAYER_DIR = outDir;

currentStage = "settings-install";

// --- settings.json: install FIRST, so it lands even if every stage fails ----
const settingsPath = join(agentDir, "settings.json");
if (scriptDir !== agentDir) {
	if (existsSync(join(scriptDir, "settings.json"))) {
		// Best-effort pre-overwrite insurance (compare/rollback a bad
		// generate), NOT a preservation contract: the agent dir's copies are
		// generated ephemeral files (see the fileoverview) and pi re-persists
		// its runtime fields itself.
		if (existsSync(settingsPath)) {
			copyFileSync(
				settingsPath,
				`${settingsPath}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`,
			);
		}
		writeArtifact(settingsPath, readFileSync(join(scriptDir, "settings.json"), "utf-8"));
		logInfo("settings.json installed", { path: settingsPath });
	} else {
		// Incomplete generator tree (a consumer copied only some of this dir's
		// inputs). Reported at error level because it is never expected, but
		// non-fatal on purpose: the caller's staged settings.json is already in
		// place and none of the stages below depend on this file, so aborting
		// here would cost the whole generation for a static file.
		logError("settings.json source missing — keeping the agent dir's copy", {
			path: join(scriptDir, "settings.json"),
			agentSettings: settingsPath,
		});
	}
}

currentStage = "mcp-install";

// --- mcp.json: committed default MCP servers, merged UNDER the operator's ----
// The agent dir is the HOST's real dir, shared with the host pi (docs/d054), so
// unlike settings.json this file cannot be clobbered: the operator's MCP servers
// exist only there, and a regeneration would delete them. Committed entries are
// DEFAULTS — an existing entry with the same name wins, so a hand-written
// definition or a deliberate `"enabled": false` survives the install (docs/d061).
const mcpPath = join(agentDir, "mcp.json");
if (scriptDir !== agentDir) {
	const mcpSource = join(scriptDir, "mcp.json");
	if (existsSync(mcpSource)) {
		const defaults = readMcpConfig(mcpSource)?.mcpServers ?? {};
		const current = existsSync(mcpPath) ? readMcpConfig(mcpPath) : {};
		if (current !== null) {
			const mcpServers = { ...defaults, ...(current.mcpServers ?? {}) };
			// Tabs so the installed copy stays byte-diffable against the committed
			// file this repo lints (biome; d050's determinism in spirit).
			writeArtifact(
				mcpPath,
				`${JSON.stringify({ ...current, mcpServers }, null, "\t")}\n`,
			);
			logInfo("mcp.json installed", {
				path: mcpPath,
				servers: Object.keys(mcpServers),
			});
		}
	} else {
		// Same non-fatal contract as the settings source above: a consumer that
		// copied only part of this dir keeps the mcp.json already in place rather
		// than dropping MCP config over a missing input.
		logError("mcp.json source missing — keeping the agent dir's copy", {
			path: mcpSource,
			agentMcp: mcpPath,
		});
	}
}

currentStage = "models-json";

// --- models.json ------------------------------------------------------------
/** @type {string} */
let modelsOut = "";
// Best-effort refresh of the vendored models.dev catalog (no secrets
// needed). Unconditional: running generate means "I want current data", so
// the catalog is refetched on every host and only a failed fetch falls back
// to the vendored copy — there is no ambient switch that makes one run
// quieter than another (docs/d060).
//
// Refresh into the output dir when the catalog itself is not writable
// (container hosts: $MODELS_DEV_JSON is a read-only mount, so writing there
// would fail every single run), and point the generators at the refreshed
// copy through $MODELS_DEV_JSON — the vendored file stays as it is either
// way (docs/d072: no symlink into the staged tree anymore, the env override
// is the whole handoff).
let catalogOut = modelsDevJson;
try {
	accessSync(modelsDevJson, constants.W_OK);
} catch {
	catalogOut = join(outDir, "models.dev.api.json");
}
if (runStage(join(scriptDir, "refresh-models-dev.mjs"), [catalogOut])) {
	process.env.MODELS_DEV_JSON = catalogOut;
	logInfo("models.dev catalog refreshed", { path: catalogOut });
} else {
	logWarn("models.dev catalog refresh failed; using vendored copy", {
		path: modelsDevJson,
	});
}

logInfo("generating pi config (layers + merge + default overlay)");
// One generator, one process: generate-pi-coding-agent.mjs runs the local
// GGUF layer, the cloud layers (docs/d037 override-only + full rows), the
// layer merge, and the operator default-model overlay internally, each
// stage isolated so one failure does not take the rest down (the same
// contract the former per-stage child processes had). Its default stage
// reads the settings file installed above ($PI_SETTINGS).
process.env.PI_SETTINGS = settingsPath;
process.env.PI_MODELS_JSON = join(outDir, "models.json");
process.env.PI_DEFAULT_MODEL_JSON = join(outDir, "default-model.json");
// Seed the run's layer dir ($PI_LAYER_DIR above) from the committed layers:
// mergeModels globs that dir, and d064's stale-preserve reads the model-010
// layer from it as it stands BEFORE this run rewrites it — an empty dir would
// merge the wrong set and drop the farm's previous llama-swap lineup. The
// retired staging made this copy part of every run too (docs/d072).
for (const name of readdirSync(scriptDir)) {
	if (/^model-.*\.json$/.test(name)) {
		copyFileSync(join(scriptDir, name), join(outDir, name));
	}
}
// d063 fail closed: a failed pi generator means its layers were not
// written — there is no committed-artifact fallback anymore (d070 §6
// retired SKIP_GEN; installing one raw would ship canonical URLs).
if (!runStage(join(scriptDir, "generate-pi-coding-agent.mjs"))) {
	logError("pi generator failed — aborting (nothing merged)", {
		script: "generate-pi-coding-agent.mjs",
	});
	process.exit(1);
}

if (existsSync(join(outDir, "models.json"))) {
	modelsOut = join(outDir, "models.json");
} else {
	logError("pi generator produced no models.json — aborting (docs/d070 §6)", {
		path: join(outDir, "models.json"),
	});
	process.exit(1);
}

currentStage = "default-model";

// --- default model: the pi generator's default stage returned the operator's
// hardcoded defaultProvider/defaultModel from the settings source, as is
// (docs/d036 — the default is an OPERATOR DECISION, not a probed fact). It ran
// with the rest of the pi stages; this block merges its overlay into the
// installed settings.json (independent of the models.json install).
const overlay = join(outDir, "default-model.json");
if (existsSync(overlay)) {
	const defaultModel = JSON.parse(readFileSync(overlay, "utf-8"));
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	if (defaultModel.defaultProvider) {
		settings.defaultProvider = defaultModel.defaultProvider;
	}
	if (defaultModel.defaultModel) {
		settings.defaultModel = defaultModel.defaultModel;
	}
	writeArtifact(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	logInfo("settings.json updated with default model config", {
		path: settingsPath,
	});
} else {
	logWarn("pi generator produced no default-model overlay");
}

currentStage = "models-install";

// --- install models.json into the agent dir --------------------------------
// d063 §3: a successful generation ALWAYS emits providers (the local
// llama-swap layer plus the pi-native cloud rows), so an empty map is a
// broken generation — neither installing it nor keeping a stale
// direct-routing one is acceptable; fail instead.
//
// d070 §3: the generated file is CANONICAL (real upstreams) — the copy that
// lands in the agent dir is the one rewritten to client routes, under the
// FIRST configured base (§4), and verified to contain zero canonical URLs
// (§5) before it is written.
if (modelsOut) {
	const count = Object.keys(providersOf(modelsOut)).length;
	if (count === 0) {
		logError("0 providers generated — refusing to install (docs/d063)", {
			action: "abort",
			modelsJson: modelsOut,
		});
		process.exit(1);
	}
	const installBase = requireInstallBase("models-install");
	const installed = /** @type {any} */ (JSON.parse(readFileSync(modelsOut, "utf-8")));
	installRouted(installed, installBase, "models.json");
	if (existsSync(join(agentDir, "models.json"))) {
		copyFileSync(
			join(agentDir, "models.json"),
			`${join(agentDir, "models.json")}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`,
		);
	}
	writeArtifact(join(agentDir, "models.json"), serializeArtifact(installed));
	for (const [id, provider] of Object.entries(
		providersOf(join(agentDir, "models.json")),
	)) {
		logInfo("provider override", {
			provider: id,
			models: (provider.models ?? []).length,
			baseUrl: provider.baseUrl ?? "",
		});
	}
	logInfo("models.json installed", {
		path: join(agentDir, "models.json"),
		providers: count,
		backup: "kept alongside",
	});
	if (!termux && modelsOut !== join(scriptDir, "models.json")) {
		refreshCommittedSnapshot(modelsOut, outDir);
	}
}

currentStage = "opencode-config";

// --- opencode config --------------------------------------------------------
// Upstream loads the provider overlay when asked. The consumer
// knob is upstream's documented OPENCODE_CONFIG_DIR (config.mdx "Custom
// directory"; verified against 1.18.30): a directory loaded AFTER the global
// config and .opencode, so its settings override theirs. NOT upstream's
// OPENCODE_CONFIG — that is the config-FILE override, and a directory value
// is silently ignored (probe: file content takes effect, dir value doesn't).
// NOT XDG_CONFIG_HOME either (first cut here): it works upstream, but it is
// a standard var every XDG tool reads — scoping the override to opencode's
// own knob keeps other tools on the host default.
//
// The install mirrors what this script does for pi's settings/models.json
// (docs/d054, docs/d065): generate into a per-run COPY of the committed
// overlay — the copy is the write target AND the d064 stale-preserve input
// previousLocalProvider reads (a fresh output dir carries no history), then
// on success install BOTH the host config dir (the dir run.sh mounts rw into
// the sandbox) and this dir's committed opencode.jsonc. The two take
// different URL forms (docs/d070 §3): the host copy is substituted to client
// routes and verified canonical-free, while the committed copy stays the
// CANONICAL reviewed git diff and the next run's stale-preserve input, so it
// refreshes on every host that runs this stage, Termux included. Termux
// skips the stage entirely (pi-only path) unless OPENCODE_CONFIG_DIR is set.
const ocHostDir =
	process.env.OPENCODE_CONFIG_DIR ??
	join(
		process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
		"opencode",
	);
let ocOut = "";
if (!termux || process.env.OPENCODE_CONFIG_DIR) {
	ocOut = join(outDir, "opencode.json");
	const ocCommitted = join(scriptDir, "opencode.jsonc");
	if (existsSync(ocCommitted)) {
		copyFileSync(ocCommitted, ocOut);
	}
}
if (ocOut && existsSync(join(scriptDir, "generate-opencode.mjs"))) {
	// d063 fail closed, same as the pi generator above: a half-written
	// overlay would leave a stale provider map in the committed opencode.jsonc.
	if (!runStage(join(scriptDir, "generate-opencode.mjs"), [ocOut])) {
		logError("opencode generator failed — aborting (nothing written)", {
			script: "generate-opencode.mjs",
		});
		process.exit(1);
	}

	// Install 1 — the host config dir, the sandbox's mount source (d065).
	// d070 §3: route-form substitution + zero-canonical verification happen
	// HERE; the committed copy below keeps the canonical file.
	// Best-effort .bak insurance, same as the settings/models installs above:
	// generated ephemeral files, not a preservation contract.
	const ocBase = requireInstallBase("opencode-config");
	const ocInstalled = /** @type {any} */ (JSON.parse(readFileSync(ocOut, "utf-8")));
	installRouted(ocInstalled, ocBase, "opencode.json");
	mkdirSync(ocHostDir, { recursive: true });
	const ocHost = join(ocHostDir, "opencode.json");
	if (existsSync(ocHost)) {
		copyFileSync(
			ocHost,
			`${ocHost}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`,
		);
	}
	writeArtifact(ocHost, serializeArtifact(ocInstalled));
	logInfo("opencode config installed", { path: ocHost });

	// Install 2 — the committed snapshot (warn-only on a read-only dir, like
	// refreshCommittedSnapshot).
	try {
		copyFileSync(ocOut, join(scriptDir, "opencode.jsonc"));
		logInfo("committed opencode snapshot refreshed", {
			path: join(scriptDir, "opencode.jsonc"),
		});
	} catch (err) {
		logWarn("committed opencode snapshot refresh skipped (read-only dir?)", {
			path: join(scriptDir, "opencode.jsonc"),
			error: err,
		});
	}
}

rmSync(outDir, { recursive: true, force: true });
logInfo("done", { agentDir });
