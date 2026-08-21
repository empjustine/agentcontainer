#!/bin/sh

set -x

# shellcheck disable=SC1091
. "$(dirname "$0")/../container-tool.sh"

workspace="$(pwd)"
if [ "$workspace" = "$HOME" ]; then
	>&2 printf "fatal: can't protect HOME\n"
	exit 90
fi
if ! infisical login --domain="$INFISICAL_API_URL" --log-level=info status; then
	exit 127
fi

# Regenerate pi's models.json (Infisical-backed env) and copy both agent
# artifacts into the mounted ~/.pi/agent before the container starts.
"$SCRIPT_DIR/generate.sh"

container_name="agentcontainer-$(date +'%Y%m%d%H%M%S%3N')"
sandbox_stage="$HOME/workspace/$container_name"
agent_dir="$sandbox_stage/pi/agent"
opencode_cfg_dir="$sandbox_stage/opencode/config"
opencode_data_dir="$sandbox_stage/opencode/data"

mkdir -p -- "$agent_dir" "$opencode_cfg_dir" "$opencode_data_dir"
cp "$SCRIPT_DIR/settings.json" "$agent_dir/settings.json"
[ -f "$SCRIPT_DIR/models.json" ] && cp "$SCRIPT_DIR/models.json" "$agent_dir/models.json"
[ -f "$SCRIPT_DIR/opencode.jsonc" ] && cp "$SCRIPT_DIR/opencode.jsonc" "$opencode_cfg_dir/opencode.json"

HF_HUB_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/huggingface/hub"

sandbox_name     "$container_name"
sandbox_image    'localhost/empjustine/coding-agent:latest'
sandbox_interactive
sandbox_init
sandbox_network  host
sandbox_user
sandbox_ro_if    "$HOME/Downloads/references" "$HOME/Downloads/references"
#sandbox_ro_if    "$HF_HUB_CACHE" /home/${USER}/.cache/huggingface/hub
sandbox_rw       "$agent_dir" /home/${USER}/.pi/agent
sandbox_rw       "$HF_HUB_CACHE" /home/${USER}/.cache/huggingface/hub
sandbox_rw       "$opencode_cfg_dir" /home/${USER}/.config/opencode
sandbox_rw       "$opencode_data_dir" /home/${USER}/.local/share/opencode
sandbox_rw       "$workspace" "$workspace"
sandbox_workdir  "$workspace"
sandbox_env      HF_TOKEN
sandbox_env      CLINE_API_KEY
sandbox_env      OPENCODE_API_KEY
sandbox_env      OPENROUTER_API_KEY
sandbox_env      PEER_API_KEY
sandbox_cmd      bash
sandbox_run infisical run --domain="$INFISICAL_API_URL" --projectId="$INFISICAL_PROJECT_ID" --log-level=info --env=prod --path=/inference --
