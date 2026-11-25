---
id: d194
type: module-design
status: draft
title: "d194 — spike: codemode2, a closed core-tool surface enumerated from GTFOBins and LOLBAS"
parent: codemode2
depends-on: [d150, d156, d176]
references:
  [
    codemode-runtime-prior-art,
    codemode2-prior-art,
    d152,
    d153,
    d163,
    d127,
    d113,
    workload-sandboxing-prior-art,
  ]
tags:
  [
    "spike",
    "research",
    "codemode",
    "tools",
    "allowlist",
    "denylist",
    "gtfobins",
    "lolbas",
    "sandbox",
    "shell",
  ]
---

# d194 — a closed core-tool surface, enumerated from the living-off-the-land corpora

This record is the research behind **codemode2**: a tooling framework whose whole
surface is a table of core-tool contracts, each exposing a small slice of its
namesake over a filesystem the runtime owns. It states the threat model, the two
corpora that were enumerated, what their numbers do and do not decide, the four
bars a command must not cross, and the surface that follows. It is not a denylist
design, and it does not describe a built runtime: the surface and its projection
exist as committed artifacts, the interpreter does not.

It exists because the alternative to a closed surface is a _narrower_ one, not a
safer one: models are trained on bash and pwsh, [d153](d153-minimal-agents-over-real-runtimes.md)
states the familiarity claim, and [d156](d156-shmode-a-closed-shell.md) drafts the
closed shell. The surface is therefore familiar in shape and closed by
construction — a product decision about tooling, not a containment boundary, which
the threat model below states explicitly.

The reader is whoever builds that runtime or attacks it. The measurement is
reproducible — `codemode2/enumerate.mjs` re-derives every count below from the
reference farm, and `--check` fails when a corpus tip moves.

## Status

Draft spike, research only. `codemode2/surface.json` is the decided surface,
`codemode2/taxonomy.json` and `codemode2/attack-corpus.json` are its generated
projection, and nothing in the tree obeys any of it yet. The layer above the
surface — the canonical tree, the derivation of grants, the refusal cascade and the
worktree envelope — is [d196](d196-refusal-cascade-and-isolation-envelope.md).

## Threat model

The adversary is a program author, not a local user: a model writes argv, file
contents and pipelines against the surface, and the surface must not let that
authorship turn into a process, a packet, or a privilege. The host, the runtime
and its operator are trusted; the repository's economy is single-user
([requirements](requirements.md)'s NFR-5), and egress is a chain step of its own
([d127](d127-proxy-only-container-egress.md)), so a tool that dials would be a
second, unpoliced door.

The neighbouring layer is worth naming, because both use the word sandbox.
**Containment** asks what _the code_ may do to the machine — a hostile dependency, an
injected agent, a damaged tool — and it is the workload runtime's question, with its
own egress policy ([workload-api](container-tooling.md),
[workload-sandboxing-prior-art](workload-sandboxing-prior-art.md),
[d127](d127-proxy-only-container-egress.md)). This record asks what _the surface_
may express to a cooperative model on a clean repository, and its answer holds
without any assumption about intent: `find -exec` is an escape whether or not
anyone meant it. The two layers share mechanisms and must not share an argument; a
runtime deployed inside containment is the intended shape, and this surface alone
is not containment.

Four failure classes are in scope, and every one of them is a _seam_ rather than a
mistake a user makes:

- **argv becomes a program** — a flag, a script operand or an environment
  variable the binary interprets as code, a child process, or a hooked loader.
- **a file becomes a program** — a write landing where code is loaded from, or a
  file the loader is pointed at by an inherited variable.
- **a privilege is inherited** — effective uid, capabilities, SUID, or a
  namespace the process can enter.
- **data leaves or arrives** — a socket, a resolver, a proxy.

Out of scope, and owned by the containment layer rather than dismissed: kernel and
driver surfaces (LOLDrivers is the Windows counterpart and stays unread here),
co-tenant isolation, host compromise, and the code-trust question — a malicious
dependency inside the visible tree is contained by the workload runtime, never by
this surface.

## Why a denylist cannot be the policy

The obvious design reads GTFOBins and LOLBAS at run time and refuses a binary
whose name appears. Four facts from the two corpora rule it out.

- **The corpora list unintended capability only.** LOLBAS's acceptance criteria
  say a binary must have "extra 'unexpected' functionality. It is not interesting
  to document intended use cases." So `cmd.exe` is in the corpus for ADS,
  Download and Upload — _not_ for Execute, because launching programs is what cmd
  is for. The most powerful Windows tool in the file is therefore classified as a
  transfer tool, and the file cannot tell a policy anything about the capability
  a caller intends to expose.
- **Both are curated, so absence is not safety.** 20 of GTFOBins' 478 entries are
  aliases of another entry, and LOLBAS's 248 files carry 247 distinct names.
  Meanwhile `runas`, `icacls`, `xcopy`, `net`, `where`, `curl` and `systeminfo`
  are Windows tools with no LOLBAS entry at all. A name-match policy is silent
  about all of them.
- **The capability lives in the flags, not the binary.** GTFOBins' own examples
  are argv strings: `find . -exec /bin/sh \; -quit`, `sed -n '1e exec /bin/sh 1>&0'
  /etc/hosts`, `split --filter='/bin/sh -i 0<&2 1>&2' file`, `tar xf x.tar -I
  '/bin/sh -c ...'`, `cp --attributes-only --preserve=all a b`. The same binary
  with a smaller argv is a text filter. Refusing the name refuses the capability
  the workflow needs along with the one it does not.
- **Names are not identities.** Aliases (20), busybox-style multiplexers, hard
  links, renamed copies and shell builtins all defeat a name table; GTFOBins
  itself models `awk` as an alias of `mawk` and `ksh` as an alias of `bash`.

So the corpora are not the policy. They are the **evidence that maps features to
capabilities**, and the policy is what a surface does about that evidence.

## What the corpora can decide

GTFOBins is a capability table annotated with reachability. Each entry is a
frontmatter block of `functions:` — shell, command, file-read, file-write,
upload, download, bind-shell, reverse-shell, library-load, inherit,
privilege-escalation — and each example under a function carries a `contexts:`
map: `unprivileged`, `sudo`, `suid`, `capabilities`. An example with no
`contexts:` is unprivileged by the site's own default, and `_data/contexts.yml`
declares that default by listing unprivileged first. That annotation is what makes
the corpus useful: it distinguishes "this tool can do X" from "X is reachable by
the process the sandbox will be".

LOLBAS is the same shape without contexts: one YAML per signed Microsoft binary or
script, a `Commands:` list, and a `Category:` per command — Execute, Download,
Upload, Copy, ADS, AWL Bypass, UAC Bypass, Compile, Dump, Credentials, Tamper,
Reconnaissance, Encode, Decode, Conceal.

Neither corpus is exhaustive, and both are argv-shaped. Nothing in either one
records the seam classes this record cares about — inherited loader variables
(`LD_PRELOAD`, `GCONV_PATH`, `LOCPATH`), a config file read from a writable
directory, a pager selected by `PAGER`, an archive entry named `../../etc/...` —
because those are not escalations _of the binary_. They are properties of the
surrounding runtime, and the runtime is the surface's responsibility.

## Method

`codemode2/enumerate.mjs` reads both mirrors in two git calls each (`ls-tree`,
then one `cat-file --batch` over the blob shas), parses the entry shapes above,
resolves the alias table, and projects every candidate tool name onto what an
unprivileged process would reach. The candidate sets are the _expected_ inventory:
the POSIX, coreutils, util-linux, diffutils, findutils, compression and
harness-base names a coding workflow asks for (229), and the Windows built-ins,
cmdlets and script hosts a Windows user asks for (109). Each row lands in one
class, in this order: **shell** (shell, command, inherit, reverse/bind-shell,
library-load), **transfer** (upload, download), **write** (file-write), **read**
(file-read only), **privileged** (in the corpus, no unprivileged function),
**absent**.

## Findings

The GTFOBins function table, with the unprivileged column as the only column a
sandbox cares about:

| function             | tools | unprivileged |
| -------------------- | ----- | ------------ |
| shell                | 228   | 207          |
| file-read            | 199   | 197          |
| file-write           | 84    | 81           |
| inherit              | 71    | 67           |
| upload               | 34    | 31           |
| download             | 32    | 30           |
| command              | 30    | 19           |
| reverse-shell        | 21    | 21           |
| privilege-escalation | 14    | **0**        |
| library-load         | 11    | 11           |
| bind-shell           | 7     | 7            |

**Privilege escalation is never an unprivileged capability.** All fourteen
function rows need sudo, SUID or capabilities, and the eight candidate commands
that carry them — `chmod`, `chown`, `install`, `ln`, `mount`, `su`, `wall`,
`unzip` — are exactly the ones a shell-shaped surface would expose for file
management. The lesson is about the sandbox, not the tool: run unprivileged, drop
capabilities, set `no_new_privs`, and the entire class disappears. A surface that
_does_ carry privilege cannot be fixed by choosing different commands.

**Execution is the dominant class, and it is dominant in the tools a workflow
actually needs.** 53 of the 229 POSIX candidates reach a shell unprivileged,
including `find`, `sed`, `split`, `tar`, `sort`, `awk`, `less`, `xargs` and
every wrapper (`env`, `nice`, `nohup`, `stdbuf`, `timeout`, `taskset`, `chrt`,
`ionice`, `flock`, `setarch`). The full POSIX projection is 113 absent, 8
privileged, 44 read-only, 10 write-capable, 53 shell and 1 transfer. Read-only, a
write grant and a text transform are what remains once the bars are removed, and
that residue is the whole surface a coding tool needs.

**Windows is a launch table.** 161 of 248 entries reach Execute, 58 Download, 35
AWL Bypass, 26 ADS, 12 Dump; of the 109 candidate names, 43 are exec-class,
10 transfer, and 65 appear in the corpus at all. Every exec-class row is a
process launcher or a script host — `cmd /c`, `powershell -c`, `wmic process call create`,
`mshta <url>`, `rundll32 javascript:`, `regsvr32 /i:http scrobj.dll`,
`msiexec <url>`, `forfiles /c`, `installutil /U`, `certutil -urlcache`. There is
no subset of a script host that is a file tool, so the Windows surface is
reimplemented and creates no process at all.

**The corpus doubles as the red-team suite.** `attack-corpus.json` is generated
from the same walk: for each surface command, the examples of the functions it
does _not_ expose. It is 15 probes over 8 commands, because most of the surface
has no non-exposed function at all — `cat`'s only corpus function is the read it
is for, and `grep`'s is the read. The 8 that do carry probes are the ones whose
contract is a slice: `find` (`-exec`, `-fprintf`), `sed` (`e`, `s///e`), `split`
(`--filter`), `tar` (`--to-command`, `-I`, `--checkpoint-action`, `--rsh-command`),
`cp` (`--preserve`, `--attributes-only`), `mv`, `ln` (`-s`), `unzip` (`-K`). The
rest of the surface's risk is path policy, and no corpus can enumerate that.

**The imitation runtimes on the farm are not the answer either.**
`vercel-labs/just-bash` carries 82 command directories, and the table includes `bash`,
`python3`, `js-exec`, `curl` and `sqlite3` — the command table _is_ the surface,
so an inherited one carries a launch and network surface. `uutils/coreutils`
reimplements every flag faithfully, which reproduces the flag-level classes that
GTFOBins documents. A curated table is the design, not a smaller download.

## The four bars

A command is safe in proportion to the bars it cannot cross, and each bar has one
mechanism.

| bar           | what it denies          | mechanism                                                                                           |
| ------------- | ----------------------- | --------------------------------------------------------------------------------------------------- |
| **exec**      | argv becoming a process | no fork/exec in the runtime at all; for a brokered binary, `clone`/`execve` refused by seccomp      |
| **loader**    | a file becoming code    | no executable mode on any entry, no loader reachable, no `LD_*`/`GCONV_PATH`/`LOCPATH` inheritance  |
| **privilege** | a capability inherited  | unprivileged uid, no capabilities, `no_new_privs`, no SUID/SGID bit in the virtual filesystem       |
| **network**   | a packet in or out      | no socket of any family; egress stays the chain step of [d127](d127-proxy-only-container-egress.md) |

Each bar is enforced twice, for two different reasons: by **absence in the table**
(the surface cannot express it) and by **OS policy at run time** (the process cannot
do it when the table is wrong). The second is the containment layer's mechanism
borrowed as a second opinion, and it does not make the surface a container.

The rule that follows: **a command belongs to the surface when its contract is
expressible over the residual grants — `fs.read`, `fs.write`, a fixed `env` and
read-only `clock` — and its dangerous functions are excluded by grammar, not by
a policy check.**

Three strategies, one of which is used:

- **Reimplement.** The command is a small interpreter over the virtual filesystem.
  The dangerous feature is not implemented, so there is nothing to refuse. This is
  every row in v1: 44 POSIX and 14 Windows commands.
- **Broker.** The real binary runs with an argv the framework builds and every bar
  enforced by the OS. No row uses it yet; the families that would need it (codecs,
  `iconv`'s charset tables, `file`'s magic database) are either absent from v1 or
  served by the host runtime.
- **Deny.** A roster with a reason, not a silent gap: shells and multiplexers,
  language runtimes, editors and pagers, argv-to-exec wrappers, the privilege
  roster, network clients, host-state tools, build systems, control-plane clients,
  block devices, archive families whose writers carry a hook, and the Windows
  launcher/script-host set. `codemode2/surface.json` carries the roster as
  families — 12 of them, scoped by OS because the names collide: POSIX `expand`
  is a tab filter, `expand.exe` is a cabinet expander, and only the second one is
  on the Windows roster.

## The surface

`codemode2/surface.json` is the decision, flag by flag: for each command, its
grants, the flags it allows (an allowlist — an unlisted flag is refused), the
flags or script constructs it refuses, and the corpus class it answers for. A few
rows carry the whole argument.

- **`find`** exposes predicates only. The nine action flags — `-exec`,
  `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprintf`, `-fls`,
  `-printf` — are the dangerous half of the tool, and none of them is a search.
- **`sed`** exposes a block list without `w`, `W`, `r`, `R` or `e`, and without
  the `e` and `w` flags on `s`. The script is our grammar, so the exclusion is a
  parser fact.
- **`sort`** refuses `-o` and `--compress-program`; the first writes outside the
  redirection rule, the second is a process.
- **`split`** refuses `--filter`, which is `exec` with a file-splitting prefix.
- **`tar`** refuses `--to-command`, `-I`, `-F`, `--checkpoint-action`,
  `--rsh-command`, `--rmt-command`, `--info-script`, `-X` and `--transform`, and
  validates entry names after decompression: no absolute path, no `..`, no
  symlink, no device.
- **`cp` and `mv`** refuse the metadata flags (`-a`, `-p`, `--preserve`,
  `--attributes-only` implicitly by allowlist), because preserving a mode preserves
  setuid.
- **`ln`** makes hard links only: a symlink is a path the root check does not
  follow.
- **`jq`** refuses `-L` and the `include`/`import`/`module` builtins, because
  module loading is code loading even when the interpreter is ours.
- **`hexdump`** refuses `-e`: a format string is a second language with its own
  conversion specifiers, and the fixed formats are what inspection needs.
- **`mkdir`** takes no mode, **`chmod`/`chown`/`install`/`setfacl`** are denied, and
  nothing in the filesystem carries an executable bit to set.

## Combination safety

A pipeline is the only composition, and it is safe for one structural reason: a
stage's grade is fixed by its own row, so composing commands cannot gain a grant.
Four rules make that hold.

- **No wrapper commands.** `env`, `nice`, `nohup`, `stdbuf`, `timeout`, `time`,
  `watch`, `flock`, `setarch`, `taskset`, `chrt`, `ionice`, `xargs`, `setsid`
  and `run-parts` are denied, because each turns its own argv into a child. A
  wrapper in the table is an exec flag with a friendlier name.
- **No inherited environment.** The runtime supplies a fixed environment, so the
  seam variables the corpora do not record — `LD_PRELOAD`, `GCONV_PATH`,
  `LOCPATH`, `TAR_OPTIONS`, `PAGER`, `LESSOPEN`, `GIT_*` — are not settable. This
  is where an argv-shaped corpus under-reports, and the runtime closes it by
  construction.
- **No redirection outside the roots.** `>` and `>>` are write operations under
  the same policy as `tee` and `cp`; there is no `2>&1`-driven descriptor game
  because descriptors are pipes and the three standard streams only.
- **Write then execute is not a combination.** Nothing can execute, and no entry
  can carry an executable mode, so a written file is inert data. The time-driven
  variants — `crontab`, `at`, `systemd-run`, `schtasks`, `reg add ...\Run` — are
  on the deny roster, and the virtual filesystem has no service manager to reach.

## Verification

The research half is verifiable now, offline: the parser fixtures and the surface
invariants in `codemode2/tests/` (no `net`/`exec` grant anywhere, deny roster
disjoint from the surface, every surface command present in the projection, every
attack naming a command in the surface), and `--check` against a moved corpus
tip.

The runtime half has one acceptance test per bar, and each is a gate rather than a
review:

- every `attack-corpus.json` probe is refused or neutered, and the refusal names
  the rule — this is the corpus earning its second purpose;
- no `clone`, `fork` or `execve` succeeds in the runtime process (seccomp verdict
  or audit hook), measured on a fuzz corpus of argv mutations, not only on the
  probes;
- no socket of any family is creatable, and no name resolves;
- no write lands outside the writable roots, including through `..`, a symlink, a
  hard link, or an archive entry;
- output, CPU, memory and file count obey the runtime's caps, so a runaway
  pipeline fails as a budget verdict rather than by timing out the harness.

## Open questions

- **Filesystem truth.** [d156](d156-shmode-a-closed-shell.md) leaves the
  choice open between a virtual filesystem seeded from the tree and tools that
  hold the truth. The second breaks the moment a pipeline has a second stage, so
  this surface assumes a virtual filesystem — and inherits the question of how a
  write is synced back, if ever.
- **The engine.** An in-process JavaScript table (just-bash's shape) is where `jq`,
  `sed`'s grammar and the archive readers want to live; a QuickJS worker (pi's
  shape, [codemode-runtime-prior-art](codemode-runtime-prior-art.md)) gives a memory
  bound and a hard interrupt; [d152](d152-pymode-a-python-code-mode-extension.md)
  prices the interpreter options. The surface's JSON and text responsibilities
  decide, not taste. A sibling engine is the worked answer in
  [codemode2-prior-art](../codemode2/PRIOR-ART.md): `djs` runs pi's codemode on a
  fuel-bounded in-process wasm engine, and that survey records what it cost.
- **Whether `awk` is needed at all.** `jq` and `cut`/`sort`/`uniq` cover the
  field-walking that a coding workflow actually does, and an `awk` subset is the
  largest interpreter this surface would carry. [d153](d153-minimal-agents-over-real-runtimes.md)'s
  familiarity argument pushes the other way. [codemode2-prior-art](../codemode2/PRIOR-ART.md)
  carries the one measurement that bears on it: `awk` is 1.2% of 295,401 agent
  commands, below `cut`.
- **What brokering still buys.** Charset conversion without a table per encoding,
  `xz`/`zstd` without a codec port, and `file`'s magic database are the three
  candidates, and each costs the OS bars instead of a parser.
- **Windows parity.** `tar` on Windows validates entries; `findstr`'s regex
  dialect and `fc`'s line comparison are behavioural details with no corpus to
  check them against.
- **Path policy shape.** One root or per-command roots, whether hard links are
  needed at all, and how the visible tree is mounted are unbuilt; the grants
  vocabulary is what the choice has to keep honest.
- **Coverage measurement.** The candidate sets above are "what a workflow asks
  for", not "what an agent typed". The session log routes
  ([d180](d180-session-collection-leg.md), [d181](d181-session-ingest-route.md))
  hold the real command and flag frequencies, and measuring them is the cheapest
  way to cut this surface further — the design's own priority is terse. The same
  measurement answers the opposite question: which familiar idioms the surface has
  to keep for the model to stay in-distribution (d153). That is the fidelity half,
  and closure alone cannot score it. The method is worked out elsewhere in the
  farm: `psh` reads 295,401 commands, keeps a shape corpus of 26,234 syntax
  skeletons with a reviewed vocabulary, and classifies on the parser it executes
  ([codemode2-prior-art](../codemode2/PRIOR-ART.md)).

## Re-verify

Read from bare mirrors under `~/Downloads/references/github.com/` at these tips.
A count above is a count about that commit; `codemode2/enumerate.mjs --check`
re-reads and reports the drift.

| repo                          | tip        |
| ----------------------------- | ---------- |
| `GTFOBins/GTFOBins.github.io` | `acd52462` |
| `LOLBAS-Project/LOLBAS`       | `2056cb76` |
| `magicsword-io/LOLDrivers`    | `39c70ca6` |
| `vercel-labs/just-bash`       | `7a2a7a57` |
| `uutils/coreutils`            | `73d3e0fd` |

The GTFOBins entries are read as their frontmatter (`functions:`, `contexts:`,
`alias:`) rather than as rendered pages, so the context default is taken from
`_data/contexts.yml` and `_includes/get_contexts_label.html` (the first listed
context is the default), not from the site's prose. LOLBAS's classification is
taken from each command's `Category:` field, and its acceptance criteria from the
repository README, because the criteria are what make "Execute" mean "unexpected
execution".
