#!/bin/sh
# Generate the split peers-only llama-swap config into config.d/
# (docs/d018-split-config-d.md).  run.sh only serves; run this to refresh.
# Provider keys come from .env (see .env.example).  No local-llm generator:
# termux is peers-only.
#
#   generate-general.yaml.js          -> 00-general.yaml        (globals+macros+ctxWindows)
#   generate-peer-openrouter.yaml.js  -> 20-peer-openrouter.yaml (peers.openrouter)
#   generate-peer-opencode.yaml.js    -> 21-peer-opencode.yaml  (peers.opencode+opencode-go)

script_dir="$(cd "$(dirname "$0")" && pwd)"
config_d="$script_dir/config.d"
env_file="$script_dir/.env"

_gen() {
	if [ -f "$env_file" ]; then
		node --env-file "$env_file" "$script_dir/$1" || \
			>&2 printf "warning: %s failed; using existing config.d/ if present\n" "$1"
	else
		node "$script_dir/$1" || \
			>&2 printf "warning: %s failed; using existing config.d/ if present\n" "$1"
	fi
}

_gen generate-general.yaml.js
_gen generate-peer-openrouter.yaml.js
_gen generate-peer-opencode.yaml.js
echo "config.d/ generated in $config_d"
