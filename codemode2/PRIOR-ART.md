---
id: codemode2-prior-art
type: module-design
status: draft
title: "codemode2 prior art: a JavaScript codemode engine, a bash-compatible shell, and a micro-VM"
parent: codemode2
depends-on: [d194]
references:
  [
    d194,
    d196,
    d198,
    d150,
    d152,
    d153,
    d156,
    d176,
    codemode-runtime-prior-art,
    workload-sandboxing-prior-art,
  ]
tags: ["references", "prior-art", "codemode", "shell", "microvm", "sandbox", "research"]
---

# codemode2 prior art: a JavaScript codemode engine, a bash-compatible shell, and a micro-VM

A **prior-art survey**, not a decision or a recommendation: three sibling projects read
for the findings, the decisions and the defects they published about putting a program
written by a model in front of a small, deliberate set of operations. Sources are bare
mirrors under `~/Downloads/references/github.com/`, named as `<repo>:<path>` at the tips
listed under [Re-verify](#re-verify). The reader needs the two-layer split from
[d194](../docs/d194-codemode2-closed-tool-surface.md) and nothing else: **surface
closure** is what the sentence may make the machine do, **containment** is what the code
may do to the machine.

The three answer different questions, and that is why they are read together. `djs` and
`psh` are code modes with a deliberately limited surface — an engine that runs a model's
script against host functions, and a shell that runs the commands a model types.
`gondolin` is a general micro-VM: it takes containment as its subject and keeps the shell,
so it is the mirror image of codemode2's product decision. One of the three is also the
other's dependency: `gondolin` embeds `djs` as the sandboxed JavaScript engine of its
per-request network policy (`native/docs/djs-hooks.md`, `native/DESIGN.md`, "Hook tiers").

## Trust boundary

Every claim about a mirrored project is that project's own statement, read from a mirror
tip. No behaviour, limit, benchmark or isolation property has been reproduced here:
constants, throughputs, conformance percentages and security mechanisms are all as the
project reports them. A tip can be ahead of any release a deployment installs, and the
surveyed text and the installed tool then disagree; the installed tool wins for a decision.
Commit hashes pin what was read; they do not imply upstream still looks like the pin.

## The three in one table

| project    | what it is                                                                         | the limit it chose                                                      | what codemode2 reads it for                                 |
| ---------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| `djs`      | JavaScript + TypeScript engine in `no_std` Rust, wasm32 first; pi's codemode       | no process, no network, no dynamic code: host functions are the surface | the engine shape under a closed surface, and its costs      |
| `psh`      | bash-compatible shell in Rust, utilities in process, real programs on fall-through | non-interactive `bash -c` only; every side effect behind one `Host`     | the corpus method, the utility set, the fall-through policy |
| `gondolin` | local Linux micro-VM (libkrun, QEMU fallback) with host-mediated network and FS    | guest untrusted, host is the policy point; no raw egress                | the containment layer d194 explicitly does not claim        |

## djs — a codemode engine that replaced QuickJS

### What it is

`djs` is a JavaScript and TypeScript interpreter in `no_std` Rust, built mainly for
wasm32, that runs codemode scripts — model-written programs that call tools and return
data — and replaces QuickJS in pi's codemode (`djs:README.md`). Its README reports 39,325
of the 39,365 test262 cases in its active group passing, and a 627 KB brotli-compressed
wasm module. Its oracle is `dquickts`, a QuickJS fork, and it matches QuickJS "down to
error messages".

Four design decisions carry the project and every other finding hangs off them
(`djs:ARCH.md`):

- **One arena.** All VM state — objects, strings, bytecode, the value stack, call frames,
  the job queue, pending host calls — lives in one `u32`-addressed byte arena. Native code
  is never referenced by pointer from it, so a VM image is a byte copy and the host reads
  strings straight out of linear memory with no serialization step.
- **Suspend anywhere.** The interpreter never recurses on the Rust stack for JS calls, so
  it can stop between any two instructions — inside getters, `toString`, `map` callbacks,
  promise jobs, generators and async functions — and resume later, in the same process or
  from a dump.
- **Persistence as code.** A run waiting on its tools is written as a _continuation dump_:
  a plain JavaScript program that recreates it. Heap images stay inside one process; the
  durable format does not depend on the heap layout.
- **Fuel, not wall clock.** Every instruction costs fuel by class, and work inside builtins
  is charged proportionally (bytes scanned, elements visited, digits parsed). A host runs
  slices and holds a budget, so the stopping point is a function of the program; the
  documented trade-off is that fuel only approximates time (`djs:docs/guide/limits.md`).

### Decisions worth copying or refusing

The engine holds the whole surface, so its decisions are a compact statement of what a
codemode runtime needs (`djs:docs/decisions-index.md`):

- **The model reads the errors.** QuickJS's messages are reproduced verbatim, and
  deliberate differences are marked per test case, because a model's repair loop depends on
  the text it gets back.
- **The pi adapter is thin and measured.** 10,000 fuel per interrupt poll; deterministic
  `Math.random` matching quickjs-wasi; quickjs-wasi's host globals installed in JS before
  the prelude; the VM image taken _after_ the prelude is reused; the prelude itself is not
  polled.
- **The shipped wasm module drops the arena bounds checks** (wasm's own bounds check is
  the second check), while native, dump and test builds keep them. The stated consequence:
  an engine bug in wasm can corrupt that VM but cannot reach the host.
- **A heap cap is catchable, with a reserve.** Reaching `memoryLimit` raises
  `InternalError: out of memory`, with 1/32 of the cap held back so the handler can run; a
  host that wants determinism asks for the uncatchable form, and the docs distinguish that
  from host-side memory exhaustion, which is not deterministic.
- **`TextEncoder`/`TextDecoder` exist (UTF-8); `URL`/`URLSearchParams` are absent by
  decision, and `fetch` and timers are the host's.** ES modules exist for embedders
  through the `embed` feature and a host loader; nothing reachable from a codemode
  script performs I/O the host did not offer.

### Findings from its own measurement

`djs:docs/codemode-feature-usage.md` measures what real codemode scripts use: 2,627
executions, 2,535 distinct scripts, 348 sessions, five weeks, read off djs's own bytecode.
The subset is narrow and modern — `await` on tool calls in 98% of scripts,
`Promise.all`/`allSettled` in 28%, arrows, template literals, `for-of`, destructuring,
`?.`/`??`, try/catch, JSON, string and array methods.

- **Never used, in 2,535 scripts:** classes, getters/setters, `super`, Proxy, Reflect,
  Symbol, the `Object.*` reflection calls, generators, for-await, BigInt, typed arrays,
  tagged templates, `eval`/`Function`, and most regular-expression syntax beyond `g`/`i`.
- **The host's own prelude needs what the scripts do not.** The `tools` object is a Proxy,
  so 92% of scripts pass through a Proxy trap; the prelude also needs getters, `Symbol`,
  `Object.defineProperty`/`freeze`, and generator syntax. Cutting the script-only features
  is therefore not free.
- **The largest measured cut is Unicode.** Disabling property escapes and full
  normalization saves 40.7 KB gzip (8.8%) of a module no script needed them from.

The size study (`djs:docs/size-vs-quickjs.md`) prices the same engine against QuickJS:
1.85x quickjs-wasi's gzip, with the gap attributed — roughly 1.7x gzip for equivalent
features because the code is safe Rust, a shipped realm image instead of a startup build,
and the embedding features QuickJS does not have.

### Issues found

- **Self-hosting costs.** Bytecode-backed builtins were slow; the answers were a Rust
  backend, leaf intrinsics and fast-path entries. Builtin-heavy code is still 2–4x
  quickjs-wasi, which is the remaining known runtime gap (`djs:ARCH.md`, "Open Questions /
  Risks").
- **A copying collector without a large-object space.** Large tool outputs are copied by
  every collection; growth policy and append ropes limit the damage and the space is a
  known open item.
- **Module support was missing when the first embedder needed it.** `import`/`export`
  parsed as syntax errors and `import()` rejected, so `gondolin` wrote an
  eight-requirement module list (goal, host loader, linking, synthetic modules,
  `import()`, snapshot survival, export access, top-level await) and an interim
  esbuild-bundling plan (`gondolin:native/docs/djs-hooks.md`); `djs` carries ES modules
  for embedders behind its `embed` feature.
- **The wire format made the host pay twice for text.** The UTF-16 length up front forced
  a full count and transcode: ~70% of the samples on a 64 KiB text body, ~67 µs, until an
  ASCII/valid-UTF-8 fast path brought it to 15 µs. The recorded fix is to let the decoder
  count, or to wrap host bytes without a copy.
- **A promise returned by an async entry could not be kept across runs** without a rooted
  handle, so the embedder's shim had to attach `.then(settle, settle)` and read the result
  from a host call. This became a requirement on the embedding API, not a workaround to
  copy.

### What transfers

The engine is a worked answer to codemode2's "The engine" open question in d194: an
in-process wasm engine with a byte arena, a fuel budget and a suspend point at every
instruction is what makes "no process, no network, no dynamic code" a _surface_ rather
than a filter. Its price is stated in the same place: builtin-heavy code at 2–4x QuickJS,
no large-object space, and an embedding API that had to grow a wire encoder, rooted handles
and budgets before a second host could use it.

## psh — a bash-compatible shell with the utilities in process

### What it is

`psh` is a portable, bash-compatible shell in Rust built for the commands coding agents
write: non-interactive `bash -c` semantics with no line editing, completion or job control
beyond `&`/`wait`/`kill`. It runs 49 utilities under 58 names in process (`head`, `sort`,
`cut`, `find`, `xargs`, `rg`, `timeout`, `awk`, `jq`, …), falls through to the real program
for anything they do not support, and embeds into a host through a synchronous, stepped
engine with no async runtime (`psh:README.md`). Its status page reports, at commit
`3475d0aa` — not at the mirror tip — 93.8% of the Oils spec cases, 90.0% of brush's cases,
and every one of its 701 agent-shaped cases; 58 utility names and 53 of bash's 61 builtins;
an 11.9 MB binary, 5.0 MB size-optimized.

Structurally it is the closest published relative of codemode2's surface, and the opposite
product decision: it **keeps** the dangerous half of the shell and makes real processes
mandatory, where codemode2 reimplements the safe half and forbids processes.

### Decisions worth copying or refusing

- **Agent-first outranks bash fidelity.** The goal order is agent-first, portable, then
  "what bash prints" (`psh:ARCH.md`, D033). Four examples: one signal numbering (Linux's)
  on every system, byte-order `sort` in every locale, `cut -c` counting characters, and
  non-ASCII bracket ranges compared by code point. Each is a deliberate divergence from the
  host's bash, decided by the argument rather than the OS.
- **A missing feature stops the script.** `coproc`, `select`, `fg`, `set -o posix` and the
  like print `NAME: not supported yet` and end the shell with status 2, because a script
  that runs on after a skipped step can damage what the model meant
  (`psh:docs/guide/differences.md`).
- **Fall-through is loud, never silent.** An option outside a utility's spec runs the real
  program of that name if there is one, and otherwise fails naming the option. A utility is
  never allowed to produce different output quietly (`psh:ARCH.md`, "Registry, modes and
  fall-through").
- **Every side effect goes through one `Host` trait**, with pollable operations, so the
  same engine runs over the real OS, a test host or an in-memory WASM host. This is the
  same shape d196 takes from the other side: the filesystem is the runtime's, and it is an
  interface rather than a convention.
- **The classifier runs on the AST the engine executes** and is conservative: dynamic
  command names, `eval`/`bash -c` of non-literals, `source`, inline interpreters, aliases
  and functions, and variables that change what runs are `unknown`, never read-only.
- **There is no exec-time approval hook.** Classification is reporting only (D036) — the
  project decided that a policy layer is not the shell's business.

### Findings from its measurement

`psh:research/corpus.md` reads 295,401 commands from 6,112 sessions (Mar–Nov 2026, all on
macOS):

- **The syntax is small.** `&&` in 55% of commands, pipes in 47%, `cd X && …` in 46%,
  `2>&1` in 15%, quoted here-docs in 13%, `$(…)` in 5%, `for` in 3.5%; `if`, functions,
  `case`, arrays, `[[ ]]` and process substitution each at or below 0.6%.
- **Names are concentrated.** The top 20 names cover 76% of commands, the top 50 92%. A
  117-name in-process set runs 37.6% of commands entirely in the shell; allowing one real
  program raises that to 85%, and that program is mostly `git` (23.8%), then `python3`,
  `node`, `npm`, `cargo`.
- **Most commands read.** 51.7% are pure reads and 47% limit their output (`| head` in
  32%). The agent uses the shell as its file viewer.
- **The per-utility frequencies are a surface decision.** `head` 32.9%, `grep` 24.2%,
  `rg` 19.7%, `sed` 16.1%, `tail` 9.0%, `cat` 8.3%, `find` 3.2%, `sort` 2.7%, `cut` 1.3%,
  `awk` 1.2%, `jq` 0.7%. That is the measurement d194's "Whether `awk` is needed at all"
  open question asks for, from a different population.
- **The headline recommendation is the one codemode2 refuses.** "A sandbox-only shell is
  not enough. Real processes are mandatory." For a general coding agent that is a finding
  about coverage, not about safety; codemode2 buys closure at exactly this cost.
- **GNU and BSD habits are mixed in the same corpus**, so a builtin needs both dialects:
  `sed -i ''` appears 5,307 times against 144 GNU-style `sed -i`, while `timeout`,
  `grep -P` and `find -printf` are GNU habits macOS lacks.

The companion studies read the neighbouring implementations (`psh:research/landscape.md`,
`psh:research/just-bash.md`): against the Oils cases bash itself passes, brush reaches
82.4%, mvdan/sh 64.9%, yash-rs 44.1%, deno_task_shell 13.5% and Bun Shell 10.5%. just-bash
(a TypeScript bash over a virtual filesystem) passes about 83% of the imported Oils cases,
ships 80 reimplemented commands, and measures the cost of that shape: `rg` over a 3.9k-file
tree took 10.9 s against 75 ms for the real tool, pipelines are fully buffered stage by
stage, `trap` is absent, `cmd &` runs in the foreground, and its "defense in depth" patches
the host JS realm's own globals while a script runs.

### Issues found

- **The last 15% of bash is a long tail.** Traps, signals, `declare` corners, NUL bytes and
  the `extdebug` option are spread thinly across the failing Oils and brush files, and that
  is the conformance ceiling the study names.
- **Windows is where the agent corpus thins out.** Against the same Linux recording, the
  701 agent-shaped cases pass 283 on Windows (40%), mostly because the programs they call
  do not exist there. A portable shell buys process spawning and path/encoding behaviour,
  not the tools.
- **An embedded shell has no process identity to give.** `$$` and `BASHPID` in a nested
  `bash -c` inside psh are an error ("this shell runs inside psh and has no process id")
  rather than a made-up number, because a fake pid would silently name nothing to
  `/proc/$$`, `ps -p $$` or a pid file. A utility job's `$!` is a job id that only the
  shell's own `kill`/`wait` know. Both are the same class of bug a virtual filesystem has:
  an identifier that looks real and reaches nothing.
- **Arithmetic is parsed before it runs**, so a syntax error wins over an earlier runtime
  error and holds back the side effects bash would already have performed. The difference
  is deliberate and documented; it is still a semantic divergence a model can trip on.
- **Licensing constrains reuse.** The study rules out the fast route to bash fidelity
  because the available port describes itself as a function-by-function port of GNU bash's
  C code; its listed safe-to-read parts are the builtins, the minimiser, the output taps,
  the `Host` design and the Windows spawn recipe.

### What transfers

The corpus method transfers whole, and it is the cheapest thing in this survey: a command
corpus, a **shape corpus** of 26,234 syntax skeletons (only a reviewed 1,422-word
vocabulary kept), per-utility and per-flag frequency tables, and a read-only classifier
built on the same parser as the executor. d194's "Coverage measurement" open question is
this measurement, unrun; the "`awk` is needed at all" question is answered in the direction
of _no_ by a 1.2% share, and in the direction of _yes_ by the familiarity argument in d153.
The fall-through policy is the decision codemode2 must not copy: a closed surface has no
host binary to fall through to, which is why d194's tests refuse a `net`/`exec` grant
rather than delegating it.

## gondolin — a micro-VM whose I/O is mediated on the host

### What it is

`gondolin` runs agent-generated code in a local Linux micro-VM — libkrun where it can,
QEMU otherwise — while the VM's network and filesystem stay under host-side policy
(`gondolin:README.md`). The guest is treated as adversarial; the host, its daemon and the
VMM are trusted. The guest sees a placeholder token for every secret, and the host
substitutes the real value only for an allowed destination; HTTP/TLS egress is parsed and
replayed by the host, UDP is blocked except DNS, and the VMM is started with `-nodefaults`
and virtio devices only (`gondolin:docs/security.md`).

Its network and filesystem hooks come in three tiers with different prices
(`gondolin:docs/hooks.md`, `native/DESIGN.md`): declarative policy evaluated in the daemon,
a self-contained JavaScript policy run inside the daemon on `djs` (tier 2), and arbitrary
callbacks in the controller process (tier 3). Only registered phases are called back, and
bodies only when read. Order is declarative, then tier 2, then tier 3; any failure fails
closed.

### Decisions worth copying or refusing

- **Containment is the VMM's, not the mediation layer's.** The security document states
  the guarantee conditionally — "absent a VMM escape, guest processes cannot access the
  host kernel, memory or filesystem" — and lists VM escape, a same-user local attacker,
  side channels and denial of service as non-goals or sharp edges. Codemode2's claim is
  weaker than this one on purpose, and d196's "not a boundary" wording is the same
  discipline.
- **The cheapest tier that can express a rule wins.** A policy that needs no per-request
  work is declarative; JavaScript is tier 2 only when a callback would cost a round trip.
- **A checkpoint covers what it can name.** Snapshots are disk-only; RAM and in-VM process
  state are not captured, and some guest paths (`/root`, `/tmp`, `/var/cache`, …) are
  tmpfs-backed by default, so their writes are outside a checkpoint unless the VM moves
  them, and VFS mounts are outside it too (`gondolin:docs/limitations.md`).
- **Every qcow2 the daemon did not create is validated, including its backing chain.**
  This was a fix, not a design: resuming a crafted checkpoint could let an external data
  file named in its header be opened by the VMM and expose host files.

### Findings from its own measurement

The `djs` tier exists because a controller round trip is expensive, and the prototype
measures what the alternative costs (`gondolin:native/docs/djs-hooks.md`, on an arm64 Mac):

| engine        | header-only hook | 64 KiB body | calls/s, 8 callers |
| ------------- | ---------------: | ----------: | -----------------: |
| native Rust   |           0.6 µs |     18.9 µs |          4,985,000 |
| djs, pooled   |          26.2 µs |     20.3 µs |            223,400 |
| djs, fresh VM |          33.0 µs |     35.1 µs |            179,500 |
| node (tier 3) |          69.7 µs |    157.2 µs |             28,800 |

- Tier 2 is 2–8x faster per call than the controller callback, and does not serialize on
  one event loop, but it is ~40x slower than a native closure, so declarative stays the
  default.
- A fresh VM per call is safer and only ~20% dearer than a pooled instance; the production
  design uses a pool with `Instance::reset` to the snapshot, shrinks idle instances above
  1 MiB, and reports equal cost for header-only calls.
- Budgets are fuel (50M per call, 200k slices with a yield between them), heap (64 MiB,
  uncatchable) and a wall-clock deadline (30 s). Every failure mode — throw, rejection,
  fuel, out of memory, never-settled promise, bad return shape, panic — maps to one
  fail-closed error.
- Boot cost is a first-order product cost: a missing RTC cost ~1.5 s per x86_64 boot, the
  boot log ~0.9 s, DHCP ~40 ms, `rngd` two vCPUs for ~11 s; the fixes are in the changelog,
  and filesystem transports moved by 2–15x (virtio-fs over sandboxfs, `READDIRPLUS`,
  larger FUSE requests).

### Issues found

- **"Mediated" is not "safe".** An allowed host can still receive anything the guest reads;
  an echo server can be used to exfiltrate; mapped TCP rules are raw tunnels that bypass
  the HTTP hooks; DNS tunnelling remains in the `trusted` DNS mode. The document says so in
  as many words.
- **No resource governance.** Buffer caps and per-hook budgets exist; a guest can still burn
  CPU and host work.
- **No full save/restore**, and the checkpoint gaps above; images are Alpine-only; HTTP/2,
  HTTP/3, QUIC and WebRTC are out; there is no upstream proxy; custom JavaScript VFS and
  hook providers cost one round trip per operation; the two backends are not at parity.
- **A second host is a second API contract.** The embedding requirements that `gondolin`
  wrote for `djs` — stable crate, shareable snapshot, typed host arguments, an async entry
  point, a Rust wire encoder, uncatchable out-of-memory, a documented panic-poisons-the-VM
  rule — are the API work a codemode engine needs before anything else can host it.

### What transfers

The containment layer is d196's, not codemode2's, and this survey changes nothing in
[workload-sandboxing-prior-art](../docs/workload-sandboxing-prior-art.md). Three findings
do reach codemode2's own records:

- **Checkpoints are as complete as their name.** d198's "decide deliberately what is inside
  the snapshot" row gains a measured example: tmpfs paths and VFS mounts fall out of a disk
  checkpoint, and RAM state is not in it at all.
- **A metered JavaScript engine can be a per-request policy runtime.** 26 µs and 5,931 fuel
  for a header policy is evidence for the engine shape d194 calls "in-process", from a
  consumer that is not a codemode.
- **A fail-closed mapping is small enough to enumerate.** The outcomes that become one
  error are the checklist any runtime beside a policy needs, and codemode2's refusal
  verdict is the same kind of table.

## Where the three disagree

| axis           | `djs`                                    | `psh`                                  | `gondolin`                              |
| -------------- | ---------------------------------------- | -------------------------------------- | --------------------------------------- |
| process        | none, by construction                    | real processes are mandatory           | a full OS and process tree in the guest |
| bound          | fuel and a heap cap, deterministic       | no security claim; `Host` is the seam  | the VMM boundary; no DoS governance     |
| filesystem     | host functions over plain data           | one `Host` trait, real or virtual      | host-served VFS, disk checkpoint        |
| persistence    | continuation dump (a JavaScript program) | none; a run ends                       | disk-only checkpoint, no RAM            |
| footprint      | 627 KB wasm                              | 11.9 MB binary, 5.0 MB optimized       | ~200 MB guest image plus a daemon       |
| oracle         | dquickts and test262                     | bash 5.3 goldens and the Oils suite    | QEMU/libkrun and its own tests          |
| what it proves | a closed surface can keep the language   | a shell can be portable and still bash | a VM contains what a shell cannot       |

The one agreement is the shape both codemodes reached independently: **the runtime owns the
resources, and every effect crosses one interface**. `djs` exposes host functions,
`psh` routes every side effect through `Host`, `gondolin` through its VFS. None of the three
hands a path or a capability straight to an OS call from the program's side. That is how
it meets d156's pipeline finding: psh runs every stage in process over the same `Host`, so
the stages share the runtime's filesystem rather than the OS's; `djs` has no filesystem at
all, and `gondolin` keeps the OS's.

## What these three do not settle

- **The surface.** All three keep a large surface and bound it by _where the code runs_ (an
  engine with host functions, a VM, a stepped shell). None enumerates the safe half of a
  command the way d194 does, and psh's own answer to "should a builtin shadow the real
  tool" is fall-through, which a closed surface cannot have.
- **Whether closure is affordable.** psh's corpus says a general agent needs real processes
  (`git` alone is 23.8% of commands); codemode2's answer is that a coding workflow's share
  of those is the part d194's surface covers and d153's familiarity claim scores. That
  comparison is unmeasured and remains d194's cheapest open question.
- **Containment.** `gondolin` is a candidate backend for the layer d196 designs, not a
  claim about it; its own document lists what it does not defend.
- **A reversible mutation journal.** None of the three has a per-operation undo: `djs`
  persists a _run_, `gondolin` persists a _disk_, and a per-mutation journal is still only
  designed in d198.

## Re-verify

Read from bare mirrors under `~/Downloads/references/github.com/` at these tips. Every
number above is about that commit; a move is a finding here rather than a silently aged
table.

| repo                      | tip        | what was read                                                                                                                                                                              |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `earendil-works/djs`      | `dd9480eb` | `README.md`, `ARCH.md`, `docs/guide/limits.md`, `docs/codemode-feature-usage.md`, `docs/size-vs-quickjs.md`, `docs/lessons-from-pico.md`, `docs/decisions-index.md`                        |
| `earendil-works/psh`      | `234d9a99` | `README.md`, `ARCH.md`, `docs/guide/status.md`, `docs/guide/differences.md`, `research/README.md`, `research/corpus.md`, `research/just-bash.md`, `research/landscape.md`, `work/BOARD.md` |
| `earendil-works/gondolin` | `ca98da58` | `README.md`, `docs/security.md`, `docs/limitations.md`, `docs/hooks.md`, `native/DESIGN.md`, `native/docs/djs-hooks.md`, `CHANGELOG.md`                                                    |
