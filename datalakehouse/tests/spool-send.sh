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
check 'report rotates nothing' "0" "$(ls "$tmp" | grep -c 'spool.ndjson.rm.' || true)"

mkdir -p "$tmp/empty"
rc=0
env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --spool "$tmp/empty/none.ndjson" --dry >/dev/null 2>&1 || rc=$?
check 'a missing spool is a no-op, not an error' 0 "$rc"

if [ "$fails" -gt 0 ]; then
	printf '%s spool-send test(s) FAILED\n' "$fails" >&2
	exit 1
fi
printf 'all spool-send tests passed\n'

