---
id: coding-harness-persistence
type: reference
status: draft
title: "Coding-harness persistence table — host-side state dirs per harness"
parent: coding-agent
tags: ["reference", "persistence", "workloads"]
---

# Coding-Harness Persistence Table

How `coding-agent/run.sh` preserves each coding harness's state across
ephemeral container runs. For the planned hardening of this mechanism into a
data diode (state may flow out, but can never be rewritten or deleted from
inside the container), see `docs/d026-data-diode-audit.md` — design note only,
not yet implemented. **pi splits the rule (docs/d054):** its *config* dir is the
host's own `~/.pi/agent`, mounted directly (no per-run copy), while its
*sessions* are staged per run under the container's `pi/`. **OpenCode splits
the same way (docs/d065):** its *config* dir is the host's own
(`OPENCODE_CONFIG_DIR`, default `~/.config/opencode`), mounted directly,
while its *data* dir (auth + long-term logs/sessions) stays staged per run.
Every other harness gets a **per-run stage directory** on the host
(`$HOME/workspace/$container_name/...`) RW-mounted into the container at the
harness's expected home-relative path, so state written inside the sandbox
survives the container's death. Secrets never follow this path — they
are loaded host-side once (lib/environment.sh — the explicit chain) and forwarded through the
`workload_env` allowlist (`CLINE_API_KEY`, `MISTRAL_API_KEY`, `PEER_API_KEY`,
`OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `HF_TOKEN`, `GEMINI_API_KEY`).

| Harness | Host dir | Container mount (RW) | Env pinned in launch.sh | What it preserves |
|---|---|---|---|---|
| pi (`pi-coding-agent`) config | `$HOME/.pi/agent` (host, permanent) | `/home/$USER/.pi/agent` | `PI_CODING_AGENT_DIR` | settings.json, models.json, skills |
| pi (`pi-coding-agent`) sessions | `$stage/pi/sessions` (per run) | `/home/$USER/.pi/sessions` | `PI_CODING_AGENT_SESSION_DIR` | sessions (docs/d054) |
| OpenCode config | `$HOME/.config/opencode` (host, permanent; `OPENCODE_CONFIG_DIR` override) | `/home/$USER/.config/opencode` | `OPENCODE_CONFIG_DIR` | opencode.json overlay (generator-installed; a missing overlay is a tolerated partial config, docs/d065) |
| OpenCode data | `$stage/opencode/data` (per run) | `/home/$USER/.local/share/opencode` | — | auth.json, long-term logs (log/), sessions (project/…/storage) |
| Cline (CLI) | `$stage/cline` | `/home/$USER/.cline` | `CLINE_DIR`, `CLINE_DATA_DIR` | data/settings/providers.json, global-settings.json, cline_mcp_settings.json, sessions/, db/, workflows/, rules/, hooks/, skills/, agents/, plugins/, cron/ |
| ThinkRail | `$stage/thinkrail` | `/home/$USER/.thinkrail` | `THINKRAIL_DATA_DIR` | projects.json, workspaces.json, terminals.json, installation.json, app config |

Notes:

- **Workspace project state needs no mount**: project-scoped harness dirs
  (`.cline/`, `.thinkrail/` inside a repo; pi's project config) live under the
  workspace, which is already RW-mounted at its real host path. Only the
  home-relative *global* state dirs are staged per run — except pi's config
  dir (docs/d054) and opencode's config dir (docs/d065), which are mounted
  directly.
- **Extra directories are explicit mounts**: `run.sh [DIRECTORY [DIRECTORY...]]`
  mounts each argument rw — the host side canonical, the container side at
  the container's home spelling for a home-relative path (CWD is the implicit
  first directory, and the first directory is the workdir; docs/d068). The
  `~/Downloads/references` mirror is passed this way; the former
  `CODING_AGENT_REFERENCES` env toggle is retired (docs/d056).
- **No Hugging Face cache mount (docs/d066)**: the host HF cache is no longer
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
  pi mount covers ThinkRail's pi config; the session dir follows
  `PI_CODING_AGENT_SESSION_DIR`, which the launch chain exports.
- **Explicit env pins** (`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`,
  `OPENCODE_CONFIG_DIR`, `CLINE_DIR`,
  `CLINE_DATA_DIR`, `THINKRAIL_DATA_DIR`) are exported by the generated
  in-container launch chain. Most duplicate each harness's built-in default —
  they exist to make the sandbox contract explicit and resilient to upstream
  default changes.
- **Init seeding**: run.sh seeds nothing per run for pi or OpenCode anymore —
  the generator installs pi's config into `$HOME/.pi/agent` (docs/d054) and
  opencode's `opencode.json` into the host config dir, refreshing the
  committed `coding-agent/opencode.jsonc` alongside (docs/d065). A missing
  opencode overlay is only warned about at launch (partial config
  tolerated); a missing pi artifact aborts. A populated
  `auth.json` in the pi agent dir aborts the run — pi's own empty `{}`
  (re-created on every start) is ignored (d052/d054); opencode needs no
  gate because its `auth.json` lives in the never-host-mounted data dir
  (d065). Cline and ThinkRail have no committed
  fallback config — they self-initialize on first
  in-container use (`cline auth`, first ThinkRail launch), and the RW mount
  persists the result.
- **VS Code Cline extension state is intentionally out of scope**: the IDE
  extension's globalStorage (`~/.config/Code/User/globalStorage/saoudrizwan.claude-dev`)
  is irrelevant in this headless container; the CLI's `~/.cline` root is the
  shared store per Cline's docs.
- The launch chain (and its `exec bash`) is generated per run at
  `$stage/launch.sh` and ro-mounted as `/opt/agentcontainer-launch.sh`; it is
  not part of preserved state.

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
see [archive/bwrap-runtime-audit.md](archive/bwrap-runtime-audit.md).

Relevance to persistence: a bwrap runtime, if added as a workload runtime
alternative to podman in `lib/workload-runtime.sh`, would replace
`workload_rw`/`workload_ro` bind mounts with equivalent `--bind`/`--ro-bind`
flags — the harness persistence table above is the mount manifest that such
a bwrap runtime must reproduce 1:1 (note bwrap has no named-volume or
`--relabel` equivalent for SELinux; host-side staging dirs like
`$workload_stage/*` remain the right persistence mechanism under either
runtime).

