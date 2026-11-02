---
base_model:
- CohereLabs/North-Mini-Code-1.0
inference: false
library_name: transformers
license: apache-2.0
tags:
- conversational
- unsloth
- chat
- code
- agent
---
<div>
<p style="margin-top: 0;margin-bottom: 0;">
    <em><a href="https://docs.unsloth.ai/basics/unsloth-dynamic-v2.0-gguf">Unsloth Dynamic 2.0</a> achieves superior accuracy & outperforms other leading quants.</em>
  </p>
  <div style="display: flex; gap: 5px; align-items: center; ">
    <a href="https://github.com/unslothai/unsloth/">
      <img src="https://github.com/unslothai/unsloth/raw/main/images/unsloth%20new%20logo.png" width="133">
    </a>
    <a href="https://discord.gg/unsloth">
      <img src="https://github.com/unslothai/unsloth/raw/main/images/Discord%20button.png" width="173">
    </a>
    <a href="https://docs.unsloth.ai/">
      <img src="https://raw.githubusercontent.com/unslothai/unsloth/refs/heads/main/images/documentation%20green%20button.png" width="143">
    </a>
  </div>
</div>


## Run these GGUFs with llama.cpp

These are GGUF quants of North-Mini-Code-1.0. The model uses the `cohere2moe` architecture, which is not in a stock llama.cpp release yet. Until [llama.cpp PR #24260](https://github.com/ggml-org/llama.cpp/pull/24260) is merged, build llama.cpp from that PR branch to load these files. Once the PR lands in a release, these same GGUFs will run on stock llama.cpp with no re-download, because they already declare `general.architecture = cohere2moe`.

### 1. Build llama.cpp from PR #24260

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
git fetch origin pull/24260/head:cohere2-moe
git checkout cohere2-moe

# CUDA build. Drop -DGGML_CUDA=ON for a CPU only build.
cmake -B build -DGGML_CUDA=ON
cmake --build build --config Release -j
```

The binaries are written to `build/bin/` (`llama-cli`, `llama-server`, `llama-quantize`).

### 2. Download a quant

```bash
pip install huggingface_hub

hf download unsloth/North-Mini-Code-1.0-GGUF \
  --include "North-Mini-Code-1.0-UD-Q4_K_XL.gguf" \
  --local-dir North-Mini-Code-1.0-GGUF
```

Every quant here is a single file except `BF16/`, which is split into two shards. To use a split set, download the whole folder and point llama.cpp at the first shard (`...-00001-of-00002.gguf`); it loads the rest automatically.

### 3. Run

Interactive chat with llama-cli:

```bash
./build/bin/llama-cli \
  --model North-Mini-Code-1.0-GGUF/North-Mini-Code-1.0-UD-Q4_K_XL.gguf \
  --jinja \
  --n-gpu-layers 99 \
  --ctx-size 16384 \
  --temp 1.0 --top-p 0.95 \
  -p "Write a python program to check if a string is a palindrome."
```

OpenAI compatible server with llama-server:

```bash
./build/bin/llama-server \
  --model North-Mini-Code-1.0-GGUF/North-Mini-Code-1.0-UD-Q4_K_XL.gguf \
  --jinja \
  --n-gpu-layers 99 \
  --ctx-size 16384 \
  --host 0.0.0.0 --port 8080
```

Then query it:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Write a python program to check if a string is a palindrome."}],
    "temperature": 1.0,
    "top_p": 0.95
  }'
```

Notes:

- Pass `--jinja` so the model chat template, including tool calling, is applied.
- Recommended sampling settings are `temperature=1.0` and `top_p=0.95`.
- Set `--n-gpu-layers 99` to offload all layers to GPU, or lower it to fit your VRAM. Use `--ctx-size` to set the context window (the model supports up to 256K).
- `imatrix_unsloth.gguf_file` is the importance matrix used to build these quants. It is not a model and is not loaded at runtime.

# **Model Card for North Mini Code**

## **Model Summary**

North Mini Code is an open weights research release of a 30B-A3B parameter model optimized for code generation, agentic software engineering, and terminal tasks.

Developed by: [Cohere](https://cohere.com/) and [Cohere Labs](https://cohere.com/research)

* Point of Contact: [**Cohere Labs**](https://cohere.com/research)  
* License: Apache 2.0
* Model: North Mini Code  
* Model Size: 30B total; 3B active  
* Context length: 256K & 64K max output

For more details about this model, please check out our [blog post](https://huggingface.co/blog/CohereLabs/introducing-north-mini-code). 

**Try North Mini Code**

You can try out North Mini Code before downloading the weights in OpenCode and our hosted [Hugging Face Space](https://huggingface.co/spaces/CohereLabs/North-Mini-Code-1.0).

**Evaluation**

![image1](https://cdn-uploads.huggingface.co/production/uploads/62668f725fb8d521d94d8451/xR7kZ3X9RKEZrbgD6hpG1.png)

<details>
<summary><span style="font-size: 80%;"><b>Benchmarking Methodology [CLICK TO EXPAND]</span></b></summary>

- <span style="font-size: 80%;">We used SWE-Bench Verified, SWE-Bench Pro, Terminal-Bench v2, and Terminal-Bench Hard to benchmark North Mini Code's agentic coding capabilities. For evaluation harnesses, we used the Swe-Agent harness v1.1.0 for SWE-Bench, and a simple ReAct harness employing a single terminal-use tool based on Harbor's Tmux session implementation for Terminal-Bench v2. For Terminal Bench Hard, we directly used Terminus-2, following the same methodology as the Artificial Analysis Intelligence Index to compare North-Mini-Code-1.0 with the other models. Additionally, we used SciCode and LiveCodeBench v6 as complex code-generation benchmarks outside of tool use.</span>
- <span style="font-size: 80%;">We run each benchmark with 3 different seeds and report the average benchmark performance, using temperature=1.0 and top\_p=0.95. We used publicly reported scores for competitor models, either from original reports or the Artificial Analysis Intelligence Index, where available. Additionally, Gemma4’s scores for agentic coding tasks were reported by [Qwen team](https://qwen.ai/blog?id=qwen3.6-35b-a3b). For benchmark results that any public report is missing, denoted by (\*) in the figure, we run them internally using the recommended model configuration.</span>
</details>

**Usage**

Please install transformers from the source repository that includes the necessary changes for this model. We recommend using the following set of sampling parameters for generation: \`temperature=1.0\`, \`top\_p=0.95\`.

```py
# pip install transformers
from transformers import AutoTokenizer, AutoModelForCausalLM

model_id = "CohereLabs/North-Mini-Code-1.0"
tokenizer = AutoTokenizer.from_pretrained(model_id)
model = AutoModelForCausalLM.from_pretrained(model_id)

prompt = "Write a python program to check if a string is a palindrome or not."

# Format message with the North-Mini-Code-1.0 chat template
messages = [{"role": "user", "content": prompt}]
input_ids = tokenizer.apply_chat_template(
    messages,
    tokenize=True,
    add_generation_prompt=True,
    return_tensors="pt",
)

gen_tokens = model.generate(
    **input_ids, 
    max_new_tokens=1024, 
    do_sample=True, 
    temperature=1.0,
    top_p=0.95
)

gen_text = tokenizer.decode(gen_tokens[0])
print(gen_text)
```

You can also use the model directly using transformers `pipeline` abstraction:

```py
from transformers import pipeline
import torch

model_id = "CohereLabs/North-Mini-Code-1.0"

prompt = """Given a list of unique words each of size k and an n sized word, w, where n is a multiple of k,
Write a program in python to determine the number of unique combinations of words in the list that can be concatenated to form an anagram of the word w.
"""

pipe = pipeline(
    "text-generation",
    model=model_id,
    torch_dtype="auto",
    device_map="auto",
)

messages = [
    {"role": "user", "content": f"{prompt}"},
]

text = tokenizer.apply_chat_template(
    messages,
    tokenize=False,
    add_generation_prompt=True,
)


outputs = pipe(
    messages,
    max_new_tokens=1024,
    do_sample=True, 
    temperature=1.0,
    top_p=0.95

)

print(outputs[0]["generated_text"][-1])

```

## **Model Details**

**Input**: Text only.

**Output**: Model generates text. 

**Model Architecture**: North-Mini-Code-1.0 is a decoder-only Transformer-based sparse Mixture-of-Experts model. It uses an efficient attention implementation, interleaved between sliding-window attention with RoPE and global attention with no positional embeddings, in a 3:1 ratio. The feed-forward block is an MoE block with 128 experts, of which 8 are activated per token. Each expert block is an FFN block with SwiGLU activation. The router applies a sigmoid activation function to the logits before the top-k selection. We also use a single dense layer before the sparse layers. North-Mini-Code-1.0 was post-trained using a two-stage cascaded supervised fine-tuning (SFT) followed by reinforcement learning with verifiable rewards (RLVR), focusing on agentic coding.  For more technical details, please check out our [blog post](https://huggingface.co/blog/CohereLabs/introducing-north-mini-code). 

**Context Length:** North-Mini-Code-1.0 supports a context length of 256K & 64K output length.

### **Tool Use Capabilities:**

North-Mini-Code-1.0 has been specifically trained with tool-use capabilities for agentic coding.

Tool use with North-Mini-Code-1.0 is supported through [chat templates](https://huggingface.co/docs/transformers/main/en/chat_templating#advanced-tool-use--function-calling) in Transformers. We recommend providing tool descriptions using JSON schema.

**Tool Use Example \[CLICK TO EXPAND\]** 

```py
# Define tools
tools = [{
  "type": "function",
  "function": {
    "name": "bash",
    "description": "Execute a bash command in the terminal.",
    "parameters": {
      "type": "object",
      "properties": {
        "command": {
          "description": "The bash command to execute.",
          "type": "string"
        }
      },
      "required": ["command"]
    },
  }
}]

# Define conversation input
conversation = [{"role": "user", "content": "Find out if there is any json file in this folder"}]


# Get the Tool Use prompt
input_prompt = tokenizer.apply_chat_template(conversation=conversation, tools=tools, tokenize=False, add_generation_prompt=True, return_tensors="pt")

# Tokenize the prompt
input_ids = tokenizer(input_prompt, return_tensors="pt")
```

You can then generate from this input as normal.

North Mini Code, similarly as all the other Cohere agent models released to date, supports [interleaved thinking](https://docs.vllm.ai/en/latest/features/interleaved_thinking/) and works best when turned on. You’re strongly encouraged to pass on all the model-generated thinking contents to future agentic steps, and chat turns for the best model performance. Please refer to the linked vllm doc and see how it’s done.

If the model generates thinking content and tool calls, you should add both of them to the chat history like so:

```py
# Pass on the tool_call and thinking
tool_call = {"name": "bash", "arguments": {"command": "ls -al"}}
reasoning = "The user wants to find if there are any JSON files in the current folder. I should use the `ls` command to list files and then check if there are any JSON files (files ending with .json). Let me first list the files in the current directory."

conversation.append({"role": "assistant", "tool_calls": [{"id": "0", "type": "function", "function": tool_call}], "reasoning": reasoning})
```

and then call the tool and append the result, as a dictionary, with the tool role, like so:

```py
# This needs to be a dictionary
tool_result = {"stdout": "test.json\ntest.py", "return_code": "0"} 

# Append tool results
conversation.append({"role": "tool", "tool_call_id": "0", "content": tool_result})
```

After that, you can `generate()` again to let the model use the tool result in the chat.

Note that this was a very brief introduction to tool calling \- for more information the Transformers [tool use documentation](https://huggingface.co/docs/transformers/main/chat_templating#advanced-tool-use--function-calling).

### **vLLM**

You can also run the model in vLLM. Please use vLLM main for North Mini Code until a new release is available, and accurate response parsing also requires installing Cohere’s melody library.

```shell
uv pip install "git+https://github.com/vllm-project/vllm.git"
uv pip install cohere_melody>=0.9.0
```

Then the vllm server can be started with the following command:

```shell
vllm serve CohereLabs/North-Mini-Code-1.0 \
  -tp 2 \
  --max-model-len 320000 \
  --tool-call-parser cohere_command4 \
  --reasoning-parser cohere_command4 \
  --enable-auto-tool-choice
```

**Use locally deployed North Mini Code in OpenCode:**

Please use OpenCode main branch until a new release is available.

```shell
# Example commands to install on linux
git clone https://github.com/anomalyco/opencode.gitcd opencode

# Install Bun
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# node-gyp was needed by a dependency
bun add -g node-gyp

# Install dependencies
bun install

# Build CLI
bun run --cwd packages/opencode build/usr/bin/install -m 755 \
  ./opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode \
  /root/.local/bin/opencode
```

To use locally deployed North Mini Code in Opencode, please use this config which enables interleaved reasoning:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "vllm/CohereLabs/North-Mini-Code-1.0",
  "provider": {
    "vllm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local vLLM server",
      "options": {
        "baseURL": "http://127.0.0.1:8000/v1",
        "apiKey": "EMPTY"
      },
      "models": {
        "North-Mini-Code-1.0": {
          "name": "North-Mini-Code-1.0",
          "interleaved": {
            "field": "reasoning"
          },
          "limit": {
            "context": 256000,
            "output": 64000
          }
        }
      }
    }
  }
}

```

## **Model Card Contact**

For errors or additional questions about details in this model card, contact \[labs@cohere.com\].