/**
 * @fileoverview host-capabilities.mjs — the host-capability probes estige's
 * build needs: can THIS host reach the cloud at all (the proxy exists to
 * relay to cloud upstreams, so building its image against a closed network is
 * work the host cannot use).
 *
 * Pruned to the two probes this unit's build gates on (docs/d104): the
 * container-backend probe (which target is even buildable here) and outbound
 * cloud reachability (whether the image is work this host can use). A copy is
 * a copy unit's own code — the render-device and RAM-floor probes stayed with
 * the folder that gates on them.
 *
 * Contract: probes are SILENT — callers own the logging. A skipped target is
 * a loud, reasoned log line, never an omission (docs/d041's fail-loudly rule),
 * and a gate may only key on hardware/network facts, never on artifact
 * presence — the retired stale-image trap (docs/d041, d058).
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


/**
 * The cloud probe's canary — public, keyless, tiny, and already a repo-fact
 * host (the estige allowlist carries models.dev), so the probe
 * never depends on an endpoint nothing else here needs.
 *
 * Dispatch rides node_run's NODE_USE_ENV_PROXY=1 (docs/d074), so the
 * probe answers the question the gates actually have: can THIS host,
 * through whatever proxy env is configured, reach the models.dev host
 * in the allowlist. It certifies nothing at run time.
 * @type {string}
 */
export const CLOUD_PROBE_CANARY = "https://models.dev/api.json";

/**
 * Short on purpose: the probe runs on the build's startup path, so a closed
 * network should cost a logged skip, not a stall.
 * @type {number}
 */
const CLOUD_PROBE_TIMEOUT_MS = 5000;

/**
 * Naive outbound-cloud probe — the same rule as coding-agent/route-probe.mjs's
 * canonical reachability classification, in its simplest form: ANY HTTP
 * answer (401/403/404/5xx included — the status line is the server talking,
 * which is all this asks) proves the outbound path exists; ONLY the absence
 * of any response (DNS failure, refused connection, TLS failure, timeout)
 * means closed. TLS verification stays ON — a bogus certificate dies in the
 * handshake, before any status could count as an answer (fail-closed,
 * docs/d033).
 *
 * A point-in-time measurement: build.mjs uses it to decide whether building
 * the proxy image is work THIS host can use (against a closed network its
 * base-image --pull would fail anyway — the gate turns that hard failure
 * into a logged skip). It certifies nothing at run time.
 * @returns {Promise<boolean>} true when any HTTP response came back
 */
export async function cloudReachable() {
	try {
		await fetch(CLOUD_PROBE_CANARY, {
			method: "HEAD",
			signal: AbortSignal.timeout(CLOUD_PROBE_TIMEOUT_MS),
		});
		return true;
	} catch {
		return false;
	}
}
