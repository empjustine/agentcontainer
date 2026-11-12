#!/bin/sh
# Root-resolution and parse tests for agent-warehouse-sync.sh - no token, no
# duckdb, no MotherDuck. ./test.sh runs every */tests/*.sh with sh, so re-exec
# into bash, and env -i keeps a host's own PI_CODING_AGENT_*/XDG_* out of a case.
[ -n "$BASH_VERSION" ] || exec bash "$0" "$@"
set -e
SCRIPT="$(CDPATH='' cd "$(dirname "$0")/.." && pwd)/agent-warehouse-sync.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi; }
has() { if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1 (missing [$3] in [$2])"; fi; }

sessdir="$tmp/pi/sessions"
agentdir="$tmp/pi/agent"
wt="$tmp/wt-a"
gone="$tmp/does-not-exist"
mkdir -p "$sessdir/proj--worktree" "$sessdir/gone--x" \
	"$agentdir/delegation/default/parent-1" \
	"$agentdir/delegation/default/parent-1/.resources/res-1" \
	"$wt"
: >"$wt/.git" # a linked worktree keeps .git as a FILE

cat >"$sessdir/proj--worktree/s1.jsonl" <<JSON
{"type":"session","version":3,"id":"sess-1","timestamp":"2026-11-12T10:00:00.000Z","cwd":"$wt"}
{"type":"message","id":"e1","parentId":null,"timestamp":"2026-11-12T10:00:01.000Z","message":{"role":"user","content":"hi"}}
{"type":"usage","id":"e2","parentId":"e1","timestamp":"2026-11-12T10:00:02.000Z","usage":{"total":1}}
JSON
cat >"$sessdir/gone--x/s2.jsonl" <<JSON
{"type":"session","version":3,"id":"sess-2","timestamp":"2026-11-12T10:30:00.000Z","cwd":"$gone"}
{"type":"message","id":"g1","parentId":null,"timestamp":"2026-11-12T10:30:01.000Z","message":{"role":"user","content":"gone"}}
JSON
cat >"$agentdir/delegation/default/parent-1/2026-11-12T11-00-00_child-1.jsonl" <<JSON
{"type":"session","version":3,"id":"child-1","timestamp":"2026-11-12T11:00:00.000Z","cwd":"$wt","parentSession":"$sessdir/proj--worktree/s1.jsonl"}
{"type":"message","id":"c1","parentId":null,"timestamp":"2026-11-12T11:00:01.000Z","message":{"role":"user","content":"sub"}}
JSON
cat >"$agentdir/delegation/default/parent-1/.resources/res-1/res.jsonl" <<JSON
{"type":"session","version":3,"id":"res-1","timestamp":"2026-11-12T12:00:00.000Z","cwd":"$wt"}
{"type":"message","id":"r1","parentId":null,"timestamp":"2026-11-12T12:00:01.000Z","message":{"role":"user","content":"res"}}
JSON

# 1 - explicit roots
out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" \
	--session-dir "$sessdir" --agent-dir "$agentdir" --print-roots)
has 'explicit session root' "$out" "session_root=$sessdir"
has 'explicit delegation root' "$out" "delegation_root=$agentdir/delegation"

# 2 - env roots (pi's own vars)
out=$(env -i PATH="$PATH" HOME="$tmp/nohome" \
	PI_CODING_AGENT_SESSION_DIR="$sessdir" PI_CODING_AGENT_DIR="$agentdir" \
	bash "$SCRIPT" --print-roots)
has 'env session root' "$out" "session_root=$sessdir"

# 3 - defaults
out=$(env -i PATH="$PATH" HOME="$tmp/h3" bash "$SCRIPT" --print-roots)
has 'default session root' "$out" "session_root=$tmp/h3/.pi/agent/sessions"
has 'default delegation root' "$out" "delegation_root=$tmp/h3/.pi/agent/delegation"

# 4 - parse counts (4 sessions, 5 entries)
out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" \
	--session-dir "$sessdir" --agent-dir "$agentdir" --dry)
has 'dry session count' "$out" 'sessions=4'
has 'dry entry count' "$out" 'entries=5'

# 5 - store classification (worktree marker, delegation root, plain session)
out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" \
	--session-dir "$sessdir" --agent-dir "$agentdir" --print-rows)
has 'worktree store' "$out" '"store":"worktree"'
has 'delegation store' "$out" '"store":"delegation"'
has 'session store' "$out" '"store":"session"'
has 'payload lands verbatim' "$out" '"payload":'
has 'entries carry the session id' "$out" '"session_id":"sess-1"'

# 6 - orphan report needs no token
out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" \
	--session-dir "$sessdir" --agent-dir "$agentdir" --report-orphans)
has 'orphan reported' "$out" 'orphan:'
has 'orphan names the gone cwd' "$out" "$gone"

# 7 - unknown flag is a usage error
rc=0
env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --frobnicate >/dev/null 2>&1 || rc=$?
check 'unknown flag exits 64' 64 "$rc"

# 8 - nothing to read exits 66
mkdir -p "$tmp/empty"
rc=0
env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" \
	--session-dir "$tmp/empty" --agent-dir "$tmp/empty" --dry >/dev/null 2>&1 || rc=$?
check 'no roots exits 66' 66 "$rc"

# 9 - the daemon spool is a third source
: >"$tmp/spool.ndjson"
printf '%s\n' '{"session_file":"spool","store":"session","line_no":1,"id":"p1","type":"custom","payload":{"from":"spool"}}' >"$tmp/spool.ndjson"
out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" \
	--session-dir "$sessdir" --agent-dir "$agentdir" --spool "$tmp/spool.ndjson" --dry)
has 'spool row counted' "$out" 'entries=6'

# 10 - route mode: the sync posts to the daemon sink, and the daemon dedupes a
# re-run instead of appending the same rows twice (docs/d181).
daemon="$(CDPATH='' cd "$(dirname "$0")/.." && pwd)/agent-warehouse-daemon.sh"
rspool="$tmp/route-spool.ndjson"
port=$((18000 + ($$ % 1000)))
AGENT_INGEST_ADDR="127.0.0.1:$port" AGENT_WAREHOUSE_SPOOL="$rspool" \
	bash "$daemon" >"$tmp/daemon.log" 2>&1 &
daemon_pid=$!
trap 'kill "$daemon_pid" 2>/dev/null || true; rm -rf "$tmp"' EXIT
ready=0
i=0
while [ "$i" -lt 25 ]; do
	if curl -s -o /dev/null "http://127.0.0.1:$port/status" 2>/dev/null; then
		ready=1
		break
	fi
	i=$((i + 1))
	sleep 0.2
done
if [ "$ready" = 1 ]; then
	route="http://127.0.0.1:$port"
	out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" \
		--session-dir "$sessdir" --agent-dir "$agentdir" --route "$route")
	has 'route post accepted rows' "$out" '"accepted"'
	out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" \
		--session-dir "$sessdir" --agent-dir "$agentdir" --route "$route")
	has 'route re-post reports duplicates' "$out" '"duplicates"'
	n1=$(wc -l <"$rspool")
	env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" \
		--session-dir "$sessdir" --agent-dir "$agentdir" --route "$route" >/dev/null
	n2=$(wc -l <"$rspool")
	check 'dedupe keeps the spool stable' "$n1" "$n2"
	# 12 - the dedupe key is the session id, not the file path: the SAME session
	# has a different path inside a sandbox and on the host.
	resp=$(curl -s -X POST -H 'content-type: application/json' \
		--data '[{"session_id":"sid-A","id":"e1","session_file":"/sandbox/a.jsonl"},{"session_id":"sid-A","id":"e1","session_file":"/host/b.jsonl"}]' \
		"http://127.0.0.1:$port/ingest/session")
	has 'same session id, different path, deduped' "$resp" '"duplicates":1'
	# 14 - --rm removes a processed file only after the ack, and only outside the
	# grace window; a just-written file is kept as possibly live.
	rmroot="$tmp/rm-sessions"
	mkdir -p "$rmroot/--x--"
	cp "$sessdir/proj--worktree/s1.jsonl" "$rmroot/--x--/old.jsonl"
	env -i PATH="$PATH" HOME="$tmp/nohome" AGENT_WAREHOUSE_RM_GRACE=0 bash "$SCRIPT" \
		--session-dir "$rmroot" --agent-dir "$tmp/no-agent" --route "$route" --rm >/dev/null 2>&1
	if [ -f "$rmroot/--x--/old.jsonl" ]; then
		bad 'rm should remove a processed file past the grace window'
	else
		ok 'rm removed the processed file after the ack'
	fi
	mkdir -p "$rmroot/--y--"
	cp "$sessdir/proj--worktree/s1.jsonl" "$rmroot/--y--/fresh.jsonl"
	env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" \
		--session-dir "$rmroot" --agent-dir "$tmp/no-agent" --route "$route" --rm >/dev/null 2>&1
	if [ -f "$rmroot/--y--/fresh.jsonl" ]; then
		ok 'rm kept a file inside the grace window (possibly live)'
	else
		bad 'rm removed a file inside the grace window'
	fi
	# 15 - without --rm nothing is removed
	cp "$sessdir/proj--worktree/s1.jsonl" "$rmroot/--y--/keep.jsonl"
	env -i PATH="$PATH" HOME="$tmp/nohome" AGENT_WAREHOUSE_RM_GRACE=0 bash "$SCRIPT" \
		--session-dir "$rmroot" --agent-dir "$tmp/no-agent" --route "$route" >/dev/null 2>&1
	if [ -f "$rmroot/--y--/keep.jsonl" ]; then
		ok 'no --rm leaves files alone'
	else
		bad 'files removed without --rm'
	fi
	if [ -s "$rspool" ]; then
		ok 'route --rm leaves the spool for the host run'
	else
		bad 'route --rm must not clear the spool'
	fi
	# 16 - the route post is batched under a byte budget, so a big payload is not
	# one oversized request (the 413 case)
	broot="$tmp/batch-sessions"
	mkdir -p "$broot"
	{
		printf '{"type":"session","version":3,"id":"batch-1","timestamp":"2026-11-14T09:00:00.000Z","cwd":"%s"}\n' "$wt"
		i=1
		while [ "$i" -le 8 ]; do
			printf '{"type":"message","id":"be%s","parentId":null,"timestamp":"2026-11-14T09:00:01.000Z","message":{"role":"user","content":"x"}}\n' "$i"
			i=$((i + 1))
		done
	} >"$broot/s.jsonl"
	out=$(env -i PATH="$PATH" HOME="$tmp/nohome" AGENT_WAREHOUSE_BATCH_BYTES=800 bash "$SCRIPT" \
		--session-dir "$broot" --agent-dir "$tmp/no-agent" --route "$route")
	has 'batched route post accepts every row' "$out" '"accepted": 9'
else
	bad 'daemon did not start (route mode untested)'
fi
kill "$daemon_pid" 2>/dev/null || true

# 11 - the route is the default transport; --direct opts into MotherDuck
out=$(env -i PATH="$PATH" HOME="$tmp/h11" bash "$SCRIPT" --print-roots)
has 'route defaults to the local daemon' "$out" 'route=http://127.0.0.1:8787'
out=$(env -i PATH="$PATH" HOME="$tmp/h11" AGENT_WAREHOUSE_ROUTE="http://example:9000/" \
	bash "$SCRIPT" --print-roots)
has 'route env override, trailing slash stripped' "$out" 'route=http://example:9000'
out=$(env -i PATH="$PATH" HOME="$tmp/h11" bash "$SCRIPT" --print-roots --direct)
has '--direct disables the route' "$out" 'route=(direct)'

# 13 - a concatenated file carries a second header; each header opens a session
csess="$tmp/concat-sessions"
mkdir -p "$csess"
cat >"$csess/concat.jsonl" <<JSON
{"type":"session","version":3,"id":"cat-a","timestamp":"2026-11-13T09:00:00.000Z","cwd":"$wt"}
{"type":"message","id":"a1","parentId":null,"timestamp":"2026-11-13T09:00:01.000Z","message":{"role":"user","content":"a"}}
{"type":"session","version":3,"id":"cat-b","timestamp":"2026-11-13T10:00:00.000Z","cwd":"$wt"}
{"type":"message","id":"b1","parentId":null,"timestamp":"2026-11-13T10:00:01.000Z","message":{"role":"user","content":"b"}}
JSON
out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" \
	--session-dir "$csess" --agent-dir "$tmp/no-agent" --print-rows)
has 'second header opens its own session' "$out" '"session_id":"cat-b"'
has 'cat-b entries keep their own id' "$out" '"session_id":"cat-b","session_file"'
if printf '%s' "$out" | grep -q '"id":"cat-b"'; then
	bad 'the second header must not be stored as an entry'
else
	ok 'the second header is not an entry'
fi

if [ "$fails" -gt 0 ]; then
	printf '%s agent-warehouse test(s) FAILED\n' "$fails" >&2
	exit 1
fi
printf 'all agent-warehouse tests passed\n'

