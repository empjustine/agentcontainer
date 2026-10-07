#!/bin/sh
# -vbs-mirror-all.sh — mirror EVERY git repository reachable in a Visual
# Builder Studio (VBS) tenant.
# One input mode, one mirror loop (docs/d044):
#
#   manifest  read a JSON inventory produced by git/vbs-har.sh (a HAR export).
#             No HTTP, no secrets.
#
# The manifest is the stable seam: the fragile, authenticated part is a browser
# HAR capture, and this half is deterministic and secret-free:
#
#   { generatedAt, base, org, repositories: [ { projectId, projectSlug,
#     repo, httpsUrl, sshUrl } ] }
#
# Secrets stay in the environment and are never written under the repo.
#
# Bulk-mirroring the tenant earns a rate limit (the forge answers with 403/429
# or a dropped connection). A failing repo is therefore retried with exponential
# backoff + jitter, the sweep is paced between repos, and a run of consecutive
# failures triggers a cooldown before continuing — nothing is silently dropped.
#
# Usage:
#   # export a HAR in the browser, convert it, then mirror from it
#   ./git/-vbs-mirror-all.sh --manifest vbs-manifest.json --dest DIR
#
# What a run IS and DOES comes from its argv and its manifest, never from the
# caller's environment (docs/d060): the manifest carries the tenant (base,
# org, repos), the mirror root and the clone identity are flags, and the
# retry/pacing policy is flags-or-constants — so no exported shell variable
# can re-point a sweep or quietly turn off its rate limiting. $WORK_MIRRORS
# is the one external read left: this machine's mirror root, the same host
# state `git/*.mjs` default from (docs/d044). Credentials are the other thing
# that has to stay in the environment — this script takes none: the HAR
# capture is the auth, and a username on argv is visible but not secret
# (docs/d044).
#
# Flags:
#   --manifest FILE   mirror from a vbs-har.sh manifest (no HTTP/auth; the
#                     manifest supplies the tenant origin and org)
#   --dest DIR        bare-mirror root (default $WORK_MIRRORS; required —
#                     no hard-coded operator path)
#   --transport T     ssh|https (default ssh)
#   --ssh-user USER   userinfo for built ssh clone URLs (the idcs-... identity)
#   --http-user USER  userinfo for built https clone URLs (the email)
#   --list            print discovered identity + clone URL, do not touch git
#   --only GLOB       mirror only repos whose org/slug/name matches (shell case glob)
#   --throttle N      seconds between repositories (default 60)
#   --retries N       retries per repo after the first failure (default 10;
#                     attempts = retries + 1)
#   --cooldown N      cooldown seconds after 5 consecutive failures (default 60)
#   -h, --help

set -eu

# Structured logs (docs/d045): the message is a static label, values are
# key=value fields — never interpolated prose. The stream is stderr because
# stdout carries this script's one machine payload (--list's TSV rows).
# shellcheck disable=SC2034  # read by lib/log.sh at source time
LOG_TOOL='git/-vbs-mirror-all'
# shellcheck disable=SC2034  # read by lib/log.sh at source time
LOG_STREAM=stderr
# shellcheck disable=SC1091  # path is relative to this script's dir
. "$(dirname "$0")/../lib/log.sh"

PROG=${0##*/}

# Run inputs and sweep policy are initialised from constants and flags, never
# from the caller's environment (docs/d060): the values below are what this
# script IS. WORK_MIRRORS is the sole external read — the mirror root of this
# machine, host state no flag can default portably — and the run logs the
# resolved dest/transport on its first line anyway.
VBS_BASE=
VBS_ORG=
VBS_DEST=${WORK_MIRRORS:-}
VBS_TRANSPORT=ssh
VBS_SSH_USER=
VBS_HTTP_USER=

# A failed clone must not be dropped: bulk-cloning this tenant earns a rate
# limit, and the fix is to back off, retry, and pace the sweep (docs/d044).
# This is the tenant's rate-limit contract, so it is fixed policy with three
# flag overrides for the knobs an operator actually tunes.
VBS_RETRIES=10
VBS_RETRY_DELAY=60
VBS_RATE_DELAY=60
VBS_BACKOFF_MAX=300
VBS_THROTTLE=60
VBS_FAIL_STREAK=5
VBS_COOLDOWN=60

# A credential prompt in a non-interactive sweep would hang; fail fast instead.
export GIT_TERMINAL_PROMPT=0

LIST_ONLY=0
ONLY=
MANIFEST=

usage() {
	cat <<EOF
usage: $PROG --manifest FILE [--dest DIR] [--list] [--only GLOB]

Mirrors every repository in the VBS tenant as a bare repo.

Inputs (flags; the caller's environment is not a config surface — docs/d060):
  # export a HAR capture from the browser, convert it with vbs-har.sh, then
  # mirror from the manifest — it carries the tenant origin and org
  $PROG --manifest vbs-manifest.json --dest DIR

  --dest DIR        mirror root (default \${WORK_MIRRORS:-unset})
  --transport T     ${VBS_TRANSPORT} (ssh|https)
  --ssh-user USER   ${VBS_SSH_USER:-unset}
  --http-user USER  ${VBS_HTTP_USER:-unset}

Rate limiting (the defaults shown; flags are the only way to move them):
  --throttle N   seconds between repositories (default $VBS_THROTTLE)
  --retries N    retries per repo after the first failure (default $VBS_RETRIES)
  --cooldown N   pause after $VBS_FAIL_STREAK consecutive failures (default ${VBS_COOLDOWN}s)
EOF
}

# Strip one scheme, then any trailing slash: VBS_HOST is what the clone URL
# builders need.
vbs_host() {
	h=${VBS_BASE#*://}
	printf '%s' "${h%/}"
}

while [ $# -gt 0 ]; do
	case $1 in
	--manifest)
		MANIFEST=$2
		shift
		;;
	--list) LIST_ONLY=1 ;;
	--only)
		ONLY=$2
		shift
		;;
	--dest)
		VBS_DEST=$2
		shift
		;;
	--transport)
		VBS_TRANSPORT=$2
		shift
		;;
	--ssh-user)
		VBS_SSH_USER=$2
		shift
		;;
	--http-user)
		VBS_HTTP_USER=$2
		shift
		;;
	--throttle)
		VBS_THROTTLE=$2
		shift
		;;
	--retries)
		VBS_RETRIES=$2
		shift
		;;
	--cooldown)
		VBS_COOLDOWN=$2
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*) log_die 1 "unknown argument (try --help)" arg="$1" ;;
	esac
	shift
done

if [ -z "$MANIFEST" ]; then
	log_die 1 "no manifest: --manifest FILE (a vbs-har.sh export carries base + org)"
fi
[ -f "$MANIFEST" ] || log_die 1 "manifest not found" manifest="$MANIFEST"
# The manifest is the input file, so it — not the environment — is what
# names the tenant (docs/d060).
_morg=$(jq -r '.org // empty' "$MANIFEST" 2>/dev/null || true)
if [ -n "$_morg" ]; then VBS_ORG=$_morg; fi
_mbase=$(jq -r '.base // empty' "$MANIFEST" 2>/dev/null || true)
if [ -n "$_mbase" ]; then VBS_BASE=${_mbase%/}; fi
# Without an origin there is nothing to clone; fail loud rather than half-run.
if [ -z "$VBS_BASE" ]; then
	log_die 1 "no tenant origin: manifest has no base field"
fi
# Same policy as the origin: the NTFS profile path was one operator's machine,
# not a default any other host can use.
if [ -z "$VBS_DEST" ]; then
	log_die 1 "no mirror dest: pass --dest DIR (or set WORK_MIRRORS)"
fi
if [ -z "$VBS_ORG" ]; then
	VBS_ORG=$(vbs_host | cut -d. -f1)
fi
if [ "$VBS_TRANSPORT" != ssh ] && [ "$VBS_TRANSPORT" != https ]; then
	log_die 1 "--transport must be ssh or https" transport="$VBS_TRANSPORT"
fi

# Creating /mnt/... where the drive is not mounted would bury the farm in the
# WSL2 rootfs, defeating the entire reason the dest is on NTFS (docs/d044).
case $VBS_DEST in
/mnt/?/*)
	_drive=${VBS_DEST#/mnt/}
	_drive=${_drive%%/*}
	if [ ! -d "/mnt/$_drive" ]; then
		log_die 1 "dest drive is not mounted" mount="/mnt/$_drive"
	fi
	;;
esac

command -v jq >/dev/null 2>&1 || log_die 1 "jq not found"
command -v git >/dev/null 2>&1 || log_die 1 "git not found"

# A GET config would silently use ssh's default user; the tenant needs the
# IDCS userinfo, so make the missing credential loud instead of mysterious.
if [ "$VBS_TRANSPORT" = ssh ] && [ -z "$VBS_SSH_USER" ] && [ "$LIST_ONLY" -eq 0 ]; then
	log_warn "ssh user is empty — ssh clones may fail; pass --ssh-user"
fi

# --- JSON extraction --------------------------------------------------------
# The SPA endpoints are undocumented, so the extractor accepts the handful of
# envelope shapes such shapes use (bare array, repositories, or a name-keyed
# object map). It is this file's own code rather than an env override, because
# the shape is a property of the HAR converter's output, not of the caller
# (docs/d060).

default_manifest_jq() {
	cat <<'JQ'
def repos:
  if type == "array" then .
  elif (.repositories? | type) == "array" then .repositories
  else [] end;
repos[]
| [ (.projectId // .projectGuid // ""),
    (.projectSlug // .project // .slug // ""),
    (.repo // .name // ""),
    (.httpsUrl // .httpUrl // ""),
    (.sshUrl // "") ]
| map(if . == null then "" else tostring end) | join("\u001f")
JQ
}

MANIFEST_JQ=$(default_manifest_jq)

# `projectId` is `<org>_<slug>_<numeric>`; the glass directory is the slug.
slug_from_project_id() {
	case $1 in
	"${VBS_ORG}_"*) _rest=${1#"${VBS_ORG}_"} ;;
	*) _rest=$1 ;;
	esac
	_tail=${_rest##*_}
	_base=${_rest%_*}
	if [ "$_tail" != "$_rest" ] && [ -n "$_tail" ] &&
		[ -z "$(printf '%s' "$_tail" | tr -d '0-9')" ]; then
		printf '%s' "$_base"
	else
		printf '%s' "$_rest"
	fi
}

# Insert userinfo into a URL that lacks it. HAR clone URLs (`url`,
# `alternateUrl`) are userinfo-less; the shell's configured identity supplies
# it, while a URL that already carries one is untouched.
inject_user() {
	# $1 url, $2 userinfo (may be empty)
	if [ -z "$2" ]; then
		printf '%s' "$1"
		return
	fi
	case ${1#*://} in
	*@*) printf '%s' "$1" ;;
	# Preserve the URL's own protocol: the ssh branch of clone_url calls this
	# with an ssh:// URL, so hardcoding https here rewrote ssh clones to https.
	*) printf '%s://%s@%s' "${1%%://*}" "$2" "${1#*://}" ;;
	esac
}

clone_url() {
	# $1 projectId, $2 repo (no .git), $3 json-http URL, $4 json-ssh URL
	if [ "$VBS_TRANSPORT" = ssh ]; then
		if [ -n "$4" ]; then
			inject_user "$4" "$VBS_SSH_USER"
			return
		fi
		_auth=
		if [ -n "$VBS_SSH_USER" ]; then _auth="$VBS_SSH_USER@"; fi
		printf 'ssh://%s%s/%s/%s.git' "$_auth" "$(vbs_host)" "$1" "$2"
	else
		if [ -n "$3" ]; then
			inject_user "$3" "$VBS_HTTP_USER"
			return
		fi
		_auth=
		if [ -n "$VBS_HTTP_USER" ]; then _auth="$VBS_HTTP_USER@"; fi
		printf 'https://%s%s/%s/s/%s/scm/%s.git' "$_auth" "$(vbs_host)" "$VBS_ORG" "$1" "$2"
	fi
}

# Exponential backoff: base * 2^(attempt-1), capped, plus up to 3s of jitter so
# retries do not re-collide on the same second.
backoff_seconds() {
	# $1 attempt (1-based), $2 base seconds
	_delay=$2
	_i=1
	while [ "$_i" -lt "$1" ]; do
		_delay=$((_delay * 2))
		_i=$((_i + 1))
	done
	if [ "$_delay" -gt "$VBS_BACKOFF_MAX" ]; then
		_delay=$VBS_BACKOFF_MAX
	fi
	_jitter=$(awk 'BEGIN { srand(); printf "%d", rand() * 3 }')
	printf '%s' "$((_delay + _jitter))"
}

# The forge's rate-limit/blocked signatures. 403 is folded in deliberately:
# on this tenant throttling surfaces as 403, not only 429.
looks_rate_limited() {
	grep -Eqi 'rate.?limit|too many|throttl|slow down|abuse|429|403|forbidden|access denied|temporarily' "$1"
}

# Transient network/5xx signatures a retry can clear.
looks_transient() {
	grep -Eqi '429|5[0-9][0-9]|timeout|timed out|connection (reset|closed|refused|aborted)|could not resolve|network is unreachable|tls|ssl' "$1"
}

mirror_one() {
	# $1 url, $2 target
	_attempt=1
	while :; do
		if [ -d "$2" ]; then
			_phase=align
			if git -C "$2" remote update --prune >"$TMP/git.out" 2>&1; then
				log_info "aligned" target="$2"
				return 0
			fi
		else
			_phase=clone
			mkdir -p "$(dirname "$2")"
			if git clone --mirror "$1" "$2" >"$TMP/git.out" 2>&1; then
				log_info "mirrored" target="$2"
				return 0
			fi
			# A half-written mirror would be mistaken for a good one on the next
			# run, so remove it before any retry.
			rm -rf "$2"
		fi

		if looks_rate_limited "$TMP/git.out"; then
			if [ "$_attempt" -gt "$VBS_RETRIES" ]; then
				log_error "step failed rate-limited" phase="$_phase" url="$1" attempt="$_attempt" retries="$VBS_RETRIES" output="$(tail -n 3 "$TMP/git.out")"
				return 1
			fi
			_delay=$(backoff_seconds "$_attempt" "$VBS_RATE_DELAY")
			log_warn "rate limited — sleeping" phase="$_phase" delay="$_delay" attempt="$_attempt" retries="$VBS_RETRIES"
		elif looks_transient "$TMP/git.out"; then
			if [ "$_attempt" -gt "$VBS_RETRIES" ]; then
				log_error "step failed transient" phase="$_phase" url="$1" attempt="$_attempt" retries="$VBS_RETRIES" output="$(tail -n 3 "$TMP/git.out")"
				return 1
			fi
			_delay=$(backoff_seconds "$_attempt" "$VBS_RETRY_DELAY")
			log_warn "transient failure — sleeping" phase="$_phase" delay="$_delay" attempt="$_attempt" retries="$VBS_RETRIES"
		else
			# A hard failure (bad path, deleted repo, real auth failure) will not
			# fix itself; report and move on without burning the rate budget.
			log_error "step failed" phase="$_phase" url="$1" output="$(tail -n 3 "$TMP/git.out")"
			return 1
		fi
		sleep "$_delay"
		_attempt=$((_attempt + 1))
	done
}

# Track a run of failures and pause the whole sweep once it looks systemic
# rather than per-repo, which is what a rate limit looks like from here.
note_result() {
	if [ "$1" -eq 0 ]; then
		STREAK=0
		return
	fi
	STREAK=$((STREAK + 1))
	if [ "$STREAK" -ge "$VBS_FAIL_STREAK" ]; then
		log_warn "consecutive failures — cooling down" streak="$STREAK" cooldown="$VBS_COOLDOWN" cause="likely rate limited"
		sleep "$VBS_COOLDOWN"
		STREAK=0
	fi
}

handle_repo() {
	# $1 projectId, $2 projectSlug, $3 repo (no .git), $4 json-https, $5 json-ssh
	_pid=$1
	_slug=$2
	_name=$3
	if [ -z "$_slug" ] && [ -n "$_pid" ]; then
		_slug=$(slug_from_project_id "$_pid")
	fi
	[ -n "$_slug" ] || _slug=unknown
	_identity="$VBS_ORG/$_slug/$_name"
	if [ -n "$ONLY" ]; then
		# shellcheck disable=SC2254  # --only is deliberately a glob, not a literal
		case $_identity in
		$ONLY) ;;
		*) return 0 ;;
		esac
	fi
	_url=$(clone_url "$_pid" "$_name" "$4" "$5")
	if [ "$LIST_ONLY" -eq 1 ]; then
		printf '%s\t%s\n' "$_identity" "$_url"
		return 0
	fi
	_target="$VBS_DEST/$VBS_ORG/$_slug/$_name.git"
	if mirror_one "$_url" "$_target"; then
		OK=$((OK + 1))
		_rc=0
	else
		FAILED=$((FAILED + 1))
		_rc=1
	fi
	# Gentle pacing: a bulk mirror is what earns the rate limit in the first place.
	if [ "$VBS_THROTTLE" -gt 0 ]; then sleep "$VBS_THROTTLE"; fi
	return "$_rc"
}

# --- main -------------------------------------------------------------------

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

OK=0
FAILED=0
STREAK=0
# Unit Separator, not tab: tab is IFS *whitespace*, and `read` collapses runs
# of it — so an empty clone-URL column would silently shift every later field.
# US is not whitespace, so empty fields survive (docs/d044).
SEP=$(printf '\037')

log_info "mirroring tenant" base="$VBS_BASE" org="$VBS_ORG" dest="$VBS_DEST" transport="$VBS_TRANSPORT"
if [ "$LIST_ONLY" -eq 1 ]; then
	log_info "list-only: no git writes"
fi

log_info "mirroring from manifest" manifest="$MANIFEST"
jq -r "$MANIFEST_JQ" "$MANIFEST" >"$TMP/repos.tsv" ||
	log_die 1 "could not parse manifest (shape not one the extractor knows)"
ROWS=$(grep -c . "$TMP/repos.tsv" || true)
log_info "repositories loaded" rows="$ROWS"
[ "$ROWS" -gt 0 ] || log_die 1 "manifest has no repositories"

while IFS=$SEP read -r mpid mslug mrepo mhttp mssh; do
	[ -n "$mrepo" ] || continue
	if handle_repo "$mpid" "$mslug" "${mrepo%.git}" "$mhttp" "$mssh"; then
		note_result 0
	else
		note_result 1
	fi
done <"$TMP/repos.tsv"

if [ "$LIST_ONLY" -eq 1 ]; then
	exit 0
fi
log_info "summary" mirrored="$OK" failed="$FAILED"
[ "$FAILED" -eq 0 ]
exit $?
