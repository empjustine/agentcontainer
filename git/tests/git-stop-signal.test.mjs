/**
 * @fileoverview What a signal means to a sweep (docs/d164). Three properties,
 * one test each, because they fail in different ways: a stop that discards the
 * step in flight (wasted hours), a stop that leaves the process alive (a Ctrl-C
 * that does nothing), and a stop that lets the next repo start anyway (the
 * sweep the operator asked to stop keeps working).
 *
 * The probe is written here rather than kept as a fixture: knip treats a
 * fixture file as an unused file, and these two runs differ only in how long
 * the first step takes.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { git } from "../lib/git-core.mjs";
import {
  installStopHandler,
  stopExitCode,
  stopRequested,
  throwIfStopRequested,
} from "../lib/stop-signal.mjs";

const UNIT_DIR = dirname(dirname(new URL(import.meta.url).pathname));
const LIB_URL = pathToFileURL(join(UNIT_DIR, "lib")).href;

/**
 * Two git steps; the first one takes STEP_SECONDS. Both drop a marker, so the
 * test can tell "the step finished" from "the step was killed" without reading
 * logs.
 * @param {string} dir
 * @returns {string} path to the probe script
 */
function writeProbe(dir) {
  const source = `import { runEntry } from "${LIB_URL}/cli.mjs";
import { git } from "${LIB_URL}/git-core.mjs";

const repo = process.argv[2];
const markers = process.argv[3];
await runEntry("probe", async () => {
	await git(repo, [
		"-c",
		"alias.step1=!sleep " + process.env.STEP_SECONDS + "; printf one > " + markers + "/step1.marker",
		"step1",
	]);
	await git(repo, [
		"-c",
		"alias.step2=!printf two > " + markers + "/step2.marker",
		"step2",
	]);
});
`;
  const path = join(dir, "probe.mjs");
  writeFileSync(path, source);
  return path;
}

/** @param {string} dir */
function makeBareRepo(dir) {
  const repo = join(dir, "probe.git");
  execFileSync("git", ["init", "--bare", repo]);
  return repo;
}

/**
 * Run the probe and hand its handles to the caller, so a test can signal it at
 * a chosen moment.
 * @param {string} probe @param {string} repo @param {string} markers
 * @param {string} stepSeconds
 */
function startProbe(probe, repo, markers, stepSeconds) {
  const child = spawn(process.execPath, [probe, repo, markers], {
    env: { ...process.env, STEP_SECONDS: stepSeconds },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    out: () => ({ stdout, stderr }),
  };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the first signal finishes the step in flight and starts nothing new", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stop-signal-"));
  try {
    const repo = makeBareRepo(dir);
    const probe = writeProbe(dir);
    const run = startProbe(probe, repo, dir, "3");
    await sleep(900);
    const signalledAt = Date.now();
    run.child.kill("SIGINT");
    const { code } = await run.exited;
    const waitedMs = Date.now() - signalledAt;
    assert.equal(code, 130, "a stopped sweep exits with the signal's code");
    assert.ok(
      existsSync(join(dir, "step1.marker")),
      "the step that was already running must finish, not die",
    );
    assert.ok(!existsSync(join(dir, "step2.marker")), "no new step starts after the request");
    assert.ok(waitedMs > 1000, `the exit waited for the step to finish (waited ${waitedMs} ms)`);
    assert.match(run.out().stderr, /stop requested/);
    assert.match(run.out().stderr, /stopped at a step boundary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second signal aborts the step in flight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stop-signal-"));
  try {
    const repo = makeBareRepo(dir);
    const probe = writeProbe(dir);
    const run = startProbe(probe, repo, dir, "30");
    await sleep(900);
    run.child.kill("SIGINT");
    await sleep(400);
    const abortedAt = Date.now();
    run.child.kill("SIGINT");
    const { code } = await run.exited;
    const abortMs = Date.now() - abortedAt;
    assert.equal(code, 130);
    assert.ok(abortMs < 6000, `the abort does not wait for the step (waited ${abortMs} ms)`);
    assert.ok(!existsSync(join(dir, "step1.marker")), "the step was taken away");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Last on purpose: installStopHandler is process-global and one request per
// process, so this test's sticky state would leak into any test after it.
test("a requested stop refuses the next git invocation", () => {
  installStopHandler();
  process.emit("SIGINT");
  assert.equal(stopRequested(), "SIGINT");
  assert.equal(stopExitCode(), 130);
  assert.throws(
    () => throwIfStopRequested(),
    (err) => err.name === "StopRequested" && err.signal === "SIGINT",
  );
  const dir = mkdtempSync(join(tmpdir(), "stop-signal-"));
  try {
    const repo = makeBareRepo(dir);
    assert.throws(
      () => git(repo, ["status"]),
      (err) => err.name === "StopRequested",
      "the refusal happens before a child exists",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
