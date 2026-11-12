#!/bin/bash
# agent-warehouse-spool-send — the spool collector: spool -> MotherDuck, streamed.
#
# WHY its own tool, not a sync flag (d180/d181): generating spool rows (a session
# sweep over the filesystem, from the daemon's route or a host walk) and folding the
# spool into the warehouse are two jobs with different inputs, triggers and failure
# modes. One script with modal flags had to hold both, and its read path fed the
# whole spool to read_json.
#
# WHY streaming: a pending spool can be hundreds of MiB, and a single read_json over
# it holds it in the engine and in a temp file. This reads a bounded batch, upserts
# it, and advances, so memory is the batch, not the spool. The upsert is idempotent,
# so an interrupted run re-reads from the start and no row is doubled.
#
# WHY rotate first: the daemon keeps appending. Moving the live tail aside freezes
# what this run consumes, and a concurrent append lands in a fresh file. The frozen
# file is deleted only after it is fully consumed and acked.
#
# Usage: agent-warehouse-spool-send.sh [--spool FILE] [--db NAME] [--batch-rows N]
#                                      [--keep] [--dry] [--print-rows]
# Env: motherduck_token · AGENT_WAREHOUSE_DB (default agent)
#      AGENT_WAREHOUSE_SPOOL (default XDG data dir/agent-warehouse/spool.ndjson)
#      AGENT_WAREHOUSE_BATCH_ROWS (default 5000)
# Needs: duckdb v1.4-v1.5 (./dev-tools.sh duckdb), jq.
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
usage: agent-warehouse-spool-send.sh [--spool FILE] [--db NAME] [--batch-rows N]
                                     [--keep] [--dry] [--print-rows]
  --spool FILE       spool to consume (default AGENT_WAREHOUSE_SPOOL)
  --db NAME          target MotherDuck database (default AGENT_WAREHOUSE_DB, else agent)
  --batch-rows N     rows per upsert batch (default 5000)
  --keep             do not delete a spool file after folding it
  --dry              normalise and count, write and delete nothing (no token)
  --print-rows       print the normalised rows, write and delete nothing (no token)
env: motherduck_token · AGENT_WAREHOUSE_DB · AGENT_WAREHOUSE_SPOOL · AGENT_WAREHOUSE_BATCH_ROWS
EOF
}

env_or() { # $1 = var name, $2 = default
	local v
	v=$(printenv "$1" 2>/dev/null || true)
	if [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "$2"; fi
}

SPOOL=""
DB=""
BATCH_ROWS=""
KEEP=0
DRY=0
PRINT_ROWS=0
while [ $# -gt 0 ]; do
	case "$1" in
	--spool | --db | --batch-rows)
		[ $# -ge 2 ] || { echo "flag needs a value: $1" >&2; exit 64; }
		case "$1" in
		--spool) SPOOL="$2" ;;
		--db) DB="$2" ;;
		--batch-rows) BATCH_ROWS="$2" ;;
		esac
		shift 2
		;;
	--keep) KEEP=1; shift ;;
	--dry) DRY=1; shift ;;
	--print-rows) PRINT_ROWS=1; shift ;;
	-h | --help) usage; exit 0 ;;
	*) echo "unknown flag: $1" >&2; usage; exit 64 ;;
	esac
done

spool=$(env_or AGENT_WAREHOUSE_SPOOL "")
[ -n "$SPOOL" ] && spool="$SPOOL"
[ -n "$spool" ] || spool=$(env_or XDG_DATA_HOME "$HOME/.local/share")/agent-warehouse/spool.ndjson
warehouse=$(env_or AGENT_WAREHOUSE_DB agent)
[ -n "$DB" ] && warehouse="$DB"
batch_rows=$(env_or AGENT_WAREHOUSE_BATCH_ROWS 5000)
[ -n "$BATCH_ROWS" ] && batch_rows="$BATCH_ROWS"

# A report or dry run must not rotate or delete anything.
side_effects=1
[ "$DRY" = 1 ] && side_effects=0
[ "$PRINT_ROWS" = 1 ] && side_effects=0

# Freeze the live tail under a report/dry guard, so what this run consumes cannot
# race a concurrent daemon append.
if [ "$side_effects" = 1 ] && [ -f "$spool" ]; then
	mv "$spool" "$spool.rm.$$"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
s_rows="$tmp/s.ndjson"
e_rows="$tmp/e.ndjson"
: >"$s_rows"
: >"$e_rows"

# One spool line -> one canonical row. The route is generic, so a row need not be
# in the warehouse shape: a session header stays a session row, an already-canonical
# entry row passes through, anything else becomes an entry with the original object
# kept verbatim as payload.
normalise() { # $1 = line, $2 = index
	printf '%s' "$1" | jq -c --argjson n "$2" 'if (.type == "session") then {session_file:(.session_file // "spool"), store:(.store // "spool"), session_id:(.session_id // .id), cwd:(.cwd // null), version:(.version // null), parent_session:(.parent_session // null), started_at:(.started_at // .timestamp // null)} elif (.id != null and .payload != null) then . else {session_id:(.session_id // ""), session_file:(.session_file // "spool"), store:(.store // "spool"), line_no:(.line_no // $n), id:(.id // ("spool-" + ($n | tostring))), parent_id:(.parent_id // null), type:(.type // null), ts:(.ts // .timestamp // null), payload:.} end' 2>/dev/null
}

token=$(env_or motherduck_token "")
[ -n "$token" ] || token=$(env_or MOTHERDUCK_TOKEN "")

ensure_db() { # DuckDB has no CREATE DATABASE; connecting is the create route.
	local out
	out=$(duckdb "md:$warehouse?motherduck_token=$token" -c 'SELECT 1;' 2>&1) && return 0
	printf '%s\n' "$out" >&2
	return 1
}

# The batch upsert. $1 = session rows to include (0/1), $2 = entry rows to include.
send_batch() { # $1 = include session rows (0/1), $2 = include entry rows (0/1)
	local sql result
	cp "$s_rows" "$tmp/send_s.ndjson"
	cp "$e_rows" "$tmp/send_e.ndjson"
	sql="INSTALL motherduck; LOAD motherduck;
SET motherduck_token='$token';
ATTACH 'md:$warehouse' AS mdw;
CREATE SCHEMA IF NOT EXISTS mdw.pi;
CREATE TABLE IF NOT EXISTS mdw.pi.session(
  session_id VARCHAR PRIMARY KEY, session_file VARCHAR, cwd VARCHAR,
  version INTEGER, parent_session VARCHAR, started_at TIMESTAMP, store VARCHAR);
CREATE TABLE IF NOT EXISTS mdw.pi.entry(
  session_id VARCHAR, session_file VARCHAR, id VARCHAR, parent_id VARCHAR,
  type VARCHAR, ts TIMESTAMP, line_no BIGINT, store VARCHAR, payload JSON,
  PRIMARY KEY (session_id, id));"
	if [ "$1" = 1 ]; then
		sql="$sql
CREATE TEMP TABLE st_s AS SELECT * FROM read_json('$tmp/send_s.ndjson', format='newline_delimited', columns={session_file:'VARCHAR', store:'VARCHAR', session_id:'VARCHAR', cwd:'VARCHAR', version:'BIGINT', parent_session:'VARCHAR', started_at:'VARCHAR'});
INSERT INTO mdw.pi.session (session_id, session_file, cwd, version, parent_session, started_at, store)
  SELECT session_id, session_file, cwd, try_cast(version AS INTEGER), parent_session, try_cast(started_at AS TIMESTAMP), store FROM st_s
  ON CONFLICT (session_id) DO UPDATE SET session_file=excluded.session_file, cwd=excluded.cwd,
    version=excluded.version, parent_session=excluded.parent_session, started_at=excluded.started_at, store=excluded.store;"
	fi
	if [ "$2" = 1 ]; then
		sql="$sql
CREATE TEMP TABLE st_e AS SELECT * FROM read_json('$tmp/send_e.ndjson', format='newline_delimited', columns={session_id:'VARCHAR', session_file:'VARCHAR', store:'VARCHAR', line_no:'BIGINT', id:'VARCHAR', parent_id:'VARCHAR', type:'VARCHAR', ts:'VARCHAR', payload:'JSON'});
INSERT INTO mdw.pi.entry (session_id, session_file, id, parent_id, type, ts, line_no, store, payload)
  SELECT session_id, session_file, id, parent_id, type, try_cast(ts AS TIMESTAMP), line_no, store, payload FROM st_e
  ON CONFLICT (session_id, id) DO UPDATE SET session_file=excluded.session_file, parent_id=excluded.parent_id,
    type=excluded.type, ts=excluded.ts, line_no=excluded.line_no, store=excluded.store, payload=excluded.payload;"
	fi
	sql="$sql
SELECT (SELECT count(*) FROM mdw.pi.session) AS sessions, (SELECT count(*) FROM mdw.pi.entry) AS entries;"
	result=$(duckdb -json -c "$sql") || return 1
	printf 'agent-warehouse-spool-send: batch ok %s\n' "$(printf '%s' "$result" | jq -c . 2>/dev/null || printf '%s' "$result")" >&2
	: >"$s_rows"
	: >"$e_rows"
	return 0
}

files=0
lines=0
batched=0
ensure_done=0
while IFS= read -r f; do
	[ -f "$f" ] || continue
	files=$((files + 1))
	n=0
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		n=$((n + 1))
		lines=$((lines + 1))
		row=$(normalise "$line" "$n") || continue
		[ -n "$row" ] || continue
		if [ "$PRINT_ROWS" = 1 ]; then
			printf '%s\n' "$row"
			continue
		fi
		case "$(printf '%s' "$row" | jq -r 'has("payload")')" in
		true) printf '%s\n' "$row" >>"$e_rows" ;;
		*) printf '%s\n' "$row" >>"$s_rows" ;;
		esac
		batched=$((batched + 1))
		if [ "$DRY" = 0 ] && [ "$batched" -ge "$batch_rows" ]; then
			if [ "$ensure_done" = 0 ]; then ensure_db || { echo 'agent-warehouse-spool-send: cannot reach the warehouse' >&2; exit 1; }; ensure_done=1; fi
			s_have=$([ -s "$s_rows" ] && echo 1 || echo 0)
			e_have=$([ -s "$e_rows" ] && echo 1 || echo 0)
			send_batch "$s_have" "$e_have" || { echo 'agent-warehouse-spool-send: batch failed; spool kept' >&2; exit 1; }
			batched=0
		fi
	done <"$f"
	# the file is fully read and its final batch is sent: it may be deleted
	if [ "$DRY" = 0 ] && [ "$PRINT_ROWS" = 0 ] && [ "$side_effects" = 1 ]; then
		s_have=$([ -s "$s_rows" ] && echo 1 || echo 0)
		e_have=$([ -s "$e_rows" ] && echo 1 || echo 0)
		if [ "$batched" -gt 0 ]; then
			if [ "$ensure_done" = 0 ]; then ensure_db || { echo 'agent-warehouse-spool-send: cannot reach the warehouse' >&2; exit 1; }; ensure_done=1; fi
			send_batch "$s_have" "$e_have" || { echo 'agent-warehouse-spool-send: batch failed; spool kept' >&2; exit 1; }
			batched=0
		fi
		if [ "$KEEP" = 0 ]; then
			rm -f "$f"
		fi
	fi
done < <(printf '%s\n' "$spool" "$spool".rm.* | sort -u)

printf 'agent-warehouse-spool-send: %s file(s), %s line(s)\n' "$files" "$lines" >&2

