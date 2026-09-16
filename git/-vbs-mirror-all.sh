#!/bin/sh
# -vbs-mirror-all.sh — mirror EVERY git repository reachable in a Visual
# Builder Studio (the rebranded Developer Cloud Service / OCDS) tenant.
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
#   ./git/-vbs-mirror-all.sh --manifest vbs-manifest.json
#
# Env:
#   VBS_MANIFEST      manifest file (same as --manifest)
#   VBS_MANIFEST_JQ   override the manifest extractor (JSON -> unit-separated id/slug/repo/http/ssh)
#   VBS_BASE          tenant origin           (no default: set VBS_BASE or a
#                     manifest with a base field)
#   VBS_ORG           tenant org path segment (default derived from VBS_BASE)
#   VBS_DEST          bare-mirror root        (default $WORK_MIRRORS; required —
#                     no hard-coded operator path)
#   VBS_TRANSPORT     ssh|https               (default ssh)
#   VBS_SSH_USER      userinfo for built ssh clone URLs (the idcs-... identity)
#   VBS_HTTP_USER     userinfo for built https clone URLs (the email)
#   VBS_RETRIES       retries per repo after the first failure (default 10)
#   VBS_RETRY_DELAY   base seconds for a transient failure (default 60)
#   VBS_RATE_DELAY    base seconds once rate limited (default 60)
#   VBS_BACKOFF_MAX   cap on a single backoff sleep, seconds (default 300)
#   VBS_THROTTLE      seconds between repositories (default 60)
#   VBS_FAIL_STREAK   consecutive failures before a cooldown (default 5)
#   VBS_COOLDOWN      cooldown seconds after that streak (default 60)
# Flags:
#   --manifest FILE   mirror from a vbs-har.sh manifest (no HTTP/auth)
#   --list            print discovered identity + clone URL, do not touch git
#   --only GLOB       mirror only repos whose org/slug/name matches (shell case glob)
#   --throttle N      seconds between repositories (same as VBS_THROTTLE)
#   --retries N       retries per repo (same as VBS_RETRIES)
#   --cooldown N      cooldown seconds (same as VBS_COOLDOWN)
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

VBS_BASE_GIVEN=${VBS_BASE:-}
VBS_BASE=${VBS_BASE:-}
VBS_BASE=${VBS_BASE%/}
VBS_ORG_GIVEN=${VBS_ORG:-}
VBS_ORG=${VBS_ORG:-}
VBS_DEST=${VBS_DEST:-${WORK_MIRRORS:-}}
VBS_TRANSPORT=${VBS_TRANSPORT:-ssh}
VBS_SSH_USER=${VBS_SSH_USER:-}
VBS_HTTP_USER=${VBS_HTTP_USER:-}

# A failed clone must not be dropped: bulk-cloning this tenant earns a rate
# limit, and the fix is to back off, retry, and pace the sweep (docs/d044).
# All are overridable by env or the matching flag.
VBS_RETRIES=${VBS_RETRIES:-10}         # retries per repo (attempts = retries + 1)
VBS_RETRY_DELAY=${VBS_RETRY_DELAY:-60} # base seconds for a transient failure
VBS_RATE_DELAY=${VBS_RATE_DELAY:-60}   # base seconds once rate limited
VBS_BACKOFF_MAX=${VBS_BACKOFF_MAX:-300}
VBS_THROTTLE=${VBS_THROTTLE:-60}       # seconds between repositories
VBS_FAIL_STREAK=${VBS_FAIL_STREAK:-5}  # consecutive failures before a cooldown
VBS_COOLDOWN=${VBS_COOLDOWN:-60}       # cooldown seconds after that streak

# A credential prompt in a non-interactive sweep would hang; fail fast instead.
export GIT_TERMINAL_PROMPT=0

LIST_ONLY=0
ONLY=
MANIFEST=${VBS_MANIFEST:-}

usage() {
	cat <<EOF
usage: $PROG --manifest FILE [--list] [--only GLOB]

Mirrors every repository in the VBS tenant as a bare repo.

Preferred (no secrets):
  # export a HAR capture from the browser, convert it with vbs-har.sh, then
  # mirror from the manifest
  $PROG --manifest vbs-manifest.json

  VBS_BASE=$VBS_BASE
  VBS_ORG=$VBS_ORG
  VBS_DEST=$VBS_DEST
  VBS_TRANSPORT=$VBS_TRANSPORT

Rate limiting:
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
	log_die 1 "no manifest: set VBS_MANIFEST or --manifest FILE"
fi
[ -f "$MANIFEST" ] || log_die 1 "manifest not found" manifest="$MANIFEST"
if [ -z "$VBS_ORG_GIVEN" ]; then
	_morg=$(jq -r '.org // empty' "$MANIFEST" 2>/dev/null || true)
	if [ -n "$_morg" ]; then VBS_ORG=$_morg; fi
fi
if [ -z "$VBS_BASE_GIVEN" ]; then
	_mbase=$(jq -r '.base // empty' "$MANIFEST" 2>/dev/null || true)
	if [ -n "$_mbase" ]; then VBS_BASE=${_mbase%/}; fi
fi
# Without an origin there is nothing to clone; fail loud rather than half-run.
if [ -z "$VBS_BASE" ]; then
	log_die 1 "no tenant origin: set VBS_BASE (or a manifest with a base field)"
fi
# Same policy as the origin: the NTFS profile path was one operator's machine,
# not a default any other host can use.
if [ -z "$VBS_DEST" ]; then
	log_die 1 "no mirror dest: set WORK_MIRRORS or VBS_DEST"
fi
if [ -z "$VBS_ORG" ]; then
	VBS_ORG=$(vbs_host | cut -d. -f1)
fi
if [ "$VBS_TRANSPORT" != ssh ] && [ "$VBS_TRANSPORT" != https ]; then
	log_die 1 "VBS_TRANSPORT must be ssh or https"
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
	log_warn "VBS_SSH_USER is empty — ssh clones may fail; set the idcs-... identity"
fi

# --- JSON extraction --------------------------------------------------------
# The SPA endpoints are undocumented, so the extractor accepts the handful of
# envelope shapes such shapes use (bare array, repositories, or a name-keyed
# object map). Callers who see their own shape can override with the matching
# VBS_MANIFEST_JQ variable rather than editing this file.

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

MANIFEST_JQ=${VBS_MANIFEST_JQ:-$(default_manifest_jq)}

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
	log_die 1 "could not parse manifest (set VBS_MANIFEST_JQ to match your shape)"
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