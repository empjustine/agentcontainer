#!/usr/bin/env node
/**
 * @fileoverview report.mjs — the roofline CLI. Reads the committed facts
 * (model-facts.json, written by extract.mjs on the host that holds the model
 * cache) and prices every scenario the deployment can run:
 *
 *     ./node-run.sh llm-local-bench/roofline/report.mjs
 *     ./node-run.sh llm-local-bench/roofline/report.mjs --format ndjson --out /tmp/roofline.jsonl
 *     ./node-run.sh llm-local-bench/roofline/report.mjs --model gemma-4 --format csv
 *
 * The output is a cartesian, one row per context level x placement x cache arm x
 * speculation arm, with decode and prefill measured separately. The table view
 * collapses it to the best arm per (model, context) because that is what a
 * serving decision asks; --format ndjson/csv emits the whole grid, flat enough
 * for DuckDB's read_json_auto / read_csv_auto (see README.md).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST, humanBytes, scenarios } from "./estimate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIB = 1024 ** 2;

/**
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
	/** @type {Record<string, string | boolean>} */
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (!arg.startsWith("--")) {
			continue;
		}
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			out[key] = true;
		} else {
			out[key] = next;
			i++;
		}
	}
	return out;
}

/**
 * @param {number} value
 * @param {number} [digits]
 * @returns {string}
 */
function fixed(value, digits = 1) {
	return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

/**
 * A duration for a table cell: minutes once seconds stop being readable.
 * @param {number} value
 * @returns {string}
 */
function seconds(value) {
	return value >= 120 ? `${fixed(value / 60, 0)}m` : `${fixed(value, 1)}s`;
}

/**
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function pad(text, width) {
	return text.length >= width
		? text.slice(0, width)
		: text + " ".repeat(width - text.length);
}

/**
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function padStart(text, width) {
	return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/**
 * A model id shortened for a table cell: the org and the suffix are noise.
 * @param {string} id
 * @returns {string}
 */
/**
 * A bus name short enough for a table cell.
 * @param {string} bottleneck
 * @returns {string}
 */
function busLabel(bottleneck) {
	const labels = /** @type {Record<string, string>} */ ({
		vram: "vram",
		dram: "dram",
		pcie: "pcie",
		"gpu-compute": "gpu-c",
		"cpu-compute": "cpu-c",
		dispatch: "disp",
	});
	return labels[bottleneck] ?? bottleneck;
}

/**
 * @param {string} id
 * @returns {string}
 */
function shortId(id) {
	return id.replace(/-GGUF(:|$)/, "$1").replace(/^(unsloth|byteshape)\//, "");
}

/**
 * @param {number} ctx
 * @returns {string}
 */
function shortCtx(ctx) {
	return ctx % 1024 === 0 ? `${ctx / 1024}k` : `${Math.round(ctx / 1024)}k`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function csvCell(value) {
	return `"${String(value).replaceAll('"', '""')}"`;
}

/**
 * The best scenario per (model, context): the serving decision, with the arms
 * that produced it kept in the row so the choice is auditable.
 * @param {import("./estimate.mjs").ScenarioRow[]} rows
 * @returns {import("./estimate.mjs").ScenarioRow[]}
 */
function bestPerContext(rows) {
	/** @type {Map<string, import("./estimate.mjs").ScenarioRow>} */
	const best = new Map();
	for (const row of rows) {
		const k = `${row.model}|${row.ctx}`;
		const current = best.get(k);
		if (!current || row.decode_tps > current.decode_tps) {
			best.set(k, row);
		}
	}
	return [...best.values()];
}

/**
 * @param {import("./estimate.mjs").ScenarioRow[]} rows
 * @returns {string}
 */
function table(rows) {
	const head = [
		pad("model", 30),
		padStart("ctx", 6),
		padStart("place", 5),
		padStart("cache", 5),
		padStart("mtp", 4),
		padStart("bus", 6),
		padStart("turn s", 7),
		padStart("turn t/s", 9),
		padStart("dec t/s", 8),
		padStart("cold", 7),
		padStart("layers", 9),
		padStart("vram", 6),
	].join(" ");
	const lines = [
		HOST.name +
			": " +
			HOST.gpu.name +
			" 16G @ " +
			HOST.gpu.bandwidthGBs +
			" GB/s, " +
			HOST.cpu.name +
			" @ " +
			HOST.cpu.bandwidthGBs +
			" GB/s RAM, " +
			HOST.link.name +
			" @ " +
			HOST.link.bandwidthGBs +
			" GB/s",
		"",
		head,
		"-".repeat(head.length),
	];
	for (const row of bestPerContext(rows)) {
		const layers =
			row.hybrid_layers > 0
				? `${row.gpu_layers}+${row.hybrid_layers}h/${row.layers}`
				: `${row.gpu_layers}/${row.layers}`;
		lines.push(
			[
				pad(shortId(row.model), 30),
				padStart(shortCtx(row.ctx), 6),
				padStart(row.placement === "expert-offload" ? "moe" : "fit", 5),
				padStart(
					row.cache_mib > 0 ? `${Math.round(row.cache_mib / 1024)}G` : "-",
					5,
				),
				padStart(row.mtp ? (row.drafter_resident ? "on" : "on*") : "-", 4),
				padStart(busLabel(row.decode_bottleneck), 6),
				padStart(fixed(row.turn_s, 1), 7),
				padStart(fixed(row.turn_tps, 0), 9),
				padStart(fixed(row.decode_tps), 8),
				padStart(seconds(row.cold_ttft_s), 7),
				padStart(layers, 9),
				padStart(humanBytes(row.vram_mib * MIB), 6),
			].join(" "),
		);
	}
	lines.push(
		"",
		"place    fit = llama.cpp --fit on; moe = --n-cpu-moe N with the attention resident",
		"cache    the --moe-cache-mib arm the row won with (see cache_break_even in the grid)",
		"mtp      on = the drafter fit; on* = it spilled to DDR4 and the gain includes that",
		"bus      what owns the decode second: the card (vram), host DRAM, the PCIe",
		"         link, or compute (gpu-c / cpu-c); the prompt side is in the grid",
		"turn     one agentic turn: the prompt grew by --growth tokens (the server reuses",
		"         the prefix), then --gen tokens came back; turn t/s is that turn rate",
		"dec t/s  a token at that context, worst case (the whole KV read per token)",
		"cold     first-token seconds when the prefix is cold: paid once, not per turn",
	);
	return lines.join("\n");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(
			"usage: report.mjs [--model substr] [--format table|ndjson|csv] [--out path]",
		);
		console.log(
			"                  [--cache MiB] [--cpu-share f] [--locality f]",
		);
		console.log(
			"                  [--alpha f] [--depth n] [--growth n] [--gen n]",
		);
		console.log("                  [--contexts 32768,65536,...]");
		return;
	}
	const facts = JSON.parse(
		readFileSync(join(HERE, "model-facts.json"), "utf8"),
	);
	/** @type {import("./estimate.mjs").PlanOptions} */
	const options = {};
	if (args.cache) {
		options.cacheMiB = Number(args.cache);
	}
	if (args["cpu-share"]) {
		options.cpuShare = Number(args["cpu-share"]);
	}
	if (args.locality) {
		options.locality = Number(args.locality);
	}
	if (args.alpha) {
		options.mtpAcceptance = Number(args.alpha);
	}
	if (args.depth) {
		options.mtpDepth = Number(args.depth);
	}
	if (args.growth) {
		options.growthTokens = Number(args.growth);
	}
	if (args.gen) {
		options.genTokens = Number(args.gen);
	}
	if (args.contexts) {
		options.contexts = String(args.contexts)
			.split(",")
			.map((value) => Number(value.trim()))
			.filter((value) => Number.isFinite(value) && value > 0);
	}
	const selected = args.model
		? facts.models.filter((/** @type {any} */ m) =>
				String(m.id).toLowerCase().includes(String(args.model).toLowerCase()),
			)
		: facts.models;
	/** @type {import("./estimate.mjs").ScenarioRow[]} */
	const rows = selected.flatMap((/** @type {any} */ model) =>
		scenarios(model, options),
	);

	const format = String(args.format ?? "table");
	let output;
	if (format === "ndjson") {
		output = rows.map((row) => JSON.stringify(row)).join("\n");
	} else if (format === "csv") {
		const columns = Object.keys(rows[0] ?? {});
		output = [
			columns.map(csvCell).join(","),
			...rows.map((row) =>
				columns
					.map((column) =>
						csvCell(
							String(row[/** @type {keyof typeof row} */ (column)] ?? ""),
						),
					)
					.join(","),
			),
		].join("\n");
	} else {
		output = table(rows);
	}

	if (args.out) {
		writeFileSync(String(args.out), `${output}\n`);
		console.log(`wrote ${String(args.out)}: ${rows.length} scenarios`);
	} else {
		console.log(output);
	}
}

main();
