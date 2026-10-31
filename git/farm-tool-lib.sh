#!/bin/sh
# The FG_* contract is written here and read by farm-tool.sh; shellcheck
# analyzes this lib standalone, so every cross-file assignment looks unused.
# shellcheck disable=SC2034
# farm-tool-lib.sh — the safety posture and shared plumbing behind
# farm-tool.sh: d099's reference-farm tool surface at its POSIX-CLI stage
# (the MCP server is a later wrapper over the same farm-tool.sh entry, so
# nothing here may assume an interactive caller).
#
# Everything d099 makes load-bearing lives HERE, once, so no tool can
# re-decide it:
#
#   - git spawns argv-only under a scrubbed environment: empty HOME,
#     GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL cut every config source except
#     the mirror's own, so no repo config can name a pager/textconv/driver to
#     execute (d099's "the server must be unable to run code named inside the
#     data it searches").
#   - revs/paths/globs are allowlist-validated BEFORE they reach an argv, and
#     every read verb sits behind --end-of-options / --literal-pathspecs —
#     option-shaped payloads are inert by construction.
#   - every output axis carries a cap, and capping is visible (truncated +
#     cursor), never silent (d099's result contract).
#   - repo bytes reach stdout only as JSON-escaped data — never as
#     instructions (d046b's posture; lib/log.sh owns the escaping rule).
#
# Sourced by farm-tool.sh (which sets FG_DIR first), never executed.

# --- caps ------------------------------------------------------------------
# Constants, not environment knobs: d060's rule (a run IS what its argv says)
# and d099's "bounded on every axis" — the MCP layer will surface these as
# tool-schema defaults, not as env state.
FG_DEADLINE=60		# seconds per read-side git call; timeout(1) kills the group
FG_MAX_RESULTS=200	# default matches/refs/paths/commits per response
FG_MAX_BYTES=262144	# bytes of git payload folded into one response
FG_GREP_REPOS=64	# live-grep fan-out bound (d099's rung-1 ladder)
FG_MAX_PATHS=256	# diff pathspec expansion bound
FG_READ_LINES=200	# default read_file chunk, lines

# --- init ------------------------------------------------------------------

# fg_init — scratch HOME + temp dir + farm root. The scratch HOME is the
# load-bearing scrub: it must exist as a directory (git probes it) and must
# be THIS process's, so the EXIT trap can drop it with the run.
fg_init() {
	FG_SCRATCH=$(mktemp -d)
	FG_TMP=$(mktemp -d)
	FG_TIMEOUT_CMD=
	if command -v timeout >/dev/null 2>&1; then
		FG_TIMEOUT_CMD=timeout
	fi
	# Expand now: the dirs must die with THIS pid even when the trap fires
	# from a signal (INT/TERM exit first, then EXIT runs the cleanup).
	# shellcheck disable=SC2064
	trap 'rm -rf "$FG_SCRATCH" "$FG_TMP"' EXIT
	trap 'exit 129' HUP
	trap 'exit 130' INT
	trap 'exit 143' TERM
	FG_ROOT=$(fg_farm_root)
}

# fg_farm_root — the farm this run operates on. It is host state (the same
# fact git-lib.mjs's DEFAULT_ROOT reads as REFERENCES_ROOT), so the env
# override name is shared with the node side; the fallback re-derives the
# xdg-DOWNLOAD + /references path -forge-mirror.sh writes by default.
fg_farm_root() {
	if [ -n "${REFERENCES_ROOT:-}" ]; then
		printf '%s' "$REFERENCES_ROOT"
		return
	fi
	_fg_dir=
	if command -v xdg-user-dir >/dev/null 2>&1; then
		_fg_dir=$(xdg-user-dir DOWNLOAD 2>/dev/null || true)
		case "$_fg_dir" in
		'' | "$HOME") _fg_dir= ;;
		esac
	fi
	[ -n "$_fg_dir" ] || _fg_dir=$HOME/Downloads
	printf '%s/references' "$_fg_dir"
}

# --- the failure envelope --------------------------------------------------

# fg_error EXIT_CODE MESSAGE [key=value ...] — the one failure path: a JSON
# error object on stdout (the payload stream, so a machine caller never has
# to parse logs) plus the same fact as a structured log on stderr (d045), then
# exit. Call this at top level only — never inside $( ) where stdout would be
# captured instead of shown.
fg_error() {
	_fg_code=$1
	shift
	_fg_msg=$1
	shift
	_fg_fields=
	for _fg_kv in "$@"; do
		case "$_fg_kv" in *=*) ;; *) continue ;; esac
		_fg_fields="$_fg_fields,\"${_fg_kv%%=*}\":\"$(log_json_escape "${_fg_kv#*=}")\""
	done
	printf '{"tool":"%s","ok":false,"error":"%s"%s}\n' \
		"$FG_TOOL" "$(log_json_escape "$_fg_msg")" "$_fg_fields"
	# "call", not "tool": log.sh already stamps every line with
	# LOG_TOOL — a second "tool" key would be a duplicate JSON key.
	log_error "$_fg_msg" call="$FG_TOOL" "$@"
	exit "$_fg_code"
}

# --- json ------------------------------------------------------------------

# fg_json_str — JSON string literal (quoted) for arbitrary bytes. C0 control
# chars other than tab/newline are dropped first (a read_file chunk can be
# any binary blob; raw C0 bytes would make the whole payload unparseable),
# then lib/log.sh's one escaping rule is applied.
fg_json_str() {
	_fg_in=$(printf '%s' "$1"; printf x)
	_fg_in=$(printf '%s' "$_fg_in" | tr -d '\000-\010\013-\037')
	_fg_out=$(log_json_escape "$_fg_in")
	# The sentinel x survives both substitutions and the escaping, which is
	# what keeps a payload's trailing newline from vanishing in them.
	printf '"%s"' "${_fg_out%x}"
}

# fg_json_str_or_null — empty string renders as JSON null (an absent url or
# default branch is absent, not ""), keeping callers from inventing "".
fg_json_str_or_null() {
	if [ -n "$1" ]; then
		fg_json_str "$1"
	else
		printf 'null'
	fi
}

# fg_join_json_lines FILE — the file's JSON-object lines as a comma-joined
# array body (no file → empty body).
fg_join_json_lines() {
	awk 'NR > 1 { printf "," } { printf "%s", $0 }' "$1"
}

# fg_bool — shell 0/1 flag as a JSON boolean literal: 0 is false, like the
# truncated flags it renders.
fg_bool() {
	if [ "$1" -eq 0 ]; then
		printf 'false'
	else
		printf 'true'
	fi
}

# --- validation ------------------------------------------------------------

# fg_require_uint VALUE — sets FG_UINT. Non-negative decimal only: these
# become line ranges, -n counts and cursor arithmetic.
fg_require_uint() {
	case "$1" in
	'' | *[!0-9]*)
		fg_error 2 "expected a non-negative integer" value="$1"
		;;
	esac
	FG_UINT=$1
}

# fg_require_repo_id VALUE — farm-relative mirror path, `.git` stripped
# (d099's identifier). Rejections are all "could name something outside one
# mirror": traversal, absolute paths, option-shaped ids — plus glob
# metacharacters, because compact_repo's `--only` glob must select EXACTLY
# this repo (a forge-derived id never carries them anyway).
fg_require_repo_id() {
	case "$1" in
	'' | -* | /* | *..* | *' '* | *\\* | *:*)
		fg_error 2 "invalid repo id" id="$1"
		;;
	esac
	case "$1" in
	*'[' | *']'* | *'*'* | *'?'*)
		fg_error 2 "invalid repo id (glob metacharacter)" id="$1"
		;;
	esac
	FG_REPO_ID=$1
}

# fg_require_rev VALUE — a single tree-ish, allowlisted: no leading `-`
# (the `--upload-pack=` as a rev injection) and no characters outside the
# refspec/SHA alphabet, so nothing option-shaped or shell-shaped survives to
# argv. Composed specs (rev:path) are built only from a validated rev and a
# validated path, so the colon split is unambiguous.
fg_require_rev() {
	case "$1" in
	'' | -* | *[!A-Za-z0-9._/@{}^~-]*)
		fg_error 2 "invalid rev" rev="$1"
		;;
	esac
	FG_REV=$1
}

# fg_require_path VALUE — repo-relative path for read_file: same traversal
# rules as the repo id, plus `:` (it would split a rev:path spec).
fg_require_path() {
	case "$1" in
	'' | -* | /* | *..* | *:*)
		fg_error 2 "invalid path" path="$1"
		;;
	esac
	FG_PATH=$1
}

# fg_require_glob VALUE — shell case-glob for repo/path filters: allowlisted
# so a pattern can never be option-shaped, and `[`/`]` are excluded (they
# would let a caller match MORE than they can see — `*` and `?` are the
# documented operators). Empty is legal and means "no filter" for path globs;
# callers default repo globs to `*` themselves.
fg_require_glob() {
	case "$1" in
	-*)
		fg_error 2 "invalid glob (leading -)" glob="$1"
		;;
	esac
	case "$1" in
	# The space is backslash-escaped: a literal space would split the
	# pattern word before case ever sees it.
	*[!A-Za-z0-9._*?/@+~\ -]*)
		fg_error 2 "invalid glob (allowlist)" glob="$1"
		;;
	esac
	FG_GLOB=$1
}

# fg_require_since VALUE — git --since date text: allowlisted charset, and it
# is always passed as ONE argv already prefixed `--since=` so it can never be
# mistaken for an option.
fg_require_since() {
	case "$1" in
	'' | -* | *[!A-Za-z0-9:._+\ -]*)
		fg_error 2 "invalid since value" since="$1"
		;;
	esac
	FG_SINCE=$1
}

# --- git choke point -------------------------------------------------------

# fg_git ARGV... — the ONLY way read tools spawn git. Argv-only (no shell
# string ever), scrubbed env, `--no-pager` (the caller's PAGER env must not
# page a captured stream), `-c core.fsmonitor=false` (a repo-configured
# fsmonitor hook is an execution primitive), `--literal-pathspecs` (repo
# content must not conjure pathspec magic), and a per-call deadline that
# kills the whole process group — a hung git must not wedge the run.
#
# --end-of-options is added at call sites where operands follow options
# (grep/rev-parse position varies by verb); validators already reject
# `-`-leading operands, so it is belt-and-braces rather than load-bearing.
fg_git() {
	if [ -n "$FG_TIMEOUT_CMD" ]; then
		env "HOME=$FG_SCRATCH" \
			GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
			GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 \
			GIT_PAGER=cat GIT_ASKPASS=/usr/bin/false \
			"$FG_TIMEOUT_CMD" "$FG_DEADLINE" \
			git --no-pager -c core.fsmonitor=false --literal-pathspecs "$@"
	else
		env "HOME=$FG_SCRATCH" \
			GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
			GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 \
			GIT_PAGER=cat GIT_ASKPASS=/usr/bin/false \
			git --no-pager -c core.fsmonitor=false --literal-pathspecs "$@"
	fi
}

# --- farm discovery / resolution -------------------------------------------

# fg_need_farm — the farm root must exist before anything scans it.
fg_need_farm() {
	if [ ! -d "$FG_ROOT" ]; then
		fg_error 3 "farm root not found" root="$FG_ROOT"
	fi
}

# fg_repo_ids — every mirror id in the farm, one per line. Discovery is the
# same structural rule git-lib.mjs owns (a bare mirror: a `*.git` directory
# directly containing HEAD) — sh has no importer to share it with, so the
# rule is restated here and pinned by tests; both walks must agree or
# list_repos and the node-side tools describe different farms.
fg_repo_ids() {
	find "$FG_ROOT" -mindepth 2 -maxdepth 6 -type d -name '*.git' 2>/dev/null |
	while IFS= read -r _fg_d; do
		[ -f "$_fg_d/HEAD" ] || continue
		_fg_rel=${_fg_d#"$FG_ROOT"/}
		printf '%s\n' "${_fg_rel%.git}"
	done
}

# fg_resolve_repo ID — sets FG_REPO_PATH; dies (envelope) when the mirror is
# absent. Global-set, not stdout: validators must never run inside $( ).
fg_resolve_repo() {
	fg_require_repo_id "$1"
	FG_REPO_PATH=$FG_ROOT/$FG_REPO_ID.git
	if [ ! -f "$FG_REPO_PATH/HEAD" ]; then
		fg_error 3 "no such mirror in the farm" repo="$FG_REPO_ID" root="$FG_ROOT"
	fi
}

# fg_resolve_repo_glob [GLOB] — sets FG_REPO_GLOB (default `*`) and fills
# $FG_TMP/ids.txt with the matching ids; sets FG_REPO_COUNT to their number.
# The fan-out count exists so search_code can REFUSE with it (d099) instead
# of attempting a runaway sweep.
fg_resolve_repo_glob() {
	fg_require_glob "${1:-*}"
	FG_REPO_GLOB=$FG_GLOB
	fg_repo_ids | while IFS= read -r _fg_id; do
		# shellcheck disable=SC2254  # the caller's glob IS the pattern
		case "$_fg_id" in
		$FG_REPO_GLOB)
			printf '%s\n' "$_fg_id"
			;;
		esac
	done >"$FG_TMP/ids.txt"
	FG_REPO_COUNT=$(grep -c . "$FG_TMP/ids.txt" 2>/dev/null || true)
	[ -n "$FG_REPO_COUNT" ] || FG_REPO_COUNT=0
	FG_REPO_COUNT=$((FG_REPO_COUNT + 0))
}

# --- capped collection state ----------------------------------------------

# The cursor/cap trio is shared by every listing tool: FG_CURSOR counts down
# the caller's skip, FG_COLLECT counts what may still be appended,
# FG_TRUNCATED flips the moment one more result existed. One model, so every
# response's truncated/cursor pair means the same thing (d099).
fg_begin_collect() {
	# $1 cursor, $2 max
	fg_require_uint "$1"
	FG_CURSOR=$FG_UINT
	fg_require_uint "$2"
	FG_COLLECT=$FG_UINT
	FG_TRUNCATED=0
	: >"$FG_TMP/hits.jsonl"
}

# fg_collect OBJECT — append one pre-escaped JSON object line if the window
# (cursor, max) still allows it; count skipped/tail results for truncation.
fg_collect() {
	# A cursor skip is NOT truncation: the caller chose to pass those
	# results (it knows they exist). Truncated means the window refused
	# something the caller never saw.
	if [ "$FG_CURSOR" -gt 0 ]; then
		FG_CURSOR=$((FG_CURSOR - 1))
		return
	fi
	if [ "$FG_COLLECT" -eq 0 ]; then
		FG_TRUNCATED=1
		return
	fi
	FG_COLLECT=$((FG_COLLECT - 1))
	printf '%s\n' "$1" >>"$FG_TMP/hits.jsonl"
}

# fg_emit_hits TOOL [key=rawjson ...] — the shared success envelope around
# hits.jsonl: the accumulated objects, `total` = how many objects the
# response carries, truncated flag. Extra members are raw JSON fragments
# (`matches=1174` → "matches":1174) so a tool can report facts the window
# cannot (list_repos' full farm count); strings must be pre-quoted by the
# caller.
fg_emit_hits() {
	_fg_tool=$1
	shift
	_fg_extra=
	for _fg_kv in "$@"; do
		_fg_extra="$_fg_extra,\"${_fg_kv%%=*}\":${_fg_kv#*=}"
	done
	_fg_total=$(awk 'END { print NR + 0 }' "$FG_TMP/hits.jsonl")
	printf '{"tool":"%s","ok":true%s,"total":%s,"truncated":%s,"results":[%s]}\n' \
		"$_fg_tool" "$_fg_extra" "$_fg_total" "$(fg_bool "$FG_TRUNCATED")" \
		"$(fg_join_json_lines "$FG_TMP/hits.jsonl")"
}

# --- maintenance status ----------------------------------------------------

# fg_write_status DETAIL — record who holds/queues for the farm mutation
# lock, BESIDE the lock (never inside the farm — a read-only session must
# leave the farm byte-identical, d099's verification). Written by the verb
# before it blocks on flock, so "queued" is visible too.
fg_write_status() {
	_fg_st=$(farm_mutation_lock_path).status
	printf '{"tool":"%s","pid":%s,"started":"%s","detail":"%s"}\n' \
		"$FG_TOOL" "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		"$(log_json_escape "$1")" >"$_fg_st.tmp"
	mv "$_fg_st.tmp" "$_fg_st"
}

# fg_clear_status — the verb finished (any exit path that returns here).
fg_clear_status() {
	rm -f "$(farm_mutation_lock_path).status"
}
