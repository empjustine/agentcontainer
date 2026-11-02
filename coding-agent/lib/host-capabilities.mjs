/**
 * @fileoverview host-capabilities.mjs — the host-capability probes the
 * coding-agent build needs: which container backend this host has, if any.
 *
 * Pruned to that one probe (docs/d113): this folder is a copy unit and carries
 * what its unit calls. The render-device / RAM-floor probes live with the unit
 * that gates local inference on them; the cloud-reachability probe with the
 * proxy that relays to cloud upstreams.
 *
 * Contract: probes are SILENT — callers own the logging. A skipped build is a
 * loud, reasoned log line, never an omission (docs/d041's fail-loudly rule),
 * and a gate may only key on hardware facts, never on artifact presence — the
 * retired stale-image trap (docs/d041, d058).
 */

import { existsSync } from "node:fs";

/**
 * @returns {"podman" | "docker" | null} the host's container backend, or
 *   null when neither binary is installed
 */
export function detectContainerTool() {
	return existsSync("/usr/bin/podman")
		? "podman"
		: existsSync("/usr/bin/docker")
			? "docker"
			: null;
}
