#!/bin/sh
# Source-resolution tests for atuin-warehouse-sync.sh — pure path logic:
# no token, no duckdb, no MotherDuck. ./test.sh runs every */tests/*.sh with
# sh, so re-exec into bash (the script under test is bash, and env -i below
# guarantees a host's real ATUIN_*/XDG_* can never leak into a case).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"

set -u
SCRIPT="$(CDPATH='' cd "$(dirname "$0")/.." && pwd)/atuin-warehouse-sync.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0

ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { # check <label> <expected> <actual>
	if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi
}
expect_66() { # expect_66 <label> <stderr+output>
	if printf '%s' "$2" | grep -q 'no history.db found\|not a file'; then
		ok "$1"
	else
		bad "$1 (no resolution error in: $2)"
	fi
}

# 1 — explicit file wins even when $PWD holds a history.db (no silent fallback)
mkdir -p "$tmp/cwd1"
: >"$tmp/cwd1/history.db"
direct="$tmp/direct.db"
: >"$direct"
got=$(cd "$tmp/cwd1" &&
	env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --print-source "$direct" 2>/dev/null) ||
	got="rc=$?"
check 'explicit file beats the cwd copy' "$direct" "$got"

# 2 — explicit directory resolves to <dir>/history.db
mkdir -p "$tmp/adir"
: >"$tmp/adir/history.db"
got=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --print-source "$tmp/adir" 2>/dev/null) ||
	got="rc=$?"
check 'explicit directory appends history.db' "$tmp/adir/history.db" "$got"

# 3 — an explicit-but-missing path FAILS even with a $PWD copy available:
# naming a path must never fall back to a different host's history
err=$(cd "$tmp/cwd1" &&
	env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --print-source "$tmp/missing.db" 2>&1)
rc=$?
check 'missing explicit path exits 66' "66" "$rc"
expect_66 'missing explicit path says so' "$err"

# 4 — no argv: $PWD/history.db is picked before atuin's own dirs
mkdir -p "$tmp/cwd4" "$tmp/h4/.local/share/atuin"
: >"$tmp/cwd4/history.db"
: >"$tmp/h4/.local/share/atuin/history.db"
got=$(cd "$tmp/cwd4" &&
	env -i PATH="$PATH" HOME="$tmp/h4" bash "$SCRIPT" --print-source 2>/dev/null) || got="rc=$?"
check 'cwd history.db beats the atuin dirs' "$tmp/cwd4/history.db" "$got"

# 5 — ATUIN_HOME/data (dirs.rs: ATUIN_HOME wins outright)
mkdir -p "$tmp/ah5/data"
: >"$tmp/ah5/data/history.db"
got=$(env -i PATH="$PATH" HOME="$tmp/h5" ATUIN_HOME="$tmp/ah5" \
	bash "$SCRIPT" --print-source 2>/dev/null) || got="rc=$?"
check 'ATUIN_HOME/data/history.db' "$tmp/ah5/data/history.db" "$got"

# 6 — XDG_DATA_HOME/atuin (the explicit legacy dir)
mkdir -p "$tmp/h6" "$tmp/xdg6/atuin"
: >"$tmp/xdg6/atuin/history.db"
got=$(env -i PATH="$PATH" HOME="$tmp/h6" XDG_DATA_HOME="$tmp/xdg6" \
	bash "$SCRIPT" --print-source 2>/dev/null) || got="rc=$?"
check 'XDG_DATA_HOME/atuin/history.db' "$tmp/xdg6/atuin/history.db" "$got"

# 7 — default legacy location ~/.local/share/atuin
mkdir -p "$tmp/h7/.local/share/atuin"
: >"$tmp/h7/.local/share/atuin/history.db"
got=$(env -i PATH="$PATH" HOME="$tmp/h7" bash "$SCRIPT" --print-source 2>/dev/null) ||
	got="rc=$?"
check 'default legacy dir picked' "$tmp/h7/.local/share/atuin/history.db" "$got"

# 8 — new-style ~/.atuin/data beats the legacy dir when BOTH exist
mkdir -p "$tmp/h8/.atuin/data" "$tmp/h8/.local/share/atuin"
: >"$tmp/h8/.atuin/data/history.db"
: >"$tmp/h8/.local/share/atuin/history.db"
got=$(env -i PATH="$PATH" HOME="$tmp/h8" bash "$SCRIPT" --print-source 2>/dev/null) ||
	got="rc=$?"
check 'new-style data dir wins over legacy' "$tmp/h8/.atuin/data/history.db" "$got"

# 9 — config.toml db_path is the top of atuin's own precedence
mkdir -p "$tmp/cfg9" "$tmp/custom"
: >"$tmp/custom/h.db"
printf 'db_path = "%s"\n' "$tmp/custom/h.db" >"$tmp/cfg9/config.toml"
got=$(env -i PATH="$PATH" HOME="$tmp/h9" ATUIN_CONFIG_DIR="$tmp/cfg9" \
	bash "$SCRIPT" --print-source 2>/dev/null) || got="rc=$?"
check 'config db_path' "$tmp/custom/h.db" "$got"

# 10 — config data_dir without db_path
mkdir -p "$tmp/cfg10" "$tmp/dd10"
: >"$tmp/dd10/history.db"
printf 'data_dir = "%s"\n' "$tmp/dd10" >"$tmp/cfg10/config.toml"
got=$(env -i PATH="$PATH" HOME="$tmp/h10" ATUIN_CONFIG_DIR="$tmp/cfg10" \
	bash "$SCRIPT" --print-source 2>/dev/null) || got="rc=$?"
check 'config data_dir/history.db' "$tmp/dd10/history.db" "$got"

# 11 — a config.toml with NEITHER key falls through to the dir rules
mkdir -p "$tmp/cfg11" "$tmp/ah11/data"
: >"$tmp/ah11/data/history.db"
printf '# nothing relevant here\n' >"$tmp/cfg11/config.toml"
got=$(env -i PATH="$PATH" HOME="$tmp/h11" ATUIN_CONFIG_DIR="$tmp/cfg11" \
	ATUIN_HOME="$tmp/ah11" bash "$SCRIPT" --print-source 2>/dev/null) || got="rc=$?"
check 'keyless config falls through' "$tmp/ah11/data/history.db" "$got"

# 12 — ATUIN_HOME set but empty: faithful to atuin, which would use the new
# location and see NO history — the legacy copy must NOT be picked up
mkdir -p "$tmp/ah12" "$tmp/h12/.local/share/atuin"
: >"$tmp/h12/.local/share/atuin/history.db"
err=$(env -i PATH="$PATH" HOME="$tmp/h12" ATUIN_HOME="$tmp/ah12" \
	bash "$SCRIPT" --print-source 2>&1)
rc=$?
check 'ATUIN_HOME without data exits 66' "66" "$rc"
expect_66 'ATUIN_HOME without data says so' "$err"

# 13 — nothing anywhere: exit 66 with the tried paths on stderr
mkdir -p "$tmp/h13"
err=$(cd "$tmp/h13" && env -i PATH="$PATH" HOME="$tmp/h13" \
	bash "$SCRIPT" --print-source 2>&1)
rc=$?
check 'no candidate exits 66' "66" "$rc"
if printf '%s' "$err" | grep -q 'tried:'; then
	ok 'no candidate lists tried paths'
else
	bad "no candidate must list tried paths (got: $err)"
fi

# 14 — unknown flag is a usage error, not a resolution error
err=$(env -i PATH="$PATH" HOME="$tmp/nohome" bash "$SCRIPT" --frobnicate 2>&1)
rc=$?
check 'unknown flag exits 64' "64" "$rc"

# --print-source needs no motherduck_token in ANY case above (env -i has none).

if [ "$fails" -gt 0 ]; then
	printf '%s resolution test(s) FAILED\n' "$fails" >&2
	exit 1
fi
printf 'all resolution tests passed\n'
