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
#                                [--spool FILE] [--print-roots] [--dry]
#                                [--report-orphans]
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
PRINT_ROOTS=0
DRY=0
REPORT_ORPHANS=0
PRINT_ROWS=0

while [ $# -gt 0 ]; do
	case "$1" in
	--session-dir | --agent-dir | --spool)
		[ $# -ge 2 ] || { echo "flag needs a value: $1" >&2; exit 64; }
		case "$1" in
		--session-dir) SESSION_DIR="$2" ;;
		--agent-dir) AGENT_DIR="$2" ;;
		--spool) SPOOL="$2" ;;
		esac
		shift 2
		;;
	--print-roots) PRINT_ROOTS=1; shift ;;
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

# Resolution precedes the token check so --print-roots and --dry need no
# credentials, and a path problem is reported before any vault round-trip.
if [ "$PRINT_ROOTS" = 1 ]; then
	printf 'session_root=%s\n' "$SESSION_ROOT"
	printf 'delegation_root=%s\n' "$DELEGATION_ROOT"
	printf 'spool=%s\n' "$spool_base"
	exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sessions_rows="$tmp/sessions.ndjson"
entries_rows="$tmp/entries.ndjson"
: >"$sessions_rows"
: >"$entries_rows"

# One file -> up to one session row and one entry row per line. Line 1 is pi's
# header (no parentId); later lines extend the documented entry base (docs/d167).
# store is the worktree marker: a linked worktree keeps a .git FILE where a main
# checkout keeps a directory.
# shellcheck disable=SC2094  # the read loop's source and the two append targets
# are three distinct paths; shellcheck sees one file per redirect.
parse_file() { # $1 = file, $2 = store
	local file=$1 store=$2 first=1 n=0 line cwd
	while IFS= read -r line || [ -n "$line" ]; do
		[ -n "$line" ] || continue
		n=$((n + 1))
		if [ "$first" = 1 ]; then
			first=0
			cwd=$(printf '%s' "$line" | jq -r '.cwd // empty') || true
			# A delegation transcript stays delegation even when its cwd is a worktree:
			# the root decides the store, the worktree marker only refines a session row.
			if [ -n "$cwd" ] && [ -f "$cwd/.git" ] && [ "$store" = session ]; then store=worktree; fi
			printf '%s' "$line" | jq -c --arg f "$file" --arg s "$store" \
				'select(.id != null) | {session_file:$f, store:$s, session_id:.id, cwd:(.cwd // null), version:(.version // null), parent_session:(.parentSession // null), started_at:(.timestamp // null)}' \
				>>"$sessions_rows" || true
			continue
		fi
		printf '%s' "$line" | jq -c --arg f "$file" --arg s "$store" --argjson n "$n" \
			'select(.id != null) | {session_file:$f, store:$s, line_no:$n, id:.id, parent_id:(.parentId // null), type:(.type // null), ts:(.timestamp // null), payload:.}' \
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
done < <(find "$SESSION_ROOT" "$DELEGATION_ROOT" -type f -name '*.jsonl' 2>/dev/null || true)

# Pushed rows from the daemon route are a third source, so a live emitter's
# capture survives even before the host sweep reaches the file.
if [ -f "$spool_base" ]; then
	found=$((found + 1))
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		case "$line" in
		*'"id"'*) printf '%s\n' "$line" >>"$entries_rows" ;;
		*) printf '%s\n' "$line" >>"$sessions_rows" ;;
		esac
	done <"$spool_base"
fi

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
	printf 'session_root=%s sessions=%s entries=%s\n' "$SESSION_ROOT" "$session_count" "$entry_count"
	exit 0
fi

TOKEN=$(env_or motherduck_token "")
[ -n "$TOKEN" ] || TOKEN=$(env_or MOTHERDUCK_TOKEN "")
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
  session_file VARCHAR PRIMARY KEY, session_id VARCHAR, cwd VARCHAR,
  version INTEGER, parent_session VARCHAR, started_at TIMESTAMP, store VARCHAR);
CREATE TABLE IF NOT EXISTS $TGT.entry(
  session_file VARCHAR, id VARCHAR, parent_id VARCHAR, type VARCHAR,
  ts TIMESTAMP, line_no BIGINT, store VARCHAR, payload JSON,
  PRIMARY KEY (session_file, id));
SQL
	if [ "$session_count" -gt 0 ]; then
		cat <<SQL
CREATE TEMP TABLE st_s AS SELECT * FROM read_json_auto('$sessions_rows');
INSERT INTO $TGT.session (session_file, session_id, cwd, version, parent_session, started_at, store)
  SELECT session_file, session_id, cwd, try_cast(version AS INTEGER), parent_session,
         try_cast(started_at AS TIMESTAMP), store FROM st_s
  ON CONFLICT (session_file) DO UPDATE SET
    session_id=excluded.session_id, cwd=excluded.cwd, version=excluded.version,
    parent_session=excluded.parent_session, started_at=excluded.started_at, store=excluded.store;
SQL
	fi
	if [ "$entry_count" -gt 0 ]; then
		cat <<SQL
CREATE TEMP TABLE st_e AS SELECT * FROM read_json_auto('$entries_rows');
INSERT INTO $TGT.entry (session_file, id, parent_id, type, ts, line_no, store, payload)
  SELECT session_file, id, parent_id, type, try_cast(ts AS TIMESTAMP), line_no, store, payload FROM st_e
  ON CONFLICT (session_file, id) DO UPDATE SET
    parent_id=excluded.parent_id, type=excluded.type, ts=excluded.ts,
    line_no=excluded.line_no, store=excluded.store, payload=excluded.payload;
SQL
	fi
	cat <<SQL
SELECT (SELECT count(*) FROM $TGT.session) AS sessions,
       (SELECT count(*) FROM $TGT.entry) AS entries;
SQL
} >"$sql_file"

result=$(duckdb -json -c "$(cat "$sql_file")")
jq -n --argjson result "$result" --arg db "md:$WAREHOUSE_DB" \
	--argjson sessions "$session_count" --argjson entries "$entry_count" \
	'{database:$db, parsed_sessions:$sessions, parsed_entries:$entries, target:($result[0] // {})}'

