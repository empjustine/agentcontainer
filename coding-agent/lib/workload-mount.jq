# workload-mount.jq — append ONE bind-mount record to a workload description.
#
# PART OF: the workload description API in lib/workload-runtime.sh (see
# docs/container-tooling.md).  The description is a JSON document that the
# shell assembles by piping it through one small jq filter per mutator.  This
# is the filter behind `workload_ro` / `workload_ro_if` / `workload_rw`.
#
# INPUT — jq variables, all required:
#   $doc    (--argjson)  the current description object.  .mounts is created if
#                        absent.  Shape:
#                          {"mounts":[{"mode":"ro"|"rw",
#                                      "host":"/abs/on/host",
#                                      "guest":"/abs/in/container"}, ...]}
#   $mode   (--arg)      "ro" or "rw" — becomes the `,ro` suffix of the bind's
#                        options string; "rw" emits no suffix.
#   $host   (--arg)      path on the host.
#   $guest  (--arg)      path inside the container.
#
# OUTPUT: the same object with one record appended to .mounts, compact JSON on
#         a single line.  The shell stores that back in $_SB_LISTS and passes
#         it as $doc on the next call.
#
# WHY: the value carries NO shell quoting.  $host / $guest are bound with
# --arg, so spaces, quotes and newlines in a path reach jq as literal data and
# come back out @sh-quoted from workload-render.jq.  The previous shell
# implementation emulated indexed arrays with `eval` (_sb_add_vol +
# a matching eval in _render_container) to achieve the same thing.
#
# ORDER: .mounts is appended to, never sorted; workload-render.jq emits mounts
# in array order, which is the order the caller declared them.
$doc | .mounts += [{mode: $mode, host: $host, guest: $guest}]
