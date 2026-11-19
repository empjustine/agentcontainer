#!/bin/bash
# Self-send tests (docs/d217): the daemon folds its own spool when it holds a
# MotherDuck token and the tail crosses the byte threshold, and stays hands-off
# without a token. The sender is stubbed, so no duckdb, jq or network is needed.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -e
UNIT="$(CDPATH='' cd "$(dirname "$0")/.." && pwd)"
DAEMON="$UNIT/agent-warehouse-daemon.sh"
tmp=$(mktemp -d)
daemon_pid=""
cleanup() {
	[ -z "$daemon_pid" ] || kill "$daemon_pid" 2>/dev/null || true
	rm -rf "$tmp"
}
trap cleanup EXIT
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi; }

# The stub records the argv it was handed and exits 0 without consuming the
# spool, so a run reports "folded" while the file stays for the next check.
stub="$tmp/sender-stub.sh"
marker="$tmp/sent.txt"
cat >"$stub" <<STUB
#!/bin/sh
printf '%s\\n' "\$*" >>"$marker"
exit 0
STUB

port=$((19000 + ($$ % 1000)))
start_daemon() { # $1 = log file, rest = env assignments
	local log=$1
	shift
	env -i PATH="$PATH" HOME="$tmp/home" AGENT_INGEST_ADDR="127.0.0.1:$port" \
		AGENT_WAREHOUSE_SPOOL="$tmp/spool.ndjson" AGENT_WAREHOUSE_SENDER="$stub" \
		"$@" bash "$DAEMON" >"$log" 2>&1 &
	daemon_pid=$!
	ready=0
	i=0
	while [ "$i" -lt 50 ]; do
		if curl -s -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
			ready=1
			break
		fi
		i=$((i + 1))
		sleep 0.1
	done
	[ "$ready" = 1 ]
}

wait_for() { # $1 = file
	i=0
	while [ "$i" -lt 50 ]; do
		[ -s "$1" ] && return 0
		i=$((i + 1))
		sleep 0.1
	done
	return 1
}

# 1 - a token plus a crossed threshold folds the tail, through the sender script
if start_daemon "$tmp/d1.log" motherduck_token=test AGENT_WAREHOUSE_SPOOL_MAX_BYTES=1; then
	curl -s -X POST -H 'content-type: application/json' \
		--data '{"session_id":"s1","id":"e1","payload":{"x":1}}' \
		"http://127.0.0.1:$port/ingest/session" >/dev/null
	if wait_for "$marker"; then
		ok 'threshold + token runs the sender'
		has_spool_arg=$(grep -c -- "--spool $tmp/spool.ndjson" "$marker" || true)
		check 'sender gets the live spool path' 1 "$has_spool_arg"
	else
		bad 'the daemon did not run the sender'
	fi
	if grep -q 'spool folded' "$tmp/d1.log"; then
		ok 'the fold is logged'
	else
		bad 'no fold log line'
	fi
else
	bad 'token daemon did not start'
fi
kill "$daemon_pid" 2>/dev/null || true
daemon_pid=""

# 2 - no token: the daemon keeps appending and never spawns a sender
port=$((port + 1))
rm -f "$tmp/spool.ndjson" "$marker"
if start_daemon "$tmp/d2.log" AGENT_WAREHOUSE_SPOOL_MAX_BYTES=1; then
	curl -s -X POST -H 'content-type: application/json' \
		--data '{"session_id":"s2","id":"e2","payload":{"x":2}}' \
		"http://127.0.0.1:$port/ingest/session" >/dev/null
	sleep 0.5
	if [ -e "$marker" ]; then
		bad 'no token must not spawn the sender'
	else
		ok 'no token leaves the sender alone'
	fi
	if grep -q 'self-send is off' "$tmp/d2.log"; then
		ok 'the off state is reported'
	else
		bad 'no self-send status line'
	fi
else
	bad 'token-less daemon did not start'
fi
kill "$daemon_pid" 2>/dev/null || true
daemon_pid=""

# 3 - a token but the tail is under the threshold: nothing is folded yet
port=$((port + 1))
rm -f "$tmp/spool.ndjson" "$marker"
if start_daemon "$tmp/d3.log" motherduck_token=test AGENT_WAREHOUSE_SPOOL_MAX_BYTES=100000; then
	curl -s -X POST -H 'content-type: application/json' \
		--data '{"session_id":"s3","id":"e3","payload":{"x":3}}' \
		"http://127.0.0.1:$port/ingest/session" >/dev/null
	sleep 0.5
	if [ -e "$marker" ]; then
		bad 'a small tail must stay in the spool'
	else
		ok 'a small tail stays spooled'
	fi
	if [ -s "$tmp/spool.ndjson" ]; then ok 'the row is on disk'; else bad 'row missing from the spool'; fi
else
	bad 'threshold daemon did not start'
fi

if [ "$fails" -gt 0 ]; then
	printf '%s self-send test(s) FAILED\n' "$fails" >&2
	exit 1
fi
printf 'all self-send tests passed\n'

