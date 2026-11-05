#!/bin/sh
# freshness.sh — is every committed data cache still what its upstream serves?
#
# WHAT IT IS: the third repo-wide sweep, and the only one allowed to touch the
# network. ./lint.sh and ./test.sh stay offline by contract, which is exactly
# why staleness kept landing: a regenerated data file looks perfect in an
# offline gate (it parses, its tests pass, its shape is right) and only review
# could notice it had drifted from upstream (docs/d122). Freshness is a claim
# about the outside world, so it needs its own gate, run when the network is
# there, never as a review catch.
#
# The contract is per-unit and comes from the unit itself — this script knows
# no payload formats, only "ask the generator":
#
#   <unit>/package.json "generate" + `--check`
#       The generator re-reads its upstream listing and exits nonzero when the
#       committed artifacts no longer match it. Every pi-* unit that has a
#       generator carries this flag.
#   llm-local-inference: `fetch_hf_manifests.py --offline`
#       The HF manifests are refreshed from the Hub, but their *audit* is
#       offline: every configured `--model` must still resolve inside the
#       cached manifest tree. That catches the failure a refresh hides — a
#       hand-edited entry that no longer names a real file — without a
#       network call. Needs `uv`; skipped when it is absent.
#
# Units deliberately NOT here:
#   coding-agent — no `--check`, and it could not have an honest one: its
#       generator falls back per source when upstream is unreachable (the
#       tailnet API, a key-gated listing, the opencode docs mirror), so
#       byte-equality against the committed snapshot is a property of the
#       host, not of the data. Its offline guarantees live in
#       ./check-types.sh and coding-agent/tests/ instead.
#   estige, git, and the remaining pi-* units — no upstream cache to compare.
#
# A listing that needs a secret we do not hold is SKIPPED, not failed: a dev
# box without the vault is a normal state, and the skip names the unit and its
# variable. Run through the env chain to include those units:
#
#   ./freshness.sh                  # public listings only
#   ./environment.sh ./freshness.sh # everything, with the vault keys
#
# Usage: ./freshness.sh [--quiet]   (from any directory)

set -eu

# shellcheck source-path=SCRIPTDIR source=log.sh
. "$(dirname "$0")/log.sh"
LOG_TOOL='freshness'
export LOG_TOOL

root="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
cd "$root"

quiet=0
case "${1:-}" in
--quiet) quiet=1 ;;
--help | -h)
	sed -n '2,/^Usage:/p' "$0" | sed 's/^# \{0,1\}//'
	exit 0
	;;
"") ;;
*)
	log_die 2 "unknown argument: $1" hint="usage: ./freshness.sh [--quiet]"
	;;
esac

# The one place a unit's secret requirement is written down: the generators
# read `$<VAR>` inside the artifacts they emit (that is how pi forwards the key
# to pi at run time), so nothing in the unit can report "I am skippable" before
# it is asked. An unlisted unit is assumed to need nothing — the honest default,
# since a public listing is the common case and a missing secret there surfaces
# as an unmistakable 401 rather than as silence.
requires_secret() {
	case $1 in
	pi-verboo) echo VERBOO_API_KEY ;;
	*) echo '' ;;
	esac
}

failed=0
skipped=0
checked=0

log_info "pi extension data (generate --check)"
for dir in ./*/; do
	unit=${dir%/}
	unit=${unit#./}
	[ -f "$unit/package.json" ] || continue
	case $unit in pi-*) ;; *) continue ;; esac
	grep -q '"generate"' "$unit/package.json" || continue

	secret=$(requires_secret "$unit")
	if [ -n "$secret" ] && [ -z "$(printenv "$secret" || true)" ]; then
		log_warn "skipped — no credential for its listing" \
			unit="$unit" env="$secret" hint="./environment.sh ./freshness.sh"
		skipped=$((skipped + 1))
		continue
	fi

	[ "$quiet" = 1 ] || log_info "check" unit="$unit"
	if "$root/npm-run.sh" "$unit" generate --check; then
		checked=$((checked + 1))
	else
		log_error "stale — the committed artifacts are not what upstream serves" unit="$unit"
		failed=$((failed + 1))
	fi
done

# The HF audit is offline, so its absence is a *tool* absence, not a network
# one: skipping silently would hide a permanently unrun check behind an
# environment that never had uv, which is the drift this script exists to stop.
if command -v uv >/dev/null 2>&1; then
	[ "$quiet" = 1 ] || log_info "check" unit="llm-local-inference"
	if (cd llm-local-inference && uv run --quiet fetch_hf_manifests.py --offline >/dev/null); then
		checked=$((checked + 1))
	else
		log_error "stale — a configured model no longer resolves in the cached manifest" \
			unit="llm-local-inference" hint="re-run: cd llm-local-inference && uv run fetch_hf_manifests.py"
		failed=$((failed + 1))
	fi
else
	log_warn "skipped — uv is not installed, so the HF manifest audit did not run" \
		unit="llm-local-inference"
	skipped=$((skipped + 1))
fi

if [ "$failed" -gt 0 ]; then
	log_error "freshness gate failed" checked="$checked" stale="$failed" skipped="$skipped"
	exit 1
fi
log_info "freshness gate passed" checked="$checked" skipped="$skipped"
