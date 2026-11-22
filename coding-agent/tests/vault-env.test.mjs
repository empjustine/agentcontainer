/**
 * @fileoverview vault-env.test.mjs — the launcher's allowlist is the FOURTH
 * place a provider's key env name has to appear, and the only one nothing else
 * derives from (docs/d032 F6): the fact table, the catalog and the generated
 * artifacts all re-state the name, so a row added there without this list
 * forwards nothing and looks exactly like a vault problem from inside the
 * sandbox.
 *
 * Two gates, both drift alarms rather than behaviour tests:
 *   - every fact-table row's key env, and its `<X>_BASE_URL` sibling, is in
 *     `vaultEnv` (a new provider row cannot land half-wired);
 *   - every `*_API_KEY` in the list carries its derived sibling (the manual
 *     rows, like the pi packages' own keys, keep the Azure pair intact).
 *
 * Run: node --test   (test.sh sweeps every unit's tests/)
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { vaultEnv } from "../run.mjs";
import { baseUrlEnvName, readCloudProviders } from "../lib/cloud-providers.mjs";

const unitRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORWARDED = new Set(vaultEnv);
const ROWS = Object.values(
	readCloudProviders(join(unitRoot, "lib/cloud-providers.json")),
);

test("every fact-table key env clears the vault allowlist", () => {
	const missing = ROWS.map((row) => row.apiKeyEnv).filter(
		(name) => !FORWARDED.has(name),
	);
	assert.deepEqual(missing, [], `not forwarded into the sandbox: ${missing.join(", ")}`);
});

test("every fact-table row forwards its base-url sibling", () => {
	const missing = ROWS.map((row) => baseUrlEnvName(row.apiKeyEnv)).filter(
		(name) => name !== null && !FORWARDED.has(name),
	);
	assert.deepEqual(missing, [], `not forwarded into the sandbox: ${missing.join(", ")}`);
});

test("every forwarded key env carries its derived base-url sibling", () => {
	const missing = vaultEnv
		.map((name) => baseUrlEnvName(name))
		.filter((name) => name !== null && !FORWARDED.has(name));
	assert.deepEqual(missing, [], `key forwarded without its override: ${missing.join(", ")}`);
});
