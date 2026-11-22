/**
 * @fileoverview extract.mjs — the roofline estimator's fact collector: one GGUF
 * header read per served model, written to model-facts.json so the estimator
 * itself never needs the model cache. docs/d113's copy-unit rule is why this is
 * an artifact and not a live read: the folder carries what it computes over, and
 * reaches into llm-local-inference only from this host-side collector.
 *
 * WHY read headers instead of trusting the manifest: a byte count says how big a
 * file is, not where those bytes live. Layer pipelining and expert offload are
 * decided per layer, so the numbers this tool needs — bytes per layer, bytes of
 * the expert tensors in that layer, KV elements per token, expert count — exist
 * only inside the GGUF tensor table. The manifest stays the byte-count authority:
 * the tensor table gives the SHAPE, the file size gives the VOLUME, so an
 * unknown quant type costs accuracy in the split instead of error in the total.
 *
 * Run on the host that holds the cache (the inference host), then commit the
 * artifact:
 *
 *     ./node-run.sh llm-local-bench/roofline/extract.mjs
 */
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const MODEL_DATA = join(
	ROOT,
	"llm-local-inference",
	"lib",
	"llamacpp-model-data.json",
);
const MANIFESTS = join(ROOT, "llm-local-inference", "lib", "hf-manifests");
const SERVED_CONFIG = join(
	ROOT,
	"llm-local-inference",
	"config.d",
	"10-local-llm-inference.yaml",
);
const OUT = join(HERE, "model-facts.json");

/**
 * ggml type -> [elements per block, bytes per block]. A type missing here is not
 * fatal: its tensors count as zero bytes and the file-size normalization below
 * absorbs the deficit, so a new quant costs split accuracy, never a crash.
 * @type {Record<number, [number, number]>}
 */
const GGML_TYPE = {
	0: [1, 4],
	1: [1, 2],
	2: [32, 18],
	3: [32, 20],
	6: [32, 22],
	7: [32, 24],
	8: [32, 34],
	9: [32, 36],
	10: [256, 84],
	11: [256, 110],
	12: [256, 144],
	13: [256, 176],
	14: [256, 210],
	15: [256, 292],
	16: [256, 66],
	17: [256, 74],
	18: [256, 98],
	19: [256, 50],
	20: [32, 18],
	21: [256, 110],
	22: [256, 82],
	23: [256, 136],
	24: [1, 1],
	25: [1, 2],
	26: [1, 4],
	27: [1, 8],
	28: [1, 8],
	29: [256, 56],
	30: [1, 2],
	31: [32, 18],
	32: [32, 18],
	33: [32, 18],
	34: [256, 54],
	35: [256, 66],
	36: [32, 18],
	37: [32, 18],
	38: [32, 18],
	39: [32, 17],
};

/** GGUF metadata scalar widths, by value type id (8 = string, 9 = array). */
/** @type {Record<number, number>} */
const FIXED_WIDTH = {
	0: 1,
	1: 1,
	2: 2,
	3: 2,
	4: 4,
	5: 4,
	6: 4,
	7: 1,
	10: 8,
	11: 8,
	12: 8,
};

/** Chunked little-endian reader: a header may be tens of MB of tokenizer text. */
class GgufReader {
	#fd;
	#buf = Buffer.alloc(1024 ** 2);
	#pos = 0;
	#end = 0;

	/** @param {string} path */
	constructor(path) {
		this.#fd = openSync(path, "r");
	}

	close() {
		closeSync(this.#fd);
	}

	/** @param {number} n */
	#fill(n) {
		if (this.#end - this.#pos >= n) {
			return;
		}
		this.#buf.copy(this.#buf, 0, this.#pos, this.#end);
		this.#end -= this.#pos;
		this.#pos = 0;
		if (n > this.#buf.length) {
			const bigger = Buffer.alloc(n);
			this.#buf.copy(bigger, 0, 0, this.#end);
			this.#buf = bigger;
		}
		while (this.#end < n) {
			const got = readSync(
				this.#fd,
				this.#buf,
				this.#end,
				this.#buf.length - this.#end,
				null,
			);
			if (got === 0) {
				throw new Error("gguf: truncated header");
			}
			this.#end += got;
		}
	}

	/** @param {number} n */
	skip(n) {
		let left = n;
		while (left > 0) {
			const step = Math.min(left, this.#buf.length);
			this.#fill(step);
			this.#pos += step;
			left -= step;
		}
	}

	/** @param {number} n @returns {Buffer} */
	bytes(n) {
		this.#fill(n);
		const out = Buffer.from(this.#buf.subarray(this.#pos, this.#pos + n));
		this.#pos += n;
		return out;
	}

	u32() {
		this.#fill(4);
		const v = this.#buf.readUInt32LE(this.#pos);
		this.#pos += 4;
		return v;
	}

	u64() {
		this.#fill(8);
		const v = Number(this.#buf.readBigUInt64LE(this.#pos));
		this.#pos += 8;
		return v;
	}

	/** @returns {string} */
	str() {
		const n = this.u64();
		return n === 0 ? "" : this.bytes(n).toString("utf8");
	}

	/**
	 * One metadata value. Numeric arrays are materialized because the attention
	 * geometry lives in them (per-layer head counts, the sliding-window pattern);
	 * string arrays are stepped over — the tokenizer vocabulary is megabytes no
	 * roofline term reads.
	 */
	/** @param {number} type @returns {any} */
	value(type) {
		if (type === 8) {
			return this.str();
		}
		if (type !== 9) {
			return this.#scalar(type);
		}
		const elem = this.u32();
		const count = this.u64();
		if (elem === 8) {
			for (let i = 0; i < count; i++) {
				this.skip(this.u64());
			}
			return null;
		}
		if (!(elem in FIXED_WIDTH)) {
			this.skip(count * (GGML_TYPE[elem]?.[1] ?? 0));
			return null;
		}
		const values = [];
		for (let i = 0; i < count; i++) {
			values.push(this.#scalar(elem));
		}
		return values;
	}

	/** @param {number} type @returns {any} */
	#scalar(type) {
		const width = FIXED_WIDTH[type];
		if (width === undefined) {
			throw new Error(`gguf: unknown metadata type ${type}`);
		}
		this.#fill(width);
		const at = this.#pos;
		this.#pos += width;
		const b = this.#buf;
		switch (type) {
			case 0:
				return b.readUInt8(at);
			case 1:
				return b.readInt8(at);
			case 2:
				return b.readUInt16LE(at);
			case 3:
				return b.readInt16LE(at);
			case 4:
				return b.readUInt32LE(at);
			case 5:
				return b.readInt32LE(at);
			case 6:
				return b.readFloatLE(at);
			case 7:
				return b.readUInt8(at) !== 0;
			case 10:
				return Number(b.readBigUInt64LE(at));
			case 11:
				return Number(b.readBigInt64LE(at));
			case 12:
				return b.readDoubleLE(at);
			default:
				return null;
		}
	}
}

/**
 * The header's two tables, decoded.
 * @param {string} path
 * @returns {{kv: Record<string, any>, tensors: {name: string, elems: number, bytes: number}[]}}
 */
function readGgufHeader(path) {
	const r = new GgufReader(path);
	if (r.bytes(4).toString("ascii") !== "GGUF") {
		throw new Error(`${path}: not a gguf file`);
	}
	r.u32();
	const nTensors = r.u64();
	const nKv = r.u64();
	/** @type {Record<string, any>} */
	const kv = {};
	for (let i = 0; i < nKv; i++) {
		const key = r.str();
		kv[key] = r.value(r.u32());
	}
	const tensors = [];
	for (let i = 0; i < nTensors; i++) {
		const name = r.str();
		const nDims = r.u32();
		let elements = 1;
		for (let d = 0; d < nDims; d++) {
			elements *= r.u64();
		}
		const type = r.u32();
		r.u64();
		const shape = GGML_TYPE[type];
		tensors.push({
			name,
			elems: elements,
			bytes: shape ? Math.floor(elements / shape[0]) * shape[1] : 0,
		});
	}
	r.close();
	return { kv, tensors };
}

/** The Hugging Face cache layouts both here and in the serving image. @returns {string[]} */
function cacheRoots() {
	const hf = process.env.HF_HOME;
	return [
		hf ? join(hf, "hub") : null,
		join(homedir(), ".cache", "huggingface", "hub"),
	].filter((root) => root !== null);
}

/**
 * @param {string} repo "org/name"
 * @param {string} file the GGUF's path inside the repo
 * @returns {string | null} the cached file, or null when the model is not fetched
 */
function findCached(repo, file) {
	const dir = `models--${repo.replace("/", "--")}`;
	for (const root of cacheRoots()) {
		const snapshots = join(root, dir, "snapshots");
		if (!existsSync(snapshots)) {
			continue;
		}
		for (const commit of readdirSync(snapshots)) {
			const candidate = join(snapshots, commit, file);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}

/** @returns {Record<string, {repo: string, files: {path: string, size: number}[]}>} */
function readManifests() {
	/** @type {Record<string, {repo: string, files: {path: string, size: number}[]}>} */
	const out = {};
	for (const name of readdirSync(MANIFESTS)) {
		if (!name.endsWith(".json")) {
			continue;
		}
		const manifest = JSON.parse(readFileSync(join(MANIFESTS, name), "utf8"));
		out[manifest.repo] = manifest;
	}
	return out;
}

/**
 * @param {Record<string, {files: {path: string, size: number}[]}>} manifests
 * @param {string} repo
 * @param {string} file
 * @returns {number | null} the exact byte count the hub serves for that path
 */
function manifestSize(manifests, repo, file) {
	return manifests[repo]?.files.find((f) => f.path === file)?.size ?? null;
}

/**
 * The served context per entry. llama-swap's own config carries it (the
 * capabilities block), so the estimate is made at the context the router
 * launches — a default 8k would overstate the free VRAM of a 64k row.
 * @returns {Record<string, number>}
 */
function readServedContext() {
	try {
		/** @type {{models?: Record<string, any>}} */
		const cfg = JSON.parse(readFileSync(SERVED_CONFIG, "utf8"));
		/** @type {Record<string, number>} */
		const out = {};
		for (const entry of Object.values(cfg.models ?? {})) {
			const ctx = entry.capabilities?.context ?? entry.metadata?.contextWindow;
			if (ctx) {
				out[entry.metadata?.id ?? ""] = ctx;
			}
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Expert tensors carry the routed FFN; the rest of a layer is dense trunk.
 * @param {string} name
 * @returns {boolean}
 */
function isExpertTensor(name) {
	return name.includes("_exps") || name.includes("_expert");
}

/**
 * Every number the roofline needs about one model, from two authorities: the
 * manifest says how many bytes the file holds, the tensor table says how they
 * divide between the trunk, each layer, and each layer's routed experts.
 * @param {{kv: Record<string, any>, tensors: {name: string, elems: number, bytes: number}[]}} header
 * @param {number} fileBytes exact size from the manifest
 */
function factsOf(header, fileBytes) {
	const { kv, tensors } = header;
	const arch = kv["general.architecture"];
	/** @param {string} name @returns {any} */
	const get = (name) => kv[`${arch}.${name}`];
	const nLayers = get("block_count");
	const embd = get("embedding_length");
	const headCount = get("attention.head_count");
	const headKvRaw = get("attention.head_count_kv");
	const headKv = Array.isArray(headKvRaw)
		? headKvRaw
		: Array.from({ length: nLayers }, () => headKvRaw ?? headCount);
	const keyLength = get("attention.key_length") ?? Math.round(embd / headCount);
	const valueLength = get("attention.value_length") ?? keyLength;
	const slidingWindow = get("attention.sliding_window") ?? null;
	const swaPattern = get("attention.sliding_window_pattern");

	const perLayer = Array.from({ length: nLayers }, () => ({
		bytes: 0,
		expertBytes: 0,
		elems: 0,
		expertElems: 0,
	}));
	let trunkBytes = 0;
	let trunkElems = 0;
	let inputBytes = 0;
	let inputElems = 0;
	for (const tensor of tensors) {
		const match = tensor.name.match(/^blk\.(\d+)\./);
		if (!match) {
			trunkBytes += tensor.bytes;
			trunkElems += tensor.elems;
			// llama.cpp keeps token_embd in host memory and the output head in VRAM
			// (docs/d206's drafter arithmetic turns on that split).
			if (tensor.name.startsWith("token_embd")) {
				inputBytes += tensor.bytes;
				inputElems += tensor.elems;
			}
			continue;
		}
		const layer = perLayer[Number(match[1])];
		if (!layer) {
			continue;
		}
		layer.bytes += tensor.bytes;
		layer.elems += tensor.elems;
		if (isExpertTensor(tensor.name)) {
			layer.expertBytes += tensor.bytes;
			layer.expertElems += tensor.elems;
		}
	}

	// The manifest's byte count is exact; the tensor table's is only as complete
	// as the quant table above. Scale the shape to the real volume.
	const tableBytes = perLayer.reduce((s, l) => s + l.bytes, 0) + trunkBytes;
	const scale = tableBytes > 0 ? fileBytes / tableBytes : 0;
	const swaPerLayer = Array.isArray(swaPattern)
		? swaPattern.map(Boolean)
		: Array.from({ length: nLayers }, () => Boolean(slidingWindow));
	const keySwa = get("attention.key_length_swa") ?? keyLength;
	const valueSwa = get("attention.value_length_swa") ?? valueLength;

	// Hybrid attention (qwen35's SSM layers, nemotron_h's recurrent ones) keeps
	// only a constant-size state, so its cache does not grow with the context.
	// An explicit recurrent_layers array wins; otherwise the interval rule is
	// llama.cpp's own (qwen35.cpp: (i + 1) % interval === 0 is full attention).
	const recurrentLayers = get("attention.recurrent_layers");
	const fullAttnInterval = get("full_attention_interval") ?? 0;
	/** @param {number} i @returns {boolean} */
	const hasCache = (i) => {
		if (Array.isArray(recurrentLayers)) {
			return Number(recurrentLayers[i]) === 0 && (headKv[i] ?? 0) > 0;
		}
		if (fullAttnInterval > 0) {
			return (i + 1) % fullAttnInterval === 0;
		}
		return true;
	};

	return {
		arch,
		/** The hub's own byte count for the file — the one exact number here. */
		fileBytes,
		layers: nLayers,
		embd,
		headCount,
		experts: get("expert_count") ?? 0,
		expertsUsed: get("expert_used_count") ?? 0,
		expertsShared: get("expert_shared_count") ?? 0,
		ctxNative: get("context_length"),
		/** Trailing blocks that are the model's own MTP head, not decoder layers. */
		nextnPredictLayers: get("nextn_predict_layers") ?? 0,
		slidingWindow,
		/** Bytes of non-repeating weights: token embeddings, output head, final norm. */
		trunkBytes: Math.round(trunkBytes * scale),
		/** The token embedding table: host memory, never VRAM. */
		inputEmbeddingBytes: Math.round(inputBytes * scale),
		inputEmbeddingElems: inputElems,
		outputElems: trunkElems - inputElems,
		/** The output head and final norms: VRAM whenever any layer is offloaded. */
		outputBytes:
			Math.round(trunkBytes * scale) - Math.round(inputBytes * scale),
		/** @type {number[]} per-layer weight bytes, every tensor of that layer */
		layerBytes: perLayer.map((l) => Math.round(l.bytes * scale)),
		/** @type {number[]} per-layer routed-expert bytes (0 for a dense layer) */
		layerExpertBytes: perLayer.map((l) => Math.round(l.expertBytes * scale)),
		/** @type {number[]} K elements each layer writes per token (K stays f16) */
		layerKvElemsK: headKv.map((heads, i) =>
			hasCache(i) ? heads * (swaPerLayer[i] ? keySwa : keyLength) : 0,
		),
		/** @type {number[]} V elements each layer writes per token (--cache-type-v lever) */
		layerKvElemsV: headKv.map((heads, i) =>
			hasCache(i) ? heads * (swaPerLayer[i] ? valueSwa : valueLength) : 0,
		),
		/** @type {number[]} weight elements per layer — the FLOPs side of the roofline */
		layerElems: perLayer.map((l) => l.elems),
		/** @type {number[]} routed-expert elements per layer (0 for a dense layer) */
		layerExpertElems: perLayer.map((l) => l.expertElems),
		/** @type {number[]} per-layer cache cap in tokens (0 = the full context) */
		layerCtxCap: swaPerLayer.map((swa, i) =>
			hasCache(i) && swa && slidingWindow ? slidingWindow : 0,
		),
	};
}

/**
 * The block indices a file's tensor table actually fills, in order.
 * @param {{tensors: {name: string}[]}} header
 * @returns {number[]}
 */
function layerIdsOf(header) {
	const ids = new Set();
	for (const t of header.tensors) {
		const m = t.name.match(/^blk\.(\d+)\./);
		if (m) {
			ids.add(Number(m[1]));
		}
	}
	return [...ids].sort((a, b) => a - b);
}

/** @param {string} path @returns {number} */
function fileSize(path) {
	return Number(statSync(path).size);
}

function main() {
	const data = JSON.parse(readFileSync(MODEL_DATA, "utf8"));
	const manifests = readManifests();
	const servedCtx = readServedContext();
	const models = [];
	const missing = [];

	for (const entry of data.models) {
		const [repo, quant] = entry["hf-repo"].split(":");
		const file = entry.model;
		const cached = findCached(repo, file);
		if (!cached) {
			missing.push(`${entry["hf-repo"]} ${file}`);
			continue;
		}
		const bytes = manifestSize(manifests, repo, file) ?? fileSize(cached);
		const facts = factsOf(readGgufHeader(cached), bytes);
		const draft = entry["model-draft"] ?? null;
		const draftCached = draft ? findCached(repo, draft) : null;
		const draftHeader = draftCached ? readGgufHeader(draftCached) : null;
		const draftFacts =
			draftCached && draftHeader
				? factsOf(draftHeader, fileSize(draftCached))
				: null;
		// An MTP GGUF declares the TARGET's block_count while carrying only its own
		// one or four blocks, so the drafter's layer set comes from its tensor table.
		const draftLayers = draftHeader ? layerIdsOf(draftHeader) : [];
		models.push({
			id: entry["hf-repo"],
			repo,
			quant: quant ?? null,
			file,
			servedContext: servedCtx[entry["hf-repo"]] ?? facts.ctxNative ?? 8192,
			cacheTypeV: entry["cache-type-v"] ?? "f16",
			speculative:
				(entry.__argv ?? "").includes("SPEC_MTP") ||
				entry["spec-type"] === "draft-mtp",
			...facts,
			draft: draft
				? {
						file: draft,
						bytes:
							manifestSize(manifests, repo, draft) ??
							(draftCached ? fileSize(draftCached) : null),
						layers: draftLayers.length || null,
						kvK: draftFacts
							? draftLayers.map((i) => draftFacts.layerKvElemsK[i] ?? 0)
							: [],
						kvV: draftFacts
							? draftLayers.map((i) => draftFacts.layerKvElemsV[i] ?? 0)
							: [],
						ctxWindows: draftFacts
							? draftLayers.map((i) => draftFacts.layerCtxCap[i] ?? 0)
							: [],
					}
				: null,
		});
	}

	writeFileSync(
		OUT,
		JSON.stringify({ from: "llamacpp-model-data.json", models }, null, "\t") +
			"\n",
	);
	console.log(`wrote ${OUT}: ${models.length} models`);
	if (missing.length > 0) {
		console.log(
			"not in the local cache (" +
				missing.length +
				"):\n  " +
				missing.join("\n  "),
		);
	}
}

main();
