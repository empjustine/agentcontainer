#!/bin/sh

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
    printf 'Usage: %s <github_https_git_url> [<github_https_git_url> ...]\n' "$0" >&2
    exit 1
fi

downloads_dir="$(get_downloads_dir)"

# --- Cleanup trap ---

current_clone_dir=""

cleanup() {
    if [ -n "$current_clone_dir" ] && [ -d "$current_clone_dir" ]; then
        printf 'Cleaning up partial clone: %s\n' "$current_clone_dir" >&2
        rm -rf "$current_clone_dir"
    fi
}

trap cleanup INT TERM EXIT

# --- Clone loop ---

overall_exit=0

for url in "$@"; do
    case "$url" in
        https://github.com/*/*.git)
            ;;
        *)
            printf 'Error: invalid GitHub HTTPS URL format: %s\n' "$url" >&2
            overall_exit=1
            continue
            ;;
    esac

    path="${url#https://github.com/}"
    owner="${path%%/*}"
    repo_git="${path#*/}"
    repo_git="${repo_git##*/}"
    repo="${repo_git%.git}"

    if [ -z "$owner" ] || [ -z "$repo" ]; then
        printf 'Error: could not parse owner/repository from URL: %s\n' "$url" >&2
        overall_exit=1
        continue
    fi

    target_dir="${downloads_dir}/references/github/${owner}/${repo}"

    if [ -d "$target_dir" ]; then
        printf 'Repository already exists at: %s\n' "$target_dir"
        continue
    fi

    mkdir -p "$(dirname "$target_dir")"

    current_clone_dir="$target_dir"

    if ! git clone "$url" "$target_dir"; then
        printf 'Error: git clone failed for: %s\n' "$url" >&2
        overall_exit=1
    fi

    current_clone_dir=""
done

trap - INT TERM EXIT

exit $overall_exit