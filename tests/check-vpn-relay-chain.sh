#!/bin/sh
# check-vpn-relay-chain.sh — the relay chain step's four gates (docs/d095):
# reuse, refusal, the start path's env sequencing, and the credential gate.
#
# WHAT IT PINS:
#   * reuse — a relay answering THIS tunnel is reused, and the child gets the
#     loopback proxy spelling (both cases: HTTP proxy + SOCKS5h);
#   * refusal — a foreign listener on the port is a named failure, never a
#     second relay and never a child;
#   * sequencing — the relay is launched with the HOST's chain variables
#     (d094) while the child gets the loopback spelling, and the detached
#     launch carries --restart (the stable-listener contract);
#   * the credential gate — a missing VPN_OPERATOR_TOKEN fails before any
#     probe or launch.
#
# WHY IT EXISTS: every other gate is blind to this class of bug. shellcheck
# sees the variable names but not which process receives which value; the
# workload API's own test (tests/check-workload.sh) renders descriptions BY
# CONSTRUCTION, so it cannot express "the relay and its child get different
# spellings of the same variable" — the exact property that makes the chain
# step safe. The stub curl answers /healthz from a fixture, so no relay runs.
#
# Usage: ./tests/check-vpn-relay-chain.sh

set -eu

root=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM
mkdir -p -- "$tmp/bin"

# --- fixtures ---------------------------------------------------------------
# The relay's own healthz shape: compact JSON, sorted keys (encoding/json).
# The tunnel here is the NORMALIZED spelling (d090) — the chain step compares
# against what the binary reports, not against the operator's URL.
printf '%s\n' '{"sessions":0,"status":"ok","tunnel":"wss://relay.example.test"}' >"$tmp/healthz.ours"
printf '%s\n' '{"sessions":0,"status":"ok","tunnel":"wss://other.example.test"}' >"$tmp/healthz.foreign"

# Stub curl: answers /healthz from STUB_HEALTHZ, "connection refused" (exit 7)
# otherwise. STUB_FAIL_FIRST=1 fails the FIRST probe and records that it ran —
# the start-path scenario (nothing listening, then the launch answers).
cat >"$tmp/bin/curl" <<'STUB'
#!/bin/sh
url=''
for a in "$@"; do
	case "$a" in http*) url="$a" ;; esac
done
case "$url" in
*/healthz) ;;
*) exit 7 ;;
esac
if [ "${STUB_FAIL_FIRST:-}" = 1 ] && [ ! -e "${STUB_SEEN:-/nonexistent}" ]; then
	: >"$STUB_SEEN"
	exit 7
fi
[ -f "${STUB_HEALTHZ:-}" ] || exit 7
cat "$STUB_HEALTHZ"
STUB
chmod 0755 -- "$tmp/bin/curl"

# Stub podman: records the launch argv (the assertion surface) and swallows
# the rm.  A real backend is never reached — the probe answers first.
cat >"$tmp/bin/podman" <<'STUB'
#!/bin/sh
if [ "$1" = container ] && [ "$2" = run ]; then
	{ for a in "$@"; do printf 'ARG[%s]\n' "$a"; done; } >"$ARGV_OUT"
	exit 0
fi
printf '%s\n' "$*" >>"$RM_OUT"
exit 0
STUB
chmod 0755 -- "$tmp/bin/podman"

# The children: one prints the proxy env it inherited, one proves it ran.
cat >"$tmp/child-env.sh" <<'CHILD'
#!/bin/sh
printf 'HTTP_PROXY=%s\n' "${HTTP_PROXY:-}"
printf 'HTTPS_PROXY=%s\n' "${HTTPS_PROXY:-}"
printf 'http_proxy=%s\n' "${http_proxy:-}"
printf 'ALL_PROXY=%s\n' "${ALL_PROXY:-}"
printf 'NO_PROXY=%s\n' "${NO_PROXY:-}"
CHILD
chmod 0755 -- "$tmp/child-env.sh"
cat >"$tmp/child-ran.sh" <<'CHILD'
#!/bin/sh
: >"$SENTINEL"
CHILD
chmod 0755 -- "$tmp/child-ran.sh"

# env -i: the chain step forwards only NON-EMPTY names, so an ambient proxy
# variable in the caller's shell would otherwise make the argv machine-
# dependent (the same reason tests/check-run-dirs.sh isolates).
_env() {
	env -i PATH="$tmp/bin:$PATH" HOME="$tmp" \
		ARGV_OUT="$tmp/argv.out" RM_OUT="$tmp/rm.out" \
		STUB_HEALTHZ="$STUB_HEALTHZ" STUB_SEEN="$tmp/seen" STUB_FAIL_FIRST="${STUB_FAIL_FIRST:-}" \
		SENTINEL="$tmp/ran" VPN_OPERATOR_TOKEN="tok-test" \
		"$@"
}

_fail=0
_check() {
	_ok="$1"
	shift
	if [ "$_ok" = 0 ]; then
		printf 'ok: %s\n' "$*"
	else
		_fail=1
		printf 'FAIL: %s\n' "$*" >&2
	fi
}
# _has <file> <fixed string> <label>
_has() {
	if grep -qF -- "$2" "$1"; then _check 0 "$3"; else _check 1 "$3"; fi
}
# _absent <file> <fixed string> <label>
_absent() {
	if grep -qF -- "$2" "$1"; then _check 1 "$3"; else _check 0 "$3"; fi
}
# _empty <file> <label> — ok when nothing was written (no launch happened)
_empty() {
	if [ ! -s "$1" ]; then _check 0 "$2"; else _check 1 "$2"; fi
}
# _missing <path> <label> — ok when the path does not exist (the child did not run)
_missing() {
	if [ ! -e "$1" ]; then _check 0 "$2"; else _check 1 "$2"; fi
}
# _rc_is <expected> <actual> <label>
_rc_is() {
	if [ "$2" -eq "$1" ]; then _check 0 "$3"; else _check 1 "$3 (got $2)"; fi
}

# --- case 1: an answering relay is REUSED, the child gets the spelling ------
: >"$tmp/argv.out"
STUB_HEALTHZ="$tmp/healthz.ours"
export STUB_HEALTHZ
(cd "$root" && _env VPN_TUNNEL_URL=https://relay.example.test/vpn \
	HTTPS_PROXY=http://corp.example:3128 \
	"$root/llm-reverse-proxy/vpn-relay.sh" "$tmp/child-env.sh") >"$tmp/out.reuse" 2>&1 || {
	printf 'FAIL: chain step exited %s on the reuse path\n' "$?" >&2
	sed 's/^/  /' "$tmp/out.reuse" >&2
	exit 1
}
for _pair in "HTTP_PROXY=http://127.0.0.1:3128" "HTTPS_PROXY=http://127.0.0.1:3128" \
	"http_proxy=http://127.0.0.1:3128" "ALL_PROXY=socks5h://127.0.0.1:1080"; do
	_has "$tmp/out.reuse" "$_pair" "reuse child env: $_pair"
done
_has "$tmp/out.reuse" 'NO_PROXY=127.0.0.1,localhost,::1' 'reuse child env: loopback stays direct'
_absent "$tmp/out.reuse" 'corp.example' 'reuse child env: the host chain spelling did not reach the child'
_empty "$tmp/argv.out" 'reuse started no container'

# --- case 2: a FOREIGN listener is refused, the child never runs ------------
STUB_HEALTHZ="$tmp/healthz.foreign"
export STUB_HEALTHZ
: >"$tmp/argv.out"
rm -f -- "$tmp/ran"
set +e
(cd "$root" && _env VPN_TUNNEL_URL=https://relay.example.test/vpn \
	HTTPS_PROXY=http://corp.example:3128 \
	"$root/llm-reverse-proxy/vpn-relay.sh" "$tmp/child-ran.sh") >"$tmp/out.foreign" 2>&1
_rc=$?
set -e
_rc_is 94 "$_rc" 'foreign listener exits 94'
_has "$tmp/out.foreign" 'refusing to start a second one' 'foreign listener names the refusal'
_missing "$tmp/ran" 'foreign listener ran no child'
_empty "$tmp/argv.out" 'foreign listener started no container'

# --- case 3: the start path — host chain to the relay, loopback to the child
STUB_HEALTHZ="$tmp/healthz.ours"
STUB_FAIL_FIRST=1
export STUB_HEALTHZ STUB_FAIL_FIRST
: >"$tmp/argv.out"
rm -f -- "$tmp/seen"
(cd "$root" && _env VPN_TUNNEL_URL=https://relay.example.test/vpn \
	HTTPS_PROXY=http://corp.example:3128 \
	"$root/llm-reverse-proxy/vpn-relay.sh" "$tmp/child-env.sh") >"$tmp/out.start" 2>&1 || {
	printf 'FAIL: chain step exited %s on the start path\n' "$?" >&2
	sed 's/^/  /' "$tmp/out.start" >&2
	exit 1
}
_has "$tmp/argv.out" 'ARG[--detach]' 'start: detached'
_has "$tmp/argv.out" 'ARG[--restart=unless-stopped]' 'start: restart policy (the stable listener)'
_has "$tmp/argv.out" 'ARG[--network=host]' 'start: host network (loopback is the HOST loopback)'
_has "$tmp/argv.out" 'ARG[-mode]' 'start: relay mode'
_has "$tmp/argv.out" 'ARG[-proxy-listen]' 'start: the loopback listener is the one the child is handed'
_has "$tmp/argv.out" 'ARG[VPN_OPERATOR_TOKEN]' 'start: the relay container carries the credential'
_has "$tmp/argv.out" 'ARG[HTTPS_PROXY]' 'start: the HOST chain name rides to the relay (d094)'
_absent "$tmp/argv.out" 'HTTPS_PROXY=http://127.0.0.1:3128' 'start: the loopback spelling never rides as the relay own chain'
_has "$tmp/out.start" 'HTTPS_PROXY=http://127.0.0.1:3128' 'start: the child got the loopback spelling'

# --- case 4: a missing credential fails before any probe or launch ----------
STUB_HEALTHZ="$tmp/healthz.ours"
STUB_FAIL_FIRST=''
export STUB_HEALTHZ STUB_FAIL_FIRST
: >"$tmp/argv.out"
set +e
(cd "$root" && env -i PATH="$tmp/bin:$PATH" HOME="$tmp" \
	ARGV_OUT="$tmp/argv.out" RM_OUT="$tmp/rm.out" STUB_HEALTHZ="$tmp/healthz.ours" \
	VPN_TUNNEL_URL=https://relay.example.test/vpn \
	"$root/llm-reverse-proxy/vpn-relay.sh" "$tmp/child-ran.sh") >"$tmp/out.nocred" 2>&1
_rc=$?
set -e
_rc_is 94 "$_rc" 'missing token exits 94'
_has "$tmp/out.nocred" 'VPN_OPERATOR_TOKEN' 'missing token names the variable'
_empty "$tmp/argv.out" 'missing token started no container'

[ "$_fail" = 0 ] || {
	printf 'FAIL: check-vpn-relay-chain (see above)\n' >&2
	exit 1
}
printf 'PASS check-vpn-relay-chain (reuse, refusal, start sequencing, credential gate)\n'
