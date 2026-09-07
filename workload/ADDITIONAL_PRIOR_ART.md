# Additional Prior Art — Minimalist & Embedded Service Management

Supplementary survey of lightweight, embedded, and mobile-oriented process
supervision approaches.  These systems are especially relevant for the
`workload-runner` target environments (Termux/Android, edge, single-binary
Go deployments).

---

## 1. Gokrazy — Go-native Service Supervision

**Repo:** `github.com/gokrazy/gokrazy`

Gokrazy is a minimal, read-only Linux appliance OS for Raspberry Pi and x86,
written entirely in Go.  Its service supervisor (`supervise.go`) is a
textbook example of a **single-binary, zero-dependency process manager**.

### Architecture

```
gokrazy main → read module list → superviseServices(services)
                  │
                  └─ for each service: go supervise(s)
```

Each `supervise()` goroutine runs an infinite loop:

1. Check `stopped` flag → sleep 1s if true
2. Build `exec.Cmd` with `Setpgid=true` (process-group isolation)
3. Set `$HOME=/perm/home/<basename>`, `$PATH=/user:/gokrazy`, `$USER=root`
4. Start process → capture `os.Process`
5. `cmd.Wait()` → on exit, check exit code:
   - Exit code 125 → `isDontSupervise()` → stop supervision
   - Non-zero → log error, sleep 1s, restart
   - Zero (clean exit) → mark stopped
6. `syscall.Wait4(-pid, …)` to reap zombie children

### Key Design Decisions

| Feature | Implementation |
|---------|---------------|
| **Process-group isolation** | `SysProcAttr.Setpgid = true` + `syscall.Kill(-pid, signal)` |
| **Graceful shutdown** | `SIGTERM` → wait → `SIGKILL` after timeout |
| **Log capture** | `lineswriter` interface with ring-buffer + syslog stream |
| **State machine** | `processState` enum: `Running ↔ Stopped` |
| **Restart control** | `supervisionMode`: `Loop` / `Once` / `Done` |
| **HTTP control** | `/stop`, `/restart` endpoints with XSRF tokens |
| **Config sourcing** | Kernel cmdline → `/perm/` → `/etc/gokrazy/` |
| **HOME isolation** | Per-service `$HOME=/perm/home/<basename>` |

### Relevance to `workload-runner`

- **Single-binary supervisor** pattern is directly applicable — no external
  dependencies, works on Termux.
- `Setpgid` + process-group kill is the right model for our `Deployment`
  kind (respawn with clean process trees).
- `superviseOnce` maps to our `Pod` (oneshot) kind.
- Ring-buffer log capture + streaming channels is a clean pattern for our
  structured logging requirement.

---

## 2. Termux-Services + runsv (runit)

**Repo:** `github.com/termux/termux-services` (referenced in `termux-packages`)

Termux-services is a **service daemon for Termux** that wraps the `runit`
supervision suite.  It enables Android/ Termux users to manage background
services with a familiar `svc` command interface.

### Architecture

```
termux-services (shell wrapper)
    │
    └─ runit (C library)
         ├─ runsv    — per-service supervisor daemon
         ├─ runsvdir — watches /var/service/ for run scripts
         └─ svc      — control command (up/down/downforce/once)
```

### How It Works

1. Each service has a directory under `/data/data/com.termux/files/usr/var/service/<name>/`
2. Each directory contains a `run` script (executable bash/shell script)
3. `runsvdir` watches the service directory and launches `runsv` for each
4. `runsv` manages the lifecycle: start, monitor, restart on failure
5. `svc` commands control services: `svc up/down/once <name>`

### Key Design Decisions

| Feature | Implementation |
|---------|---------------|
| **Directory-based config** | `/var/service/<name>/run` script |
| **Per-service process** | `runsv` daemon per service |
| **Restart policy** | Automatic restart with exponential backoff |
| **Control interface** | `svc up/down/once` commands |
| **Logging** | `svlogd` for per-service log rotation |
| **Dependency** | `runit` C library (statically linkable) |

### Relevance to `workload-runner`

- The **directory-as-config** pattern is simple and shell-friendly — could be
  a fallback for native/termux execution.
- `svc`-style control commands map to our desired CLI interface.
- `runsvdir` watching for service additions is a clean hot-reload pattern.
- The `once` mode (run to completion, no restart) maps to `Pod` kind.

---

## 3. Process Compose

**Repo:** `github.com/F1bonacc1/process-compose`

A **Go-native process orchestrator** for non-containerized applications.
Uses YAML configuration (similar to docker-compose) with dependency tracking,
health checks, scheduling, and a TUI.  Runs as a single binary.

### Schema (Key Fields)

```yaml
version: "0.5"
processes:
  <name>:
    command: "string"                # Shell command to execute
    entrypoint: ["bin", "arg"]       # Direct binary + args
    availability:                    # Restart policy
      restart: "always|on_failure|exit_on_failure|no"
      backoff_seconds: 300
      max_restarts: 10
      exit_on_end: false
    depends_on:
      <dep>:
        condition: "process_started|process_healthy|process_completed|process_completed_successfully|process_log_ready"
    liveness_probe: { ... }          # Health check
    readiness_probe: { ... }         # Readiness check
    ready_log_line: "string"         # Log-line trigger
    environment: ["KEY=VAL"]         # Env vars
    env_file: ".env"                 # Env file
    working_dir: "/path"             # Working directory
    namespace: "default"             # Process namespace grouping
    replicas: 1                      # Scale to N instances
    schedule:                        # Cron/interval scheduling
      cron: "0 2 * * *"
      timezone: "UTC"
      interval: "30m"
      run_on_start: true
      max_concurrent: 1
    watch:                           # File watcher trigger
      paths: ["/path/to/file"]
    shutdown:
      command: "cleanup"
      timeout_seconds: 30
      signal: 15                     # SIGTERM
    success_exit_codes: [0, 143]     # Treat as success
```

### Architecture

```
CLI/API Input → Cobra Commands → ProjectRunner (app/)
  → Process execution with dependency resolution (DAG)
  → Health checks (HTTP, exec) + Scheduling (gocron/v2)
  → State updates → TUI (rivo/tview) / API (Gin) / WebSocket
  → Logs → ProcessLogBuffer with rotation + ANSI tracking
```

### Process Lifecycle States

```
Pending → Launching → Running → [Restarting] → Terminating → Completed/Error
```

### Key Features

- **Dependency DAG**: Topological sort with conditional waits
- **Health probes**: HTTP, exec, log-line based
- **Scheduling**: Cron expressions + interval-based with `gocron/v2`
- **Namespaces**: Process grouping for scoped management
- **Replicas**: Scale processes to N instances
- **TUI**: Terminal UI with process table, log viewer, terminal view
- **API**: REST API with WebSocket support
- **MCP**: Model Context Protocol server integration
- **File watching**: Restart on file changes

### Relevance to `workload-runner`

- **YAML schema** is a strong reference for our manifest format
- `depends_on` with conditions maps directly to our orchestration needs
- `availability.restart` policies map to our restart strategies
- `schedule` with cron/interval is exactly what we need for scheduled workloads
- `watch` for file-change triggers is a nice-to-have
- Single-binary Go deployment is our target architecture
- `replicas` concept maps to our `Deployment.replicas`

---

## 4. Other Notable Prior Art

### 4.1 Just (casey/just)

A command runner similar to `make` but with a simpler syntax.  Uses a
`Justfile` (YAML-like) to define tasks.  Relevant for **task orchestration**
patterns and dependency management within a single binary.

### 4.2 Toybox (landley/toybox)

A rewrite of GNU coreutils in ~30K lines of C.  Designed for **embedded
Linux** (Android init).  Demonstrates how to build a minimal toolset with
a single binary — relevant for our "minimize dependencies" goal.

### 4.3 Litestream (benbjohnson/litestream)

A single-binary replication tool with built-in **process supervision**.
Uses a simple config file and manages its own lifecycle.  Demonstrates
the pattern of a single binary that can both run as a service and be
supervised externally.

### 4.4 Serf (hashicorp/serf)

A decentralized cluster membership and failure detection system.  Provides
**event-driven orchestration** with gossip protocol.  Relevant for
multi-node coordination patterns, though overkill for single-host use.

### 4.5 Bakah (emersion/bakah)

A Go-based build system using JSON configuration.  Defines targets,
groups, and variables in a declarative format.  Relevant for the
**declarative config** approach, though focused on builds rather than
process supervision.

---

## 5. Comparison Matrix

| Feature | Gokrazy | Termux-Runsv | Process Compose | Systemd | K8s | **Target** |
|---------|---------|-------------|-----------------|---------|-----|-----------|
| **Language** | Go | C | Go | C | Go+C | Go |
| **Binary size** | ~10MB | ~500KB | ~30MB | ~15MB | ~200MB+ | <20MB |
| **Config format** | Go code | Shell script | YAML | Unit file | YAML/JSON | YAML |
| **Restart policies** | Loop/Once | Automatic | Configurable | Configurable | Configurable | Configurable |
| **Health checks** | None | None | HTTP/Exec/Log | None | HTTP/Exec/TCP | HTTP/Exec |
| **Scheduling** | None | None | Cron/Interval | Timer | CronJob | Cron/Interval |
| **Dependencies** | None | None | DAG | Order/Requires | Controllers | DAG |
| **Process groups** | Yes (Setpgid) | Yes | Yes | Yes | Yes | Yes |
| **Log capture** | Ring buffer | svlogd | Log buffer | Journal | Audit log | Structured |
| **HTTP control** | /stop /restart | svc | API + TUI | systemctl | kubectl | CLI + API |
| **Cross-platform** | Linux/ARM/x86 | Android | Cross | Linux | Multi | Cross |
| **Container aware** | No | No | No | No | Yes | Optional |
| **Single binary** | Yes | Yes | Yes | No | No | Yes |

---

## 6. Recommendations for `workload-runner`

Based on this research, the following patterns should be adopted:

1. **Gokrazy-style supervisor loop** — Simple, single-binary, Go-native
   supervision with process-group isolation.

2. **Process Compose YAML schema** — Adopt a similar manifest format with
   `command`, `availability`, `depends_on`, `schedule`, and `health` fields.

3. **Termux-Runsv directory fallback** — For native/termux execution,
   support a simple directory-based config as a low-friction alternative.

4. **Supervision modes** — Adopt `Loop` (Deployment), `Once` (Pod), and
   `Done` (transient) modes from gokrazy.

5. **Health check probes** — Support HTTP, exec, and log-line based probes
   from process-compose.

6. **Scheduling** — Adopt cron + interval scheduling from process-compose
   for scheduled workloads.

7. **Graceful shutdown** — SIGTERM → wait → SIGKILL pattern from gokrazy.
