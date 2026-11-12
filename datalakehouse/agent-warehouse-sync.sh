#!/bin/bash
# agent-warehouse-sync — coding-harness session JSONL -> MotherDuck (md:agent).
#
# WHY the sweep IS the read path (docs/d184): the live ingest route (docs/d181)
# only captures what an emitter sent. A route that was down, a harness with no
# emitter, and a compromised agent withholding events all leave the live path
# blind while the files remain. This sync walks the roots instead of trusting a
# push, so it is also the postmortem.
#
# WHY no ThinkRail documents (docs/d183): a worktree is the transcript header's
# cwd, a name is the session_info entry, a branch is git — every ThinkRail-owned
# field is derivable, so the decision stores none of them.
#
# WHY two roots and one parser (docs/d183): pi writes one JSONL per session under
# a cwd-derived folder (a git worktree is just another cwd), and subagent and
# resource transcripts under the agent dir's delegation root. Both are pi JSONL.
#
# WHY payloads land verbatim (docs/d167): the warehouse keeps what the harness
# wrote, because a reader that reshapes private data is a second, silent
# formatter.
#
# Usage: agent-warehouse-sync.sh [--session-dir DIR] [--agent-dir DIR]
#                                [--spool FILE] [--route URL] [--print-roots]
#                                [--dry] [--report-orphans]
#
# WHY the route is the default (docs/d181): the sync runs both inside a sandbox
# and on the host, and the daemon sink is the one transport both can use. Posting
# to it keeps the archive host-written and needs no MotherDuck token or duckdb;
# --direct is the alternative for a host that uploads without a daemon running.
# Env:   motherduck_token   MotherDuck access token (MOTHERDUCK_TOKEN accepted)
#        AGENT_WAREHOUSE_DB target md: database (default: agent)
#        PI_CODING_AGENT_SESSION_DIR / PI_CODING_AGENT_DIR / XDG_DATA_HOME
# Needs: duckdb v1.4-v1.5 (MotherDuck refuses other versions; ./dev-tools.sh duckdb), jq.
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
usage: agent-warehouse-sync.sh [--session-dir DIR] [--agent-dir DIR]
          [--spool FILE] [--print-roots] [--dry] [--report-orphans]
  --session-dir      pi session root (default PI_CODING_AGENT_SESSION_DIR, else ~/.pi/agent/sessions)
  --agent-dir        pi agent dir; its delegation/ subdir is the second root
                     (default PI_CODING_AGENT_DIR, else ~/.pi/agent)
  --spool            pushed rows from the daemon route (default XDG data dir/agent-warehouse/spool.ndjson)
  --route URL        daemon sink base URL; the default transport, needing no token
                     or duckdb (default env AGENT_WAREHOUSE_ROUTE, else http://127.0.0.1:8787)
  --direct           upload straight to MotherDuck instead of the route
                     (needs motherduck_token and the pinned duckdb)
  --rm               after the transport ack, remove the processed session files
                     and, on a direct run, the consumed spool (route runs keep it)
                     (postmortem and historical piles only; a file modified within
                     AGENT_WAREHOUSE_RM_GRACE seconds is kept as possibly live)
  --print-roots      print the resolved roots, then exit (no token needed)
  --dry              parse and count, write nothing (no token needed)
  --report-orphans   print sessions whose cwd is gone (the postmortem view)
  --print-rows       print the parsed NDJSON rows, then exit (no token; for tests)
env: motherduck_token · AGENT_WAREHOUSE_DB (default: agent)
EOF
}

# Read an env var without brace expansion, so the whole script stays free of
# parameter-expansion syntax and shellcheck-clean under set -u.
env_or() { # $1 = var name, $2 = default
	local v
	v=$(printenv "$1" 2>/dev/null || true)
	if [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "$2"; fi
}

SESSION_DIR=""
AGENT_DIR=""
SPOOL=""
ROUTE=""
DIRECT=0
RM=0
PRINT_ROOTS=0
DRY=0
REPORT_ORPHANS=0
PRINT_ROWS=0

while [ $# -gt 0 ]; do
	case "$1" in
	--session-dir | --agent-dir | --spool | --route)
		[ $# -ge 2 ] || { echo "flag needs a value: $1" >&2; exit 64; }
		case "$1" in
		--session-dir) SESSION_DIR="$2" ;;
		--agent-dir) AGENT_DIR="$2" ;;
		--spool) SPOOL="$2" ;;
		--route) ROUTE="$2" ;;
		esac
		shift 2
		;;
	--print-roots) PRINT_ROOTS=1; shift ;;
	--direct) DIRECT=1; shift ;;
	--rm) RM=1; shift ;;
	--dry) DRY=1; shift ;;
	--report-orphans) REPORT_ORPHANS=1; shift ;;
	--print-rows) PRINT_ROWS=1; shift ;;
	-h | --help) usage; exit 0 ;;
	-*) echo "unknown flag: $1" >&2; usage; exit 64 ;;
	*) echo "unexpected argument: $1" >&2; usage; exit 64 ;;
	esac
done

# Root discovery mirrors pi's defaults (docs/d183): explicit flag, then pi's env
# var, then ~/.pi/agent. The delegation root is always the agent dir's child.
SESSION_ROOT="$SESSION_DIR"
[ -n "$SESSION_ROOT" ] || SESSION_ROOT=$(env_or PI_CODING_AGENT_SESSION_DIR "")
[ -n "$SESSION_ROOT" ] || SESSION_ROOT="$HOME/.pi/agent/sessions"
AGENT_ROOT="$AGENT_DIR"
[ -n "$AGENT_ROOT" ] || AGENT_ROOT=$(env_or PI_CODING_AGENT_DIR "")
[ -n "$AGENT_ROOT" ] || AGENT_ROOT="$HOME/.pi/agent"
DELEGATION_ROOT="$AGENT_ROOT/delegation"
spool_base="$SPOOL"
[ -n "$spool_base" ] || spool_base=$(env_or XDG_DATA_HOME "$HOME/.local/share")/agent-warehouse/spool.ndjson
# The route is the default transport; --direct turns it off and takes the
# MotherDuck leg instead.
if [ "$DIRECT" = 1 ]; then
	route=""
else
	route="$ROUTE"
	[ -n "$route" ] || route=$(env_or AGENT_WAREHOUSE_ROUTE "http://127.0.0.1:8787")
	route=$(printf '%s' "$route" | sed 's:/*$::')
fi
# --rm grace: a file modified within this many seconds is treated as live and kept.
GRACE=$(env_or AGENT_WAREHOUSE_RM_GRACE 300)
TOKEN=$(env_or motherduck_token "")
[ -n "$TOKEN" ] || TOKEN=$(env_or MOTHERDUCK_TOKEN "")
# --rm clears the spool too, but only when THIS run folds it into the warehouse
# (direct mode, with a token): a route-mode run has uploaded nothing, so it must
# leave the daemon's tail alone. The spool is ROTATED before it is read rather
# than truncated in place, so a concurrent daemon append cannot be lost; the
# frozen file is deleted only after the direct ack.
if [ "$RM" = 1 ] && [ -z "$route" ] && [ -n "$TOKEN" ] && [ -f "$spool_base" ]; then
	mv "$spool_base" "$spool_base.rm.$$"
fi

# Resolution precedes the token check so --print-roots and --dry need no
# credentials, and a path problem is reported before any vault round-trip.
if [ "$PRINT_ROOTS" = 1 ]; then
	printf 'session_root=%s\n' "$SESSION_ROOT"
	printf 'delegation_root=%s\n' "$DELEGATION_ROOT"
	printf 'spool=%s\n' "$spool_base"
	if [ "$DIRECT" = 1 ]; then
		printf 'route=(direct)\n'
	else
		printf 'route=%s\n' "$route"
	fi
	exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sessions_rows="$tmp/sessions.ndjson"
entries_rows="$tmp/entries.ndjson"
: >"$sessions_rows"
: >"$entries_rows"
removable="$tmp/removable"
: >"$removable"

# One file -> up to one session row and one entry row per line. Line 1 is pi's
# header (no parentId); later lines extend the documented entry base (docs/d167).
# store is the worktree marker: a linked worktree keeps a .git FILE where a main
# checkout keeps a directory.
# shellcheck disable=SC2094  # the read loop's source and the two append targets
# are three distinct paths; shellcheck sees one file per redirect.
# A pi header is recognized by its type, never by its position: a concatenated
# file carries several, each opening a new session, so the reader must not assume
# line 1 is the only header. Assuming so would attribute the second session's
# entries to the first and drop the second session's identity.
# --rm removes a processed file only AFTER the transport ack, and only when the
# file is older than the grace window: a live session is being appended to right
# now, so a just-modified file is kept and reported rather than deleted.
remove_processed() {
	[ "$RM" = 1 ] || return 0
	[ -s "$removable" ] || return 0
	local removed=0 kept=0 grace_min f recent
	grace_min=$(((GRACE + 59) / 60))
	while IFS= read -r f; do
		[ -n "$f" ] || continue
		recent=""
		if [ "$grace_min" -gt 0 ]; then
			recent=$(find "$f" -mmin -"$grace_min" -print -quit 2>/dev/null || true)
		fi
		if [ -n "$recent" ]; then
			kept=$((kept + 1))
			printf 'agent-warehouse-sync: --rm kept %s (modified within %ss; live?)\n' "$f" "$GRACE" >&2
		else
			rm -f "$f" && removed=$((removed + 1))
		fi
	done <"$removable"
	find "$SESSION_ROOT" "$DELEGATION_ROOT" -mindepth 1 -type d -empty -delete 2>/dev/null || true
	printf 'agent-warehouse-sync: --rm removed %s file(s), kept %s\n' "$removed" "$kept" >&2
}

# shellcheck disable=SC2094  # the read loop's source and the two append targets
# are three distinct paths; shellcheck sees one file per redirect.
parse_file() { # $1 = file, $2 = base store (session|delegation)
	local file=$1 base=$2 line sid="" store="$2" cwd n=0
	while IFS= read -r line || [ -n "$line" ]; do
		[ -n "$line" ] || continue
		n=$((n + 1))
		if printf '%s' "$line" | jq -e '.type == "session"' >/dev/null 2>&1; then
			sid=$(printf '%s' "$line" | jq -r '.id // empty') || true
			cwd=$(printf '%s' "$line" | jq -r '.cwd // empty') || true
			# A delegation transcript stays delegation even when its cwd is a
			# worktree: the root decides the store, the marker only refines a
			# session row.
			store=$base
			if [ "$base" = session ] && [ -n "$cwd" ] && [ -f "$cwd/.git" ]; then store=worktree; fi
			printf '%s' "$line" | jq -c --arg f "$file" --arg s "$store" \
				'select(.id != null) | {session_file:$f, store:$s, session_id:.id, cwd:(.cwd // null), version:(.version // null), parent_session:(.parentSession // null), started_at:(.timestamp // null)}' \
				>>"$sessions_rows" || true
			continue
		fi
		# The payload carries the message content array verbatim; splitting it into
		# content parts is a v2 design (docs/d167), so one row can hold 100 KB+.
		printf '%s' "$line" | jq -c --arg sid "$sid" --arg f "$file" --arg s "$store" --argjson n "$n" \
			'select(.id != null) | {session_id:$sid, session_file:$f, store:$s, line_no:$n, id:.id, parent_id:(.parentId // null), type:(.type // null), ts:(.timestamp // null), payload:.}' \
			>>"$entries_rows" || true
	done <"$file"
}

found=0
while IFS= read -r f; do
	[ -n "$f" ] || continue
	found=$((found + 1))
	case "$f" in
	"$DELEGATION_ROOT"/*) store=delegation ;;
	*) store=session ;;
	esac
	parse_file "$f" "$store"
	if [ "$RM" = 1 ]; then
		# Only a file whose every line is valid JSON is a removal candidate; a
		# partial read must never cost the last copy of a session.
		if jq . "$f" >/dev/null 2>&1; then
			printf '%s\n' "$f" >>"$removable"
		else
			printf 'agent-warehouse-sync: invalid JSON, keeping %s\n' "$f" >&2
		fi
	fi
done < <(find "$SESSION_ROOT" "$DELEGATION_ROOT" -type f -name '*.jsonl' 2>/dev/null || true)

# Pushed rows from the daemon route are a third source, so a live emitter's
# capture survives even before the host sweep reaches the file.
# Sources are the live tail plus any rotated tail a failed run left behind: a
# direct+token --rm run rotated the live one above, so this read cannot race a
# concurrent daemon append, and a leftover rotated file is still folded in.
spool_seen=0
for sp in "$spool_base" "$spool_base".rm.*; do
	[ -f "$sp" ] || continue
	spool_seen=1
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		case "$line" in
		*'"id"'*) printf '%s\n' "$line" >>"$entries_rows" ;;
		*) printf '%s\n' "$line" >>"$sessions_rows" ;;
		esac
	done <"$sp"
done
[ "$spool_seen" = 0 ] || found=$((found + 1))

if [ "$found" -eq 0 ]; then
	printf 'agent-warehouse-sync: no session files under %s or %s\n' "$SESSION_ROOT" "$DELEGATION_ROOT" >&2
	exit 66
fi

session_count=$(wc -l <"$sessions_rows")
entry_count=$(wc -l <"$entries_rows")

if [ "$REPORT_ORPHANS" = 1 ]; then
	while IFS= read -r row; do
		[ -n "$row" ] || continue
		cwd=$(printf '%s' "$row" | jq -r '.cwd // empty')
		[ -n "$cwd" ] || continue
		if [ ! -d "$cwd" ]; then
			printf 'orphan: %s (cwd gone: %s)\n' "$(printf '%s' "$row" | jq -r '.session_file')" "$cwd"
		fi
	done <"$sessions_rows"
	# The orphan view is a report: print and exit so it needs no token.
	exit 0
fi

if [ "$PRINT_ROWS" = 1 ]; then
	cat "$sessions_rows" "$entries_rows"
	exit 0
fi

if [ "$DRY" = 1 ]; then
	if [ "$DIRECT" = 1 ]; then route_desc="(direct)"; else route_desc=$route; fi
	printf 'session_root=%s sessions=%s entries=%s route=%s\n' "$SESSION_ROOT" "$session_count" "$entry_count" "$route_desc"
	exit 0
fi

# Route mode is the inside-the-sandbox transport (docs/d181): post the parsed
# rows to the host sink, so a sandbox with no token and no duckdb still ships its
# sessions, and the archive is still written only host-side.
if [ -n "$route" ]; then
	payload="$tmp/payload.json"
	jq -s '.' "$sessions_rows" "$entries_rows" >"$payload"
	ingest_token=$(env_or AGENT_INGEST_TOKEN "")
	set -- curl -sS -f -X POST -H 'content-type: application/json'
	[ -z "$ingest_token" ] || set -- "$@" -H "x-ingest-token: $ingest_token"
	set -- "$@" --data-binary "@$payload" "$route/ingest/session"
	if ! resp=$("$@"); then
		printf 'agent-warehouse-sync: route post to %s failed\n' "$route" >&2
		exit 1
	fi
	remove_processed
	printf '%s\n' "$resp"
	exit 0
fi

if [ -z "$TOKEN" ]; then
	echo 'agent-warehouse-sync: set motherduck_token (MotherDuck access token; see README)' >&2
	exit 1
fi

# The same version gate as the atuin sibling: MotherDuck's extension rejects
# clients outside its range with a load error that names no fix.
duckdb_version=$(duckdb --version 2>&1 || true)
case "$duckdb_version" in
v1.4.* | v1.5.*) ;;
*)
	duckdb_short=$(printf '%s' "$duckdb_version" | awk '{print $1}')
	echo "duckdb $duckdb_short is outside the v1.4-v1.5 range MotherDuck accepts; run ./dev-tools.sh duckdb" >&2
	exit 69
	;;
esac

WAREHOUSE_DB=$(env_or AGENT_WAREHOUSE_DB agent)
TGT=mdw.pi
sql_file="$tmp/sync.sql"
{
	cat <<SQL
INSTALL motherduck; LOAD motherduck;
SET motherduck_token='$TOKEN';
ATTACH 'md:$WAREHOUSE_DB' AS mdw;
CREATE SCHEMA IF NOT EXISTS $TGT;
CREATE TABLE IF NOT EXISTS $TGT.session(
  session_id VARCHAR PRIMARY KEY, session_file VARCHAR, cwd VARCHAR,
  version INTEGER, parent_session VARCHAR, started_at TIMESTAMP, store VARCHAR);
CREATE TABLE IF NOT EXISTS $TGT.entry(
  session_id VARCHAR, session_file VARCHAR, id VARCHAR, parent_id VARCHAR,
  type VARCHAR, ts TIMESTAMP, line_no BIGINT, store VARCHAR, payload JSON,
  PRIMARY KEY (session_id, id));
SQL
	if [ "$session_count" -gt 0 ]; then
		cat <<SQL
CREATE TEMP TABLE st_s AS SELECT * FROM read_json_auto('$sessions_rows');
INSERT INTO $TGT.session (session_id, session_file, cwd, version, parent_session, started_at, store)
  SELECT session_id, session_file, cwd, try_cast(version AS INTEGER), parent_session,
         try_cast(started_at AS TIMESTAMP), store FROM st_s
  ON CONFLICT (session_id) DO UPDATE SET
    session_file=excluded.session_file, cwd=excluded.cwd, version=excluded.version,
    parent_session=excluded.parent_session, started_at=excluded.started_at, store=excluded.store;
SQL
	fi
	if [ "$entry_count" -gt 0 ]; then
		cat <<SQL
CREATE TEMP TABLE st_e AS SELECT * FROM read_json_auto('$entries_rows');
INSERT INTO $TGT.entry (session_id, session_file, id, parent_id, type, ts, line_no, store, payload)
  SELECT session_id, session_file, id, parent_id, type, try_cast(ts AS TIMESTAMP), line_no, store, payload FROM st_e
  ON CONFLICT (session_id, id) DO UPDATE SET
    session_file=excluded.session_file, parent_id=excluded.parent_id, type=excluded.type,
    ts=excluded.ts, line_no=excluded.line_no, store=excluded.store, payload=excluded.payload;
SQL
	fi
	cat <<SQL
SELECT (SELECT count(*) FROM $TGT.session) AS sessions,
       (SELECT count(*) FROM $TGT.entry) AS entries;
SQL
} >"$sql_file"

result=$(duckdb -json -c "$(cat "$sql_file")")
remove_processed
# A direct --rm run has folded every rotated tail it read; remove them. The live
# tail is only ever rotated, so a route run never touches it.
if [ "$RM" = 1 ] && [ -z "$route" ]; then
	for sp in "$spool_base".rm.*; do
		[ -f "$sp" ] && rm -f "$sp"
	done
fi
jq -n --argjson result "$result" --arg db "md:$WAREHOUSE_DB" \
	--argjson sessions "$session_count" --argjson entries "$entry_count" \
	'{database:$db, parsed_sessions:$sessions, parsed_entries:$entries, target:($result[0] // {})}'

