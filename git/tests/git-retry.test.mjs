/**
 * @fileoverview The rate-limit policy of a bulk clone sweep (docs/d044,
 * docs/d121). Pinned here because the policy is only arguable if it is
 * testable: the sleep and the jitter source are injected, so the whole retry
 * ladder is exercised in milliseconds instead of in forged-throttle minutes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	backoffSeconds,
	classifyFailure,
	createFailureStreak,
} from "../lib/retry.mjs";

test("a throttle signature is rate-limited — and 403 counts, on this tenant", () => {
	// The forge reports throttling as 403 as often as 429; missing that turns
	// a rate-limited sweep into a "hard failure" that never retries.
	for (const output of [
		"error: RPC failed; HTTP 429",
		"remote: Too many requests",
		"request was throttled, slow down",
		"fatal: unable to access ... 403 Forbidden",
		"access denied: abuse detected",
	]) {
		assert.equal(classifyFailure(output), "rate-limited", output);
	}
});

test("a network blip is transient — retried, on the retry ladder", () => {
	for (const output of [
		"fatal: unable to access: Could not resolve host",
		"ssh: connect to host port 22: Connection refused",
		"the remote end hung up unexpectedly (timeout)",
		"error: 502 Bad Gateway",
		"gnutls_handshake() failed: TLS",
	]) {
		assert.equal(classifyFailure(output), "transient", output);
	}
});

test("everything else is hard — retrying it only burns the rate budget", () => {
	for (const output of [
		"fatal: repository '/x/y.git' does not exist",
		"remote: Invalid username or password",
		"fatal: not a git repository",
	]) {
		assert.equal(classifyFailure(output), "hard", output);
	}
});

test("backoff doubles from the base, caps, and adds 0–2 s of jitter", () => {
	const noJitter = { random: () => 0 };
	assert.equal(backoffSeconds(1, 60, noJitter), 60);
	assert.equal(backoffSeconds(2, 60, noJitter), 120);
	assert.equal(backoffSeconds(3, 60, noJitter), 240);
	// Capped: attempt 4 would be 480 without the cap.
	assert.equal(backoffSeconds(4, 60, noJitter), 300);
	assert.equal(backoffSeconds(9, 60, noJitter), 300);
	// Jitter is whole seconds below 3, so retries do not re-collide.
	assert.equal(backoffSeconds(1, 60, { random: () => 0.999 }), 62);
});

test("a failure streak cools the sweep down once, then starts over", async () => {
	/** @type {number[]} */
	const slept = [];
	/** @type {[number, number][]} */
	const cooled = [];
	const streak = createFailureStreak({
		threshold: 5,
		cooldown: 60,
		sleep: async (seconds) => {
			slept.push(seconds);
		},
		onCooldown: (n, seconds) => {
			cooled.push([n, seconds]);
		},
	});
	for (const ok of [false, false, false, false]) {
		await streak.note(ok);
	}
	assert.deepEqual(slept, [], "four failures are not yet systemic");
	assert.equal(streak.streak(), 4);

	await streak.note(false);
	assert.deepEqual(slept, [60], "the fifth failure triggers the cooldown");
	assert.deepEqual(cooled, [[5, 60]]);
	assert.equal(streak.streak(), 0, "the streak resets after the cooldown");
});

test("one success clears the streak — a run of failures is what matters", async () => {
	/** @type {number[]} */
	const slept = [];
	const streak = createFailureStreak({
		threshold: 3,
		cooldown: 60,
		sleep: async (seconds) => {
			slept.push(seconds);
		},
	});
	await streak.note(false);
	await streak.note(false);
	await streak.note(true);
	await streak.note(false);
	await streak.note(false);
	assert.deepEqual(slept, [], "no three consecutive failures ever happened");
	assert.equal(streak.streak(), 2);
});
