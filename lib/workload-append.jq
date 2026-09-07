# sandbox-append.jq — append one or more STRINGS to a named array of a sandbox
# description.
#
# PART OF: the sandbox description API in ../container-tool.sh.
#
# INPUT — jq variables:
#   $doc    (--argjson)  the current description object.
#   $field  (--arg)      which array to append to.  Two callers today:
#                          "env"      environment-variable NAMES.  Rendered as
#                                     a bare `--env NAME`, so podman/docker
#                                     takes the value from the host
#                                     environment (that is how the vault keys
#                                     reach the sandbox — see
#                                     coding-agent/run.sh).
#                          "devices"  host device paths (e.g. /dev/kfd,
#                                     /dev/dri/renderD128).  Rendered as
#                                     `--device PATH:PATH:rw`.
#   $ARGS.positional (--args)  the values to append, in order.  --args must be
#                              FOLLOWED BY A BARE `--`: jq keeps parsing
#                              options after --args, so without the `--` a
#                              value beginning with a dash is read as jq flags
#                              (e.g. `sandbox_cmd -config-dir` fails with
#                              "Unknown option -o").  After `--`, every
#                              remaining argument is data.
#
# OUTPUT: the description with those values appended to .$field, compact JSON
#         on a single line.
#
# WHY: replaces two space-joined shell strings (_SB_ENV, _SB_DEV) that were
# word-split at render time inside unquoted `for` loops.  Word-splitting an
# unquoted expansion is a bash/dash behaviour, not a POSIX-shell one — zsh does
# not do it — so the old form was silently dialect-dependent.  An array is not.
#
# NOTE: appending to a missing field creates it, so callers need no
# initialisation beyond the empty description object.
$doc | .[$field] += $ARGS.positional
