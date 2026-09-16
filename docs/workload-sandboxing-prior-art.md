---
id: workload-sandboxing-prior-art
type: reference
status: draft
title: "Sandboxing prior art — bwrap / landlock / seccomp / cgroups / namespaces in the reference farm"
parent: architecture
tags: ["workload-runtime", "sandbox", "bwrap", "landlock", "seccomp", "cgroups", "prior-art"]
---

# Sandboxing prior-art survey (reference farm)

A **prior-art / what-others-do survey**, not a security or trust assessment:
the mechanism each tool claims and how it is shaped in code, as a reference
frame for the workload backend work. Our own statements live in
[container-tooling.md](container-tooling.md) (`lib/workload-runtime.sh` module
doc: podman/docker backends, the removed PRoot backend, and the bwrap
backend assessment), [d020](d020-libvirt-qemu-sandbox.md) (VM backend,
assessed) and [d043](d043-cross-repo-reference-search.md) (the farm itself).
Paths below are bare mirrors under `~/Downloads/references/`.

## Threat model of OUR runner (the lens this survey is read through)

The workload API in `lib/workload-runtime.sh` is built on explicit trust
positions, chosen on cost/benefit — record them once so the survey below
(and any future backend work) cannot silently drift into a different war:

- **The host is trusted. Defending against a truly malicious host is
  out of scope, on purpose.** A hostile host can read anything the
  workload can, tamper with the launcher, the binaries, or the kernel
  itself; the only honest responses are trusted-hardware attestation
  chains (TPM/TEE paths), which are large, egg-and-chicken dependencies
  with dubious track record for delivering a platform one actually wants
  to build on. No surveyed tool assumes otherwise either — every
  SECURITY/threat-model document in the farm lists the host kernel and
  the launcher binary as trusted bases.
- **The workload is not adversarial by intent.** The typical contents are
  our own scripts, prompt-driven agent sessions and tool chains; the
  boundaries exist for **accidents**, not for a determined attacker:
  a typo'd `rm -rf` finding itself on a bind mount of `$HOME`, an agent
  session crossing a write into another checkout mounted into the same
  tree, a vault secret forwarded too far, a data stream from one
  repository's context mixing into another's output.
- **The worst realistic escalation is prompt-injection misalignment** —
  an injected instruction turning the LLM against the user. Against a
  competent model faithfully executing a well-crafted instruction, no
  "naive sandbox" (containers + Landlock + seccomp, i.e. everything on
  the farm except the microVMs) is a real defense; the harshest honest
  verdict among the surveyed tools — "the agent running arbitrary code is
  the attack surface, every effective enforcement is OUTSIDE its
  process" (clampdown) — still only raises the cost. A real boundary
  against an aligned-with-the-prompt LLM starts at a VM with its own
  kernel ([d020](d020-libvirt-qemu-sandbox.md), assessed, not
  implemented) — and even there the operator/harness on the outside
  remains the seam every tool also names.

What this means for reading the rest of this document:

- The pitfall sections are an **engineering-care list** — gotchas that
  produce the exact accident classes named above (symlink dest-resolution,
  word-splitting, env leakage between classifications, mounts leaking
  host state) — not an attack-surface analysis.
- kern's "a boundary and a governor are named separately" rule is adopted
  as an honesty requirement for OUR docs too — not as a claim that a
  boundary is achievable against the worst case, but because conflating
  the two is how an accidental-safety layer ends up advertised as
  malicious-adversary armor.
- Consequence for scope if this threat model ever changes: domain-level
  network policy, argv-level exec policy and credential-decoy plumbing
  (the non-overlap rows below, each high-cost) only earn their keep
  against an *adversarial* workload; under the accidental-error model
  they stay out, and the overlap core (tree-scoped writes, read-only
  mounts, env allowlist, isolation of pids/filesystems) carries almost
  all of the actual value.

## The lay of the land

Four families appear across the farm, and the agent-harness tools of the last
two years keep converging on a hybrid: **namespaces for the hard boundary,
Landlock for path/port granularity on top, seccomp (often `user notif`) for
exec-time policy, and a loopback proxy + unix-socket bridge for domain-split
networking** — with cgroups used only when resource limits matter, and often
replaced by rlimits/seccomp-notif shims.

| Technique | Harder boundary | Fine-grained control | Notable in-mirror examples |
|---|---|---|---|
| mount/userns via bwrap | yes (ns) | path allow/deny via binds (coarse; symlink traps) | `anthropics/sandbox-runtime`, `fencesandbox/fence`, `didvc/{opencode,ai}-bwrap`, `cyunrei/opencode-bwrap` |
| Landlock (LSM) | no — same mount view | path RO/RW, TCP bind/connect (ABI v4), IPC scope (ABI v6) | `multikernel/sandlock`, `fencesandbox/fence`, `89luca89/clampdown`, `deepseek-ai/deepseek-harness`, `landlock-lsm/rust-landlock` |
| seccomp + `SECCOMP_RET_USER_NOTIF` | syscall filter | argv-level `execve` inspection, /proc and IP virtualization, pseudo-rlimits | `fencesandbox/fence`, `89luca89/clampdown` (sidecar), `multikernel/sandlock`, `souk4711/hakoniwa` |
| cgroups v2 | resource caps | memory/CPU/io | `souk4711/hakoniwa` (via systemd), `getkern/kern`; elsewhere replaced (fence→rlimits+notif, clampdown→seccomp-notif) |

## bwrap-only wrappers (agent harnesses)

Thin shells around `bwrap` confining an agent to the cwd, network left open
(the API is loopback-reachable or the trust line is just the FS):

- `didvc/opencode-bwrap`, `didvc/ai-bwrap` (multi-agent sequel), and
  `cyunrei/opencode-bwrap` — opencode under bwrap: RW only the cwd, rest of
  `$HOME` blocked, PID/IPC/UTS/mount unshared, config/auth dirs passed
  read-only. `didvc/ai-bwrap` adds an agent registry (Claude Code/opencode/
  Grok/plain shell).
- `helpme970/bubblejail` — bash aliases over bwrap (AppImage support,
  audio/X11 helpers); desktop-app guardrail tooling.
- `containers/bubblewrap` + `projectatomic/bwrap-oci` — the launcher itself
  and the OCI-spec-to-bwrap translator.

Implementation lessons worth keeping (all from `anthropics/sandbox-runtime`
`src/sandbox/linux-sandbox-utils.ts`, the most detailed bwrap consumer on the
farm):

- **Symlink handling is the whole game.** bwrap follows symlink destinations
  at resolve time, so allow/deny evaluation must run over *resolved* paths
  with every raw spelling tracked (`dir` vs `dir/` bind differently);
  `--ro-bind /dev/null <symlink>` aborts startup, so deny actions are
  rewritten to bind `/dev/null` onto the first non-existent/symlink
  component instead — fail closed by refusing to start when that is not
  possible.
- **The deny-bind mount points leak onto the host**: bwrap creates empty
  files/dirs on the host as mount points for nonexistent deny targets, and
  they persist after exit — srt keeps a cleanup registry keyed by mount
  points created.
- **argv-profile via `--args-fd`**: bwrap has a hard argument count/size
  ceiling; fine-grained deny lists overflow it, so bwrap args are moved into
  an unnamed temp file passed on an fd (NUL-split — a NUL in a path is
  rejected up-front).
- **Always `--unshare-pid` + fresh `/proc`** ("without it it is possible to
  escape"), `--new-session --die-with-parent`, userns chosen even for root
  callers because `bwrap` run as uid 0 grants the child every capability.
- `--clearenv`-style inversion plus explicit `--setenv` for the secret-env
  allowlist (our `workload_env_allowlist` contract, value-resolved at render
  time as predicted in container-tooling.md).

## bwrap + proxy network layer (the two big harness sandboxes)

`anthropics/sandbox-runtime` (`srt`): bubblewrap on Linux / sandbox-exec
(Seatbelt) on macOS, plus an HTTP proxy inside the netns for domain
allow/deny; MITM for observability; seccomp from a generated filter; a
violation monitor. Explicitly documents that `--unshare-net` is
all-or-nothing and domain filtering *happens at the proxy*, not in bwrap.

`fencesandbox/fence` (Go; also a library) — the closest architectural match
to a "bwrap third backend" for this repo, and the strongest source of
counter-evidence to our bwrap verdicts in container-tooling.md:

- Layers: config/policy resolution (JSONC + templates + `extends`), local
  HTTP + SOCKS5 proxies, unix-socket bridges, bwrap wrapper generation,
  Landlock re-exec (`--landlock-apply`), seccomp BPF generation, eBPF
  monitoring, violation monitoring; mandatory dangerous-path protection
  (`~/.shellrc`, nested `.git/hooks`, editor dirs) and `LD_*` sanitization.
- **`workload_publish` is NOT a hard blocker for bwrap after all.** Fence
  publishes an in-sandbox server via a *reverse unix-socket bridge*: host
  `socat TCP-LISTEN` ⇄ shared unix socket (bind-mounted into the sandbox)
  ⇄ in-sandbox bridge helper ⇒ app port. Outbound host-loopback access
  (`--unshare-net` gives the sandbox its own loopback) uses the mirror-image
  per-port bridge. This is the exact mechanism the "no slirp4netns/pasta
  port forwarding ⇒ hard blocker" row in container-tooling.md assumed
  absent — it exists, at the cost of a socat/helper per port (plus fixed
  facade ports 3128/1080 inside the netns).
- Network-namespace-less fallback: when `unshare` is unavailable (CI
  containers), direct-network isolation degrades to proxy-only best effort —
  an honest failure mode our backend detection would have to model too.
- Exec-time policy: `path` mode (bind-mask the executable) vs Linux-only
  `argv` mode — host supervisor + in-sandbox shim installing a
  `SECCOMP_USER_NOTIF` filter on `execve`/`execveat` so the *argv* of child
  execs is policy-checked. Preflight parsing understands `&&`, `||`, `;`,
  pipes and nested `sh -c` so command chains cannot bypass policy — the
  same parser-shaped problem our workload_cmd words avoid by never being
  a string.

## Landlock-centric (no namespaces, no root)

- `multikernel/sandlock` (Rust): Landlock (FS + net TCP + IPC) + seccomp-bpf
  + seccomp user notif for everything cgroups would do (memory limits,
  IP enforcement, /proc virtualization); COW via seccomp; kernel matrix is
  documented landlock-ABI-version-driven (`6.12+` for ABI v6). Ships an OCI
  runtime shim (`sandlock-oci`) pitching "namespace-less containers".
- `souk4711/hakoniwa` (Rust): the *full* puzzle in one tool — namespaces +
  pivot_root from an empty mount ns, `setrlimit`, systemd cgroups v2,
  Landlock, seccomp; network via pasta (pasta for usernet slirp work);
  ships desktop-app profiles in a separate `hakoniwa.d` repo.
- `89luca89/clampdown` — agent-in-container hardening, notable for how it
  composes around Landlock's limitations: Landlock cannot see `mount()`, so
  the container-runtime sidecar is `FROM scratch`, no shell/libc, with a
  seccomp-notif supervisor intercepting ~20 syscalls (unmounts of masked
  paths, unauthorized bind sources, unknown binary exec, firewall changes);
  Landlock rulesets applied per container for FS/egress-TCP (443/53 only on
  the auth proxy); API keys live only in a scratch-sidecar auth proxy with
  dummy keys presented to the agent. Model responsibility split between
  *runtime-provided* isolation (seccomp, iptables, namespace) and
  *in-process* Landlock rulesets applied before the agent starts.
- `deepseek-ai/deepseek-harness` — `sandbox-local` Linux chain: probe bwrap,
  else `@deepseek-ai/node-addon-landlock-run` (Landlock launcher with
  per-process read-only / workspace-write grants, mapping `/tmp` into a VFS
  path); the Web Worker profile trades kernel Landlock for a per-process VFS
  guard with identical `permission denied` classification. Shows a
  probe-and-fallback chain shaped like our backend detection, with a
  capability verdict (`read-only` / `workspace-write` / `full`) resolved per
  launch rather than per host — sisu: the same "capability-gated layer"
  pattern `llm-local-inference/generate.mjs` already uses.
- `landlock-lsm/rust-landlock` — the upstream language binding the above
  (except the node-addon) orbit around; groups features by ABI version.
- Historical base layer: `valpackett/rusty-sandbox` (Capsicum/pledge-first
  design; Linux "TODO … seccomp, O_BENEATH never accepted") is a snapshot
  of exactly the gap Landlock (5.13+) later closed, and `tailhook/unshare`
  is the namespace library that pre-dated it.

## Container-shaped but daemon-less: kern and ruri

- `getkern/kern` (Rust, static binary): a full *runtime* (OCI pull, box,
  lifecycle, SDK, compose) in one process, no daemon; kernel-enforced
  container in ~3.5 ms; seccomp deny-by-default allowlist; cgroup v2 for
  resources; macOS via Linux VM only. Its own `FAQ` positions itself
  against bubblewrap ("bwrap is a sandbox launcher; kern is a runtime") —
  i.e. the srt/fence pattern plus the OCI layer our `workload_image`
  blocker row assumed missing. The strongest "third backend would also
  work" datapoint: if a bwrap backend is ever pursued, kern shows the
  image problem can be solved without podman.
- `RuriOSS/ruri` (C): lightweight rootless/rootful chroot-with-features
  builder for the "when cannot docker" hosts; container tinkering tool,
  adjacent rather than competing.
- `sandbox-utils/sandbox-run` / `sandbox-venv` — pure-bash sandbox wrappers
  (whitelist pids/syscalls/caps world); the "least machinery" end of the
  spectrum, and a reminder that our own `lib/` already sits close to it.
- `DavHau/nix-portable` — runtime *selection* pre-run: userns → proot
  fallback per host capability, same probe-chain shape as fence/deepseek.

## The PRoot corner (cross-check against our backend removal)

Our PRoot backend removal ("ptrace path translation, not isolation") matches
the farm's own characterizations:

- `bubbleroot` (`codeberg.org/valpackett`) — a cursed-by-choice bwrap→proot
  translation script whose *reason to exist* is exactly hosts where
  namespaces are unavailable (unprivileged Docker, Termux): ptrace as the
  reachability fallback, never the guardrail.
- `rootless-containers/runrootless` — proot + runc for rootless-without-
  userns OCI bundles; niche, unmaintained-era shapes.
- `termux/proot` + `termux/termux-packages` mirror the Termux side our
  termux-serving retirement already documented in termux-serving.md.

## cgroups prior-art corner

Nothing on the farm restricts *agent workloads* with plain cgroups alone;
it always appears as one layer:

- `hakoniwa`: cgroup v2 via systemd - the classic topology (and a hint that
  a systemd-slice-based backend is probe-able, not that we need one).
- `kern`: cgroup v2 behind resource profiles (its `docs/RESOURCES.md`).
- `clampdown`, `sandlock`, `fence`: deliberately cgroup-free, substituting
  rlimits + seccomp-notif (clampdown's sidecar) or `SIGSTOP` accounting
  (sandlock) to stay zero-privilege. Their tradeoff is explicit: weaker
  memory limits, simpler UX.

## The layer above the backend: declarative workload orchestration, VMs, micro-VMs

The survey so far lives at the granularity of ONE launch command. The field
also has the layer above it — describing *sets* of workloads declaratively —
and the layer beside it — VM/micro-VM substrates. Both were swept for in the
farm; this section records what is present, warns about what is missing, and
maps the finding onto our description-driven runner.

### Declarative orchestration — on the mirror

| Repo (present) | Shape | Prior art it offers vs `lib/workload-runtime.sh` |
|---|---|---|
| `podenv/podenv` (Haskell, Dhall config) | the **closest architectural cousin of our description API**: a capability schema toggles (wayland/audio/dbus/network), smart volumes, runtime selection (podman, bwrap-like, nix flakes) — a *typed* description rendered to backend flags, which is exactly our scalars+`workload_LISTS`+renderer split with schema-level typing | the argument for one typed description rendered into ANY backend (the user-namespace model podenv applies to daemon-LESS runtimes: rootless podman AND non-containerized commands); its isolation-by-default capability checklist is a design review for our `workload_hardening` defaults |
| `containers/podlet` | generates Podman **Quadlet** (systemd unit) files from podman CLI, compose files, or existing objects | the "declarative-ize the imperative renderer" inverse of our `_render_container`: quadlet/classical systemd-merged units are the host-native way to persist a workload description — the tool our run scripts already walk around (run.sh is imperative render + launch), kept as the "if/when systemd owns the workloads" candidate |
| `containers/podman-compose`, `compose-spec` shape | compose-spec over podman, daemonless process model | the standard multi-service declarative shape (deps, volumes, networks, healthchecks). Our model covers single-service; llama-swap + llm-reverse-proxy + coding-agent run on the same host but do NOT share a lifecycle — that is exactly the point where compose would buy something, and we are deliberately not there (each workload has its own run.sh + reload semantics in d041) |
| `F1bonacc1/process-compose` | declarative YAML scheduler/orchestrator for NON-containerized processes (single Go binary, no daemon) | the declarative orchestration that fits the retired termux-native serving world (and any future no-container backend): deps, health probes, restart policy WITHOUT a container stack — the shape a non-backend process supervisor would take if ever needed |
| `devcontainers/cli` | devcontainer.json → build/up/exec lifecycle + features/lockfiles | the ecosystem-standard declarative dev-container contract; our `coding-agent/` generator tree deliberately IS the role devcontainer features play elsewhere — comparing shows our generator emits CONTENT (models.json, auth files), not a dev-tool spec, so adopting devcontainer.json would buy interop at the cost of losing the generated-state model (the thing d041 pinned: runners never generate) |
| `containers/toolbox`, `89luca89/distrobox` | interactive container dev environments over podman | container-as-CLI-environment UX; shows what a "workload" means when the user IS the workload (shell-first, home-shared) — the opposite end of prio from our serve-side parameters |
| `systemd/mkosi` | declarative bootable OS disk images (mkosi config, systemd-initrd, VM/QEMU integration) | declarative IMAGE building for the VM path — the shape `build.mjs` would take for guests; complementary to crun-vm below |
| `NixOS/nix` (+ `nixfmt`) | the fully declarative configuration/package end | not a runner, but the substrate every declarative Nix-based runtime (podenv flakes, microvm.nix — see WARN) sits on |

Verdict on the orchestration layer: our two-halves description (shell
scalars + jq filters) is the same idea as podenv's typed schema and
quadlet's unit file, one level of tooling lower. Nothing surveyed makes the
single-service description smaller; adopting one would force the multi-
service lifecycle problems we do not have. The real takeaway is podenv's
"runtime" concept: the description API should outlive ANY backend, which
container-tooling.md's "backend dialects" wording already assumes.

### VMs and micro-VMs — on the mirror

- `containers/crun-vm` — an OCI runtime that lets podman/docker/k8s run
  QEMU VM images. **This is the key bridge for the d020 Level-2 libvirt
  backend**: a `workload_image`-shaped VM would keep the OCI pull/build
  story (the blocker row that killed a hypothetical bwrap backend) instead
  of inventing a VM-image store — crun-vm is the prior art that lets that
  backend render like a container dialect.
- `apptainer/apptainer` — HPC container model (same-source container and
  VM modes; on no-subuid hosts it proves the "image is a file" alternative
  edge of the field).
- `containers/crun` (the runtime crun-vm plugs), `containers/common`,
  `containers/crun`-adjacent OCR specs — present as needed substrate.
- Micro-VM *orchestrators* (E2B-style agent clouds, firecracker fleets,
  microvm.nix): **NOT on the mirror** — see the warning list; the only
  farm traces of the micro-VM-per-call world are kern's FAQ (naming E2B/
  Modal/Daytona as the hosted-class comparison) and d020's assessment.

### WARN/mirrored — the orchestration/VM-layer repositories

Everything the analysis called load-bearing for the orchestration/VM layer
is now mirrored and **verified readable** (git rev-parse/log/branch OK,
`container_file_t` labels — no host-side relabeling needed; note
`~/Downloads/references` is read-only from the container side, so relabel
or freeze-time fixes must happen host-side):

- `qemu/qemu`, `libvirt/libvirt` — d020's own subjects: the libvirt
  domain XML / virt-install / qemu cmdline surface a VM backend would
  render against, with a primary source on the farm at last.
- `firecracker-microvm/firecracker` (+ `firecracker-microvm/firecracker-containerd`)
  — the micro-VM per-call substrate most agent-cloud services are based on;
  the reference point for d020's "stronger than container" tier.
- `kata-containers/kata-containers` — OCI micro-VM runtime (the standard
  answer for "k8s-compatible VM workload").
- `cloud-hypervisor/cloud-hypervisor` — verified. `google/crosvm` — **the
  strongest agent-sandbox prior art on the farm now**: multiprocess VMM
  whose per-device processes are each `fork`-but-not-exec and jailed via
  minijail (namespaces + seccomp), with per-device seccomp policy files
  committed per-arch in `jail/seccomp/{arch}/{device}.policy`
  (ARCHITECTURE.md, verified) — the industrial escalation of
  "each device is its own sandboxed process", and the reason
  `google/minijail` (already mirrored) matters to this survey.
  `google/alioth` — verified present (Rust VMM, control-socket-less
  candidate row in microvm.nix's matrix).
- Matrix completeness: `kvmtool/kvmtool` — verified (tiny C VMM, the
  no-virtiofs/no-control-socket matrix row); `openeuler-mirror/stratovirt` —
  verified (Huawei's firecracker-class Rust VMM, same row shape). All
  Linux hypervisor rows of microvm.nix's matrix now have a primary source
  on the farm.
- Deliberately NOT mirrored, as a recorded choice: `crc-org/vfkit` — the
  macOS-only matrix row (no 9p shares, no tap/bridge networking); macOS
  is not a supported environment for this repo's workloads, so the last
  matrix row stays verifiable only through microvm.nix's table.
- `microvm-nix/microvm.nix` — declarative micro-VM management (libvirt/
  cloud-hypervisor + systemd integration, Nix) — the built-out version of
  the mkosi+podenv shape above. (NB: the project moved from the old
  `astro/` org — mirror by the org above.)
- `compose-spec/compose-spec` — the reference spec podman-compose
  implements; needed before adopting/authoring compose shapes.
- `e2b-dev/runtime` — agent micro-VM cloud services as open source
  (kern FAQ's named class); prior art for "VM per tool call".
- `youki-dev/youki` — the lightweight Rust container runtime (cgroup v2
  unified only, rootless verified in-tree); prior art for a kern-class
  own-runtime.

#### What the primary sources now grant to the capability maps and issues

Round-trip check of survey claims against the actual mirrors — deltas
found where the survey previously had no source and hand-drawn rows:

- **microvm.nix's hypervisor-restrictions matrix is a ready-made
  capability table for the VM layer** — and it directly sharpens the
  d020 workspace-share row: firecracker and cloud-hypervisor ship no
  9p/virtiofs (the entire micro-VM tier supports only
  block-device/overlay roots), so a rw *workspace share* (d020 §5,
  virtiofs + idmap) is a **QEMU/libvirt-tier capability**, not a micro-VM
  one — micro-VMs take a full in-guest clone + push-back instead.
- **e2b runtime (`docs/ARCHITECTURE.md`)** — the agent-VM-as-a-service
  primary source; its architecture doc names the issue class the farm had
  no source for: **"a sandbox is a resumed snapshot"** (restore
  pre-booted VM state from object storage), plus per-node orchestrator,
  in-VM agent and edge routing — meaning the per-call cost a micro-VM
  product actually optimizes is RESTORE time, not boot time; this pins
  the d020 snapshot-rollback idea against the industrial shape.
- **firecracker FAQ** answers the container-ecosystem question explicitly
  (it integrates through satellite projects: kata +
  firecracker-containerd). Firecracker itself deliberately stays minimal
  (no ports, no file shares, no control API beyond vsock/blk) — the same
  "launcher-not-runtime" shape bwrap has; its Jailer (recursive chroot,
  cgroup/ns setup, drop-privs) is host-tenant hardening against a
  malicious VM, **not** a policy mechanism for the workload — the same
  boundary/governor split kern's docs demand, one tier up.
- **kata-containers**: security fixes land on the current monthly
  rolling release only — **no LTS branches** (SECURITY.md, verified); a
  deployment-cost fact for the VM tier, not CVE prose.
- **compose-spec (schema verified)**: the field set (`depends_on`,
  `healthcheck`, `pids_limit`, `ulimits`, `devices`, `security_opt`) is
  the vocabulary the compose tier promises — every one of those has a
  corresponding or consciously-absent row in our API (healthchecks: none;
  pids/ulimits: not surfaced; devices: GPU-only via detect script) — a
  clean checklist confirming the never-adopted-a-compose decision stays
  cheap unless lifecycle+healths are wanted.
- **crun-vm cross-check (verified in README)**: only loads
  QEMU-compatible images via OCI — it is the translation layer, not an
  isolation boundary of its own; the VM tier's capability claims in the
  tables above stay anchored on the per-hypervisor rows (microvm.nix
  matrix, firecracker FAQ), not on crun-vm itself.

Caveat — these are fresh mirrors, so the Zoekt search index (d043) does not
cover them until the indexer is re-run (host side, given the read-only
mount). Until then fall back to plain `git -C <repo>.git grep`/`show`.

Still deliberately NOT mirrored (wrong altitude for a single-host workload
runner; documented so the omission reads as a choice): `kubernetes`,
`nomad`, `swarmkit`, `k3s`/`k0s` (both elsewhere on the mirror from other
interests are enough to survey the mass-provisioning shape we do not
want), plus `Qubes` (the strongest OS-level VM partition of all, and
exactly the wrong complexity class for a small host).

## Convergence summary (what to take from it)

1. **Networking via proxy + unix-socket bridges** is the consensus answer
   to bwrap/netns + domain policy, and it *also* solves publishing from an
   isolated netns. Mechanism worth a d-doc before any bwrap work:
   fence's reverse bridge removes the hard-blocker status of
   `workload_publish` (feasibility only — podman's `-p` remains the right
   choice for llama-swap serving).
2. **Capability-probe fallback chains** (bwrap→landlock, userns→proot,
   seccomp-notif→rlimits) are ubiquitous — mirror of our
   `detect_workload_tool` + capability-gated generation.
3. **seccomp user notification is now the standard way to add
   not-just-static syscall policy** (argv exec checks, /proc virtualization,
   soft memory limits) without root/cgroups — kernel 5.6+.
4. **Landlock granularity is bounded by ABI version**, and every serious
   user keeps namespaces as the real boundary; Landlock is the *second*
   line. Landlock cannot police `mount()` (clampdown's whole sidecar design
   exists because of that).
5. **bwrap foot-guns documented repeatedly**: symlink dest-resolution,
   host-leaking deny mount points, argv ceiling (`--args-fd`), mandatory
   `--unshare-pid`, env inversion (`--clearenv`), no init → explicit
   zombie-reaping shim. All consistent with the assessment table in
   container-tooling.md, and additive detail if that work ever happens.
6. **Env sanitation (`LD_*`/`DYLD_*`) and dangerous-path protection**
   (`.git/hooks`, shell rc files, editor dirs) are table stakes in every
   harness-grade tool, on both platforms.

## Overlap map: what everything can do vs what is unique

Read this as a capability-intent map, not a benchmark: each tool claims the
row, cost is the effort for **this repo's workload layer**
(`lib/workload-runtime.sh` + backend dialects) to make that row work — so
"free" = already expressed by our description API and renderable for at least
podman/docker today, "shim" = small new helper/filter, "branch" = a new
backend dialect or per-backend feature branch, and "boundary" = no mechanism
of that class can honestly provide it (a governor at best, kern's wording).

### The overlap core (everything surveyed can do this)

| Capability | srt | fence | sandlock | hakoniwa | kern | containers (podman/docker) | Mechanism under it |
|---|---|---|---|---|---|---|---|
| restrict FS writes to a tree | ✔ binds | ✔ binds+Landlock | ✔ Landlock | ✔ Landlock | ✔ rootfs | ✔ rootfs/bind | mount or LSM ruleset |
| read-only tree / path masking | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | same |
| process isolation (no peer pids/signals) | ✔ (`--unshare-pid`) | ✔ | ✔ (SignalScope v6) | ✔ pid ns | ✔ pid ns | ✔ pid ns | namespace or net-notif scoping |
| clean env allowlist | ✔ `--clearenv`+setenv | ✔ sanitize + setenv | ✔ builder | ✔ | ✔ | ✔ `--env` | env table |
| deny-by-default posture | ✔ | ✔ | ✔ (refuses on missing protection) | ✔ | ✔ seccomp | ✔ cap-drop/seccomp | config default |
| run without root | ✔ userns | ✔ userns+Landlock | ✔ (never needs it) | ✔ | ✔ | ✔ rootless | all unprivileged primitives |
| default deny (template) profiles | ✔ settings.json | ✔ templates+`extends` | ✔ profiles | ✔ hakoniwa.d | ✔ resource profiles | ✔ (ours: layers) | static config |

That core IS the feature set a minimal backend must deliver; everything
below diverges. Sanity check against our API: `workload_ro`/`workload_rw`,
`workload_env_allowlist`, `workload_hardening`, and description-driven
config cover the whole overlap core today for the container backends.

### The non-overlap (where each wants to sit)

| Capability | Only (first-party shape) | Mechanism | Cost for this repo to cover |
|---|---|---|---|
| OCI image as the unit | containers (podman/docker), kern | pull/build/layer store | none — `workload_image` + the root `build.mjs` is this story; stays the default backend |
| daemon-less runtime, no socket at rest | kern (bwrap-family too, but no runtime) | one static binary | not needed while backend detection runs ephemerally; a third dialect would trade `workload_logs`/`workload_rm` for a pidfile machinery (assessed in container-tooling.md) |
| domain-level network policy | srt, fence, clampdown (proxy) , sandlock (seccomp-notif) | in-netns HTTP/SOCKS proxy with unix-socket bridges; or Landlock TCP + seccomp rules | high for the container backends (they already get network from the netns — the cost only shows in a bwrap/dialect-less no-net backend, fence needed ~1 proxy + ~1 bridge helper per direction) |
| per-port publish from isolated netns | fence, sandlock (`allow_bind`) | reverse unix-socket bridge / Landlock BIND_TCP | medium: a `bridge-the-port` path per backend; only worth it if serving ever leaves podman |
| syscall filtering | kern (moby default, 35 escapes), container runtimes, sandlock, fence, srt | seccomp-bpf | free-ish via containers (already attach runtime default) ; a new filter generator is one more artifact to freeze/verify |
| argv-level exec policy | fence, clampdown sidecar, deepseek (grants) | `SECCOMP_USER_NOTIF` supervisor + shim | boundary-ish: a supervisor process, a versioned bootstrap plan and a pidfd watcher — the most involved class on the map; the workload API currently has no surface for it (a `workload_exec_policy` would be its hook point) |
| resource ceilings (honest memory limit) | containers (cgroups v2), kern (profiles), hakoniwa (systemd) | cgroups | free in containers; governor-at-best in the Landlock/seccomp-notif stacks (sandlock: notif + SIGSTOP accounting) — the tradeoff sandlock/fence both called out |
| GPU passthrough | containers (`--device`), bwrap (`--dev-bind`) | device nodes | our `workload_gpu` already maps 1:1 for both; Sandlock-style Landlock/seccomp stacks have **no GPU story** (kern: no VRAM cap in userspace is a boundary) |
| SELinux relabel of mounts | containers (podman `z,U`) | kernel labeling | boundary — no bwrap/Landlock equivalent (`--exec-label` sets a process label at most); the static-binary runtimes sidestep relabeling entirely. Corroborates, not challenges, the container-tooling.md verdict that podman stays for serving |
| agent-policy plumbing (MCP whitelists, hooks, config import) | srt, fence, clampdown | config plumbing, agent side | out of scope for a sh workload layer — it lives above the runtime, in the agent config |

Reading of the map: on the rows our serving path needs (image, publishing,
GPU, SELinux, resources) the **container backend is the superset**, while a
Landlock/bwrap layer buys the features our description API does not expose
(argv-level exec policy, per-port bind ACLs, /proc virtualization via
seccomp-notif). Telling consequence: nothing surveyed replaced its container
backend once one existed — Landlock, seccomp-notif and the unix-socket
bridges all landed ON TOP of whichever boundary the tool already had. The
only bwrap-first tools (srt, fence) exist because a container was declared
out of their design surface, not because containers failed.

## Prior-art pitfalls, gotchas, and issues per solution

Each entry: what the tool itself puts on record (SECURITY.md, "known gaps",
"out of scope" — the primary sources these projects maintain), plus the
systemic gotchas repeated across the field.

### bubblewrap (bwrap) — and the wrappers on it

- **Symlinks defeat naive allow/deny.** bwrap resolves bind destinations at
  mount time and binds `dir` and `dir/` differently; srt had to
  re-evaluate every rule over *resolved* paths while tracking all raw
  spellings, and rewrite "deny" to "bind `/dev/null` onto the first
  non-existent/symlinked component path" (straight `--ro-bind /dev/null
  <symlink>` aborts startup).
- **Deny mounts leak onto the host.** The `/dev/null` stub binds for
  nonexistent paths create host files that persist after bwrap exits; srt
  keeps a cleanup registry to reap them.
- **argv ceiling.** Fine-grained deny lists overflow bwrap's argument
  limit; the answer is `--args-fd` with a NUL-split file (and paths
  containing NUL are unrepresentable, rejected up-front).
- **Mandatory namespaces.** Every consumer lands on `--unshare-user`
  always (even for root callers — bwrap as uid 0 gives the child every
  capability), `--unshare-pid` always, fresh `/proc` always; skipping the
  PID unshare "is possible to escape" (srt's wording).
- **No ports, no daemon, no init.** Publishing needs the unix-socket bridge
  dance (fence), backgrounding needs pidfile/setsid/log-file shims, and
  zombie reaping needs an explicit tini-style init — `--die-with-parent`
  does NOT reap children. Not hypothetical for us: llama-swap spawns
  llama-server children, which is why `workload_init` exists.
- **Env is inverted by default.** Working allowlist = `--clearenv` + one
  `--setenv` per var — the same inversion our `workload_env_allowlist`
  would need to carry as a bwrap dialect value-resolve, not name-forward.
- **It is a launcher, not a runtime.** kern's FAQ names it: no lifecycle,
  no image handling, no resource profiles; a policy means re-generating
  the full bwrap CLI per command — which is exactly what srt and fence do.

### Landlock (LSM)

- **ABI version granularity.** Every feature has a floor: FS refer v2,
  truncate v3, net-TCP v4 (6.7+), ioctl-dev v5, SignalScope + abstract-UX
  v6 (6.12+). sandlock refuses to start missing protections unless you
  opt into `allow_degraded`/`disable` — silent downgrade vs hard-fail is a
  policy you must write, not inherit.
- **Cannot see `mount()`.** The reason clampdown's whole sidecar exists:
  mount/unmount of masked paths bypasses Landlock, so binding mounts need
  an outer mechanism (seccomp-notif supervisor intercepting the mount API).
- **No cgroups-era limits.** Memory/CPU need something else (sandlock:
  seccomp-notif + SIGSTOP accounting); Landlock is access control, not a
  governor.
- **No GPU/device controls.** Landlock today has no device-node/iomem
  scoping; sandlock and fence both fall back to no `/dev` exposure at all
  rather than fine-grained device access — devices belong to namespaces
  or outer cgroup/driver controls.
- **The ruleset guards this process only.** A fork made before applying
  the ruleset is unrestricted; every tool therefore applies it in a shim
  that immediately `exec`s the workload (`--landlock-apply`,
  landlock-run, `fence --linux-apply`) — and the shim itself runs
  unrestricted, so it must stay trivial and short-lived.

### seccomp (+ user notification)

- **Static BPF is two-verdict only** (kill / ENOSYS). Anything conditional
  — "this exec path is fine, that one isn't", /proc virtualization, soft
  memory caps — needs `SECCOMP_USER_NOTIF` (kernel 5.6+), i.e. a host-side
  supervisor process with a lifecycle, a message protocol, and the
  pidfd/procfs race questions fence answers with a versioned bootstrap
  plan and a pidfd-watching bridge helper.
- **A notification is only as good as its path resolution.** A supervisor
  reconstructing the exec path from a user-notif message must re-derive it
  from `/proc` (with pidfd pinning), or the classic TOCTOU
  `/proc/<pid>/exe` swap wins; fence's `runtime_exec_argv_linux.go` exists
  precisely because of this race class.
- **ABI/alias surface.** kern explicitly kills wrong-arch syscalls and the
  whole x32 ABI ("x32 alias of a denied number slips") — the bypass every
  hand-rolled filter forgets.
- **Governor, not boundary.** "A userspace cap is a quota, not a boundary"
  is kern's line about VRAM; seccomp-notif memory limits are the same
  class (sandlock's SIGSTOP accounting sits there too).

### namespaces (user/mount/net/pid) + containers

- **The userns is attack surface.** kern's threat model states it plainly:
  "running untrusted code in a box hands that code the in-kernel namespace
  surface to probe" — userns has a long kernel-CVE history. Fine for
  semi-trusted workloads, a worth-considering tradeoff for hostile ones
  (microVM per call in kern/others' FAQ).
- **Kernel trust remains an asterisk.** Even the VM backends inherit the
  host kernel; the microVM/VM-fork (our d020) is the only hop off that
  boundary — the exact trade every surveyed tool names and none solves in
  the same tool.
- **Rootless containers' fixed plumbing costs**: no ports <1024, no
  `CAP_MKNOD` (GPU only via pre-existing nodes — the reason
  `workload_gpu`/`detect_gpu_devs` are built the way they are),
  `/etc/subuid` setup, userns-mapping quirks (`--userns=keep-id`, and `U`
  on SELinux mounts so files do not land chowned to a raw subuid).
  Measured costs this repo has already paid.
- **Network namespace gives only all-or-nothing.** Per-host filtering
  lives OUTSIDE the namespace (srt/fence proxies) or in Landlock's
  BIND_TCP rules (TCP only — no UDP-bind ACL in any ABI); nothing on the
  field does per-domain UDP policy without a proxy.
### Dynamic-loader env (repeated across every stack)

- **`LD_*` / `DYLD_*` sanitization is universal in harness-grade tools**
  (blocks write-then-exec library injection); fence applies it twice, even
  inside its Landlock wrappers. Cheapest adoption candidate for us: the
  `workload_env_allowlist` forwarders currently do NOT strip `LD_*`.

### proot / ptrace era

- **It is translation, not isolation.** The reason for this repo's PRoot
  removal, and the reason bubbleroot exists at all: ptrace path-translation
  fills the gap on hosts where namespaces are unavailable (unprivileged
  Docker, Termux) but provides no kernel boundary — the farm uniformly
  uses it as a reachability fallback, never as the guardrail.

### cgroups

- **Resource governor ≠ boundary.** With or without delegation, cgroups
  memory/CPU caps are governor-only (bar the OOM semantics); nobody on the
  farm leans on them as a security perimeter.
- **Delegation topology is the real cost.** hakoniwa routes through
  systemd (user slice) — the cost model is that a runtime setting up
  cgroup v2 without systemd needs either root or pre-delegated subtrees;
  that wiring is why the field again and again reaches for rlimits and
  seccomp-notif instead.

### Tool-specific honesty-on-record

- `kern` (SECURITY.md / THREAT_MODEL.md): host kernel and user-ns are the
  trusted base ("a kernel privilege-escalation bug is an escape", and the
  userns it builds on has a long kernel-CVE history); **no GPU cap ships
  by design** — its reasoning is quotable: a workload reached the driver
  with a raw ioctl and a userspace VRAM cap was bypassed, so a cap ships
  only where the device enforces it (MIG/SR-IOV), and they keep a pentest
  suite to keep the claim honest; the runtime registry is a listed asset
  (it holds peer boxes' secrets and posture); and their doc rule —
  "a boundary and a governor are named separately" — is the standard every
  sandbox document should hold itself to.
- `fence`: an honest degraded mode when network namespaces are unavailable
  (proxy-only, direct-net isolation lost — a failure mode our backend
  detection would have to model too); a mandatory short-lived `linux-init`
  bootstrap; per-port bind defaults shaped by WSL2's automatic localhost
  forwarding (documented there, not portable lore).
- `sandlock`: refuses to start when a required Landlock protection is
  missing unless told otherwise (`allow_degraded`/`disable`) — the
  anti-side of the fallback chains, and the deployment friction that comes
  with it on mixed kernel fleets; either posture is fine, but a silent
  half-sandbox must be a decision, never an accident.
- `hakoniwa`: "Running untrusted code is never safe, sandboxing cannot
  change this" is literally the README warning; and the tool is thin while
  the profile corpus (makepkg, firefox, apps) is the product, shipped in
  the separate `hakoniwa.d` repo — the tooling/profiles split is itself
  the lesson.
- `bubblejail` / `sandbox-run`: the least-machinery end of the field —
  bash wrappers that inherit every bwrap/whitelist problem and add shell
  quoting/splitting hazards the compiled tools closed (the same
  word-splitting class our jq description refactor removed); useful as
  the lower bound and as a caution about how quickly "just a wrapper"
  grows a policy language.
- `deepseek-harness`: the emulated-confinement honesty: a per-process VFS
  guard stands in for kernel Landlock inside Web Workers, and the doc
  explicitly lists "protection against a future shell program that bypasses
  ShellFileSystem" as NOT covered — emulated confinement stays emulated.
- `rusty-sandbox` (valpackett, codeberg): the pre-Landlock snapshot of
  "Linux is the hard one" (Capsicum/pledge-first design; O_BENEATH never
  accepted into the kernel) — the demand Landlock 5.13+ later met; its
  fd-only-IO sandbox model is still what the Capsicum-first camp
  re-converges on.

## Candidates not on the mirror (to add, if the topic gains traction)

These were named in the surveyed tools/readmes but are NOT in
`~/Downloads/references/` yet. (The orchestration/VM-layer candidates have
their own WARN list under "The layer above the backend" — this one is the
agent-sandbox side.)

- `openai/codex` — the other major agent sandbox: Seatbelt on macOS,
  Landlock + seccomp on Linux, from-scratch proxy for network policy; the
  tool several of the above compare themselves to.
- `openai/container-sandbox`-style microVM-per-call services shaping
  (E2B/Modal equivalents are referenced by kern's FAQ but not mirrored).
- `firejail/firejail` — the long-running setuid-helper alternative;
  useful mostly as cautionary prior art (a long history of setuid attack
  surface bugs names the whole class).
- `lxc/incus` / `systemd` `systemd-nspawn` docs — namespace-based but
  managed; only if a cgroup/systemd-slice backend is ever considered.
- `Netflix/bpfmon`-grade eBPF monitors — fence references the *idea*
  (ebpf monitoring) without shipping much; a kernel-BPF-policy reference if
  violation monitoring is ever wanted.

Sync any fetched one via `git/-forge-mirror.sh` (docs/d043).
