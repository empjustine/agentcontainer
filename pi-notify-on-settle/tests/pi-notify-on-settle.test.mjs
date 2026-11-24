/**
 * @fileoverview pi-notify-on-settle.test.mjs — the extension's rules, pinned:
 * which event decides the notice, what each outcome reports, and which channel
 * a mode may open.
 *
 * The entry is driven through a fake `pi` that records handlers, so the suite
 * runs the real code path (including the settle dispatch) with no session and
 * no terminal. `process.stdout.write` is patched for the TUI cases, the same
 * way the sibling folders inject `fetch`.
 *
 * Run: node --test   (from this folder — discovers tests/*.test.mjs)
 */
import assert from "node:assert/strict";
import test from "node:test";

const entry = await import("../index.mjs");
const { noticeFor, oscSafe, writeTuiAlert } = entry;

/**
 * A `pi` whose handlers the test can drive by event name.
 * @returns {{pi: any, emit: (name: string, event?: any, ctx?: any) => void}}
 */
function harness() {
	/** @type {Map<string, any[]>} */
	const handlers = new Map();
	const pi = {
		on: (/** @type {string} */ name, /** @type {any} */ handler) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	};
	entry.default(/** @type {any} */ (pi));
	const emit = (
		/** @type {string} */ name,
		/** @type {any} */ event = {},
		/** @type {any} */ ctx = tuiContext(),
	) => {
		for (const handler of handlers.get(name) ?? []) {
			handler(event, ctx);
		}
	};
	return { pi, emit };
}

/** A TUI context whose UI calls are recorded. */
function tuiContext() {
	/** @type {{body: string, level: string}[]} */
	const notices = [];
	return {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (/** @type {string} */ body, /** @type {string} */ level) => {
				notices.push({ body, level });
			},
		},
		notices,
	};
}

/**
 * Run one settle with the given events, capturing stdout.
 * @param {string} mode
 * @param {boolean} hasUI
 * @param {(emit: (name: string, event?: any, ctx?: any) => void, ctx: any) => void} drive
 * @returns {{notices: {body: string, level: string}[], written: string}}
 */
function run(mode, hasUI, drive) {
	const { emit: emitRaw } = harness();
	const ctx = tuiContext();
	ctx.mode = mode;
	ctx.hasUI = hasUI;
	const emit = (/** @type {string} */ name, /** @type {any} */ event = {}) =>
		emitRaw(name, event, ctx);
	/** @type {string[]} */
	const written = [];
	const realWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = /** @type {any} */ (
		(/** @type {any} */ chunk) => {
			written.push(String(chunk));
			return true;
		}
	);
	try {
		drive(emit, ctx);
	} finally {
		process.stdout.write = realWrite;
	}
	return { notices: ctx.notices, written: written.join("") };
}

test("a completed run reports a plain ready notice at info level", () => {
	assert.deepEqual(noticeFor("completed", false, ""), {
		title: "Pi is ready",
		body: "Ready for input",
		level: "info",
	});
});

test("a provider failure names the detail at error level", () => {
	assert.deepEqual(noticeFor("error", false, "socket hang up"), {
		title: "Pi needs attention",
		body: "Run failed: socket hang up",
		level: "error",
	});
	assert.equal(
		noticeFor("error", false, "").body,
		"Run failed: see transcript",
		"a failure with no message still says something",
	);
});

test("a cancel is a warning, and agent_settled's own aborted flag wins", () => {
	assert.equal(noticeFor("aborted", false, "").level, "warning");
	assert.equal(
		noticeFor("completed", true, "").level,
		"warning",
		"an abort during the settle boundary is still a cancel",
	);
});

test("the settle dispatch reads agent_before_settle's outcome", () => {
	const { notices } = run("tui", true, (emit) => {
		emit("agent_start", {});
		emit("agent_before_settle", { outcome: "error" });
		emit("agent_settled", { aborted: false });
	});
	assert.deepEqual(notices, [
		{ body: "Run failed: see transcript", level: "error" },
	]);
});

test("a failed assistant message supplies the detail, and the next run clears it", () => {
	const { notices } = run("tui", true, (emit) => {
		emit("agent_start", {});
		emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "upstream returned 503",
			},
		});
		emit("message_end", {
			message: { role: "user", stopReason: "error", errorMessage: "ignored" },
		});
		emit("agent_before_settle", { outcome: "error" });
		emit("agent_settled", { aborted: false });
		emit("agent_start", {});
		emit("agent_before_settle", { outcome: "completed" });
		emit("agent_settled", { aborted: false });
	});
	assert.deepEqual(notices, [
		{ body: "Run failed: upstream returned 503", level: "error" },
		{ body: "Ready for input", level: "info" },
	]);
});

test("a timeout reads through rawStopReason when no message was published", () => {
	const { notices } = run("tui", true, (emit) => {
		emit("agent_start", {});
		emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "error",
				rawStopReason: "timeout",
			},
		});
		emit("agent_before_settle", { outcome: "error" });
		emit("agent_settled", { aborted: false });
	});
	assert.deepEqual(notices, [{ body: "Run failed: timeout", level: "error" }]);
});

test("no UI means no notice, and no TUI means no escape sequences", () => {
	const noUi = run("print", false, (emit) => {
		emit("agent_before_settle", { outcome: "completed" });
		emit("agent_settled", { aborted: false });
	});
	assert.deepEqual(noUi.notices, [], "print mode has no UI to notify");
	assert.equal(noUi.written, "", "and no terminal to address");

	const rpc = run("rpc", true, (emit) => {
		emit("agent_before_settle", { outcome: "completed" });
		emit("agent_settled", { aborted: false });
	});
	assert.deepEqual(
		rpc.notices,
		[{ body: "Ready for input", level: "info" }],
		"RPC renders the notice as a protocol message",
	);
	assert.equal(
		rpc.written,
		"",
		"RPC must never carry raw control sequences into its JSON stream",
	);
});

test("the TUI channel rings BEL and sends one OSC 777 notification", () => {
	const { written, notices } = run("tui", true, (emit) => {
		emit("agent_before_settle", { outcome: "completed" });
		emit("agent_settled", { aborted: false });
	});
	assert.equal(written, "\x07\x1b]777;notify;Pi is ready;Ready for input\x07");
	assert.equal(notices.length, 1, "the in-app notice rides alongside");
});

test("OSC payloads strip the terminators and separator, and are length-capped", () => {
	assert.equal(oscSafe("a;b\x07c\x1bd"), "a b c d");
	assert.equal(oscSafe("x".repeat(500)).length, 200);
	const { written } = run("tui", false, (emit) => {
		emit("agent_start", {});
		emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "boom;\x07\x1b]0;title",
			},
		});
		emit("agent_before_settle", { outcome: "error" });
		emit("agent_settled", { aborted: false });
	});
	// The sequence's own terminators are the target: BEL ends it and `;`
	// separates its fields, so they are matched as literals rather than as a
	// regular expression either linter would flag.
	const MARKER = "\u001b]777;notify;";
	const BEL = "\u0007";
	assert.ok(written.startsWith(BEL + MARKER), "the alert starts with BEL");
	assert.ok(written.endsWith(BEL), "and ends with BEL");
	const payload = written.slice(BEL.length + MARKER.length, -BEL.length);
	assert.ok(!payload.includes(BEL), "no bare BEL inside the payload");
	const [title = "", body = ""] = payload.split(";");
	assert.equal(title, "Pi needs attention");
	assert.ok(!body.includes(";"), "no field separator survives");
	const controlCharacters = Array.from(body).filter((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 0x20 || code === 0x7f;
	});
	assert.deepEqual(controlCharacters, [], "no control character survives");
});

test("writeTuiAlert is the one place the sequences are spelled", () => {
	/** @type {string[]} */
	const written = [];
	const realWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = /** @type {any} */ (
		(/** @type {any} */ c) => {
			written.push(String(c));
			return true;
		}
	);
	try {
		writeTuiAlert("Pi", "Ready");
	} finally {
		process.stdout.write = realWrite;
	}
	assert.equal(written.join(""), "\x07\x1b]777;notify;Pi;Ready\x07");
});
