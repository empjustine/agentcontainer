/**
 * @fileoverview generate.mjs — the coding-agent folder driver: it stages the
 * two by-harness generators (pi + opencode) into a writable scratch dir,
 * installs the static settings.json, refreshes the models.dev catalog, runs
 * them as child processes, and installs the generated artifacts (container
 * hosts AND Termux; d041 ported the former generate.sh shell 1:1 into node).
 *
 * Profile, detected at runtime:
 *   Termux (PREFIX under /data/data/com.termux):
 *     - system node (Termux's bionic build; no mise) — pi's own engines
 *       enforce the >= 22.19 floor when it launches
 *     - secrets arrive as plain environment, via the explicit chain
 *       (./lib/environment.sh ./generate.sh)
 *     - vendored models.dev catalog by default (no refetch over mobile data)
 *   Everywhere else (host or inside the coding-agent container):
 *     - the orchestrator itself was resolved through lib/node-run.sh by the
 *       generate.sh shim; stages run via process.execPath (same pinned node)
 *     - secrets expected ALREADY IN the environment by the caller (run.sh is
 *       exec'd through lib/environment.sh and forwards the vault env through
 *       the workload_env allowlist)
 *     - models.dev catalog refreshed best-effort
 *     - peer routing goes through the vault-sourced $PEER_BASE_URL (or
 *       $PEER_BASE_URLS for multi-hop proxy chains — see peer-probe.mjs)
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
 * the pi agent dir (models.json + settings.json + the static mcp.json,
 * models/settings backed up as .bak-<ts>)
 * AND, on container hosts, this dir's own committed snapshot (models.json +
 * model-*.json) — what SKIP_GEN installs and what a regeneration's git diff
 * reviews (docs/d041's "the committed config is the runtime config"). The
 * agent-dir copies are
 * GENERATED EPHEMERAL files: the install target is the live dir in every
 * environment (bare host and Termux: $HOME/.pi/agent; in-container: the
 * pinned mount), so pi itself always sees the fresh list. Overwriting
 * whatever pi left there is by design — pi re-persists its own runtime
 * fields (theme, lastChangelogVersion) on the next run; the committed
 * settings.json is the source of truth for everything else. mcp.json is the
 * one exception: it is MERGED, committed servers as defaults UNDER the
 * operator's own entries, because this dir is shared with the host pi and a
 * clobber would delete its personal servers (docs/d061). The committed
 * snapshot refresh is container-only: on Termux pi reads the agent dir
 * directly and no runner consumes the committed copy (docs/d059), so it stays
 * a SKIP_GEN fallback there. A read-only scriptDir (e.g. a copied folder
 * mounted ro) only warns.
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
 *   SKIP_GEN         1 = install the committed <this dir>/models.json instead of
 *                    generating (no network at all) — it chooses the artifact
 *                    SOURCE; the write itself still replaces atomically
 *                    (lib/artifact.mjs). SKIP_GEN=1 short-circuits first.
 *                    Since docs/d063 it doubles as the SANCTIONED BYPASS for
 *                    proxy-only generation on a host without vault env
 *                    (PEER_BASE_URL(S) empty ⇒ the generators refuse to run).
 *   RUN_DIR          scratch dir for intermediate layers (default $TMPDIR,
 *                    falling back to $PREFIX/tmp on Termux, /tmp elsewhere) —
 *                    this script's dir may be a read-only mount
 *   MODELS_DEV_JSON  models.dev catalog (default ../lib/models.dev.api.json —
 *                    the shared vendored catalog, see docs/d023)
 *   MODELS_DEV_RELAY_URL  catalog relay fallback (llm-reverse-proxy
 *                    passthrough; default http://127.0.0.1:8080/models.dev/
 *                    api.json, empty disables — fetch chain in docs/d027)
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
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const LIB_DIR = process.env.LIB_DIR ?? join(repoRoot, "lib");
const { logError, logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
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
 * a read-only mount, so scratch lives in TMPDIR ($PREFIX/tmp on Termux).
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

/**
 * Mirror the freshly generated models.json and its model-*.json layers into
 * this script's own dir — the committed snapshot SKIP_GEN installs (docs/d041).
 * Without this copy-back `./generate.sh` refreshes
 * only the agent dir, so the committed coding-agent/models.json stays frozen:
 * the list a SKIP_GEN run installs and the diff a regeneration reviews would
 * both keep an old generation. Container hosts only (docs/d059). A read-only
 * scriptDir (e.g. a copied folder mounted ro) is
 * expected and only warns.
 * @param {string} modelsOut the merged models.json just installed
 * @param {string} scratch the staged generator dir holding the layers
 * @returns {void}
 */
function refreshCommittedSnapshot(modelsOut, scratch) {
	const committedModels = join(scriptDir, "models.json");
	try {
		if (modelsOut !== committedModels) {
			copyFileSync(modelsOut, committedModels);
			for (const name of readdirSync(scratch)) {
				if (/^model-.*\.json$/.test(name)) {
					copyFileSync(join(scratch, name), join(scriptDir, name));
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

currentStage = "scratch-stage";

// --- scratch dir: generators read layers from their own directory, and this
// dir may be a read-only mount (container ro-mount), so stage the generators
// — plus the helper modules they import (peer-probe.mjs, provider-facts.mjs,
// catwalk-facts.mjs, docs/d039) and the lib/ modules resolved via $LIB_DIR
// (log.mjs, artifact.mjs, canonical-json.mjs, cloud-providers.mjs, docs/d023
// + d050) — there and
// symlink the big inputs.
const scratch = mkdtempSync(join(runDir, "pi-models-gen-"));
const scratchLib = join(scratch, "lib");
mkdirSync(scratchLib, { recursive: true });
const GENERATORS = [
	"gen-lib.mjs",
	"generate-pi-coding-agent.mjs",
	"generate-opencode.mjs",
	"peer-probe.mjs",
	"provider-facts.mjs",
	"catwalk-facts.mjs",
	"refresh-models-dev.mjs",
];
for (const f of GENERATORS) {
	if (existsSync(join(scriptDir, f))) {
		copyFileSync(join(scriptDir, f), join(scratch, f));
	} else {
		logWarn("generator missing", { path: join(scriptDir, f) });
	}
}
// Structured logging + the shared fact table for the .mjs generators: they
// import these from $LIB_DIR (default ../lib relative to their own file —
// which from the scratch dir resolves somewhere that does not exist, so a
// missing copy here costs every generator instead of one clear line).
// canonical-json.mjs is here as artifact.mjs's runtime dependency (d050);
// tests/lib-staging.test.mjs fails if either this list or run.sh's mounts
// drift out of sync with what the generators actually import.
for (const f of [
	"log.mjs",
	"artifact.mjs",
	"canonical-json.mjs",
	"cloud-providers.mjs",
]) {
	if (existsSync(join(repoRoot, "lib", f))) {
		copyFileSync(join(repoRoot, "lib", f), join(scratchLib, f));
	} else {
		logError("lib module missing — generators cannot log or probe", {
			path: join(repoRoot, "lib", f),
		});
	}
}
// The facts caches ride along with their consumers: each `<id>-facts.json`
// (provider-facts.mjs's path convention) lives next to the module in
// coding-agent/ and stages into the scratch ROOT; catwalk-facts.json stays in
// lib/ (the proxy generator reads it too) and stages into the scratch lib.
// The caches are discovered by provider-facts.mjs's own naming rule rather
// than listed per provider, so adding a facts-backed row needs no edit here.
// All are staged writable so in-container refreshes succeed instead of
// failing on the ro-mounted /opt copies; all are consumed stale-tolerantly
// and direct-mode runs refresh them fresh.
for (const cache of readdirSync(scriptDir).filter((name) =>
	/^[a-z0-9]+(?:-[a-z0-9]+)*-facts\.json$/.test(name),
)) {
	copyFileSync(join(scriptDir, cache), join(scratch, cache));
}
if (existsSync(join(repoRoot, "lib", "catwalk-facts.json"))) {
	copyFileSync(
		join(repoRoot, "lib", "catwalk-facts.json"),
		join(scratchLib, "catwalk-facts.json"),
	);
}
// d063's stale-preserve needs the previous state readable from the scratch
// dir: the local llama-swap carry-forward (previousLocalProvider) reads the
// committed model-010 layer, and the layer merge sees whatever is staged
// here. Every committed model-*.json is staged; the rows regenerate over it
// each run, so the survivors ARE the previous state. Consequence: retiring
// a row must delete its committed layer in the same change, or the merge
// keeps merging it in — stale.
for (const name of readdirSync(scriptDir)) {
	if (/^model-.*\.json$/.test(name)) {
		copyFileSync(join(scriptDir, name), join(scratch, name));
	}
}
process.env.LIB_DIR = scratchLib;
if (existsSync(modelsDevJson)) {
	symlinkSync(modelsDevJson, join(scratch, "models.dev.api.json"));
}

currentStage = "settings-install";

// --- settings.json: install FIRST, so it lands even if every stage fails ----
const settingsPath = join(agentDir, "settings.json");
if (scriptDir !== agentDir) {
	if (!existsSync(join(scriptDir, "settings.json"))) {
		// Incomplete generator tree (a consumer copied only some of this dir's
		// inputs). Reported at error level because it is never expected, but
		// non-fatal on purpose: the caller's staged settings.json is already in
		// place and none of the stages below depend on this file, so aborting
		// here would cost the whole generation for a static file.
		logError("settings.json source missing — keeping the agent dir's copy", {
			path: join(scriptDir, "settings.json"),
			agentSettings: settingsPath,
		});
	} else {
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
		copyFileSync(join(scriptDir, "settings.json"), settingsPath);
		logInfo("settings.json installed", { path: settingsPath });
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
	if (!existsSync(mcpSource)) {
		// Same non-fatal contract as the settings source above: a consumer that
		// copied only part of this dir keeps the mcp.json already in place rather
		// than dropping MCP config over a missing input.
		logError("mcp.json source missing — keeping the agent dir's copy", {
			path: mcpSource,
			agentMcp: mcpPath,
		});
	} else {
		const defaults = readMcpConfig(mcpSource)?.mcpServers ?? {};
		const current = existsSync(mcpPath) ? readMcpConfig(mcpPath) : {};
		if (current !== null) {
			const mcpServers = { ...defaults, ...(current.mcpServers ?? {}) };
			// Tabs so the installed copy stays byte-diffable against the committed
			// file this repo lints (biome; d050's determinism in spirit).
			writeFileSync(
				mcpPath,
				`${JSON.stringify({ ...current, mcpServers }, null, "\t")}\n`,
			);
			logInfo("mcp.json installed", {
				path: mcpPath,
				servers: Object.keys(mcpServers),
			});
		}
	}
}

currentStage = "models-json";

// --- models.json ------------------------------------------------------------
/** @type {string} */
let modelsOut = "";
if (process.env.SKIP_GEN === "1") {
	if (existsSync(join(scriptDir, "models.json"))) {
		modelsOut = join(scriptDir, "models.json");
		logInfo("SKIP_GEN: using committed models.json", { path: modelsOut });
	} else {
		logWarn("SKIP_GEN=1 but committed models.json missing", {
			path: join(scriptDir, "models.json"),
		});
	}
} else {
	// Best-effort refresh of the vendored models.dev catalog (no secrets
	// needed). Unconditional: running generate means "I want current data", so
	// the catalog is refetched on every host and only a failed fetch falls back
	// to the vendored copy — there is no ambient switch that makes one run
	// quieter than another (docs/d060).
	//
	// Refresh into the scratch dir when the catalog itself is not writable
	// (container hosts: $MODELS_DEV_JSON is a read-only mount, so writing
	// there fails every single run). The scratch entry is a symlink to the
	// vendored catalog at this point; the generator's tmp+rename replaces
	// the symlink with a regular file and never follows it, so the vendored
	// copy stays untouched either way.
	let catalogOut = modelsDevJson;
	try {
		accessSync(modelsDevJson, constants.W_OK);
	} catch {
		catalogOut = join(scratch, "models.dev.api.json");
	}
	if (runStage(join(scratch, "refresh-models-dev.mjs"), [catalogOut])) {
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
	process.env.PI_MODELS_JSON = join(scratch, "models.json");
	process.env.PI_DEFAULT_MODEL_JSON = join(scratch, "default-model.json");
	// d063 fail closed: a failed pi generator means its layers were not
	// written — installing the committed artifact anyway would ship direct
	// baseUrls. SKIP_GEN=1 is the sanctioned bypass (docs/d063 §4).
	if (!runStage(join(scratch, "generate-pi-coding-agent.mjs"))) {
		logError("pi generator failed — aborting (nothing merged)", {
			script: "generate-pi-coding-agent.mjs",
		});
		process.exit(1);
	}

	if (existsSync(join(scratch, "models.json"))) {
		modelsOut = join(scratch, "models.json");
	} else {
		logWarn("no models.json generated; falling back to committed copy", {
			path: join(scriptDir, "models.json"),
		});
		if (existsSync(join(scriptDir, "models.json"))) {
			modelsOut = join(scriptDir, "models.json");
		}
	}
}

currentStage = "default-model";

// --- default model: the pi generator's default stage returned the operator's
// hardcoded defaultProvider/defaultModel from the settings source, as is
// (docs/d036 — the default is an OPERATOR DECISION, not a probed fact). It ran
// with the rest of the pi stages; this block merges its overlay into the
// installed settings.json (independent of the models.json install).
if (process.env.SKIP_GEN === "1") {
	logInfo("SKIP_GEN: skipping default model configuration");
} else {
	const overlay = join(scratch, "default-model.json");
	if (existsSync(overlay)) {
		const defaultModel = JSON.parse(readFileSync(overlay, "utf-8"));
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		if (defaultModel.defaultProvider) {
			settings.defaultProvider = defaultModel.defaultProvider;
		}
		if (defaultModel.defaultModel) {
			settings.defaultModel = defaultModel.defaultModel;
		}
		const merged = join(scratch, "settings-with-default.json");
		writeFileSync(merged, `${JSON.stringify(settings, null, 2)}\n`);
		copyFileSync(merged, settingsPath);
		logInfo("settings.json updated with default model config", {
			path: settingsPath,
		});
	} else {
		logWarn("pi generator produced no default-model overlay");
	}
}

currentStage = "models-install";

// --- install models.json into the agent dir --------------------------------
// d063 §3: a successful generation ALWAYS emits providers (the local
// llama-swap layer plus the pi-native cloud rows at proxy routes), so an
// empty map is a broken generation — neither installing it nor keeping a
// stale direct-routing one is acceptable. Fail instead (SKIP_GEN=1 never
// reaches here with an empty committed file — the warn below is its own
// missing-file path).
if (modelsOut) {
	const count = Object.keys(providersOf(modelsOut)).length;
	if (count === 0) {
		logError("0 providers generated — refusing to install (docs/d063)", {
			action: "abort",
			modelsJson: modelsOut,
		});
		process.exit(1);
	} else {
		if (existsSync(join(agentDir, "models.json"))) {
			copyFileSync(
				join(agentDir, "models.json"),
				`${join(agentDir, "models.json")}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`,
			);
		}
		copyFileSync(modelsOut, join(agentDir, "models.json"));
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
			refreshCommittedSnapshot(modelsOut, scratch);
		}
	}
} else if (
	!existsSync(join(agentDir, "models.json")) &&
	existsSync(join(scriptDir, "models.json"))
) {
	copyFileSync(join(scriptDir, "models.json"), join(agentDir, "models.json"));
	logInfo("nothing generated; installed committed models.json", {
		path: join(agentDir, "models.json"),
	});
}

currentStage = "opencode-config";

// --- opencode config --------------------------------------------------------
// Upstream generates the peer-mode provider overlay when asked. The consumer
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
// (docs/d054, docs/d065): generate into a SCRATCH copy of the committed
// overlay — that copy is also the d064 stale-preserve input
// previousLocalProvider reads — and on success install BOTH the host config
// dir (the dir run.sh mounts rw into the sandbox) and this dir's committed
// opencode.jsonc. The committed copy is not a SKIP_GEN fallback (opencode
// has no SKIP_GEN path, docs/d065): it is the reviewed git diff and the next
// run's stale-preserve input, so it refreshes on every host that runs this
// stage, Termux included. Termux skips the stage entirely (pi-only path)
// unless OPENCODE_CONFIG_DIR is set.
const ocHostDir =
	process.env.OPENCODE_CONFIG_DIR ??
	join(
		process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
		"opencode",
	);
let ocOut = "";
if (!termux || process.env.OPENCODE_CONFIG_DIR) {
	ocOut = join(scratch, "opencode.json");
	const ocCommitted = join(scriptDir, "opencode.jsonc");
	if (existsSync(ocCommitted)) {
		copyFileSync(ocCommitted, ocOut);
	}
}
if (ocOut && existsSync(join(scratch, "generate-opencode.mjs"))) {
	// d063 fail closed, same as the pi generator above: a half-written
	// overlay would leave direct baseUrls in the committed opencode.jsonc.
	if (!runStage(join(scratch, "generate-opencode.mjs"), [ocOut])) {
		logError("opencode generator failed — aborting (nothing written)", {
			script: "generate-opencode.mjs",
		});
		process.exit(1);
	}

	// Install 1 — the host config dir, the sandbox's mount source (d065).
	// Best-effort .bak insurance, same as the settings/models installs above:
	// generated ephemeral files, not a preservation contract.
	mkdirSync(ocHostDir, { recursive: true });
	const ocHost = join(ocHostDir, "opencode.json");
	if (existsSync(ocHost)) {
		copyFileSync(
			ocHost,
			`${ocHost}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`,
		);
	}
	copyFileSync(ocOut, ocHost);
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

rmSync(scratch, { recursive: true, force: true });
logInfo("done", { agentDir });
