/**
 * @fileoverview Judge-free scoring for llm-local-bench (docs/d201).
 *
 * WHY no model grades the answer: a second local model is another quantised
 * opinion, and a cloud judge contradicts the local-only constraint. Every check
 * below is a string or a file predicate the harness itself owns, so a score is
 * reproducible on any host, offline, in milliseconds — and a reviewer can re-run
 * the scorer on a journal without the model that produced it.
 *
 * WHAT the checks are: the decision (did it stop when the request was
 * unanswerable, and proceed when the repository settled it), the evidence (were
 * the paths that carry the truth among the paths it read), the facts (did the
 * seeded tokens appear at all), the artifact (does the requested file exist and
 * hold them), and the stop's shape (a stop with no question and no blocked
 * action is a bare refusal, not a clarification).
 *
 * WHAT is reported but not scored: citing a decoy source (the stale README, the
 * superseded record) drops clean, and naming a token that exists nowhere in the
 * tree sets invented. Both are findings a reader ranks by, not gates — folding
 * them into one boolean would hide which failure happened.
 */

const WITHOUT_PREFIX = /^\.\//;
const TRAILING_SLASH = /\/+$/;

/**
 * Paths arrive as the agent wrote them; one spelling for comparison.
 * @param {unknown} path
 * @returns {string}
 */
function normalize(path) {
	return String(path)
		.trim()
		.replace(WITHOUT_PREFIX, "")
		.replace(TRAILING_SLASH, "");
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const isFilled = (value) =>
	typeof value === "string" && value.trim().length > 0;

/**
 * @param {import("./episode.mjs").Step} step an episode step (episode.mjs)
 * @param {unknown} answer the parsed $BENCH_ANSWER, or null when none was written
 * @param {(path: string) => string | null} read reads a file from the step's workspace
 * @returns {{pass: boolean, answered: boolean, decision_ok: boolean, evidence_ok: boolean, facts_ok: boolean, artifact_ok: boolean, asked: boolean, clean: boolean, wrong_source: string[], phantom_source: string[], invented: string[], missing_evidence: string[], artifact_missing: string[]}}
 */
export function score(step, answer, read) {
	const truth = step.truth;
	const given = /** @type {Record<string, unknown>} */ (
		answer !== null && typeof answer === "object" ? answer : {}
	);
	const answered = typeof given.decision === "string";
	const cited = new Set(
		(Array.isArray(given.evidence) ? given.evidence : []).map(normalize),
	);
	const missing_evidence = truth.evidencePaths.filter((p) => !cited.has(p));
	const wrong_source = (truth.decoyPaths ?? []).filter((p) => cited.has(p));
	// A cited path that is not in the live workspace is a source the agent invented —
	// the journey's notes file makes this checkable, since only the agent can create it.
	const phantom_source = [...cited].filter((p) => read(p) === null);
	const asked =
		given.decision === "stop" &&
		isFilled(given.question) &&
		isFilled(given.blocked_action);
	// One blob so a fact quoted in facts and one quoted in question count the
	// same: the bench measures whether the value was FOUND, not where it was put.
	const blob = JSON.stringify(given).toLowerCase();
	const artifact_missing = truth.artifact
		? (() => {
				const body = read(truth.artifact.path);
				if (body === null) {
					return [truth.artifact.path];
				}
				return truth.artifact.contains.some((s) => !body.includes(s))
					? [truth.artifact.path]
					: [];
			})()
		: [];
	const decision_ok = given.decision === truth.decision;
	const evidence_ok = missing_evidence.length === 0;
	const facts_ok = (truth.requiredFacts ?? []).every((f) =>
		blob.includes(f.toLowerCase()),
	);
	const artifact_ok = artifact_missing.length === 0;
	const invented = (truth.inventedPool ?? []).filter((w) =>
		blob.includes(w.toLowerCase()),
	);
	return {
		pass:
			answered &&
			decision_ok &&
			evidence_ok &&
			facts_ok &&
			artifact_ok &&
			(truth.decision === "stop" ? asked : true),
		answered,
		decision_ok,
		evidence_ok,
		facts_ok,
		artifact_ok,
		asked,
		clean: wrong_source.length === 0,
		wrong_source,
		phantom_source,
		invented,
		missing_evidence,
		artifact_missing,
	};
}

/**
 * Grades a repair pass against the tree's own ledger (episode.mjs's defectsOf).
 *
 * WHY the pass is not scored on "did it fix what it was told about": the noticed
 * defect is the cheap half. The graded quantity is whether the rest of the
 * damage went with it, whether anything sound was broken in the process, and
 * whether the claimed span matches the span the tree's own history records —
 * "for how long was it wrong", which a session that only repairs the tip gets
 * wrong in one direction and a session that blames everything gets wrong in the
 * other.
 * @param {{before: import("./episode.mjs").Defect[], after: import("./episode.mjs").Defect[], claimed: {from: number, to: number} | null, span: {from: number, to: number} | null}} input
 * @returns {{fixed: number, remaining: number, regressions: number, span_ok: boolean, span_late_start: boolean, span_early_start: boolean, span_short_end: boolean, span_long_end: boolean}}
 */
export function gradeRecovery({ before, after, claimed, span }) {
	// A defect is identified by WHERE, WHAT and WHO WROTE IT: two wrong note lines
	// about the same key are two defects, so the step is part of the identity.
	/**
	 * @param {import("./episode.mjs").Defect} d
	 * @returns {string}
	 */
	const key = (d) => d.path + ":" + d.key + ":" + (d.step ?? "-");
	const beforeKeys = new Set(before.map(key));
	const afterKeys = new Set(after.map(key));
	return {
		fixed: before.filter((d) => !afterKeys.has(key(d))).length,
		remaining: after.length,
		// Sound before, broken after: the classic "fixed one thing, broke another",
		// which a repair score must not reward.
		regressions: after.filter((d) => !beforeKeys.has(key(d))).length,
		span_ok:
			span !== null &&
			claimed !== null &&
			claimed.from === span.from &&
			claimed.to === span.to,
		// Four ways to be wrong about "how long": not going back far enough,
		// blaming more than the tree does, missing damage past the tip, and
		// overreaching past it. Each is reported alone because they are different
		// repairs, and a session that only fixes the notice gets the first wrong.
		span_late_start:
			span !== null && claimed !== null && claimed.from > span.from,
		span_early_start:
			span !== null && claimed !== null && claimed.from < span.from,
		span_short_end: span !== null && claimed !== null && claimed.to < span.to,
		span_long_end: span !== null && claimed !== null && claimed.to > span.to,
	};
}
