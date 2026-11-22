/**
 * @fileoverview estimate.mjs — the roofline estimator: what tlalocayotl can
 * expect from each served GGUF, as a decode-and-prefill latency budget rather
 * than a benchmark.
 *
 * The unit of an answer is a SCENARIO, not a model: the cartesian of
 *   - context length (CONTEXTS; a row is only priced up to the context it serves),
 *   - placement (llama.cpp's --fit on, or --n-cpu-moe with the attention resident),
 *   - the MoE expert cache (off, or a given --moe-cache-mib size),
 *   - speculation (no MTP, or the row's drafter),
 * each measured as decode (a token at that context) and prefill (the prompt that
 * reaches it), then combined into the TURN an agentic loop actually runs: the
 * prompt grew by --growth tokens (the server keeps the prefix, so only the delta
 * is prefilled) and --gen tokens came back. Nobody waits for the screen, so the
 * turn's wall clock is the headline, while the cold prefill of the whole context
 * is the price of starting a new task or branch.
 *
 * The model is deliberately the memory roofline, not a kernel simulator: at
 * batch 1 each pass reads its own weights once, so decode time is
 * max(FLOPs/rate, bytes/bandwidth) per device and the sum over passes is one
 * token. Prefill reads the same bytes once for the whole prompt, so its time is
 * max(tokens x FLOPs / prefill rate, bytes/bandwidth) — quadratic in the context
 * through attention, which is why the two answer different questions.
 *
 * Constants are the reference estimators' calibrations, not this file's taste:
 * ai-leaderboard's HW Roofline supplies bandwidth 0.85 / compute 0.50 / prefill
 * MFU 0.15, the flash-attention prefill boost and FLOPS_PER_PARAM = 2;
 * huggingface-estimate supplies the KV sizing and the --fit placement algorithm
 * (see README.md).
 */
const MIB = 1024 ** 2;

/**
 * The context levels an estimate is made at, for agentic use: nothing below 32k
 * is useful for a tool-calling session, ~100k is the working range, and the
 * level is where the KV read and the attention FLOPs both bite. A row is priced
 * at every level it can serve and at no level beyond its own context.
 * @type {readonly number[]}
 */
export const CONTEXTS = [32_768, 65_536, 102_400, 131_072, 262_144];

/** KV element widths llama.cpp can store, in bytes (ggml block sizes).
 * @type {Record<string, number>} */
const KV_BYTES = {
	f16: 2,
	bf16: 2,
	q8_0: 34 / 32,
	q5_1: 24 / 32,
	q4_0: 18 / 32,
};

/** llama.cpp's own arithmetic: 2 FLOPs per parameter, 2-byte activations. */
const FLOPS_PER_PARAM = 2;
const ACTIVATION_BYTES = 2;
/** A GPU<->CPU round trip per split layer; a whole-stack spill pays one. */
const HOPS_PER_SPLIT_LAYER = 2;
/**
 * llama.cpp's default ubatch and the 256-cell alignment of the SWA ring buffer
 * (llama-kv-cache-iswa.cpp). A sliding-window layer of a 262144-token row holds
 * 1024+512 cells, not 262144 — the term that decides whether the KV fits.
 */
const N_UBATCH = 512;
const KV_CELL_PAD = 256;
/** Router + dispatch cost per expert per token, from the reference estimator. */
const MOE_DISPATCH_SEC_PER_EXPERT = 5e-9;
/** Extra cost of a verify pass's k-th speculative token (attention, not weights). */
const VERIFY_TOKEN_COST = 0.05;
/**
 * Prefill's model-FLOPs utilization, kept apart from decode's compute
 * utilization: a 2048-token GEMM reaches a different fraction of peak than a
 * batch-1 GEMV (the reference uses 0.15 and a flash-attention boost on top).
 */
const PREFILL_MFU = 0.15;
/** The expert cache's default arm, in MiB, when the caller names no size. */
const DEFAULT_CACHE_MIB = 2048;
/**
 * The turn an agentic session actually runs: a prompt that grew by this many
 * tokens since the last one (llama.cpp reuses the cached prefix, so only the
 * delta is prefilled) and this many tokens generated back. Nobody watches the
 * screen, so the number that ranks a row is the wall clock of that turn, not the
 * latency of its first token.
 */
const DEFAULT_GROWTH_TOKENS = 1024;
const DEFAULT_GEN_TOKENS = 512;

/**
 * @typedef {object} HostSpec
 * @property {string} name
 * @property {{name: string, vramMiB: number, reserveMiB: number, bandwidthGBs: number, flopsTFp16: number, bwUtilization: number, computeUtilization: number}} gpu
 * @property {{name: string, bandwidthGBs: number, flopsTFp16: number, bwUtilization: number, computeUtilization: number, cores: number}} cpu
 * @property {{name: string, bandwidthGBs: number}} link
 * @property {number} ramMiB
 */

/**
 * The device rates a scenario runs on, in bytes and FLOPs per second.
 * @typedef {object} Rates
 * @property {number} gpuBw
 * @property {number} gpuFlops
 * @property {number} cpuBw
 * @property {number} cpuFlops
 * @property {number} linkBw
 */

/**
 * tlalocayotl: one 16 GB RDNA2 card, DDR4-2400 through 8 PCIe 3.0 lanes.
 * The efficiencies are the reference calculators' (0.85 bandwidth, 0.50 decode
 * compute, 0.15 prefill MFU) and are the ONLY calibration knobs here — measured
 * predicted_per_second and prompt_per_second against these numbers is how they
 * get replaced.
 * @type {HostSpec}
 */
export const HOST = {
	name: "tlalocayotl",
	gpu: {
		name: "Radeon RX 6900 XT",
		vramMiB: 16_384,
		/** Display, driver and compute buffers: never available to weights. */
		reserveMiB: 512,
		bandwidthGBs: 512,
		flopsTFp16: 23.04,
		bwUtilization: 0.85,
		computeUtilization: 0.5,
	},
	cpu: {
		name: "Ryzen 7 5800X3D",
		bandwidthGBs: 38.4,
		flopsTFp16: 1.6,
		bwUtilization: 0.85,
		computeUtilization: 0.5,
		cores: 8,
	},
	link: { name: "PCIe 3.0 x8", bandwidthGBs: 3.9 },
	ramMiB: 80 * 1024,
};

/**
 * @param {HostSpec} host
 * @returns {Rates}
 */
function rates(host) {
	return {
		gpuBw: host.gpu.bandwidthGBs * 1e9 * host.gpu.bwUtilization,
		gpuFlops: host.gpu.flopsTFp16 * 1e12 * host.gpu.computeUtilization,
		cpuBw: host.cpu.bandwidthGBs * 1e9 * host.cpu.bwUtilization,
		cpuFlops: host.cpu.flopsTFp16 * 1e12 * host.cpu.computeUtilization,
		linkBw: host.link.bandwidthGBs * 1e9,
	};
}

/**
 * The flash-attention prefill gain, from the reference estimator: tiled
 * attention pays off more the longer the prompt, saturating at 2.45x.
 * @param {number} ctx
 * @returns {number}
 */
function flashBoost(ctx) {
	return Math.min(2.45, 1.08 + Math.log2(Math.max(2, ctx)) / 14);
}

/**
 * Cells a KV row holds: the full context, or the SWA ring buffer's
 * pad(min(ctx, window + ubatch), 256) — the formula llama.cpp allocates with,
 * so a 1024-token window costs 1536 cells per layer, not 262144.
 * @param {number} ctx
 * @param {number} window sliding-window size, 0 when the layer is global
 * @returns {number}
 */
function kvCells(ctx, window) {
	if (!window) {
		return ctx;
	}
	return Math.min(
		ctx,
		Math.ceil((window + N_UBATCH) / KV_CELL_PAD) * KV_CELL_PAD,
	);
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function sum(values) {
	return values.reduce((a, b) => a + b, 0);
}

/**
 * A per-layer array read that cannot be undefined: the facts arrays are as long
 * as the layer count (the facts test pins it), and a missing entry must read as
 * zero rather than poison a sum with NaN.
 * @param {number[]} values
 * @param {number} i
 * @returns {number}
 */
function at(values, i) {
	return values[i] ?? 0;
}

/**
 * @typedef {object} Pass
 * @property {number} layer the PHYSICAL layer whose weights this pass reads
 * @property {number} [kvK] K elements per token (defaults to the layer's)
 * @property {number} [kvV] V elements per token
 * @property {number} [ctxWindow] this pass's sliding window, when it has one
 */

/**
 * @typedef {object} DraftFacts
 * @property {string} [file]
 * @property {number | null} bytes
 * @property {number | null} [layers]
 * @property {number[]} kvK
 * @property {number[]} kvV
 * @property {number[]} ctxWindows
 */

/**
 * One row of model-facts.json: what extract.mjs read out of that GGUF's header,
 * plus the entry's own serving decisions.
 * @typedef {object} ModelFacts
 * @property {string} id
 * @property {string} repo
 * @property {string | null} quant
 * @property {string} arch
 * @property {number} fileBytes
 * @property {number} layers physical blocks in the file
 * @property {number} embd
 * @property {number} experts
 * @property {number} expertsUsed
 * @property {number} nextnPredictLayers trailing blocks that are the MTP head
 * @property {number} ctxNative
 * @property {number | null} slidingWindow
 * @property {number} trunkBytes
 * @property {number} inputEmbeddingBytes
 * @property {number} outputBytes VRAM-resident head, read once per token
 * @property {number} outputElems
 * @property {number[]} layerBytes
 * @property {number[]} layerExpertBytes
 * @property {number[]} layerElems
 * @property {number[]} layerExpertElems
 * @property {number[]} layerKvElemsK
 * @property {number[]} layerKvElemsV
 * @property {number[]} layerCtxCap
 * @property {number} servedContext
 * @property {string} cacheTypeV
 * @property {boolean} speculative
 * @property {DraftFacts | null} draft
 * @property {Pass[]} [passes] a looped model's pass list; absent means one pass
 *   per decoder layer
 */

/**
 * One prompt arm: the token count to prefilled and the rates that arm runs at
 * (flash attention's gain depends on the prompt length, so each arm carries its
 * own).
 * @typedef {object} PrefillCfg
 * @property {number} tokens
 * @property {number} gpuFlops
 * @property {number} cpuFlops
 */

/**
 * One placement's budget, in both phases.
 * @typedef {object} Placement
 * @property {number} decodeSec
 * @property {number} decodeTps
 * @property {number} decodeMs
 * @property {number[]} prefillSec per prompt arm, in the order it was asked
 * @property {number[]} prefillTps prompt tokens per second, per arm
 * @property {number} cpuExpertDecodeSec the part the expert cache can price
 * @property {Split} decode where the decode second goes, by resource
 * @property {Split[]} prefill the same, per prompt arm
 * @property {number} hops
 * @property {number} vramBytes
 * @property {number} ramBytes
 * @property {number} gpuLayers
 * @property {number} hybridLayers
 * @property {number} cpuLayers
 * @property {string[]} modes per physical layer: gpu | hybrid | cpu
 */

/**
 * The pass list a model executes per token. A conventional transformer runs one
 * pass per physical layer; a looped model (the planned Inkling 2 Mini: 24
 * physical blocks read as 48 passes, 8 global + 40 sliding-window-1024) carries
 * its own list, and every number below follows from it — which is the whole
 * reason passes are data instead of loop counters.
 * @param {ModelFacts} model
 * @returns {Pass[]}
 */
function passesOf(model) {
	if (model.passes) {
		return model.passes;
	}
	const decoder = model.layers - model.nextnPredictLayers;
	return Array.from({ length: decoder }, (_v, i) => ({ layer: i }));
}

/**
 * The per-pass KV bytes at one context, honouring each layer's sliding window
 * and the two cache types separately (K is f16; V follows --cache-type-v).
 * @param {{model: ModelFacts, passes: Pass[], ctx: number, bpeK: number, bpeV: number}} args
 * @returns {number[]}
 */
function kvByPass({ model, passes, ctx, bpeK, bpeV }) {
	return passes.map((p) => {
		const window = p.ctxWindow ?? at(model.layerCtxCap, p.layer);
		const cells = kvCells(ctx, window);
		const kElems = p.kvK ?? at(model.layerKvElemsK, p.layer);
		const vElems = p.kvV ?? at(model.layerKvElemsV, p.layer);
		return cells * (kElems * bpeK + vElems * bpeV);
	});
}

/**
 * One device's share of one pass.
 * @param {number} bytes
 * @param {number} elems
 * @param {number} bw bytes/second
 * @param {number} flops FLOPs/second
 * @returns {{sec: number, memoryBound: boolean}}
 */
function stepTime(bytes, elems, bw, flops) {
	const memorySec = bytes / bw;
	const computeSec = (FLOPS_PER_PARAM * elems) / flops;
	return {
		sec: Math.max(memorySec, computeSec),
		memoryBound: memorySec >= computeSec,
	};
}

/**
 * The prompt half of one pass: the same bytes read once for the whole prompt,
 * and FLOPs that grow with the tokens (linear in the weights, quadratic in
 * attention — a sliding window caps the quadratic term at ctx x window).
 * @param {{bytes: number, elems: number, attnElems: number, tokens: number, window: number, bw: number, flops: number}} args
 * @returns {{sec: number, memoryBound: boolean}}
 */
function prefillTime({ bytes, elems, attnElems, tokens, window, bw, flops }) {
	const attended = window > 0 ? Math.min(tokens, window) : tokens;
	const flopsTotal =
		FLOPS_PER_PARAM * elems * tokens +
		FLOPS_PER_PARAM * attnElems * tokens * attended;
	const memorySec = bytes / bw;
	const computeSec = flopsTotal / flops;
	return {
		sec: Math.max(memorySec, computeSec),
		memoryBound: memorySec >= computeSec,
	};
}

/**
 * llama.cpp's --fit on placement, which is what the deployed config runs: fill
 * back to front, counting a MoE layer as its dense part only (its experts stay
 * in host memory), then upgrade the hybrids front to back while VRAM allows.
 * Mirrors huggingface-estimate's computeOffloadSplit, passes one and two; the
 * reference's third pass (a fractional boundary layer) is left out because it
 * can only move the answer by the one layer it cannot fit whole.
 * @param {{model: ModelFacts, decoder: number, usable: number, reserved: number, kv: number[]}} args
 * @returns {{modes: string[], spareBytes: number}}
 */
function autoSplit({ model, decoder, usable, reserved, kv }) {
	const modes = Array.from({ length: model.layers }, () => "cpu");
	let remaining = usable - reserved;
	for (let i = decoder - 1; i >= 0; i--) {
		const experts = at(model.layerExpertBytes, i);
		const bytes = at(model.layerBytes, i);
		const cost = (experts > 0 ? bytes - experts : bytes) + at(kv, i);
		if (remaining < cost) {
			break;
		}
		modes[i] = experts > 0 ? "hybrid" : "gpu";
		remaining -= cost;
	}
	for (let i = 0; i < decoder; i++) {
		if (modes[i] !== "hybrid") {
			continue;
		}
		const experts = at(model.layerExpertBytes, i);
		if (remaining < experts) {
			break;
		}
		remaining -= experts;
		modes[i] = "gpu";
	}
	return { modes, spareBytes: remaining };
}

/**
 * @param {ModelFacts} model
 * @param {number} decoder
 * @returns {{denseBytes: number, expertBytes: number}}
 */
function layerTotals(model, decoder) {
	let denseBytes = 0;
	let expertBytes = 0;
	for (let i = 0; i < decoder; i++) {
		const experts = at(model.layerExpertBytes, i);
		expertBytes += experts;
		denseBytes += at(model.layerBytes, i) - experts;
	}
	return { denseBytes, expertBytes };
}

/**
 * The --n-cpu-moe N alternative: every layer's attention stays on the card and
 * the leading N layers' experts live in host memory. Returns the smallest N that
 * fits the dense trunk plus KV, or feasible false when even the trunk overflows.
 * @param {{model: ModelFacts, decoder: number, usable: number, reserved: number, kvTotal: number}} args
 * @returns {{feasible: boolean, nCpuMoe: number | null, spareBytes: number}}
 */
function expertSplit({ model, decoder, usable, reserved, kvTotal }) {
	const { denseBytes, expertBytes } = layerTotals(model, decoder);
	const spare = usable - reserved - denseBytes - kvTotal;
	if (spare < 0) {
		return { feasible: false, nCpuMoe: null, spareBytes: spare };
	}
	let accumulated = 0;
	let nCpuMoe = 0;
	while (nCpuMoe < decoder && expertBytes - accumulated > spare) {
		accumulated += at(model.layerExpertBytes, nCpuMoe);
		nCpuMoe++;
	}
	return {
		feasible: true,
		nCpuMoe,
		spareBytes: spare - (expertBytes - accumulated),
	};
}

/**
 * The budget of one placement, decode and prefill, every pass on the device that
 * holds it: the weights it reads, the KV it writes, the activations that cross
 * the bus and the router's dispatch cost.
 * @param {{model: ModelFacts, passes: Pass[], modes: string[], kv: number[], r: Rates, embd: number, prefills: PrefillCfg[]}} args
 * @returns {Placement}
 */
function timePlacement({ model, passes, modes, kv, r, embd, prefills }) {
	const expertShare = model.experts > 0 ? model.expertsUsed / model.experts : 0;
	/** @type {Split} */
	const decode = { ...NO_TIME };
	/** @type {Split[]} */
	const prefill = prefills.map(() => ({ ...NO_TIME }));
	/** Attribute one device's phase time to the resource that produced it. */
	const credit = (
		/** @type {Split} */ into,
		/** @type {{sec: number, memoryBound: boolean}} */ t,
		/** @type {boolean} */ onGpu,
	) => {
		if (t.memoryBound) {
			into[onGpu ? "vram" : "dram"] += t.sec;
		} else {
			into[onGpu ? "gpuCompute" : "cpuCompute"] += t.sec;
		}
	};
	const addPrefill = (
		/** @type {{bytes: number, elems: number, attnElems: number, window: number, onGpu: boolean}} */ part,
	) => {
		for (const [k, cfg] of prefills.entries()) {
			const t = prefillTime({
				bytes: part.bytes,
				elems: part.elems,
				attnElems: part.attnElems,
				tokens: cfg.tokens,
				window: part.window,
				bw: part.onGpu ? r.gpuBw : r.cpuBw,
				flops: part.onGpu ? cfg.gpuFlops : cfg.cpuFlops,
			});
			const split = prefill[k];
			if (split) {
				credit(split, t, part.onGpu);
			}
		}
	};

	let cpuExpertDecodeSec = 0;
	let hops = 0;
	let vramBytes = model.outputBytes;
	let ramBytes = model.inputEmbeddingBytes;
	let gpuLayers = 0;
	let hybridLayers = 0;
	let cpuLayers = 0;
	let anyGpu = false;

	for (const [i, pass] of passes.entries()) {
		const layer = pass.layer;
		const mode = modes[layer] ?? "cpu";
		const bytes = at(model.layerBytes, layer);
		const elems = at(model.layerElems, layer);
		const experts = at(model.layerExpertBytes, layer);
		const expertElems = at(model.layerExpertElems, layer);
		const activeExpertBytes = experts * expertShare;
		const activeExpertElems = expertElems * expertShare;
		const attnElems = at(model.layerKvElemsK, layer);
		const window = pass.ctxWindow ?? at(model.layerCtxCap, layer);
		const kvBytes = at(kv, i);
		const denseBytes = bytes - experts + kvBytes;
		const denseElems = elems - expertElems;

		if (mode === "gpu") {
			const readBytes = denseBytes + activeExpertBytes;
			const readElems = denseElems + activeExpertElems;
			credit(decode, stepTime(readBytes, readElems, r.gpuBw, r.gpuFlops), true);
			addPrefill({
				bytes: readBytes,
				elems: readElems,
				attnElems,
				window,
				onGpu: true,
			});
			vramBytes += bytes + kvBytes;
			anyGpu = true;
		} else if (mode === "cpu") {
			credit(
				decode,
				stepTime(bytes + kvBytes, elems, r.cpuBw, r.cpuFlops),
				false,
			);
			addPrefill({
				bytes: bytes + kvBytes,
				elems,
				attnElems,
				window,
				onGpu: false,
			});
			ramBytes += bytes + kvBytes;
		} else {
			const expertTime = stepTime(
				activeExpertBytes,
				activeExpertElems,
				r.cpuBw,
				r.cpuFlops,
			);
			credit(
				decode,
				stepTime(denseBytes, denseElems, r.gpuBw, r.gpuFlops),
				true,
			);
			credit(decode, expertTime, false);
			cpuExpertDecodeSec += expertTime.sec;
			addPrefill({
				bytes: denseBytes,
				elems: denseElems,
				attnElems,
				window,
				onGpu: true,
			});
			addPrefill({
				bytes: activeExpertBytes,
				elems: activeExpertElems,
				attnElems: 0,
				window: 0,
				onGpu: false,
			});
			vramBytes += denseBytes;
			ramBytes += experts;
			hops += HOPS_PER_SPLIT_LAYER;
			anyGpu = true;
		}
	}

	for (const mode of modes) {
		if (mode === "gpu") {
			gpuLayers++;
		} else if (mode === "hybrid") {
			hybridLayers++;
		} else {
			cpuLayers++;
		}
	}

	// The output head is read once per pass-batch, on whichever device holds it.
	credit(
		decode,
		stepTime(
			model.outputBytes,
			model.outputElems ?? 0,
			anyGpu ? r.gpuBw : r.cpuBw,
			anyGpu ? r.gpuFlops : r.cpuFlops,
		),
		anyGpu,
	);
	addPrefill({
		bytes: model.outputBytes,
		elems: model.outputElems ?? 0,
		attnElems: 0,
		window: 0,
		onGpu: anyGpu,
	});

	// A whole-stack spill costs one more activation round trip; the split layers
	// already paid theirs inside the loop. Prefill moves the whole prompt across
	// the same boundary, so its cost scales with that arm's token count.
	const stackHops =
		anyGpu && ramBytes > model.inputEmbeddingBytes && hops === 0 ? 1 : 0;
	const totalHops = hops + stackHops;
	const boundaryBw = Math.min(r.linkBw, r.cpuBw);
	decode.pcie += (totalHops * embd * ACTIVATION_BYTES) / boundaryBw;
	for (const [k, cfg] of prefills.entries()) {
		const split = prefill[k];
		if (split) {
			split.pcie +=
				(totalHops * embd * ACTIVATION_BYTES * cfg.tokens) / boundaryBw;
		}
	}
	decode.dispatch += model.experts * MOE_DISPATCH_SEC_PER_EXPERT;

	const decodeSec = splitSec(decode);
	return {
		decodeSec,
		decodeTps: decodeSec > 0 ? 1 / decodeSec : 0,
		decodeMs: decodeSec * 1000,
		decode,
		prefill,
		prefillSec: prefill.map((split) => splitSec(split)),
		prefillTps: prefills.map((cfg, k) => {
			const sec = prefill[k] ? splitSec(/** @type {Split} */ (prefill[k])) : 0;
			return sec > 0 ? cfg.tokens / sec : 0;
		}),
		cpuExpertDecodeSec,
		hops: totalHops,
		vramBytes,
		ramBytes,
		gpuLayers,
		hybridLayers,
		cpuLayers,
		modes,
	};
}

/**
 * What a --moe-cache-mib cache does to a placement whose experts live in host
 * memory. The cache is not free speed: a miss uploads an expert block across the
 * bus (3.9 GB/s) to read it at 512 GB/s, and one upload costs what ~10 host
 * reads cost, so the cache only wins at a high hit rate — the number returned as
 * breakEvenHit.
 *
 * Hit rate from routing skew: with locality = 1 (uniform, eviction-blind) the
 * resident fraction of the pool IS the hit rate; skewed routing makes a small
 * cache worth more than its share, which the exponent (1/locality) prices.
 *
 * Decode only, by construction: a prefill chunk touches nearly every expert in
 * the pool, so the cache cannot hold a chunk's working set on this host and its
 * prefill column is the static one.
 * @param {{cpuExpertBytes: number, poolBytes: number, staticExpertSec: number, r: Rates, cacheMiB?: number, cpuShare?: number, locality?: number}} args
 */
export function moeCacheEffect(args) {
	const {
		cpuExpertBytes,
		poolBytes,
		staticExpertSec,
		r,
		cacheMiB = DEFAULT_CACHE_MIB,
		cpuShare = 0,
		locality = 2,
	} = args;
	const missUnitCost =
		cpuShare / r.cpuBw + (1 - cpuShare) * (1 / r.linkBw + 1 / r.gpuBw);
	const staticUnitCost = 1 / r.cpuBw;
	const breakEvenHit =
		(staticUnitCost - missUnitCost) / (1 / r.gpuBw - missUnitCost);
	const residentFraction =
		poolBytes > 0 ? Math.min(1, (cacheMiB * MIB) / poolBytes) : 0;
	const hitRate =
		residentFraction > 0 ? Math.min(1, residentFraction ** (1 / locality)) : 0;
	const cachedUnitCost = hitRate / r.gpuBw + (1 - hitRate) * missUnitCost;
	const cachedExpertSec = cpuExpertBytes * cachedUnitCost;
	const factor = staticExpertSec > 0 ? cachedExpertSec / staticExpertSec : 1;
	// The cache is a bus trade, so its term is priced as one: hits read VRAM, and a
	// miss is either an upload over the link or host compute, never a DRAM read.
	const missBytes = cpuExpertBytes * (1 - hitRate);
	/** @type {Split} */
	const split = {
		vram: (cpuExpertBytes * hitRate + missBytes * (1 - cpuShare)) / r.gpuBw,
		dram: (missBytes * cpuShare) / r.cpuBw,
		pcie: (missBytes * (1 - cpuShare)) / r.linkBw,
		gpuCompute: 0,
		cpuCompute: 0,
		dispatch: 0,
	};
	return {
		split,
		cacheMiB,
		cpuShare,
		locality,
		poolMiB: poolBytes / MIB,
		cpuExpertMiB: cpuExpertBytes / MIB,
		hitRate,
		breakEvenHit,
		/** Decode time of the host-expert term, cached vs static (1 = no change). */
		factor,
		/** The cache size that holds everything a token asks for, with margin. */
		hotSetMiB: (cpuExpertBytes / MIB) * 2,
	};
}

/**
 * What an MTP head buys in decode. A round drafts K tokens (each a full pass
 * over the drafter's own weights, so a drafter that spilled to RAM is charged
 * host bandwidth), then verifies them in ONE target pass whose weight reads are
 * unchanged — only the extra tokens' attention and kernels are added on top.
 * @param {{model: ModelFacts, baseSplit: Split, spareBytes: number, ctx: number, r: Rates, bpeK: number, bpeV: number, acceptance?: number, depth?: number}} args
 * @returns {null | {acceptance: number, depth: number, draftMiB: number, draftKvMiB: number, draftResident: boolean, tokensPerRound: number, split: Split, tps: number, speedup: number}}
 */
function mtpEffect(args) {
	const {
		model,
		baseSplit,
		spareBytes,
		ctx,
		r,
		bpeK,
		bpeV,
		acceptance = 0.8,
		depth = 3,
	} = args;
	const draft = model.draft;
	if (!draft?.bytes) {
		return null;
	}
	// The drafter inherits the TARGET's context, but its own sliding windows cap
	// what each of its layers allocates (docs/d206's draft_kv term).
	const draftKv = (draft.kvK ?? []).reduce(
		(total, k, i) =>
			total +
			kvCells(ctx, draft.ctxWindows?.[i] ?? 0) *
				(k * bpeK + (draft.kvV?.[i] ?? 0) * bpeV),
		0,
	);
	const needBytes = draft.bytes + draftKv;
	// llama.cpp can leave PART of a drafter on the host (--n-gpu-layers-draft N),
	// so the cost is a blend rather than a residency cliff: what fits is read at
	// VRAM speed, the rest at DDR4 speed, and a head that misses by 5 MiB does not
	// read as five times slower than one that fits.
	const residentBytes = Math.min(needBytes, Math.max(0, spareBytes));
	const spilledBytes = needBytes - residentBytes;
	const resident = spilledBytes <= 0;
	const tokens =
		1 + sum(Array.from({ length: depth }, (_v, i) => acceptance ** (i + 1)));
	// The verify pass reads the target's weights once and pays only the extra
	// tokens' attention and kernels; the drafts are reads of their own bytes.
	const verify = scaleSplit(baseSplit, 1 + VERIFY_TOKEN_COST * (tokens - 1));
	/** @type {Split} */
	const draftSplit = {
		vram: (residentBytes / r.gpuBw) * depth,
		dram: (spilledBytes / r.cpuBw) * depth,
		pcie: 0,
		gpuCompute: 0,
		cpuCompute: 0,
		dispatch: 0,
	};
	const split = addSplit(verify, draftSplit);
	const roundSec = splitSec(split);
	const tps = tokens / roundSec;
	return {
		acceptance,
		depth,
		draftMiB: draft.bytes / MIB,
		draftKvMiB: draftKv / MIB,
		draftResident: resident,
		tokensPerRound: tokens,
		split,
		tps,
		speedup: tps * splitSec(baseSplit),
	};
}

/**
 * Where the time of one phase actually goes, by RESOURCE rather than by device:
 * the three buses a token waits on are not interchangeable (VRAM reads at
 * 435 GB/s, host DRAM at 33, the PCIe link at 3.9), and a single "bandwidth"
 * label hides which one is the wall.
 * @typedef {object} Split
 * @property {number} vram GPU weight and KV reads
 * @property {number} dram host weight and KV reads
 * @property {number} pcie boundary activations and expert uploads
 * @property {number} gpuCompute
 * @property {number} cpuCompute
 * @property {number} dispatch router and dispatch overhead
 */

/** @type {Split} */
const NO_TIME = {
	vram: 0,
	dram: 0,
	pcie: 0,
	gpuCompute: 0,
	cpuCompute: 0,
	dispatch: 0,
};

/**
 * @param {Split} a
 * @param {Split} b
 * @returns {Split}
 */
function addSplit(a, b) {
	return {
		vram: a.vram + b.vram,
		dram: a.dram + b.dram,
		pcie: a.pcie + b.pcie,
		gpuCompute: a.gpuCompute + b.gpuCompute,
		cpuCompute: a.cpuCompute + b.cpuCompute,
		dispatch: a.dispatch + b.dispatch,
	};
}

/**
 * @param {Split} split
 * @param {number} factor
 * @returns {Split}
 */
function scaleSplit(split, factor) {
	return {
		vram: split.vram * factor,
		dram: split.dram * factor,
		pcie: split.pcie * factor,
		gpuCompute: split.gpuCompute * factor,
		cpuCompute: split.cpuCompute * factor,
		dispatch: split.dispatch * factor,
	};
}

/** @param {Split} split @returns {number} */
function splitSec(split) {
	return (
		split.vram +
		split.dram +
		split.pcie +
		split.gpuCompute +
		split.cpuCompute +
		split.dispatch
	);
}

/**
 * The resource that owns the largest share of a phase. "gpu-compute" and
 * "cpu-compute" are the two cases where the buses are not the wall; everything
 * else names the bus.
 * @param {Split} split
 * @returns {string}
 */
function dominant(split) {
	/** @type {[string, number][]} */
	const entries = [
		["vram", split.vram],
		["dram", split.dram],
		["pcie", split.pcie],
		["gpu-compute", split.gpuCompute],
		["cpu-compute", split.cpuCompute],
		["dispatch", split.dispatch],
	];
	let name = "none";
	let sec = 0;
	for (const [resource, value] of entries) {
		if (value > sec) {
			name = resource;
			sec = value;
		}
	}
	return name;
}

/**
 * One resource's share of a phase, for the grid's numeric columns.
 * @param {Split} split
 * @param {keyof Split} resource
 * @returns {number}
 */
function share(split, resource) {
	const total = splitSec(split);
	return total > 0 ? split[resource] / total : 0;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function humanBytes(bytes) {
	const gib = bytes / 1024 ** 3;
	return gib >= 1 ? `${gib.toFixed(1)}G` : `${(bytes / MIB).toFixed(0)}M`;
}

/**
 * The expert bytes a placement leaves in host memory, and the pool they come
 * from: a token reads the first at host speed, and the cache's residency is a
 * fraction of the second. Both placements produce hybrids (--fit on leaves a MoE
 * layer's experts behind; --n-cpu-moe moves the leading ones), so one helper
 * serves both arms.
 * @param {{model: ModelFacts, passes: Pass[], modes: string[]}} args
 * @returns {{cpuExpertBytes: number, poolBytes: number}}
 */
function expertTotals({ model, passes, modes }) {
	const share = model.experts > 0 ? model.expertsUsed / model.experts : 0;
	let cpuExpertBytes = 0;
	let poolBytes = 0;
	for (const pass of passes) {
		if (modes[pass.layer] === "hybrid") {
			const bytes = at(model.layerExpertBytes, pass.layer);
			cpuExpertBytes += bytes * share;
			poolBytes += bytes;
		}
	}
	return { cpuExpertBytes, poolBytes };
}

/**
 * The two placements an expert layer can land in.
 * @typedef {Placement & {nCpuMoe: number, cpuExpertBytes: number, poolBytes: number}} ExpertOffload
 */

/**
 * Everything one context needs before the arms split: the pass list's KV, the
 * VRAM budget, and both placements priced.
 * @typedef {object} Geometry
 * @property {number} ctx
 * @property {Pass[]} passes
 * @property {number[]} kv
 * @property {number} kvTotal
 * @property {number} usable
 * @property {number} mtpTailBytes
 * @property {number} bpeK
 * @property {number} bpeV
 * @property {Rates} r
 * @property {number} growthTokens
 * @property {number} genTokens
 * @property {Placement} pipelined
 * @property {ExpertOffload | null} expert
 */

/**
 * Overrides a caller may set; every one has a default the deployment implies.
 * @typedef {object} PlanOptions
 * @property {HostSpec} [host]
 * @property {number[]} [contexts] the levels to price (default CONTEXTS)
 * @property {number} [fitTargetMiB] the macro's --fit-target, held free
 * @property {string} [cacheTypeK]
 * @property {string} [cacheTypeV]
 * @property {number} [cacheMiB] the cache arm's size, when the cache is on
 * @property {number} [cpuShare] --moe-cache-cpu-share
 * @property {number} [locality] routing skew; 1 is uniform eviction
 * @property {number} [mtpAcceptance] per-token acceptance rate of the drafter
 * @property {number} [mtpDepth] draft tokens per round
 * @property {number} [growthTokens] new prompt tokens per turn (prefix reused)
 * @property {number} [genTokens] tokens generated per turn
 */

/**
 * One flat row of the output: a single scenario, ready for DuckDB's
 * read_json_auto or read_csv_auto. Every field is a scalar for that reason —
 * a nested object would need a struct type in the consumer.
 * @typedef {object} ScenarioRow
 * @property {string} model
 * @property {string} repo
 * @property {string | null} quant
 * @property {string} arch
 * @property {number} layers
 * @property {number} experts
 * @property {number} experts_used
 * @property {number} ctx
 * @property {number} ctx_served
 * @property {number} growth_tokens
 * @property {number} gen_tokens
 * @property {number} weights_mib
 * @property {number} kv_mib
 * @property {number} usable_mib
 * @property {string} placement
 * @property {number} gpu_layers
 * @property {number} hybrid_layers
 * @property {number} cpu_layers
 * @property {number} vram_mib
 * @property {number} ram_mib
 * @property {number} cache_mib
 * @property {number} cache_hit_rate
 * @property {number} cache_break_even
 * @property {number} cpu_expert_mib
 * @property {number} cache_gain
 * @property {boolean} mtp
 * @property {number} mtp_depth
 * @property {number} mtp_alpha
 * @property {number} drafter_mib
 * @property {number} drafter_kv_mib
 * @property {boolean} drafter_resident
 * @property {number} mtp_gain
 * @property {number} decode_tps
 * @property {number} decode_ms
 * @property {number} turn_s one turn: the prompt delta, then the answer
 * @property {number} turn_tps the rate of that turn, which is what a
 *   non-interactive session feels
 * @property {number} cold_prefill_tps a fresh prompt of the whole context
 * @property {number} cold_ttft_s seconds to first token when the prefix is cold
 * @property {string} decode_bottleneck the resource that owns the decode second
 * @property {number} decode_vram_share
 * @property {number} decode_dram_share
 * @property {number} decode_pcie_share
 * @property {number} decode_compute_share
 * @property {string} prefill_bottleneck the same for a cold prompt
 * @property {number} prefill_compute_share
 */

/**
 * @param {number} value
 * @param {number} [digits]
 * @returns {number}
 */
function round(value, digits = 3) {
	const scale = 10 ** digits;
	return Math.round(value * scale) / scale;
}

/**
 * The context levels this row is priced at: the canonical levels it can serve,
 * and never one beyond its own context. A 64k row gets 32k and 64k; a 256k row
 * gets all five.
 * @param {ModelFacts} model
 * @param {PlanOptions} options
 * @returns {number[]}
 */
function contextArms(model, options) {
	const levels = options.contexts ?? CONTEXTS;
	return levels.filter((ctx) => ctx <= model.servedContext);
}

/**
 * @param {ModelFacts} model
 * @param {number} ctx
 * @param {PlanOptions} options
 * @returns {Geometry}
 */
function geometryAt(model, ctx, options) {
	const host = options.host ?? HOST;
	const r = rates(host);
	const bpeK = KV_BYTES[options.cacheTypeK ?? "f16"] ?? 2;
	const bpeV = KV_BYTES[options.cacheTypeV ?? model.cacheTypeV] ?? 2;
	const decoder = model.layers - model.nextnPredictLayers;
	const passes = passesOf(model);
	const kv = kvByPass({ model, passes, ctx, bpeK, bpeV });
	const kvTotal = sum(kv);
	const usable =
		(host.gpu.vramMiB - host.gpu.reserveMiB - (options.fitTargetMiB ?? 1024)) *
		MIB;
	const mtpTailBytes = sum(model.layerBytes.slice(decoder));
	const reserved = model.outputBytes + mtpTailBytes;
	const growth = Math.min(options.growthTokens ?? DEFAULT_GROWTH_TOKENS, ctx);
	const prefills = [ctx, growth].map((tokens) => ({
		tokens,
		gpuFlops: host.gpu.flopsTFp16 * 1e12 * PREFILL_MFU * flashBoost(tokens),
		cpuFlops: host.cpu.flopsTFp16 * 1e12 * PREFILL_MFU,
	}));

	const auto = autoSplit({ model, decoder, usable, reserved, kv });
	const pipelined = timePlacement({
		model,
		passes,
		modes: auto.modes,
		kv,
		r,
		embd: model.embd,
		prefills,
	});

	/** @type {ExpertOffload | null} */
	let expert = null;
	if (model.experts > 0) {
		const split = expertSplit({ model, decoder, usable, reserved, kvTotal });
		if (split.feasible && split.nCpuMoe !== null) {
			const modes = Array.from({ length: model.layers }, () => "gpu");
			for (let i = 0; i < split.nCpuMoe; i++) {
				modes[i] = "hybrid";
			}
			const placement = timePlacement({
				model,
				passes,
				modes,
				kv,
				r,
				embd: model.embd,
				prefills,
			});
			const totals = expertTotals({ model, passes, modes });
			expert = { ...placement, nCpuMoe: split.nCpuMoe, ...totals };
		}
	}

	return {
		ctx,
		growthTokens: growth,
		genTokens: options.genTokens ?? DEFAULT_GEN_TOKENS,
		passes,
		kv,
		kvTotal,
		usable,
		mtpTailBytes,
		bpeK,
		bpeV,
		r,
		pipelined,
		expert,
	};
}

/**
 * The scenario cartesian for one row: every context level x both placements x
 * the cache arms x speculation. The arms are pruned where they would be a
 * duplicate — a cache size on a placement with no host-resident expert, an MTP
 * arm on a row with no drafter — so a row in the output always differs from its
 * neighbours in at least one dimension it was asked about.
 * @param {ModelFacts} model
 * @param {PlanOptions} [options]
 * @returns {ScenarioRow[]}
 */
export function scenarios(model, options = {}) {
	/** @type {ScenarioRow[]} */
	const rows = [];
	const cacheMiB = options.cacheMiB ?? DEFAULT_CACHE_MIB;

	for (const ctx of contextArms(model, options)) {
		const g = geometryAt(model, ctx, options);
		const arms = [{ placement: "layer-pipelining", p: g.pipelined }];
		if (g.expert) {
			arms.push({ placement: "expert-offload", p: g.expert });
		}
		for (const arm of arms) {
			const totals = expertTotals({
				model,
				passes: g.passes,
				modes: arm.p.modes,
			});
			const cacheArms = totals.cpuExpertBytes > 0 ? [0, cacheMiB] : [0];
			for (const armCache of cacheArms) {
				const cache =
					armCache > 0
						? moeCacheEffect({
								cpuExpertBytes: totals.cpuExpertBytes,
								poolBytes: totals.poolBytes,
								staticExpertSec: arm.p.cpuExpertDecodeSec,
								r: g.r,
								cacheMiB: armCache,
								cpuShare: options.cpuShare ?? 0,
								locality: options.locality ?? 2,
							})
						: null;
				// The cache arm swaps the host-read term for the cache's own bus mix:
				// the static expert second leaves DRAM and comes back as VRAM reads and
				// link uploads, which is the whole point of the flag.
				const staticExpertSec = cache ? arm.p.cpuExpertDecodeSec : 0;
				const fromDram = Math.min(arm.p.decode.dram, staticExpertSec);
				const fromCompute = staticExpertSec - fromDram;
				const armSplit = cache
					? addSplit(
							{
								vram: arm.p.decode.vram,
								dram: arm.p.decode.dram - fromDram,
								pcie: arm.p.decode.pcie,
								gpuCompute: arm.p.decode.gpuCompute,
								cpuCompute: arm.p.decode.cpuCompute - fromCompute,
								dispatch: arm.p.decode.dispatch,
							},
							cache.split,
						)
					: arm.p.decode;
				const mtpArms =
					model.speculative && model.draft ? [false, true] : [false];
				for (const armMtp of mtpArms) {
					const mtp = armMtp
						? mtpEffect({
								model,
								baseSplit: armSplit,
								spareBytes: g.usable - arm.p.vramBytes - g.mtpTailBytes,
								ctx,
								r: g.r,
								bpeK: g.bpeK,
								bpeV: g.bpeV,
								acceptance: options.mtpAcceptance ?? 0.8,
								depth: options.mtpDepth ?? 3,
							})
						: null;
					// One token costs the round divided by the tokens it yields; with MTP the
					// round's split is the verify pass scaled plus the drafts' own reads.
					const split = mtp ? mtp.split : armSplit;
					const tokenSec = mtp
						? splitSec(split) / mtp.tokensPerRound
						: splitSec(split);
					const decodeTps = 1 / tokenSec;
					const coldPrefill = arm.p.prefill[0] ?? NO_TIME;
					const prefillCompute =
						share(coldPrefill, "gpuCompute") + share(coldPrefill, "cpuCompute");
					// A turn prefills only what grew since the last one (the server
					// keeps the prefix), then generates the answer.
					const turnSec = (arm.p.prefillSec[1] ?? 0) + tokenSec * g.genTokens;
					const turnTps =
						turnSec > 0 ? (g.growthTokens + g.genTokens) / turnSec : 0;
					rows.push({
						model: model.id,
						repo: model.repo,
						quant: model.quant,
						arch: model.arch,
						layers: model.layers,
						experts: model.experts,
						experts_used: model.expertsUsed,
						ctx,
						ctx_served: model.servedContext,
						growth_tokens: g.growthTokens,
						gen_tokens: g.genTokens,
						weights_mib: round(
							(sum(model.layerBytes) + model.trunkBytes) / MIB,
							1,
						),
						kv_mib: round(g.kvTotal / MIB, 1),
						usable_mib: round(g.usable / MIB, 1),
						placement: arm.placement,
						gpu_layers: arm.p.gpuLayers,
						hybrid_layers: arm.p.hybridLayers,
						cpu_layers: arm.p.cpuLayers,
						vram_mib: round(arm.p.vramBytes / MIB, 1),
						ram_mib: round(arm.p.ramBytes / MIB, 1),
						cache_mib: cache ? cache.cacheMiB : 0,
						cache_hit_rate: cache ? round(cache.hitRate, 4) : 0,
						cache_break_even: cache ? round(cache.breakEvenHit, 4) : 0,
						cpu_expert_mib: round(totals.cpuExpertBytes / MIB, 1),
						cache_gain: 1,
						mtp: Boolean(mtp),
						mtp_depth: mtp ? mtp.depth : 0,
						mtp_alpha: mtp ? mtp.acceptance : 0,
						drafter_mib: mtp ? round(mtp.draftMiB, 1) : 0,
						drafter_kv_mib: mtp ? round(mtp.draftKvMiB, 1) : 0,
						drafter_resident: mtp ? mtp.draftResident : false,
						mtp_gain: mtp ? round(mtp.speedup, 4) : 1,
						decode_tps: round(decodeTps, 3),
						decode_ms: round(tokenSec * 1000, 3),
						turn_s: round(turnSec, 3),
						turn_tps: round(turnTps, 3),
						cold_prefill_tps: round(arm.p.prefillTps[0] ?? 0, 3),
						cold_ttft_s: round(arm.p.prefillSec[0] ?? 0, 3),
						decode_bottleneck: dominant(split),
						decode_vram_share: round(share(split, "vram"), 3),
						decode_dram_share: round(share(split, "dram"), 3),
						decode_pcie_share: round(share(split, "pcie"), 3),
						decode_compute_share: round(
							share(split, "gpuCompute") + share(split, "cpuCompute"),
							3,
						),
						prefill_bottleneck: dominant(coldPrefill),
						prefill_compute_share: round(prefillCompute, 3),
					});
				}
			}
		}
	}

	// The two gains are relative to the neighbouring arm of the SAME scenario, so
	// a reader can compare them without recomputing the baseline.
	const key = (/** @type {ScenarioRow} */ r) =>
		`${r.model}|${r.ctx}|${r.placement}`;
	const cacheBase = new Map();
	const mtpBase = new Map();
	for (const row of rows) {
		if (row.cache_mib === 0) {
			cacheBase.set(`${key(row)}|${row.mtp}`, row.decode_tps);
		}
		if (!row.mtp) {
			mtpBase.set(`${key(row)}|${row.cache_mib}`, row.decode_tps);
		}
	}
	for (const row of rows) {
		if (row.cache_mib > 0) {
			const base = cacheBase.get(`${key(row)}|${row.mtp}`) ?? 0;
			row.cache_gain = base > 0 ? round(row.decode_tps / base, 4) : 1;
		}
		if (row.mtp) {
			const base = mtpBase.get(`${key(row)}|${row.cache_mib}`) ?? 0;
			row.mtp_gain = base > 0 ? round(row.decode_tps / base, 4) : 1;
		}
	}
	return rows;
}
