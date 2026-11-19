---
id: coding-harness-persistence
type: module-design
status: draft
title: "Coding-harness persistence table — host-side state dirs per harness"
parent: coding-agent
tags: ["reference", "persistence", "workloads"]
---

# Coding-Harness Persistence Table

How `coding-agent/run.mjs` preserves each coding harness's state across
ephemeral container runs. **Every row is a HOST directory mounted RW at the
CONTAINER's own default path for that harness (docs/d216):** the host harness
and the sandboxed harness read one directory, so state written inside the
sandbox survives the container's death and the host sees it where it keeps its
own. No per-run stage directory and no env pin exists for a harness that already
looks at that path. For the planned hardening of this mechanism into a data
diode (state may flow out, but can never be rewritten or deleted from inside the
container), see `docs/d026-data-diode-audit.md` — design note only, not yet
implemented. Secrets never follow this path — they are loaded host-side once
(./environment.sh — the explicit chain) and forwarded through the
`workload_env` allowlist (`CLINE_API_KEY`, `MISTRAL_API_KEY`, `PEER_API_KEY`,
`OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `HF_TOKEN`, `GEMINI_API_KEY`).

| Harness                         | Host dir (override honored)                                   | Container mount (RW)                | Env pin | What it preserves                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------- | ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pi (`pi-coding-agent`) config   | `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`)                | `/home/$USER/.pi/agent`             | —       | settings.json, models.json, skills                                                                                                                         |
| pi (`pi-coding-agent`) sessions | `<agentDir>/sessions` (inside the agent dir)                  | same path, by the agent-dir mount   | —       | sessions (docs/d054, d216)                                                                                                                                 |
| OpenCode config                 | `$OPENCODE_CONFIG_DIR` (default XDG config's `opencode/`)     | `/home/$USER/.config/opencode`      | —       | opencode.json overlay (generator-installed; a missing overlay is a tolerated partial config, docs/d065)                                                    |
| OpenCode data                   | `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`) | `/home/$USER/.local/share/opencode` | —       | auth.json, long-term logs (log/), sessions (project/…/storage)                                                                                             |
| Cline (CLI)                     | `$CLINE_DIR` (default `~/.cline`)                             | `/home/$USER/.cline`                | —       | data/settings/providers.json, global-settings.json, cline_mcp_settings.json, sessions/, db/, workflows/, rules/, hooks/, skills/, agents/, plugins/, cron/ |
| ThinkRail                       | `$THINKRAIL_DATA_DIR` (default `~/.thinkrail`)                | `/home/$USER/.thinkrail`            | —       | projects.json, workspaces.json, terminals.json, installation.json, app config                                                                              |

Notes:

- **mistral-vibe has no row in this table**: the launcher mounts no
  directory for it and pins no env — support is pending (docs/d167), on the
  best-effort tier's terms (d116).
- **Workspace project state needs no mount**: project-scoped harness dirs
  (`.cline/`, `.thinkrail/` inside a repo; pi's project config) live under the
  workspace, which is already RW-mounted at its real host path. The
  home-relative _global_ state dirs are the host's own, mounted at the
  container's default path for each harness (docs/d216).
- **Extra directories are explicit mounts**: `./node-run.sh coding-agent/run.mjs
  [DIRECTORY [DIRECTORY...]]`
  mounts each argument rw — the host side canonical, the container side at
  the container's home spelling for a home-relative path (CWD is the implicit
  first directory, and the first directory is the workdir; docs/d068). The
  `~/Downloads/references` mirror is passed this way; the former
  `CODING_AGENT_REFERENCES` env toggle is retired (docs/d056).
- **No Hugging Face cache mount (docs/d066)**: the host HF cache is not
  bound into the sandbox. That mount was unconditional and existence-unguarded
  (`workload_rw` aborts the launch when the source dir is missing) and its
  `z,U` relabel walk scaled with the model store. The image's own
  `~/.cache/huggingface/hub` is empty and ephemeral, so `hf` still runs
  there; a launch that wants the warm host cache names it as a DIRECTORY —
  it lands at the sandbox's own `~/.cache/huggingface/hub`, the path `hf`
  already reads by default (docs/d068). `llm-local-inference/run.sh` still ro-mounts the cache —
  that workload serves models straight out of it.
- **pi↔ThinkRail share `~/.pi/agent`**: ThinkRail runs pi in-process and
  resolves the same agent dir (`getAgentDir()` → `~/.pi/agent`), so the single
  pi mount covers ThinkRail's pi config and its sessions (`sessions/` inside
  that dir).
- **No env pins and no launch chain.** Every mount lands on the harness's own
  default path, so the in-container command is the image's default bash and the
  generated `$stage/launch.sh` is gone (docs/d216, docs/d067). A harness that
  changes its default path breaks the mount silently; its upstream docs are the
  tripwire.
- **Init seeding**: the launcher seeds nothing per run for pi or OpenCode anymore —
  the generator installs pi's config into `$HOME/.pi/agent` (docs/d054) and
  opencode's `opencode.json` into the host config dir, refreshing the
  committed `coding-agent/opencode.jsonc` alongside (docs/d065). A missing
  opencode overlay is only warned about at launch (partial config
  tolerated); a missing pi artifact aborts. A populated
  `auth.json` in the pi agent dir or the opencode data dir aborts the run —
  an empty `{}` is ignored (pi re-creates it on every start; opencode writes
  the file only on login) (d052/d054/d216). Cline's
  `data/settings/providers.json` and ThinkRail's `installation.json` are
  credential-shaped with no empty form to test; their presence is warned about,
  not gated. Cline and ThinkRail have no committed fallback config — they
  self-initialize on first in-container use (`cline auth`, first ThinkRail
  launch), and the RW mount persists the result.
- **VS Code Cline extension state is intentionally out of scope**: the IDE
  extension's globalStorage (`~/.config/Code/User/globalStorage/saoudrizwan.claude-dev`)
  is irrelevant in this headless container; the CLI's `~/.cline` root is the
  shared store per Cline's docs.
- There is no launch chain: the container command is the image's own
  `/usr/bin/bash`, and no repo file is mounted (docs/d067, docs/d216).

Sources verified against upstream repos (canonical: github.com/cline/cline,
github.com/JetBrains/thinkrail), read from local reference clones under
`~/Downloads/references/github/` — a convenience cache, not the canonical
source: Cline
(`docs/getting-started/config.mdx` — `~/.cline` layout,
`CLINE_DATA_DIR` replaces only `~/.cline/data`) and ThinkRail
(`packages/server/src/persistence/persistence.ts` —
`dataDir()` = `THINKRAIL_DATA_DIR` ?? `~/.thinkrail`; pi agent dir reuse via
`packages/server/src/agent/piRuntime.ts`).

---

## Appendix: bwrap (bubblewrap) usage audit — cross-reference (2026-09-10)

A mirror-tree search for `bwrap`/`bubblewrap` found exactly one real code
consumer: **mini-swe-agent**
(`SWE-agent/mini-swe-agent/src/minisweagent/environments/extra/bubblewrap.py`,
an experimental, Windows-unsupported sandbox environment). All its flags
(`--unshare-user-try`, `--ro-bind`, `--bind`, `--chdir`, `--tmpfs`, `--proc`,
`--dev`, `--new-session`, `--setenv`) were verified flag-by-flag against
upstream bubblewrap (github.com/containers/bubblewrap — `bwrap.xml` man page +
`bubblewrap.c`, read from the local reference clone) and are all real,
documented options
used in a semantically correct minimal-sandbox layout — **verdict:
plausible**. Full audit (flag table, semantic checks against upstream
`README.md`, and adoption caveats for a possible `bwrap` workload runtime
tier — missing `--die-with-parent`, no `--unshare-net`, no device binds):
see [archive/bwrap-runtime-audit.md](../docs/archive/bwrap-runtime-audit.md).

Relevance to persistence: a bwrap runtime, if added as a workload runtime
alternative to podman in the workload runner (each unit's own workload
runtime — `coding-agent/lib/workload-runtime.mjs` here; `estige/` and
`llm-local-inference/` keep their `lib/workload-runtime.sh` copies, docs/d113), would replace
`workload_rw`/`workload_ro` bind mounts with equivalent `--bind`/`--ro-bind`
flags — the harness persistence table above is the mount manifest that such
a bwrap runtime must reproduce 1:1 (note bwrap has no named-volume or
`--relabel` equivalent for SELinux; host-side staging dirs like
`$workload_stage/*` remain the right persistence mechanism under either
runtime).
