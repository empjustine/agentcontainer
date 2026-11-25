/**
 * @fileoverview run.mjs — coding-agent launcher: ALWAYS the container sandbox
 * (docs/d059). A host with no podman/docker has no sandbox to launch, so there
 * is nothing here to fall back to — run pi itself under the same chain
 * instead: `./environment.sh pi`.
 *
 * The environment is loaded EXPLICITLY, before this launcher runs:
 *
 *   ./environment.sh ./node-run.sh coding-agent/run.mjs
 *
 * That chain (./environment.sh — the ONE infisical round-trip, on the host,
 * outside any sandbox) injects the vault into plain environment variables;
 * this launcher consumes env only — it never loads, fetches or caches secrets
 * itself, and the host login state never leaves the host.
 *
 * RUNNERS NEVER BUILD OR GENERATE (docs/d041): this launcher serves the host
 * harness dirs as they are — the pi agent dir and the host opencode config dir,
 * both mounted as-is — refreshed by `./npm-run.sh coding-agent generate`,
 * which forwards the vault env themselves. It also GATES NOTHING in them
 * (docs/d227): each harness starts on its own defaults plus whatever config it
 * finds, so an absent, empty or hand-edited artifact is a partial config, never
 * a refusal and never an implicit regeneration. The generator tree is
 * deliberately NOT mounted (docs/d056): an in-container session cannot
 * regenerate.
 *
 * ARGV: [DIRECTORY [DIRECTORY...]]
 *   Each DIRECTORY is a host directory exposed INSIDE the container at its own
 *   path, read-write — a home-relative path at the CONTAINER's home spelling
 *   (docs/d068), because a host home may sit behind a symlink. CWD is the
 *   implicit first DIRECTORY, so extra arguments ADD mounts without restating
 *   the workdir; the first directory is also the container workdir.
 *   `./node-run.sh coding-agent/run.mjs ~/Downloads/references` is the whole replacement for the retired
 *   CODING_AGENT_REFERENCES toggle (docs/d043, docs/d056): the costly z,U
 *   relabel walk is paid only for a launch that names the mirror. A DIRECTORY
 *   resolving to $HOME is refused — HOME is host state and credentials, not a
 *   workspace.
 *
 * The launch (podman/docker required, via lib/workload-runtime.mjs):
 *   - rw-mount the HOST agent dir (PI_CODING_AGENT_DIR) directly — no per-run
 *     config copy, so the generator's install target, the host pi, and the
 *     sandboxed pi are one directory
 *   - rw-mount every other harness state dir where the HOST keeps it, at the
 *     CONTAINER's own default path for it (docs/d216): pi's sessions are the
 *     agent dir's sessions/ child, opencode's config and data dirs, Cline's
 *     ~/.cline and ThinkRail's ~/.thinkrail. No ~/workspace stage, no env
 *     pin: each harness finds its state where it looks by default, and the
 *     host harness reads the same directory
 *   - NO repo file rides along (docs/d067): with no env pins there is nothing
 *     to export, so the command is the image's own default shell — no
 *     generated launch script and no logger mount
 *   - the host HF cache is NOT mounted (docs/d066): the old binding was
 *     unconditional and unguarded, and its relabel cost scaled with the model
 *     store. A run that wants it names it as a DIRECTORY
 *   - forward the (already-loaded) vault env through the workload_env
 *     allowlist; the spawn chain inside the container is plain interactive
 *     bash with no infisical at all
 *
 * There is deliberately no second (host-native) branch: without podman/docker
 * this launcher refuses BEFORE creating anything and names the sandbox-free path
 * above.
 *
 * WHY the argv is a PURE function of (ARGV, env): the sh predecessor built the
 * same launch by mutating globals across 380 lines and shelling out to jq, so
 * the only way to assert what it handed podman was to run the whole thing
 * against a stub backend. `buildLaunch()` returns the description document
 * without spawning or reading anything, and tests/check-run-dirs.test.mjs
 * renders THAT — the mount manifest, the two-sided DIRECTORY spelling and the
 * workdir are then ordinary assertions (docs/d068, docs/d069).
 *
 * Env overrides — each names the HOST dir; the sandbox always sees the
 * CONTAINER's own default path, so a host override never leaks into the guest
 * contract (docs/d216):
 *   PI_CODING_AGENT_DIR  pi's agent/config dir (default ~/.pi/agent) — also
 *                    the var pi itself reads, so the generator's install target
 *                    and pi's config source are the same path by construction.
 *                    Mounted rw (docs/d054); its sessions/ child is pi's
 *                    session store, so cross-run /resume now works and
 *                    PI_CODING_AGENT_SESSION_DIR is deliberately not read: the
 *                    sandbox mounts one agent dir, not a second store
 *   OPENCODE_CONFIG_DIR  opencode's config dir (default the XDG config root's
 *                    opencode/ — upstream's own knob and the generator's
 *                    install target), mounted rw (docs/d065). A missing
 *                    opencode.json there is a tolerated partial config
 *   XDG_CONFIG_HOME, XDG_DATA_HOME  the host's XDG roots: only the HOST side of
 *                    a mount follows them
 *   CLINE_DIR  Cline's dir (default ~/.cline), mounted rw
 *   THINKRAIL_DATA_DIR  ThinkRail's data dir (default ~/.thinkrail), mounted rw
 *
 * Exit codes (wrappers and docs quote them). Each rides on a thrown `failure`
 * and is set by the one handler (docs/d225):
 *   90 a DIRECTORY is unusable or is $HOME · 91 no backend / required mount
 *   source gone · 92 the description does not render
 *
 * 93 — auth.json holds credentials — retired with the credential gate, and 94 —
 * a generated artifact missing or stale — with the artifact gate (docs/d227): a
 * launch has no status to report about mounted config content, and a credential
 * file in an RW-mounted harness dir is the exposure the forwarded env already
 * carries.
 */

import { mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { baseUrlEnvName } from "./lib/cloud-providers.mjs";
import { exitCodeOf, failure } from "./lib/failure.mjs";
import { logError, logInfo, logWarn, setLogTool } from "./lib/log.mjs";
import {
	detectBackend,
	emptyDescription,
	hostFs,
	WorkloadDescriptionError,
	workload_cmd,
	workload_env_allowlist,
	workload_image,
	workload_init,
	workload_interactive,
	workload_name,
	workload_network,
	workload_run,
	workload_rw,
	workload_user,
	workload_workdir,
} from "./lib/workload-runtime.mjs";

/** @typedef {import("./lib/workload-runtime.mjs").Host} Host */
/** @typedef {import("./lib/workload-runtime.mjs").WorkloadDescription} WorkloadDescription */

const image = "localhost/empjustine/coding-agent:latest";

/** Exit codes are part of the launcher's contract (see the file overview). */
const EXIT_DIRECTORY = 90;
const EXIT_BACKEND = 91;
const EXIT_RENDER = 92;

/**
 * Every provider key env the sandbox's harnesses read. Only non-empty values are
 * forwarded (workload_env_allowlist), so a key absent from the vault simply does
 * not appear — an omission here looks exactly like a vault problem, because a
 * host-empty var is dropped rather than passed empty.
 *
 * This list is a FOURTH place a provider's key env name has to appear (the
 * catalog `env`, lib/cloud-providers.json's apiKeyEnv, the pi generator spec's
 * envKey, and here) — docs/d032 F6. Add the name here whenever a provider row
 * lands in the fact table. A missing name has two silent shapes, both measured:
 * the generated models.json's "$<KEY>" reference starves inside the container,
 * and a pi package registering `apiKey: "$<KEY>"` never reaches its own
 * `refreshModels` network phase — pi resolves the key FIRST, so the refresh
 * records "Failed to resolve API key … <KEY>" and the model selector reports
 * "Could not refresh <provider>" while no request ever leaves the sandbox.
 *
 * NEURALWATT_API_KEY is the one row with no fact-table entry: it belongs to the
 * pi-neuralwatt-provider package alone, so no derivation reaches it.
 * @type {readonly string[]}
 */
const providerKeyEnv = Object.freeze([
	"CLINE_API_KEY",
	"MISTRAL_API_KEY",
	"TLALOCAYOTL_API_KEY",
	"OPENROUTER_API_KEY",
	"OPENCODE_API_KEY",
	"HYPER_API_KEY",
	"INFERX_API_KEY",
	"VERBOO_API_KEY",
	"SYNTHETIC_API_KEY",
	"GEMINI_API_KEY",
	"NVIDIA_API_KEY",
	"NEURALWATT_API_KEY",
]);

/**
 * Each row's `<X>_BASE_URL` sibling forwards with its key, DERIVED by the one
 * naming rule (the Azure spelling `baseUrlEnvName` applies for the generator),
 * never a second list. The generated artifacts bake their URL at generate time,
 * so the pi provider packages are this override's runtime reader
 * (`baseUrlFromEnv` in every pi-* folder): an operator retargeting a provider
 * has to reach them. Deriving it for every key rather than picking the
 * extension-backed rows keeps one rule — a hand-picked subset is a list to
 * forget to extend, which is the failure this allowlist already has a history of.
 * @type {readonly string[]}
 */
const providerBaseUrlEnv = Object.freeze(
	providerKeyEnv.map(baseUrlEnvName).filter((name) => name !== null),
);

/**
 * The names forwarded INTO the sandbox: every provider key with its base-url
 * sibling above, the pi packages' own catalog override, the Hugging Face token,
 * and the proxy routing below.
 *
 * The proxy vars are routing, not secrets (docs/d074): forwarded so the image's
 * NODE_USE_ENV_PROXY=1 has something to honor — node's native fetch/http proxy
 * support reads HTTP(S)_PROXY / NO_PROXY (upper- and lowercase) at startup.
 * ALL_PROXY rides for the NON-node harnesses in this image (docs/d074): python
 * (requests/urllib3) and rust (reqwest) read it natively, go reads only the
 * HTTP(S)_PROXY spelling — dropping it at this boundary made the relay's SOCKS
 * spelling silently unreachable inside the sandbox. NODE_USE_ENV_PROXY
 * forwards as well so a host chain (estige's `proxy-env`, docs/d120) can
 * override the image's ENV default instead of losing to it, and REVERSE_PROXY_*
 * stays out on purpose: only the generator consumes it (docs/d063, docs/d070),
 * and the generator does not run in here (docs/d056).
 *
 * NODE_USE_ENV_PROXY arrives from ./node-run.sh, which pins it to 1 for this
 * process, so it is forwarded even when the host did not export it — the same
 * value the image's ENV already defaults to.
 */
export const vaultEnv = [
	...providerKeyEnv,
	...providerBaseUrlEnv,
	"HF_TOKEN",
	// pi-cline-pass-provider reads this at runtime: a host that pins the docs table
	// instead of fetching it must reach the sandboxed extension too, with the
	// pinned file arriving through the DIRECTORY mounts.
	"CLINE_PASS_MDX",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NODE_USE_ENV_PROXY",
];

/**
 * @typedef {object} Directory
 * @property {string} host canonical host path — what the dedupe and the $HOME
 *   refusal compare, and what the MOUNT carries (docs/d068)
 * @property {string} guest container spelling — the image's home for a
 *   home-relative directory, the host path otherwise
 */

/**
 * The whole launch as a value: no container was started and nothing on disk was
 * touched. `main` is the only thing that turns this into effects.
 * @typedef {object} Launch
 * @property {string} containerName
 * @property {string} user image user; also the container home's last segment
 * @property {Directory[]} directories resolved DIRECTORY list, CWD first
 * @property {string} workdir container spelling of the first DIRECTORY
 * @property {string} agentDir host pi agent dir (mounted rw)
 * @property {string} opencodeConfigDir host opencode config dir (mounted rw)
 * @property {string} opencodeDataDir host opencode data dir (mounted rw)
 * @property {string} clineDir host Cline dir (mounted rw)
 * @property {string} thinkrailDir host ThinkRail data dir (mounted rw)
 * @property {WorkloadDescription} workload the description the runner renders
 */

/**
 * @param {number} value
 * @param {number} [width]
 * @returns {string}
 */
function pad(value, width = 2) {
	return String(value).padStart(width, "0");
}

/**
 * `agentcontainer-<YYYYMMDDhhmmssmmm>` — the per-run container name. Collision
 * within one millisecond is not a concern (a second launch that fast would
 * fight over the same mounts anyway).
 * @param {Date} [now]
 * @returns {string}
 */
function containerName(now = new Date()) {
	return `agentcontainer-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
}

/**
 * Container-side spelling of a host path (docs/d068). WHY the two sides are
 * spelled differently: a host home can sit behind a symlink (Bazzite / Fedora
 * Atomic: /home -> /var/home), so the canonical spelling of every
 * home-relative path is /var/home/... while the image gives the user
 * /home/$USER as `~`. Mounting at the canonical path would park the directory
 * exactly where a session does NOT look for it.
 * @param {string} hostPath
 * @param {string} hostHome canonical host home
 * @param {string} containerHome
 * @returns {string}
 */
function guestPath(hostPath, hostHome, containerHome) {
	if (hostPath === hostHome) {
		return containerHome;
	}
	return hostPath.startsWith(`${hostHome}/`)
		? `${containerHome}${hostPath.slice(hostHome.length)}`
		: hostPath;
}

/**
 * The value a DIRECTORY list resolves against — one object because every field
 * is a fact about the host the launch runs on, and the pure `buildLaunch` hands
 * the same ones to each resolution step.
 * @typedef {object} DirectoryContext
 * @property {readonly string[]} argv the operator's DIRECTORY words
 * @property {string} cwd where the launcher was started
 * @property {string} hostHome canonical host home
 * @property {string} containerHome
 * @property {Host} host
 */

/**
 * Resolve the DIRECTORY list: CWD implicit and first, every entry canonical on
 * the host side, deduped in order, $HOME refused. There is no separate
 * workspace argument (docs/d056) — the first entry IS the workdir.
 * @param {DirectoryContext} context
 * @returns {Directory[]}
 */
function resolveDirectories({
	argv,
	cwd,
	hostHome,
	containerHome,
	host,
}) {
	/** @type {Directory[]} */
	const directories = [];
	const seen = new Set();
	for (const arg of [cwd, ...argv]) {
		const resolved = host.canonicalDirectory(arg);
		if (resolved === null) {
			throw failure("DIRECTORY is not a directory", EXIT_DIRECTORY, {
				dir: arg,
			});
		}
		if (resolved === hostHome) {
			throw failure("refusing to expose HOME as a DIRECTORY", EXIT_DIRECTORY, {
				dir: resolved,
			});
		}
		if (seen.has(resolved)) {
			continue;
		}
		seen.add(resolved);
		directories.push({
			host: resolved,
			guest: guestPath(resolved, hostHome, containerHome),
		});
	}
	return directories;
}

/**
 * Assemble the whole launch. Pure: no spawn, no filesystem writes, no mkdir —
 * every host fact comes through the injected Host port, so the tests can render
 * the same description against a fixture host.
 * @param {readonly string[]} argv the DIRECTORY arguments
 * @param {Record<string, string | undefined>} env the host environment
 * @param {Host} [host]
 * @param {string} [cwd] where the launcher was started (a host fact tests set)
 * @returns {Launch}
 */
export function buildLaunch(argv, env, host = hostFs, cwd = process.cwd()) {
	const home = env.HOME ?? "";
	const hostHome = host.canonicalDirectory(home) ?? home;
	const user = env.USER || userInfo().username;
	const containerHome = `/home/${user}`;
	const directories = resolveDirectories({
		argv,
		cwd,
		hostHome,
		containerHome,
		host,
	});
	const workdir = directories[0]?.guest ?? containerHome;

	const name = containerName();
	// Every harness state dir below is the HOST's real dir, mounted at the
	// CONTAINER's own default path for it (docs/d216). This is the move
	// docs/d054 made for pi's agent dir and docs/d065 for opencode's config dir,
	// applied to the harness dirs that were still staged per run: no
	// ~/workspace stage, and no env pin, because the harness already looks where
	// the mount lands and the host harness reads the same directory.
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
	// pi's sessions are <agentDir>/sessions by default — inside the mount above.
	// PI_CODING_AGENT_SESSION_DIR is therefore NOT read: a second store would be
	// a second mount for state the agent dir already carries (docs/d216).
	const opencodeConfigDir =
		env.OPENCODE_CONFIG_DIR ??
		join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode");
	// opencode has no data-dir knob (docs/d065), so the mount at its XDG default
	// IS the pin. The HOST side follows the host's XDG_DATA_HOME; the GUEST side
	// stays the container default, which is the path opencode reads.
	const opencodeDataDir = join(
		env.XDG_DATA_HOME ?? join(home, ".local", "share"),
		"opencode",
	);
	const clineDir = env.CLINE_DIR ?? join(home, ".cline");
	const thinkrailDir = env.THINKRAIL_DATA_DIR ?? join(home, ".thinkrail");

	let workload = baseWorkload(name);
	for (const directory of directories) {
		// Each DIRECTORY is exposed rw at its guest target. Beware the cost the
		// retired references toggle used to hide: every mount carries podman's
		// z,U (lib/workload-runtime.mjs render), which RECURSIVELY relabels+idmaps
		// the source on each launch — ~39 s for a 1.66M-file mirror.
		workload = workload_rw(workload, directory.host, directory.guest);
	}
	for (const [hostDir, guestDir] of /** @type {[string, string][]} */ ([
		[agentDir, join(containerHome, ".pi", "agent")],
		[opencodeConfigDir, join(containerHome, ".config", "opencode")],
		[opencodeDataDir, join(containerHome, ".local", "share", "opencode")],
		[clineDir, join(containerHome, ".cline")],
		[thinkrailDir, join(containerHome, ".thinkrail")],
	])) {
		workload = workload_rw(workload, hostDir, guestDir);
	}
	workload = workload_workdir(workload, workdir);
	// Secrets! The host-side loader (./environment.sh — the launcher is exec'd
	// through it) put the vault keys in THIS process's environment; the
	// allowlist forwards them into the sandbox like the llm-local-inference run
	// path (only non-empty values are forwarded). The host HF cache is
	// deliberately NOT mounted (docs/d066): the old binding was unconditional and
	// existence-unguarded while its z,U walk relabels the entire model store on
	// every launch — the exact cost the ARGV manifest exists to make opt-in. The
	// image ships its own empty, ephemeral ~/.cache/huggingface/hub, so hf still
	// works in-container, and a launch that wants the warm host cache names it
	// as a DIRECTORY (it lands at the path hf reads by default, docs/d068).
	workload = workload_env_allowlist(workload, vaultEnv, env);
	// No launch script (docs/d067): with every mount on the harness's own
	// default path there is nothing to export, and the image already defaults to
	// bash. --init supplies the reaping init a bare shell loses.
	workload = workload_cmd(workload, "/usr/bin/bash");

	return {
		containerName: name,
		user,
		directories,
		workdir,
		agentDir,
		opencodeConfigDir,
		opencodeDataDir,
		clineDir,
		thinkrailDir,
		workload,
	};
}

/**
 * Everything about the WORKLOAD that does not depend on a resolved directory:
 * name, image, mode, network and the user mapping.
 * @param {string} name
 * @returns {WorkloadDescription}
 */
function baseWorkload(name) {
	let description = emptyDescription();
	description = workload_name(description, name);
	description = workload_image(description, image);
	description = workload_interactive(description);
	description = workload_init(description);
	description = workload_network(description, "host");
	// workload_hardening() is deliberately NOT called (docs/d067): its
	// --cap-drop=all --security-opt no-new-privileges pair makes the image's
	// setuid sudo dead (NOPASSWD:ALL, Containerfile), which is how the agent
	// installs a system package at runtime. The other two runners are
	// single-purpose servers with no escalation hatch, and both harden.
	return workload_user(description);
}

/**
 * The host state dirs a launch mounts. `ensureHostState` creates them.
 * @param {Launch} launch
 * @returns {string[]}
 */
function hostStateDirs(launch) {
	return [
		launch.agentDir,
		launch.opencodeConfigDir,
		launch.opencodeDataDir,
		launch.clineDir,
		launch.thinkrailDir,
	];
}

/**
 * Files the sandbox can now read because the harness dir is mounted directly
 * (docs/d216), carrying credentials instead of the config this launcher knows:
 * Cline's providers.json and ThinkRail's installation/environment documents. A
 * warning, not a stop — they are the operator's files, and the mount decision
 * is the one being reported (auth.json left this list with its abort; docs/d227's
 * amendment).
 * @param {Launch} launch
 * @returns {string[]}
 */
function credentialWarnings(launch) {
	return [
		join(launch.clineDir, "data", "settings", "providers.json"),
		join(launch.thinkrailDir, "installation.json"),
		join(launch.thinkrailDir, "environment.json"),
	].filter((file) => hostFs.exists(file));
}

/**
 * @returns {Promise<void>}
 */
async function main() {
	setLogTool("coding-agent/run");
	// The launch is argv assembly; each check below is a guard that owns its own
	// stop or report (docs/d225). No check reads the mounted config's CONTENT —
	// the artifact gate that did (settings/models/mcp existence plus the
	// canonical-URL re-check) is retired: mounted config is host state the
	// harnesses tolerate, and validating it refused launches for files pi
	// itself accepts (docs/d227). The credential file gate went the same way
	// (d227's amendment) — a populated auth.json is the exposure the forwarded
	// env keys already carry.
	const launch = buildLaunch(process.argv.slice(2), process.env);
	const backend = requireBackend();
	ensureHostState(launch);
	warnCredentialFiles(launch);
	logInfo("mounting host harness state", {
		container: launch.containerName,
		dirs: hostStateDirs(launch).length,
	});
	warnMissingOpencodeConfig(launch);
	requireMountSources(launch.workload);

	// Everything above this line is host-side argv assembly; the next call is
	// where podman creates the container — mount relabel, userns setup and image
	// probes all happen there. Nothing logs from inside any more (docs/d067), so
	// this line IS the launch marker: the next thing on the terminal is the
	// sandbox's own bash prompt.
	logInfo("starting container", { container: launch.containerName });
	// The container's status is the launcher's status (docs/d225 R5): assigning
	// it lets the call stack unwind instead of tearing the process down here.
	process.exitCode = await launchWorkload(launch.workload, backend);
}

/**
 * The host must have a container backend. It is resolved BEFORE anything is
 * created or written, so a backend-less host is left with nothing half-built
 * and is pointed at the sandbox-free run path (docs/d059).
 * @returns {import("./lib/workload-runtime.mjs").Backend}
 * @throws {Error} exit 91 when neither podman nor docker is on PATH
 */
function requireBackend() {
	const backend = detectBackend(hostFs);
	if (backend === null) {
		throw failure(
			"no workload backend available (need podman or docker) — no sandbox here; run pi directly: ./environment.sh pi",
			EXIT_BACKEND,
		);
	}
	return backend;
}

/**
 * Create the harness state dirs once, before any gate reads them, so a first
 * run on a fresh host does not refuse for a missing dir.
 * @param {Launch} launch
 * @returns {void}
 */
function ensureHostState(launch) {
	for (const dir of hostStateDirs(launch)) {
		mkdirSync(dir, { recursive: true });
	}
}

/**
 * Report the credential-shaped files the direct mounts expose (docs/d216). A
 * warning, not a stop: these are the operator's files, and the mount decision
 * is the one being reported.
 * @param {Launch} launch
 * @returns {void}
 */
function warnCredentialFiles(launch) {
	for (const file of credentialWarnings(launch)) {
		logWarn(
			"host credential-shaped file is readable in the sandbox (docs/d216)",
			{ file },
		);
	}
}

/**
 * The only config file whose absence still earns a line at launch: a missing
 * opencode overlay costs the provider reroute the generator installed, and
 * nothing else is lost (d065's partial-config rule, now the whole launcher's
 * shape — docs/d227). Pi's artifacts get no equivalent warning because pi
 * starts on its bundled catalog plus whatever it finds; a hand-edited
 * `models.json` is the operator's file, not a launch input to validate.
 * SKIP_GEN (the committed-artifact install path) is retired with d070 §6: the
 * overlay is a generate-time artifact, and regeneration is the only fix.
 * @param {Launch} launch
 * @returns {void}
 */
function warnMissingOpencodeConfig(launch) {
	if (hostFs.exists(join(launch.opencodeConfigDir, "opencode.json"))) {
		return;
	}
	logWarn(
		"no opencode.json in the host config dir — opencode launches on built-in (partial) config; run `./npm-run.sh coding-agent generate` to install",
		{ configDir: launch.opencodeConfigDir },
	);
}

/**
 * No required mount may point at a host path that is gone: the container would
 * be created and the bind fail after the fact. The sh API aborted at its
 * workload_rw call (exit 91) and this is the same refusal, checked once over
 * the assembled description.
 * @param {WorkloadDescription} workload
 * @returns {void}
 * @throws {Error} exit 91 naming the first missing mount
 */
function requireMountSources(workload) {
	const missing = workload.mounts.find(
		(mount) => mount.required && !hostFs.exists(mount.host),
	);
	if (missing) {
		throw failure("required mount source is gone", EXIT_BACKEND, {
			mount: missing.host,
		});
	}
}

/**
 * Run the container and map a render/spawn failure onto the launcher's codes.
 * A description that does not render is a launcher bug (exit 92, the sh API's
 * render code); a backend that cannot be spawned is the environment's (91).
 * @param {WorkloadDescription} workload
 * @param {import("./lib/workload-runtime.mjs").Backend} backend
 * @returns {Promise<number>} the container's status
 * @throws {Error} exit 92 or 91
 */
async function launchWorkload(workload, backend) {
	try {
		return await workload_run(workload, { backend, env: process.env });
	} catch (error) {
		const unrenderable = error instanceof WorkloadDescriptionError;
		throw failure(
			unrenderable
				? "cannot render the workload description"
				: "cannot launch the workload backend",
			unrenderable ? EXIT_RENDER : EXIT_BACKEND,
			{
				backend: backend.tool,
				cause: /** @type {Error} */ (error).message,
			},
		);
	}
}

// `import.meta.main` (node >= 24.2; this repo runs 24.22) replaces a
// `process.argv[1] === fileURLToPath(import.meta.url)` comparison that was
// false whenever the entry was invoked by an absolute path spelled through a
// symlink: node realpaths `import.meta.url` but keeps argv[1]'s spelling, so
// main() never ran and the process exited 0 with no output at all — the
// Bazzite /home -> /var/home shape, an IDE task, any absolute argv.
if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		// The one handler (docs/d225 R3): log the refusal once, set the status,
		// return.
		const refused =
			/** @type {Error & { fields?: Record<string, unknown> }} */ (error);
		const exitCode = exitCodeOf(error);
		if (exitCode === undefined) {
			logError("launcher failed", { error: String(refused?.stack ?? refused) });
			process.exitCode = 1;
		} else {
			logError(refused.message, refused.fields ?? {});
			process.exitCode = exitCode;
		}
	}
}
