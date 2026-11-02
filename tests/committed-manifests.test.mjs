/**
 * @fileoverview committed-manifests.test.mjs — the DRIFT GUARD half of docs/d050:
 * every committed generated artifact is in canonical form, so an order-only
 * edit in a review means someone bypassed the write choke point.
 *
 * WHY IT IS AT THE REPO ROOT and not beside the canonicalizer: the subject is
 * the WHOLE unit set (coding-agent's manifests AND estige's Go-generated
 * estige.json), which no single copy unit can assert — the one test this sweep
 * keeps after docs/d104 moved every unit-owned test into its unit. It reads
 * coding-agent/lib/canonical-json.mjs (the node canonicalizer; estige/go
 * implements the same ordering natively, docs/d102) as the reference.
 *
 * Run: ./test.sh   (or node --test tests/*.test.mjs from the repo root)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { serializeArtifact } from "../coding-agent/lib/canonical-json.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- committed-manifest canonicity guard (docs/d050 migration contract) ----
// Order-only edits to these files in a review now mean someone bypassed the
// write choke point — the whole point of d050 is that reruns are byte-stable.
const COMMITTED_MANIFESTS = [
	"coding-agent/model-010-local-default.json",
	"coding-agent/model-012-cloud-pi-native.json",
	"coding-agent/model-015-cloud-cline-pass.json",
	"coding-agent/model-016-cloud-hyper.json",
	"coding-agent/model-017-cloud-inferx.json",
	"coding-agent/model-018-cloud-verboo.json",
	"coding-agent/models.json",
	"coding-agent/opencode.jsonc",
	"estige/estige.json",
];

for (const rel of COMMITTED_MANIFESTS) {
	test(`committed manifest is canonical: ${rel}`, () => {
		const text = readFileSync(join(repoRoot, rel), "utf-8");
		assert.equal(
			serializeArtifact(JSON.parse(text)),
			text,
			`${rel} is not in canonical form — regenerate through writeJsonArtifact (docs/d050)`,
		);
	});
}
