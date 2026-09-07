# sandbox-port.jq — append ONE published-port record to a sandbox description.
#
# PART OF: the sandbox description API in ../container-tool.sh.  This is the
# filter behind `sandbox_publish`.
#
# INPUT — jq variables, all required:
#   $doc    (--argjson)  the current description object.  .ports is created if
#                        absent.  Shape:
#                          {"ports":[{"host":"8080","guest":"8080"}, ...]}
#   $host   (--arg)      port (or port range) published on the host.
#   $guest  (--arg)      port the container listens on.
#
# OUTPUT: the description with one record appended to .ports, compact JSON on a
#         single line.
#
# RENDERED BY sandbox-render.jq as two argv words:
#   --publish  <host>:<guest>/tcp
#
# WHY A RECORD AND NOT A STRING: the old code pre-formatted the pair into
# $_SB_PORTS as "host:guest/tcp" and then word-split it back out.  Keeping the
# two halves separate means the "/tcp" convention lives in exactly one place
# (the renderer) instead of at the call site.
$doc | .ports += [{host: $host, guest: $guest}]
