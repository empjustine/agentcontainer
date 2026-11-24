/**
 * @fileoverview index.mjs — the pi extension entry: one alert when an agent
 * loop SETTLES, with the run's own outcome attached.
 *
 * Why `agent_settled` and not `agent_end`: `agent_end` closes one low-level
 * run, and pi may still retry, compact or drain a queued message after it, so
 * a notice there fires while the agent is still working. `agent_settled` is
 * the final idle boundary and carries only `aborted`, so the outcome is
 * gathered from the two events that do carry it (`agent_before_settle`'s
 * `outcome`, and the failed assistant message's `stopReason`) and read at that
 * dispatch. This file, package.json, AGENTS.md and README.md ARE the pi package
 * (docs/d096's folder contract): `pi install ./pi-notify-on-settle -l`, a copy
 * into `~/.pi/agent/extensions/pi-notify-on-settle/`, or
 * `pi -e ./pi-notify-on-settle/index.mjs`. The design record — the event
 * table, the channel table and the upstream example this file follows — is
 * README.md.
 *
 * Two channels, each behind the guard its mode demands:
 *   - `ctx.ui.notify()` whenever the context HAS a UI (TUI and RPC), because
 *     that is the one channel both modes render;
 *   - the terminal bell plus an OSC 777 native notification only in TUI mode,
 *     since RPC carries notifications as protocol messages and json/print have
 *     no terminal to address.
 *
 * Deliberately absent: a config surface. Installing the package is the switch,
 * the level follows the outcome, and nothing here writes files, spawns
 * processes or opens a channel the two above do not cover.
 */

/** @typedef {import("@earendil-works/pi-coding-agent").ExtensionAPI} ExtensionAPI */

/**
 * Which outcome the settled loop reports. `agent_settled`'s own `aborted`
 * wins over this value: a cancel during the settle boundary is still a cancel.
 * @typedef {"completed"|"aborted"|"error"} Outcome
 */

/**
 * The OSC 777 payload is a control sequence, so its fields are constrained:
 * BEL ends it and `;` separates them, which is why both are stripped. The
 * length cap keeps a provider's multi-kilobyte error text out of the terminal
 * title bar.
 * @param {string} value
 * @returns {string}
 */
export function oscSafe(value) {
	// Stripping these exact bytes IS the contract with OSC 777: BEL ends the
	// sequence and `;` separates its fields — the rule's usual hazard (an
	// accidental control character in a pattern) is the point.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the C0 range and BEL are the target
	return value.replace(/[\u0000-\u001f\u007f;]/gu, " ").slice(0, 200); // eslint-disable-line no-control-regex — matching these bytes is the contract
}

/**
 * The notification a settled loop earns. A provider failure is an error, a
 * cancel is a warning (the operator asked for it, but the run did not finish),
 * and a completed run is plain information.
 * @param {Outcome} outcome
 * @param {boolean} aborted
 * @param {string} failureDetail
 * @returns {{title: string, body: string, level: "info"|"warning"|"error"}}
 */
export function noticeFor(outcome, aborted, failureDetail) {
	if (outcome === "error") {
		return {
			title: "Pi needs attention",
			body: `Run failed: ${failureDetail || "see transcript"}`,
			level: "error",
		};
	}
	if (aborted || outcome === "aborted") {
		return {
			title: "Pi run cancelled",
			body: "Run cancelled",
			level: "warning",
		};
	}
	return { title: "Pi is ready", body: "Ready for input", level: "info" };
}

/**
 * The TUI alert: BEL for the audible/visual bell, OSC 777 for a desktop
 * notification on the terminals that implement it (Ghostty, iTerm2, WezTerm,
 * rxvt-unicode — the upstream example's list; Kitty speaks OSC 99 instead and
 * falls back to its own BEL handling).
 * @param {string} title
 * @param {string} body
 * @returns {void}
 */
export function writeTuiAlert(title, body) {
	process.stdout.write("\x07");
	process.stdout.write(
		`\x1b]777;notify;${oscSafe(title)};${oscSafe(body)}\x07`,
	);
}

/**
 * @param {ExtensionAPI} pi
 * @returns {void}
 */
export default function piNotifyOnSettle(pi) {
	/** @type {Outcome} */
	let outcome = "completed";
	let failureDetail = "";

	pi.on("agent_start", () => {
		outcome = "completed";
		failureDetail = "";
	});

	// A provider failure has no lifecycle event of its own, and a timeout reads
	// as an ordinary failed response: the assistant message's stopReason is the
	// only place it shows up, so the last one is kept for the settle dispatch.
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") {
			return;
		}
		const { stopReason, errorMessage, rawStopReason } = event.message;
		if (stopReason === "error") {
			failureDetail = errorMessage ?? rawStopReason ?? "provider error";
		}
	});

	// The final actionable boundary: after retries and compaction, before the
	// loop goes idle. Its outcome is what the notice reports.
	pi.on("agent_before_settle", (event) => {
		outcome = event.outcome;
	});

	pi.on("agent_settled", (event, ctx) => {
		const { title, body, level } = noticeFor(
			outcome,
			event.aborted,
			failureDetail,
		);
		if (ctx.hasUI) {
			ctx.ui.notify(body, level);
		}
		if (ctx.mode === "tui") {
			writeTuiAlert(title, body);
		}
	});
}
