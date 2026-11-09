---
id: d153
type: module-design
status: draft
title: "d153 — spike: do minimal agents over a familiar runtime beat a tuned code-mode sandbox?"
parent: coding-agent
depends-on: [d150, codemode-runtime-prior-art, d152]
references: [d116, d149, d150, d152, codemode-runtime-prior-art, mini-swe-agent]
tags: ["agent", "codemode", "minimal-agent", "performance", "spike"]
---

# d153 — spike: do minimal agents over a familiar runtime beat a tuned code-mode sandbox?

The claim under test: **an agent whose only interface is a runtime the model already knows — a
bash or Python shell — performs better than an agent whose interface is a bespoke sandbox with a
small, intentional tool surface**, and the difference comes from familiarity rather than from
scaffold quality. This record assembles what the farm can say about that claim, states the
mechanism precisely enough to be measured, and designs the measurement. It reports no result:
nothing here was benchmarked.

Scope is the runtime and tool surface a coding agent presents, not the harness choice (d116),
not the prompt and gating mechanics (d149), not the four harnesses' Code Mode implementations
(d150). d152 owns the Python-runtime feasibility question that this record's answer would feed.

Sources are bare mirrors under `~/Downloads/references/`, cited `<repo>:<path>` at the tips
named in the survey's Re-verify table, plus the installed `pi` 1.5.0 docs.
**Benchmark percentages below are their authors' published numbers, not reproductions**, and no
project's interface was run side by side with another on this tree's tasks.

## Status

Draft spike. It states a hypothesis, the evidence for and against it, and an experiment design.
No experiment ran, no settings changed, and the record recommends no interface.

## The claim, split into three

The sentence above bundles three assertions, and only the third is new.

1. **A minimal agent is competitive.** One tool, a short prompt, a linear loop, no scaffolding.
   This is claimed by mini-swe-agent and Agentless with published numbers.
2. **The interface matters.** Tool design and interaction shape change outcomes independently of
   the model. This is claimed by SWE-agent's ACI work, which is the project least sympathetic to
   assertion 1.
3. **Familiarity is the reason.** Between two interfaces that are both well designed, the one
   that looks like a runtime in the model's training corpus wins. This is the assertion no
   project on the farm measures, and it is the one this tree cares about, because its agent
   runs in a QuickJS sandbox that intentionally is not Node.

Assertions 1 and 2 are compatible, and the evidence says they are both true at once. What is
missing is the mechanism in assertion 3, which is why most of this record is a table of
specific mismatches rather than a comparison of philosophies.

## Evidence for the minimal-agent half

**mini-swe-agent** presents exactly one tool, bash, and executes each action with
`subprocess.run` from a ~190-line synchronous loop with two Jinja templates; it does not depend
on a tool-calling API at all (`SWE-agent/mini-swe-agent.git:src/minisweagent/agents/default.py`,
`README.md`). The README reports more than 74% on SWE-bench verified and states that it beats
Claude Code and Codex on DeepSWE. Those are vendor numbers, and the important part for this
record is the shape: **the model's whole interface is a shell and a working directory**, and the
project's own framing is that most agent scaffolding is unnecessary.

**Agentless** goes further and removes the agent: localize, repair, validate, in three fixed
phases with no tool loop at all. The README reports 27.3% on SWE-bench Lite at $0.34 per issue,
and 40.7% / 50.8% with Claude 3.5 Sonnet. If a fixed pipeline with no model-chosen actions
reaches a third to a half of the benchmark, then much of what agent harnesses add is not the
source of capability.

**SWE-agent** is the counterweight and says so first: the agent-computer interface (ACI) is a
design problem of the same order as prompt engineering, and "a baseline agent without a
well-tuned ACI does much worse" (`SWE-agent/SWE-agent.git:docs/background/aci.md`, paper
arXiv 2405.15793). Its four worked examples are all about the _surface_ of an interaction rather
than its existence: a linter that rejects a malformed edit before it lands, a file viewer that
shows 100 lines per turn with scroll and search, a search command that lists only matching
files, and an explicit message when a search returned nothing. None of those are language
features and all of them are output or error shaping.

The synthesis that matters here: both camps agree the interface decides outcomes. They disagree
about where the interface comes from — designed for the model (SWE-agent) or inherited from the
machine (mini-swe-agent). Assertion 3 is the untested middle: _inherited_ wins because the model
has seen it, not because inheritance is better design.

## Evidence for the familiarity half: none, measured

Nothing on the farm compares two runtime shapes on the same model and tasks. The closest
material is mechanism-level, and it splits into two kinds.

**Projects that treat familiarity as a design input.** mini-swe-agent's premise is that a shell
needs no teaching. `vercel/ai`'s sandbox abstraction keeps one bash tool over either an
in-process emulation or a real VM, so the model's view is a shell in both cases
(`vercel/ai.git:packages/tool-bash/README.md`). smolagents' tutorial argues for code over JSON
tool calls partly on the ground of "representation in training corpus"
(`huggingface/smolagents.git:docs/source/en/tutorials/secure_code_execution.md`).

**Projects that pay for a gap in familiarity.** `@ai-sdk/sandbox-just-bash` registers a
JavaScript `realpath` because the emulation has no such command
(`vercel/ai.git:packages/sandbox-just-bash/src/utils.ts`). smolagents binds `print` to a
function returning `None`, so a model's ordinary `print(...)` debugging produces nothing
(`smolagents.git:src/smolagents/local_python_executor.py`). OpenAI's Codex shell tool ships
instruction templates for shell behaviour rather than relying on the model's habits
(`openai/codex.git`). Each of those is a place where a familiar-looking runtime is not familiar
enough, and the project patched it.

So the farm supports the mechanism's existence — every project here has a list of behaviours a
model had to be taught or patched — and not its size. The size is the thing that decides whether
assertion 3 is worth acting on.

## The mechanism, written as a table of mismatches

pi's codemode — jsmode — is the concrete case. Each row is a thing a model that knows Node or Python will
write, what happens instead, and the source of the behaviour.

| the model writes                       | what pi's sandbox does                                                                                                                                                        | what a familiar runtime does                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `setTimeout(f, 100)`, `sleep`          | nothing to schedule it; a promise that can never settle "fails immediately, since there are no timers"                                                                        | schedules it                                       |
| `fetch(url)`                           | not defined: no network, no WebCrypto, no Node globals                                                                                                                        | performs the request, or fails with a policy error |
| `import x from 'y'`, `require`         | no module system; `eval` and `Function` only make more code inside the same VM                                                                                                | resolves modules                                   |
| `Date.now()` during a long computation | does not advance while the script computes without calling a tool; a non-yielding script is bounded by the interrupt budget instead, past which it fails as `kind: "timeout"` | the clock advances                                 |
| a variable from the previous script    | gone: each execution is a fresh VM; only `store`/`load` JSON survives, at most 262,144 characters per value                                                                   | still there                                        |
| `fs.readFileSync`                      | no filesystem in the VM; the script must call `tools.read(...)` and read a structured result                                                                                  | reads the file                                     |
| `tools.my-tool(...)`                   | names are mangled to valid identifiers; the declaration block is the only signature source                                                                                    | the name on `PATH`, or the real module             |
| a class instance, `Date`, `Map`        | tool boundaries are JSON; values that do not survive are gone                                                                                                                 | passes the object                                  |
| `throw` from deep in a helper          | QuickJS frames referencing `codemode.js`                                                                                                                                      | a host-language traceback with real file paths     |
| a second codemode script               | "scripts cannot start other `codemode` scripts"                                                                                                                               | runs a program                                     |
| long output                            | capped at `max_output_tokens` (default 10,000) and 100,000 items; excess is dropped or spilled to a file                                                                      | streams to the terminal                            |
| a nested call inside a loop            | a real tool call, recorded outside the model's context — the feature the sandbox exists for                                                                                   | a subprocess the harness never sees                |

Three of those rows are _benefits_ of the sandbox and two are neutral: nested calls stay out of
context, output is capped by design, and the tool set is closed. That is why the hypothesis is
not "the sandbox is bad". It is a claim about which way the trade should lean, and rows like
`Date.now()` or the missing module system are not part of the trade — they are consequences of
QuickJS-in-Wasm that a different sandbox could avoid.

## Where familiarity is not free

- **Output shaping is independent of the runtime.** SWE-agent's four findings are about
  truncation, search results and error text. A bash-only agent inherits none of them, and
  mini-swe-agent's answer is that the model handles raw `stdout` — unmeasured on this tree's
  tasks.
- **A familiar runtime is also a larger attack surface.** A shell can reach anything the
  container can, so "only intentional tools" becomes a container policy question
  (`docs/codemode-runtime-prior-art.md`). Assertion 3 could be true and the answer still be no.
- **A bespoke surface can be constrained, a real one cannot.** pi hands providers a Lark grammar
  for the tool input (`constrainedSampling: { type: "grammar", variants: { openai_lark:
  CODEMODE_SOURCE_GRAMMAR } }`, `earendil-works/pi.git:packages/coding-agent/src/extensions/codemode/tool.ts`,
  grammar in `packages/codemode/src/source.ts`). A bash tool has no such shape to constrain,
  so the familiar arm trades a structured guarantee for fluency.
- **The catalog cost is language-independent.** This tree runs `codemode` in `mode: "only"`
  with `inlineBudget: 0`, so every signature arrives through `searchTools()`. That is a real
  per-task cost and it is not a QuickJS property; a comparison that ignores it would attribute a
  catalog problem to the language.

## Why this tree is a good place to measure it

The claim bundles two variables that this tree can separate, and separating them is the only way
to know which one a result belongs to:

- **Language familiarity** — jsmode's QuickJS JavaScript versus pymode's Python (d152).
- **Surface freedom** — a closed tool catalog reached through a bridge, versus a shell that
  reaches whatever the container holds.

Three of the four combinations are runnable here, and the missing one (an unfamiliar language over
an open surface) is nobody's design:

|                          | closed catalog    | open surface |
| ------------------------ | ----------------- | ------------ |
| language the model knows | pymode            | bash         |
| language it does not     | jsmode (baseline) | —            |

The baseline already exists in configuration, which is what makes the comparison cheap:

- `coding-agent/settings.json` enables `+read +bash +edit +write +grep +find +ls +codemode` with
  `codemode.mode = "only"` and `inlineBudget: 0`, so the model reaches all eight tools through
  scripts and must search for their signatures.
- Every arm but pymode is a settings variant of the same pi binary: `defaultTools` alone (no
  codemode), `defaultTools: ["bash"]` (mini-swe-agent's shape), and codemode with
  `inlineBudget: 3000` (catalog removed as a variable).
- pymode is one extension file (d152), and it can be active beside jsmode in the same session, so
  no binary swap is needed.
- The tasks can be this repository's own maintenance work — a grep across `docs/`, a multi-file
  edit with a gate run, a small analysis script — so the outcome is gradable by an existing check
  (`./lint.sh`, `./test.sh`, the spec gate) rather than by a benchmark harness.

## What would count as evidence

Six arms, one model, one task set, three runs per arm and task:

| arm | interface                                    | tests                                              |
| --- | -------------------------------------------- | -------------------------------------------------- |
| 1   | jsmode only, `inlineBudget: 0` (baseline)    | the current configuration                          |
| 2   | jsmode only, `inlineBudget: 3000`            | whether the catalog, not the language, is the cost |
| 3   | declared tools, no code mode                 | whether a code mode helps at all                   |
| 4   | bash only                                    | a familiar language over an open surface           |
| 5   | pymode, catalog in the description           | a familiar language over a closed surface          |
| 6   | shmode (d156), a closed shell over just-bash | whether a familiar runtime has to be a real one    |

Arms 1 and 5 are the clean test of assertion 3: same eight tools, same closed-catalog design, same
output contract, and only the language differs. Arms 4 and 5 hold the language fixed and move the
surface, which is how the shell-is-enough premise gets tested rather than assumed. Arm 2 removes
the catalog cost that arm 1 pays and arm 5 does not, so a difference between 1 and 5 that survives
arm 2 is about the language.

Arm 5 against arm 6 is the sharpest pair in the table, because it holds two things fixed and moves
one: both are closed catalogs in a language the model knows, and only the runtime differs — a real
CPython child against an emulated shell written in JavaScript. A model calling `cat` and
`ssh prd read` cannot tell which it is talking to, so if the imitation costs success, the reason
is the emulator's gaps rather than the language. That is the question d156 exists to measure, and
it is the one a "just make the sandbox look normal" plan rests on.

Metrics per arm: task success, turns, tool and nested-call counts, error rate **classified by
cause**, prompt and completion tokens, wall time, and cost per success. The classes are
language-specific and that is the point: "not defined" and "wrong number of arguments" on the
JavaScript side correspond to `NameError` and `TypeError` on the Python side, so the comparison
counts _classes_ of failure rather than raw errors. An interface change that reduces the
"this is not the language I know" class supports assertion 3; one that reduces "wrong argument"
supports assertion 2 instead.

Two cheap steps come before any of that. Arms 1 to 4 need no code and can run as soon as the task
set exists. And the failures already recorded in this tree's jsmode sessions can be classified
now: if the "not the language I know" class is rare, the familiarity hypothesis is small here and
the record can stop before pymode is written.

## Confounds that could produce the result without the mechanism

- **The catalog.** Arm 1's `inlineBudget: 0` forces a search step for every signature. Arm 2
  exists to absorb it; a difference between 1 and 4 that also appears between 1 and 2 is a
  catalog effect.
- **The prompt.** Each interface needs its own instructions, and mini-swe-agent's minimal prompt
  is part of its result. A fair comparison gives every arm a competent prompt, which means the
  prompt is a variable, not a control (d149 owns the gating rules).
- **The model's tool-training.** A model fine-tuned on bash-style action strings may be better
  at bash for reasons unrelated to runtime familiarity, and a codemode's JSON-to-source step is
  where that shows.
- **Output discipline.** If the familiar arm prints 40 KB per turn and the sandbox arm is capped
  at 10,000 tokens, the comparison measures truncation as much as fluency.
- **Task selection.** Repository maintenance tasks reward reading and grep; benchmark-shaped bug
  fixing rewards reproduction. A result that holds for one may not hold for the other.

## What this record does not conclude

It does not claim the sandbox is slower, worse, or wrong. It does not claim a minimal agent is
sufficient here: the farm's numbers come from benchmark tasks, and this tree's agent also does
documentation, gates and container work. It does not decide the Python question — d152 owns that
— and it does not change the current settings, which stay as they are until an experiment says
otherwise.
