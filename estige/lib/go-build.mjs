/**
 * @fileoverview go-build.mjs — centralized go toolchain handling for the
 * repo's builders (docs/d041): the toolchain probe and the per-platform flag
 * presets live HERE so no builder carries its own copy.
 *
 * The probe matters because a `command -v go` hit is NOT proof of a
 * toolchain: mise installs (or activates) a `go` shim even when NO go version
 * is set, the shim answers every PATH lookup, and only fails once invoked —
 * "mise ERROR No version is set for shim: go" — which would kill a build
 * mid-run (observed on the rootless-podman bazzite host). Only a `go
 * version` that actually executes counts as ready.
 *
 * Termux capacity: go builds there are ALWAYS serialized by the caller and
 * run with the memory caps (GOGC/-p) — ~1 GB devices OOM otherwise.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The unit root (this file lives in <unit>/lib). */
const unitRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Termux identifies itself through $PREFIX — one spelling for every caller
 * that branches on the platform (the root builder's target table, the root
 * generator's go legs), so the detection cannot drift between them.
 * @returns {boolean}
 */
export function isTermux() {
	return Boolean(process.env.PREFIX?.includes("com.termux"));
}

/**
 * Probe for a WORKING go toolchain: PATH first, then the mise shims dir
 * (sandbox/toolbox hosts without a login shell don't have the shims on PATH).
 * @returns {boolean}
 */
export function goToolchainReady() {
	if (spawnSync("go", ["version"], { stdio: "ignore" }).status === 0) {
		return true;
	}
	const shims = join(process.env.HOME ?? "", ".local/share/mise/shims");
	if (!existsSync(shims)) {
		return false;
	}
	return (
		spawnSync("go", ["version"], {
			stdio: "ignore",
			env: { ...process.env, PATH: `${shims}:${process.env.PATH ?? ""}` },
		}).status === 0
	);
}

/**
 * Go build env with the Android preset. GOOS=android, NOT linux: an
 * android-targeted binary uses Android's system DNS resolver instead of the
 * missing /etc/resolv.conf — a linux binary falls back to localhost:53,
 * which fails there. CGO stays off so no NDK is needed.
 * @param {boolean} termux cap parallelism/GC for ~1 GB devices
 * @returns {Record<string, string>}
 */
export function androidBuildEnv(termux) {
	/** @type {Record<string, string>} */
	const env = {
		...process.env,
		CGO_ENABLED: "0",
		GOOS: "android",
		GOARCH: "arm64",
		...(termux ? { GOGC: "50" } : {}),
	};
	delete env.GOBIN;
	return env;
}

/**
 * Go build env for a plain host binary (the packaged systemd service execs
 * it; nothing Android-specific).
 * @returns {Record<string, string>}
 */
export function hostBuildEnv() {
	/** @type {Record<string, string>} */
	const env = { ...process.env, CGO_ENABLED: "0" };
	delete env.GOOS;
	delete env.GOARCH;
	delete env.GOBIN;
	return env;
}

/**
 * The one version spelling: -version output and both package versions. The
 * committed VERSION file is the source; ESTIGE_VERSION exists for a release
 * build that has not bumped the file yet. Dashes are rejected because RPM
 * splits version/release on them and Debian uses them for a revision.
 * @returns {string}
 */
export function estigeVersion() {
	const raw = (
		process.env.ESTIGE_VERSION?.trim() ||
		readFileSync(join(unitRoot, "packaging", "VERSION"), "utf8").trim()
	);
	if (!/^[0-9][0-9A-Za-z.+~_]*$/.test(raw)) {
		throw new Error(
			`estige version ${JSON.stringify(raw)} must match ^[0-9][0-9A-Za-z.+~_]*$`,
		);
	}
	return raw;
}

/**
 * Build args shared by every go build: strip debug info (less linker RAM on
 * ~1 GB devices), make paths reproducible, and inject the version (-version,
 * ldflags) so the binary and the packages cannot disagree.
 * @param {boolean} termux cap parallelism (-p=2) on Termux; the infisical
 *   provisioning build (lib/provision-termux.sh) goes further (-p=1) because
 *   it compiles a much larger dependency tree.
 * @returns {string[]}
 */
export function commonBuildFlags(termux) {
	return [
		...(termux ? ["-p=2"] : []),
		"-trimpath",
		`-ldflags=-s -w -X main.version=${estigeVersion()}`,
	];
}
