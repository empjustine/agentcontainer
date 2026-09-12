# Coding-Harness Persistence Table

How `coding-agent/run.sh` preserves each coding harness's state across
ephemeral container runs. For the planned hardening of this mechanism into a
data diode (state may flow out, but can never be rewritten or deleted from
inside the container), see `docs/d026-data-diode-audit.md` — design note only,
not yet implemented. Every harness gets a **per-run stage directory** on
the host (`$HOME/workspace/$container_name/...`) RW-mounted into the container
at the harness's expected home-relative path, so state written inside the
sandbox survives the container's death. Secrets never follow this path — they
are loaded host-side once (lib/environment.sh — the explicit chain) and forwarded through the
`workload_env` allowlist (`CLINE_API_KEY`, `MISTRAL_API_KEY`, `PEER_API_KEY`,
`OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `HF_TOKEN`, `GEMINI_API_KEY`,
`PEER_BASE_URL`).

| Harness | Host stage dir (per run) | Container mount (RW) | Env pinned in launch.sh | What it preserves |
|---|---|---|---|---|
| pi (`pi-coding-agent`) | `$stage/pi/agent` | `/home/$USER/.pi/agent` | `AGENT_DIR` | settings.json, models.json, sessions, skills |
| OpenCode | `$stage/opencode/config` | `/home/$USER/.config/opencode` | `OPENCODE_CFG_DIR` | opencode.json, global config/cache |
| OpenCode | `$stage/opencode/data` | `/home/$USER/.local/share/opencode` | — | auth.json, session/state data |
| Cline (CLI) | `$stage/cline` | `/home/$USER/.cline` | `CLINE_DIR`, `CLINE_DATA_DIR` | data/settings/providers.json, global-settings.json, cline_mcp_settings.json, sessions/, db/, workflows/, rules/, hooks/, skills/, agents/, plugins/, cron/ |
| ThinkRail | `$stage/thinkrail` | `/home/$USER/.thinkrail` | `THINKRAIL_DATA_DIR` | projects.json, workspaces.json, terminals.json, installation.json, app config |
| Hugging Face | `$HF_HUB_CACHE` (host cache) | `/home/$USER/.cache/huggingface/hub` | — | model hub cache (shared, not per-run staged) |

Notes:

- **Workspace project state needs no mount**: project-scoped harness dirs
  (`.cline/`, `.thinkrail/` inside a repo; pi's project config) live under the
  workspace, which is already RW-mounted at its real host path. Only the
  home-relative *global* state dirs are staged per run.
- **pi↔ThinkRail share `~/.pi/agent`**: ThinkRail runs pi in-process and
  resolves the same agent dir (`getAgentDir()` → `~/.pi/agent`), so the single
  pi mount covers both.
- **Explicit env pins** (`AGENT_DIR`, `OPENCODE_CFG_DIR`, `CLINE_DIR`,
  `CLINE_DATA_DIR`, `THINKRAIL_DATA_DIR`) are exported by the generated
  in-container launch chain. Most duplicate each harness's built-in default —
  they exist to make the sandbox contract explicit and resilient to upstream
  default changes.
- **No fallback seeding beyond pi/OpenCode**: run.sh copies committed
  `settings.json` / `models.json` (pi) and `opencode.jsonc` (OpenCode) into the
  stage dirs before generation; Cline and ThinkRail have no committed fallback
  config — they self-initialize on first in-container use (`cline auth`,
  first ThinkRail launch), and the RW mount persists the result.
- **VS Code Cline extension state is intentionally out of scope**: the IDE
  extension's globalStorage (`~/.config/Code/User/globalStorage/saoudrizwan.claude-dev`)
  is irrelevant in this headless container; the CLI's `~/.cline` root is the
  shared store per Cline's docs.
- The launch chain (and its `exec bash`) is generated per run at
  `$stage/launch.sh` and ro-mounted as `/opt/agentcontainer-launch.sh`; it is
  not part of preserved state.

Sources verified against reference clones
(`~/Downloads/references/github/`): Cline
(`cline/cline/docs/getting-started/config.mdx` — `~/.cline` layout,
`CLINE_DATA_DIR` replaces only `~/.cline/data`) and ThinkRail
(`JetBrains/thinkrail/packages/server/src/persistence/persistence.ts` —
`dataDir()` = `THINKRAIL_DATA_DIR` ?? `~/.thinkrail`; pi agent dir reuse via
`packages/server/src/agent/piRuntime.ts`).

---

## Appendix: bwrap (bubblewrap) usage audit — cross-reference (2026-09-10)

A mirror-tree search for `bwrap`/`bubblewrap` found exactly one real code
consumer: **mini-swe-agent**
(`SWE-agent/mini-swe-agent/src/minisweagent/environments/extra/bubblewrap.py`,
an experimental, Windows-unsupported sandbox environment). All its flags
(`--unshare-user-try`, `--ro-bind`, `--bind`, `--chdir`, `--tmpfs`, `--proc`,
`--dev`, `--new-session`, `--setenv`) were verified flag-by-flag against the
upstream clone `~/Downloads/references/github/containers/bubblewrap`
(`bwrap.xml` man page + `bubblewrap.c`) and are all real, documented options
used in a semantically correct minimal-sandbox layout — **verdict:
plausible**. Full audit (flag table, semantic checks against upstream
`README.md`, and adoption caveats for a possible `bwrap` workload runtime
tier — missing `--die-with-parent`, no `--unshare-net`, no device binds):
see [bwrap-runtime-audit.md](bwrap-runtime-audit.md).

Relevance to persistence: a bwrap runtime, if added as a workload runtime
alternative to podman in `lib/workload-runtime.sh`, would replace
`workload_rw`/`workload_ro` bind mounts with equivalent `--bind`/`--ro-bind`
flags — the harness persistence table above is the mount manifest that such
a bwrap runtime must reproduce 1:1 (note bwrap has no named-volume or
`--relabel` equivalent for SELinux; host-side staging dirs like
`$workload_stage/*` remain the right persistence mechanism under either
runtime).

