#!/bin/sh
# lib/environment.sh — THE environment loader: infisical vault chain, made
# EXPLICIT by invocation.
#
#   ./lib/environment.sh ./coding-agent/generate.sh [args...]
#   ./lib/environment.sh ./coding-agent/run.sh
#   ./lib/environment.sh ./llm-local-inference/run.sh
#   ./lib/environment.sh ./local-llm/run-all.sh
#
# The named script runs with the vault injected into its environment (ONE
# in-memory infisical round-trip, parsed straight out of a here-string —
# never a file on disk). The script itself is environment-agnostic: it reads
# plain env vars and never knows or cares where they came from. That split —
# WHO loads the environment vs WHO consumes it — is the whole point of the
# explicit chain:
#
#   - the loader runs OUTSIDE the container/sandbox (the host login state
#     never leaves the host); consumers inside a sandbox see plain forwarded
#     env via the workload_env allowlist
#   - a consumer can be run WITHOUT the chain when its env is already
#     correct (CI, another loader) — it has no loader of its own to skip
#   - testing a consumer is "run it with a stub env"; testing the loader is
#     "run anything through it and diff `env`"
#
# Secrets sourcing (formerly load_secrets's two-path logic, now ONE path —
# the emergency "environment is already seeded" short-circuit was removed):
# infisical only. Binary resolution (first executable wins):
#   $INFISICAL_BIN › $HOME/Infisical/cli/infisical (the Termux/Android
#   source build — see the repo root ./build.sh, which also documents the
#   -checklinkname=0 flags) › `mise x infisical@latest` › `infisical` on PATH.
#
# Identity is pinned (INFISICAL_API_URL / INFISICAL_PROJECT_ID below) so the
# CLI resolves the correct workspace from any working directory; self-hosted
# instances override INFISICAL_API_URL. These are routing, NOT secrets.
#
# Exit codes: 91 missing target script · 95 no infisical binary · 96 vault
# fetch returned nothing (previously a warn-and-continue — with the emergency
# path gone there is nothing to fall back TO, so an empty vault is now fatal:
# the consumer would otherwise run half-configured and fail opaquely
# downstream). A failing vault CLI propagates its own exit code.
#
# NEVER FATAL is gone by design; "generators tolerate missing keys" still
# holds INSIDE consumers (they see an empty var and skip that provider) —
# but reaching them at all requires a successful vault round-trip.
#
# Env: INFISICAL_BIN (explicit binary) · INFISICAL_API_URL / INFISICAL_PROJECT_ID
# (identity overrides) · everything else passes through untouched.

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

# Infisical identity, pinned so `infisical` resolves the correct workspace from
# any working directory (proposals-upstream.md D). Self-hosted instances override
# INFISICAL_API_URL; the project id matches the workspaceId in the checked-in
# .infisical.json.  Exported so the vault CLI (and any child that re-reads them)
# references these instead of duplicating the literal across scripts.
# These are routing, NOT secrets.
INFISICAL_API_URL="${INFISICAL_API_URL:-https://app.infisical.com}"
INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-628c46b6-a5d5-4671-9435-c205847397ce}"
export INFISICAL_API_URL INFISICAL_PROJECT_ID

# Binary resolution — first executable wins (see the header).
# $INFISICAL_BIN › Termux/Android source build › mise › PATH.
_infisical_run() {
	if [ -n "${INFISICAL_BIN:-}" ] && [ -x "$INFISICAL_BIN" ]; then
		"$INFISICAL_BIN" "$@"
	elif [ -x "$HOME/Infisical/cli/infisical" ]; then
		# The Termux/Android source build (see the repo's ./build.sh) — tried
		# before mise so a Termux host with mise installed still uses the
		# locally built CLI (no official Android release exists).
		"$HOME/Infisical/cli/infisical" "$@"
	elif command -v infisical >/dev/null 2>&1; then
		"infisical" "$@"
	elif command -v mise >/dev/null 2>&1; then
		# mise hosts without a PATH binary: run it through mise's environment.
		mise x infisical@latest -- "$@"
	else
		return 127
	fi
}
_infisical_available() {
	{ [ -n "${INFISICAL_BIN:-}" ] && [ -x "$INFISICAL_BIN" ]; } \
		|| [ -x "$HOME/Infisical/cli/infisical" ] \
		|| command -v infisical >/dev/null 2>&1 \
		|| command -v mise >/dev/null 2>&1
}
_infisical_available ||
	log_die 95 "no infisical binary — run the repo's ./build.sh (Termux: source build; elsewhere: mise x infisical@latest or a release binary on PATH)"

# Dotenv parser for an IN-MEMORY string ($1) — the infisical fetch.  There is
# deliberately no file variant of this (no `.env`, no `$ENV_FILE`): the vault
# keys must never be materialized on disk, so the CLI's dotenv output is
# parsed straight from a here-doc.  The here-doc keeps the `while` loop in
# this shell (exports persist into the exec'd target), and parameter expansion
# yields literal text (no eval / no re-expansion).
# shellcheck disable=SC2163  # intentional dynamic export
_inject() {
	while IFS= read -r _l || [ -n "$_l" ]; do
		case "$_l" in ''|\#*) continue ;; esac
		_l="${_l#export }"
		case "$_l" in *=*) export "$_l" ;; esac
	done <<EOF
$1
EOF
}

# ONE vault round-trip, injected into THIS process's environment, then exec —
# the target replaces this shell (no wrapper process left behind, no env
# re-marshalling) and sees the vault as plain environment.
#
# The fetch is deliberately UNGUARDED (no `if` around it): a failing or empty
# vault must be fatal now that there is no fallback loader to defer to —
# see the exit-codes note in the header.
log_info "loading environment" \
	target="$target" api="${INFISICAL_API_URL}" project="${INFISICAL_PROJECT_ID}"
_secrets_dotenv="$(_infisical_run secrets --output=dotenv --silent \
	--domain="${INFISICAL_API_URL}" \
	--projectId="${INFISICAL_PROJECT_ID}" \
	--env=prod --path=/inference)"
[ -n "$_secrets_dotenv" ] ||
	log_die 96 "vault returned nothing — refusing to launch '$target' with an empty environment"
_inject "$_secrets_dotenv"
unset _secrets_dotenv

log_info "environment loaded — exec" target="$target" args="${*:-<none>}"
exec "$target" "$@"
