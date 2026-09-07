# Orchestration Prior Art

This document serves as a survey of existing orchestration paradigms. It is intended to inform the design of the `workload-runner` by documenting how different systems handle lifecycle, scheduling, and resource isolation.

---

## 1. Systemd Orchestration

Systemd is the industry standard for managing processes on Linux. It provides a robust, event-driven orchestration layer.

### 1.1 Systemd Units
The fundamental building block of systemd orchestration.
- **`[Service]`**: Manages the lifecycle of a process (start, stop, restart, dependencies).
- **`[Timer]`**: Triggers service execution based on monotonic time (since boot) or wall-clock time (calendar).
- **`[Path]`**: Triggers service execution when a specific file or directory is modified.
- **`[Mount]`**: Manages the mounting of filesystems.

### 1.2 Quadlets (The Declarative Evolution)
Quadlets are a modern, declarative way to generate systemd units. Instead of writing complex `.service` files, users write simple, high-level `.container` or `.volume` files.
- **The Mechanism:** `systemd-generator` reads these files during boot or via `systemctl daemon-reload` and automatically produces the corresponding low-level `.service` and `.mount` units.
- **Relevance:** This is the closest existing parallel to our proposed "Manifest" approach. It moves the complexity of "how to build the unit" into a generator, leaving the user with a clean, intent-based configuration.

### 1.3 systemd-nspawn
A lightweight tool for running containers using Linux namespaces.
- **The Concept:** Unlike Docker/Podman (which are daemon-based and image-centric), `nspawn` is a "machine container" tool. It is often used to boot a minimal OS environment within a namespace.
- **Comparison:** It sits in the middle ground between a raw process (`Service`) and a full container engine.

---

## 2. Podman Orchestration

Podman provides a daemonless, container-centric approach to orchestration.

### 2.1 Volume Management
Podman (and Docker) handles data persistence through two primary models:
- **Bind Mounts (`-v /host/path:/container/path`):** Directly maps a directory from the host into the container. This is highly performable but relies on the host's filesystem structure being predictable.
- **Named Volumes (`podman volume create my-data`):** Manages data in a dedicated area of the host filesystem. This abstracts the host path away from the user but adds a layer of management.
- **K8s Mapping:** In Kubernetes, this is abstracted into `PersistentVolume` (the actual storage) and `PersistentVolumeClaim` (the user's request for storage), which is what the `workload-runner`'s `volumes` spec aims to mirror.

---

## 3. Minimalist & Edge Kubernetes

These distributions focus on reducing the footprint of Kubernetes for resource-constrained or single-node environments.

### 3.1 k3s & k0s
- **k3s:** A highly lightweight, fully compliant Kubernetes distribution designed for IoT and Edge. It is packaged as a single binary and uses a lightweight database (SQLite) by default.
- **k0s:** A zero-friction, zero-dependency Kubernetes distribution. Like k3s, it aims to be easy to install and run on a single node, emphasizing simplicity and minimal overhead.

### 3.2 lilipod
- **Concept:** A very simple, minimal-feature container and image manager.
- **Implementation:** A single statically compiled binary that avoids external dependencies by bundling `busybox`. It provides a subset of the Podman/Docker CLI for downloading and running containers using namespaces.
- **Use Case:** A lightweight fallback for environments where full container engines cannot be installed.

---

## 4. Scheduling Paradigms: Temporal vs. Workload

There is a fundamental distinction in how "when" and "how" a task is run.

### 4.1 Temporal/Event-Based (Systemd)
Focuses on *triggers*.
- **`systemd timer`**: "Run this every Tuesday at 3 AM" or "Run this 5 minutes after boot."
- **`systemd path`**: "Run this whenever `/tmp/config.json` changes."
- **Characteristics:** Highly integrated with the OS kernel/events; very low overhead; excellent for system maintenance.

### 4.2 Workload-Based (Kubernetes)
Focuses on *intent and completion*.
- **`Job`**: "Run this task until it completes successfully." If it crashes, the controller restarts it. (Matches our `Pod` concept).
- **`CronJob`**: "Create a new `Job` object on a schedule." It is a factory for Jobs.
- **`Deployment`**: "Ensure X number of these processes are always running." (Matches our `Deployment` concept).

### Summary Comparison Table

| Feature | Systemd (Timer/Path) | K8s (Job/CronJob) | Target `workload-runner` |
| :--- | :--- | :--- | :--- |
| **Primary Trigger** | Time or File Event | Schedule or Controller | Manifest-defined Intent |
| **Lifecycle** | Run and exit | Run-to-completion (Job) | `Pod` (oneshot) / `Deployment` (resilient) |
| **Complexity** | Low (Unit files) | High (API/etcd/Controller) | Medium (Declarative Manifest) |
| **Scope** | Single Host | Cluster-wide | Single Host / Local Orchestration |
