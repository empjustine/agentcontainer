/**
 * @fileoverview check-workload.test.mjs — behavioural check for the workload
 * description API (lib/workload-runtime.mjs).
 *
 * WHAT IT CHECKS: that a description assembled through the workload_* calls
 * renders to the exact `container run` argv this unit produced BEFORE the port
 * — the expectations below are still the argv captured from the shell renderer
 * (lib/workload-*.jq), so this remains a DIFFERENTIAL test against the
 * behaviour that shipped, not a snapshot of whatever the node code does.
 *
 * WHY IT EXISTS: the two bugs found during the earlier refactor were invisible
 * to static analysis — neither shellcheck nor the jq compile gate in
 * ../../lint.sh could see them — because both were semantic:
 * - jq keeps parsing options after --args, so `workload_cmd -config-dir …`
 *   was read as jq flags ("Unknown option -o") until a bare `--` was added;
 * - workload_has ran jq without -n, so the filter never ran at all and the
 *   predicate silently returned 4 instead of 0/1.
 * Case 2 (a command word starting with a dash) and case 3 (the predicate) are
 * exactly those two, kept because the node port has its own ways to get them
 * wrong (a spread that drops a leading `-`, an `Array.isArray` on the wrong
 * field). Only an end-to-end render catches either.
 *
 * Five cases: two per-backend render shapes (the mount options are the one
 * genuine backend difference), the workload_has predicate, the
 * workload_env_allowlist non-empty guard, and the workload_restart flag
 * position (docs/d095).
 *
 * Run: . ./lib/node-run.sh && node_run --test tests/*.test.mjs   (from ./coding-agent)
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	containerRunArgv,
	detectBackend,
	emptyDescription,
	workload_cmd,
	workload_detach,
	workload_devices,
	workload_entrypoint,
	workload_env,
	workload_env_allowlist,
	workload_hardening,
	workload_has,
	workload_image,
	workload_init,
	workload_interactive,
	workload_name,
	workload_network,
	workload_publish,
	workload_restart,
	workload_ro,
	workload_ro_if,
	workload_rw,
	workload_user,
	workload_workdir,
} from "../lib/workload-runtime.mjs";

const unit = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = dirname(unit);

const tmp = mkdtempSync(join(tmpdir(), "check-workload-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
/** The uid:gid the --user flag carries, whatever process.getuid says here. */
const uidGid = `${process.getuid?.() ?? ""}:${process.getgid?.() ?? ""}`;
const spaced = join(tmp, "src/a workspace with spaces");
mkdirSync(spaced, { recursive: true });

/**
 * A Host port over the fixture: which container tools are "installed" and which
 * host paths "exist". The backend is still resolved by NAME through PATH
 * (docs/d069), so the test exercises the real detection branch rather than
 * hand-building a backend literal.
 * @param {{ tools: string[], existing?: string[] }} fixture
 * @returns {import("../lib/workload-runtime.mjs").Host}
 */
function fixtureHost({ tools, existing = [] }) {
	return {
		findOnPath: (name) => (tools.includes(name) ? `/stub/bin/${name}` : null),
		exists: (path) => existing.includes(path),
		readdir: () => [],
		canonicalDirectory: () => null,
	};
}

/**
 * Render and normalise. The tool NAME is dropped because the cases compare what
 * the tool is invoked with (the sh test's stub printed its `$@` the same way);
 * the two things that legitimately vary between machines are the temp path and
 * the uid:gid the --user flag carries.
 * @param {import("../lib/workload-runtime.mjs").WorkloadDescription} description
 * @param {import("../lib/workload-runtime.mjs").Backend} backend
 * @returns {string}
 */
function rendered(description, backend) {
	return containerRunArgv(description, { backend, env: {} })
		.slice(1)
		.map((word) => `ARG[${word}]`)
		.join("\n")
		.replaceAll(tmp, "<TMP>")
		.replaceAll(repo, "<REPO>")
		.replace(uidGid, "<UID>:<GID>");
}

const podman = /** @type {import("../lib/workload-runtime.mjs").Backend} */ (
	detectBackend(fixtureHost({ tools: ["podman"] }))
);
const docker = /** @type {import("../lib/workload-runtime.mjs").Backend} */ (
	detectBackend(fixtureHost({ tools: ["docker"] }))
);

test("coding-agent shape, podman", () => {
	const host = fixtureHost({
		tools: ["podman"],
		existing: [join(repo, "README.md")],
	});
	let description = emptyDescription();
	description = workload_name(description, "agent-ctr");
	description = workload_image(
		description,
		"localhost/empjustine/coding-agent:latest",
	);
	description = workload_interactive(description);
	description = workload_init(description);
	description = workload_network(description, "host");
	description = workload_user(description);
	description = workload_ro(description, join(repo, "docs"), "/config.d");
	description = workload_rw(description, spaced, "/mnt/a guest with spaces");
	description = workload_ro_if(
		description,
		join(repo, "README.md"),
		"/opt/present",
		host,
	);
	description = workload_ro_if(
		description,
		join(repo, "nope"),
		"/opt/absent",
		host,
	);
	description = workload_env(
		description,
		"CLINE_API_KEY",
		"MISTRAL_API_KEY",
		"REVERSE_PROXY_API_KEY",
		"OPENROUTER_API_KEY",
	);
	description = workload_env(
		description,
		"OPENCODE_API_KEY",
		"HF_TOKEN",
		"GEMINI_API_KEY",
		"REVERSE_PROXY_BASE_URLS",
	);
	description = workload_workdir(description, spaced);
	description = workload_cmd(
		description,
		"/bin/sh",
		"/opt/agentcontainer-launch.sh",
	);

	const expected = `ARG[container]
ARG[run]
ARG[--init]
ARG[-it]
ARG[--name=agent-ctr]
ARG[--network=host]
ARG[--userns=keep-id]
ARG[--user]
ARG[<UID>:<GID>]
ARG[--group-add]
ARG[keep-groups]
ARG[-v]
ARG[<REPO>/docs:/config.d:z,U,ro]
ARG[-v]
ARG[<TMP>/src/a workspace with spaces:/mnt/a guest with spaces:z,U]
ARG[-v]
ARG[<REPO>/README.md:/opt/present:z,U,ro]
ARG[--env]
ARG[CLINE_API_KEY]
ARG[--env]
ARG[MISTRAL_API_KEY]
ARG[--env]
ARG[REVERSE_PROXY_API_KEY]
ARG[--env]
ARG[OPENROUTER_API_KEY]
ARG[--env]
ARG[OPENCODE_API_KEY]
ARG[--env]
ARG[HF_TOKEN]
ARG[--env]
ARG[GEMINI_API_KEY]
ARG[--env]
ARG[REVERSE_PROXY_BASE_URLS]
ARG[--workdir]
ARG[<TMP>/src/a workspace with spaces]
ARG[localhost/empjustine/coding-agent:latest]
ARG[/bin/sh]
ARG[/opt/agentcontainer-launch.sh]`;
	assert.equal(rendered(description, podman), expected);
});

test("llm-local-inference shape, docker", () => {
	let description = emptyDescription();
	description = workload_name(description, "llama-swap");
	description = workload_image(
		description,
		"ghcr.io/mostlygeek/llama-swap:cpu",
	);
	description = workload_detach(description);
	description = workload_publish(description, "8080", "8080");
	description = workload_hardening(description);
	description = workload_entrypoint(description, "llama-swap");
	description = workload_ro(description, join(repo, "docs"), "/config.d");
	description = workload_rw(description, spaced, "/cache");
	description = workload_env(
		description,
		"OPENROUTER_API_KEY",
		"OPENCODE_API_KEY",
		"REVERSE_PROXY_API_KEY",
	);
	// Devices are populated by workload_gpu on a real GPU host; there is no
	// /dev/kfd here, so declare them directly.
	description = workload_devices(
		description,
		"/dev/kfd",
		"/dev/dri/renderD128",
	);
	description = workload_cmd(description, "-config-dir", "/config.d");

	const expected = `ARG[container]
ARG[run]
ARG[--detach]
ARG[--name=llama-swap]
ARG[--entrypoint]
ARG[llama-swap]
ARG[--publish]
ARG[8080:8080/tcp]
ARG[--device]
ARG[/dev/kfd:/dev/kfd:rw]
ARG[--device]
ARG[/dev/dri/renderD128:/dev/dri/renderD128:rw]
ARG[--cap-drop=all]
ARG[--security-opt]
ARG[no-new-privileges]
ARG[-v]
ARG[<REPO>/docs:/config.d:z,ro]
ARG[-v]
ARG[<TMP>/src/a workspace with spaces:/cache:z]
ARG[--env]
ARG[OPENROUTER_API_KEY]
ARG[--env]
ARG[OPENCODE_API_KEY]
ARG[--env]
ARG[REVERSE_PROXY_API_KEY]
ARG[ghcr.io/mostlygeek/llama-swap:cpu]
ARG[-config-dir]
ARG[/config.d]`;
	assert.equal(rendered(description, docker), expected);
});

test("workload_has predicate", () => {
	let description = emptyDescription();
	assert.equal(workload_has(description, "mounts"), false);
	assert.equal(workload_has(description, "env"), false);
	description = workload_devices(description, "/dev/kfd");
	assert.equal(workload_has(description, "devices"), true);
	description = workload_env(description, "A", "B");
	assert.equal(workload_has(description, "env"), true);
});

test("workload_env_allowlist forwards only non-empty host vars, in order", () => {
	const description = workload_env_allowlist(
		emptyDescription(),
		["UNSET_ONE", "SET_ONE", "EMPTY_ONE", "SET_TWO"],
		{
			SET_ONE: "alpha",
			SET_TWO: "beta",
			EMPTY_ONE: "",
		},
	);
	assert.deepEqual(description.env, ["SET_ONE", "SET_TWO"]);
});

test("workload_restart rides directly after the mode flag", () => {
	let description = emptyDescription();
	description = workload_name(description, "relay-ctr");
	description = workload_image(description, "localhost/estige:latest");
	description = workload_detach(description);
	description = workload_restart(description, "unless-stopped");
	description = workload_network(description, "host");
	description = workload_cmd(description, "-mode", "relay");

	const expected = `ARG[container]
ARG[run]
ARG[--detach]
ARG[--restart=unless-stopped]
ARG[--name=relay-ctr]
ARG[--network=host]
ARG[localhost/estige:latest]
ARG[-mode]
ARG[relay]`;
	assert.equal(rendered(description, podman), expected);
});

test("an unset restart policy emits nothing", () => {
	let description = emptyDescription();
	description = workload_name(description, "quiet");
	description = workload_image(description, "localhost/estige:latest");
	assert.equal(rendered(description, podman).includes("--restart"), false);
	// A description with no image is a launcher bug, mapped to exit 92.
	assert.throws(() => rendered(emptyDescription(), podman), /has no image/);
});
