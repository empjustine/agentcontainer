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
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Probe for a WORKING go toolchain: PATH first, then the mise shims dir
 * (sandbox/toolbox hosts without a login shell don't have the shims on PATH).
 * @returns {boolean}
 */
export function goToolchainReady() {
	if (spawnSync("go", ["version"], { stdio: "ignore" }).status === 0) {
		return true;
	}
	const shims = join(
		process.env.HOME ?? "",
		".local/share/mise/shims",
	);
	if (!existsSync(shims)) return false;
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
 * Go build env for a plain host binary (the proxy's smoke-test/direct-run
 * binary; nothing Android-specific).
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
 * Build args shared by every go build: strip debug info (less linker RAM on
 * ~1 GB devices) and make paths reproducible.
 * @param {boolean} termux cap parallelism (-p=2) on Termux; the infisical
 *   provisioning build (lib/provision-termux.sh) goes further (-p=1) because
 *   it compiles a much larger dependency tree.
 * @returns {string[]}
 */
export function commonBuildFlags(termux) {
	return [
		...(termux ? ["-p=2"] : []),
		"-trimpath",
		"-ldflags=-s -w",
	];
}
