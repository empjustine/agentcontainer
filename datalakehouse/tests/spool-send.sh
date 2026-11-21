#!/bin/sh
# Sender tests: row normalisation and no-side-effect reports, no token, no duckdb.
[ -n "$BASH_VERSION" ] || exec bash "$0" "$@"
set -e
SCRIPT="$(CDPATH='' cd "$(dirname "$0")/.." && pwd)/agent-warehouse-spool-send.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi; }
has() { if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1 (missing [$3])"; fi; }

spool="$tmp/spool.ndjson"
printf '%s\n' '{"id":"a1","type":"search","timestamp":"2026-11-15T00:00:00Z","queries":["x"]}' >"$spool"

out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --spool "$spool" --print-rows 2>/dev/null)
has 'foreign row wrapped as an entry' "$out" '"id":"a1"'
has 'foreign body kept verbatim as payload' "$out" '"queries"'
has 'timestamp maps to ts' "$out" '"ts":"2026-11-15T00:00:00Z"'

out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --spool "$spool" --dry 2>&1)
has 'dry counts the spool' "$out" '1 line(s)'

check 'report leaves the spool in place' "$spool" "$(ls "$spool" 2>/dev/null)"
rotated=0
for rotated_file in "$tmp"/spool.ndjson.rm.*; do
	[ -e "$rotated_file" ] && rotated=$((rotated + 1))
done
check 'report rotates nothing' "0" "$rotated"

mkdir -p "$tmp/empty"
rc=0
env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --spool "$tmp/empty/none.ndjson" --dry >/dev/null 2>&1 || rc=$?
check 'a missing spool is a no-op, not an error' 0 "$rc"

# A foreign source lands in the harness envelope, not in pi's columns (docs/d221):
# its promoted shape has no reader yet, so the row keeps its own identity and the
# object verbatim as payload.
cat >"$tmp/foreign.ndjson" <<'EOF'
{"source":"vibe_legacy","session_id":"s1","role":"user","content":"hi","message_id":"m1"}
{"source":"vibe_legacy","session_id":"s1","role":"tool","content":"out"}
{"source":"opencode_v2","kind":"session","session_id":"v2a","cwd":"/w"}
EOF
out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --spool "$tmp/foreign.ndjson" --print-rows 2>/dev/null)
has 'a foreign row keeps its source' "$out" '"source":"vibe_legacy"'
has 'message_id stands in for the entry id' "$out" '"id":"m1"'
has 'a foreign entry keeps its order' "$out" '"seq":1'
has 'an explicit kind makes a session row' "$out" '"source":"opencode_v2"'
has 'an unidentified row is keyed by its content' "$out" '"id":"spool-'
id_plain=$(printf '%s\n' "$out" | sed -n 2p | jq -r .id)

# The identity is content-addressed, not the file and line: a rotated tail (the
# sender renames the live spool to .rm.<pid>) and a direct fold that concatenates
# rows into a differently named temp file must reproduce the same key, or every
# re-run appends a new copy under ON CONFLICT DO NOTHING.
cp "$tmp/foreign.ndjson" "$tmp/foreign.ndjson.rm.77"
out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --spool "$tmp/foreign.ndjson.rm.77" --print-rows 2>/dev/null)
has 'a rotated tail keeps the content id' "$out" '"id":"spool-'
id_rotated=$(printf '%s\n' "$out" | sed -n 2p | jq -r .id)
check 'a re-read row keeps one id across the rotation' "$id_plain" "$id_rotated"

# pi's canonical session row is a session, not an entry: the sweep hands these to
# the sender over --direct, and reading them as entries would bury every header.
printf '%s
' '{"session_id":"sess-1","store":"session","cwd":"/w","version":3}' >"$tmp/canon.ndjson"
out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --spool "$tmp/canon.ndjson" --print-rows 2>/dev/null)
has 'a canonical session row stays a session' "$out" '"session_file":"spool"'
if printf '%s' "$out" | grep -q '"line_no"'; then
	bad 'a canonical session row must not become an entry'
else
	ok 'a canonical session row carries no entry line'
fi

# A stub duckdb exercises the write path without a network or the real binary.
# It also records its argv, which is how the token-in-argv regression stays
# caught: the credential belongs in the environment, not in /proc.
stubdir="$tmp/bin"
mkdir -p "$stubdir"
cat >"$stubdir/duckdb" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >>"$DUCKDB_ARGS"
case "$1" in
--version) echo 'v1.5.0 stub'; exit 0 ;;
-json) if [ -n "$DUCKDB_SLEEP" ]; then sleep 2; fi ;;
esac
echo '{"sessions":1,"entries":1,"harness_entries":1}'
STUB
chmod +x "$stubdir/duckdb"

good="$tmp/good.ndjson"
printf '%s\n' '{"source":"vibe_legacy","session_id":"s1","id":"e1","payload":{"x":1}}' >"$good"
rc=0
env -i PATH="$stubdir:$PATH" HOME="$tmp/nohome" DUCKDB_ARGS="$tmp/duckdb.args" \
	motherduck_token=supersecret bash "$SCRIPT" --spool "$good" >/dev/null 2>&1 || rc=$?
check 'a good spool is consumed' 0 "$rc"
if [ -e "$good" ]; then
	bad 'a consumed spool must be deleted after the ack'
else
	ok 'a consumed spool is deleted after the ack'
fi
if grep -q 'supersecret' "$tmp/duckdb.args" 2>/dev/null; then
	bad 'the token must not reach duckdb argv'
else
	ok 'the token stays out of duckdb argv'
fi

# A malformed line is a dead letter: the bad line, its last session header and
# the surrounding lines are preserved, and the tail is consumed so one poison
# line cannot block the archive forever.
badspool="$tmp/badspool.ndjson"
deadlog="$tmp/bad.dead.ndjson"
cat >"$badspool" <<'JSON'
{"type":"session","id":"sess-bad","timestamp":"2026-11-15T00:00:00Z","cwd":"/w"}
{"type":"message","id":"e1","parentId":null,"timestamp":"2026-11-15T00:00:01Z","message":{"role":"user","content":"a"}}
{not json
{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-11-15T00:00:02Z","message":{"role":"assistant","content":"b"}}
JSON
rc=0
env -i PATH="$stubdir:$PATH" HOME="$tmp/nohome" DUCKDB_ARGS="$tmp/duckdb2.args" \
	motherduck_token=supersecret bash "$SCRIPT" --spool "$badspool" --deadlog "$deadlog" >/dev/null 2>&1 || rc=$?
check 'a malformed line is quarantined, not fatal' 0 "$rc"
if [ -e "$badspool" ] || ls "$badspool".rm.* >/dev/null 2>&1; then
	bad 'a quarantined tail must be consumed'
else
	ok 'a quarantined tail is consumed'
fi
if [ -s "$deadlog" ]; then ok 'a dead letter is written'; else bad 'no dead letter'; fi
check 'one dead letter' 1 "$(jq -s 'length' "$deadlog")"
check 'the raw bad line is preserved' '{not json' "$(jq -s -r '.[0].line_raw' "$deadlog")"
check 'the session header is preserved' 'sess-bad' \
	"$(jq -s -r '.[0].session_line_raw' "$deadlog" | jq -r '.id')"
check 'the dead letter carries two before lines' 2 \
	"$(jq -s '.[0].context_before | length' "$deadlog")"
check 'the dead letter carries one after line' 1 \
	"$(jq -s '.[0].context_after | length' "$deadlog")"
check 'the dead letter names the source line' 3 "$(jq -s -r '.[0].line_no' "$deadlog")"

# The dead letter is content-idempotent: re-reading the same bad line under a
# different tail must not append a second copy.
dup="$tmp/dup.ndjson"
printf '%s\n' '{not json' >"$dup"
rc=0
env -i PATH="$stubdir:$PATH" HOME="$tmp/nohome" DUCKDB_ARGS="$tmp/duckdb3.args" \
	motherduck_token=supersecret bash "$SCRIPT" --spool "$dup" --deadlog "$deadlog" >/dev/null 2>&1 || rc=$?
check 'a repeated dead letter is a no-op' 0 "$rc"
check 'the dead letter is not duplicated' 1 "$(jq -s 'length' "$deadlog")"

# Report mode has no side effects: a bad line exits 1, writes no dead letter and
# leaves the tail in place.
report="$tmp/report.ndjson"
printf '%s\n' '{not json' >"$report"
rc=0
env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --spool "$report" --dry \
	--deadlog "$tmp/report.dead.ndjson" >/dev/null 2>&1 || rc=$?
check 'a report run fails on a bad line' 1 "$rc"
if [ -e "$report" ]; then ok 'a report run keeps the tail'; else bad 'a report run deleted the tail'; fi
if [ -e "$tmp/report.dead.ndjson" ]; then bad 'a report run wrote a dead letter'; else ok 'a report run writes no dead letter'; fi

# The shared lock: a second sender of the same spool exits 75 while the first
# holds it, rather than racing the rotation or the delete.
lockspool="$tmp/lock.ndjson"
printf '%s\n' '{"source":"vibe_legacy","session_id":"s3","id":"e3","payload":{}}' >"$lockspool"
env -i PATH="$stubdir:$PATH" HOME="$tmp/nohome" DUCKDB_ARGS="$tmp/duckdb4.args" \
	DUCKDB_SLEEP=1 motherduck_token=supersecret bash "$SCRIPT" --spool "$lockspool" >/dev/null 2>&1 &
lockpid=$!
i=0
while [ "$i" -lt 40 ]; do
	if [ -e "$lockspool.lock" ] || [ -d "$lockspool.lock.d" ]; then break; fi
	i=$((i + 1))
	sleep 0.05
done
rc=0
env -i PATH="$stubdir:$PATH" HOME="$tmp/nohome" DUCKDB_ARGS="$tmp/duckdb5.args" \
	motherduck_token=supersecret bash "$SCRIPT" --spool "$lockspool" >/dev/null 2>&1 || rc=$?
check 'a second sender is refused by the shared lock' 75 "$rc"
if wait "$lockpid"; then ok 'the first sender still finishes'; else bad 'the first sender failed'; fi

rc=0
env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --db 'bad-name; DROP TABLE x' --dry >/dev/null 2>&1 || rc=$?
check 'a non-identifier database name is refused' 64 "$rc"

if [ "$fails" -gt 0 ]; then
	printf '%s spool-send test(s) FAILED\n' "$fails" >&2
	exit 1
fi
printf 'all spool-send tests passed\n'

