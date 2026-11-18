/**
 * @fileoverview The manifest is a permission contract (docs/d204's Permissions
 * and packaging): the set is exactly what the producer uses, the background is a
 * document rather than a service worker, and every host permission is loopback.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const unit = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(unit, "manifest.json"), "utf8"));

test("manifest v3 with a document background, not a service worker", () => {
	assert.equal(manifest.manifest_version, 3);
	assert.deepEqual(manifest.background.scripts, ["background.mjs"]);
	assert.equal(manifest.background.type, "module");
	assert.equal("service_worker" in manifest.background, false);
});

test("the permission set is exactly the producer's", () => {
	assert.deepEqual(
		[...manifest.permissions].sort((left, right) => (left < right ? -1 : 1)),
		["alarms", "bookmarks", "history", "storage"],
	);
	assert.equal("tabs" in manifest.permissions, false);
	assert.equal("scripting" in manifest.permissions, false);
	assert.equal("webNavigation" in manifest.permissions, false);
	assert.equal("activeTab" in manifest.permissions, false);
	assert.equal("content_scripts" in manifest, false);
});

test("host access is loopback only", () => {
	for (const pattern of manifest.host_permissions) {
		assert.match(pattern, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])\//);
	}
});

test("private windows are excluded and the ESR floor is declared", () => {
	assert.equal(manifest.incognito, "not_allowed");
	assert.match(manifest.browser_specific_settings.gecko.strict_min_version, /^\d+\.\d+$/);
	assert.equal(manifest.options_ui.page, "options.html");
});
