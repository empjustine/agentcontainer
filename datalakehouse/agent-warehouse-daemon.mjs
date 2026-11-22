#!/usr/bin/env node
// agent-warehouse-daemon - the write-only local ingest route (docs/d181).
//
// WHY write-only: a sandboxed harness, or its extension, must be able to hand
// session events to the host WITHOUT holding write access to the archive. This
// route answers POST /ingest/session and nothing else: no read-back, no delete,
// no update. A compromised sandbox can add rows and can never remove or rewrite
// one, which is the diode property (docs/d180, docs/d181).
//
// WHY the process is host-side: the spool below is the archive's append-only
// tail, and agent-warehouse-sync.sh folds it into MotherDuck. If this ran inside
// the sandbox it would be under the adversary's control, which is worse than no
// route because it looks like one.
//
// WHY no daemonize: this runs in the foreground and logs to stdout. Background
// management (systemd, supervisord, nohup) is the orchestration layer's job, not
// the process's; a new-style daemon does not fork itself.
//
// WHY the daemon folds its own spool (docs/d217): the spool is a tail, not the
// archive. Left alone it grows until an operator remembers to run the sender,
// which is a size ceiling set by human attention. The daemon already holds the
// one credential that leg needs whenever it starts through ./environment.sh, so
// it runs the SAME sender (agent-warehouse-spool-send.sh) at a byte threshold
// and the sender stays the only code that writes to MotherDuck. Rotation stays
// safe on both sides because the sender freezes the tail by renaming it and
// this process appends by path, never a held fd.
//
// Env: AGENT_INGEST_ADDR (default 127.0.0.1:8787), AGENT_INGEST_TOKEN,
//      AGENT_INGEST_MAX_BODY (default 8 MiB), AGENT_INGEST_MAX_ROWS (default
//      10000), AGENT_WAREHOUSE_SPOOL,
//      motherduck_token / MOTHERDUCK_TOKEN (enables the self-send),
//      AGENT_WAREHOUSE_SPOOL_MAX_BYTES (default 32 MiB; 0 disables the
//      self-send), AGENT_WAREHOUSE_SPOOL_SEND_RETRY (default 60000 ms),
//      AGENT_WAREHOUSE_SENDER (default the sender script beside this file).
// A non-numeric value for any of the numeric variables is reported and replaced
// by its default: NaN defeats every guard built on the number, which is worse
// than the default.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Session transcripts are private. The umask covers every file this process
// creates (the spool, the dedupe ledger, the lock) and every child that
// inherits it, including the sender's temporary staging files.
process.umask(0o077);

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(
    "usage: agent-warehouse-daemon.sh\n" +
      "  POST /ingest/session   append one JSON row, or a JSON array of rows\n" +
      "env: AGENT_INGEST_ADDR (default 127.0.0.1:8787), AGENT_INGEST_TOKEN,\n" +
      "     AGENT_WAREHOUSE_SPOOL, motherduck_token/MOTHERDUCK_TOKEN (enables the\n" +
      "     self-send), AGENT_WAREHOUSE_SPOOL_MAX_BYTES (default 32 MiB; 0 off),\n" +
      "     AGENT_WAREHOUSE_SPOOL_SEND_RETRY (ms), AGENT_WAREHOUSE_SENDER,\n" +
      "     AGENT_INGEST_MAX_BODY (default 8 MiB), AGENT_INGEST_MAX_ROWS (default 10000)\n",
  );
  process.exit(0);
}

const addr = process.env.AGENT_INGEST_ADDR || "127.0.0.1:8787";
const sep = addr.lastIndexOf(":");
const host = sep > 0 ? addr.slice(0, sep) : "127.0.0.1";
const port = Number(sep > 0 ? addr.slice(sep + 1) : addr);
const token = process.env.AGENT_INGEST_TOKEN || "";
const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const spool =
  process.env.AGENT_WAREHOUSE_SPOOL || path.join(dataHome, "agent-warehouse", "spool.ndjson");
/**
 * An env number, or the default when the variable is absent or not a number.
 * `Number("32MB")` is NaN, and NaN makes every comparison built on it false: a
 * typo in a ceiling would fold on every append and a typo in a delay would never
 * wait. The warning is the only signal the typo gets.
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") { return fallback; }
  const value = Number(raw);
  if (Number.isFinite(value)) { return value; }
  process.stderr.write(
    "agent-warehouse-daemon: " + name + "=" + JSON.stringify(raw) +
      " is not a number; using " + fallback + "\n",
  );
  return fallback;
}

// A single row can carry a whole message content array, so the limit is env-tunable
// and the sync batches under its own budget (AGENT_WAREHOUSE_BATCH_BYTES).
const maxBodyEnv = envNumber("AGENT_INGEST_MAX_BODY", 8 * 1024 * 1024);
const MAX_BODY = maxBodyEnv > 0 ? maxBodyEnv : 8 * 1024 * 1024;
// A body can be eight megabytes of a million tiny rows; the row count bounds
// the per-row work and the loop, the byte ceiling bounds the allocation.
const maxRowsEnv = envNumber("AGENT_INGEST_MAX_ROWS", 10_000);
const MAX_ROWS = maxRowsEnv > 0 ? maxRowsEnv : 10_000;

// The self-send (docs/d217). The threshold is the spool tail the daemon
// tolerates before folding it; the sender's own batch budget is
// AGENT_WAREHOUSE_BATCH_ROWS, so this is a size ceiling, not a batching choice.
// 0 disables it explicitly, and a missing token disables it implicitly — the
// two are reported differently at startup.
const warehouseToken =
  process.env.motherduck_token || process.env.MOTHERDUCK_TOKEN || "";
const spoolMaxBytes = envNumber("AGENT_WAREHOUSE_SPOOL_MAX_BYTES", 32 * 1024 * 1024);
const sendRetryMs = envNumber("AGENT_WAREHOUSE_SPOOL_SEND_RETRY", 60_000);
const senderScript =
  process.env.AGENT_WAREHOUSE_SENDER ||
  fileURLToPath(new URL("./agent-warehouse-spool-send.sh", import.meta.url));

// A re-posted row must not duplicate a line, and the sync re-posts every run.
// The dedupe is a conditional insert: a SQLite PRIMARY KEY with INSERT OR IGNORE
// turns a seen key into a no-op, so it is durable across restarts. The ledger is
// reseeded from the tails on every start, because a crash can leave a line that
// was appended but not recorded; the scan is streamed, not read into memory. An
// in-memory set is the fallback when node:sqlite is unavailable. The key is the
// row's own identity (session id, then entry id), never its file path: the same
// session has a different path inside a sandbox and on the
// host, so a path key would fail to dedupe exactly the duplicate the route creates.
/**
 * A caught value's message, for the stderr lines below: a catch clause hands
 * over unknown, and these lines exist so a failure is readable either way.
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Canonical JSON: sorted object keys, so a re-post with a different key order
 * hashes to the same identity. Arrays keep their order; JSON has no set.
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(
      (key) =>
        JSON.stringify(key) +
        ":" +
        canonicalJson(/** @type {Record<string, unknown>} */ (value)[key]),
    ).join(",") + "}";
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

/** A content identity for a row that carries no id of its own. The hash is
 * stable across spool rotations and direct folds; a line-number key was not
 * (the sender renames the tail to .rm.<pid>, and a direct fold renumbers the
 * same row on every run), so the warehouse stored a new copy each time. */
/**
 * @param {any} row
 * @returns {string}
 */
function rowHash(row) {
  return crypto.createHash("sha256").update(canonicalJson(row)).digest("hex");
}

/**
 * @param {any} row
 * @returns {string}
 */
function rowKey(row) {
  if (row && typeof row === "object") {
    // A foreign harness mints its own ids, so its key carries the source: the
    // same id string from two harnesses is two rows, and a vibe legacy entry is
    // identified by message_id (docs/d221). pi keeps the key spelling below —
    // a daemon upgrading in place must not re-accept a row seen.sqlite holds.
    if (row.source && row.source !== "pi") {
      const sid = row.session_id ?? "";
      if (row.id) { return JSON.stringify(["entry", row.source, sid, row.id]); }
      if (row.message_id) { return JSON.stringify(["message", row.source, sid, row.message_id]); }
      return JSON.stringify(["row", row.source, rowHash(row)]);
    }
    if (row.session_id && row.id) { return JSON.stringify(["entry", row.session_id, row.id]); }
    if (row.session_id) { return JSON.stringify(["session", row.session_id]); }
    if (row.session_file && row.id) { return JSON.stringify(["entry", row.session_file, row.id]); }
    if (row.session_file) { return JSON.stringify(["session", row.session_file]); }
  }
  return JSON.stringify(["raw", rowHash(row)]);
}

/**
 * @param {string} line
 * @returns {string}
 */
function lineKey(line) {
  try {
    return rowKey(JSON.parse(line));
  } catch {
    return JSON.stringify(["raw-line", crypto.createHash("sha256").update(line).digest("hex")]);
  }
}

fs.mkdirSync(path.dirname(spool), { recursive: true, mode: 0o700 });
// Tighten the default store directory if it predates this daemon. A custom
// spool's parent is the operator's; chmod on a shared parent such as /tmp is not
// this process's decision.
if (path.basename(path.resolve(path.dirname(spool))) === "agent-warehouse") {
  try { fs.chmodSync(path.dirname(spool), 0o700); } catch { /* not ours */ }
}

/**
 * A crash can leave the tail without its final newline. Treat the partial row as
 * a line of its own: the next append then starts cleanly and the sender reports
 * the malformed line instead of merging it into a later row.
 */
/**
 * @param {string} file
 * @returns {void}
 */
function repairPartialTail(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return; }
  if (stat.size === 0) { return; }
  const fd = fs.openSync(file, "r");
  const last = Buffer.alloc(1);
  try { fs.readSync(fd, last, 0, 1, stat.size - 1); } finally { fs.closeSync(fd); }
  if (last[0] !== 0x0a) {
    fs.appendFileSync(file, "\n", { mode: 0o600 });
    process.stderr.write(
      "agent-warehouse-daemon: " + file + " ended mid-line; appended a newline so" +
        " the partial row is reported rather than merged\n",
    );
  }
}
repairPartialTail(spool);

/** @type {any} */
let sqliteDb = null;
/** @type {(key: string) => boolean} */
let hasSeen;
/** @type {(key: string) => void} */
let rememberSeen;
try {
  const { DatabaseSync } = await import("node:sqlite");
  sqliteDb = new DatabaseSync(path.join(path.dirname(spool), "seen.sqlite"));
  sqliteDb.exec("PRAGMA journal_mode=WAL");
  sqliteDb.exec("PRAGMA synchronous=NORMAL");
  sqliteDb.exec("PRAGMA busy_timeout=10000");
  sqliteDb.exec("CREATE TABLE IF NOT EXISTS seen(key TEXT PRIMARY KEY)");
  const has = sqliteDb.prepare("SELECT 1 AS n FROM seen WHERE key = ?");
  const insert = sqliteDb.prepare("INSERT OR IGNORE INTO seen(key) VALUES(?)");
  hasSeen = (key) => has.get(key) !== undefined;
  rememberSeen = (key) => { insert.run(key); };
} catch (error) {
  // A durability downgrade is loud: without node:sqlite a restart forgets
  // every key and re-appends rows (the warehouse's first-write-wins absorbs
  // them, but the spool doubles).
  const seen = new Set();
  hasSeen = (key) => seen.has(key);
  rememberSeen = (key) => { seen.add(key); };
  process.stderr.write(
    "agent-warehouse-daemon: node:sqlite unavailable (" + messageOf(error) +
      "); dedupe is in memory and will not survive a restart\n",
  );
}

/**
 * Seed the ledger from every tail the sender still globs: the live spool and a
 * leftover frozen tail. Reading line by line keeps startup memory bounded by a
 * line, not by a hundreds-of-MiB backlog. Seeding every start, not only an
 * empty ledger, is what repairs a ledger that missed a line after a crash.
 * @param {string} file
 */
async function seedSeen(file) {
  if (!fs.existsSync(file)) { return; }
  const lines = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (line.trim() === "") { continue; }
    try {
      rememberSeen(lineKey(line));
    } catch (error) {
      process.stderr.write(
        "agent-warehouse-daemon: cannot seed " + file + ": " + messageOf(error) + "\n",
      );
    }
  }
}

const spoolDir = path.dirname(spool);
const spoolBase = path.basename(spool);
const seedFiles = [spool];
try {
  for (const name of fs.readdirSync(spoolDir)) {
    if (name.startsWith(spoolBase + ".rm.")) { seedFiles.push(path.join(spoolDir, name)); }
  }
} catch {
  // the directory was created just above; a readdir failure is a real error
}
// One transaction for the seed: a per-line autocommit over a large backlog is
// the slowest possible startup, and the whole seed is idempotent.
if (sqliteDb !== null) { sqliteDb.exec("BEGIN"); }
for (const file of seedFiles) { await seedSeen(file); }
if (sqliteDb !== null) { sqliteDb.exec("COMMIT"); }
// Start-up upkeep, not a one-off migration: the ledger only grows, and a
// long-lived daemon should not carry its freelist and WAL into the next run.
if (sqliteDb !== null) {
  try {
    sqliteDb.exec("PRAGMA optimize");
    sqliteDb.exec("VACUUM");
    sqliteDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const keys = sqliteDb.prepare("SELECT count(*) AS n FROM seen").get().n;
    process.stdout.write(
      "agent-warehouse-daemon: dedupe ledger vacuumed (" + keys + " keys)\n",
    );
  } catch (error) {
    process.stderr.write(
      "agent-warehouse-daemon: ledger upkeep failed (" + messageOf(error) +
        "); continuing\n",
    );
  }
}
for (const file of [spool, path.join(spoolDir, "seen.sqlite")]) {
  try { fs.chmodSync(file, 0o600); } catch { /* not created yet */ }
}

// The self-send lives here, not in the request handler, because the append path,
// startup and the retry timer all call it. `pendingBytes` is an estimate that
// avoids a stat per POST; every fold re-measures it against the files, because
// the tail also moves without this process (an operator's --direct sync rotates
// it) and a failed fold leaves it under `spool.rm.<pid>`.
/**
 * Bytes the next fold would consume: the live spool plus every frozen tail the
 * sender still globs. Counting the live path alone would strand a leftover from
 * a killed fold — it can sit under the ceiling forever and never trigger.
 * @returns {number}
 */
function pendingTailBytes() {
  const dir = path.dirname(spool);
  const base = path.basename(spool);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (name !== base && !name.startsWith(base + ".rm.")) { continue; }
    try {
      total += fs.statSync(path.join(dir, name)).size;
    } catch {
      // rotated away between the readdir and the stat
    }
  }
  return total;
}

let pendingBytes = pendingTailBytes();
let sending = false;
let retryAt = 0;
/** @type {NodeJS.Timeout | null} */
let retryTimer = null;
/** @type {import("node:child_process").ChildProcess | null} */
let activeChild = null;
let shuttingDown = false;

// A failed fold ends in this timer, not in the next POST: an idle daemon would
// otherwise leave the tail growing while the backoff expired silently. Unref'd,
// so a pending retry never keeps the process alive.
function armRetry() {
  if (retryTimer) { return; }
  // A hair past the deadline: firing early would send sendSpool() back into the
  // same backoff branch and the timer would have to arm itself twice.
  retryTimer = setTimeout(() => {
    retryTimer = null;
    sendSpool();
  }, Math.max(0, retryAt - Date.now()) + 10);
  retryTimer.unref();
}

/**
 * @param {boolean} [foldAnyTail] fold even under the ceiling. The startup call
 *   sets it so a tail left by an earlier run (frozen ones included) is folded
 *   before it grows further, instead of waiting for a threshold's worth of
 *   appends that may never come.
 */
function sendSpool(foldAnyTail = false) {
  if (!warehouseToken || spoolMaxBytes <= 0 || sending || shuttingDown) { return; }
  if (Date.now() < retryAt) { armRetry(); return; }
  if (!foldAnyTail && pendingBytes < spoolMaxBytes) { return; }
  // One sender at a time is the sender's lock, not this process's: the daemon,
  // an operator and the sync's --direct leg all contend on <spool>.lock. The
  // sender exits 75 when another holds it; that is busy, not a failure.
  sending = true;
  pendingBytes = pendingTailBytes();
  const bytesAtStart = pendingBytes;
  process.stdout.write(
    "agent-warehouse-daemon: spool is " + pendingBytes +
      " bytes, folding it into the warehouse\n",
  );
  const child = spawn("bash", [senderScript, "--spool", spool], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  activeChild = child;
  let finished = false;
  /** @param {number} code */
  const done = (code) => {
    if (finished) { return; }
    finished = true;
    sending = false;
    if (activeChild === child) { activeChild = null; }
    // Measure what is left instead of subtracting what this process counted:
    // rows that landed during the fold are in a NEW spool (the sender froze the
    // old one by renaming it), and a failed fold leaves the whole tail behind as
    // `spool.rm.<pid>`. Both are pending, and both are in the files.
    pendingBytes = pendingTailBytes();
    if (code === 0) {
      process.stdout.write("agent-warehouse-daemon: spool folded\n");
      // Re-trigger only when the fold removed bytes: a sender that reports
      // success without consuming would otherwise call itself forever.
      if (pendingBytes < bytesAtStart) {
        sendSpool();
      } else if (pendingBytes > 0) {
        process.stderr.write(
          "agent-warehouse-daemon: spool folded but " + pendingBytes +
            " bytes remain; not folding again until the next append\n",
        );
      }
    } else if (code === 75) {
      // Another sender (operator, another daemon, a direct sync) holds the
      // shared lock. Do not treat it as a failed fold; wait, then re-measure.
      retryAt = Date.now() + sendRetryMs;
      process.stderr.write(
        "agent-warehouse-daemon: another sender holds " + spool +
          ".lock; retry in " + sendRetryMs + " ms\n",
      );
      armRetry();
    } else {
      // The sender keeps the spool on failure; back off so a host without
      // duckdb does not spawn a child per POST.
      retryAt = Date.now() + sendRetryMs;
      process.stderr.write(
        "agent-warehouse-daemon: spool send failed (" + code +
          "); spool kept, retry in " + sendRetryMs + " ms\n",
      );
      armRetry();
    }
  };
  child.on("error", (error) => {
    process.stderr.write(
      "agent-warehouse-daemon: cannot run " + senderScript +
        " (" + messageOf(error) + ")\n",
    );
    done(1);
  });
  child.on("close", (code) => done(code ?? 1));
}

// RFC 9457 problem details, the same shape the browse daemon answers.
const PROBLEM_BASE = "https://agentcontainer.example/problems/";

/**
 * @param {number} status
 * @param {string} slug
 * @param {string} title
 * @param {string} detail
 * @returns {{type: string, title: string, status: number, detail: string}}
 */
function problem(status, slug, title, detail) {
  return { type: PROBLEM_BASE + slug, title, status, detail };
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} code
 * @param {unknown} obj
 * @param {string} [contentType]
 * @returns {void}
 */
function send(res, code, obj, contentType = "application/json") {
  if (res.writableEnded) { return; }
  try {
    res.writeHead(code, { "content-type": contentType });
    res.end(JSON.stringify(obj) + "\n");
  } catch {
    // The client disconnected between the decision and the write.
  }
}

/** Timing-safe: == leaks the length and the first wrong byte to a client that
 * can measure a wide bind. */
/**
 * @param {string | string[] | undefined} given
 * @returns {boolean}
 */
function tokenMatches(given) {
  if (!token) { return true; }
  const supplied = Buffer.from(typeof given === "string" ? given : "");
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {number} code
 * @param {number} started
 * @param {string} detail
 * @returns {void}
 */
function logRequest(req, code, started, detail) {
  process.stdout.write(
    "agent-warehouse-daemon: " + req.method + " " + (req.url || "") + " " + code +
      " " + (Date.now() - started) + "ms" + (detail ? " " + detail : "") + "\n",
  );
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const respond = (
    /** @type {number} */ code,
    /** @type {unknown} */ obj,
    /** @type {string} */ detail = "",
    /** @type {string} */ contentType = "application/json",
  ) => {
    if (res.writableEnded) { return; }
    send(res, code, obj, contentType);
    logRequest(req, code, started, detail);
  };
  const respondProblem = (
    /** @type {number} */ code,
    /** @type {string} */ slug,
    /** @type {string} */ title,
    /** @type {string} */ detail,
  ) =>
    respond(code, problem(code, slug, title, detail), detail, "application/problem+json");
  try {
    if (req.method !== "POST") {
      respondProblem(
        405, "method-not-allowed", "Method not allowed",
        "this route is write-only: POST /ingest/session",
      );
      return;
    }
    if (req.url !== "/ingest/session") {
      respondProblem(404, "not-found", "Not found", "unknown path");
      return;
    }
    if (!tokenMatches(req.headers["x-ingest-token"])) {
      respondProblem(401, "unauthorized", "Unauthorized", "missing or bad token");
      return;
    }
    let size = 0;
    let tooLarge = false;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => {
      if (tooLarge) { return; }
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        respondProblem(413, "payload-too-large", "Payload too large", "body too large");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () =>
      respondProblem(400, "interface-error", "Interface error", "request read failed"),
    );
    req.on("end", () => {
      if (tooLarge || res.writableEnded) { return; }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        respondProblem(400, "interface-error", "Interface error", "empty body");
        return;
      }
      let rows;
      try {
        const parsed = JSON.parse(text);
        rows = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        respondProblem(400, "interface-error", "Interface error", "invalid json");
        return;
      }
      if (rows.length > MAX_ROWS) {
        respondProblem(413, "payload-too-large", "Payload too large", "too many rows");
        return;
      }
      const fresh = [];
      const freshKeys = new Set();
      let duplicates = 0;
      try {
        for (const row of rows) {
          const key = rowKey(row);
          if (freshKeys.has(key) || hasSeen(key)) {
            duplicates++;
            continue;
          }
          freshKeys.add(key);
          fresh.push({ row, key });
        }
      } catch (error) {
        process.stderr.write(
          "agent-warehouse-daemon: cannot compute a row identity: " +
            messageOf(error) + "\n",
        );
        respondProblem(400, "interface-error", "Interface error", "unidentifiable row");
        return;
      }
      if (fresh.length > 0) {
        const lines = fresh.map((item) => JSON.stringify(item.row)).join("\n") + "\n";
        try {
          // WHY append-by-path, never a held fd: the sender rotates the spool by
          // renaming it (mv spool spool.rm.<pid>). Because this open targets the PATH on
          // every append, the next write creates a fresh spool and the daemon follows the
          // rotation with no signal. A persistent fs.createWriteStream would keep writing
          // the renamed inode and silently break the sender's delete-after-consume.
          fs.appendFileSync(spool, lines, { mode: 0o600 });
        } catch (error) {
          process.stderr.write(
            "agent-warehouse-daemon: cannot append to " + spool + ": " +
              messageOf(error) + "\n",
          );
          respondProblem(
            500, "store-error", "Store error", "cannot append to the spool",
          );
          return;
        }
        // Record the keys only after the append: marking first would let a
        // disk-full append lose the rows forever, because the replay is then
        // answered as a duplicate. A ledger write that fails after a successful
        // append is the safe direction (a replay may duplicate the spool line,
        // and the warehouse's first-write-wins absorbs it).
        try {
          for (const item of fresh) { rememberSeen(item.key); }
        } catch (error) {
          process.stderr.write(
            "agent-warehouse-daemon: cannot record dedupe keys: " +
              messageOf(error) + "\n",
          );
        }
        pendingBytes += Buffer.byteLength(lines);
        sendSpool();
      }
      respond(
        200,
        { accepted: fresh.length, duplicates },
        "accepted=" + fresh.length + " duplicates=" + duplicates,
      );
    });
  } catch (error) {
    process.stderr.write(
      "agent-warehouse-daemon: handler failed: " +
        (error instanceof Error ? (error.stack ?? messageOf(error)) : String(error)) +
        "\n",
    );
    respondProblem(500, "internal-error", "Internal error", "the request failed");
  }
});

const loopbackHost = host === "127.0.0.1" || host === "::1" ||
  host === "localhost" || host === "[::1]";
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  process.stderr.write("agent-warehouse-daemon: bad AGENT_INGEST_ADDR " + JSON.stringify(addr) + "\n");
  process.exit(64);
}
// The write gate is the whole boundary on a wide bind: without a token every
// peer that can reach the port can append rows. Refuse to start rather than
// look like a diode while being an open sink.
if (!loopbackHost && !token) {
  process.stderr.write(
    "agent-warehouse-daemon: AGENT_INGEST_ADDR=" + JSON.stringify(addr) +
      " binds a non-loopback address without AGENT_INGEST_TOKEN; refusing to" +
      " expose an unauthenticated write route\n",
  );
  process.exit(78);
}
if (!token) {
  process.stdout.write(
    "agent-warehouse-daemon: no AGENT_INGEST_TOKEN - any local process can post" +
      " to this route; set one whenever the bind is wider than loopback\n",
  );
}
server.headersTimeout = 30_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 100;
// A local route still must not let a stalled peer hold thousands of sockets;
// the event loop is single-threaded, but the accept queue and file descriptors
// are not free.
server.maxConnections = 64;
server.on("error", (error) => {
  process.stderr.write("agent-warehouse-daemon: server error: " + messageOf(error) + "\n");
  process.exit(1);
});
server.listen(port, host, () => {
  process.stdout.write(
    "agent-warehouse-daemon listening on http://" + host + ":" + port +
      " spool=" + spool + " max_body=" + MAX_BODY + " max_rows=" + MAX_ROWS + "\n",
  );
  if (!warehouseToken) {
    process.stdout.write(
      "agent-warehouse-daemon: no motherduck_token — spool self-send is off; run agent-warehouse-spool-send.sh\n",
    );
  } else if (spoolMaxBytes <= 0) {
    process.stdout.write(
      "agent-warehouse-daemon: AGENT_WAREHOUSE_SPOOL_MAX_BYTES=0 — spool self-send is off\n",
    );
  } else {
    // Fold whatever the previous run left, over the ceiling or not: startup is
    // the one moment nobody is appending, so it is the cheapest fold there is.
    sendSpool(pendingBytes > 0);
  }
});

/**
 * @param {string} signal
 * @returns {void}
 */
function shutdown(signal) {
  if (shuttingDown) { return; }
  shuttingDown = true;
  process.stdout.write("agent-warehouse-daemon: " + signal + " - draining\n");
  const finish = () => {
    if (sqliteDb) {
      try { sqliteDb.close(); } catch { /* already closed */ }
    }
    process.exit(0);
  };
  server.close(() => {
    // A fold is a child writing to the warehouse; let it finish so its lock is
    // removed by done(), not left stale for the next run.
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.once("close", finish);
      const timer = setTimeout(finish, 5000);
      timer.unref();
    } else {
      finish();
    }
  });
  server.closeIdleConnections?.();
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => shutdown(sig));
}
