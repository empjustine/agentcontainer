# /// script
# dependencies = ["duckdb", "zstandard"]
# ///
"""
Transform the stage zone into the staging ledger and the cold columnar store.

WHY two outputs and not one: the sqlite file is *staging* — raw zone rows,
append-only, one row per (batch, key), replayable — and the parquet files are
*cold* — deduped, promoted, sorted, and rebuildable at any time from staging.
Only the zone is authoritative; a transform bug costs a re-run, never data.

WHY the dedupe is "last batch wins": the zone is a log of dumps, so the newest
row for a natural key is the producer's newest statement about it. Ordering is
the ledger sequence, not wall-clock: two batches landed in the same second must
still resolve the same way on every run.
"""

import argparse
import hashlib
import json
import sqlite3
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import duckdb
import zstandard as zstd

LEDGER_SQL = """
CREATE TABLE IF NOT EXISTS batch(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL, kind TEXT NOT NULL,
  dump TEXT NOT NULL, base_batch TEXT,
  schema_version INTEGER NOT NULL, received_at TEXT NOT NULL,
  rows INTEGER NOT NULL, payload_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stage_row(
  batch_seq INTEGER NOT NULL,
  kind TEXT NOT NULL, key TEXT NOT NULL,
  row_hash TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(batch_seq, kind, key));
"""


def log(event: str, **kw):
    record = {"ts": datetime.now(UTC).isoformat(), "event": event}
    record.update(kw)
    sys.stderr.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def read_batch(batch_dir: Path) -> tuple[dict, list[dict]]:
    """Read and verify one batch. A batch whose hash or count disagrees is corrupt."""
    manifest = json.loads((batch_dir / "manifest.json").read_text(encoding="utf-8"))
    raw = zstd.ZstdDecompressor().decompress((batch_dir / "data.ndjson.zst").read_bytes())
    if hashlib.sha256(raw).hexdigest() != manifest["payload_sha256"]:
        raise SystemExit("transform: payload hash mismatch in " + str(batch_dir))
    rows = [json.loads(line) for line in raw.splitlines() if line]
    if len(rows) != manifest["rows"]:
        raise SystemExit("transform: row count mismatch in " + str(batch_dir))
    return manifest, rows


def stage(zone: Path, ledger: Path) -> int:
    """Append unseen batches to the ledger; return how many were new."""
    con = sqlite3.connect(ledger)
    con.executescript(LEDGER_SQL)
    seen = {row[0] for row in con.execute("SELECT batch_id FROM batch")}
    manifests = []
    for path in zone.glob("**/manifest.json"):
        manifests.append((json.loads(path.read_text(encoding="utf-8")), path.parent))
    manifests.sort(key=lambda item: (item[0]["received_at"], item[0]["batch_id"]))

    added = 0
    for manifest, batch_dir in manifests:
        if manifest["batch_id"] in seen:
            continue
        manifest, rows = read_batch(batch_dir)
        with con:
            cur = con.cursor()
            cur.execute(
                "INSERT INTO batch(batch_id, source, kind, dump, base_batch, schema_version,"
                " received_at, rows, payload_sha256) VALUES(?,?,?,?,?,?,?,?,?)",
                (manifest["batch_id"], manifest["source"], manifest["kind"], manifest["dump"],
                 manifest["base_batch"], manifest["schema_version"], manifest["received_at"],
                 manifest["rows"], manifest["payload_sha256"]))
            seq = cur.lastrowid
            cur.executemany(
                "INSERT INTO stage_row(batch_seq, kind, key, row_hash, payload) VALUES(?,?,?,?,?)",
                [(seq, row["kind"], row["key"], row["row_hash"], json.dumps(row["payload"], ensure_ascii=False))
                 for row in rows])
        log("batch_staged", batch_id=manifest["batch_id"], seq=seq, rows=len(rows))
        added += 1
    con.close()
    return added


def newest_rows(ledger: Path) -> list[dict]:
    """One row per (kind, key): the statement from the highest ledger sequence."""
    con = sqlite3.connect(ledger)
    con.row_factory = sqlite3.Row
    rows = con.execute("""
        SELECT kind, key, payload, row_hash, batch_seq FROM (
          SELECT kind, key, payload, row_hash, batch_seq,
                 ROW_NUMBER() OVER (PARTITION BY kind, key ORDER BY batch_seq DESC) AS rank
          FROM stage_row)
        WHERE rank = 1""").fetchall()
    con.close()
    return [dict(row) for row in rows]


def promote(row: dict) -> dict:
    """Fixed column set, so the cold schema is decided here and not by input drift."""
    payload = json.loads(row["payload"])
    return {
        "arxiv_id": row["key"],
        "title": payload.get("title"),
        "published_at": payload.get("published_at"),
        "upvotes": payload.get("upvotes"),
        "comments": payload.get("comments"),
        "github_repo": payload.get("github_repo"),
        "github_stars": payload.get("github_stars"),
        "project_page": payload.get("project_page"),
        "organization": payload.get("organization"),
        "num_total_models": payload.get("num_total_models"),
        "num_total_datasets": payload.get("num_total_datasets"),
        "ai_summary": payload.get("ai_summary"),
        "row_hash": row["row_hash"],
        "batch_seq": row["batch_seq"],
        "payload": row["payload"],
    }


def links(rows: list[dict]) -> list[dict]:
    """The graph the cold store keeps beside the paper: HF models, datasets, spaces, the repo."""
    out = []
    for row in rows:
        payload = json.loads(row["payload"])
        for rel, field, extra in (
                ("model", "linked_models", ("downloads", "likes")),
                ("dataset", "linked_datasets", ("downloads", "likes")),
                ("space", "linked_spaces", ())):
            for target in payload.get(field) or []:
                if not isinstance(target, dict) or "id" not in target:
                    continue
                out.append({"arxiv_id": row["key"], "rel": rel, "target": target["id"],
                            **{name: target.get(name) for name in extra}})
        if payload.get("github_repo"):
            out.append({"arxiv_id": row["key"], "rel": "github", "target": payload["github_repo"],
                        "downloads": None, "likes": None})
    return out


def write_parquet(rows: list[dict], out: Path) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False, encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        tmp = handle.name
    con = duckdb.connect()
    con.execute("COPY (SELECT * FROM read_json_auto('" + tmp + "')) TO '" + str(out) +
                "' (FORMAT PARQUET, COMPRESSION ZSTD)")
    written = con.execute("SELECT count(*) FROM read_parquet('" + str(out) + "')").fetchone()
    con.close()
    Path(tmp).unlink()
    return written[0] if written else 0


def main():
    here = Path(__file__).parent
    ap = argparse.ArgumentParser(description="zone -> staging ledger -> cold parquet")
    ap.add_argument("--zone", default=str(here / "zone"))
    ap.add_argument("--staging", default=str(here / "staging" / "staging.db"))
    ap.add_argument("--cold", default=str(here / "cold"))
    args = ap.parse_args()

    zone, ledger, cold = Path(args.zone), Path(args.staging), Path(args.cold)
    ledger.parent.mkdir(parents=True, exist_ok=True)

    added = stage(zone, ledger)
    rows = newest_rows(ledger)
    if not rows:
        raise SystemExit("transform: nothing in the zone")

    papers = [promote(row) for row in rows]
    paper_count = write_parquet(papers, cold / "arxiv" / "entries.parquet")
    link_rows = links([row for row in rows])
    link_count = write_parquet(link_rows, cold / "arxiv" / "links.parquet") if link_rows else 0

    log("transform_done", new_batches=added, staged_rows=len(rows),
        papers=paper_count, links=link_count,
        entries=str(cold / "arxiv" / "entries.parquet"),
        entries_bytes=(cold / "arxiv" / "entries.parquet").stat().st_size)


if __name__ == "__main__":
    main()
