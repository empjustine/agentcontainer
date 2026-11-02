/**
 * @fileoverview retry.mjs — the rate-limit contract of a bulk clone sweep,
 * as pure policy. A tenant-wide mirror earns throttling (403/429, dropped
 * connections, "slow down"), so a failure is never dropped: it is classified,
 * retried with exponential backoff plus jitter, and — when failures come in a
 * run — answered with a cooldown for the whole sweep (docs/d044).
 *
 * Exactly one consumer today (`vbs-mirror-all.mjs`), and it lives here rather
 * than in that entry for the reason the policy is worth reading on its own:
 * classification and backoff are decisions an operator can argue about, and
 * they are only arguable if they are testable without a real forge throttling
 * a real run. Hence the injectable `sleep` and `random`: the retry ladder is
 * pinned by unit tests, not by waiting 60 seconds.
 */

/**
 * A rate limit is what the forge calls it: 403 is folded in deliberately,
 * because on this tenant throttling surfaces as 403, not only 429.
 */
const RATE_LIMITED =
	/rate.?limit|too many|throttl|slow down|abuse|429|403|forbidden|access denied|temporarily/i;

/** Transient network/5xx signatures a retry can actually clear. */
const TRANSIENT =
	/429|5[0-9][0-9]|timeout|timed out|connection (reset|closed|refused|aborted)|could not resolve|network is unreachable|tls|ssl/i;

/**
 * Which failure this git output is — the one classification every caller must
 * agree on, because it decides both the delay and whether a retry is even
 * attempted.
 *   rate-limited — the forge pushed back; back off on the RATE ladder
 *   transient    — the network blipped; back off on the RETRY ladder
 *   hard         — a bad path, a deleted repo, a real auth failure; retrying
 *                  only burns the rate budget, so the caller must not
 * @param {string} output the child's combined output (tail is enough)
 * @returns {"rate-limited"|"transient"|"hard"}
 */
export function classifyFailure(output) {
	if (RATE_LIMITED.test(output)) {
		return "rate-limited";
	}
	if (TRANSIENT.test(output)) {
		return "transient";
	}
	return "hard";
}

/**
 * Exponential backoff: base * 2^(attempt-1), capped, plus 0–2 s of jitter so
 * a batch of retries does not re-collide on the same second.
 * @param {number} attempt  1-based: the attempt that just failed
 * @param {number} base     seconds to start from
 * @param {{ max?: number, random?: () => number }} [o]
 * @returns {number} whole seconds
 */
export function backoffSeconds(attempt, base, { max = 300, random = Math.random } = {}) {
	let delay = base;
	for (let i = 1; i < attempt; i += 1) {
		delay *= 2;
	}
	if (delay > max) {
		delay = max;
	}
	return delay + Math.floor(random() * 3);
}

/**
 * Track a run of failures and pause the whole sweep once it looks systemic
 * rather than per-repo — which is what a rate limit looks like from here.
 * @param {{ threshold: number, cooldown: number,
 *   sleep: (seconds: number) => Promise<void>,
 *   onCooldown?: (streak: number, cooldown: number) => void }} o
 * @returns {{ note: (ok: boolean) => Promise<void>, streak: () => number }}
 */
export function createFailureStreak({ threshold, cooldown, sleep, onCooldown }) {
	let streak = 0;
	return {
		streak: () => streak,
		async note(ok) {
			if (ok) {
				streak = 0;
				return;
			}
			streak += 1;
			if (streak < threshold) {
				return;
			}
			onCooldown?.(streak, cooldown);
			await sleep(cooldown);
			streak = 0;
		},
	};
}

/**
 * The real sleep, in the one spelling every caller injects.
 * @param {number} seconds
 * @returns {Promise<void>}
 */
export function sleepSeconds(seconds) {
	return new Promise((resolve) => {
		setTimeout(resolve, seconds * 1000);
	});
}
