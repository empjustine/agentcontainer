#!/bin/sh
# Lint all shell scripts. Tools are provisioned ad hoc via
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
# -x: follow `source` directives (the generate.sh shims point at
# lib/node-run.sh for node_run; run scripts point at lib/workload-runtime.sh).
mise exec shellcheck@latest -- find . -type f -name '*.sh' -exec shellcheck -x {} +

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
	--arg tool podman --arg image i --arg name n --arg network net --arg restart r \
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
mise exec shfmt@latest -- find . -type f -name '*.sh' -exec shfmt -l {} + || true

# biome — the JS/TS lint gate. RULES ONLY on purpose (plain `biome lint`, not
# `check`): the formatter and the import organizer stay host-side manual
# until the markdown-formatting policy is decided (biome 2.6+ formats
# markdown, this tree never has), so this stage never fights that open
# decision. The pin is AGED, not @latest, matching every other gate pin:
# 2.5.3 is months old where 2.6.x is days old, and a lint pin that moves
# between runs is a gate whose meaning moves with it. The rule set itself
# is the explicit list in biome.jsonc — new upstream rules do not
# auto-arrive. --error-on-warnings keeps soft findings from accumulating
# back to a baseline nobody reviews.
log_info "biome lint (gating — rule set in biome.jsonc; pinned 2.5.3)"
mise exec biome@2.5.3 -- biome lint . --error-on-warnings

# knip — the dead-code gate (unused files, unused exports). This is the
# mechanical teeth for the fold discipline (docs/d039/d072): an export no
# consumer imports is a finding, not a style opinion. The one hand-maintained
# input is the entry list in knip.jsonc — this repo has no bin/main field, so
# "which files the shims and the pi host actually execute" is operator
# knowledge a graph walk cannot derive (the WHY for every entry is in that
# file). The tool is pinned to an AGED release on purpose, not @latest: the
# pin is the cooldown (a deliberate human decision, matching the toolchain's
# minimum_release_age posture), and a moving target would change what the
# gate means between runs. mise's embedded aube installer runs no dependency
# lifecycle scripts, so the check itself carries no npm-style install-time
# code execution.
log_info "knip (gating — unused files/exports; entry contract in knip.jsonc)"
mise exec npm:knip@6.41.0 -- knip

# Capability-bearing URL gate (docs/d086): a funnel mount path in a tracked
# file is the mode A credential written down — it leaks the only credential
# mode A has and churns whenever the mount rotates. Any writer, any shape:
# the leak is textual, so a plain pattern is the whole detector. Fixtures
# use the canonical synthetic mount (all-zero UUID); anything else fails.
log_info "capability URL gate (gating — tracked files)"
if git grep -nE '[.]ts[.]net/[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}' -- . \
	| grep -vF '00000000-0000-4000-8000-000000000000'; then
	echo "capability-bearing funnel URL in tracked files (docs/d086) — see lines above" >&2
	exit 1
fi
