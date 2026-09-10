# bwrap runtime audit — mirror-tree usage vs upstream bubblewrap

Verified 2026-09-10, flag-by-flag against the upstream source/docs clone at
`~/Downloads/references/github/containers/bubblewrap` (`bwrap.xml` man page
and `bubblewrap.c`). Question answered: is the bubblewrap usage found in the
GitHub mirror tree (`~/Downloads/references/github`) plausible and correct,
and what would adopting a `bwrap` runtime tier in `lib/workload-runtime.sh`
entail?

## Usage found in the mirror tree

1. **mini-swe-agent** (`SWE-agent/mini-swe-agent`) — the only in-tree
   *code* consumer: `src/minisweagent/environments/extra/bubblewrap.py`
   implements a `BubblewrapEnvironment` that wraps every agent command
   in `bwrap`, invoked as:

   ```
   bwrap --unshare-user-try --ro-bind /usr /usr --ro-bind /bin /bin \
        --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /etc /etc \
        --tmpfs /tmp --proc /proc --dev /dev --new-session \
        --setenv PATH … \
        --bind <cwd> <cwd> --chdir <cwd> \
        --setenv K V … bash -c <command>
   ```

   Marked **experimental** upstream; not supported on Windows;
   executable overridable via `MSWEA_BUBBLEWRAP_EXECUTABLE`. Also
   referenced only as documentation elsewhere (docs, mkdocs, CI yaml);
   the sole other hit is a doc citation in `cline/kanban` (codex CLI
   reference), i.e. not code.

2. **This repo's own prior-art docs** referenced bwrap as the
   Pressure-Vessel / Flatpak-style ideal sandbox layer for a containerless
   Termux runtime, and listed `bwrap` as one of the pluggable workload
   runtimes — consistent with the mini-swe-agent usage shape.

## Plausibility verification vs `containers/bubblewrap`

Every flag mini-swe-agent passes is a real, documented option in the
upstream man page (`bwrap.xml`) and parsed in `bubblewrap.c`
(occurrence counts man page/source):

| Flag | bwrap.xml | bubblewrap.c | Notes |
|---|---|---|---|
| `--unshare-user-try` | 2 | 3 | unshare user ns only if permitted — the right *try* form for heterogeneous hosts |
| `--ro-bind` | 4 | 11 | 4× system dirs; keeps base OS read-only |
| `--bind` | 14 | 63 | 1× per-run workspace cwd (RW) |
| `--chdir` | 2 | 23 | enters the bound workspace |
| `--tmpfs` | 16 | 22 | private `/tmp` |
| `--proc` | 25 | 95 | fresh `/proc` |
| `--dev` | 6 | 29 | minimal `/dev` |
| `--new-session` | 2 | 2 | new TTY session; upstream man page explicitly recommends it "in a general sandbox" |
| `--setenv` | 4 | 9 | PATH + per-var env injection |

Semantic consistency with upstream `README.md`:

- Bubblewrap's supported mode is **unprivileged user namespaces**
  (`--unshare-user-try` matches; upstream setuid mode has been removed,
  so a plain unprivileged invocation is the correct, plausible usage —
  no setuid expectations anywhere in mini-swe-agent).
- The layout (ro-bind system trees + tmpfs tmp + fresh proc/dev +
  per-run RW workspace bind) is exactly the minimal-sandbox pattern
  upstream demos/tests exercise; nothing invented.
- Correct sequencing: option order (binds before `--chdir`/exec) is
  legal — bwrap processes options positionally; `bash` as the payload
  runs inside the namespace.

## Gaps / caveats if adopted as a workload runtime here

- mini-swe-agent does **not** pass `--die-with-parent` (documented,
  `bwrap.xml:587`) — advisable for our supervision loop so the sandbox
  dies with its supervisor.
- No `--unshare-net`; the sandbox keeps host networking. Our workload
  model may want opt-in network isolation instead.
- No `--dev-bind` for GPU/device trees; fine for CPU-only agent work,
  would need extension for CUDA workloads (cf. HF cache mount needs).
- Env forwarding is explicit-only (`--setenv` per key), which mirrors
  this repo's `workload_env` allowlist pattern — a good match.
- Upstream marks this environment experimental; if we wire a `bwrap`
  runtime into `lib/workload-runtime.sh`, treat it as the
  `proot`/`native` tier's peer, not a podman replacement.

**Verdict: plausible.** The only real bwrap consumer in the mirror
tree uses exclusively documented, semantically correct flags against
the containers/bubblewrap reference clone; the usage is a faithful
minimal-sandbox construction consistent with upstream docs and with
this repo's own prior-art notes.
