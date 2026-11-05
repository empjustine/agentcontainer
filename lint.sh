#!/bin/sh
# lint.sh — the repo-wide lint gate (docs/d113: the maintainer's view ACROSS
# units; no unit imports it).
#
# The gate surface, in the order it runs — every leg gates except shfmt:
#   shell sources · jq workload-filter compile · shfmt (advisory) · oxfmt
#   markdown · biome · oxlint (type-aware) · knip · ruff · uv sync --frozen ·
#   ty · the capability-URL, runner-copy and retired-root-lib text gates ·
#   spec-graph contract · golangci-lint.
#
# Toolchain split (docs/d139): the npm packages are locked by package-lock.json
# and installed by ./npm-tools.sh (docs/d107); every other tool is pinned in
# ./dev-tools.sh, which acquires it through mise on a dev host and hands back
# the host's own binary on Termux/mise-less hosts. Both helpers are the single
# install path, so this file names a tool but never a way to obtain it.
#
# Runs shellcheck(1) as the gating linter.
# shfmt(1) -l is advisory only (exit status tolerated): it lists files whose
# formatting differs from canonical shfmt style. Adopting that style would
# collapse the deliberate column alignment in the run scripts, so format drift
# is reported, not enforced. Syntax errors are covered by shellcheck anyway.
# Usage: ./lint.sh [path]   (default: repo root)

set -eu

# shellcheck source-path=SCRIPTDIR source=log.sh
. "$(dirname "$0")/log.sh"
# shellcheck source-path=SCRIPTDIR source=npm-tools.sh
. "$(dirname "$0")/npm-tools.sh"
# shellcheck source-path=SCRIPTDIR source=dev-tools.sh
. "$(dirname "$0")/dev-tools.sh"
LOG_TOOL='lint'
export LOG_TOOL

repo_root=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root="${1:-$repo_root}"
cd "$root"

# Every non-npm tool below is provided by dev-tools.sh (docs/d139): one pin
# table, one acquisition path — mise on a dev host, the host's own binary on
# Termux/mise-less hosts. The JS gates deliberately do NOT go through it: their
# versions are locked by package-lock.json (docs/d107).

log_info "shellcheck"
# -x: follow `source` directives (the run scripts point at their
# own folder's lib copies; the shell run scripts point
# at their lib/workload-runtime.sh — coding-agent's launcher is a node module,
# docs/d119).
# node_modules is pruned: npm's dependency tree may carry vendor *.sh files,
# and this gate owns only this repo's sources.
# .venv is pruned alongside node_modules: the gate environment ships its
# own .sh files (tqdm's completion.sh) that are third-party, not ours.
dev_tool_run shellcheck find . -path ./node_modules -prune -o \
	-path ./.venv -prune -o \
	-type f -name '*.sh' -exec shellcheck -x {} +

# jq compile gate for the workload description filters. One copy is left:
# llm-local-inference/ — there is no repo-level lib/ (docs/d113), coding-agent
# ported its runtime to node (docs/d119) and estige became a package (docs/d120).
# The glob stays `*/lib/workload-*.jq` so a future shell copy is gated the day it
# lands rather than the day someone remembers this line.
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
# compile error.  Semantic mistakes are
# coding-agent/tests/check-workload.test.mjs's job, not this gate's.
log_info "jq compile (gating — */lib/workload-*.jq)"
# shellcheck disable=SC2016  # $f is expanded by the inner sh, not by this one
dev_tool_run jq sh -c '
set -- --argjson doc "{}" \
	--arg field f --arg mode m --arg host h --arg guest g \
	--arg tool podman --arg image i --arg name n --arg network net --arg restart r \
	--arg entrypoint e --arg workdir w --arg init 1 --arg user 1 \
	--arg uid 0 --arg gid 0 --arg userns u --arg keepgroups k --arg harden 1 \
	--args -- dummy
for f in */lib/workload-*.jq; do
	[ -f "$f" ] || continue
	jq -n --from-file "$f" "$@" >/dev/null 2>&1
	if [ $? -eq 3 ]; then
		echo "jq compile error: $f" >&2
		jq -n --from-file "$f" "$@" >&2
		exit 1
	fi
done'

log_info "shfmt (advisory)"
dev_tool_run shfmt find . -path ./node_modules -prune -o \
	-path ./.venv -prune -o \
	-type f -name '*.sh' -exec shfmt -l {} + || true

# oxfmt (gating, markdown only): the ox toolchain's prose formatter — the one
# that can reflow a table a JS linter cannot see. Gating, and it started that
# way only after a one-shot reformat of the whole tree (docs/docs included): an
# advisory that is permanently non-empty is not a signal, it is wallpaper, and
# it was covering 1000+ files nobody could act on. Now a non-empty list means
# somebody wrote markdown oxfmt disagrees with, which is a one-command fix.
# The glob excludes non-md output — code-format policy belongs to biome, whose
# lint line below is deliberately lint-only. The glob is quoted so bash hands
# oxfmt the pattern itself (its own glob walker), not a shell expansion.
#
# PINNED, not @latest (d137's rule for a gate whose output IS its meaning): a
# formatter default change upstream would otherwise turn the sweep red across
# the tree without a single edit here. The pin lives in dev-tools.sh's one
# table (docs/d139; the repo commits no mise.toml — docs/d051/d082); Termux has
# no mise and takes the host package's oxfmt, so a bump there re-runs the
# one-shot reformat.
OXFMT_GLOB='**/*.md'
log_info "oxfmt markdown (gating — canonical markdown, pinned)"
dev_tool_run oxfmt oxfmt --check "$OXFMT_GLOB" ||
	log_die 96 "markdown is not oxfmt-canonical" \
		hint="fix: oxfmt --write '**/*.md' (pinned: mise exec oxfmt@0.75.0 -- oxfmt --write '**/*.md')"

npm_tools_ensure "$repo_root"
[ -x "$repo_root/node_modules/.bin/biome" ] ||
	log_die 96 "biome missing from the npm dev toolchain" path="$repo_root/node_modules"
[ -x "$repo_root/node_modules/.bin/knip" ] ||
	log_die 96 "knip missing from the npm dev toolchain" path="$repo_root/node_modules"

# biome — the JS/TS lint gate. RULES ONLY on purpose (plain `biome lint`, not
# `check`): the formatter and the import organizer stay host-side manual
# until the markdown-formatting policy is decided (the pinned 2.6.3 can
# format markdown; this tree never has), so this stage never fights that
# open decision. The pin is AGED, not @latest, matching every other gate
# pin: a deliberate cooldown, because a lint pin that moves between runs
# is a gate whose meaning moves with it. The rule set itself
# is the explicit list in biome.jsonc — new upstream rules do not
# auto-arrive. --error-on-warnings keeps soft findings from accumulating
# back to a baseline nobody reviews.
log_info "biome lint (gating — rule set in biome.jsonc; pinned by package-lock.json)"
"$repo_root/node_modules/.bin/biome" lint . --error-on-warnings

# oxlint (gating): the type-aware JS/TS lint half biome structurally cannot
# be — biome 2.6.x has no type-inference option anywhere in its schema
# (schema-verified), so no-floating-promises / no-base-to-string /
# require-array-sort-compare live here, powered by oxlint-tsgolint.
# npm-pinned pair under node_modules/.bin so linter and type provider move
# in one lockstep (the biome posture). Config = .oxlintrc.json: typeAware
# on; the tests override turns off no-floating-promises for **/tests/**
# because node:test treats every handler as fire-and-forget by design, not
# a bug to flag 219 times.
log_info "oxlint (gating — type-aware JS/TS lint)"
( cd "$repo_root" && "$repo_root/node_modules/.bin/oxlint" . -D warning )

# knip — the dead-code gate (unused files, unused exports). This is the
# mechanical teeth for the fold discipline (docs/d039/d072): an export no
# consumer imports is a finding, not a style opinion. The one hand-maintained
# input is the entry list in knip.jsonc — this repo has no bin/main field, so
# "which files the shims and the pi host actually execute" is operator
# knowledge a graph walk cannot derive (the WHY for every entry is in that
# file). The tool is pinned to an AGED release on purpose, not @latest: the
# pin is the cooldown (a deliberate human decision, matching the toolchain's
# minimum_release_age posture), and a moving target would change what the
# gate means between runs. `npm ci --ignore-scripts` runs no package
# lifecycle code, so the check itself carries no install-time code execution.
log_info "knip (gating — unused files/exports; entry contract in knip.jsonc)"
( cd "$repo_root" && "$repo_root/node_modules/.bin/knip" )

# ruff (gating): the python lint gate. No [tool.ruff] select exists on
# purpose — the gate runs ruff 0.17's default surface (407 enabled codes,
# measured green 2026-11-06); target-version derives from pyproject's
# requires-python. A hand-written family list would either drift from that
# default or silently drop rules the default keeps.
log_info "ruff (gating — python lint)"
dev_tool_run ruff ruff check .

# uv sync --frozen: ty's prerequisite and the python gate's npm-ci —
# installs the tracked uv.lock into .venv exactly; --frozen fails on a
# stale lock instead of silently re-resolving it.
log_info "uv sync --frozen (ty's environment)"
dev_tool_run uv uv sync --frozen

# ty (gating): python type checking — tsc's counterpart. The flags carry
# what ty 0.0.95 parses but won't apply from [tool.ty.environment]
# (pyproject's NOTE); the search-path pair is the per-unit lib/ layout
# (docs/d113) that makes bare import log / import _hf_cache resolve the
# way the scripts are written to run.
log_info "ty (gating — python types)"
dev_tool_run ty ty check . --python .venv --extra-search-path llm-local-inference/lib --extra-search-path llm-local-inference

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

# Retired-root-lib gate (docs/d113): after the fold every unit owns its own
# `lib/`, so a reference that climbs out of the unit to reach one points at a
# folder that no longer exists. Nothing notices at lint time and nothing runs
# python in the sweep, which is how six llm-local-inference tools kept
# resolving `<repo-root>/lib` long after it was gone: `import log` only failed
# once an operator ran the script. Textual, like the gate above, because the
# break is a path, not a type. `*/tests/` is excluded on purpose — a test in
# `<unit>/tests/` climbing one level reaches its own unit's lib.
log_info "runner-copy gate (gating — tracked sources)"
# The interpreter runners live ONCE, at the repo root (docs/d138). A unit copy
# re-forks the pin — estige/build.sh had inlined the whole function before this
# existed — and a fork of a version pin is exactly the drift no gate would catch
# later, because the copy keeps working until the day it does not.
if _runner_copies=$(git ls-files '*/lib/node-run.sh' '*/lib/npm-run.sh' '*/lib/node-run.ps1' '*/node-run.ps1'); then
	if [ -n "$_runner_copies" ]; then
		echo "per-unit runner copy — the pin is ./node-run.sh at the repo root (docs/d138):" >&2
		echo "$_runner_copies" >&2
		exit 1
	fi
fi

log_info "retired-root-lib gate (gating — tracked sources)"
if git grep -nE 'parent[.]parent|HERE[.]parent' -- '*.py' \
	|| git grep -nE '[.][.]/lib/' -- '*.mjs' '*.sh' '*.jq' '*.ts' ':(exclude)*/tests/*'; then
	echo "reference to a lib/ outside the unit's own (docs/d113) — see lines above" >&2
	exit 1
fi

# Spec-graph contract gate (docs/d140): the frontmatter invariants
# docs/spec-graph-standard.md states and the ThinkRail validator does not check
# — the vocabulary, titles, id spelling, the nesting rules, and the file/edge
# agreement. Offline and textual: it walks markdown and fetches nothing.
log_info "spec graph (gating — docs/spec-graph-standard.md)"
"$repo_root/node-run.sh" docs/spec-check.mjs ||
	log_die 96 "spec graph is off-contract" \
		hint="fix the findings above (docs/spec-graph-standard.md)"

# golangci-lint — the Go lint gate (docs/d137). estige is the repo's only Go
# unit (docs/d102/d113) and its rule set rides in the folder
# (estige/.golangci.yml), so it travels with the unit on the docs/d082 split.
#
# Two things separate this leg from the mise tools above:
#   - it needs a WORKING go toolchain on PATH, not a mise shim: golangci-lint
#     shells out to `go list`. The three-step probe is test.sh's (docs/d123);
#     a host with no Go skips loudly, because a laptop with no toolchain
#     cannot be asked to lint Go.
#   - it is PINNED, not @latest: a linter's rule set IS the gate's meaning, so
#     a floating pin would change what green means between runs (the biome
#     posture, docs/d107). The pin lives here because the repo commits no
#     mise.toml (docs/d051/d082); Termux has no mise and takes whatever
#     `pkg install golangci-lint` ships, so a bump there re-runs the survey.
log_info "golangci-lint (gating — Go; rule set in estige/.golangci.yml, docs/d137)"
# Both binaries are resolved to REAL paths and placed first on PATH: the child
# `go list` would otherwise resolve the mise SHIM, which errors "no version is
# set" because this repo pins no bare `go` (docs/d051). On a dev host
# dev_tool_bin also acquires the tool (docs/d139); on Termux/mise-less hosts a
# missing toolchain skips the leg loudly, because a box with no Go cannot be
# asked to lint Go.
if [ ! -d estige ]; then
	log_info "skipped — no estige/ under $root"
elif ! _go_bin=$(dev_tool_bin go); then
	log_warn "skipped — no go toolchain" hint="./dev-tools.sh go (or the host package manager)"
else
	_golangci=$(dev_tool_bin golangci-lint) ||
		log_die 96 "golangci-lint is not obtainable" hint="./dev-tools.sh golangci-lint"
	PATH="$(dirname "$_go_bin"):$PATH"
	export PATH
	# config verify is the schema gate first: in v2 a typo'd key makes
	# golangci-lint silently drop the whole config, so the schema check runs
	# before the lint.
	( cd estige && "$_golangci" config verify && "$_golangci" run ./... )
fi

