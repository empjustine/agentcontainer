#!/bin/sh
# Generate the split llama-swap config into config.d/ (docs/d018).  Each
# generator owns a disjoint concern; llama-swap merges the files at startup
# via -config-dir.  Provider keys come from .env (see .env.oci.example);
# without them the generators omit apiKey refs and skip peers as appropriate.
#
#   generate-general.yaml.js          -> 00-general.yaml        (globals+macros+ctxWindows)
#   generate-local-llm-models.yaml.js -> 10-local-llm-inference.yaml (local GGUF)
#   generate-peer-openrouter.yaml.js  -> 20-peer-openrouter.yaml (peers.openrouter)
#   generate-peer-opencode.yaml.js    -> 21-peer-opencode.yaml  (peers.opencode+opencode-go)

script_dir="$(cd "$(dirname "$0")" && pwd)"
env_file="$script_dir/.env"
config_d="$script_dir/config.d"

_gen() {
	if [ -f "$env_file" ]; then
		mise exec node@24 -- node --env-file "$env_file" "$script_dir/$1" || \
			>&2 printf "warning: %s failed; using existing config.d/ if present\n" "$1"
	else
		mise exec node@24 -- node "$script_dir/$1" || \
			>&2 printf "warning: %s failed; using existing config.d/ if present\n" "$1"
	fi
}

_gen generate-general.yaml.js
_gen generate-local-llm-models.yaml.js
_gen generate-peer-openrouter.yaml.js
_gen generate-peer-opencode.yaml.js
echo "config.d/ generated in $config_d"
