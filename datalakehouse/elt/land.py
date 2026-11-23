# /// script
# dependencies = ["zstandard"]
# ///
"""
Land one full or delta dump into the stage zone as one immutable batch.

WHY a batch and not a table: the zone's critical requirement is the WRITE path.
Ingest does no reads, no rewrites, no index maintenance and no compaction —
append one file, add its manifest, publish the directory atomically. Every
transform reads the zone and writes somewhere else; nothing writes into a
published batch, so a bad transform is re-runnable and a full dump is a batch
with dump=full rather than a replacement of the log (see README.md here).

WHY schema-less ndjson.zst in the zone: parquet needs a schema, and a landing
zone that enforces one turns every producer drift into a rewrite of history.
Compressed NDJSON accepts whatever the source emitted and the schema is decided
by the transform that reads it.

WHY the batch id is the payload hash: a re-sent batch lands on the same
directory name and is answered as already present without a ledger read, so a
producer retry is idempotent by construction rather than by bookkeeping.
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
from datetime import UTC, datetime
from pathlib import Path

import zstandard as zstd


def canonical(obj) -> bytes:
    """One spelling per value, so the same input always mints the same batch id."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def log(event: str, **kw):
    record = {"ts": datetime.now(UTC).isoformat(), "event": event}
    record.update(kw)
    sys.stderr.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def expand_inputs(paths, suffix):
    files = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            files.extend(sorted(p for p in path.iterdir() if p.suffix == suffix))
        elif path.is_file():
            files.append(path)
        else:
            raise SystemExit("land: no such input: " + raw)
    return files


def row_for(path: Path, kind: str, key_field: str) -> dict:
    """One zone row: the source record verbatim, plus the identity the transform dedupes on."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if key_field not in payload:
        raise SystemExit("land: " + str(path) + " has no " + repr(key_field) + " field")
    return {
        "kind": kind,
        "key": str(payload[key_field]),
        "row_hash": hashlib.sha256(canonical(payload)).hexdigest(),
        "payload": payload,
    }


def newest_full(zone: Path):
    """The full batch a delta continues: recorded for lineage, ignored by dedupe."""
    best = None
    for manifest in zone.glob("**/dump=full/*/*/manifest.json"):
        data = json.loads(manifest.read_text(encoding="utf-8"))
        candidate = (data.get("received_at", ""), data["batch_id"])
        if best is None or candidate > best:
            best = candidate
    return best[1] if best else None


def main():
    ap = argparse.ArgumentParser(description="land a dump into the stage zone")
    ap.add_argument("inputs", nargs="+", help="files or directories to land")
    ap.add_argument("--zone", default=str(Path(__file__).parent / "zone"))
    ap.add_argument("--source", required=True, help="producing system, e.g. hf-papers")
    ap.add_argument("--kind", required=True, help="row kind, e.g. arxiv.paper")
    ap.add_argument("--key-field", default="id", help="payload field holding the natural key")
    ap.add_argument("--suffix", default=".json", help="input file suffix")
    ap.add_argument("--dump", choices=["full", "delta"], default="delta")
    ap.add_argument("--schema-version", type=int, default=1)
    args = ap.parse_args()

    zone = Path(args.zone).resolve()
    files = expand_inputs(args.inputs, args.suffix)
    if not files:
        raise SystemExit("land: no input files")

    rows = [row_for(path, args.kind, args.key_field) for path in files]
    body = b"".join(canonical(row) + b"\n" for row in rows)
    batch_id = hashlib.sha256(body).hexdigest()
    received_at = datetime.now(UTC).isoformat()
    batch_dir = (zone / args.source / args.kind / ("dump=" + args.dump)
                 / ("dt=" + received_at[:10]) / batch_id)

    if batch_dir.is_dir():
        log("batch_present", batch_id=batch_id, rows=len(rows), path=str(batch_dir))
        return

    manifest = {
        "batch_id": batch_id,
        "source": args.source,
        "kind": args.kind,
        "dump": args.dump,
        "base_batch": newest_full(zone) if args.dump == "delta" else None,
        "schema_version": args.schema_version,
        "received_at": received_at,
        "rows": len(rows),
        "keys": len({row["key"] for row in rows}),
        "payload_bytes": len(body),
        "payload_sha256": batch_id,
        "inputs": {"roots": args.inputs, "files": len(files)},
    }

    staging = zone / ".tmp" / batch_id
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    (staging / "data.ndjson.zst").write_bytes(zstd.ZstdCompressor(level=12).compress(body))
    # The manifest is written beside the data inside the directory that is
    # renamed into place, so a visible batch is always complete: its row count
    # and hash are checkable before any transform trusts it.
    (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    batch_dir.parent.mkdir(parents=True, exist_ok=True)
    os.rename(staging, batch_dir)

    log("batch_landed", batch_id=batch_id, rows=len(rows), bytes=len(body), path=str(batch_dir))


if __name__ == "__main__":
    main()
