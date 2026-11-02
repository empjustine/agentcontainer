#!/bin/sh
# lib/npm-tools.sh — install the npm-pinned JS/TS dev toolchain on demand.
#
# WHY a lockfile instead of mise: Termux has no mise, and the JS gates are npm
# packages with Android builds. package.json + package-lock.json are the one
# version source; this helper is the one install path so lint.sh and
# check-types.sh cannot drift (docs/d107).
#
# Source lib/log.sh first: this file uses log_info/log_die. The cksum stamp
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
