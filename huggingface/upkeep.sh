#!/bin/sh

# HuggingFace model-cache upkeep: list, prune, pull newer revisions, verify.
#
# Thin POSIX-sh shim for upkeep.py. The upkeep pipeline runs directly on the
# host via huggingface_hub (no container). The old container caller was dead
# code: the image entrypoint is download-all, not an upkeep tool, and the
# container was never handed the upkeep script.

set -eu

here="$(CDPATH= cd "$(dirname "$0")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
	printf 'fatal: python3 not found\n' >&2
	exit 90
fi

if ! python3 -c 'import huggingface_hub' >/dev/null 2>&1; then
	printf 'fatal: huggingface_hub not installed (try: pip install huggingface_hub)\n' >&2
	exit 91
fi

exec python3 "$here/upkeep.py" "$@"
