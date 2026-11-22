/**
 * @fileoverview artifact.test.mjs — the no-pre-flight half of the artifact
 * helper (docs/d228): "absent" comes from the READ's errno and "nothing to
 * keep" from the COPY's, and every other errno propagates instead of being
 * reported as a missing input. Those are the two answers a generator's install
 * step branches on, and a test that only covered the present case would let the
 * helper drift back into an existence test.
 *
 * The publish half of the same helper is covered here too: `copyArtifact` puts a
 * whole file in place with one rename, so a crash cannot leave a committed
 * artifact half-written (docs/d228 R8).
 *
 * Run: ../node-run.sh --test tests/*.test.mjs   (this folder)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  backupArtifact,
  copyArtifact,
  readArtifactOrNull,
  writeArtifact,
} from "../lib/artifact.mjs";

const scratch = mkdtempSync(join(tmpdir(), "artifact-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("readArtifactOrNull answers null for an absent artifact", () => {
  assert.equal(readArtifactOrNull(join(scratch, "never-written.json")), null);
});

test("readArtifactOrNull returns the text of a present artifact", () => {
  const out = join(scratch, "present.json");
  writeArtifact(out, "{}\n");
  assert.equal(readArtifactOrNull(out), "{}\n");
});

test("readArtifactOrNull does not report an unreadable artifact as absent", () => {
  // A directory is the portable stand-in for "there is something here that will
  // not read": EISDIR must reach the caller, or a generator would silently keep
  // the stale copy in place and report a successful install.
  assert.throws(() => readArtifactOrNull(scratch), { code: "EISDIR" });
});

test("backupArtifact keeps a copy beside a present artifact", () => {
  const out = join(scratch, "backup-me.json");
  writeArtifact(out, "old\n");
  const backup = backupArtifact(out);
  assert.ok(backup !== null);
  assert.match(/** @type {string} */ (backup), /backup-me\.json\.bak-\d{14}$/);
  assert.equal(readFileSync(/** @type {string} */ (backup), "utf-8"), "old\n");
});

test("backupArtifact answers null when the artifact is absent", () => {
  // The install path backs up before it replaces, and the first generation has
  // nothing to replace: a throw here would make every fresh install fail.
  assert.equal(backupArtifact(join(scratch, "first-time.json")), null);
});

test("copyArtifact publishes a whole file in one rename", () => {
  const from = join(scratch, "generated.json");
  const to = join(scratch, "committed.json");
  writeArtifact(from, "new\n");
  writeArtifact(to, "old\n");
  assert.equal(copyArtifact(from, to), to);
  assert.equal(readFileSync(to, "utf-8"), "new\n");
  // The staged temp is gone: a leftover would be a second artifact beside the
  // committed one (docs/d228 R11).
  assert.throws(() => readFileSync(`${to}.tmp`), { code: "ENOENT" });
});

test("a copyArtifact whose source will not read leaves the target alone", () => {
  // The copy is the commit; a source that fails mid-way must not shorten the
  // artifact it was about to replace.
  const to = join(scratch, "kept.json");
  writeArtifact(to, "live\n");
  assert.throws(() => copyArtifact(scratch, to), { code: "EISDIR" });
  assert.equal(readFileSync(to, "utf-8"), "live\n");
});
