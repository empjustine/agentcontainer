#!/bin/sh

set -xe

for mdoel in \
	unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL \
	unsloth/gemma-4-26B-A4B-it-qat-GGUF:UD-Q4_K_XL \
	unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q8_K_XL \
	unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL \
	unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL \
	unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL \
	unsloth/gemma-4-31B-it-GGUF:UD-Q8_K_XL \
	unsloth/Qwen3.6-27B-GGUF:UD-Q8_K_XL \
	byteshape/Qwen3.6-35B-A3B-GGUF:Q4_K_S \
	unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q8_K_XL \
	byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF:IQ4_XS \
	unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF:UD-Q8_K_XL \
	unsloth/granite-4.1-3b-GGUF:UD-Q8_K_XL \
	unsloth/granite-4.1-8b-GGUF:UD-Q8_K_XL; do
	~/agentcontainer/-openai-completions-download.sh "$mdoel"
done
