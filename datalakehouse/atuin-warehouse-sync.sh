#!/bin/bash
# atuin-warehouse-sync — atuin's history.db -> MotherDuck, conventional duckdb CLI only.
#
# WHY runtime introspection: atuin's `history` table grew columns over releases
# (deleted_at 2023, author/intent 2026, shell 2026, author_kind 2026...), so a
# hardcoded SELECT list breaks on older hosts and CREATE OR REPLACE breaks on
# newer ones. The source schema is read each run via duckdb_columns() over the
# attached sqlite, and the target is created/ALTERed to match before upserting.
#
# WHY pruning is opt-in (--prune): the warehouse outlives any single host, and a
# partial or stale source copy would silently erase history that only exists
# there. Default runs are additive/upsert-only; --prune states "this source is
# authoritative for what it covers" and only then mirrors its deletions.
#
# WHY a resolution mirror instead of asking atuin: the sync runs unattended
# (cron/systemd), where a mandatory argv is a liability, and atuin itself is
# not a dependency a shell script can link against. The source path therefore
# follows atuin's own precedence — explicit argv > $PWD/history.db >
# config.toml db_path/data_dir > the ATUIN_HOME/XDG/legacy data-dir rules —
# reproduced from crates/atuin-common/src/dirs.rs (unconfigured_data_dir and
# config_path). It mirrors PRECEDENCE, not toml semantics: values inside
# config.toml are not shell- or env-expanded here (README's deviations).
#
# Usage: atuin-warehouse-sync.sh [--prune] [--print-source] [history.db | directory]
# Env:   motherduck_token   MotherDuck access token (MOTHERDUCK_TOKEN accepted too)
#        ATUIN_WAREHOUSE_DB target md: database (default: atuin)
#        ATUIN_HOME / ATUIN_CONFIG_DIR / XDG_DATA_HOME / XDG_CONFIG_HOME
#                          source discovery only — the atuin precedence mirror
# Needs: duckdb v1.4-v1.5 (MotherDuck refuses other versions; ./dev-tools.sh duckdb), jq.
set -euo pipefail

usage() {
	cat >&2 <<EOF
usage: $0 [--prune] [--print-source] [history.db | directory]
  source   explicit path > \$PWD/history.db > atuin's own resolution
           (config.toml db_path/data_dir, ATUIN_HOME, XDG_DATA_HOME,
           legacy ~/.local/share/atuin, ~/.atuin/data)
  --print-source  resolve and print the source path, then exit (no token needed)
  --prune  mirror source deletions into the warehouse (default: upsert only)
env:      motherduck_token · ATUIN_WAREHOUSE_DB (default: atuin)
EOF
}

expand_home() { # a leading ~ arrives from config.toml the way atuin's ShellExpanded paths do
	# shellcheck disable=SC2088  # the tilde here is the literal character being MATCHED, not a word to expand
	case "$1" in
	'~') printf '%s\n' "$HOME" ;;
	'~/'*) printf '%s\n' "$HOME/${1#\~/}" ;;
	*) printf '%s\n' "$1" ;;
	esac
}

config_value() { # value of `key = value` in file $2, surrounding quotes stripped.
	# A PRECEDENCE read, not a toml parser: interpolation inside the value is
	# atuin's job and is a recorded deviation (README), not a silent guess.
	local line
	line=$(grep -E "^[[:space:]]*$1[[:space:]]*=" "$2" | head -n1 || true)
	line=${line#*=}
	line=$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
	line=${line#\"}
	line=${line%\"}
	line=${line#\'}
	line=${line%\'}
	printf '%s\n' "$line"
}

atuin_config_file() { # first existing config.toml in atuin's own precedence
	local candidate
	for candidate in \
		${ATUIN_CONFIG_DIR:+"$ATUIN_CONFIG_DIR/config.toml"} \
		${ATUIN_HOME:+"$ATUIN_HOME/config.toml"} \
		"$HOME/.atuin/config.toml" \
		${XDG_CONFIG_HOME:+"$XDG_CONFIG_HOME/atuin/config.toml"} \
		"$HOME/.config/atuin/config.toml"; do
		[ -f "$candidate" ] && {
			printf '%s\n' "$candidate"
			return 0
		}
	done
	return 0
}

atuin_data_dir() { # mirrors dirs.rs unconfigured_data_dir: ATUIN_HOME wins outright, otherwise
	# the EXISTING directory decides (~/.atuin/data before the legacy XDG locations),
	# and ~/.atuin/data is the default even when absent.
	local candidate
	if [ -n "${ATUIN_HOME:-}" ]; then
		printf '%s\n' "$ATUIN_HOME/data"
		return 0
	fi
	if [ -d "$HOME/.atuin/data" ]; then
		printf '%s\n' "$HOME/.atuin/data"
		return 0
	fi
	for candidate in ${XDG_DATA_HOME:+"$XDG_DATA_HOME/atuin"} "$HOME/.local/share/atuin"; do
		[ -d "$candidate" ] && {
			printf '%s\n' "$candidate"
			return 0
		}
	done
	printf '%s\n' "$HOME/.atuin/data"
}

resolve_source() { # echoes the history.db atuin itself would use; dies 66 listing what was tried.
	# An explicit argv never falls back: naming a path that is not a file must
	# fail loudly, or the sync would silently mirror a DIFFERENT host's history.
	local resolved="" cfg="" value=""
	if [ -n "$SRC" ]; then
		resolved=$SRC
		[ -d "$resolved" ] && resolved="$resolved/history.db"
		[ -f "$resolved" ] || {
			printf 'atuin-warehouse-sync: not a file: %s\n' "$resolved" >&2
			return 66
		}
		printf '%s\n' "$resolved"
		return 0
	fi
	if [ -f "$PWD/history.db" ]; then
		printf '%s\n' "$PWD/history.db"
		return 0
	fi
	cfg=$(atuin_config_file)
	if [ -n "$cfg" ]; then
		value=$(config_value db_path "$cfg")
		if [ -n "$value" ]; then
			resolved=$(expand_home "$value")
		else
			value=$(config_value data_dir "$cfg")
			if [ -n "$value" ]; then
				resolved="$(expand_home "$value")/history.db"
			else
				resolved="$(atuin_data_dir)/history.db"
			fi
		fi
	else
		resolved="$(atuin_data_dir)/history.db"
	fi
	if [ -f "$resolved" ]; then
		printf '%s\n' "$resolved"
		return 0
	fi
	{
		printf 'atuin-warehouse-sync: no history.db found\n'
		printf '  tried: %s\n' "$PWD/history.db"
		printf '  tried: %s%s\n' "$resolved" "${cfg:+ (from config: $cfg)}"
	} >&2
	return 66
}

PRUNE=0
PRINT_SOURCE=0
SRC=""
for arg in "$@"; do
	case "$arg" in
	--prune) PRUNE=1 ;;
	--print-source) PRINT_SOURCE=1 ;;
	-h | --help)
		usage
		exit 0
		;;
	-*)
		echo "unknown flag: $arg" >&2
		usage
		exit 64
		;;
	*)
		[ -z "$SRC" ] || { echo "only one source path" >&2; usage; exit 64; }
		SRC="$arg"
		;;
	esac
done

# Resolution precedes the token check so --print-source (and the tests) need no
# credentials, and a path problem is reported before any vault round-trip.
src=$(resolve_source) || exit $?
if [ "$PRINT_SOURCE" = 1 ]; then
	printf '%s\n' "$src"
	exit 0
fi

TOKEN=${motherduck_token:-${MOTHERDUCK_TOKEN:-}}
: "${TOKEN:?set motherduck_token (MotherDuck access token; see README)}"

# MotherDuck's extension rejects clients outside its supported range (docs:
# 1.4.1-1.5.6) with a load error that names no fix — a bare PATH duckdb can be
# 2.x, so fail first with the install command that pins the right one.
duckdb_version=$(duckdb --version 2>&1 || true)
case "$duckdb_version" in
v1.4.* | v1.5.*) ;;
*)
	echo "duckdb ${duckdb_version%% *} is outside the v1.4-v1.5 range MotherDuck accepts; run ./dev-tools.sh duckdb" >&2
	exit 69
	;;
esac

WAREHOUSE_DB=${ATUIN_WAREHOUSE_DB:-atuin}
TGT_DB=mdw
TGT_SCHEMA=main
TGT_TABLE=history
TGT="$TGT_DB.$TGT_SCHEMA.$TGT_TABLE"

duck() { duckdb -json -c "$1"; }

# Source columns as JSON [{name,type}]; fails cleanly when history.db has no history table.
src_json=$(duck "
  INSTALL sqlite; LOAD sqlite;
  ATTACH '$SRC' AS src (TYPE sqlite, READ_ONLY);
  SELECT column_name AS name, data_type AS type
  FROM duckdb_columns()
  WHERE database_name='src' AND table_name='history'
  ORDER BY column_index;")
jq -e 'type == "array" and length > 0' <<<"$src_json" >/dev/null ||
	{ echo "no history table in $SRC" >&2; exit 3; }

# Unsuspected errors (bad token, missing md: database) surface here rather than
# being read as "empty target": a missing table yields [] from duckdb_columns
# without error, so suppression would only hide real failures.
tgt_json=$(duck "
  INSTALL motherduck; LOAD motherduck;
  SET motherduck_token='$TOKEN';
  ATTACH 'md:$WAREHOUSE_DB' AS $TGT_DB;
  SELECT column_name AS name, data_type AS type
  FROM duckdb_columns()
  WHERE database_name='$TGT_DB' AND schema_name='$TGT_SCHEMA' AND table_name='$TGT_TABLE'
  ORDER BY column_index;")
[ -n "$tgt_json" ] || tgt_json='[]'

# SQL is generated from the two introspections: create-or-ALTER the target to the
# source's shape (unknown future atuin columns keep their attached sqlite type),
# then upsert by id. The mirror DELETE is emitted only under --prune.
sql=$(jq -r --argjson src "$src_json" --argjson tgt "$tgt_json" --argjson prune "$PRUNE" \
	--arg target "$TGT" -n '
  def known_type:
    if . == "timestamp" or . == "deleted_at" then "TIMESTAMP"
    elif . == "duration" then "DOUBLE"
    elif . == "exit" or . == "author_kind" then "BIGINT"
    else "VARCHAR" end;
  def known_names:
    ["id","timestamp","duration","exit","command","cwd","session","hostname",
     "deleted_at","author","intent","shell","author_kind"];
  def coltype:
    . as $c | if (known_names | index($c.name)) != null
      then ($c.name | known_type) else $c.type end;
  def expr:
    if . == "timestamp" or . == "deleted_at"
      then "to_timestamp(CAST(s.\"" + . + "\" AS DOUBLE)/1e9)"
    elif . == "duration" then "s.\"duration\"/1e9"
    elif . == "exit" or . == "author_kind" then "CAST(s.\"" + . + "\" AS BIGINT)"
    else "s.\"" + . + "\"" end;

  $src as $s | $tgt as $t |
  ($t | map(.name)) as $tn |
  ($s | map(.name)) as $sn |
  (if ($t | length) == 0 then
     ["CREATE TABLE " + $target + " (" +
      ($s | map(. as $c | $c.name + " " + ($c | coltype)) | join(", ")) +
      ", PRIMARY KEY (id));"]
   else [] end) as $create |
  # after a fresh CREATE the target already mirrors the source; only a
  # pre-existing target needs ALTERs for columns the source gained.
  (if ($t | length) == 0 then [] else
     $s | map(select(.name as $n | ($tn | index($n)) == null))
         | map("ALTER TABLE " + $target + " ADD COLUMN " + .name + " " + coltype + ";")
   end) as $alter |
  (["INSERT INTO " + $target + " (" + ($sn | join(", ")) + ")",
    "SELECT " + ($s | map(.name | expr) | join(", ")) + " FROM src.history s",
    "ON CONFLICT (id) DO UPDATE SET " +
      ($sn | map(select(. != "id")) | map(. + "=excluded." + .) | join(", ")) + ";"]
   + if $prune == 1 then
       ["DELETE FROM " + $target + " t WHERE NOT EXISTS " +
        "(SELECT 1 FROM src.history s WHERE s.id = t.id);"]
     else [] end)
  | ($create + $alter + .) | join("\n")')

result=$(duck "
  INSTALL sqlite; LOAD sqlite;
  INSTALL motherduck; LOAD motherduck;
  SET motherduck_token='$TOKEN';
  ATTACH '$SRC' AS src (TYPE sqlite, READ_ONLY);
  ATTACH 'md:$WAREHOUSE_DB' AS $TGT_DB;
  CREATE SCHEMA IF NOT EXISTS $TGT_DB.$TGT_SCHEMA;
$sql
SELECT (SELECT count(*) FROM $TGT_DB.$TGT_SCHEMA.$TGT_TABLE) AS rows_target;")

jq -n --argjson result "$result" --arg source "$src" --argjson prune "$PRUNE" \
	--arg target "md:$WAREHOUSE_DB" \
	'$result[0] + {source: $source, target: $target, prune: ($prune == 1)}'
