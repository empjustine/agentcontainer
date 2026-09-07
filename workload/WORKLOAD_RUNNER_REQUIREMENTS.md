# Workload Runner Requirements

## 1. Introduction
The `workload-runner` is a specialized orchestration tool designed to execute complex workloads (e.g., LLM inference, coding agents, proxy services) across heterogeneous environments, specifically targeting **Containerized Linux** (via Podman/Docker) and **Native Android/Termux** (via direct execution).

This tool replaces the existing collection of shell scripts (`run.sh`, `generate.sh`, `build.sh`) which have become overly complex, brittle, and difficult to maintain due to heavy reliance on shell-specific "glue" and process management.

**Note on Nomenclature:** We use the term "Workload Runner" rather than "Sandbox Runner" because, in environments like Termux, the execution may not provide true sandboxing. The tool's responsibility is **orchestration and environment provisioning**, not isolation itself.

## 2. Core Objectives
- **Unify Execution:** Provide a single, consistent interface for running workloads, regardless of whether the backend is a container or a native process.
- **Structured Configuration:** Move from imperative shell scripts to a declarative, Kubernetes-inspired manifest format.
- **Robust Process Management:** Replace fragile shell-based PID/process tracking with a reliable, Go-native supervision model.
- **High-Fidelity Secret Injection:** Implement a sophisticated, metadata-driven secret injection system using Infisical.
- **Minimize Overhead:** Reduce the "sub-process storm" caused by shell scripts calling `jq`, `grep`, `sed`, `cat`, etc., by implementing core logic in a single compiled Go binary.

## 3. The Manifest Model (Kubernetes-Inspired)

The runner shall consume a YAML manifest following a schema derived from Kubernetes specification. The `kind` field determines the orchestration logic (the "Control Loop") applied to the workload.

### 3.1 Workload Kinds

#### `kind: Pod` (Oneshot)
A single, ephemeral instance of a workload. The runner executes the workload and terminates once the process exits.
*   **Use Case:** Batch jobs, one-time model downloads, or short-lived utility tasks.

#### `kind: Deployment` (Resilient/Long-running)
A controller that ensures a specified number of `replicas` are always running. If a process dies, the runner automatically respawns it.
*   **Use Case:** API gateways, LLM inference servers, or persistent proxy services.

#### `kind: VirtualMachine` (Full VM)
A specialized workload representing a full virtual machine (e.g., QEMU/KVM). The runner manages the emulator process and its associated hardware requirements.
*   **Use Case:** Running legacy OSs, specialized kernel-dependent workloads, or high-isolation environments.

### 3.2 Schema Examples

#### Deployment Example
```yaml
apiVersion: workload.mostlygeek.io/v1
kind: Deployment
metadata:
  name: llama-swap-server
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: llama-swap
          image: ghcr.io/mostlygeek/llama-swap:unified-vulkan
          resources:
            limits:
              amd.com/gpu: 1
      volumes:
        - name: config
          hostPath:
            path: ./config.d
```

#### Pod Example
```yaml
apiVersion: workload.mostlygeek.io/v1
kind: Pod
metadata:
  name: model-downloader
spec:
  containers:
    - name: downloader
      image: alpine:latest
      command: ["wget", "https://example.com/model.gguf"]
```

#### VirtualMachine Example
```yaml
apiVersion: workload.mostlygeek.io/v1
kind: VirtualMachine
metadata:
  name: legacy-linux-vm
spec:
  image: /path/to/debian-server.qcow2
  resources:
    limits:
      cpu: "2"
      memory: "4Gi"
  # VM-specific configurations
  emulator: qemu
  args: ["-enable-kvm", "-m", "4G"]
```

## 4. Secret Management & Injection

To avoid "magic strings" and provide a professional-grade integration with Infisical, the runner shall support a specialized `Secret` kind.

### 4.1 The `Secret` Kind
Instead of manual environment variable mapping, users can define a `Secret` object that carries the necessary context for the Infisical provider.

```yaml
apiVersion: workload.mostlygeek.io/v1
kind: Secret
metadata:
  name: my-app-secrets
  annotations:
    "com.infisical.domain": "production"
    "com.infisical.projectId": "abc-123"
    "com.infisical.env": "prod"
    "com.infisical.path": "/path/to/secrets"
```

### 4.2 Injection Mechanisms
The runner shall support two ways to consume these secrets:

1.  **`secretRef` (Per-variable):** Maps a specific key from the defined `Secret` object to a specific environment variable in the workload.
2.  **`envFrom` (Bulk injection):** Injects all keys from the defined `Secret` object as environment variables into the workload.

## 5. Functional Requirements

### 5.1 Runtime Abstraction
- **Container Runtime:** The runner must translate the manifest into a `podman` or `docker` execution command, handling volume mounts, resource limits, and environment variables.
- **Native Runtime:** The runner must execute the workload directly on the host (e.g., Termux). It must handle environment provisioning and, if requested via manifest/CLI, trigger a native build process.
- **VM Runtime:** The runner must manage the lifecycle of an emulator process (e.g., QEMU), translating resource requirements into appropriate emulator flags.

### 5.2 Resource & Volume Management
- **Resource Limits:** The runner must correctly interpret resource request/limit syntax and translate it into the appropriate backend flags (e.g., `--device` for GPUs).
- **Volume Mapping:** The runner must ensure that `hostPath` volumes defined in the manifest are correctly mounted into the container or available to the native process.

### 5.3 Process Supervision
- **Lifecycle Management:** The runner must manage the lifecycle of the workload, including graceful shutdown (handling `SIGTERM`/`SIGINT`) and automatic cleanup of temporary assets.
- **PID Tracking:** The runner must maintain a reliable record of the workload's process ID to prevent "stray" instances.

## 6. Non-Functional Requirements

### 6.1 Portability
- The runner must be a statically linked or minimally dependent Go binary capable of running on both standard Linux distributions and Termux (Android).

### 6.2 Observability
- **Dry-Run Mode:** A `--dry-run` flag must be provided to print the final constructed command (e.g., the exact `podman` string) without executing it.
- **Structured Logging:** The runner must provide clear, leveled logging (Info, Warn, Error) to assist in debugging orchestration failures.

### 6.3 Error Handling
- The runner must provide actionable error messages. Instead of a generic "command failed," it should report specific issues like "Secret 'X' not found in Infisical" or "Host path '/Y' does not exist."
