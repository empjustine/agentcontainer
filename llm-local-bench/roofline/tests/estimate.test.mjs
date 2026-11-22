/**
 * @fileoverview The estimator's physics, pinned. These are not snapshot tests:
 * each one asserts a property the roofline must have (scale linearly with bytes,
 * honour the sliding window, lose to the bus when it should, make a long prompt
 * quadratically expensive, price a turn by its delta), so a calibration change
 * that breaks the frame fails here instead of in a report nobody re-reads.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	CONTEXTS,
	HOST,
	humanBytes,
	moeCacheEffect,
	scenarios,
} from "../estimate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIB = 1024 ** 2;
const GPU_BW = HOST.gpu.bandwidthGBs * 1e9 * HOST.gpu.bwUtilization;
const CPU_BW = HOST.cpu.bandwidthGBs * 1e9 * HOST.cpu.bwUtilization;

/**
 * @typedef {object} SyntheticOverrides
 * @property {number} [layers]
 * @property {number} [layerMiB] dense bytes per layer
 * @property {number} [expertMiB] routed-expert bytes per layer
 * @property {number} [experts]
 * @property {number} [expertsUsed]
 * @property {number} [kvElems]
 * @property {number} [ctx] the context the row serves
 * @property {number | null} [slidingWindow]
 * @property {(i: number) => number} [ctxCapAt]
 * @property {boolean} [speculative]
 * @property {{bytes: number, kvK: number[], kvV: number[], ctxWindows: number[]}} [draft]
 * @property {{layer: number}[]} [passes]
 */

/**
 * A synthetic row: no GGUF behind it, one pass per layer unless told otherwise.
 * @param {SyntheticOverrides} [overrides]
 * @returns {import("../estimate.mjs").ModelFacts}
 */
function syntheticModel(overrides = {}) {
	const layers = overrides.layers ?? 20;
	const layerMiB = overrides.layerMiB ?? 200;
	const expertMiB = overrides.expertMiB ?? 0;
	const kvElems = overrides.kvElems ?? 256;
	const ctx = overrides.ctx ?? 262_144;
	return {
		id: "synthetic/row",
		repo: "synthetic/row",
		quant: null,
		arch: "llama",
		fileBytes: 0,
		layers,
		embd: 4096,
		experts: overrides.experts ?? 0,
		expertsUsed: overrides.expertsUsed ?? 0,
		nextnPredictLayers: 0,
		ctxNative: ctx,
		servedContext: ctx,
		cacheTypeV: "f16",
		slidingWindow: overrides.slidingWindow ?? null,
		trunkBytes: 0,
		inputEmbeddingBytes: 0,
		outputBytes: 0,
		outputElems: 0,
		layerBytes: Array.from(
			{ length: layers },
			() => layerMiB * MIB + expertMiB * MIB,
		),
		layerExpertBytes: Array.from({ length: layers }, () => expertMiB * MIB),
		layerElems: Array.from({ length: layers }, () => layerMiB * 5e5),
		layerExpertElems: Array.from({ length: layers }, () => expertMiB * 5e5),
		layerKvElemsK: Array.from({ length: layers }, () => kvElems),
		layerKvElemsV: Array.from({ length: layers }, () => kvElems),
		layerCtxCap: Array.from(
			{ length: layers },
			(_v, i) => overrides.ctxCapAt?.(i) ?? 0,
		),
		speculative: overrides.speculative ?? false,
		draft: overrides.draft ?? null,
		...(overrides.passes ? { passes: overrides.passes } : {}),
	};
}

/**
 * The first scenario of a set, asserted present (noUncheckedIndexedAccess).
 * @param {import("../estimate.mjs").ScenarioRow[]} rows
 * @returns {import("../estimate.mjs").ScenarioRow}
 */
function first(rows) {
	const [row] = rows;
	assert.ok(row, "no scenario produced");
	return row;
}

/**
 * @param {import("../estimate.mjs").ScenarioRow[]} rows
 * @param {(row: import("../estimate.mjs").ScenarioRow) => boolean} want
 * @returns {import("../estimate.mjs").ScenarioRow}
 */
function one(rows, want) {
	const found = rows.find(want);
	assert.ok(found, "no row matched");
	return found;
}

test("a fully resident row decodes at exactly its weights-plus-KV rate", () => {
	const model = syntheticModel({
		layers: 4,
		layerMiB: 100,
		kvElems: 0,
		ctx: 32_768,
	});
	const row = first(scenarios(model, { contexts: [32_768] }));
	assert.equal(row.gpu_layers, 4);
	const expected = GPU_BW / (4 * 100 * MIB);
	assert.ok(
		Math.abs(row.decode_tps - expected) / expected < 0.01,
		String(row.decode_tps),
	);
});

test("decode time scales with the bytes a token reads", () => {
	const small = first(
		scenarios(
			syntheticModel({ layers: 4, layerMiB: 100, kvElems: 0, ctx: 32_768 }),
			{ contexts: [32_768] },
		),
	);
	const double = first(
		scenarios(
			syntheticModel({ layers: 4, layerMiB: 200, kvElems: 0, ctx: 32_768 }),
			{ contexts: [32_768] },
		),
	);
	assert.ok(Math.abs(small.decode_tps / double.decode_tps - 2) < 0.02);
});

test("a sliding window caps the KV cells its layer allocates", () => {
	const ctx = 262_144;
	const windowed = first(
		scenarios(syntheticModel({ ctx, kvElems: 1024, ctxCapAt: () => 1024 }), {
			contexts: [ctx],
		}),
	);
	const global = first(
		scenarios(syntheticModel({ ctx, kvElems: 1024 }), { contexts: [ctx] }),
	);
	// 1024-window + ubatch 512, padded to 256 cells -> 1536, not the full context;
	// K and V are both f16 here, so a token's row is 1024 x 2 x 2 bytes.
	assert.ok(
		Math.abs(windowed.kv_mib - (20 * 1536 * 4096) / MIB) < 1,
		String(windowed.kv_mib),
	);
	assert.ok(global.kv_mib / windowed.kv_mib > 100);
});

test("layers stop fitting once VRAM is gone, and every extra byte of KV pushes one out", () => {
	const roomy = first(
		scenarios(syntheticModel({ layers: 20, layerMiB: 100, kvElems: 0 }), {
			contexts: [32_768],
		}),
	);
	assert.equal(roomy.gpu_layers, 20);
	const tight = first(
		scenarios(syntheticModel({ layers: 20, layerMiB: 900, kvElems: 0 }), {
			contexts: [32_768],
		}),
	);
	assert.ok(tight.gpu_layers > 0 && tight.gpu_layers < 20);
	assert.ok(tight.decode_tps < roomy.decode_tps);
});

test("a host-memory split is bounded by DDR4, not by the card", () => {
	const model = syntheticModel({ layers: 20, layerMiB: 900, kvElems: 0 });
	const row = first(scenarios(model, { contexts: [32_768] }));
	const cpuBytes = model.layerBytes
		.slice(0, 20 - row.gpu_layers)
		.reduce((a, b) => a + b, 0);
	assert.ok(
		row.decode_ms / 1000 > 0.9 * (cpuBytes / CPU_BW),
		String(row.decode_ms),
	);
});

test("the MoE cache needs the hit rate the bus arithmetic implies", () => {
	const r = {
		gpuBw: GPU_BW,
		gpuFlops: 0,
		cpuBw: CPU_BW,
		cpuFlops: 0,
		linkBw: HOST.link.bandwidthGBs * 1e9,
	};
	const cpuExpertBytes = 1e9;
	const effect = moeCacheEffect({
		cpuExpertBytes,
		poolBytes: 4096 * MIB,
		staticExpertSec: cpuExpertBytes / CPU_BW,
		r,
		cacheMiB: 1024,
		cpuShare: 0,
		locality: 2,
	});
	// An upload costs 1/3.9 GB/s against a host read's 1/32.6 GB/s, so only a
	// near-total hit rate can pay for it — the measured verdict on this host.
	assert.ok(effect.breakEvenHit > 0.8 && effect.breakEvenHit < 0.95);
	// A quarter of the pool cached, skew 2: sqrt(0.25) of the token's experts hit.
	assert.ok(Math.abs(effect.hitRate - 0.5) < 1e-9);
	assert.ok(effect.factor > 1, "a sub-break-even cache must price a slowdown");
});

test("a looped model pays every pass, a resident one only every layer", () => {
	const base = syntheticModel({ layers: 8, layerMiB: 100, kvElems: 0 });
	const looped = syntheticModel({
		layers: 8,
		layerMiB: 100,
		kvElems: 0,
		passes: Array.from({ length: 16 }, (_v, i) => ({ layer: i % 8 })),
	});
	const once = first(scenarios(base, { contexts: [32_768] }));
	const twice = first(scenarios(looped, { contexts: [32_768] }));
	assert.ok(
		Math.abs(once.decode_tps / twice.decode_tps - 2) < 0.02,
		"two passes cost two reads",
	);
	assert.equal(twice.weights_mib, once.weights_mib);
});

test("MTP pays when its drafter is resident and loses when it spills", () => {
	const draft = { bytes: 100 * MIB, kvK: [256], kvV: [256], ctxWindows: [0] };
	const fast = scenarios(
		syntheticModel({
			layers: 4,
			layerMiB: 100,
			kvElems: 0,
			speculative: true,
			draft,
		}),
		{ contexts: [32_768] },
	);
	const resident = one(fast, (row) => row.mtp);
	assert.equal(resident.drafter_resident, true);
	assert.ok(resident.mtp_gain > 1.3, String(resident.mtp_gain));

	const spilled = scenarios(
		syntheticModel({
			layers: 4,
			layerMiB: 3900,
			kvElems: 0,
			speculative: true,
			draft: { ...draft, bytes: 40 * 1024 * MIB },
		}),
		{ contexts: [32_768] },
	);
	const lost = one(spilled, (row) => row.mtp);
	assert.equal(lost.drafter_resident, false);
	assert.ok(lost.mtp_gain < 0.5, String(lost.mtp_gain));
});

test("the scenario grid is the cartesian it claims to be", () => {
	// 100 MiB of dense + 3 GiB of experts per layer: the trunk fits, so both
	// placements exist and both leave experts in host memory.
	const model = syntheticModel({
		layers: 8,
		layerMiB: 100,
		expertMiB: 3000,
		experts: 64,
		expertsUsed: 4,
		ctx: 65_536,
		speculative: true,
		draft: { bytes: 100 * MIB, kvK: [256], kvV: [256], ctxWindows: [0] },
	});
	const rows = scenarios(model, { contexts: [32_768, 65_536], cacheMiB: 2048 });
	assert.deepEqual([...new Set(rows.map((row) => row.ctx))], [32_768, 65_536]);
	assert.deepEqual([...new Set(rows.map((row) => row.placement))].sort(), [
		"expert-offload",
		"layer-pipelining",
	]);
	assert.deepEqual(
		[...new Set(rows.map((row) => row.cache_mib))].sort((a, b) => a - b),
		[0, 2048],
	);
	assert.deepEqual([...new Set(rows.map((row) => row.mtp))], [false, true]);
	assert.equal(rows.length, 2 * 2 * 2 * 2);
	for (const row of rows) {
		assert.ok(row.cold_ttft_s > 0 && row.turn_s > 0, row.model);
	}
});

test("a context level beyond the row's own context is never priced", () => {
	const rows = scenarios(syntheticModel({ ctx: 65_536 }), {});
	assert.deepEqual(
		[...new Set(rows.map((row) => row.ctx))],
		CONTEXTS.filter((ctx) => ctx <= 65_536),
	);
});

test("a long prompt costs more than its token count in prefill", () => {
	// Global attention, negligible weights: the quadratic term is the whole cost.
	const model = syntheticModel({
		layers: 8,
		layerMiB: 1,
		kvElems: 1024,
		ctx: 131_072,
	});
	const rows = scenarios(model, { contexts: [65_536, 131_072] });
	const short = one(rows, (row) => row.ctx === 65_536);
	const long = one(rows, (row) => row.ctx === 131_072);
	assert.ok(
		long.cold_ttft_s > 3 * short.cold_ttft_s,
		`${short.cold_ttft_s} -> ${long.cold_ttft_s}`,
	);
	assert.ok(long.cold_prefill_tps < short.cold_prefill_tps);
});

test("a turn costs its delta, not the whole context", () => {
	// 12 layers of 400 MiB at 100k: the cold prompt is minutes, the 1024 new
	// tokens of the next turn are seconds, and a turn's rate beats decode alone.
	const model = syntheticModel({
		layers: 12,
		layerMiB: 400,
		kvElems: 512,
		ctx: 102_400,
	});
	const row = first(scenarios(model, { contexts: [102_400] }));
	assert.ok(
		row.cold_ttft_s > 5 * row.turn_s,
		`${row.cold_ttft_s} vs ${row.turn_s}`,
	);
	assert.ok(
		row.turn_tps > row.decode_tps,
		`${row.turn_tps} vs ${row.decode_tps}`,
	);
	assert.equal(row.growth_tokens, 1024);
	assert.equal(row.gen_tokens, 512);
	// A turn is the generated tokens at the decode rate plus the delta's prefill:
	// never less than generating, never the whole context again.
	const genOnly = row.gen_tokens / row.decode_tps;
	assert.ok(row.turn_s > genOnly, `${row.turn_s} vs ${genOnly}`);
	assert.ok(row.turn_s < genOnly * 1.5, `${row.turn_s} vs ${genOnly}`);
});

test("the committed facts carry what the estimator reads", () => {
	const facts = JSON.parse(
		readFileSync(join(HERE, "..", "model-facts.json"), "utf8"),
	);
	assert.ok(facts.models.length > 0);
	for (const model of /** @type {import("../estimate.mjs").ModelFacts[]} */ (
		facts.models
	)) {
		assert.equal(model.layerBytes.length, model.layers, model.id);
		assert.equal(model.layerExpertBytes.length, model.layers, model.id);
		assert.equal(model.layerKvElemsK.length, model.layers, model.id);
		assert.ok(model.servedContext > 0, model.id);
		const total =
			model.inputEmbeddingBytes +
			model.outputBytes +
			model.layerBytes.reduce((a, b) => a + b, 0);
		assert.ok(
			Math.abs(total - model.fileBytes) / model.fileBytes < 0.001,
			model.id,
		);
	}
});

test("humanBytes keeps the units it prints", () => {
	assert.equal(humanBytes(3 * MIB), "3M");
	assert.equal(humanBytes(2 * 1024 ** 3), "2.0G");
});

test("the bottleneck names a bus, not 'bandwidth'", () => {
	const resident = first(
		scenarios(syntheticModel({ layers: 8, layerMiB: 200, kvElems: 0 }), {
			contexts: [32_768],
		}),
	);
	assert.equal(resident.decode_bottleneck, "vram");
	assert.ok(
		resident.decode_vram_share > 0.9,
		String(resident.decode_vram_share),
	);

	const spilled = first(
		scenarios(syntheticModel({ layers: 20, layerMiB: 900, kvElems: 0 }), {
			contexts: [32_768],
		}),
	);
	assert.equal(spilled.decode_bottleneck, "dram");
	assert.ok(spilled.decode_dram_share > 0.5, String(spilled.decode_dram_share));

	// The prompt side is a different answer: a long prompt of a tiny model is
	// compute-bound, which no "bandwidth" label could have said.
	const long = first(
		scenarios(
			syntheticModel({ layers: 8, layerMiB: 1, kvElems: 1024, ctx: 131_072 }),
			{ contexts: [131_072] },
		),
	);
	assert.equal(long.prefill_bottleneck, "gpu-compute");
	assert.ok(
		long.prefill_compute_share > 0.9,
		String(long.prefill_compute_share),
	);
});

test("the expert cache trades DRAM time for the link and the card", () => {
	const model = syntheticModel({
		layers: 8,
		layerMiB: 100,
		expertMiB: 3000,
		experts: 64,
		expertsUsed: 4,
		ctx: 32_768,
	});
	const rows = scenarios(model, { contexts: [32_768], cacheMiB: 2048 });
	const off = one(
		rows,
		(row) => row.placement === "layer-pipelining" && row.cache_mib === 0,
	);
	const on = one(
		rows,
		(row) => row.placement === "layer-pipelining" && row.cache_mib > 0,
	);
	assert.ok(
		on.decode_pcie_share > off.decode_pcie_share,
		`${off.decode_pcie_share} -> ${on.decode_pcie_share}`,
	);
	assert.ok(on.decode_dram_share < off.decode_dram_share);
});

test("MTP re-prices the round it optimizes", () => {
	// Target fully resident, drafter spilled: the round it prices is DRAM-bound
	// even though the target's own token never left the card.
	const model = syntheticModel({
		layers: 4,
		layerMiB: 100,
		kvElems: 0,
		speculative: true,
		draft: { bytes: 40 * 1024 * MIB, kvK: [256], kvV: [256], ctxWindows: [0] },
	});
	const rows = scenarios(model, { contexts: [32_768] });
	const off = one(rows, (row) => !row.mtp);
	const on = one(rows, (row) => row.mtp);
	assert.equal(off.decode_bottleneck, "vram");
	assert.equal(on.decode_bottleneck, "dram");
	assert.ok(on.mtp_gain < 1);
});
