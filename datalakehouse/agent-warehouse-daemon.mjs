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
//      AGENT_WAREHOUSE_SPOOL,
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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(
    "usage: agent-warehouse-daemon.sh\n" +
      "  POST /ingest/session   append one JSON row, or a JSON array of rows\n" +
      "env: AGENT_INGEST_ADDR (default 127.0.0.1:8787), AGENT_INGEST_TOKEN,\n" +
      "     AGENT_WAREHOUSE_SPOOL, motherduck_token/MOTHERDUCK_TOKEN (enables the\n" +
      "     self-send), AGENT_WAREHOUSE_SPOOL_MAX_BYTES (default 32 MiB; 0 off),\n" +
      "     AGENT_WAREHOUSE_SPOOL_SEND_RETRY (ms), AGENT_WAREHOUSE_SENDER\n",
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
const MAX_BODY = envNumber("AGENT_INGEST_MAX_BODY", 8 * 1024 * 1024);

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
// turns a seen key into a no-op (changes === 0), so it is durable across restarts
// and needs no startup scan. An in-memory set is the fallback when node:sqlite is
// unavailable. The key is the row's own identity (session id, then entry id), never
// its file path: the same session has a different path inside a sandbox and on the
// host, so a path key would fail to dedupe exactly the duplicate the route creates.
function rowKey(row) {
  if (row && typeof row === "object") {
    if (row.session_id && row.id) { return JSON.stringify(["entry", row.session_id, row.id]); }
    if (row.session_id) { return JSON.stringify(["session", row.session_id]); }
    if (row.session_file && row.id) { return JSON.stringify(["entry", row.session_file, row.id]); }
    if (row.session_file) { return JSON.stringify(["session", row.session_file]); }
  }
  return JSON.stringify(["raw", row]);
}

let isNew;
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(path.dirname(spool), "seen.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS seen(key TEXT PRIMARY KEY)");
  const insert = db.prepare("INSERT OR IGNORE INTO seen(key) VALUES(?)");
  isNew = (key) => insert.run(key).changes > 0;
  // Seed once from an existing spool, or a pre-upgrade spool would re-append.
  const seeded = db.prepare("SELECT count(*) AS n FROM seen").get().n;
  if (seeded === 0 && fs.existsSync(spool)) {
    db.exec("BEGIN");
    for (const line of fs.readFileSync(spool, "utf8").split("\n")) {
      if (line.trim() === "") { continue; }
      let key;
      try {
        key = rowKey(JSON.parse(line));
      } catch {
        key = line;
      }
      insert.run(key);
    }
    db.exec("COMMIT");
  }
} catch {
  const seen = new Set();
  isNew = (key) => {
    if (seen.has(key)) { return false; }
    seen.add(key);
    return true;
  };
}

fs.mkdirSync(path.dirname(spool), { recursive: true });

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
let retryTimer = null;
let lockBlocked = false;

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
  if (!warehouseToken || spoolMaxBytes <= 0 || sending) { return; }
  if (Date.now() < retryAt) { armRetry(); return; }
  if (!foldAnyTail && pendingBytes < spoolMaxBytes) { return; }
  // One sender at a time. The lock also covers the daemon's own double trigger
  // (a POST landing while the previous child is closing). A stale lock from a
  // killed daemon is removed by hand: guessing at liveness is worse than a
  // loud, resumable stop — but the skip is still reported once, so folding that
  // silently stops is distinguishable from folding with nothing to do.
  const lockPath = spool + ".lock";
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, "wx");
  } catch {
    if (!lockBlocked) {
      lockBlocked = true;
      process.stderr.write(
        "agent-warehouse-daemon: " + lockPath +
          " is held; not folding (remove a stale lock by hand)\n",
      );
    }
    return;
  }
  lockBlocked = false;
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
  let finished = false;
  /** @param {number} code */
  const done = (code) => {
    if (finished) { return; }
    finished = true;
    sending = false;
    fs.closeSync(lockFd);
    fs.rmSync(lockPath, { force: true });
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
        " (" + error.message + ")\n",
    );
    done(1);
  });
  child.on("close", (code) => done(code ?? 1));
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(`${JSON.stringify(obj)}\n`);
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    send(res, 405, { error: "this route is write-only: POST /ingest/session" });
    return;
  }
  if (req.url !== "/ingest/session") {
    send(res, 404, { error: "unknown path" });
    return;
  }
  if (token && req.headers["x-ingest-token"] !== token) {
    send(res, 401, { error: "missing or bad token" });
    return;
  }
  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      send(res, 413, { error: "body too large" });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (res.writableEnded) { return; }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) {
      send(res, 400, { error: "empty body" });
      return;
    }
    let rows;
    try {
      const parsed = JSON.parse(text);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      send(res, 400, { error: "invalid json" });
      return;
    }
    const fresh = [];
    let duplicates = 0;
    for (const r of rows) {
      if (isNew(rowKey(r))) {
        fresh.push(r);
      } else {
        duplicates++;
      }
    }
    if (fresh.length > 0) {
      const lines = `${fresh.map((r) => JSON.stringify(r)).join("\n")}\n`;
      // WHY append-by-path, never a held fd: the sender rotates the spool by
      // renaming it (mv spool spool.rm.<pid>). Because this open targets the PATH on
      // every append, the next write creates a fresh spool and the daemon follows the
      // rotation with no signal. A persistent fs.createWriteStream would keep writing
      // the renamed inode and silently break the sender's delete-after-consume.
      fs.appendFileSync(spool, lines);
      pendingBytes += Buffer.byteLength(lines);
      sendSpool();
    }
    send(res, 200, { accepted: fresh.length, duplicates });
  });
});

server.listen(port, host, () => {
  process.stdout.write(
    `agent-warehouse-daemon listening on http://${host}:${port} spool=${spool}\n`,
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

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

