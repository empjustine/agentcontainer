#!/bin/sh
# Lint all shell scripts (excluding OLD/). Tools are provisioned ad hoc via
# mise — no pinned dev deps needed.
# Runs shellcheck(1) as the gating linter.
# shfmt(1) -l is advisory only (exit status tolerated): it lists files whose
# formatting differs from canonical shfmt style. Adopting that style would
# collapse the deliberate column alignment in the run scripts, so format drift
# is reported, not enforced. Syntax errors are covered by shellcheck anyway.
# Usage: ./lint.sh [path]   (default: repo root)

set -eu

root="${1:-$(CDPATH='' cd "$(dirname "$0")" && pwd)}"
cd "$root"

printf ':: shellcheck\n'
mise exec shellcheck@latest -- find . -path ./OLD -prune -o -type f -name '*.sh' -exec shellcheck {} +

printf ':: shfmt (advisory)\n'
mise exec shfmt@latest -- find . -path ./OLD -prune -o -type f -name '*.sh' -exec shfmt -l {} + || true
