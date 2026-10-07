#!/bin/sh
# lib/environment.sh — THE explicit env chain: `infisical run` fetches the
# vault, injects it into the child environment and spawns the target
# (docs/d046).  One invocation, no dotenv parsing, nothing on disk:
#
#   ./lib/environment.sh ./coding-agent/run.sh [args...]
#   ./lib/environment.sh pi                       # bare command → resolved on PATH
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
#   - the target-resolution contract (file or PATH command; exit 91)
#
# Exit codes: 91 missing target (no file, nothing on PATH) · 95 no infisical
# binary; vault errors propagate from the CLI itself.
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
	log_die 91 "usage: lib/environment.sh <script-or-command> [args...]  — e.g. lib/environment.sh ./coding-agent/generate.sh, lib/environment.sh pi"

target="$1"
shift

# Resolve a file target relative to the CALLER's cwd (so ./coding-agent/...
# works from the repo root as advertised). A bare command name resolves on
# PATH instead — that is what makes `./lib/environment.sh pi` the sandbox-free
# run path (docs/d059). Either way resolution happens HERE, before the vault
# round-trip: a bad target never costs an infisical call.
if [ -f "$target" ]; then
	case "$target" in
	/*) ;;
	*) target="$(pwd)/$target" ;;
	esac
else
	_target_path="$(command -v "$target" 2>/dev/null || true)"
	[ -n "$_target_path" ] && [ -f "$_target_path" ] ||
		log_die 91 "target not found — not a file and not on PATH" target="$target" cwd="$(pwd)"
	target="$_target_path"
fi

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
elif command -v infisical >/dev/null 2>&1 && infisical --version >/dev/null 2>&1; then
	# Accepted only if it EXECUTES: a mise shim answers `command -v` yet dies
	# with "No version is set for shim" unless that tool has a default version
	# set, so a PATH hit which cannot run standalone falls through to the wrap
	# below rather than failing the vault round-trip (d059).
	_infisical_bin=infisical
elif command -v mise >/dev/null 2>&1; then
	_mise_wrap=1
else
	log_die 95 "no infisical binary — run the repo's ./build.sh (Termux: source build; elsewhere: mise x infisical@latest or a release binary on PATH)"
fi

_vault_exec() {
	if [ -n "$_mise_wrap" ]; then
		# infisical named EXPLICITLY: `mise x tool -- cmd` execs cmd as given (it
		# only injects the tool's env/PATH), so the bare `run` subcommand below
		# used to be exec'd as a program and died with "couldn't exec process" —
		# silently leaving the mise-fallback host with no vault at all (d059).
		exec mise x infisical@latest -- infisical "$@"
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
