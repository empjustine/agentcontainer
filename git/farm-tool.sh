#!/bin/sh
# farm-tool.sh — d099's reference-farm tool surface as a POSIX CLI:
# positional argv, one JSON object on stdout (the payload stream), structured
# logs on stderr (d045), nothing interpolated into a shell string anywhere.
#
# This is the MCP tool surface at its CLI stage: the later stdio MCP server
# wraps THIS entry point verbatim (same argv shape, same envelopes), so the
# safety posture never forks into two implementations. Read tools are
# capped-by-construction and cannot mutate (GIT_OPTIONAL_LOCKS=0 plus a
# scrubbed env, git/farm-tool-lib.sh); the two maintenance verbs wrap the
# existing operator scripts under the farm-wide mutation lock.
#
# Exit codes: 0 ok · 1 tool failed (child error, unknown rev/path) ·
# 2 usage/argv error · 3 not found (repo/rev/path/farm) · 4 refused
# (fan-out bound) · 5 git failed/timed out.
set -eu

LOG_STREAM=stderr
LOG_TOOL='git/farm-tool'
# The script's own directory: the sourced libs AND the maintenance children
# (maintain.sh, -forge-mirror.sh) are found relative to it, never relative
# to the caller's cwd.
FG_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=../lib/log.sh
. "$FG_DIR/../lib/log.sh"
# shellcheck source-path=SCRIPTDIR source=farm-lock.sh
. "$FG_DIR/farm-lock.sh"
# shellcheck source-path=SCRIPTDIR source=farm-tool-lib.sh
. "$FG_DIR/farm-tool-lib.sh"

# --- read tools ------------------------------------------------------------

# list_repos [FILTER] [CURSOR] [MAX]
# The farm as d099 needs it: bare mirrors with the urls the farm itself
# records, ref counts and default branch for orientation. `matches` is the
# FULL count of mirrors whose id matches FILTER — it stays honest even when
# the window truncates, so a caller can page the whole farm.
tool_list_repos() {
	if [ $# -gt 3 ]; then
		fg_error 2 "usage: list_repos [FILTER] [CURSOR] [MAX]"
	fi
	fg_need_farm
	fg_resolve_repo_glob "${1:-*}"
	fg_begin_collect "${2:-0}" "${3:-$FG_MAX_RESULTS}"
	while IFS= read -r _id; do
		fg_resolve_repo "$_id"
		if _url=$(fg_git -C "$FG_REPO_PATH" config --get remote.origin.url 2>/dev/null); then :; else _url=; fi
		if _branch=$(fg_git -C "$FG_REPO_PATH" symbolic-ref -q --short HEAD 2>/dev/null); then :; else _branch=; fi
		_refs=$(fg_git -C "$FG_REPO_PATH" for-each-ref --format=x 2>/dev/null | wc -l)
		_refs=$((_refs + 0))
		_obj=$(printf '{"id":%s,"url":%s,"default_branch":%s,"ref_count":%s}' \
			"$(fg_json_str "$_id")" "$(fg_json_str_or_null "$_url")" \
			"$(fg_json_str_or_null "$_branch")" "$_refs")
		fg_collect "$_obj"
	done <"$FG_TMP/ids.txt"
	fg_emit_hits list_repos "matches=$FG_REPO_COUNT"
}

# list_refs REPO [CURSOR] [MAX]
tool_list_refs() {
	if [ $# -lt 1 ] || [ $# -gt 3 ]; then
		fg_error 2 "usage: list_refs REPO [CURSOR] [MAX]"
	fi
	fg_need_farm
	fg_resolve_repo "$1"
	fg_begin_collect "${2:-0}" "${3:-$FG_MAX_RESULTS}"
	# A literal 0x1f between fields (git for-each-ref does NOT expand the
	# %x1f escape that git log expands — verified on git 2.47), and it is
	# safe as data because git ref names may not contain control chars.
	_us=$(printf '\037')
	if fg_git -C "$FG_REPO_PATH" for-each-ref \
		--format="%(refname)$_us%(objectname)" >"$FG_TMP/refs.txt" 2>"$FG_TMP/err"; then :; else
		fg_error 5 "git for-each-ref failed" repo="$FG_REPO_ID" \
			detail="$(tail -n 1 "$FG_TMP/err" 2>/dev/null || true)"
	fi
	while IFS= read -r _line; do
		[ -n "$_line" ] || continue
		_ref=${_line%%"$_us"*}
		_sha=${_line#*"$_us"}
		case "$_ref" in
		refs/heads/*) _type=branch ;;
		refs/tags/*) _type=tag ;;
		refs/remotes/*) _type=remote ;;
		*) _type=other ;;
		esac
		fg_collect "$(printf '{"ref":%s,"type":%s,"sha":%s}' \
			"$(fg_json_str "$_ref")" "$(fg_json_str "$_type")" "$(fg_json_str "$_sha")")"
	done <"$FG_TMP/refs.txt"
	fg_emit_hits list_refs
}

# search_code QUERY [REPO_GLOB] [PATH_GLOB] [MODE] [MAX] [CURSOR] [WIDE]
# d099's rung-1 search: live `git grep` over a bounded repo fan-out, hits
# pinned to the commit that was actually searched. MODE is fixed (default,
# `-F`) or regex; PATH_GLOB is a shell glob applied to paths AFTER grep
# matched (it can never reach an argv as a pattern). WIDE=1 opts in past the
# fan-out bound — farm-wide scope still needs the Zoekt index (d043), this
# only refuses less often.
tool_search_code() {
	if [ $# -lt 1 ] || [ $# -gt 7 ]; then
		fg_error 2 "usage: search_code QUERY [REPO_GLOB] [PATH_GLOB] [MODE] [MAX] [CURSOR] [WIDE]"
	fi
	fg_need_farm
	_query=$1
	[ -n "$_query" ] || fg_error 2 "empty query"
	fg_resolve_repo_glob "${2:-*}"
	fg_require_glob "${3:-}"
	_pglob=$FG_GLOB
	_mode=${4:-fixed}
	case "$_mode" in
	fixed | regex) ;;
	*) fg_error 2 "MODE must be fixed or regex" mode="$_mode" ;;
	esac
	_wide=${7:-0}
	case "$_wide" in
	0 | 1) ;;
	*) fg_error 2 "WIDE must be 0 or 1" wide="$_wide" ;;
	esac
	if [ "$FG_REPO_COUNT" -gt "$FG_GREP_REPOS" ] && [ "$_wide" != 1 ]; then
		fg_error 4 "live-grep fan-out exceeded — narrow the repo filter, or pass WIDE=1 to attempt it" \
			repos="$FG_REPO_COUNT" bound="$FG_GREP_REPOS"
	fi
	fg_begin_collect "${6:-0}" "${5:-$FG_MAX_RESULTS}"
	while IFS= read -r _id; do
		fg_resolve_repo "$_id"
		if _sha=$(fg_git -C "$FG_REPO_PATH" rev-parse --verify --end-of-options HEAD 2>/dev/null); then :; else
			log_warn "unreadable HEAD — skipped" repo="$_id"
			continue
		fi
		# -I: binary files are not matched (a "Binary file … matches" line
		# is not path:line:text and would corrupt the parsed stream).
		_grep_rc=0
		if [ "$_mode" = fixed ]; then
			fg_git -C "$FG_REPO_PATH" grep -I -n --no-color -F -e "$_query" --end-of-options "$_sha" \
				>"$FG_TMP/grep.txt" 2>"$FG_TMP/err" || _grep_rc=$?
		else
			fg_git -C "$FG_REPO_PATH" grep -I -n --no-color -e "$_query" --end-of-options "$_sha" \
				>"$FG_TMP/grep.txt" 2>"$FG_TMP/err" || _grep_rc=$?
		fi
		case "$_grep_rc" in
		0) ;;
		1) continue ;; # no match is not a failure
		124) fg_error 5 "git grep timed out" repo="$_id" ;;
		*) fg_error 5 "git grep failed" repo="$_id" rc="$_grep_rc" \
			detail="$(tail -n 1 "$FG_TMP/err" 2>/dev/null || true)" ;;
		esac
		while IFS= read -r _line; do
			[ -n "$_line" ] || continue
			# git grep prefixes every match with the tree-ish it
			# searched (rev:path:line:text) — here the pinned sha we
			# already report as commit_sha, so it comes off the front.
			case "$_line" in
			"$_sha:"*) _line=${_line#"$_sha:"} ;;
			esac
			_path=${_line%%:*}
			_rest=${_line#*:}
			_lnum=${_rest%%:*}
			_text=${_rest#*:}
			if [ -n "$_pglob" ]; then
				# shellcheck disable=SC2254  # the caller's glob IS the pattern
				case "$_path" in
				$_pglob) ;;
				*) continue ;;
				esac
			fi
			fg_collect "$(printf '{"repo":%s,"commit_sha":%s,"path":%s,"line":%s,"text":%s}' \
				"$(fg_json_str "$_id")" "$(fg_json_str "$_sha")" "$(fg_json_str "$_path")" \
				"$((_lnum + 0))" "$(fg_json_str "$_text")")"
		done <"$FG_TMP/grep.txt"
		if [ "$FG_COLLECT" -eq 0 ] && [ "$FG_TRUNCATED" -eq 1 ]; then
			break
		fi
	done <"$FG_TMP/ids.txt"
	fg_emit_hits search_code "repos_matched=$FG_REPO_COUNT"
}

# search_paths PATH_GLOB [REPO_GLOB] [CURSOR] [MAX]
# Which files exist by name: `git ls-tree -r` names, glob-filtered in shell
# — the glob never reaches git as a pathspec, so no magic prefixes and no
# traversal (d099's path rule). commit_sha pins each row to the HEAD that
# was walked.
tool_search_paths() {
	if [ $# -lt 1 ] || [ $# -gt 4 ]; then
		fg_error 2 "usage: search_paths PATH_GLOB [REPO_GLOB] [CURSOR] [MAX]"
	fi
	fg_need_farm
	fg_require_glob "$1"
	_pglob=$FG_GLOB
	[ -n "$_pglob" ] || fg_error 2 "empty path glob"
	fg_resolve_repo_glob "${2:-*}"
	fg_begin_collect "${3:-0}" "${4:-$FG_MAX_RESULTS}"
	while IFS= read -r _id; do
		fg_resolve_repo "$_id"
		if _sha=$(fg_git -C "$FG_REPO_PATH" rev-parse --verify --end-of-options HEAD 2>/dev/null); then :; else
			log_warn "unreadable HEAD — skipped" repo="$_id"
			continue
		fi
		# core.quotepath=false keeps non-ASCII names raw so the glob sees
		# real bytes instead of "quoted" escapes.
		if ! fg_git -c core.quotepath=false -C "$FG_REPO_PATH" ls-tree -r --name-only \
			--end-of-options HEAD >"$FG_TMP/tree.txt" 2>/dev/null; then
			log_warn "ls-tree failed — skipped" repo="$_id"
			continue
		fi
		while IFS= read -r _p; do
			[ -n "$_p" ] || continue
			# shellcheck disable=SC2254  # the caller's glob IS the pattern
			case "$_p" in
			$_pglob) ;;
			*) continue ;;
			esac
			fg_collect "$(printf '{"repo":%s,"commit_sha":%s,"path":%s}' \
				"$(fg_json_str "$_id")" "$(fg_json_str "$_sha")" "$(fg_json_str "$_p")")"
		done <"$FG_TMP/tree.txt"
		if [ "$FG_COLLECT" -eq 0 ] && [ "$FG_TRUNCATED" -eq 1 ]; then
			break
		fi
	done <"$FG_TMP/ids.txt"
	fg_emit_hits search_paths "repos_matched=$FG_REPO_COUNT"
}

# read_file REPO REV PATH [OFFSET] [LIMIT]
# Chunked, capped blob read against a PINNED commit (d099: a read never
# moves under the consumer — HEAD drift cannot re-page the file). OFFSET is
# 1-based, LIMIT is lines; both are also byte-capped, and truncated is set
# when the window or the byte cap cut the blob short.
tool_read_file() {
	if [ $# -lt 3 ] || [ $# -gt 5 ]; then
		fg_error 2 "usage: read_file REPO REV PATH [OFFSET] [LIMIT]"
	fi
	fg_need_farm
	fg_resolve_repo "$1"
	fg_require_rev "$2"
	_rev=$FG_REV
	fg_require_path "$3"
	_path=$FG_PATH
	fg_require_uint "${4:-1}"
	_off=$FG_UINT
	if [ "$_off" -lt 1 ]; then
		fg_error 2 "OFFSET is 1-based" offset="$_off"
	fi
	fg_require_uint "${5:-$FG_READ_LINES}"
	_limit=$FG_UINT
	if [ "$_limit" -lt 1 ]; then
		fg_error 2 "LIMIT must be at least 1" limit="$_limit"
	fi
	if _csha=$(fg_git -C "$FG_REPO_PATH" rev-parse --verify --end-of-options "$_rev" 2>/dev/null); then :; else
		fg_error 3 "unknown rev" rev="$_rev" repo="$FG_REPO_ID"
	fi
	# The rev:path split is unambiguous because both halves were
	# allowlist-validated: the rev side carries no colon, the path carries
	# no colon and cannot be option-shaped.
	if _blob=$(fg_git -C "$FG_REPO_PATH" rev-parse --verify --end-of-options "$_csha:$_path" 2>/dev/null); then :; else
		fg_error 3 "no such path at rev" repo="$FG_REPO_ID" rev="$_rev" path="$_path"
	fi
	_type=$(fg_git -C "$FG_REPO_PATH" cat-file -t "$_blob" 2>/dev/null || printf 'unknown')
	if [ "$_type" != blob ]; then
		fg_error 3 "not a blob" repo="$FG_REPO_ID" path="$_path" type="$_type"
	fi
	_end=$((_off + _limit - 1))
	# The sentinel x keeps the capture's trailing newline intact through
	# $() — a file chunk must round-trip byte-exactly inside its JSON string.
	_content=$(fg_git -C "$FG_REPO_PATH" cat-file blob "$_blob" |
		sed -n "${_off},${_end}p" | head -c "$FG_MAX_BYTES"; printf x)
	_content=${_content%x}
	_trunc=0
	if [ "$(printf '%s' "$_content" | wc -c)" -ge "$FG_MAX_BYTES" ]; then
		_trunc=1
	elif [ -n "$(fg_git -C "$FG_REPO_PATH" cat-file blob "$_blob" | sed -n "$((_end + 1))p" | head -c 1)" ]; then
		_trunc=1
	fi
	printf '{"tool":"read_file","ok":true,"repo":%s,"commit_sha":%s,"path":%s,"offset":%s,"limit":%s,"truncated":%s,"content":%s}\n' \
		"$(fg_json_str "$FG_REPO_ID")" "$(fg_json_str "$_csha")" "$(fg_json_str "$_path")" \
		"$_off" "$_limit" "$(fg_bool "$_trunc")" "$(fg_json_str "$_content")"
}

# _hist_flush — emit the commit record tool_search_history accumulated once
# its changed paths passed the glob filter. Global state, no locals (POSIX
# sh): the parse loop and this helper deliberately share the _in_* variables.
_hist_flush() {
	[ -n "$_in_sha" ] || return 0
	[ "$_match" -eq 1 ] || return 0
	fg_collect "$(printf '{"repo":%s,"commit_sha":%s,"date":%s,"subject":%s}' \
		"$(fg_json_str "$_hist_id")" "$(fg_json_str "$_in_sha")" \
		"$(fg_json_str "$_in_date")" "$(fg_json_str "$_in_subj")")"
}

# search_history QUERY [REPO_GLOB] [PATH_GLOB] [SINCE] [CURSOR] [MAX]
# d099's phase 3 (the only search whose engine is native git, not Zoekt):
# literal pickaxe (-S) across commits, with an optional changed-paths glob
# and a date floor. The log stream is record-separated (%x1e) with
# field-separated (%x1f) header data so subjects and paths are never split
# on a character they may contain.
tool_search_history() {
	if [ $# -lt 1 ] || [ $# -gt 6 ]; then
		fg_error 2 "usage: search_history QUERY [REPO_GLOB] [PATH_GLOB] [SINCE] [CURSOR] [MAX]"
	fi
	fg_need_farm
	_query=$1
	[ -n "$_query" ] || fg_error 2 "empty query"
	fg_resolve_repo_glob "${2:-*}"
	fg_require_glob "${3:-}"
	_pglob=$FG_GLOB
	_since=${4:-}
	if [ -n "$_since" ]; then
		fg_require_since "$_since"
		_since=$FG_SINCE
	fi
	fg_begin_collect "${5:-0}" "${6:-$FG_MAX_RESULTS}"
	# One past the window: a commit beyond the cap is exactly what
	# "truncated" means, so the walk asks for just enough to prove it.
	_w=$((FG_CURSOR + FG_COLLECT + 1))
	_rs=$(printf '\036')
	_us=$(printf '\037')
	while IFS= read -r _id; do
		fg_resolve_repo "$_id"
		_hist_id=$_id
		if _sha=$(fg_git -C "$FG_REPO_PATH" rev-parse --verify --end-of-options HEAD 2>/dev/null); then :; else
			log_warn "unreadable HEAD — skipped" repo="$_id"
			continue
		fi
		_hist_rc=0
		if [ -n "$_since" ]; then
			fg_git -C "$FG_REPO_PATH" log --max-count="$_w" --format='%x1e%H%x1f%aI%x1f%s' --name-only \
				"-S$_query" "--since=$_since" --end-of-options HEAD >"$FG_TMP/hist.txt" 2>"$FG_TMP/err" || _hist_rc=$?
		else
			fg_git -C "$FG_REPO_PATH" log --max-count="$_w" --format='%x1e%H%x1f%aI%x1f%s' --name-only \
				"-S$_query" --end-of-options HEAD >"$FG_TMP/hist.txt" 2>"$FG_TMP/err" || _hist_rc=$?
		fi
		case "$_hist_rc" in
		0) ;;
		124) fg_error 5 "git log timed out" repo="$_id" ;;
		*) fg_error 5 "git log failed" repo="$_id" rc="$_hist_rc" \
			detail="$(tail -n 1 "$FG_TMP/err" 2>/dev/null || true)" ;;
		esac
		_in_sha=
		_in_date=
		_in_subj=
		_match=0
		while IFS= read -r _l; do
			case "$_l" in
			"$_rs"*)
				# A record boundary flushes the previous commit; the
				# line carries its header fields after the marker.
				_hist_flush
				_l=${_l#"$_rs"}
				_in_sha=${_l%%"$_us"*}
				_rest=${_l#*"$_us"}
				_in_date=${_rest%%"$_us"*}
				_in_subj=${_rest#*"$_us"}
				if [ -n "$_pglob" ]; then
					_match=0
				else
					_match=1
				fi
				;;
			*)
				# Every other line is a changed path of the open record.
				if [ -n "$_pglob" ] && [ -n "$_l" ]; then
					# shellcheck disable=SC2254  # the caller's glob IS the pattern
					case "$_l" in
					$_pglob) _match=1 ;;
					esac
				fi
				;;
			esac
			if [ "$FG_COLLECT" -eq 0 ] && [ "$FG_TRUNCATED" -eq 1 ]; then
				break
			fi
		done <"$FG_TMP/hist.txt"
		_hist_flush
		if [ "$FG_COLLECT" -eq 0 ] && [ "$FG_TRUNCATED" -eq 1 ]; then
			break
		fi
	done <"$FG_TMP/ids.txt"
	fg_emit_hits search_history "repos_matched=$FG_REPO_COUNT"
}

# diff REPO REV_A REV_B [PATH] [MAX]
# Unified patch between two pins, byte-capped with visible truncation. PATH
# is a shell glob that is expanded AGAINST THE DIFF'S OWN NAME LIST, and the
# matching names go back to git as literal pathspecs — the glob itself never
# reaches an argv, and an unmatched glob yields an EMPTY patch rather than
# the whole repo (the keep-all trap, tests/git-glob.test.mjs).
tool_diff() {
	if [ $# -lt 3 ] || [ $# -gt 5 ]; then
		fg_error 2 "usage: diff REPO REV_A REV_B [PATH] [MAX]"
	fi
	fg_need_farm
	fg_resolve_repo "$1"
	fg_require_rev "$2"
	_ra=$FG_REV
	fg_require_rev "$3"
	_rb=$FG_REV
	_path=${4:-}
	if [ -n "$_path" ]; then
		fg_require_glob "$_path"
		_path=$FG_GLOB
	fi
	fg_require_uint "${5:-$FG_MAX_BYTES}"
	_cap=$FG_UINT
	if [ "$_cap" -gt "$FG_MAX_BYTES" ]; then
		fg_error 2 "MAX may not exceed the server cap" cap="$_cap" server_cap="$FG_MAX_BYTES"
	fi
	if _sha_a=$(fg_git -C "$FG_REPO_PATH" rev-parse --verify --end-of-options "$_ra" 2>/dev/null); then :; else
		fg_error 3 "unknown rev" rev="$_ra" repo="$FG_REPO_ID"
	fi
	if _sha_b=$(fg_git -C "$FG_REPO_PATH" rev-parse --verify --end-of-options "$_rb" 2>/dev/null); then :; else
		fg_error 3 "unknown rev" rev="$_rb" repo="$FG_REPO_ID"
	fi
	# The positional args are consumed, so the remainder of set -- becomes
	# the pathspec argv — one entry per line, spaces intact (never word
	# split, never expanded).
	set --
	if [ -n "$_path" ]; then
		if ! fg_git -C "$FG_REPO_PATH" diff --name-only --no-color "$_sha_a" "$_sha_b" \
			>"$FG_TMP/changed.txt" 2>/dev/null; then
			fg_error 5 "git diff --name-only failed" repo="$FG_REPO_ID"
		fi
		: >"$FG_TMP/specs.txt"
		while IFS= read -r _p; do
			[ -n "$_p" ] || continue
			# shellcheck disable=SC2254  # the caller's glob IS the pattern
			case "$_p" in
			$_path)
				printf '%s\n' "$_p" >>"$FG_TMP/specs.txt"
				;;
			esac
		done <"$FG_TMP/changed.txt"
		_nspec=$(grep -c . "$FG_TMP/specs.txt" 2>/dev/null || true)
		[ -n "$_nspec" ] || _nspec=0
		_nspec=$((_nspec + 0))
		if [ "$_nspec" -gt "$FG_MAX_PATHS" ]; then
			fg_error 4 "diff path glob expands past the bound — narrow it" \
				paths="$_nspec" bound="$FG_MAX_PATHS"
		fi
		if [ "$_nspec" -eq 0 ]; then
			# Zero pathspecs after `--` means NO restriction — an
			# unmatched glob must be an empty patch, never the repo.
			printf '{"tool":"diff","ok":true,"repo":%s,"commit_sha_a":%s,"commit_sha_b":%s,"truncated":false,"patch":""}\n' \
				"$(fg_json_str "$FG_REPO_ID")" "$(fg_json_str "$_sha_a")" "$(fg_json_str "$_sha_b")"
			return 0
		fi
		while IFS= read -r _p; do
			set -- "$@" "$_p"
		done <"$FG_TMP/specs.txt"
	fi
	# One past the cap, not the cap: a diff of exactly cap bytes is not
	# truncated, a bigger one is — the sentinel keeps the count exact
	# through command substitution.
	_raw=$(fg_git -C "$FG_REPO_PATH" diff --no-ext-diff --no-textconv --no-color \
		"$_sha_a" "$_sha_b" -- "$@" | head -c "$((_cap + 1))"; printf x)
	_raw=${_raw%x}
	_size=$(printf '%s' "$_raw" | wc -c)
	_trunc=0
	if [ "$_size" -gt "$_cap" ]; then
		_trunc=1
		_patch=$(printf '%s' "$_raw" | head -c "$_cap"; printf x)
		_patch=${_patch%x}
	else
		_patch=$_raw
	fi
	printf '{"tool":"diff","ok":true,"repo":%s,"commit_sha_a":%s,"commit_sha_b":%s,"truncated":%s,"patch":%s}\n' \
		"$(fg_json_str "$FG_REPO_ID")" "$(fg_json_str "$_sha_a")" "$(fg_json_str "$_sha_b")" \
		"$(fg_bool "$_trunc")" "$(fg_json_str "$_patch")"
}

# --- maintenance tools -----------------------------------------------------

# upsert_repo URL
# d099's write tool: a bare mirror of URL under the farm. The wrapper is the
# thin part BY DESIGN — forge-mirror.mjs owns URL validation (the safety
# boundary, docs/d099's decision to reuse it rather than fork it) and the
# acquisition script owns the flock. Human-readable child output flows to
# stderr; stdout stays a single JSON object. Serialized with the other
# verbs: farm-lock.sh's mutex is shared by this shim, maintain.sh and
# -forge-mirror.sh.
tool_upsert_repo() {
	if [ $# -ne 1 ]; then
		fg_error 2 "usage: upsert_repo URL"
	fi
	_url=$1
	[ -n "$_url" ] || fg_error 2 "empty url"
	# Option-shaped argv is rejected HERE: a bare `-h` would make the child
	# print help and exit 0, which would read as success. URL SHAPE stays
	# forge-mirror.mjs's rule — one validator, not two.
	case "$_url" in
	-*) fg_error 2 "invalid url (leading -)" url="$_url" ;;
	esac
	fg_write_status "upsert_repo $_url"
	if "$FG_DIR/-forge-mirror.sh" "$_url" >&2; then
		_child=0
	else
		_child=$?
	fi
	fg_clear_status
	if [ "$_child" -ne 0 ]; then
		fg_error 1 "acquisition failed (see the stderr log)" url="$_url" child_exit="$_child"
	fi
	printf '{"tool":"upsert_repo","ok":true,"url":%s}\n' "$(fg_json_str "$_url")"
}

# compact_repo REPO [MODE=optimize|deep]
# d099's second verb: the same maintain-mirrors.mjs the operator cron runs,
# narrowed to one repo by --only and pinned to a single mutation at a time
# via the farm lock. --no-fetch keeps compaction pure housekeeping — the
# verb may never pull new data (that is upsert_repo's job).
tool_compact_repo() {
	if [ $# -lt 1 ] || [ $# -gt 2 ]; then
		fg_error 2 "usage: compact_repo REPO [MODE=optimize|deep]"
	fi
	fg_need_farm
	fg_resolve_repo "$1"
	_mode=${2:-optimize}
	case "$_mode" in
	optimize) _deep= ;;
	deep) _deep=1 ;;
	*) fg_error 2 "MODE must be optimize or deep" mode="$_mode" ;;
	esac
	fg_write_status "compact_repo $FG_REPO_ID mode=$_mode"
	if [ -n "$_deep" ]; then
		if "$FG_DIR/maintain.sh" --root "$FG_ROOT" --only "$FG_REPO_ID.git" --no-fetch --deep-optimize >&2; then
			_child=0
		else
			_child=$?
		fi
	else
		if "$FG_DIR/maintain.sh" --root "$FG_ROOT" --only "$FG_REPO_ID.git" --no-fetch >&2; then
			_child=0
		else
			_child=$?
		fi
	fi
	fg_clear_status
	if [ "$_child" -ne 0 ]; then
		fg_error 1 "compaction failed (see the stderr log)" repo="$FG_REPO_ID" child_exit="$_child"
	fi
	printf '{"tool":"compact_repo","ok":true,"repo":%s,"mode":%s}\n' \
		"$(fg_json_str "$FG_REPO_ID")" "$(fg_json_str "$_mode")"
}

# maintenance_status
# What holds the mutation mutex and since when (d099). The probe is the
# TRUTH — it asks flock directly instead of trusting a file's existence —
# and the status file beside the lock is only the holder's own description
# (written by whoever queued; deliberately OUTSIDE the farm so reads stay
# byte-identical).
tool_maintenance_status() {
	if [ $# -ne 0 ]; then
		fg_error 2 "usage: maintenance_status"
	fi
	_lock=$(farm_mutation_lock_path)
	_lockjson=null
	_holderjson=null
	if command -v flock >/dev/null 2>&1; then
		if flock -n "$_lock" true; then
			_lockjson=false
		else
			_lockjson=true
		fi
	else
		# Without flock(1) there is no mutex — unknown is more honest
		# than inferring one from a file's existence.
		log_warn "flock missing — lock state unknown"
	fi
	if [ "$_lockjson" = true ] && [ -f "$_lock.status" ]; then
		# The status file is written by this tool family, so sed is
		# enough — a read query must not grow a jq dependency.
		_h_tool=$(sed -n 's/.*"tool":"\([^"]*\)".*/\1/p' "$_lock.status" | head -n 1)
		_h_pid=$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$_lock.status" | head -n 1)
		_h_started=$(sed -n 's/.*"started":"\([^"]*\)".*/\1/p' "$_lock.status" | head -n 1)
		_h_detail=$(sed -n 's/.*"detail":"\([^"]*\)".*/\1/p' "$_lock.status" | head -n 1)
		[ -n "$_h_pid" ] || _h_pid=null
		_holderjson=$(printf '{"tool":%s,"pid":%s,"started":%s,"detail":%s}' \
			"$(fg_json_str_or_null "$_h_tool")" "$_h_pid" \
			"$(fg_json_str_or_null "$_h_started")" "$(fg_json_str_or_null "$_h_detail")")
	fi
	printf '{"tool":"maintenance_status","ok":true,"lock_path":%s,"locked":%s,"holder":%s}\n' \
		"$(fg_json_str "$_lock")" "$_lockjson" "$_holderjson"
}

# --- dispatch --------------------------------------------------------------

fg_usage() {
	cat <<EOF
usage: ./git/farm-tool.sh TOOL [ARGS...]

d099's reference-farm tool surface as a POSIX CLI: positional argv, one
JSON object on stdout, structured logs on stderr. The later stdio MCP
server wraps this same entry verbatim, so the safety posture lives in one
place (git/farm-tool-lib.sh).

read tools (capped, read-only by construction):
  list_repos     [FILTER] [CURSOR] [MAX]
  list_refs      REPO [CURSOR] [MAX]
  search_code    QUERY [REPO_GLOB] [PATH_GLOB] [MODE] [MAX] [CURSOR] [WIDE]
  search_paths   PATH_GLOB [REPO_GLOB] [CURSOR] [MAX]
  read_file      REPO REV PATH [OFFSET] [LIMIT]
  search_history QUERY [REPO_GLOB] [PATH_GLOB] [SINCE] [CURSOR] [MAX]
  diff           REPO REV_A REV_B [PATH] [MAX]

maintenance tools (farm-wide mutation lock, git/farm-lock.sh):
  upsert_repo        URL
  compact_repo       REPO [MODE=optimize|deep]
  maintenance_status

MODE is fixed (default) or regex; globs are shell case-globs (* and ? only);
REPO ids are farm-relative mirror paths with .git stripped (see list_repos).
exit: 0 ok · 1 tool failed · 2 usage · 3 not found · 4 refused · 5 git failed
EOF
}

if [ $# -eq 0 ]; then
	fg_usage >&2
	exit 2
fi
FG_TOOL=$1
shift
case "$FG_TOOL" in
-h | --help | help)
	fg_usage
	exit 0
	;;
esac
fg_init
case "$FG_TOOL" in
list_repos) tool_list_repos "$@" ;;
list_refs) tool_list_refs "$@" ;;
search_code) tool_search_code "$@" ;;
search_paths) tool_search_paths "$@" ;;
read_file) tool_read_file "$@" ;;
search_history) tool_search_history "$@" ;;
diff) tool_diff "$@" ;;
upsert_repo) tool_upsert_repo "$@" ;;
compact_repo) tool_compact_repo "$@" ;;
maintenance_status) tool_maintenance_status "$@" ;;
*) fg_error 2 "unknown tool (try --help)" name="$FG_TOOL" ;;
esac
