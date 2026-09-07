# sandbox-render.jq — turn a sandbox description into `container run` argv.
#
# PART OF: the sandbox description API in ../container-tool.sh.  This is the
# single renderer: every flag the sandbox API can produce is emitted here, so
# there is exactly one place that knows podman's and docker's dialects.
#
# ---------------------------------------------------------------------------
# INPUT — jq variables.  Two halves:
#
#   $doc (--argjson)  the LIST side of the description, built by
#                     lib/sandbox-mount.jq, lib/sandbox-append.jq,
#                     lib/sandbox-port.jq and lib/sandbox-cmd.jq:
#                       {"mounts": [{"mode","host","guest"}, ...],
#                        "env":     ["NAME", ...],
#                        "ports":   [{"host","guest"}, ...],
#                        "devices": ["/dev/kfd", ...],
#                        "cmd":     ["word", ...]}
#                     Every field is optional; a missing or empty field emits
#                     nothing (they are all read as `// []`).
#
#   Scalar settings (--arg each).  EMPTY STRING MEANS "OMIT THE FLAG" — this is
#   how "the caller did not set it" is distinguished from "set to empty":
#                       ""            → no --name at all
#                       ""            → no --network at all
#                       ""            → no --entrypoint at all
#                       ""            → no --workdir at all
#                       "" | "detach" | "interactive" → nothing | --detach | -it
#                       "1"           → pass --init
#                       "1"           → pass --user $uid:$gid
#                       "1"           → pass --cap-drop=all
#                                       --security-opt no-new-privileges
#                       "podman" | "docker" → selects the mount options (below)
#                       "$SUDO_UID or id -u" / "$SUDO_GID or id -g"
#                       rootless-podman extras: "--userns=keep-id"
#                       rootless-podman extras: "--group-add keep-groups"
#                       image to run — required, and the shell checks that it
#                       is non-empty before calling this filter
#
# ---------------------------------------------------------------------------
# OUTPUT — ONE line of space-separated, @sh-quoted words:
#
#   <flags...> <image> <cmd words...>
#
#   The caller does `eval "set -- $(_render_argv)"`.  @sh is what makes that
#   safe: every word comes back quoted for POSIX sh, so a path containing a
#   space, a quote or a newline stays ONE word.  Nothing is emitted for a flag
#   whose input is empty, and no flag is ever passed as an empty string.
#
# ---------------------------------------------------------------------------
# ORDER — byte-for-byte the order the previous shell renderer emitted, because
# `container run` is order-insensitive for these flags but the argv is captured
# verbatim by tests and appears in `ps`:
#   --init, mode flag, --name, --network, --entrypoint, --user (+ rootless
#   podman extras), --publish, --device, hardening, -v mounts, --env,
#   --workdir, image, cmd.
#
# ---------------------------------------------------------------------------
# MOUNT OPTIONS — the one genuine backend difference:
#   podman (rootless, SELinux): "z,U" — shared relabel PLUS chown into the
#     mapped subuid range.  Without the U, rootless podman chowns the host's
#     files into a raw subuid and the user loses them.
#   docker (rootful, SELinux):  "z" — shared relabel only.
#   ",ro" is appended for a read-only mount.  "rw" emits no suffix.
[
  ( if $init == "1" then "--init" else empty end
  , if   $mode == "detach"      then "--detach"
    elif $mode == "interactive" then "-it"
    else empty end
  , (if $name == "" then empty else "--name=\($name)" end)
  , (if $network == "" then empty else "--network=\($network)" end)
  , (if $entrypoint == "" then empty else "--entrypoint", $entrypoint end)
  , (if $user != "1" then empty else
       (if $userns == "" then empty else ($userns | splits(" +")) end)
     , ("--user", "\($uid):\($gid)")
     , (if $keepgroups == "" then empty else ($keepgroups | splits(" +")) end)
     end)
  , (($doc.ports // [])[] | "--publish", "\(.host):\(.guest)/tcp")
  , (($doc.devices // [])[] | "--device", "\(.):\(.):rw")
  , (if $harden == "1" then
       "--cap-drop=all", "--security-opt", "no-new-privileges"
     else empty end)
  , (($doc.mounts // [])[]
     | (if $tool == "podman" then "z,U" else "z" end) as $mo
     | "-v", "\(.host):\(.guest):\($mo)\(if .mode == "ro" then ",ro" else "" end)")
  , (($doc.env // [])[] | "--env", .)
  , (if $workdir == "" then empty else "--workdir", $workdir end)
  , $image
  , (($doc.cmd // [])[])
  )
  | @sh
] | join(" ")
