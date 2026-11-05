/**
 * @fileoverview committed-manifests.test.mjs — the DRIFT GUARD half of docs/d050:
 * every committed generated artifact in THIS folder is in canonical form, so an
 * order-only edit in a review means someone bypassed the write choke point.
 *
 * WHY IT LIVES HERE: its subject is this folder's manifests, and the
 * canonicalizer it checks them with is this folder's own
 * `lib/canonical-json.mjs` — so it travels with them like every other unit test
 * (docs/d113). It used to sit at the repo root because it also covered
 * `estige/estige.json`; docs/d108 deleted that artifact with the allowlist
 * generator, which left this guard with a single unit and therefore a single
 * home. The Go side keeps the same ordering natively and is not checkable from
 * node (docs/d102).
 *
 * Run: ../node-run.sh --test tests/*.test.mjs   (this folder)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { serializeArtifact } from "../lib/canonical-json.mjs";

const unitRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- committed-manifest canonicity guard (docs/d050 migration contract) ----
// Order-only edits to these files in a review now mean someone bypassed the
// write choke point — the whole point of d050 is that reruns are byte-stable.
const COMMITTED_MANIFESTS = [
	"model-010-local-default.json",
	"model-012-cloud-pi-native.json",
	"model-015-cloud-cline-pass.json",
	"model-016-cloud-hyper.json",
	"model-017-cloud-inferx.json",
	"model-018-cloud-verboo.json",
	"models.json",
	"opencode.jsonc",
];

for (const rel of COMMITTED_MANIFESTS) {
	test(`committed manifest is canonical: ${rel}`, () => {
		const text = readFileSync(join(unitRoot, rel), "utf-8");
		assert.equal(
			serializeArtifact(JSON.parse(text)),
			text,
			`${rel} is not in canonical form — regenerate through writeJsonArtifact (docs/d050)`,
		);
	});
}
