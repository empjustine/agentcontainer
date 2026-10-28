/**
 * @fileoverview host-capabilities.mjs — the ONE host-capability probe set for
 * the build/generate side: what THIS host can build or serve. build.mjs gates
 * target REGISTRATION on these probes (llama-swap pull needs an inference
 * ENDPOINT — render devices plus the RAM floor, docs/d087 — and
 * llm-reverse-proxy image needs outbound cloud networking, and
 * llm-local-inference/generate.mjs gates its serving layer on the same
 * inference probes — one definition per capability, so "can this host serve
 * local inference" cannot drift between builder and generator (docs/d041).
 *
 * lib/workload-runtime.sh keeps its own shell copies (detect_workload_tool,
 * detect_gpu_devs): the runtime sandbox API cannot import a module, and it is
 * the runtime-side original these probes port. Keep the two in sync.
 *
 * Contract: probes are SILENT — callers own the logging. A skipped target is
 * a loud, reasoned log line, never an omission (docs/d041's fail-loudly
 * rule), and a gate may only key on hardware/network facts, never on artifact
 * presence — the retired stale-image trap (docs/d041, d058).
 */

import { existsSync, readdirSync } from "node:fs";
import { totalmem } from "node:os";

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
 * The dedicated inference render devices llama.cpp runs against (the
 * unified-vulkan image; ported from workload-runtime.sh's detect_gpu_devs).
 * A present-but-broken driver is deliberately NOT probed — that is a
 * run-time failure for the serving container to surface, not something a
 * device-node check can honestly certify.
 * @returns {string[]} absolute device paths (empty when the host has none)
 */
export function detectGpuDevices() {
	return [
		existsSync("/dev/kfd") ? "/dev/kfd" : null,
		...(existsSync("/dev/dri")
			? readdirSync("/dev/dri")
					.filter((f) => f.startsWith("renderD"))
					.map((f) => `/dev/dri/${f}`)
			: []),
	].filter((d) => d !== null);
}

/**
 * The cloud probe's canary — public, keyless, tiny, and already a repo-fact
 * host (the llm-reverse-proxy allowlist carries models.dev), so the probe
 * never depends on an endpoint nothing else here needs.
 *
 * Dispatch rides node_run's NODE_USE_ENV_PROXY=1 (docs/d074), so the
 * probe answers the question the gates actually have: can THIS host,
 * through whatever proxy env is configured, reach the models.dev host
 * in the allowlist. It certifies nothing at run time.
 *
 * Only build.mjs consumes it; no generator reads it.
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

/**
 * Total installed RAM — the hardware fact behind the inference-endpoint gate
 * (docs/d087): llama.cpp serving holds model weights plus KV cache in
 * memory, so a host below the floor cannot serve regardless of what
 * accelerators it has. os.totalmem() reports the machine's RAM (not a
 * cgroup limit) — correct for the builder, which asks "is THIS host an
 * inference endpoint", and build-time is before any container limits apply.
 * @returns {number} total installed RAM in GiB
 */
export function totalMemGiB() {
	return totalmem() / 1024 ** 3;
}

/**
 * RAM floor of an inference endpoint (docs/d087) — not a probe but the one
 * policy threshold the endpoint definition needs, kept beside the probes so
 * builder and generator import the SAME number and cannot drift apart. 16
 * GiB covers the small local GGUFs the default config serves with headroom
 * for the OS; a host below it skips the llama-swap pull loudly instead of
 * burning multi-GB of disk on an image that cannot serve.
 * @type {number}
 */
export const INFERENCE_MIN_RAM_GIB = 16;
