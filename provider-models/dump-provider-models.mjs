#!/usr/bin/env node
// dump-provider-models.mjs
//
// Reference extractor: pulls EVERY inference provider's model catalog from the
// installed pi-ai package and writes the combined catalog to a single
// newline-delimited JSON file (NDJSON / JSON Lines) in ./ (i.e.
// provider-models/).
//
// Each line is one model object. Every model already carries a `provider`
// field (pi's own definitions include it), so a single file preserves the
// per-provider grouping without needing one JSON document per provider — this
// replaces the previous per-provider `*-models.json` explosion.
//
// This is the authoritative "latest" source — it reads the very catalog pi
// itself uses (regenerated against `pi update`), with no network calls and no
// API keys. Re-run this script after `pi update` to refresh the snapshot.
//
// Output: pi-models.ndjson
//   - one model object per line (compact, no whitespace)
//   - lines sorted by (provider, id) for stable, per-model git diffs
//   - the trailing newline terminates the final record
import { execSync } from "child_process";
import { readdirSync, mkdirSync, writeFileSync, realpathSync } from "fs";
import { dirname, join, basename } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = here;
mkdirSync(outDir, { recursive: true });

// Resolve the installed pi-ai package via the `pi` binary's real path.
const piBin = realpathSync(execSync("command -v pi").toString().trim());
// piBin = .../pi-coding-agent/<ver>/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
const codingAgentPkg = dirname(dirname(piBin));
const piAi = join(codingAgentPkg, "node_modules", "@earendil-works", "pi-ai");
const modelsDir = join(piAi, "dist", "providers");

const files = readdirSync(modelsDir).filter((f) => f.endsWith(".models.js"));
if (files.length === 0) {
  console.error(`fatal: no <provider>.models.js found under ${modelsDir}`);
  process.exit(1);
}

const allModels = [];
let ok = 0;
let fail = 0;
for (const f of files) {
  const provider = basename(f, ".models.js");
  const url = pathToFileURL(join(modelsDir, f)).href;
  try {
    const mod = await import(url);
    // Find the export that is a map/array of model definitions.
    let models = null;
    for (const val of Object.values(mod)) {
      if (val && typeof val === "object") {
        const list = Array.isArray(val) ? val : Object.values(val);
        const sample = list[0];
        if (sample && typeof sample === "object" && (sample.id || sample.provider)) {
          models = Array.isArray(val) ? val : Object.values(val);
          break;
        }
      }
    }
    if (!models) throw new Error("no model-map export found");
    for (const m of models) {
      // Guarantee a provider tag even if a definition omits it.
      if (!m.provider) m.provider = provider;
      allModels.push(m);
    }
    console.log(`  read ${provider}-models (${models.length} models)`);
    ok++;
  } catch (e) {
    console.warn(`  skip ${provider}: ${e.message}`);
    fail++;
  }
}

// Deterministic ordering by (provider, id) so diffs are per-model rather than
// one giant re-indented blob.
allModels.sort((a, b) => {
  const pa = a.provider || "";
  const pb = b.provider || "";
  if (pa !== pb) return pa < pb ? -1 : 1;
  const ia = a.id || "";
  const ib = b.id || "";
  return ia < ib ? -1 : ia > ib ? 1 : 0;
});

const outFile = join(outDir, "pi-models.ndjson");
const lines = allModels.map((m) => JSON.stringify(m));
writeFileSync(outFile, lines.join("\n") + (lines.length ? "\n" : ""));

console.log(
  `\ndone: ${ok} providers, ${fail} skipped, ${allModels.length} models -> ${outFile}`,
);
