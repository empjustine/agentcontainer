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
# it holds it in the engine and in a temp file. This reads a bounded batch, applies
# it, and advances, so memory is the batch, not the spool. The insert is idempotent,
# so an interrupted run re-reads from the start and no row is doubled.
#
# WHY rotate first: the daemon keeps appending. Moving the live tail aside freezes
# what this run consumes, and a concurrent append lands in a fresh file. The frozen
# file is deleted only after it is fully consumed and acked.
#
# WHY every schema lives here (docs/d221): this is the only code that writes to
# MotherDuck (docs/d217), so the sync's --direct leg hands it rows instead of
# carrying a second copy of the DDL, and a harness reader owns no uploader. A
# foreign source's row -- whose promoted shape the sender cannot know -- lands in
# the mdw.harness envelope with its object verbatim; d167's per-source tables are
# defined over those rows when the reader lands.
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
  --batch-rows N     rows per apply batch (default 5000)
  --keep             do not delete a spool file after folding it
  --dry              normalise and count, write and delete nothing (no token)
  --print-rows       print the normalised rows, write and delete nothing (no token)
  a row's source decides its target: absent or "pi" -> mdw.pi, anything else ->
  mdw.harness (docs/d221)
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
pi_s="$tmp/pi_session.ndjson"
pi_e="$tmp/pi_entry.ndjson"
h_s="$tmp/harness_session.ndjson"
h_e="$tmp/harness_entry.ndjson"
: >"$pi_s"
: >"$pi_e"
: >"$h_s"
: >"$h_e"

# One spool line -> [schema, kind, canonical row]. The route is generic, so a row
# need not be in the warehouse shape: a session header stays a session row, an
# already-canonical row passes through, anything else becomes an entry with the
# original object kept verbatim as payload (docs/d167's no-shredding).
#
# A session row is explicit (kind, or pi's header type) for every source, because
# only the producer knows what it sent. pi adds one inferred shape: the canonical
# session row the sweep emits, recognised by its pi session COLUMNS rather than by
# "no entry id" -- a vibe legacy tool row carries a session_id, no message_id and
# no payload, and field absence alone would file it as a header.
#
# An unidentified row is keyed by the spool FILE and its line, never the line
# alone: the fold renames the tail to <spool>.rm.<pid>, so two generations cannot
# mint the same key while a re-read of an interrupted run reproduces it. A clash
# here is a silent drop (ON CONFLICT DO NOTHING), not a visible duplicate.
normalise() { # $1 = line, $2 = line number, $3 = spool file basename
	printf '%s' "$1" | jq -r --argjson n "$2" --arg base "$3" '
    def said_session: (.kind == "session") or (.type == "session");
    def pi_session:
      said_session
      or ((.session_id != null) and (.id == null) and (.payload == null)
          and ((.session_file != null) or (.store != null) or (.version != null)
               or (.parent_session != null) or (.started_at != null)));
    (.source // "pi") as $src
    | if $src == "pi" then
        if pi_session then
          ["pi", "session", {session_file:(.session_file // "spool"), store:(.store // "spool"), session_id:(.session_id // .id), cwd:(.cwd // null), version:(.version // null), parent_session:(.parent_session // null), started_at:(.started_at // .timestamp // null)}]
        elif (.id != null and .payload != null) then
          ["pi", "entry", .]
        else
          ["pi", "entry", {session_id:(.session_id // ""), session_file:(.session_file // "spool"), store:(.store // "spool"), line_no:(.line_no // $n), id:(.id // ("spool-" + $base + "-" + ($n | tostring))), parent_id:(.parent_id // null), type:(.type // null), ts:(.ts // .timestamp // null), payload:.}]
        end
      elif said_session then
        ["harness", "session", {source:$src, session_id:(.session_id // .id // ("spool-" + $base + "-" + ($n | tostring))), parent_session:(.parent_session // null), cwd:(.cwd // null), started_at:(.started_at // .ts // .timestamp // null), payload:.}]
      else
        ["harness", "entry", {source:$src, session_id:(.session_id // ""), id:(.id // .message_id // ("spool-" + $base + "-" + ($n | tostring))), parent_id:(.parent_id // null), seq:(.seq // .line_no // $n), type:(.type // .kind // null), ts:(.ts // .timestamp // null), store:(.store // "spool"), payload:.}]
      end
    | .[0], .[1], (.[2] | tojson)' 2>/dev/null
}

token=$(env_or motherduck_token "")
[ -n "$token" ] || token=$(env_or MOTHERDUCK_TOKEN "")

ensure_db() { # DuckDB has no CREATE DATABASE; connecting is the create route.
	local out
	out=$(duckdb "md:$warehouse?motherduck_token=$token" -c 'SELECT 1;' 2>&1) && return 0
	printf '%s\n' "$out" >&2
	return 1
}

# MotherDuck's extension rejects a client outside its version range with a load
# error that names no fix, so the gate runs before the first batch -- here rather
# than in each caller, because this script is every uploader's only path now.
ensure_done=0
prepare_warehouse() {
	local version short
	version=$(duckdb --version 2>&1 || true)
	case "$version" in
	v1.4.* | v1.5.*) ;;
	*)
		short=$(printf '%s' "$version" | awk '{print $1}')
		printf 'agent-warehouse-spool-send: duckdb %s is outside the v1.4-v1.5 range MotherDuck accepts; run ./dev-tools.sh duckdb\n' "$short" >&2
		exit 69
		;;
	esac
	ensure_db || { echo 'agent-warehouse-spool-send: cannot reach the warehouse' >&2; exit 1; }
	ensure_done=1
}

# The batch apply, over whichever of the four stagings this run filled.
send_batch() {
	local sql result
	cp "$pi_s" "$tmp/send_pi_s.ndjson"
	cp "$pi_e" "$tmp/send_pi_e.ndjson"
	cp "$h_s" "$tmp/send_h_s.ndjson"
	cp "$h_e" "$tmp/send_h_e.ndjson"
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
  PRIMARY KEY (session_id, id));
CREATE SCHEMA IF NOT EXISTS mdw.harness;
CREATE TABLE IF NOT EXISTS mdw.harness.session(
  source VARCHAR, session_id VARCHAR, parent_session VARCHAR, cwd VARCHAR,
  started_at TIMESTAMP, payload JSON, PRIMARY KEY (source, session_id));
CREATE TABLE IF NOT EXISTS mdw.harness.entry(
  source VARCHAR, session_id VARCHAR, id VARCHAR, parent_id VARCHAR, seq BIGINT,
  type VARCHAR, ts TIMESTAMP, store VARCHAR, payload JSON,
  PRIMARY KEY (source, session_id, id));"
	if [ -s "$tmp/send_pi_s.ndjson" ]; then
		sql="$sql
CREATE TEMP TABLE st_pi_s AS SELECT * FROM read_json('$tmp/send_pi_s.ndjson', format='newline_delimited', columns={session_file:'VARCHAR', store:'VARCHAR', session_id:'VARCHAR', cwd:'VARCHAR', version:'BIGINT', parent_session:'VARCHAR', started_at:'VARCHAR'});
-- First-write-wins (docs/d203): re-writing an unchanged session is a new
-- MotherDuck version in failsafe; the path is a location attribute, so the
-- first spelling seen wins.
INSERT INTO mdw.pi.session (session_id, session_file, cwd, version, parent_session, started_at, store)
  SELECT session_id, session_file, cwd, try_cast(version AS INTEGER), parent_session, try_cast(started_at AS TIMESTAMP), store FROM st_pi_s
  ON CONFLICT (session_id) DO NOTHING;"
	fi
	if [ -s "$tmp/send_pi_e.ndjson" ]; then
		sql="$sql
CREATE TEMP TABLE st_pi_e AS SELECT * FROM read_json('$tmp/send_pi_e.ndjson', format='newline_delimited', columns={session_id:'VARCHAR', session_file:'VARCHAR', store:'VARCHAR', line_no:'BIGINT', id:'VARCHAR', parent_id:'VARCHAR', type:'VARCHAR', ts:'VARCHAR', payload:'JSON'});
-- First-write-wins (docs/d203): an entry is immutable by (session_id, id) and
-- the spool is re-read after an interruption. An update leaves a copy in
-- failsafe; DO NOTHING keeps the archive and the bill flat.
INSERT INTO mdw.pi.entry (session_id, session_file, id, parent_id, type, ts, line_no, store, payload)
  SELECT session_id, session_file, id, parent_id, type, try_cast(ts AS TIMESTAMP), line_no, store, payload FROM st_pi_e
  ON CONFLICT (session_id, id) DO NOTHING;"
	fi
	if [ -s "$tmp/send_h_s.ndjson" ]; then
		sql="$sql
CREATE TEMP TABLE st_h_s AS SELECT * FROM read_json('$tmp/send_h_s.ndjson', format='newline_delimited', columns={source:'VARCHAR', session_id:'VARCHAR', parent_session:'VARCHAR', cwd:'VARCHAR', started_at:'VARCHAR', payload:'JSON'});
-- The envelope (docs/d221): a source whose promoted shape has no reader yet still
-- lands loss-free, keyed on its own identity, with the row verbatim in payload.
INSERT INTO mdw.harness.session (source, session_id, parent_session, cwd, started_at, payload)
  SELECT source, session_id, parent_session, cwd, try_cast(started_at AS TIMESTAMP), payload FROM st_h_s
  ON CONFLICT (source, session_id) DO NOTHING;"
	fi
	if [ -s "$tmp/send_h_e.ndjson" ]; then
		sql="$sql
CREATE TEMP TABLE st_h_e AS SELECT * FROM read_json('$tmp/send_h_e.ndjson', format='newline_delimited', columns={source:'VARCHAR', session_id:'VARCHAR', id:'VARCHAR', parent_id:'VARCHAR', seq:'BIGINT', type:'VARCHAR', ts:'VARCHAR', store:'VARCHAR', payload:'JSON'});
INSERT INTO mdw.harness.entry (source, session_id, id, parent_id, seq, type, ts, store, payload)
  SELECT source, session_id, id, parent_id, seq, type, try_cast(ts AS TIMESTAMP), store, payload FROM st_h_e
  ON CONFLICT (source, session_id, id) DO NOTHING;"
	fi
	sql="$sql
SELECT (SELECT count(*) FROM mdw.pi.session) AS sessions,
       (SELECT count(*) FROM mdw.pi.entry) AS entries,
       (SELECT count(*) FROM mdw.harness.entry) AS harness_entries;"
	result=$(duckdb -json -c "$sql") || return 1
	printf 'agent-warehouse-spool-send: batch ok %s\n' "$(printf '%s' "$result" | jq -c . 2>/dev/null || printf '%s' "$result")" >&2
	: >"$pi_s"
	: >"$pi_e"
	: >"$h_s"
	: >"$h_e"
	return 0
}

files=0
lines=0
batched=0
while IFS= read -r f; do
	[ -f "$f" ] || continue
	files=$((files + 1))
	base=$(basename -- "$f")
	n=0
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		n=$((n + 1))
		lines=$((lines + 1))
		out=$(normalise "$line" "$n" "$base") || continue
		[ -n "$out" ] || continue
		schema=${out%%$'\n'*}
		rest=${out#*$'\n'}
		kind=${rest%%$'\n'*}
		row=${rest#*$'\n'}
		[ -n "$row" ] || continue
		if [ "$PRINT_ROWS" = 1 ]; then
			printf '%s\n' "$row"
			continue
		fi
		case "$schema/$kind" in
		pi/session) target=$pi_s ;;
		pi/entry) target=$pi_e ;;
		harness/session) target=$h_s ;;
		harness/entry) target=$h_e ;;
		*) continue ;;
		esac
		printf '%s\n' "$row" >>"$target"
		batched=$((batched + 1))
		if [ "$DRY" = 0 ] && [ "$batched" -ge "$batch_rows" ]; then
			[ "$ensure_done" = 1 ] || prepare_warehouse
			send_batch || { echo 'agent-warehouse-spool-send: batch failed; spool kept' >&2; exit 1; }
			batched=0
		fi
	done <"$f"
	# the file is fully read and its final batch is sent: it may be deleted
	if [ "$DRY" = 0 ] && [ "$PRINT_ROWS" = 0 ] && [ "$side_effects" = 1 ]; then
		if [ "$batched" -gt 0 ]; then
			[ "$ensure_done" = 1 ] || prepare_warehouse
			send_batch || { echo 'agent-warehouse-spool-send: batch failed; spool kept' >&2; exit 1; }
			batched=0
		fi
		if [ "$KEEP" = 0 ]; then
			rm -f "$f"
		fi
	fi
done < <(printf '%s\n' "$spool" "$spool".rm.* | sort -u)

printf 'agent-warehouse-spool-send: %s file(s), %s line(s)\n' "$files" "$lines" >&2
