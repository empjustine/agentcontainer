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
// Env: AGENT_INGEST_ADDR (default 127.0.0.1:8787), AGENT_INGEST_TOKEN,
//      AGENT_WAREHOUSE_SPOOL.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(
    "usage: agent-warehouse-daemon.sh\n" +
      "  POST /ingest/session   append one JSON row, or a JSON array of rows\n" +
      "env: AGENT_INGEST_ADDR (default 127.0.0.1:8787), AGENT_INGEST_TOKEN,\n" +
      "     AGENT_WAREHOUSE_SPOOL\n",
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
// A single row can carry a whole message content array, so the limit is env-tunable
// and the sync batches under its own budget (AGENT_WAREHOUSE_BATCH_BYTES).
const MAX_BODY = Number(process.env.AGENT_INGEST_MAX_BODY || 8 * 1024 * 1024);

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
      fs.appendFileSync(spool, lines);
    }
    send(res, 200, { accepted: fresh.length, duplicates });
  });
});

server.listen(port, host, () => {
  process.stdout.write(
    `agent-warehouse-daemon listening on http://${host}:${port} spool=${spool}\n`,
  );
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

