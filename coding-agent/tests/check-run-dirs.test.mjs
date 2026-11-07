/**
 * @fileoverview check-run-dirs.test.mjs — the DIRECTORY argv that
 * coding-agent/run.mjs hands the container tool, asserted as argv.
 *
 * The launcher is spawned the way an operator starts it (docs/d138): the
 * repo-root invoker with the entry as its first argument, so the test covers
 * the real chain — pin, then launcher — rather than a shim around it.
 *
 * WHAT IT PINS: docs/d068's two-sided spelling of the mount manifest — the
 * HOST side of a DIRECTORY stays canonical (`pwd -P`: the dedupe and the
 * `$HOME` refusal compare those forms), the CONTAINER side of a home-relative
 * DIRECTORY is spelled from the home the image gives the user, and a
 * non-home DIRECTORY passes through untouched. It also rides along the pieces
 * the spelling is entangled with: CWD as the implicit first DIRECTORY, dedupe
 * of a symlinked and a physical spelling of the same directory, the `$HOME`
 * refusal (exit 90), and the workdir being that first DIRECTORY.
 *
 * WHY IT EXISTS: every other gate is blind to this class of bug. check-workload
 * renders host==guest pairs BY CONSTRUCTION, so it cannot express a pair that
 * differs; the type checker cannot see a path's value. A launcher that spelled
 * the guest from `pwd -P` passed everything while, on a host whose home sits
 * behind a symlink (Bazzite / Fedora Atomic: `/home` -> `/var/home`), the
 * folders landed outside the sandbox's `~` — mounted, yet nowhere a session
 * looks for them, which is how the bug read to the operator.
 *
 * The fixture below IS that host: `$HOME` is a symlink to a physical home, so
 * every home-relative path has two spellings, and the stub `podman` only
 * records its argv (found because the backend probe resolves through PATH,
 * docs/d069) — the assertion is the argv itself. The stub bin also carries a
 * TRIPWIRE `jq` that fails loudly and records a marker: the launcher must never
 * need one (the port retired lib/workload-*.jq), and a regression that shells
 * out to it again fails here rather than on a host without jq.
 *
 * Exit-code coverage rides along because these are the launcher's hard contract:
 * 90 (a DIRECTORY that is $HOME), 93 (auth.json holding credentials), 94 (a
 * missing generated artifact).
 *
 * Run: ../node-run.sh --test tests/*.test.mjs   (from ./coding-agent)
 *      RECORD=1 … to rewrite tests/expect-run-dirs.txt (review the diff!)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, suite, test } from "node:test";
import { fileURLToPath } from "node:url";
import { containerRunArgv, detectBackend } from "../lib/workload-runtime.mjs";
import { buildLaunch, vaultEnv } from "../run.mjs";

const unit = dirname(dirname(fileURLToPath(import.meta.url)));
const expectation = join(unit, "tests/expect-run-dirs.txt");
const nodeRun = join(unit, "..", "node-run.sh");
const runMjs = join(unit, "run.mjs");

/** The uid:gid the --user flag carries, whatever process.getuid says here. */
const uidGid = `${process.getuid?.() ?? ""}:${process.getgid?.() ?? ""}`;
const tmp = mkdtempSync(join(tmpdir(), "check-run-dirs-"));
const physical = join(tmp, "physical");
const home = join(tmp, "home");
const argvOut = join(tmp, "argv.txt");
const tripwire = join(tmp, "jq-invoked");

/**
 * The reference-host layout: a symlinked home (so pwd -P != the spelling the
 * operator typed) with one dir under it, one under that, and one outside it.
 */
function fixture() {
	mkdirSync(join(physical, "home/project"), { recursive: true });
	mkdirSync(join(physical, "home/Downloads/references"), { recursive: true });
	mkdirSync(join(physical, "srv/data"), { recursive: true });
	symlinkSync(join(physical, "home"), home);
	// The launcher reached through a SYMLINKED path: node realpaths
	// `import.meta.url` but keeps argv[1]'s spelling, so a main-module guard
	// that compares the two exits 0 with no output here — the /home -> /var/home
	// shape every Bazzite host has.
	symlinkSync(unit, join(tmp, "unit-link"));

	const bin = join(tmp, "bin");
	mkdirSync(bin, { recursive: true });
	// Stand-in container tool: one ARG[...] line per word, so the launcher's own
	// log lines cannot pollute what is compared.
	writeFileSync(
		join(bin, "podman"),
		'#!/bin/sh\n{ for a in "$@"; do printf "ARG[%s]\\n" "$a"; done; } >"$ARGV_OUT"\n',
		{ mode: 0o755 },
	);
	// The pinned interpreter under a second name: the jq-free launch below takes
	// node-run.sh's system-node branch, which resolves `node` from PATH.
	symlinkSync(process.execPath, join(bin, "node"));
	writeFileSync(
		join(bin, "jq"),
		`#!/bin/sh\nprintf 'TRIPWIRE: jq was invoked\\n' >&2\n: >"${tripwire}"\nexit 1\n`,
		{ mode: 0o755 },
	);

	// pi's generated artifacts (the launcher aborts without them, exit 94);
	// everything else it mkdir -p's itself.
	mkdirSync(join(home, ".pi/agent"), { recursive: true });
	for (const file of ["settings.json", "models.json", "mcp.json"]) {
		writeFileSync(join(home, ".pi/agent", file), "{}\n");
	}
}

/**
 * The launcher's environment: everything ambient except the names it forwards
 * to the sandbox or reads as a path override, so an ambient HF_TOKEN or
 * XDG_CONFIG_HOME cannot make the argv machine-dependent.
 * @returns {NodeJS.ProcessEnv}
 */
function launcherEnv() {
	/** @type {NodeJS.ProcessEnv} */
	const env = { ...process.env };
	for (const name of [
		...vaultEnv,
		"PI_CODING_AGENT_DIR",
		"PI_CODING_AGENT_SESSION_DIR",
		"OPENCODE_CONFIG_DIR",
		"XDG_CONFIG_HOME",
		"SUDO_UID",
		"SUDO_GID",
	]) {
		delete env[name];
	}
	return {
		...env,
		PATH: `${join(tmp, "bin")}:${process.env.PATH ?? ""}`,
		HOME: home,
		USER: "run-dirs-check",
		ARGV_OUT: argvOut,
	};
}

/**
 * The ambient PATH minus every directory that provides a `jq` — the host this
 * unit has to work on. Filtering rather than prefixing is the point: mise
 * PREPENDS its own tool dirs to PATH inside `mise exec`, so a stub earlier in
 * PATH never wins (measured with a `node` stub) — the only way to make the
 * launcher genuinely jq-less is to remove those directories and take
 * node-run.sh's system-node branch, which the `PREFIX` spelling below selects and
 * the fixture's `node` symlink satisfies.
 * @returns {string}
 */
function jqFreePath() {
	// The fixture's own bin keeps the tripwire `jq`, so it goes FIRST and the
	// filter applies to the ambient PATH only: a launcher that asks for jq finds
	// the tripwire, and nothing else on PATH can answer.
	const ambient = (process.env.PATH ?? "")
		.split(":")
		.filter((dir) => dir && !existsSync(join(dir, "jq")));
	return [join(tmp, "bin"), ...ambient].join(":");
}

/**
 * Run the launcher from the fixture project with the given DIRECTORY args.
 * @param {string[]} dirs
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [entry] the run.mjs spelling to invoke; defaults to the
 *   physical path, and the symlinked spelling is the guard regression's point
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function launch(dirs, env = launcherEnv(), entry = runMjs) {
	const result = spawnSync(nodeRun, [entry, ...dirs], {
		cwd: join(home, "project"),
		env,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

/**
 * Normalise the three things that legitimately vary between machines: the
 * mktemp path, the uid:gid the --user flag carries, and the per-run stamp.
 * @param {string} text
 * @returns {string}
 */
function normalise(text) {
	return text
		.replaceAll(tmp, "<TMP>")
		.replaceAll(uidGid, "<UID>:<GID>")
		.replace(/agentcontainer-\d{17}/g, "agentcontainer-<STAMP>");
}

// One fixture for both suites, torn down once: node's `suite` bodies run when
// they are REGISTERED, so a per-suite fixture would build (and delete) the same
// temp tree twice.
fixture();
after(() => rmSync(tmp, { recursive: true, force: true }));

suite("the DIRECTORY argv is the d068 mount manifest", () => {
	test("auth.json holding credentials refuses the launch (exit 93)", () => {
		writeFileSync(
			join(home, ".pi/agent/auth.json"),
			'{"openai":{"key":"sk-live"}}\n',
		);
		const { status } = launch([]);
		assert.equal(status, 93);
		rmSync(join(home, ".pi/agent/auth.json"));
	});

	test("an empty auth.json is pi's own store, not a credential", () => {
		writeFileSync(join(home, ".pi/agent/auth.json"), "{ }\n");
		assert.equal(launch([]).status, 0);
		rmSync(join(home, ".pi/agent/auth.json"));
	});

	test("a missing generated artifact refuses the launch (exit 94)", () => {
		rmSync(join(home, ".pi/agent/settings.json"));
		const { status } = launch([]);
		writeFileSync(join(home, ".pi/agent/settings.json"), "{}\n");
		assert.equal(status, 94);
	});

	test("$HOME as a DIRECTORY is refused (exit 90)", () => {
		const { status, stdout, stderr } = launch([home]);
		assert.equal(status, 90);
		assert.match(`${stdout}${stderr}`, /refusing to expose HOME/);
	});

	// The only argv word the node port ADDS to the recorded manifest is
	// `--env NODE_USE_ENV_PROXY`: the launcher now runs under ./node-run.sh,
	// which pins that variable to 1 for its process, and the allowlist forwards
	// whatever the process environment holds. The image's ENV sets the same
	// value, so the sandbox sees no change; the fixture records it because the
	// argv is asserted verbatim.
	test("CWD is the implicit first DIRECTORY, duplicates collapse", () => {
		const { status } = launch([
			join(home, "Downloads/references"),
			join(physical, "home/Downloads/references"),
			join(physical, "srv/data"),
		]);
		assert.equal(status, 0);
		const got = normalise(readFileSync(argvOut, "utf8"));
		if (process.env.RECORD === "1") {
			writeFileSync(expectation, got);
		}
		assert.equal(got, readFileSync(expectation, "utf8"));
	});

	test("an entry spelled through a symlink still launches", () => {
		const { status, stdout, stderr } = launch(
			[],
			launcherEnv(),
			join(tmp, "unit-link", "run.mjs"),
		);
		// exit 0 is NOT enough — the bug was exit 0 with no log at all, so the
		// launch marker is the assertion.
		assert.equal(status, 0, `${stdout}${stderr}`);
		assert.match(stdout, /starting container/);
	});

	test("no entrypoint needed jq on PATH", () => {
		const env = {
			...launcherEnv(),
			PATH: jqFreePath(),
			PREFIX: "/data/data/com.termux/files/usr",
		};
		const result = launch([], env);
		// The tripwire writes its marker and exits non-zero, so a launcher that
		// shells out to jq fails here on BOTH counts.
		assert.equal(existsSync(tripwire), false);
		assert.equal(result.status, 0, result.stdout);
	});
});

/**
 * The Host port `buildLaunch` asks facts of: the canonical spelling of a
 * DIRECTORY (docs/d068's host side) and the container tool on PATH (the fixture
 * stub). The other members refuse loudly rather than quietly handing back a
 * default the description would then carry.
 * @returns {import("../lib/workload-runtime.mjs").Host}
 */
function realHost() {
	/**
	 * @param {string} name
	 * @returns {() => never}
	 */
	const unused = (name) => () => {
		throw new Error(`buildLaunch must not call host.${name}`);
	};
	return {
		/** @param {string} name */
		findOnPath: (name) => (name === "podman" ? join(tmp, "bin/podman") : null),
		exists: unused("exists"),
		readdir: unused("readdir"),
		/** @param {string} path */
		canonicalDirectory: (path) => {
			try {
				return realpathSync(path);
			} catch {
				return null;
			}
		},
	};
}

/**
 * A refusal predicate for `assert.throws`: the launcher's contract is the exit
 * CODE plus a message the operator can act on (docs/d045).
 * @param {number} code
 * @param {RegExp} message
 * @returns {(error: unknown) => boolean}
 */
function refusal(code, message) {
	return (error) => {
		const refusalError = /** @type {{ code?: number, message?: string }} */ (
			error
		);
		return (
			refusalError.code === code &&
			message.test(refusalError.message ?? "")
		);
	};
}

suite("buildLaunch assembles the same argv with no container tool", () => {
	const dirs = [
		join(home, "Downloads/references"),
		join(physical, "home/Downloads/references"),
		join(physical, "srv/data"),
	];

	test("the pure argv equals the launcher's, both against the recorded manifest", () => {
		const env = { ...launcherEnv(), NODE_USE_ENV_PROXY: "1" };
		const host = realHost();
		const launch = buildLaunch(dirs, env, host, join(home, "project"));
		const backend = detectBackend(host);
		assert.ok(backend, "the fixture podman stub must be detected");
		const got = normalise(
			containerRunArgv(launch.workload, { backend, env })
				.slice(1)
				.map((word) => `ARG[${word}]\n`)
				.join(""),
		);
		assert.equal(got, readFileSync(expectation, "utf8"));
	});

	test("$HOME as a DIRECTORY is refused before any spawn", () => {
		const env = { ...launcherEnv() };
		assert.throws(
			() => buildLaunch([home], env, realHost(), join(home, "project")),
			refusal(90, /refusing to expose HOME/),
		);
	});

	test("a DIRECTORY that is not a directory is refused (exit 90)", () => {
		const env = { ...launcherEnv() };
		assert.throws(
			() =>
				buildLaunch(
					[join(home, "no-such-dir")],
					env,
					realHost(),
					join(home, "project"),
				),
			refusal(90, /not a directory/),
		);
	});
});
