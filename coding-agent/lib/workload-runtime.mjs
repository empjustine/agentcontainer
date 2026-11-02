/**
 * @fileoverview workload-runtime.mjs — the description-driven workload runner
 * for this unit's launchers (docs/container-tooling.md owns the API contract).
 *
 * The description is ONE in-memory object here, where its shell predecessor
 * had two halves — scalars in globals and lists in a JSON string passed through
 * six jq filters. That split existed for one reason: POSIX sh cannot hold an
 * array safely (the old `eval`-emulated arrays and space-joined strings were
 * word-split at render time, a bash/dash behaviour zsh does not share). JS has
 * arrays, so the split, the per-mutator jq subprocess, and the two jq
 * invocation hazards the filter headers warned about all disappear
 * structurally: no shell quoting, no `--args --` option-parsing trap, no
 * `-n` stdin trap. jq stops being a host prerequisite for this unit at all.
 *
 * Two shapes are still contract, not implementation detail:
 *
 * - **`render()` output order** is byte-for-byte what `workload-render.jq`
 *   emitted (`container run` is order-insensitive, but the argv is captured by
 *   tests and appears in `ps`, so it is asserted, not incidental):
 *   --init, mode flag, --restart, --name, --network, --entrypoint, --user
 *   (+ rootless podman extras), --publish, --device, hardening, -v mounts,
 *   --env, --workdir, image, cmd.
 * - **Empty string means "not set"**: an unset scalar emits no flag, never an
 *   empty one (a bare `--env NAME` is different — it forwards the host value).
 *
 * The six `workload-*.jq` filters and `workload-runtime.sh` were retired with
 * this port; `estige/` and `llm-local-inference/` keep their own sh + jq copies
 * until those units move (docs/d113: a folder is the copy unit).
 *
 * Filesystem and PATH facts arrive through the `Host` port so the description
 * API and the launcher's argv assembly stay testable without a container
 * backend (docs/d069: the backend is resolved through PATH because that is how
 * it is later INVOKED).
 */

import { spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, join } from "node:path";

/**
 * @typedef {"ro" | "rw"} MountMode
 * @typedef {{ mode: MountMode, host: string, guest: string, required: boolean }} Mount
 * @typedef {{ host: string, guest: string }} Port
 */

/**
 * The workload description. Scalars are strings with "" meaning "omit the
 * flag"; `user`, `init` and `hardening` are 0/1 flags.
 * @typedef {object} WorkloadDescription
 * @property {string} name container/instance name
 * @property {string} image OCI image
 * @property {"" | "detach" | "interactive"} mode
 * @property {string} network
 * @property {string} restart restart policy; "" emits no flag
 * @property {boolean} init pass `--init`
 * @property {boolean} user run as the invoking uid:gid (plus the rootless
 *   podman extras the backend carries)
 * @property {boolean} hardening `--cap-drop=all --security-opt no-new-privileges`
 * @property {string} entrypoint
 * @property {string} workdir
 * @property {Mount[]} mounts in declaration order — the order the argv carries
 * @property {string[]} env host variable NAMES to forward
 * @property {Port[]} ports
 * @property {string[]} devices host device paths to pass through
 * @property {string[]} cmd argv after the image
 */

/**
 * @typedef {object} Backend
 * @property {"podman" | "docker"} tool
 * @property {string[]} userns extra words for `workload_user` (podman's
 *   `--userns=keep-id`; docker has none)
 * @property {string[]} keepGroups extra words for `workload_user` (podman's
 *   `--group-add keep-groups`)
 */

/**
 * Every host fact the runner needs, as one injectable port: the description
 * API and the launcher's directory resolution are then pure functions of their
 * arguments, which is what lets the tests assert rendered argv with no
 * container backend and no real directory tree.
 * @typedef {object} Host
 * @property {(name: string) => string | null} findOnPath resolved path of an
 *   executable on PATH, or null. Same probe the launch uses — a backend found
 *   here is one that can actually be executed (docs/d069).
 * @property {(path: string) => boolean} exists
 * @property {(path: string) => string[]} readdir names under a directory, []
 *   when it cannot be read
 * @property {(path: string) => string | null} canonicalDirectory the canonical
 *   (symlink-resolved) absolute path when `path` names a directory, else null.
 *   The host side of every mount is spelled this way (docs/d068).
 */

/** @type {Host} */
export const hostFs = {
	findOnPath(name) {
		for (const dir of (process.env.PATH ?? "").split(delimiter)) {
			if (!dir) {
				continue;
			}
			const candidate = join(dir, name);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// not here — keep scanning; the last miss is the answer
			}
		}
		return null;
	},
	exists: (path) => existsSync(path),
	readdir(path) {
		try {
			return readdirSync(path);
		} catch {
			return [];
		}
	},
	canonicalDirectory(path) {
		try {
			const canonical = realpathSync(path);
			return statSync(canonical).isDirectory() ? canonical : null;
		} catch {
			return null;
		}
	},
};

/**
 * The empty description: nothing set, so `render` emits nothing but the image
 * (and even that is checked first — a description without an image is a
 * programming error, not a workload).
 * @returns {WorkloadDescription}
 */
export function emptyDescription() {
	return {
		name: "",
		image: "",
		mode: "",
		network: "",
		restart: "",
		init: false,
		user: false,
		hardening: false,
		entrypoint: "",
		workdir: "",
		mounts: [],
		env: [],
		ports: [],
		devices: [],
		cmd: [],
	};
}

/**
 * Backend detection, PATH-resolved (docs/d069). Returns null when neither
 * tool is executable — the caller owns the refusal (exit 91) because it knows
 * what the fallback is.
 * @param {Host} [host]
 * @returns {Backend | null}
 */
export function detectBackend(host = hostFs) {
	if (host.findOnPath("podman")) {
		return {
			tool: "podman",
			userns: ["--userns=keep-id"],
			keepGroups: ["--group-add", "keep-groups"],
		};
	}
	if (host.findOnPath("docker")) {
		return { tool: "docker", userns: [], keepGroups: [] };
	}
	return null;
}

/**
 * @param {WorkloadDescription} description
 * @param {string} name
 * @returns {WorkloadDescription}
 */
export function workload_name(description, name) {
	return { ...description, name };
}

/**
 * @param {WorkloadDescription} description
 * @param {string} image
 * @returns {WorkloadDescription}
 */
export function workload_image(description, image) {
	return { ...description, image };
}

/**
 * @param {WorkloadDescription} description
 * @returns {WorkloadDescription}
 */
export function workload_detach(description) {
	return { ...description, mode: "detach" };
}

/**
 * @param {WorkloadDescription} description
 * @returns {WorkloadDescription}
 */
export function workload_interactive(description) {
	return { ...description, mode: "interactive" };
}

/**
 * The restart policy earns its place because a crash-restart keeps a listener
 * address its consumer was handed alive (docs/d095) — only detached long-lived
 * services use it, and an unset policy emits no flag at all.
 * @param {WorkloadDescription} description
 * @param {string} policy
 * @returns {WorkloadDescription}
 */
export function workload_restart(description, policy) {
	return { ...description, restart: policy };
}

/**
 * @param {WorkloadDescription} description
 * @returns {WorkloadDescription}
 */
export function workload_init(description) {
	return { ...description, init: true };
}

/**
 * @param {WorkloadDescription} description
 * @param {string} network
 * @returns {WorkloadDescription}
 */
export function workload_network(description, network) {
	return { ...description, network };
}

/**
 * Run as the invoking user: rootless podman needs `--userns=keep-id` too, or
 * the container cannot write into its bind mounts as the real uid.
 * @param {WorkloadDescription} description
 * @returns {WorkloadDescription}
 */
export function workload_user(description) {
	return { ...description, user: true };
}

/**
 * `--cap-drop=all --security-opt no-new-privileges`. NOT for the coding-agent
 * sandbox, whose image needs its setuid sudo to install packages at runtime
 * (docs/d067) — the serving runners harden.
 * @param {WorkloadDescription} description
 * @returns {WorkloadDescription}
 */
export function workload_hardening(description) {
	return { ...description, hardening: true };
}

/**
 * @param {WorkloadDescription} description
 * @param {string} path
 * @returns {WorkloadDescription}
 */
export function workload_workdir(description, path) {
	return { ...description, workdir: path };
}

/**
 * @param {WorkloadDescription} description
 * @param {string} path
 * @returns {WorkloadDescription}
 */
export function workload_entrypoint(description, path) {
	return { ...description, entrypoint: path };
}

/**
 * `-p host:guest/tcp`; the `/tcp` convention lives in `render` (one place),
 * which is why the record keeps the two halves apart.
 * @param {WorkloadDescription} description
 * @param {string} hostPort
 * @param {string} guestPort
 * @returns {WorkloadDescription}
 */
export function workload_publish(description, hostPort, guestPort) {
	return {
		...description,
		ports: [...description.ports, { host: hostPort, guest: guestPort }],
	};
}

/**
 * Forward host env variable NAMES (a bare `--env NAME` takes the value from the
 * host at run time, so no value is ever written into argv).
 * @param {WorkloadDescription} description
 * @param {...string} names
 * @returns {WorkloadDescription}
 */
export function workload_env(description, ...names) {
	return { ...description, env: [...description.env, ...names] };
}

/**
 * Forward each named host variable ONLY when it holds a non-empty value. A bare
 * `--env NAME` on an unset host var injects an EMPTY value, which consumers
 * then read as "set" — every vault-key forwarder goes through this one
 * implementation instead of a pasted loop (docs/d030/d046).
 * @param {WorkloadDescription} description
 * @param {readonly string[]} names
 * @param {Record<string, string | undefined>} env
 * @returns {WorkloadDescription}
 */
export function workload_env_allowlist(description, names, env) {
	return workload_env(
		description,
		...names.filter((name) => (env[name] ?? "") !== ""),
	);
}

/**
 * SET the command (a container has one, so re-declaring it must not stack).
 * @param {WorkloadDescription} description
 * @param {...string} words
 * @returns {WorkloadDescription}
 */
export function workload_cmd(description, ...words) {
	return { ...description, cmd: words };
}

/**
 * @param {WorkloadDescription} description
 * @param {string} host
 * @param {string} guest
 * @returns {WorkloadDescription}
 */
export function workload_ro(description, host, guest) {
	return requiredMount(description, "ro", host, guest);
}

/**
 * @param {WorkloadDescription} description
 * @param {string} host
 * @param {string} guest
 * @returns {WorkloadDescription}
 */
export function workload_rw(description, host, guest) {
	return requiredMount(description, "rw", host, guest);
}

/**
 * Best-effort variant: a missing host path is simply not mounted.
 * @param {WorkloadDescription} description
 * @param {string} host
 * @param {string} guest
 * @param {Host} [hostFsPort]
 * @returns {WorkloadDescription}
 */
export function workload_ro_if(description, host, guest, hostFsPort = hostFs) {
	if (!hostFsPort.exists(host)) {
		return description;
	}
	return {
		...description,
		mounts: [
			...description.mounts,
			{ mode: "ro", host, guest, required: false },
		],
	};
}

/**
 * @param {WorkloadDescription} description
 * @param {MountMode} mode
 * @param {string} host
 * @param {string} guest
 * @returns {WorkloadDescription}
 */
function requiredMount(description, mode, host, guest) {
	// The sh API aborted the whole launch (exit 91) at THIS call when the host
	// path was gone. The requirement is recorded instead and checked once over
	// the assembled description (`missingMountHosts`): the same refusal, but the
	// description stays a plain value, buildable without touching the disk.
	return {
		...description,
		mounts: [...description.mounts, { mode, host, guest, required: true }],
	};
}

/**
 * The required mounts whose host path is gone — the launcher's exit-91 gate,
 * checked once before anything is created or launched.
 * @param {WorkloadDescription} description
 * @param {Host} [host]
 * @returns {Mount[]}
 */
export function missingMountHosts(description, host = hostFs) {
	return description.mounts.filter(
		(mount) => mount.required && !host.exists(mount.host),
	);
}

/**
 * Pass host device paths through (`--device PATH:PATH:rw`). The serving runners
 * declare these directly when the devices are not probe-able (a container build
 * host has no /dev/kfd), which is why this exists next to the GPU probe.
 * @param {WorkloadDescription} description
 * @param {...string} paths
 * @returns {WorkloadDescription}
 */
export function workload_devices(description, ...paths) {
	return { ...description, devices: [...description.devices, ...paths] };
}

/**
 * GPU passthrough: the dedicated inference devices a host actually has.
 * @param {Host} [host]
 * @returns {string[]}
 */
export function detectGpuDevs(host = hostFs) {
	const devices = [];
	if (host.exists("/dev/kfd")) {
		devices.push("/dev/kfd");
	}
	for (const entry of host.readdir("/dev/dri").sort()) {
		if (entry.startsWith("renderD")) {
			devices.push(`/dev/dri/${entry}`);
		}
	}
	return devices;
}

/**
 * @param {WorkloadDescription} description
 * @param {Host} [host]
 * @returns {WorkloadDescription}
 */
export function workload_gpu(description, host = hostFs) {
	return {
		...description,
		devices: [...description.devices, ...detectGpuDevs(host)],
	};
}

/**
 * Is a named array of the description non-empty? The callers that gate a whole
 * config layer on it (llm-local-inference) must not reach into the internals.
 * @param {WorkloadDescription} description
 * @param {string} field
 * @returns {boolean}
 */
export function workload_has(description, field) {
	const value = /** @type {Record<string, unknown>} */ (
		/** @type {unknown} */ (description)
	)[field];
	return Array.isArray(value) && value.length > 0;
}

/**
 * @typedef {object} RenderContext
 * @property {Backend} backend
 * @property {Record<string, string | undefined>} env the host environment the
 *   uid/gid fall back to (SUDO_UID/SUDO_GID win, as in the sh API)
 */

/**
 * A description that cannot become an argv at all — the launcher maps it to
 * exit 92, the sh API's render code. Only a launcher bug can produce one.
 */
export class WorkloadDescriptionError extends Error {
	/**
	 * @param {string} message
	 */
	constructor(message) {
		super(message);
		this.name = "WorkloadDescriptionError";
	}
}

/**
 * The `container run` flag words, in the pre-refactor order (see the file
 * overview). Pure: no spawn, no filesystem, no process state.
 * @param {WorkloadDescription} description
 * @param {RenderContext} context
 * @returns {string[]}
 */
export function render(description, context) {
	const { backend, env } = context;
	if (!description.image) {
		throw new WorkloadDescriptionError("workload description has no image");
	}
	const uid = env.SUDO_UID || String(process.getuid?.() ?? "");
	const gid = env.SUDO_GID || String(process.getgid?.() ?? "");
	// podman is rootless+SELinux here: "z,U" relabels AND chowns into the mapped
	// subuid, without which the host user loses files to a raw subuid.
	const mountOptions = backend.tool === "podman" ? "z,U" : "z";

	/** @type {string[]} */
	const words = [];
	if (description.init) {
		words.push("--init");
	}
	if (description.mode === "detach") {
		words.push("--detach");
	}
	if (description.mode === "interactive") {
		words.push("-it");
	}
	if (description.restart) {
		words.push(`--restart=${description.restart}`);
	}
	if (description.name) {
		words.push(`--name=${description.name}`);
	}
	if (description.network) {
		words.push(`--network=${description.network}`);
	}
	if (description.entrypoint) {
		words.push("--entrypoint", description.entrypoint);
	}
	if (description.user) {
		words.push(
			...backend.userns,
			"--user",
			`${uid}:${gid}`,
			...backend.keepGroups,
		);
	}
	for (const port of description.ports) {
		words.push("--publish", `${port.host}:${port.guest}/tcp`);
	}
	for (const device of description.devices) {
		words.push("--device", `${device}:${device}:rw`);
	}
	if (description.hardening) {
		words.push("--cap-drop=all", "--security-opt", "no-new-privileges");
	}
	for (const mount of description.mounts) {
		words.push(
			"-v",
			`${mount.host}:${mount.guest}:${mountOptions}${mount.mode === "ro" ? ",ro" : ""}`,
		);
	}
	for (const name of description.env) {
		words.push("--env", name);
	}
	if (description.workdir) {
		words.push("--workdir", description.workdir);
	}
	words.push(description.image, ...description.cmd);
	return words;
}

/**
 * The whole launch argv, tool included — what the tests capture and what `ps`
 * shows.
 * @param {WorkloadDescription} description
 * @param {RenderContext} context
 * @returns {string[]}
 */
export function containerRunArgv(description, context) {
	return [
		context.backend.tool,
		"container",
		"run",
		...render(description, context),
	];
}

/**
 * @param {string | null} signal
 * @returns {number}
 */
function signalExitCode(signal) {
	const signum =
		signal === null
			? undefined
			: /** @type {Record<string, number>} */ (osConstants.signals)[signal];
	// 128+N is the shell convention a wrapper chain expects to see.
	return signum === undefined ? 1 : 128 + signum;
}

/**
 * Render and launch. `wrapper` words (if any) prefix the launch ON THE HOST,
 * so they cannot inject env into the workload — secrets reach it only through
 * the `workload_env` allowlist (docs/d046).
 * @param {WorkloadDescription} description
 * @param {RenderContext & { wrapper?: string[] }} context
 * @returns {Promise<number>} the launch's exit status
 */
export async function workload_run(description, context) {
	const argv = containerRunArgv(description, context);
	const wrapper = context.wrapper ?? [];
	const [command, ...rest] = [...wrapper, ...argv];
	if (!command) {
		throw new Error("workload_run: empty argv");
	}
	return await new Promise((resolve, reject) => {
		const child = spawn(command, rest, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code, signal) =>
			resolve(code ?? signalExitCode(signal)),
		);
	});
}

/**
 * Remove a prior instance by name through EVERY installed backend, not just the
 * one picked for `run`: podman and docker keep separate stores, so a stale
 * instance left by the other tool would otherwise collide with `--name`.
 * @param {string} name
 * @param {Host} [host]
 * @returns {void}
 */
export function workload_rm(name, host = hostFs) {
	for (const tool of /** @type {const} */ (["podman", "docker"])) {
		if (!host.findOnPath(tool)) {
			continue;
		}
		spawnSync(tool, ["container", "rm", "-f", name], { stdio: "ignore" });
	}
}

/**
 * Tail a running instance's logs, attached like the sh API did.
 * @param {string} name
 * @param {Backend} backend
 * @returns {number} the tool's exit status
 */
export function workload_logs(name, backend) {
	return (
		spawnSync(backend.tool, ["logs", name], { stdio: "inherit" }).status ?? 1
	);
}
