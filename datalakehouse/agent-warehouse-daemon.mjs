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
const MAX_BODY = 8 * 1024 * 1024;

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
    const lines = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    fs.appendFileSync(spool, lines);
    send(res, 200, { accepted: rows.length });
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

