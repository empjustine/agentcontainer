#!/usr/bin/env bash
# Behavioural smoke test for llm-reverse-proxy. Builds the binary, spins up a local
# upstream (SSE + echo), and checks every documented behaviour. TLS failure
# classes use the badssl.com test hosts, so no bundled cert is needed
# (requires outbound internet for the TLS section; it is skipped otherwise).
set -euo pipefail
cd "$(dirname "$0")"

TMP=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$TMP"' EXIT
cd "$TMP"

# Pre-flight: our ports must be free BEFORE anything starts. A stale instance
# answering the wait-loop's curl makes the run race (the bind failure may land
# in the log after we already moved on) — so check, don't race. curl is the
# portable probe here (ss/lsof are not always installed): any HTTP answer on
# these ports means a stale HTTP server is squatting on it.
for port in 19091 18101; do
	if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/"; then
		echo "FATAL: port $port already answering — a stale upstream/proxy is running; kill it first" >&2
		exit 1
	fi
done

# build the host binary if it is not there yet (smoke-test must not require
# a prior image/native build). NOTE: `command -v go` is NOT proof of a
# toolchain — a mise shim with no version set answers PATH lookups and fails
# only when invoked ("No version is set for shim: go"). Probe with
# `go version`; without a WORKING go, fail with instructions instead of a
# cryptic mise error (image hosts do not need this binary at all — only
# smoke-test and direct runs do).
if [ ! -x "$OLDPWD/llm-reverse-proxy" ]; then
	command -v go >/dev/null 2>&1 || export PATH="$HOME/.local/share/mise/shims:$PATH"
	if ! go version >/dev/null 2>&1; then
		echo 'FATAL: no working go toolchain (mise hosts: mise use -g go@1.27; Termux: pkg install golang)' >&2
		exit 96
	fi
	(cd "$OLDPWD" && CGO_ENABLED=0 go build -o llm-reverse-proxy .)
fi

cat > upstream.mjs <<'EOF'
import http from 'node:http';
http.createServer((req, res) => {
  if (req.url.startsWith('/v1/stream')) {
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    let i = 0;
    const t = setInterval(() => {
      res.write(`data: chunk ${i++}\n\n`);
      if (i >= 5) { clearInterval(t); res.end('data: [DONE]\n\n'); }
    }, 100);
    req.on('close', () => clearInterval(t));
  } else if (req.url.startsWith('/v1/error')) {
    res.writeHead(429, {'Content-Type': 'application/json'});
    res.end('{"error":{"message":"rate limited by upstream itself"}}');
  } else {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({method: req.method, url: req.url, auth: req.headers.authorization ?? null, body, host: req.headers.host}));
    });
  }
}).listen(19091, '127.0.0.1');
EOF

node upstream.mjs >upstream.log 2>&1 &
for i in $(seq 50); do curl -s -o /dev/null http://127.0.0.1:19091/ && break; sleep 0.1; done
cat upstream.log
# a stale node upstream holding 19091 with a DIFFERENT script answers wrong
# with no error anywhere — detect the bind failure and abort loudly instead
if grep -q 'EADDRINUSE' upstream.log; then
	echo 'FATAL: port 19091 already bound — a stale upstream.mjs is running; kill it first' >&2
	exit 1
fi

# badssl.com: canonical broken-TLS hosts; Go classifies each deterministically.
# revoked/pinning are EXPECTED to pass through 200: Go's TLS stack does no
# revocation or pinning checks, so the proxy streams them like any other site.
cat > llm-reverse-proxy.json <<'EOF'
{
  "listen": "127.0.0.1:18101",
  "providers": {
    "local": "http://127.0.0.1:19091",
    "refused": "http://127.0.0.1:1",
    "nxdomain": "http://no-such-host-llm-reverse-proxy-smoketest.invalid",
    "expired": "https://expired.badssl.com",
    "wronghost": "https://wrong.host.badssl.com",
    "selfsigned": "https://self-signed.badssl.com",
    "untrustedroot": "https://untrusted-root.badssl.com",
    "revoked": "https://revoked.badssl.com",
    "pinning": "https://pinning-test.badssl.com",
    "models.dev": "https://models.dev",
    "catwalk": "https://catwalk.charm.land"
  }
}
EOF

"$OLDPWD/llm-reverse-proxy" -config llm-reverse-proxy.json >proxy.log 2>&1 &
for i in $(seq 50); do curl -s -o /dev/null http://127.0.0.1:18101/ && break; sleep 0.1; done
cat proxy.log
# same staleness guard for the proxy port (otherwise every /local check hits
# whatever old instance holds it and fails with mismatched bodies)
if grep -q 'bind: address already in use' proxy.log; then
	echo 'FATAL: port 18101 already bound — a stale llm-reverse-proxy is running; kill it first' >&2
	exit 1
fi

B=http://127.0.0.1:18101
pass=0; fail=0; skip=0
check() { # check <name> <expected-substr> <actual>
  if [[ "$3" == *"$2"* ]]; then pass=$((pass+1)); echo "ok   $1"
  else fail=$((fail+1)); echo "FAIL $1: expected *$2* got: $3"; fi
}
skipif() { skip=$((skip+1)); echo "skip $1: $2"; }

# network precheck for the badssl section
if ! curl -sk --max-time 5 -o /dev/null https://expired.badssl.com; then
  BADSSL_DOWN=1
fi

# passthrough: method, path join, query, auth header, body
r=$(curl -s -X POST "$B/local/v1/chat/completions?beta=true" -H 'Authorization: Bearer sk-t' -d '{"m":1}')
check passthrough-method '"method":"POST"' "$r"
check passthrough-path '/v1/chat/completions?beta=true' "$r"
check passthrough-auth '"auth":"Bearer sk-t"' "$r"
check passthrough-body '{\"m\":1}' "$r"

# streaming: first chunk must arrive well before the whole body (~500ms total)
t0=$(date +%s%N)
first=$(curl -sN --max-time 2 "$B/local/v1/stream" 2>/dev/null | head -1 || true)
dt=$(( ($(date +%s%N) - t0) / 1000000 ))
check streaming-chunk 'data: chunk 0' "$first"
if [ "$dt" -lt 250 ]; then pass=$((pass+1)); echo "ok   streaming-unbuffered (first chunk after ${dt}ms)"
else fail=$((fail+1)); echo "FAIL streaming-unbuffered: first chunk after ${dt}ms (buffering?)"; fi

# upstream errors pass through untouched
check upstream-4xx-passthrough 'rate limited by upstream itself' "$(curl -s "$B/local/v1/error")"

# RFC 9457 internal errors — transport / DNS
for spec in 'refused tcp-econnrefused' 'nxdomain dns-nxdomain'; do
  set -- $spec
  r=$(curl -s "$B/$1/v1/models")
  check "502-$1" "\"code\":\"$2" "$r"
  check "502-$1-status" '"status":502' "$r"
done

# RFC 9457 internal errors — TLS verification (badssl.com)
if [ "${BADSSL_DOWN:-0}" = 1 ]; then
  skipif tls-badssl 'badssl.com unreachable (no outbound internet)'
else
  check 502-expired      '"code":"tls-cert-expired"'      "$(curl -s "$B/expired/v1/models")"
  check 502-wronghost    '"code":"tls-hostname-mismatch"' "$(curl -s "$B/wronghost/v1/models")"
  check 502-selfsigned   '"code":"tls-unknown-authority"' "$(curl -s "$B/selfsigned/v1/models")"
  check 502-untrustedroot '"code":"tls-unknown-authority"' "$(curl -s "$B/untrustedroot/v1/models")"
  for spec in expired wronghost selfsigned untrustedroot; do
    check "502-$spec-status" '"status":502' "$(curl -s "$B/$spec/v1/models")"
  done
  # no revocation / pinning enforcement: these must stream through as 200
  check passthrough-revoked-200 '200' "$(curl -s -o /dev/null -w '%{http_code}' "$B/revoked/")"
  check passthrough-pinning-200 '200' "$(curl -s -o /dev/null -w '%{http_code}' "$B/pinning/")"
fi

  # models.dev catalog passthrough (public JSON endpoint via the relay route)
  r=$(curl -s --max-time 15 "$B/models.dev/api.json")
  if echo "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert isinstance(d,dict) and len(d)>=100' 2>/dev/null; then
    pass=$((pass+1)); echo "ok   passthrough-models-dev"
  else
    fail=$((fail+1)); echo "FAIL passthrough-models-dev: relay did not return a valid catalog"
  fi

  # catwalk catalog passthrough (public JSON endpoint: /v2/providers is the
  # metadata tier — https://catwalk.charm.land, docs/d028)
  r=$(curl -s --max-time 15 "$B/catwalk/v2/providers")
  if echo "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert isinstance(d,list) and len(d)>=20 and all("models" in p for p in d)' 2>/dev/null; then
    pass=$((pass+1)); echo "ok   passthrough-catwalk"
  else
    fail=$((fail+1)); echo "FAIL passthrough-catwalk: relay did not return a valid provider catalog"
  fi

# EVERY 404 — /, unknown provider prefix, garbage path — must be the exact
# funnel-style plain-text answer (no JSON, no URN, no provider enumeration:
# a distinctive body would be a probe oracle for "custom software lives here")
F404_BODY='404 page not found'
for path in '/' '/nosuch/v1/models' '/wp-login.php' '/.env' '/api/v1/models'; do
  body=$(curl -s "$B$path")
  code=$(curl -s -o /dev/null -w '%{http_code}' "$B$path")
  ct=$(curl -s -o /dev/null -w '%{content_type}' "$B$path")
  if [ "$body" = "$F404_BODY" ] && [ "$code" = "404" ] && [ "$ct" = "text/plain; charset=utf-8" ]; then
    pass=$((pass+1)); echo "ok   404-camouflage $path"
  else
    fail=$((fail+1)); echo "FAIL 404-camouflage $path: got [$body] code=$code"
  fi
done
# and no routing-table leak anywhere in those bodies
leak=$(for path in '/' '/nosuch/v1/models' '/wp-login.php'; do curl -s "$B$path"; done | grep -cE 'openrouter|nvidia|llm-reverse-proxy|urn:' || true)
if [ "$leak" -eq 0 ]; then pass=$((pass+1)); echo "ok   404-no-fingerprint-leak"
else fail=$((fail+1)); echo "FAIL 404-no-fingerprint-leak"; fi

echo
echo "passed=$pass failed=$fail skipped=$skip"
[ "$fail" -eq 0 ]
