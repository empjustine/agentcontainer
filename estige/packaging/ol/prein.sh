#!/bin/sh
# Create the unprivileged service account. Idempotent so upgrades re-run it.
set -e

getent group estige >/dev/null 2>&1 || groupadd -r estige
getent passwd estige >/dev/null 2>&1 ||
	useradd -r -g estige -d / -s /sbin/nologin -c "estige service" estige

exit 0
