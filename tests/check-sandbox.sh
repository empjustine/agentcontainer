#!/bin/sh
# check-sandbox.sh — behavioural check for the sandbox description API.
#
# WHAT IT CHECKS: that a description assembled through the workload_* calls
# renders to the exact `container run` argv it produced BEFORE the list side of
# the description (mounts, env, ports, devices, cmd) was moved out of shell
# globals and into the JSON document built by lib/sandbox-*.jq.  The
# expectations below are the pre-refactor output, captured from the old shell
# renderer, so this is a differential test against the behaviour that shipped.
#
# WHY IT EXISTS: the two bugs found during that refactor were invisible to
# static analysis — neither shellcheck nor the jq compile gate in ../lint.sh
# can see them — because both are semantic rather than syntactic:
#   * jq keeps parsing options after --args, so `workload_cmd -config-dir …` was
#     read as jq flags ("Unknown option -o") until a bare `--` was added;
#   * workload_has ran jq without -n, so the filter never ran at all and the
#     predicate silently returned 4 instead of 0/1.
# Only an end-to-end render catches either.
#
# Two cases, one per backend, because the mount options are the one genuine
# backend difference (podman "z,U" vs docker "z" — see lib/sandbox-render.jq).
#
# Usage: ./tests/check-sandbox.sh     (from any directory)

set -eu

# NOTE: lib/workload-runtime.sh derives REPO_ROOT from the CALLER's $0 (that is how
# coding-agent/run.sh gets the repo root one level up), so this script has to
# live exactly one directory below the repo root — hence tests/.
root="$(CDPATH='' cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091  # loads log_* + the workload_* API under test
. "$root/lib/workload-runtime.sh"
LOG_TOOL='check-sandbox'
export LOG_TOOL

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM
mkdir -p -- "$tmp/src/a workspace with spaces"

# A stand-in container tool that prints its argv one word per line.  The names
# matter: --from-file's mount-option branch keys off the tool NAME, so the fake
# must be called podman/docker for that branch to be exercised.
for _ct in podman docker; do
	# shellcheck disable=SC2016  # $@/$a must stay literal in the GENERATED file
	printf '#!/bin/sh\nfor a in "$@"; do printf "ARG[%%s]\\n" "$a"; done\n' >"$tmp/$_ct"
	chmod 0755 -- "$tmp/$_ct"
done
PATH="$tmp:$PATH"
export PATH

_fail=0

# Normalise the two things that legitimately vary between machines: the mktemp
# path, and the uid:gid the --user flag carries.
_norm() { sed -e "s|$tmp|<TMP>|g" -e "s|$(id -u):$(id -g)|<UID>:<GID>|g"; }

_check() {
	_name="$1"
	if diff -u "$tmp/expect.$_name" "$tmp/got.$_name" >"$tmp/diff.$_name" 2>&1; then
		log_info "ok" case="$_name" \
			words="$(wc -l <"$tmp/got.$_name" | tr -d ' ')"
	else
		_fail=1
		log_error "MISMATCH" case="$_name"
		sed 's/^/    /' "$tmp/diff.$_name" >&2
	fi
}

# --- case 1: coding-agent shape, podman -------------------------------------
# Exercises: --init, interactive (-it), --network, --user with the rootless
# podman extras (a multi-word flag, --group-add keep-groups), mounts of both
# modes, workload_ro_if with a present AND an absent host path, a path
# containing spaces on both the host and guest side, seven --env names,
# --workdir, and a two-word command.
cat >"$tmp/expect.coding-agent" <<'EXPECT'
ARG[container]
ARG[run]
ARG[--init]
ARG[-it]
ARG[--name=agent-ctr]
ARG[--network=host]
ARG[--userns=keep-id]
ARG[--user]
ARG[<UID>:<GID>]
ARG[--group-add]
ARG[keep-groups]
ARG[-v]
ARG[<REPO>/docs:/config.d:z,U,ro]
ARG[-v]
ARG[<REPO>/lib/log.sh:/opt/lib/log.sh:z,U,ro]
ARG[-v]
ARG[<TMP>/src/a workspace with spaces:/mnt/a guest with spaces:z,U]
ARG[-v]
ARG[<REPO>/README.md:/opt/present:z,U,ro]
ARG[--env]
ARG[CLINE_API_KEY]
ARG[--env]
ARG[PEER_API_KEY]
ARG[--env]
ARG[OPENROUTER_API_KEY]
ARG[--env]
ARG[OPENCODE_API_KEY]
ARG[--env]
ARG[HF_TOKEN]
ARG[--env]
ARG[GEMINI_API_KEY]
ARG[--env]
ARG[PEER_BASE_URL]
ARG[--workdir]
ARG[<TMP>/src/a workspace with spaces]
ARG[localhost/empjustine/coding-agent:latest]
ARG[/bin/sh]
ARG[/opt/agentcontainer-launch.sh]
EXPECT
sed -i "s|<REPO>|$root|g" "$tmp/expect.coding-agent"

case_coding_agent() {
	_workload_tool=podman
	_userns='--userns=keep-id'
	_keep_groups='--group-add keep-groups'
	workload_name     'agent-ctr'
	workload_image    'localhost/empjustine/coding-agent:latest'
	workload_interactive
	workload_init
	workload_network  host
	workload_user
	workload_ro       "$root/docs"       /config.d
	workload_ro       "$root/lib/log.sh" /opt/lib/log.sh
	workload_rw       "$tmp/src/a workspace with spaces" '/mnt/a guest with spaces'
	workload_ro_if    "$root/README.md"  /opt/present
	workload_ro_if    "$root/nope"       /opt/absent
	workload_env      CLINE_API_KEY PEER_API_KEY OPENROUTER_API_KEY
	workload_env      OPENCODE_API_KEY HF_TOKEN GEMINI_API_KEY PEER_BASE_URL
	workload_workdir  "$tmp/src/a workspace with spaces"
	workload_cmd      /bin/sh /opt/agentcontainer-launch.sh
	_render_container
}
# A subshell per case: the workload_* accumulators are globals, so without it
# case 2 would inherit everything case 1 declared.
( case_coding_agent ) | _norm >"$tmp/got.coding-agent"
_check coding-agent

# --- case 2: openai-completions shape, docker -------------------------------
# Exercises: --detach, --publish (built from a {host,guest} record, not a
# pre-formatted string), --device (from the devices array), hardening (a
# three-word flag group), --entrypoint, docker's "z" mount option, and a
# command word that STARTS WITH A DASH — the case that needs `--args --`.
cat >"$tmp/expect.openai-completions" <<'EXPECT'
ARG[container]
ARG[run]
ARG[--detach]
ARG[--name=llama-swap]
ARG[--entrypoint]
ARG[llama-swap]
ARG[--publish]
ARG[8080:8080/tcp]
ARG[--device]
ARG[/dev/kfd:/dev/kfd:rw]
ARG[--device]
ARG[/dev/dri/renderD128:/dev/dri/renderD128:rw]
ARG[--cap-drop=all]
ARG[--security-opt]
ARG[no-new-privileges]
ARG[-v]
ARG[<REPO>/docs:/config.d:z,ro]
ARG[-v]
ARG[<TMP>/src/a workspace with spaces:/cache:z]
ARG[--env]
ARG[OPENROUTER_API_KEY]
ARG[--env]
ARG[OPENCODE_API_KEY]
ARG[--env]
ARG[PEER_API_KEY]
ARG[ghcr.io/mostlygeek/llama-swap:cpu]
ARG[-config-dir]
ARG[/config.d]
EXPECT
sed -i "s|<REPO>|$root|g" "$tmp/expect.openai-completions"

case_openai_completions() {
	_workload_tool=docker
	_userns=''
	_keep_groups=''
	workload_name       'llama-swap'
	workload_image      'ghcr.io/mostlygeek/llama-swap:cpu'
	workload_detach
	workload_publish    "${HOST_PORT:-8080}" 8080
	workload_hardening
	workload_entrypoint 'llama-swap'
	workload_ro         "$root/docs" /config.d
	workload_rw         "$tmp/src/a workspace with spaces" /cache
	workload_env        OPENROUTER_API_KEY OPENCODE_API_KEY PEER_API_KEY
	workload_cmd        -config-dir /config.d
	# Devices are populated by detect_gpu_devs on a real GPU host; there is no
	# /dev/kfd here, so declare them directly.
	_sb_append devices /dev/kfd /dev/dri/renderD128
	_render_container
}
( case_openai_completions ) | _norm >"$tmp/got.openai-completions"
_check openai-completions

# --- case 3: workload_has predicate (jq -e exit status) ----------------------
# The predicate that replaced `[ -n "$_SB_DEV" ]` in
# openai-completions/generate.sh.  It must be a usable `if` condition: true
# for a populated array, false for a missing or empty one.
cat >"$tmp/expect.has" <<'EXPECT'
devices: yes
mounts: no
env: no
env after append: yes
EXPECT
(
	_sb_append devices /dev/kfd
	workload_has devices && echo 'devices: yes' || echo 'devices: no'
	workload_has mounts  && echo 'mounts: yes'  || echo 'mounts: no'
	workload_has env     && echo 'env: yes'     || echo 'env: no'
	_sb_append env A B
	workload_has env     && echo 'env after append: yes' || echo 'env after append: no'
) >"$tmp/got.has" 2>&1
_check has

[ "$_fail" = 0 ] || log_die 1 "check-sandbox FAILED (see the diffs above)"
log_info "check-sandbox passed" cases=3
