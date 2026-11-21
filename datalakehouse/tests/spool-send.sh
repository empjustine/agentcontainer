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
has 'an unidentified row is keyed by spool file and line' "$out" '"id":"spool-foreign.ndjson-2"'

# The key is the FILE and the line, never the line alone: a rotated tail is a new
# generation, so the same position cannot collide with another row's key (a clash
# is a silent drop under ON CONFLICT DO NOTHING).
cp "$tmp/foreign.ndjson" "$tmp/foreign.ndjson.rm.77"
out=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --spool "$tmp/foreign.ndjson.rm.77" --print-rows 2>/dev/null)
has 'a rotated tail has its own id space' "$out" '"id":"spool-foreign.ndjson.rm.77-2"'

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

if [ "$fails" -gt 0 ]; then
	printf '%s spool-send test(s) FAILED\n' "$fails" >&2
	exit 1
fi
printf 'all spool-send tests passed\n'

