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
	# A fixed formula can land on a port another process already holds, and the
	# sweep runs this beside other suites. Retry on a nearby port rather than
	# failing the whole gate on an unlucky number; the caller's curl uses the
	# global port this leaves behind.
	local tries=0 ready i
	while [ "$tries" -lt 5 ]; do
		env -i PATH="$PATH" HOME="$tmp/home" AGENT_INGEST_ADDR="127.0.0.1:$port" \
			AGENT_WAREHOUSE_SPOOL="$tmp/spool.ndjson" AGENT_WAREHOUSE_SENDER="$stub" \
			"$@" bash "$DAEMON" >"$log" 2>&1 &
		daemon_pid=$!
		ready=0
		i=0
		while [ "$i" -lt 100 ]; do
			if curl -s -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
				ready=1
				break
			fi
			# The daemon exits at once on a bind failure; stop waiting for it.
			kill -0 "$daemon_pid" 2>/dev/null || break
			i=$((i + 1))
			sleep 0.1
		done
		if [ "$ready" = 1 ]; then
			return 0
		fi
		kill "$daemon_pid" 2>/dev/null || true
		daemon_pid=""
		port=$((port + 7))
		tries=$((tries + 1))
	done
	return 1
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

wait_for_text() { # $1 = file, $2 = pattern (the log line lands after the stub's marker)
	i=0
	while [ "$i" -lt 50 ]; do
		grep -q "$2" "$1" 2>/dev/null && return 0
		i=$((i + 1))
		sleep 0.1
	done
	return 1
}

wait_for_lines() { # $1 = file, $2 = minimum line count
	i=0
	while [ "$i" -lt 50 ]; do
		[ "$(wc -l <"$1" 2>/dev/null || echo 0)" -ge "$2" ] && return 0
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
	if wait_for_text "$tmp/d1.log" 'spool folded'; then
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

# 4 - a frozen tail a killed fold left behind is folded at startup, even under
# the ceiling and with no live spool: the sender globs spool and spool.rm.*, so
# the daemon must count both or the leftover waits for traffic that may never
# come.
port=$((port + 1))
rm -f "$tmp"/spool.ndjson* "$marker"
printf '{"session_id":"s4","id":"e4","payload":{"x":4}}\n' >"$tmp/spool.ndjson.rm.4242"
if start_daemon "$tmp/d4.log" motherduck_token=test; then
	if wait_for "$marker"; then
		ok 'a leftover frozen tail is folded at startup'
	else
		bad 'the startup fold skipped the leftover tail'
	fi
else
	bad 'startup-leftover daemon did not start'
fi
kill "$daemon_pid" 2>/dev/null || true
daemon_pid=""

# 5 - a non-numeric ceiling is replaced by the default. Left as NaN it would
# compare false against every guard and fold on every accepted row.
port=$((port + 1))
rm -f "$tmp"/spool.ndjson* "$marker"
if start_daemon "$tmp/d5.log" motherduck_token=test AGENT_WAREHOUSE_SPOOL_MAX_BYTES=32MB; then
	curl -s -X POST -H 'content-type: application/json' \
		--data '{"session_id":"s5","id":"e5","payload":{"x":5}}' \
		"http://127.0.0.1:$port/ingest/session" >/dev/null
	sleep 0.5
	if [ -e "$marker" ]; then
		bad 'a non-numeric ceiling must not fold on every append'
	else
		ok 'a non-numeric ceiling falls back to the default'
	fi
	if grep -q 'AGENT_WAREHOUSE_SPOOL_MAX_BYTES="32MB" is not a number' "$tmp/d5.log"; then
		ok 'the bad value is reported'
	else
		bad 'no bad-value warning'
	fi
else
	bad 'bad-ceiling daemon did not start'
fi
kill "$daemon_pid" 2>/dev/null || true
daemon_pid=""

# 6 - a failed fold retries on its own timer, with no further POST. The stub
# fails once and then succeeds without consuming the spool, so it also proves a
# zero-progress success does not re-trigger itself forever.
port=$((port + 1))
rm -f "$tmp"/spool.ndjson* "$marker"
retry_stub="$tmp/sender-retry.sh"
cat >"$retry_stub" <<STUB
#!/bin/sh
printf '%s\\n' "\$*" >>"$marker"
[ "\$(wc -l <"$marker")" -gt 1 ]
STUB
if start_daemon "$tmp/d6.log" motherduck_token=test AGENT_WAREHOUSE_SPOOL_MAX_BYTES=1 \
	AGENT_WAREHOUSE_SENDER="$retry_stub" AGENT_WAREHOUSE_SPOOL_SEND_RETRY=200; then
	curl -s -X POST -H 'content-type: application/json' \
		--data '{"session_id":"s6","id":"e6","payload":{"x":6}}' \
		"http://127.0.0.1:$port/ingest/session" >/dev/null
	if wait_for_lines "$marker" 2; then
		ok 'a failed fold retries on its own timer'
	else
		bad 'no retry happened without a further POST'
	fi
	sleep 0.5
	check 'a zero-progress success does not re-trigger' 2 "$(wc -l <"$marker")"
else
	bad 'retry daemon did not start'
fi
kill "$daemon_pid" 2>/dev/null || true
daemon_pid=""

if [ "$fails" -gt 0 ]; then
	printf '%s self-send test(s) FAILED\n' "$fails" >&2
	exit 1
fi
printf 'all self-send tests passed\n'

