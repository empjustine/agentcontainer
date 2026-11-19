/**
 * @fileoverview model-entries.mjs — the GGUF facts two tools must agree on:
 * shard expansion, the de-sharded main-GGUF view of a repo manifest, and the
 * full-precision tag. They live here rather than in 30-generate.mjs because the
 * curating generator and the manifest-authoring tool (20-propose-entries.mjs) both
 * need them, and a second copy is the drift this repo keeps paying for: the
 * retired downloader carried its own SPLIT_RE "kept in sync" by a comment.
 *
 * Nothing here reads the host or the Hub: these are pure functions over a
 * committed repo manifest (lib/hf-manifests/<org>--<repo>.json) and filenames.
 */

/**
 * Tail of one shard inside a split GGUF ("...-00001-of-00002.gguf"). Shard
 * groups are summed under the de-sharded name, so a repo's footprint per quant
 * is one number whether or not it was uploaded split.
 * @type {RegExp}
 */
export const GGUF_SHARD_RE = /-\d{5}-of-\d{5}\.gguf$/;

/**
 * Normalize a (possibly sharded) GGUF filename to its 00001 shard — llama.cpp
 * auto-loads sibling shards when pointed at the first one, and a model entry
 * must name shard 1.
 * @param {string} filename
 * @returns {string} the 00001-shard filename
 */
export function shardOne(filename) {
	const m = /-(\d{5})-of-(\d{5})\.gguf$/.exec(filename);
	if (m === null) {
		return filename;
	}
	return `${filename.slice(0, m.index)}-00001-of-${m[2]}.gguf`;
}

/**
 * Expand a sharded GGUF filename to ALL of its shards: llama-server needs the
 * complete set present, so both the curated manifest and its consumer list
 * every shard.
 * @param {string} filename
 * @returns {string[]} every shard filename
 */
export function allShards(filename) {
	const first = shardOne(filename);
	// the shard groups are all required, so a match carries them — the guard
	// below is the noUncheckedIndexedAccess narrowing of that fact.
	const m = /-(\d{5})-of-(\d{5})\.gguf$/.exec(first);
	const width = m?.[1]?.length;
	const total = m?.[2];
	if (m === null || width === undefined || total === undefined) {
		return [first];
	}
	const base = first.slice(0, first.length - m[0].length);
	return Array.from(
		{ length: Number(total) },
		(_, i) => `${base}-${String(i + 1).padStart(width, "0")}-of-${total}.gguf`,
	);
}

/**
 * Bytes per parameter of every full-precision GGUF the repos publish — the ONE
 * home of both "is this file full precision" and "how big is a parameter in
 * it". The size estimate (30-generate.mjs's totalParamsB) and the display rule
 * read this map, because two per-tag lists drifted: F32 was in neither, so an
 * F32-only repo went unsized and an F32 entry survived the very rule that hid
 * its BF16 sibling, at twice the bytes (docs/d202).
 *
 * Order matters: "bf16" precedes "f16", since "…BF16" also ends with "f16".
 * @type {Readonly<Record<string, number>>}
 */
export const FULL_PRECISION_BYTES_PER_PARAM = { f32: 4, bf16: 2, f16: 2 };

/**
 * Anywhere-in-the-name form of the same tags, for "this file is full precision
 * spelled oddly" — the size estimate's bare-upload fallback must not read a
 * file that mentions a full-precision tag but does not end with one.
 * @type {RegExp}
 */
export const FULL_PRECISION_NAME_RE = new RegExp(
	Object.keys(FULL_PRECISION_BYTES_PER_PARAM).join("|"),
	"i",
);

/**
 * @param {string} name a GGUF path or basename, with or without the extension,
 *   sharded or whole, or a model entry's bare ":quant" label
 * @returns {string|null} the full-precision tag the name ENDS with (a key of
 *   FULL_PRECISION_BYTES_PER_PARAM), or null for a quant or an untagged file
 */
export function fullPrecisionTag(name) {
	// shards are stripped first: a model entry and the repo manifest both name the
	// 00001 shard, so "...-BF16-00001-of-00002.gguf" must still read as BF16
	const base = (name.split("/").pop() ?? "")
		.replace(GGUF_SHARD_RE, "")
		.replace(/\.gguf$/i, "")
		.toLowerCase();
	for (const tag of Object.keys(FULL_PRECISION_BYTES_PER_PARAM)) {
		if (base.endsWith(tag)) {
			return tag;
		}
	}
	return null;
}

/**
 * The repo manifest's main GGUFs, shard groups summed under the de-sharded
 * name. Drafter and side-build files carry sizes unrelated to the weights (a
 * dflash bf16 once read a 27B blend as 1.9B), so they are excluded by the same
 * prefix rule llama.cpp uses to tell them apart from weights.
 * @param {Array<{path: string, size: number}>} files repo manifest files
 * @returns {Map<string, number>} de-sharded main GGUF path -> bytes
 */
export function mainGgufSizes(files) {
	/** @type {Map<string, number>} */
	const sizes = new Map();
	for (const f of files) {
		if (!f.path.endsWith(".gguf")) { continue; }
		// the projector, the MTP drafter, and the partial dflash/dspark artifacts
		// some repos ship beside the main quants
		if (/(^|\/)(mmproj|mtp|dflash|dspark)-/i.test(f.path)) { continue; }
		const key = f.path.replace(GGUF_SHARD_RE, ".gguf");
		sizes.set(key, (sizes.get(key) ?? 0) + f.size);
	}
	return sizes;
}

