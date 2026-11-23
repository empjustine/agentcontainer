# /// script
# dependencies = ["duckdb"]
# ///
"""
Union the hot level and the cold level in one duckdb query.

WHY there is no cross-source index: duckdb already unions a hot sqlite store
(ATTACH ... TYPE sqlite) with a cold parquet glob, so a "canonical index" would
be a second copy of an answer duckdb computes. Tier precedence is the only rule
the query adds: a row still in the hot level wins over the same key in cold.
"""

import argparse
import os
import sys
from pathlib import Path

import duckdb

HERE = Path(__file__).parent
SQL = """
WITH hot_level AS (
  -- Rows of the newest landed batch are still hot; older ones were demoted.
  SELECT key AS arxiv_id, json_extract_string(payload, '$.title') AS title,
         CAST(json_extract(payload, '$.upvotes') AS BIGINT) AS upvotes, 'hot' AS tier
  FROM hot.stage_row
  WHERE batch_seq = (SELECT max(seq) FROM hot.batch)
), cold_level AS (
  SELECT arxiv_id, title, upvotes, 'cold' AS tier
  FROM read_parquet('COLD/entries.parquet')
  WHERE batch_seq < (SELECT max(seq) FROM hot.batch)
), merged AS (
  SELECT * FROM hot_level UNION ALL SELECT * FROM cold_level
)
SELECT arxiv_id, tier, upvotes, title
FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY arxiv_id ORDER BY tier = 'hot' DESC) AS rank FROM merged)
WHERE rank = 1 AND title ILIKE ?
ORDER BY upvotes DESC NULLS LAST
LIMIT ?"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("term", nargs="?", default="%")
    ap.add_argument("--limit", type=int, default=5)
    ap.add_argument("--staging", default=str(HERE / "staging" / "staging.db"))
    ap.add_argument("--cold", default=str(HERE / "cold"))
    args = ap.parse_args()

    cold = Path(args.cold) / "arxiv" / "entries.parquet"
    if not cold.exists():
        sys.exit("query: run transform.py first")

    con = duckdb.connect()
    con.execute("ATTACH '" + os.path.abspath(args.staging) + "' AS hot (TYPE sqlite, READ_ONLY)")
    sql = SQL.replace("COLD", str(cold.parent))
    rows = con.execute(sql, ["%" + args.term.strip("%") + "%", args.limit]).fetchall()
    for arxiv_id, tier, upvotes, title in rows:
        print(f"{arxiv_id}\t{tier}\t{upvotes}\t{(title or '')[:70]}")
    print("---", len(rows), "row(s)", file=sys.stderr)


if __name__ == "__main__":
    main()
