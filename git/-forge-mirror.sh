#!/bin/sh
# -forge-mirror.sh — acquire any HTTPS git-forge repo into the reference farm
# as a BARE MIRROR, the shape the farm now uses everywhere
# (git/non-bare-issues.md). The leading `-` matches its non-bare sibling
# -github-clone.sh so the two hand-run acquisition scripts sort together.
#
# Forge-agnostic on purpose: GitHub is not the only reference source, so the
# on-disk layout is keyed by HOST rather than a hardcoded `github.com`, and the
# whole path after the host is preserved as directories. That covers every
# common forge path model:
#
#   https://github.com/owner/repo.git       -> github.com/owner/repo.git
#   https://codeberg.org/q3k/crowbar.git    -> codeberg.org/q3k/crowbar.git
#   https://git.sr.ht/~whynothugo/pimsync   -> git.sr.ht/~whynothugo/pimsync.git
#   https://gitlab.com/group/sub/repo.git   -> gitlab.com/group/sub/repo.git
#
# The trailing `.git` is OPTIONAL: it is normalized away before the local name
# is built, so a forge that spells it and one that does not land in the same
# directory. Only https is accepted — the transport the task named, and an
# unauthenticated plain-http clone of reference material is not worth the
# downgrade.
#
# This script only acquires. Pickaxe optimization stays with
# git/maintain-mirrors.mjs (`./git/maintain.sh`), and search indexing is opt-in
# (`./git/search-references.sh index --only …`, docs/d043).

set -eu

# --- Resolve downloads directory ---

get_downloads_dir() {
	_dir=""

	if command -v xdg-user-dir >/dev/null 2>&1; then
		_dir="$(xdg-user-dir DOWNLOAD)"

		if [ "$_dir" = "$HOME" ] || [ -z "$_dir" ]; then
			printf 'Warning: xdg-user-dir DOWNLOAD is not configured, falling back to default.\n' >&2
			_dir=""
		elif [ ! -d "$_dir" ]; then
			printf 'Warning: xdg-user-dir DOWNLOAD path does not exist: %s, falling back to default.\n' "$_dir" >&2
			_dir=""
		elif [ ! -w "$_dir" ]; then
			printf 'Warning: xdg-user-dir DOWNLOAD path is not writable: %s, falling back to default.\n' "$_dir" >&2
			_dir=""
		fi
	else
		printf 'Warning: xdg-user-dir is not available, falling back to default.\n' >&2
	fi

	if [ -z "$_dir" ]; then
		_dir="${HOME}/Downloads"
		if [ ! -d "$_dir" ]; then
			printf 'Error: fallback downloads directory does not exist: %s\n' "$_dir" >&2
			return 1
		fi
		if [ ! -w "$_dir" ]; then
			printf 'Error: fallback downloads directory is not writable: %s\n' "$_dir" >&2
			return 1
		fi
	fi

	printf '%s' "$_dir"
}

# --- Main ---

if [ "$#" -eq 0 ]; then
	printf 'Usage: %s <https_git_url> [<https_git_url> ...]\n' "$0" >&2
	printf '  e.g. https://codeberg.org/q3k/crowbar.git\n' >&2
	printf '       https://git.sr.ht/~whynothugo/pimsync\n' >&2
	exit 1
fi

downloads_dir="$(get_downloads_dir)"

# --- Cleanup trap ---

current_mirror_dir=""

# shellcheck disable=SC2329  # invoked indirectly via the trap below
cleanup() {
	if [ -n "$current_mirror_dir" ] && [ -d "$current_mirror_dir" ]; then
		printf 'Cleaning up partial mirror: %s\n' "$current_mirror_dir" >&2
		rm -rf "$current_mirror_dir"
	fi
}

trap cleanup INT TERM EXIT

# --- Mirror loop ---

overall_exit=0

for url in "$@"; do
	case "$url" in
		https://*) ;;
		*)
			printf 'Error: only https forge URLs are accepted: %s\n' "$url" >&2
			overall_exit=1
			continue
			;;
	esac

	# Split off the scheme, then the host (to the first slash). A URL with no
	# slash after the host repeats the host in `path`, which the shape check
	# below rejects.
	rest="${url#https://}"
	host="${rest%%/*}"
	path="${rest#*/}"
	host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"

	# Normalize the path: strip trailing slashes, then one trailing `.git`.
	# (A repository genuinely named `foo.git` is indistinguishable here; that
	# ambiguity is inherent to forges making the suffix optional.)
	while [ "${path%/}" != "$path" ]; do
		path="${path%/}"
	done
	path="${path%.git}"

	if [ -z "$host" ] || [ "$path" = "$rest" ]; then
		printf 'Error: could not parse host/path from URL: %s\n' "$url" >&2
		overall_exit=1
		continue
	fi
	case "$host" in
		*.*) ;;
		*)
			printf 'Error: host is not a domain: %s\n' "$host" >&2
			overall_exit=1
			continue
			;;
	esac
	# Require at least `owner/repo`, and reject segments that would escape the
	# farm root or break on URL fragments.
	case "$path" in
		*/*) ;;
		*)
			printf 'Error: URL has no repository path: %s\n' "$url" >&2
			overall_exit=1
			continue
			;;
	esac
	case "/$path/" in
		*"//"* | *"/../"* | *"/./"*)
			printf 'Error: unsafe path segment in URL: %s\n' "$url" >&2
			overall_exit=1
			continue
			;;
	esac
	case "$path" in
		*" "* | *"?"* | *"#"*)
			printf 'Error: URL path contains a space, query or fragment: %s\n' "$url" >&2
			overall_exit=1
			continue
			;;
	esac

	target_dir="${downloads_dir}/references/${host}/${path}.git"

	if [ -d "$target_dir" ]; then
		printf 'Mirror already exists at: %s\n' "$target_dir"
		if git -C "$target_dir" remote update --prune; then
			printf 'Aligned mirror with upstream: %s\n' "$target_dir"
		else
			printf 'Error: aligning existing mirror failed: %s\n' "$target_dir" >&2
			overall_exit=1
		fi
		continue
	fi

	mkdir -p "$(dirname "$target_dir")"

	current_mirror_dir="$target_dir"

	if ! git clone --mirror "$url" "$target_dir"; then
		printf 'Error: git clone --mirror failed for: %s\n' "$url" >&2
		overall_exit=1
	else
		printf 'Mirrored: %s\n' "$target_dir"
	fi

	current_mirror_dir=""
done

trap - INT TERM EXIT

exit $overall_exit
