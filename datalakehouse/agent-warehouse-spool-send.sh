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
#      AGENT_WAREHOUSE_BATCH_BYTES (default 32 MiB; a row cap alone is no bound
#      when one row can carry a whole message content array)
#      AGENT_WAREHOUSE_DEADLOG (default <spool>.dead.ndjson)
#      AGENT_WAREHOUSE_DLQ_CONTEXT (default 3 lines before and after a bad line)
# Needs: duckdb v1.4-v1.5 (./dev-tools.sh duckdb), jq.
set -euo pipefail
umask 077

# One lock for every sender of a spool: the daemon's self-send, an operator's
# run and the sync's direct leg all contend on the same <spool>.lock. A second
# sender exits 75 (EX_TEMPFAIL) rather than racing the first. The Java port
# replaces this block; it is deliberately not a shared shell library.
lock_dir=""
tmp=""
# shellcheck disable=SC2329  # invoked through the EXIT trap
cleanup() {
	[ -z "$lock_dir" ] || rm -rf "$lock_dir"
	[ -z "$tmp" ] || rm -rf "$tmp"
}

trap cleanup EXIT
acquire_lock() { # $1 = spool path
	local path=$1 dir="$1.lock.d" pid=""
	if command -v flock >/dev/null 2>&1; then
		exec 9>"$path.lock"
		if ! flock -n 9; then
			echo "agent-warehouse-spool-send: another sender holds $path.lock" >&2
			exit 75
		fi
		return 0
	fi
	if mkdir "$dir" 2>/dev/null; then
		printf '%s\n' "$@" >"$dir/pid"
		lock_dir="$dir"
		return 0
	fi
	[ -f "$dir/pid" ] && pid=$(cat "$dir/pid" 2>/dev/null || true)
	if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
		echo "agent-warehouse-spool-send: another sender (pid $pid) holds $dir" >&2
		exit 75
	fi
	# A killed fallback lock has no kernel owner; its pid is gone.
	rm -rf "$dir"
	if mkdir "$dir" 2>/dev/null; then
		printf '%s\n' "$@" >"$dir/pid"
		lock_dir="$dir"
		return 0
	fi
	echo "agent-warehouse-spool-send: another sender holds $dir" >&2
	exit 75
}

usage() {
	cat >&2 <<'EOF'
usage: agent-warehouse-spool-send.sh [--spool FILE] [--db NAME] [--batch-rows N]
                                     [--keep] [--dry] [--print-rows]
  --spool FILE       spool to consume (default AGENT_WAREHOUSE_SPOOL)
  --db NAME          target MotherDuck database (default AGENT_WAREHOUSE_DB, else agent)
  --batch-rows N     rows per apply batch (default 5000)
  --deadlog FILE     dead-letter queue for an unfixable line (default
                     <spool>.dead.ndjson)
  --keep             do not delete a spool file after folding it
  --dry              normalise and count, write and delete nothing (no token)
  --print-rows       print the normalised rows, write and delete nothing (no token)
  a row's source decides its target: absent or "pi" -> mdw.pi, anything else ->
  mdw.harness (docs/d221)
env: motherduck_token · AGENT_WAREHOUSE_DB · AGENT_WAREHOUSE_SPOOL
     AGENT_WAREHOUSE_BATCH_ROWS · AGENT_WAREHOUSE_BATCH_BYTES
     AGENT_WAREHOUSE_DEADLOG · AGENT_WAREHOUSE_DLQ_CONTEXT
EOF
}

env_or() { # $1 = var name, $2 = default
	local v
	v=$(printenv "$1" 2>/dev/null || true)
	if [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "$2"; fi
}

env_int() { # $1 = var name, $2 = default
	local v
	v=$(env_or "$1" "")
	if [ -z "$v" ]; then
		printf '%s' "$2"
		return 0
	fi
	case "$v" in
	*[!0-9]*)
		echo "agent-warehouse-spool-send: $1=$v is not an integer; using $2" >&2
		printf '%s' "$2"
		;;
	*) printf '%s' "$v" ;;
	esac
}

SPOOL=""
DB=""
BATCH_ROWS=""
DEADLOG=""
KEEP=0
DRY=0
PRINT_ROWS=0
while [ $# -gt 0 ]; do
	case "$1" in
	--spool | --db | --batch-rows | --deadlog)
		[ $# -ge 2 ] || { echo "flag needs a value: $1" >&2; exit 64; }
		case "$1" in
		--spool) SPOOL="$2" ;;
		--db) DB="$2" ;;
		--batch-rows) BATCH_ROWS="$2" ;;
		--deadlog) DEADLOG="$2" ;;
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
batch_rows=$(env_int AGENT_WAREHOUSE_BATCH_ROWS 5000)
[ -n "$BATCH_ROWS" ] && batch_rows="$BATCH_ROWS"
batch_bytes_max=$(env_int AGENT_WAREHOUSE_BATCH_BYTES 33554432)
dlq_context=$(env_int AGENT_WAREHOUSE_DLQ_CONTEXT 3)
deadlog="$DEADLOG"
[ -n "$deadlog" ] || deadlog=$(env_or AGENT_WAREHOUSE_DEADLOG "")
[ -n "$deadlog" ] || deadlog="$spool.dead.ndjson"

case "$warehouse" in
"" | *[!A-Za-z0-9_]*)
	echo "agent-warehouse-spool-send: --db/AGENT_WAREHOUSE_DB must be a simple database name" >&2
	exit 64
	;;
esac

# A report or dry run must not rotate or delete anything.
side_effects=1
[ "$DRY" = 1 ] && side_effects=0
[ "$PRINT_ROWS" = 1 ] && side_effects=0

# The lock covers rotation, folding and deletion. Every sender of this spool
# takes it, so a second run cannot read a tail the first is deleting.
if [ "$side_effects" = 1 ]; then
	acquire_lock "$spool"
fi
# Freeze the live tail under the lock, so what this run consumes cannot race a
# concurrent daemon append.
if [ "$side_effects" = 1 ] && [ -f "$spool" ]; then
	mv "$spool" "$spool.rm.$$"
fi
# A side-effect run consumes only the frozen tails. The live path may be
# recreated by the daemon during this run; including it here used to read it and
# then rm the file, deleting rows appended between the last read and the rm. A
# report run has no deletion, so it may read the live path as well.
if [ "$side_effects" = 1 ]; then
	candidates=$(printf '%s\n' "$spool".rm.*)
else
	candidates=$(printf '%s\n' "$spool" "$spool".rm.*)
fi

tmp=$(mktemp -d)
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
# An unidentified row is keyed by the content hash of its line, never by the
# spool file and line. The fold renames the tail to <spool>.rm.<pid>, so the
# basename carries a new pid after every restart, and a direct fold concatenates
# rows into a differently named temp file; a file/line key therefore minted a
# new primary key and the warehouse stored a duplicate on every run. A clash
# here is a silent drop (ON CONFLICT DO NOTHING), so the hash must cover the
# whole row.
line_hash() { # $1 = line
	if command -v sha256sum >/dev/null 2>&1; then
		printf '%s' "$1" | sha256sum | awk '{print $1}'
	else
		# cksum is POSIX; its CRC and length are a weaker but still stable
		# identity for a row that carries no id of its own.
		printf '%s' "$1" | cksum | awk '{print $1 "-" $2}'
	fi
}

normalise() { # $1 = line, $2 = line number, $3 = content hash
	printf '%s' "$1" | jq -r --argjson n "$2" --arg hash "$3" '
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
          ["pi", "entry", {session_id:(.session_id // ""), session_file:(.session_file // "spool"), store:(.store // "spool"), line_no:(.line_no // $n), id:(.id // ("spool-" + $hash)), parent_id:(.parent_id // null), type:(.type // null), ts:(.ts // .timestamp // null), payload:.}]
        end
      elif said_session then
        ["harness", "session", {source:$src, session_id:(.session_id // .id // ("spool-" + $hash)), parent_session:(.parent_session // null), cwd:(.cwd // null), started_at:(.started_at // .ts // .timestamp // null), payload:.}]
      else
        ["harness", "entry", {source:$src, session_id:(.session_id // ""), id:(.id // .message_id // ("spool-" + $hash)), parent_id:(.parent_id // null), seq:(.seq // .line_no // $n), type:(.type // .kind // null), ts:(.ts // .timestamp // null), store:(.store // "spool"), payload:.}]
      end
    | .[0], .[1], (.[2] | tojson)'
}

token=$(env_or motherduck_token "")
[ -n "$token" ] || token=$(env_or MOTHERDUCK_TOKEN "")
# The credential travels in the environment, never in argv and never in the SQL
# text: argv is world-readable in /proc, and a SET literal also lands in a
# query log. The MotherDuck extension reads motherduck_token itself.
if [ -n "$token" ]; then
	export motherduck_token="$token"
	export MOTHERDUCK_TOKEN="$token"
fi

ensure_db() { # DuckDB has no CREATE DATABASE; connecting is the create route.
	local out
	out=$(duckdb "md:$warehouse" -c 'SELECT 1;' 2>&1) && return 0
	printf '%s\n' "$out" >&2
	return 1
}

# MotherDuck's extension rejects a client outside its version range with a load
# error that names no fix, so the gate runs before the first batch -- here rather
# than in each caller, because this script is every uploader's only path now.
ensure_done=0
prepare_warehouse() {
	local version short
	if [ -z "$token" ]; then
		echo 'agent-warehouse-spool-send: set motherduck_token (MotherDuck access token; see README)' >&2
		exit 1
	fi
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

flush_batch() {
	[ "$batched" -gt 0 ] || return 0
	[ "$ensure_done" = 1 ] || prepare_warehouse
	if ! send_batch; then
		echo 'agent-warehouse-spool-send: batch failed; spool kept' >&2
		exit 1
	fi
	batched=0
	batch_bytes=0
}

json_array() {
	if [ "$#" -eq 0 ]; then
		printf '[]'
		return 0
	fi
	printf '%s\n' "$@" | jq -R . | jq -s .
}

# A dead letter is the bad line plus the facts needed to repair it: the last
# session header seen in the tail, the lines before it and the lines after it.
# The record is content-idempotent, so re-reading a rotated tail cannot append
# the same dead letter twice. This is the sender's dead-letter queue, not a
# second staging area: it is never consumed automatically.
quarantine() { # $1 line, $2 line number, $3 reason
	local line=$1 n=$2 reason=$3 qid before after at
	qid=$(line_hash "$line")
	if [ -f "$deadlog" ] && grep -qF "\"id\":\"$qid\"" "$deadlog" 2>/dev/null; then
		printf 'agent-warehouse-spool-send: %s:%s already quarantined\n' "$f" "$n" >&2
		return 0
	fi
	mkdir -p "$(dirname -- "$deadlog")" || return 1
	before=$(json_array "${prev_lines[@]}") || return 1
	after=$(json_array "${pending_lines[@]:1}") || return 1
	at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	if ! jq -c -n \
		--arg id "$qid" --arg at "$at" --arg file "$f" \
		--argjson line_no "$n" --arg reason "$reason" \
		--arg session "$session_line" --arg line "$line" \
		--argjson before "$before" --argjson after "$after" \
		'{id:$id, quarantined_at:$at, source_file:($file|split("/")|last),
		  file:$file, line_no:$line_no, reason:$reason,
		  session_line_raw:($session|if .=="" then null else . end),
		  line_raw:$line, context_before:$before, context_after:$after}' \
		>>"$deadlog"; then
		return 1
	fi
	chmod 600 "$deadlog" 2>/dev/null || true
	printf 'agent-warehouse-spool-send: quarantined %s:%s -> %s (%s)\n' \
		"$f" "$n" "$deadlog" "$reason" >&2
	return 0
}

dead_letter() { # $1 line, $2 n, $3 reason
	if [ "$side_effects" = 1 ]; then
		if quarantine "$1" "$2" "$3"; then
			file_quarantined=$((file_quarantined + 1))
			quarantined=$((quarantined + 1))
		else
			printf 'agent-warehouse-spool-send: cannot quarantine %s:%s; keeping the tail\n' \
				"$f" "$2" >&2
			quarantine_failed=1
			failed=1
		fi
	else
		printf 'agent-warehouse-spool-send: %s:%s %s\n' "$f" "$2" "$3" >&2
		file_skipped=$((file_skipped + 1))
		skipped=$((skipped + 1))
		failed=1
	fi
}

process_line() { # $1 raw line, $2 line number
	local line=$1 n=$2 hash out schema kind row reason
	hash=$(line_hash "$line")
	if ! out=$(normalise "$line" "$n" "$hash" 2>"$tmp/jq.err"); then
		reason="malformed: $(head -n 1 "$tmp/jq.err")"
		dead_letter "$line" "$n" "$reason"
		return 0
	fi
	if [ -z "$out" ]; then
		dead_letter "$line" "$n" "unreadable normalised output"
		return 0
	fi
	schema=""
	kind=""
	row=""
	{
		IFS= read -r schema || true
		IFS= read -r kind || true
		IFS= read -r row || true
	} <<<"$out"
	if [ -z "$row" ]; then
		dead_letter "$line" "$n" "empty normalised row"
		return 0
	fi
	case "$schema/$kind" in
	pi/session) target=$pi_s ;;
	pi/entry) target=$pi_e ;;
	harness/session) target=$h_s ;;
	harness/entry) target=$h_e ;;
	*)
		dead_letter "$line" "$n" "unknown target $schema/$kind"
		return 0
		;;
	esac
	if [ "$schema/$kind" = "pi/session" ] || [ "$schema/$kind" = "harness/session" ]; then
		session_line="$line"
	fi
	if [ "$PRINT_ROWS" = 1 ]; then
		printf '%s\n' "$row"
		return 0
	fi
	if [ "$DRY" = 1 ]; then
		return 0
	fi
	row_bytes=$(printf '%s' "$row" | wc -c)
	if [ "$batched" -gt 0 ] &&
		{ [ "$batched" -ge "$batch_rows" ] ||
			[ $((batch_bytes + row_bytes)) -gt "$batch_bytes_max" ]; }; then
		flush_batch
	fi
	printf '%s\n' "$row" >>"$target"
	batched=$((batched + 1))
	batch_bytes=$((batch_bytes + row_bytes))
}

files=0
lines=0
batched=0
batch_bytes=0
skipped=0
quarantined=0
failed=0
while IFS= read -r f; do
	[ -f "$f" ] || continue
	files=$((files + 1))
	file_skipped=0
	file_quarantined=0
	quarantine_failed=0
	session_line=""
	prev_lines=()
	pending_lines=()
	pending_nums=()
	n=0
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		n=$((n + 1))
		lines=$((lines + 1))
		pending_lines+=("$line")
		pending_nums+=("$n")
		if [ "${#pending_lines[@]}" -gt "$dlq_context" ]; then
			process_line "${pending_lines[0]}" "${pending_nums[0]}"
			prev_lines+=("${pending_lines[0]}")
			while [ "${#prev_lines[@]}" -gt "$dlq_context" ]; do
				prev_lines=("${prev_lines[@]:1}")
			done
			pending_lines=("${pending_lines[@]:1}")
			pending_nums=("${pending_nums[@]:1}")
		fi
	done <"$f"
	while [ "${#pending_lines[@]}" -gt 0 ]; do
		process_line "${pending_lines[0]}" "${pending_nums[0]}"
		prev_lines+=("${pending_lines[0]}")
		while [ "${#prev_lines[@]}" -gt "$dlq_context" ]; do
			prev_lines=("${prev_lines[@]:1}")
		done
		pending_lines=("${pending_lines[@]:1}")
		pending_nums=("${pending_nums[@]:1}")
	done
	if [ "$DRY" = 0 ] && [ "$PRINT_ROWS" = 0 ] && [ "$side_effects" = 1 ]; then
		flush_batch
		if [ "$quarantine_failed" = 1 ]; then
			printf 'agent-warehouse-spool-send: kept %s (quarantine failed)\n' "$f" >&2
			continue
		fi
		if [ "$file_quarantined" -gt 0 ]; then
			printf 'agent-warehouse-spool-send: %s quarantined line(s) from %s\n' \
				"$file_quarantined" "$f" >&2
		fi
		if [ "$KEEP" = 0 ]; then
			rm -f "$f"
		fi
	elif [ "$file_skipped" -gt 0 ]; then
		printf 'agent-warehouse-spool-send: %s:%s malformed line(s) in report mode\n' \
			"$f" "$file_skipped" >&2
		failed=1
	fi
done < <(printf '%s\n' "$candidates" | sort -u)

if [ "$failed" -ne 0 ]; then
	printf 'agent-warehouse-spool-send: %s malformed line(s) left unread\n' "$skipped" >&2
	exit 1
fi
if [ "$quarantined" -gt 0 ]; then
	printf 'agent-warehouse-spool-send: %s line(s) quarantined to %s\n' "$quarantined" "$deadlog" >&2
fi
printf 'agent-warehouse-spool-send: %s file(s), %s line(s)\n' "$files" "$lines" >&2
