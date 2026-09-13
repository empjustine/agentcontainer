/**
 * @fileoverview gen-lib.mjs — the shared preamble for the coding-agent
 * pi-layer generators: resolves `scriptDir` / `LIB_DIR`, re-exports the lib/
 * helpers they use, and owns the models.dev catalog lookup order. The serving
 * layers' equivalent is ../llm-local-inference/gen-lib.mjs; the LIB_DIR
 * staging convention (and why a scratch copy exists at all) is docs/d023.
 *
 * This module is staged next to the generators and a copy of lib/ (see
 * generate.sh), and mounted into the container by run.sh — both lists must
 * carry it. Every lib import resolves through $LIB_DIR, so the same file works
 * in place and in the scratch dir.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const scriptDir = dirname(fileURLToPath(import.meta.url));
export const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");

const logging = /** @type {typeof import("../lib/log.mjs")} */ (
	await import(`${LIB_DIR}/log.mjs`)
);
const artifact = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);
const probe = /** @type {typeof import("../lib/peer-probe.mjs")} */ (
	await import(`${LIB_DIR}/peer-probe.mjs`)
);
const piModels = /** @type {typeof import("../lib/pi-models.mjs")} */ (
	await import(`${LIB_DIR}/pi-models.mjs`)
);
const cloudProviders = /** @type {typeof import("../lib/cloud-providers.mjs")} */ (
	await import(`${LIB_DIR}/cloud-providers.mjs`)
);
const hyperFacts = /** @type {typeof import("../lib/hyper-facts.mjs")} */ (
	await import(`${LIB_DIR}/hyper-facts.mjs`)
);
const catwalkFacts = /** @type {typeof import("../lib/catwalk-facts.mjs")} */ (
	await import(`${LIB_DIR}/catwalk-facts.mjs`)
);

export const { logError, logInfo, logWarn, setLogTool } = logging;
export const { writeArtifact } = artifact;
export const {
	bearerHeaders,
	fetchModelEntries,
	peerBaseUrl,
	peerBaseUrls,
	peerProviderUrl,
	probeCandidates,
	probeDirect,
	probePeerRoutes,
} = probe;
export const { piModel, providerEntry, providerReroute } = piModels;
export const { CLOUD_PROVIDERS, PI_NATIVE_CLOUD_IDS } = cloudProviders;
export const { loadHyperFacts, refreshHyperFacts } = hyperFacts;
export const {
	loadCatwalkFacts,
	getCatwalkModels,
	refreshCatwalkFacts,
	PROVIDER_MAP: CATWALK_PROVIDER_MAP,
} = catwalkFacts;

/**
 * The models.dev catalog to read: a `models.dev.api.json` next to this script
 * wins (when staged, that entry is a symlink the best-effort refresh replaces
 * with the freshly fetched copy), else the shared vendored copy under
 * `LIB_DIR`. `MODELS_DEV_JSON` overrides both.
 * @returns {string}
 */
export function modelsDevCatalogPath() {
	return (
		process.env.MODELS_DEV_JSON ??
		(existsSync(join(scriptDir, "models.dev.api.json"))
			? join(scriptDir, "models.dev.api.json")
			: join(LIB_DIR, "models.dev.api.json"))
	);
}
