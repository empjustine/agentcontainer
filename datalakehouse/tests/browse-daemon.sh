#!/bin/sh
# Browsing endpoint tests: the Promnesia face, the hister face, the slurper
# verb and the rule check, against a real daemon on a throwaway store.
#
# WHY a live server: the contracts under test are HTTP status codes, JSON field
# names and CORS headers - the things the two stock extensions actually read. A
# unit test of the handlers would pass while the wire shape drifted.
[ -n "$BASH_VERSION" ] || exec bash "$0" "$@"
set -e
unit=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
repo=$(dirname "$unit")
tmp=$(mktemp -d)
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
# Fixed-string matching: the patterns under test carry JSON brackets and dots,
# which a BRE would read as syntax.
has() { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1 (missing [$3] in [$2])"; fi; }
hasi() { if printf '%s' "$2" | grep -qiF -- "$3"; then ok "$1"; else bad "$1 (missing [$3] in [$2])"; fi; }
lacks() { if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1 (unexpected [$3])"; else ok "$1"; fi; }
is() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$3], got [$2])"; fi; }

# The canonicaliser is the contract /visited answers against, so it is asserted
# before anything talks HTTP: mobile.twitter and twitter must fold to one key.
cat >"$tmp/cannon_check.py" <<'PY'
import sys

sys.path.insert(0, sys.argv[1])
import cannon

pairs = [
    ("https://mobile.twitter.com/foo/status/1?s=20", "twitter.com/foo/status/1"),
    ("http://www.example.com/a/b/?utm_source=x&id=5", "example.com/a/b/?id=5"),
    ("https://example.com/", "example.com"),
]
print(" ".join("1" if cannon.canonify(a) == b else "0" for a, b in pairs))
PY
if out=$("$repo/py-run.sh" "$tmp/cannon_check.py" "$unit" 2>&1); then
	is 'vendored cannon folds the tracked URL shapes' "$out" '1 1 1'
else
	bad "vendored cannon import ($out)"
fi

port=$((20000 + ($$ % 20000)))
export BROWSE_DB="$tmp/browse.sqlite"
# A POSIX TZ string, not a zoneinfo name: the Promnesia timestamp check must not
# depend on the host shipping tzdata.
export TZ=UTC-2
export BROWSE_HISTER_ADDR="127.0.0.1:$port"
export BROWSE_PROMNESIA_ADDR="127.0.0.1:$((port + 1))"
export BROWSE_TOKEN="secret"
base="http://$BROWSE_HISTER_ADDR"
pm="http://$BROWSE_PROMNESIA_ADDR"

"$repo/py-run.sh" "$unit/browse-daemon.py" >"$tmp/daemon.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true; rm -rf "$tmp"' EXIT

i=0
while [ "$i" -lt 100 ]; do
	if [ "$(grep -c 'listening on' "$tmp/daemon.log" 2>/dev/null)" = 2 ]; then break; fi
	if ! kill -0 $pid 2>/dev/null; then cat "$tmp/daemon.log" >&2; exit 1; fi
	i=$((i + 1))
	sleep 0.1
done
[ "$(grep -c 'listening on' "$tmp/daemon.log")" = 2 ] || { cat "$tmp/daemon.log" >&2; exit 1; }

code() { curl -sS -m 10 -o /dev/null -w '%{http_code}' "$@"; }

# --- the slurper verb -----------------------------------------------------

# The envelope and the record shapes are the producer's (docs/d204 and the
# extension's wire.mjs): one stream per batch, src and kind on every record.
body=$(cat <<'JSON'
{"schema":1,"producer":"agentcontainer-slurp/0.1.0","stream":"visit",
 "stream_seq":{"low":1,"high":3,"acked":0},"checkpoint":{"cursor":"b2"},
 "records":[
  {"src":"firefox-history","kind":"visit","key":"v1","url":"https://www.example.com/post?id=7","visit_time":1712345678901,"title":"A Post","via":"backfill"},
  {"src":"firefox-history","kind":"visit","key":"v2","url":"https://www.example.com/post?id=7#comments","visit_time":1712345679999,"context":"https://www.example.com/post?id=7","title":"Comments","via":"backfill"},
  {"src":"firefox-history","kind":"visit","key":"v3","url":"https://mobile.twitter.com/foo/status/1","visit_time":1712345690000,"title":"A Tweet","via":"live"},
  {"src":"firefox-history","kind":"visit","key":"v4","url":"https://removed.example/gone","visit_time":1712345695000,"title":"Gone","via":"live"}
 ]}
JSON
)
is 'ingest without the key is refused' '401' "$(code -X POST -H 'content-type: application/json' --data-binary "$body" "$base/ingest/slurp")"
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary "$body" "$base/ingest/slurp")
has 'accepted counts the first write' "$out" '"accepted":4'
has 'the ack carries the daemon version' "$out" '"version":'
has 'the checkpoint is echoed' "$out" '"cursor":"b2"'
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary "$body" "$base/ingest/slurp")
has 'a replayed batch is all duplicates' "$out" '"accepted":0'
has 'the duplicate count covers every record' "$out" '"duplicates":4'
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary '{"schema":9,"stream":"visit","records":[]}' "$base/ingest/slurp")
has 'an unknown schema is a 409' "$out" 'unsupported schema'
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary '{"schema":1,"stream":"x","records":[{"src":"s","kind":"nonsense"}]}' "$base/ingest/slurp")
is 'an unknown record kind is a permanent reject' '400' "$(code -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary '{"schema":1,"stream":"x","records":[{"src":"s","kind":"nonsense"}]}' "$base/ingest/slurp")"

# A bookmark batch: the parent guid and index are the facts, a folder has no URL.
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary \
	'{"schema":1,"stream":"bookmark","stream_seq":{"low":1,"high":3},"records":[
	  {"src":"firefox-bookmarks","kind":"bookmark","key":"f1","node_type":"folder","title":"Reading","parent_id":"root________","position":0,"date_added":1712345000000},
	  {"src":"firefox-bookmarks","kind":"bookmark","key":"b1","node_type":"bookmark","url":"https://www.example.com/post?id=7","title":"A Post","parent_id":"f1","position":0,"date_added":1712345600000},
	  {"src":"firefox-bookmarks","kind":"bookmark","key":"b2","node_type":"bookmark","url":"https://bookmark-only.example/saved","title":"Saved Only","parent_id":"root________","position":1,"date_added":1712345600000}]}' \
	"$base/ingest/slurp")
has 'a bookmark batch is accepted' "$out" '"accepted":3'
out=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
	--data-binary '{"urls":["https://bookmark-only.example/saved"]}' "$pm/visited")
has 'a bookmark is not a visit' "$out" '[null]'

# A title fact fills a blank locator without inventing a visit.
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary \
	'{"schema":1,"stream":"title","stream_seq":{"low":1,"high":1},"records":[
	  {"src":"firefox-history","kind":"title","key":"title:p1","url":"https://untitled.example/x","title":"Later Title","seen_at":1712345699000}]}' \
	"$base/ingest/slurp")
has 'a title batch is accepted' "$out" '"accepted":1'

# A page-level removal hides the visit list, and the visited check stays true.
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary \
	'{"schema":1,"stream":"tombstone","stream_seq":{"low":1,"high":2},"records":[
	  {"src":"firefox-bookmarks","kind":"bookmark-removed","key":"f1","node_type":"folder","cascade":true,"deleted_at":1712345700000,"source":"bookmark"},
	  {"src":"firefox-history","kind":"visit-removed","key":"https://removed.example/gone","url":"https://removed.example/gone","deleted_at":1712345700000,"source":"local"}]}' \
	"$base/ingest/slurp")
has 'a tombstone batch is accepted' "$out" '"accepted":2'
out=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
	--data-binary '{"urls":["https://removed.example/gone"]}' "$pm/visited")
has 'a removed page still answers the visited check' "$out" 'Gone'
out=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
	--data-binary '{"url":"https://removed.example/gone"}' "$pm/visits")
has 'a removed page leaves the visit list' "$out" '"visits":[]'

# A move re-sends the same node with a new parent and position. INSERT OR IGNORE
# would keep the first walk's chain forever and the folder view would lie.
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary \
	'{"schema":1,"stream":"bookmark","stream_seq":{"low":1,"high":1},"records":[
	  {"src":"firefox-bookmarks","kind":"bookmark","key":"b2","node_type":"bookmark","url":"https://bookmark-only.example/saved","title":"Saved Only","parent_id":"f2","position":5,"date_added":1712345600000,"date_modified":1712345800000}]}' \
	"$base/ingest/slurp")
has 'a bookmark move is accepted' "$out" '"accepted":1'
moved=$(python3 - "$tmp/browse.sqlite" <<'PYINNER'
import sqlite3
import sys

conn = sqlite3.connect(sys.argv[1], timeout=10)
row = conn.execute(
    "SELECT parent_id, position, date_added FROM bookmark WHERE src = ? AND key = ?",
    ("firefox-bookmarks", "b2"),
).fetchone()
print("|".join(str(value) for value in row))
PYINNER
)
is 'a bookmark move updates the parent and position' 'f2|5|1712345600000' "$moved"
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary \
	'{"schema":1,"stream":"bookmark","stream_seq":{"low":1,"high":1},"records":[
	  {"src":"firefox-bookmarks","kind":"bookmark","key":"b2","node_type":"bookmark","url":"https://bookmark-only.example/saved","title":"Saved Only","parent_id":"f2","position":5,"date_added":1712345600000,"date_modified":1712345800000}]}' \
	"$base/ingest/slurp")
has 'a replayed bookmark move is a duplicate' "$out" '"accepted":0'


# --- the Promnesia face ----------------------------------------------------

out=$(curl -sS -m 10 "$pm/status")
has 'status reports the store' "$out" '"total_visits":4'
has 'status counts the marks' "$out" '"tombstones":3'
has 'status names the db path' "$out" 'browse.sqlite'

out=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
	--data-binary '{"urls":["https://mobile.twitter.com/foo/status/1","https://never.example/"],"client_version":"0.12.0"}' \
	"$pm/visited")
has 'visited answers the canonical form' "$out" '"normalised_url":"twitter.com/foo/status/1"'
has 'visited keeps a null for an unseen url' "$out" 'null'
has 'visited reports the IXDTF timestamp shape' "$out" 'T21:34:50+02:00"'

out=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
	--data-binary '{"url":"https://www.example.com/post?id=7"}' "$pm/visits")
has 'visits returns the exact visit' "$out" 'A Post'
has 'visits returns the child URL that carries context' "$out" 'Comments'
has 'visits normalises the envelope' "$out" '"normalised_url":"example.com/post?id=7"'

out=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
	--data-binary '{"url":"A Post"}' "$pm/search")
has 'the Promnesia search path matches on text' "$out" 'A Post'
is 'the Promnesia port answers a hister-shaped search too' '200' \
	"$(code -X POST -H 'content-type: application/json' --data-binary '{"text":"A Post"}' "$pm/search")"

out=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
	--data-binary '{"timestamp":1712345690}' "$pm/search_around")
has 'search_around finds the visit in its window' "$out" 'A Tweet'
has 'search_around mirrors the upstream placeholder url' "$out" '"normalised_url":"http://dummy.org"'

# --- the hister face -------------------------------------------------------

is 'profile answers the single-user status' '200' "$(code "$base/api/profile")"
lacks 'profile carries no synthetic user id' "$(curl -sS -m 10 "$base/api/profile")" 'user_id'
out=$(curl -sS -m 10 "$base/api/config")
has 'config reports semantic search disabled' "$out" '"semanticEnabled":false'
has 'config reports token auth when a key is set' "$out" '"authMode":"token"'

is 'add answers 201' '201' "$(code -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' \
	--data-binary '{"url":"https://news.example/story","title":"Story","text":"body text"}' "$base/api/add")"
is 'add without the key is refused' '401' \
	"$(code -X POST -H 'content-type: application/json' --data-binary '{"url":"https://x.example/"}' "$base/api/add")"
is 'add with the key answers 201' '201' \
	"$(code -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary '{"url":"https://news.example/story"}' "$base/api/add")"
is 'HEAD reports an indexed url' '200' "$(code -I "$base/api/document?url=https://news.example/story")"
is 'HEAD reports an unknown url as 404' '404' "$(code -I "$base/api/document?url=https://news.example/other")"
out=$(curl -sS -m 10 "$base/api/document?url=https://news.example/story")
has 'the document carries its text' "$out" 'body text'
has 'a metadata-only re-add keeps the stored text' "$(curl -sS -m 10 "$base/api/document?url=https://news.example/story")" 'body text'
has 'the document carries its title' "$out" 'Story'

# The cold-shaped postings: one term, a field filter, a domain filter, a phrase
# and the match-all form. query quality is deliberately naive; the contract is
# that every query shape the delete action and a web client use answers.
out=$(curl -sS -m 10 --get --data-urlencode 'q=body' "$base/search")
has 'search finds a captured term' "$out" 'https://news.example/story'
out=$(curl -sS -m 10 --get --data-urlencode 'q=title:Story' "$base/search")
has 'search reads the title field' "$out" 'https://news.example/story'
out=$(curl -sS -m 10 --get --data-urlencode 'q=domain:news.example' "$base/search")
has 'search filters by domain' "$out" 'https://news.example/story'
out=$(curl -sS -m 10 --get --data-urlencode 'q="body text"' "$base/search")
has 'search filters a quoted phrase' "$out" 'https://news.example/story'
out=$(curl -sS -m 10 --get --data-urlencode 'q=bo*' "$base/search")
has 'search expands a term prefix' "$out" 'https://news.example/story'
out=$(curl -sS -m 10 --get --data-urlencode 'q=body+surelynotpresent' "$base/search")
has 'search requires every term' "$out" '"total":0'
out=$(curl -sS -m 10 --get --data-urlencode 'q=*' "$base/search")
has 'search answers match-all' "$out" '"total":1'
is 'search accepts the hister POST body' '200' \
	"$(code -X POST -H 'content-type: application/json' --data-binary '{"text":"body"}' "$base/search")"

curl -sS -m 10 -o /dev/null -X POST -H 'X-Access-Token: secret' \
	--data-binary 'skip=news.example' "$base/api/rules"
out=$(curl -sS -m 10 "$base/api/rules")
has 'rules round-trip the skip list' "$out" '"skip":["news.example"]'
is 'a skipped url is refused with 406' '406' \
	"$(code -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary '{"url":"https://news.example/blocked"}' "$base/api/add")"
is 'a bad pattern is a 400' '400' \
	"$(code -X POST -H 'X-Access-Token: secret' --data-binary 'skip=(unclosed' "$base/api/rules")"

out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' \
	--data-binary '{"url":"https://news.example/story","label":"read-later"}' "$base/api/label")
has 'label answers ok' "$out" '"ok":true'
out=$(curl -sS -m 10 "$base/api/document?url=https://news.example/story")
has 'label is stored on the document' "$out" '"label":"read-later"'
is 'label of an unknown document is a 404' '404' \
	"$(code -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary '{"url":"https://nope.example/","label":"x"}' "$base/api/label")"

out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' \
	--data-binary '{"query":"domain:news.example","dry_run":true}' "$base/api/delete")
has 'a dry-run domain delete reports the match' "$out" '"matched":1'
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' \
	--data-binary '{"query":"url:\"https://news.example/story\"","dry_run":true}' "$base/api/delete")
has 'a dry-run url delete reports the match' "$out" '"matched":1'
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' \
	--data-binary '{"query":"url:\"https://news.example/story\""}' "$base/api/delete")
has 'a delete removes the document' "$out" '"deleted":1'
is 'the deleted document is gone from the probe' '404' "$(code -I "$base/api/document?url=https://news.example/story")"
out=$(curl -sS -m 10 --get --data-urlencode 'q=body' "$base/search")
has 'a deleted document leaves the index' "$out" '"total":0'
pdf64='JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0MCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDIwIDEwMCBUZCAoSGVsbG8gUERGKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMzMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQwMQolJUVPRgo='
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' \
	--data-binary '{"document":{"url":"https://files.example/doc.pdf","title":"Doc"}}' "$base/api/add_pdf")
has 'add_pdf requires a pdf field' "$out" 'missing pdf'
is 'add_pdf answers 201' '201' "$(code -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' \
	--data-binary "{\"document\":{\"url\":\"https://files.example/doc.pdf\",\"title\":\"Doc\"},\"pdf\":\"$pdf64\"}" "$base/api/add_pdf")"
out=$(curl -sS -m 10 "$base/api/document?url=https://files.example/doc.pdf")
has 'the PDF text is extracted and stored' "$out" 'Hello PDF'
out=$(curl -sS -m 10 --get --data-urlencode 'q=Hello' "$base/search")
has 'the PDF text is searchable' "$out" 'https://files.example/doc.pdf'
is 'a malformed PDF is a 500' '500' "$(code -X POST -H 'X-Access-Token: secret' \
	-H 'content-type: application/json' --data-binary \
	'{"document":{"url":"https://files.example/bad.pdf"},"pdf":"bm90IGEgcGRm"}' \
	"$base/api/add_pdf")"
is 'the daemon survives a bad PDF' '200' "$(code "$pm/status")"
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' \
	--data-binary '{"query":"https://files.example/doc.pdf","dry_run":true}' "$base/api/delete")
has 'a bare URL delete is still an exact url filter' "$out" '"matched":1'

# Invalid values are RFC 9457 problem documents, not the old {"error": ...}.
headers=$(curl -sS -m 10 -D - -o /dev/null -X POST -H 'X-Access-Token: secret' \
	-H 'content-type: application/json' --data-binary '{}' "$base/api/add")
hasi 'a client error is application/problem+json' "$headers" 'content-type: application/problem+json'
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' \
	--data-binary '{}' "$base/api/add")
has 'a client error names the interface-error type' "$out" '"type":"https://agentcontainer.example/problems/interface-error"'
has 'a client error carries a title and status' "$out" '"title":"Interface error"'

out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' \
	--data-binary '{"url":"https://news.example/story","title":"Story","query":"q"}' "$base/api/history")
is 'history accepts a click row' "$out" ''

out=$(curl -sS -m 10 "$base/api/versions?url=https://a.example/")
has 'versions answers the deferral' "$out" 'not built'

# --- the extension's half of the same contract --------------------------

# The two halves are developed in one folder, so the check that has to exist is
# theirs: the extension builds records and posts them with its own wire module,
# and this asserts the daemon's answer and its read faces agree.
out=$(cd "$repo" && ./node-run.sh datalakehouse/tests/slurp-contract.mjs "$base" "$pm" secret 2>&1)
has 'the extension half and the daemon agree end to end' "$out" 'slurp contract ok'

# --- the wire details the extensions depend on -----------------------------

headers=$(curl -sS -m 10 -D - -o /dev/null -X OPTIONS -H 'Origin: moz-extension://abc' \
	-H 'Access-Control-Request-Headers: content-type, x-access-token' \
	"$base/api/add")
has 'preflight allows the extension origin' "$headers" 'Access-Control-Allow-Origin: moz-extension://abc'
has 'preflight echoes the requested headers' "$headers" 'x-access-token'
is 'preflight answers 204' '204' "$(code -X OPTIONS -H 'Origin: moz-extension://abc' "$base/api/add")"
# Each listener answers its own protocol only: a hister path on the Promnesia
# port is a misconfigured client, not a route.
is 'the Promnesia port refuses a hister path' '404' "$(code "$pm/api/config")"
is 'the hister port refuses a Promnesia path' '404' "$(code "$base/status")"

lacks 'a web origin gets no CORS grant' "$(curl -sS -m 10 -D - -o /dev/null -H 'Origin: https://evil.example' "$base/api/config")" 'Access-Control-Allow-Origin'

# The visit table is append-only: a later title fills the derived page_title
# and the read faces, but the stored visit row keeps its original locator.
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary \
	'{"schema":1,"stream":"visit","stream_seq":{"low":1,"high":1},"records":[
	  {"src":"firefox-history","kind":"visit","key":"append-v1","url":"https://append.example/page","visit_time":1712345698000}]}' \
	"$base/ingest/slurp")
has 'an untitled visit is accepted' "$out" '"accepted":1'
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary \
	'{"schema":1,"stream":"title","stream_seq":{"low":1,"high":1},"records":[
	  {"src":"firefox-history","kind":"title","key":"title:append","url":"https://append.example/page","title":"Late Title","seen_at":1712345699000}]}' \
	"$base/ingest/slurp")
has 'a late title is accepted' "$out" '"accepted":1'
append_state=$(python3 - "$tmp/browse.sqlite" <<'PYDB'
import sqlite3
import sys

conn = sqlite3.connect(sys.argv[1], timeout=10)
visit = conn.execute(
    "SELECT locator_title FROM visit WHERE norm_url = ?", ("append.example/page",)
).fetchone()
page = conn.execute(
    "SELECT title FROM page_title WHERE norm_url = ?", ("append.example/page",)
).fetchone()
print(f"{visit[0]!r}|{page[0]!r}")
PYDB
)
is 'a late title leaves the visit row untouched' "None|'Late Title'" "$append_state"
out=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
	--data-binary '{"url":"https://append.example/page"}' "$pm/visits")
has 'the visit read face derives the late title' "$out" 'Late Title'

# A bookmark title is context too: it fills the derived page title, not the
# append-only visit row.
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary \
	'{"schema":1,"stream":"visit","stream_seq":{"low":1,"high":1},"records":[
	  {"src":"firefox-history","kind":"visit","key":"append-v2","url":"https://append2.example/page","visit_time":1712345698500}]}' \
	"$base/ingest/slurp")
has 'a second untitled visit is accepted' "$out" '"accepted":1'
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary \
	'{"schema":1,"stream":"bookmark","stream_seq":{"low":1,"high":1},"records":[
	  {"src":"firefox-bookmarks","kind":"bookmark","key":"append-b1","node_type":"bookmark","url":"https://append2.example/page","title":"Bookmark Title","parent_id":"root________","position":9,"date_added":1712345600000}]}' \
	"$base/ingest/slurp")
has 'a bookmark for an untitled page is accepted' "$out" '"accepted":1'
append_state=$(python3 - "$tmp/browse.sqlite" <<'PYDB'
import sqlite3
import sys

conn = sqlite3.connect(sys.argv[1], timeout=10)
visit = conn.execute(
    "SELECT locator_title FROM visit WHERE norm_url = ?", ("append2.example/page",)
).fetchone()
print(repr(visit[0]))
PYDB
)
is 'a bookmark title leaves the visit row untouched' 'None' "$append_state"
out=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
	--data-binary '{"url":"https://append2.example/page"}' "$pm/visits")
has 'the visit read face derives the bookmark title' "$out" 'Bookmark Title'

# A history clear is a timestamped global mark: it hides every visit up to the
# mark on the read faces, while the presence row and its rows stay (docs/d204's
# mark-not-erase rule). A second clear must move the mark forward.
out=$(curl -sS -m 10 -X POST -H 'X-Access-Token: secret' -H 'content-type: application/json' --data-binary \
	'{"schema":1,"stream":"history","stream_seq":{"low":1,"high":1},"records":[
	  {"src":"firefox-history","kind":"history-cleared","key":"*","deleted_at":1712346000000,"source":"local"}]}' \
	"$base/ingest/slurp")
has 'a history clear is accepted' "$out" '"accepted":1'
out=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
	--data-binary '{"url":"https://www.example.com/post?id=7"}' "$pm/visits")
has 'a history clear hides the visit list' "$out" '"visits":[]'
out=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
	--data-binary '{"urls":["https://www.example.com/post?id=7"]}' "$pm/visited")
has 'a history clear keeps the visited archive mark' "$out" 'A Post'

# A body over the ceiling is refused before it is read into memory. The
# limit is deliberately generous, so the fixture is just over the default.
head -c 9000000 /dev/zero | tr '\0' ' ' >"$tmp/big.json"
is 'an oversized body is a 413' '413' "$(code --max-time 20 -X POST -H 'X-Access-Token: secret' \
	-H 'content-type: application/json' --data-binary @"$tmp/big.json" "$base/ingest/slurp")"

# A wide bind with no key would expose the write faces to the network; the
# daemon must refuse to start rather than accept the first request.
if BROWSE_TOKEN='' BROWSE_HISTER_ADDR="0.0.0.0:$((port + 2))" \
	BROWSE_PROMNESIA_ADDR="127.0.0.1:$((port + 3))" \
	"$repo/py-run.sh" "$unit/browse-daemon.py" >/dev/null 2>&1; then
	bad 'a wide bind without a key must be refused'
else
	ok 'a wide bind without a key is refused'
fi

if [ "$fails" -gt 0 ]; then
	printf '%s browse-daemon test(s) FAILED\n' "$fails" >&2
	printf '%s\n' '--- daemon log ---' >&2
	cat "$tmp/daemon.log" >&2
	exit 1
fi
printf 'all browse-daemon tests passed\n'
