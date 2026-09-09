# workload-has.jq — is a named array of the description non-empty?
#
# PART OF: the workload description API in lib/workload-runtime.sh.  This is the
# filter behind `workload_has`, which is how a caller asks the description a
# question without reaching into its internals.
#
# INPUT — jq variables:
#   $doc    (--argjson)  the current description object.
#   $field  (--arg)      which array to test, e.g. "devices", "mounts", "env".
#
# OUTPUT: one JSON boolean, true or false.
#
# EXIT STATUS IS THE REAL INTERFACE: the caller runs jq with -e, which maps
# the last output value onto the exit status —
#     true  → exit 0   (the array has at least one element)
#     false → exit 1   (missing, null or empty)
# so `workload_has devices` is usable directly as an `if` condition and never
# has to compare a string.  A missing field counts as empty (// []), so
# callers need no initialisation.
#
# WHY THIS EXISTS: it replaces the old `[ -n "$_SB_DEV" ]` test in
# llm-reverse-proxy/generate.sh, which reached straight into a space-joined
# shell global that this refactor removed.
#
# NOTE: a compile error (syntax, or an undefined $var) exits 3, which is
# distinct from the 0/1 above — the lint gate in ./lint.sh relies on that.
#
# CALLER CONTRACT: this filter produces no input of its own, so it MUST be run
# with jq -n.  Without -n, jq waits on stdin, the filter never runs and there
# is no output (exit 4 under -e).  Every caller here passes the description via
# --argjson, never on stdin.
($doc[$field] // []) | length > 0
