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
umask 077

# The same <spool>.lock the sender takes. The direct leg rotates the live tail
# before the sender runs, so it must hold the lock across rotation, read and
# delete; otherwise a daemon self-send can consume the tail this run is folding.
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
			echo "agent-warehouse-sync: another sender holds $path.lock" >&2
			exit 75
		fi
		return 0
	fi
	if mkdir "$dir" 2>/dev/null; then
		printf '%s\n' "$$" >"$dir/pid"
		lock_dir="$dir"
		return 0
	fi
	# The substitution answers absence itself (it is already tolerant), so a
	# `-f` test in front of it can only add a window (docs/d228).
	pid=$(cat "$dir/pid" 2>/dev/null || true)
	if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
		echo "agent-warehouse-sync: another sender (pid $pid) holds $dir" >&2
		exit 75
	fi
	rm -rf "$dir"
	if mkdir "$dir" 2>/dev/null; then
		printf '%s\n' "$$" >"$dir/pid"
		lock_dir="$dir"
		return 0
	fi
	echo "agent-warehouse-sync: another sender holds $dir" >&2
	exit 75
}

UNIT=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# The sender is the unit's only uploader (docs/d221): this script reads sources
# and hands rows over, so no schema, version gate or insert lives here.
SENDER="$UNIT/agent-warehouse-spool-send.sh"

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
  --direct           upload straight to MotherDuck instead of the route, and clear
                     the consumed spool (needs motherduck_token and the pinned duckdb)
  --rm               after the transport ack, also remove the processed session files
                     (a route run removes nothing)
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

env_int() { # $1 = var name, $2 = default
	local v
	v=$(env_or "$1" "")
	if [ -z "$v" ]; then
		printf '%s' "$2"
		return 0
	fi
	case "$v" in
	*[!0-9]*)
		echo "agent-warehouse-sync: $1=$v is not an integer; using $2" >&2
		printf '%s' "$2"
		;;
	*) printf '%s' "$v" ;;
	esac
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
GRACE=$(env_int AGENT_WAREHOUSE_RM_GRACE 300)
BATCH_MAX=$(env_int AGENT_WAREHOUSE_BATCH_BYTES 4194304)
if [ "$RM" = 1 ] && [ "$GRACE" -eq 0 ]; then
	printf 'agent-warehouse-sync: AGENT_WAREHOUSE_RM_GRACE=0 disables the live-file check; --rm may delete a session still being written\n' >&2
fi
if [ "$RM" = 1 ] && [ -n "$route" ]; then
	printf 'agent-warehouse-sync: --rm after a route ack removes the source while the row is only in the host spool; use --direct when the source is the last copy\n' >&2
fi
TOKEN=$(env_or motherduck_token "")
[ -n "$TOKEN" ] || TOKEN=$(env_or MOTHERDUCK_TOKEN "")
# A DIRECT run is the collector: it folds the spool into the warehouse, so it
# clears the consumed tail itself, independent of --rm (which governs the session
# files). A route run uploaded nothing and never touches the spool, and a report
# or dry run has no side effect. The tail is ROTATED before it is read rather than
# truncated in place, so a concurrent daemon append cannot be lost; the frozen
# file is deleted only after the direct ack.
direct_side_effects=0
if [ -z "$route" ] && [ -n "$TOKEN" ] && [ "$DRY" = 0 ] && [ "$PRINT_ROWS" = 0 ] &&
	[ "$PRINT_ROOTS" = 0 ] && [ "$REPORT_ORPHANS" = 0 ]; then
	direct_side_effects=1
fi
if [ "$direct_side_effects" = 1 ]; then
	acquire_lock "$spool_base"
fi
if [ "$direct_side_effects" = 1 ]; then
	# The move's own ENOENT is the answer: the daemon may have rotated the tail
	# already, and freezing a tail that is gone is freezing nothing (docs/d228).
	mv "$spool_base" "$spool_base.rm.$$" 2>/dev/null || :
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
	printf 'agent-warehouse-sync: --rm removed %s file(s), kept %s\n' "$removed" "$kept" >&2
}

# shellcheck disable=SC2094  # the read loop's source and the two append targets
# are three distinct paths; shellcheck sees one file per redirect.
parse_file() { # $1 = file, $2 = base store (session|delegation)
	local file=$1 base=$2 line sid="" store="$2" cwd n=0 row
	file_skipped=0
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
			if ! row=$(printf '%s' "$line" | jq -c --arg f "$file" --arg s "$store" \
				'select(.id != null) | {session_file:$f, store:$s, session_id:.id, cwd:(.cwd // null), version:(.version // null), parent_session:(.parentSession // null), started_at:(.timestamp // null)}'); then
				printf 'agent-warehouse-sync: unparseable session header at %s:%s\n' "$file" "$n" >&2
				file_skipped=$((file_skipped + 1))
			elif [ -n "$row" ]; then
				printf '%s\n' "$row" >>"$sessions_rows"
			else
				printf 'agent-warehouse-sync: session header without an id at %s:%s\n' "$file" "$n" >&2
				file_skipped=$((file_skipped + 1))
			fi
			continue
		fi
		# The payload carries the message content array verbatim; splitting it into
		# content parts is a v2 design (docs/d167), so one row can hold 100 KB+.
		if ! row=$(printf '%s' "$line" | jq -c --arg sid "$sid" --arg f "$file" --arg s "$store" --argjson n "$n" \
			'select(.id != null) | {session_id:$sid, session_file:$f, store:$s, line_no:$n, id:.id, parent_id:(.parentId // null), type:(.type // null), ts:(.timestamp // null), payload:.}'); then
			printf 'agent-warehouse-sync: unparseable entry at %s:%s\n' "$file" "$n" >&2
			file_skipped=$((file_skipped + 1))
		elif [ -n "$row" ]; then
			printf '%s\n' "$row" >>"$entries_rows"
		else
			printf 'agent-warehouse-sync: entry without an id at %s:%s\n' "$file" "$n" >&2
			file_skipped=$((file_skipped + 1))
		fi
	done <"$file"
}

found=0
while IFS= read -r f; do
	[ -n "$f" ] || continue
	# A pi session file ALWAYS opens with a {type:session} header. A .jsonl without
	# one is another tool's stream (mistral-vibe's messages.jsonl, say) or a
	# fragment, so it is skipped, never ingested, and never a --rm candidate: a
	# foreign file must not become junk rows or be deleted.
	if ! printf '%s' "$(head -n1 "$f")" | jq -e '.type == "session"' >/dev/null 2>&1; then
		printf 'agent-warehouse-sync: skipping non-pi %s (no session header)\n' "$f" >&2
		continue
	fi
	found=$((found + 1))
	case "$f" in
	"$DELEGATION_ROOT"/*) store=delegation ;;
	*) store=session ;;
	esac
	parse_file "$f" "$store"
	# Validate every file, not only a --rm candidate: the per-line jq above
	# drops a line without an id, and a partial transcript must be reported and
	# never be a removal candidate even when the rest of it is valid JSON.
	if jq . "$f" >/dev/null 2>&1 && [ "$file_skipped" = 0 ]; then
		[ "$RM" = 1 ] && printf '%s\n' "$f" >>"$removable"
	elif [ "$file_skipped" -gt 0 ]; then
		printf 'agent-warehouse-sync: kept %s (%s line(s) unparseable or without an id)\n' "$f" "$file_skipped" >&2
	else
		printf 'agent-warehouse-sync: invalid JSON, keeping %s (valid lines were ingested)\n' "$f" >&2
	fi
done < <(find "$SESSION_ROOT" "$DELEGATION_ROOT" -type f -name '*.jsonl' 2>/dev/null || true)

# The spool is the daemon's own tail (docs/d184): its rows are already stored
# host-side, so this sweep neither re-parses nor re-posts them (docs/d221). A
# direct run hands the tails to the sender, which normalises by source and by
# line; a dry run counts them and moves on. Sources are the live tail plus any
# rotated tail a failed run left behind.
spool_seen=0
spool_lines=0
for sp in "$spool_base" "$spool_base".rm.*; do
	[ -f "$sp" ] || continue
	spool_seen=1
	spool_lines=$((spool_lines + $(awk 'NF' "$sp" | wc -l)))
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
	printf 'session_root=%s sessions=%s entries=%s spool=%s route=%s\n' "$SESSION_ROOT" "$session_count" "$entry_count" "$spool_lines" "$route_desc"
	exit 0
fi

# Route mode is the inside-the-sandbox transport (docs/d181): post the parsed
# rows to the host sink, so a sandbox with no token and no duckdb still ships its
# sessions, and the archive is still written only host-side.
if [ -n "$route" ]; then
	# The scheme check belongs at the post, not at resolution: --print-roots and
	# --dry must resolve and report without a credential or a network policy.
	case "$route" in
	https://*) ;;
	http://127.0.0.1:* | http://localhost:* | "http://[::1]:"*) ;;
	http://*)
		echo 'agent-warehouse-sync: a plaintext route off loopback would carry the ingest token in the clear; use https or loopback' >&2
		exit 64
		;;
	*)
		echo 'agent-warehouse-sync: AGENT_WAREHOUSE_ROUTE must be an http(s) URL' >&2
		exit 64
		;;
	esac
	ingest_token=$(env_or AGENT_INGEST_TOKEN "")
	# The route post is batched under a byte budget: one row can hold a whole
	# message content array (docs/d167's v2 note), so a single array of every row
	# is exactly what overflows the daemon's body limit (HTTP 413).
	batch="$tmp/batch.ndjson"
	batch_json="$tmp/batch.json"
	: >"$batch"
	accepted_total=0
	duplicates_total=0
	bytes=0
	post_batch() {
		[ -s "$batch" ] || return 0
		jq -s -c '.' "$batch" >"$batch_json"
		set -- curl -sS -f --connect-timeout 10 --max-time 120 \
			-X POST -H 'content-type: application/json'
		[ -z "$ingest_token" ] || set -- "$@" -H "x-ingest-token: $ingest_token"
		set -- "$@" --data-binary "@$batch_json" "$route/ingest/session"
		if ! resp=$("$@"); then
			printf 'agent-warehouse-sync: route post to %s failed (%s bytes; raise AGENT_INGEST_MAX_BODY on the daemon)\n' "$route" "$(wc -c <"$batch_json")" >&2
			return 1
		fi
		accepted_total=$((accepted_total + $(printf '%s' "$resp" | jq -r '.accepted // 0')))
		duplicates_total=$((duplicates_total + $(printf '%s' "$resp" | jq -r '.duplicates // 0')))
		: >"$batch"
		bytes=0
	}
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		# Count bytes, not characters: a UTF-8 row over 4 MiB of characters is
		# already larger than the daemon's byte cap.
		len=$(printf '%s' "$line" | wc -c)
		if [ "$len" -gt "$BATCH_MAX" ]; then
			printf 'agent-warehouse-sync: a %s-byte row exceeds the %s-byte budget; raise AGENT_INGEST_MAX_BODY on the daemon\n' "$len" "$BATCH_MAX" >&2
			exit 1
		fi
		if [ "$bytes" -gt 0 ] && [ $((bytes + len)) -gt "$BATCH_MAX" ]; then
			post_batch || exit 1
		fi
		printf '%s\n' "$line" >>"$batch"
		bytes=$((bytes + len + 1))
	done < <(cat "$sessions_rows" "$entries_rows")
	post_batch || exit 1
	remove_processed
	jq -n --arg route "$route" --argjson accepted "$accepted_total" --argjson duplicates "$duplicates_total" \
		'{route:$route, accepted:$accepted, duplicates:$duplicates}'
	exit 0
fi

if [ -z "$TOKEN" ]; then
	echo 'agent-warehouse-sync: set motherduck_token (MotherDuck access token; see README)' >&2
	exit 1
fi

# --direct is the sender's job (docs/d221): the sender owns the schema, the
# duckdb version gate and the first-write-wins inserts, so this leg hands it
# every row the run read -- the parsed files plus the daemon's tails -- instead
# of carrying a second copy of the DDL (docs/d217).
direct="$tmp/direct.ndjson"
rotated="$tmp/rotated"
: >"$rotated"
cat "$sessions_rows" "$entries_rows" >"$direct"
# Only the tails this run froze. The live path may be recreated by the daemon
# while the fold runs, and deleting it here would discard rows this run never
# read. The list is captured with the reads so a later glob cannot widen it.
for sp in "$spool_base".rm.*; do
	[ -f "$sp" ] || continue
	cat "$sp" >>"$direct"
	printf '%s\n' "$sp" >>"$rotated"
done
if ! bash "$SENDER" --spool "$direct" --deadlog "$spool_base.dead.ndjson"; then
	printf 'agent-warehouse-sync: the sender refused the direct fold\n' >&2
	exit 1
fi
remove_processed
# A direct run folded every tail it read, and the sender deleted the file it was
# handed; the tails listed before the fold go only after the ack.
while IFS= read -r sp; do
	[ -n "$sp" ] && rm -f "$sp"
done <"$rotated"
jq -n --arg db "md:$(env_or AGENT_WAREHOUSE_DB agent)" \
	--argjson sessions "$session_count" --argjson entries "$entry_count" \
	'{database:$db, parsed_sessions:$sessions, parsed_entries:$entries}'
exit 0
