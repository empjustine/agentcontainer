# workload-cmd.jq — SET the container command (the argv that follows the image).
#
# PART OF: the workload description API in lib/workload-runtime.sh.  This is the
# filter behind `workload_cmd`.
#
# INPUT — jq variables:
#   $doc    (--argjson)  the current description object.
#   $ARGS.positional (--args)  the command words, in order.  --args must be
#                              FOLLOWED BY A BARE `--`: jq keeps parsing
#                              options after --args, so without it the very
#                              common `workload_cmd -config-dir /config.d` is
#                              read as jq flags ("Unknown option -o").
#
# OUTPUT: the description with .cmd REPLACED by that word array, compact JSON
#         on a single line.  It is a set, not an append: a container has one
#         command, and re-declaring it must not stack.
#
# RENDERED BY workload-render.jq as the trailing argv words, after the image:
#   ... <image> <word> <word> ...
#
# WHY: replaces `_SB_CMD="$*"` plus an unquoted, shellcheck-suppressed
# word-splitting at launch (`$_SB_CMD` with `# shellcheck disable=SC2086`).
# The command is now a real array: workload-render.jq emits each word @sh-quoted,
# so a word containing a space or a quote survives as one word instead of being
# re-split by the shell.
$doc | .cmd = $ARGS.positional
