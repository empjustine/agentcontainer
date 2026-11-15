#!/bin/sh
# npm-tools.sh — install the npm-pinned JS/TS dev toolchain on demand.
#
# WHY a lockfile instead of mise: Termux has no mise, and the JS gates are npm
# packages with Android builds. package.json + package-lock.json are the one
# version source; this helper is the one install path so lint.sh and
# check-types.sh cannot drift (docs/d107).
#
# Source log.sh first: this file uses log_info/log_die. The cksum stamp
# lives UNDER node_modules, so `npm ci` replacing the tree invalidates it by
# construction rather than by a second bookkeeping file to keep in sync.
#
# Usage: npm_tools_ensure <repo-root>
npm_tools_ensure() {
	_npm_root=$1
	_npm_lock="$_npm_root/package-lock.json"
	_npm_stamp="$_npm_root/node_modules/.agentcontainer-lock"

	[ -f "$_npm_lock" ] ||
		log_die 96 "missing package-lock.json — cannot install the dev toolchain" \
			path="$_npm_lock"

	_npm_sum=$(cksum "$_npm_lock" | awk '{print $1 ":" $2}')
	if [ -d "$_npm_root/node_modules" ] &&
		[ "$(cat "$_npm_stamp" 2>/dev/null || :)" = "$_npm_sum" ]; then
		return 0
	fi

	log_info "installing npm dev toolchain" lock="package-lock.json" \
		path="$_npm_root/node_modules"
	# --ignore-scripts keeps package lifecycle code out of the gate; the pinned
	# packages are pure JS or prebuilt natives. --include=dev defeats a
	# NODE_ENV=production that would otherwise omit the gates.
	if ! ( cd "$_npm_root" &&
		npm ci --no-audit --no-fund --include=dev --ignore-scripts ); then
		log_die 96 "npm ci failed — dev toolchain unavailable" path="$_npm_root"
	fi
	printf '%s\n' "$_npm_sum" > "$_npm_stamp"
}
# pnpm_tools_ensure <repo-root> — install what the six pi extension folders
# typecheck against: @earendil-works/pi-coding-agent, one lockfile per folder
# because a folder is a copy unit (docs/d113), ONE store because pnpm hardlinks
# the unpacked tree instead of copying it (docs/d107). Six entries therefore
# cost one copy on disk — the reason pnpm rather than npm is the second manager
# here, where npm would have written six.
#
# Skips a folder whose lockfile is unchanged, by the same cksum stamp idiom as
# the npm tree above. A folder with no lockfile is skipped rather than fatal:
# only the extensions that carry the devDependency need the install.
#
# Usage: pnpm_tools_ensure <repo-root>
pnpm_tools_ensure() {
	_pnpm_root=$1
	# shellcheck source-path=SCRIPTDIR source=dev-tools.sh
	. "$(dirname "$0")/dev-tools.sh"
	for _pnpm_lock in "$_pnpm_root"/pi-*/pnpm-lock.yaml; do
		[ -f "$_pnpm_lock" ] || continue
		_pnpm_dir=${_pnpm_lock%/pnpm-lock.yaml}
		_pnpm_stamp="$_pnpm_dir/node_modules/.agentcontainer-lock"
		_pnpm_sum=$(cksum "$_pnpm_lock" | awk '{print $1 ":" $2}')
		if [ -d "$_pnpm_dir/node_modules" ] &&
			[ "$(cat "$_pnpm_stamp" 2>/dev/null || :)" = "$_pnpm_sum" ]; then
			continue
		fi
		_pnpm_name=${_pnpm_dir##*/}
		log_info "installing pi extension types" unit="$_pnpm_name" \
			lock=pnpm-lock.yaml store=.pnpm-store
		# --frozen-lockfile: the committed lock is the only version source, so a
		# drifted package.json fails here instead of silently resolving. The pin
		# table (dev-tools.sh) supplies pnpm; mise is a dev-host tool only.
		if ! ( cd "$_pnpm_dir" &&
			dev_tool_run pnpm pnpm install --frozen-lockfile --ignore-scripts ); then
			log_die 96 "pnpm install failed — the pi entry points cannot typecheck" \
				path="$_pnpm_dir" hint="./dev-tools.sh pnpm"
		fi
		printf '%s\n' "$_pnpm_sum" > "$_pnpm_stamp"
	done
}

