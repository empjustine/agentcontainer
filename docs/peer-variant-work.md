# Work (nonfree-world) peer variant

> **ARCHIVED.** The `coding-agent-peer/` folder is gone from the live tree —
> the coding-agent squash folded the peers-only usage variant into
> `coding-agent/` itself (static provider config + layered generation, see
> `coding-agent/merge-models-json.mjs` for the layer contract and
> [environments-and-peer-variants.md](environments-and-peer-variants.md)).
> This note is kept as historical reference.

Implements the **work** environment from
[environments-and-peer-variants.md](environments-and-peer-variants.md):
WSL2 under rootful docker with **no direct cloud access**, so the coding agent
only ever talks to a peer endpoint.

## Layout

```
coding-agent-peer/
├── run.sh           # Simplified container launch (static config, no generation)
├── settings.json    # Static pi settings (retry, terminal config)
├── models.json      # Static Custom Models provider config (peer override)
└── .env             # PEER_API_KEY / PEER_BASE_URL (gitignored)
```

## How it works

Unlike the bazzite `coding-agent/run.sh`, which dynamically generates
static `settings.json` and a `models.json` via `coding-agent/generate-models.json.js`,
the work variant **ships static files**
that are copied into the container's `~/.pi/agent/` directory.

### `models.json` — peer endpoint override

A static pi `models.json` (Custom Models provider config) that overrides the
built-in `opencode` and `opencode-go` providers with the peer endpoint:

```json
{
  "providers": {
    "opencode-go": { "baseUrl": "http://10.90.17.20:8080/v1", "apiKey": "$PEER_API_KEY" },
    "opencode": { "baseUrl": "http://10.90.17.20:8080/v1", "apiKey": "$PEER_API_KEY" }
  }
}
```

- **baseUrl** is hardcoded to the peer's address (not sensitive — it's the
  local llama-swap endpoint). The `.env.example` value should match.
- **apiKey** is `$PEER_API_KEY` — pi resolves this at request time from the
  container env (injected via `--env-file coding-agent-peer/.env`). The secret
  never touches disk in `models.json`.

> **Note**: pi interpolates `$ENV_VAR` only in `apiKey`/`headers`, never in
> `baseUrl` — hence the hardcoded URL.

### `.env` — secrets

```
PEER_API_KEY=<your-secret-key>
PEER_BASE_URL=http://10.90.17.20:8080/v1
```

- `.env` is gitignored (via the `*.env` pattern in `.gitignore`;
  `coding-agent-peer/.env` is **not** tracked).
- `PEER_BASE_URL` is **informational** — the peer baseUrl is hardcoded in
  `models.json`. Set it locally for documentation/reference, but changing it
  won't affect pi's behavior until `models.json` is updated.
- To set up: copy the values from your environment and re-run `run.sh`.

### `settings.json` — pi settings

Ships the same retry/terminal settings as the bazzite variant's generated
output:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 9,
    "baseDelayMs": 10000,
    "provider": { "timeoutMs": 600000 }
  },
  "editorPaddingX": 0,
  "outputPad": 0,
  "showCacheMissNotices": true,
  "terminal": { "showTerminalProgress": false }
}
```

## Container run

`run.sh` sources `lib/workload-runtime.sh`, creates the `.pi/agent/` directory,
copies `settings.json` and `models.json` into it, and launches the container:

```sh
"$_container_tool" container run -it --rm --init \
    ${_userns} \
    --user "$(id -u):$(id -g)" \
    ${_keep_groups} \
    -v "${workspace}:${workspace}:z${_vol_u}" --workdir "${workspace}" \
    -v "${pi_dir}:/home/dev/.pi:Z${_vol_u}" \
    -v "${HOME}/agentcontainer:/home/dev/agentcontainer:z,ro" \
    --network=host \
    --name "$container_name" --hostname "$container_name" \
    --env-file ~/agentcontainer/coding-agent-peer/.env \
    "$tag"
```

Key differences from bazzite `coding-agent/run.sh`:

| Aspect | bazzite (`coding-agent/`) | work (`coding-agent-peer/`) |
|--------|--------------------------|-----------------------------|
| Config generation | dynamic (`generate-pi-*.js`) | static files |
| Models source | live `/models` fetches | peer endpoint only |
| Container network | `--network=host` | `--network=host` |
| HF cache mount | yes (read-only) | no (no local models) |
| Env file | `coding-agent/.env` | `coding-agent-peer/.env` |

## Relationship to PEERS_ONLY=1

The work variant is conceptually similar to running `openai-completions-peer/run.sh`
with `PEERS_ONLY=1` (cloud peers only, no local models) — but on the **usage**
side rather than the serving side. The work variant's coding-agent container
talks to a peer endpoint (either the local bazzite llama-swap, or an OCI
peers-only instance) instead of directly to paid cloud providers.
