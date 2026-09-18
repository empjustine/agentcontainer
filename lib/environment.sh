#!/bin/sh
# lib/environment.sh — THE explicit env chain: `infisical run` fetches the
# vault, injects it into the child environment and spawns the target
# (docs/d046).  One invocation, no dotenv parsing, nothing on disk:
#
#   ./lib/environment.sh ./coding-agent/run.sh [args...]
#
# Consumers read plain env and never load secrets themselves; a failing
# vault aborts here via infisical's own exit code.  The successful-but-empty
# vault is no longer special-cased (the old exit-96 pre-flight is gone,
# docs/d046) — the consumers' "tolerate missing keys" contract covers it.
#
# The wrapper keeps only what the CLI does not own:
#   - binary resolution: $INFISICAL_BIN › $HOME/Infisical/cli/infisical (the
#     Termux/Android source build — provisioned by lib/provision-termux.sh
#     via the root ./build.sh; the -checklinkname=0 flags are documented
#     there) › `infisical` on PATH › `mise x infisical@latest`
#   - pinned identity: INFISICAL_API_URL / INFISICAL_PROJECT_ID below —
#     routing, NOT secrets; same defaults as lib/workload-runtime.sh
#   - the target-exists contract (exit 91)
#
# Exit codes: 91 missing target script · 95 no infisical binary; vault
# errors propagate from the CLI itself.
#
# Env: INFISICAL_BIN (explicit binary) · INFISICAL_API_URL /
# INFISICAL_PROJECT_ID (identity overrides) · INFISICAL_ENV (vault env,
# default prod) · everything else passes through untouched.

set -eu

here="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$here/.." && pwd)"

# shellcheck disable=SC1091
. "$REPO_ROOT/lib/log.sh"
LOG_TOOL='lib/environment'
export LOG_TOOL

[ "$#" -ge 1 ] ||
	log_die 91 "usage: lib/environment.sh <script> [args...]  — e.g. lib/environment.sh ./coding-agent/generate.sh"

target="$1"
shift

# Resolve the target relative to the CALLER's cwd (so ./coding-agent/... works
# from the repo root as advertised), then require it to exist and be runnable.
if [ ! -f "$target" ]; then
	log_die 91 "target script not found" target="$target" cwd="$(pwd)"
fi
case "$target" in
	/*) ;;
	*) target="$(pwd)/$target" ;;
esac
[ -f "$target" ] || log_die 91 "target script not found" target="$target"

# Identity — same pins as lib/workload-runtime.sh (routing, NOT secrets).
# INFISICAL_DOMAIN, not `run`'s --domain flag: in CLI 0.43.x the run
# subcommand mis-parses the flag ("Unable to parse domain url") while the
# env var works, and the flag's default carries an /api suffix the pinned
# URL deliberately does not (docs/d046).
INFISICAL_API_URL="${INFISICAL_API_URL:-https://app.infisical.com}"
INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-628c46b6-a5d5-4671-9435-c205847397ce}"
INFISICAL_DOMAIN="$INFISICAL_API_URL"
export INFISICAL_API_URL INFISICAL_PROJECT_ID INFISICAL_DOMAIN

# Binary resolution — first executable wins (see the header).
_infisical_bin=''
_mise_wrap=''
if [ -n "${INFISICAL_BIN:-}" ] && [ -x "$INFISICAL_BIN" ]; then
	_infisical_bin="$INFISICAL_BIN"
elif [ -x "$HOME/Infisical/cli/infisical" ]; then
	# The Termux/Android source build — tried before mise so a Termux host
	# with mise installed still uses the locally built CLI (no official
	# Android release exists).
	_infisical_bin="$HOME/Infisical/cli/infisical"
elif command -v infisical >/dev/null 2>&1; then
	_infisical_bin=infisical
elif command -v mise >/dev/null 2>&1; then
	_mise_wrap=1
else
	log_die 95 "no infisical binary — run the repo's ./build.sh (Termux: source build; elsewhere: mise x infisical@latest or a release binary on PATH)"
fi

_vault_exec() {
	if [ -n "$_mise_wrap" ]; then
		exec mise x infisical@latest -- "$@"
	fi
	exec "$_infisical_bin" "$@"
}

log_info "loading environment (infisical run)" target="$target" \
	api="${INFISICAL_API_URL}" project="${INFISICAL_PROJECT_ID}"

# --expand=false keeps secret values literal — the old hand-rolled parser
# never re-expanded, and `infisical run`'s default WOULD shell-expand them.
# --projectId stays for machine-identity auth (no .infisical.json is checked
# in on purpose: it only ever helped commands launched from inside the repo
# root, and every consumer here is cwd-independent by design).
_vault_exec run \
	--env="${INFISICAL_ENV:-prod}" --path=/inference \
	--projectId="${INFISICAL_PROJECT_ID}" \
	--expand=false --silent -- "$target" "$@"
