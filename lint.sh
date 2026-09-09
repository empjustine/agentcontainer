#!/bin/sh
# Lint all shell scripts (excluding OLD/). Tools are provisioned ad hoc via
# mise — no pinned dev deps needed.
# Runs shellcheck(1) as the gating linter.
# shfmt(1) -l is advisory only (exit status tolerated): it lists files whose
# formatting differs from canonical shfmt style. Adopting that style would
# collapse the deliberate column alignment in the run scripts, so format drift
# is reported, not enforced. Syntax errors are covered by shellcheck anyway.
# Usage: ./lint.sh [path]   (default: repo root)

set -eu

# shellcheck disable=SC1091
. "$(dirname "$0")/lib/log.sh"
LOG_TOOL='lint'
export LOG_TOOL

root="${1:-$(CDPATH='' cd "$(dirname "$0")" && pwd)}"
cd "$root"

log_info "shellcheck"
# -x: follow `source` directives (the generate.sh scripts point at
# lib/workload-runtime.sh for _termux/node_run/default_run_dir).
mise exec shellcheck@latest -- find . -path ./OLD -prune -o -type f -name '*.sh' -exec shellcheck -x {} +

# jq compile gate for the workload description filters (lib/workload-*.jq).
#
# jq resolves --arg/--argjson names at COMPILE time, so this catches a typo'd
# filter variable as well as a syntax error.  The catch: a filter that uses
# \$doc cannot be compiled with nothing bound — it would fail "\$doc is not
# defined" — so every variable the filters declare is bound to a dummy value
# below.  A legitimate name then resolves, and only a typo stands out.  Adding
# a new --arg to a filter means adding it here, or this gate fails loudly.
#
# Exit 3 is the compile-error code, tested specifically: a valid filter that
# merely fails when run against -n's null input exits 5, which is not a
# compile error.  Semantic mistakes are check-workload.sh's job, not this gate's.
log_info "jq compile (gating — lib/workload-*.jq)"
# shellcheck disable=SC2016  # $f is expanded by the inner sh, not by this one
mise exec jq@latest -- sh -c '
set -- --argjson doc "{}" \
	--arg field f --arg mode m --arg host h --arg guest g \
	--arg tool podman --arg image i --arg name n --arg network net \
	--arg entrypoint e --arg workdir w --arg init 1 --arg user 1 \
	--arg uid 0 --arg gid 0 --arg userns u --arg keepgroups k --arg harden 1 \
	--args -- dummy
for f in lib/workload-*.jq; do
	[ -f "$f" ] || continue
	jq -n --from-file "$f" "$@" >/dev/null 2>&1
	if [ $? -eq 3 ]; then
		echo "jq compile error: $f" >&2
		jq -n --from-file "$f" "$@" >&2
		exit 1
	fi
done'

log_info "shfmt (advisory)"
mise exec shfmt@latest -- find . -path ./OLD -prune -o -type f -name '*.sh' -exec shfmt -l {} + || true
