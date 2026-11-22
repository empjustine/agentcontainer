/**
 * @fileoverview compat.mjs — the request-shaping facts `/v1/models` cannot
 * carry, each next to the page that decides it.
 *
 * Two kinds live here, and the split is why the file exists:
 *   - `CHAT_COMPAT`, the provider-wide fields: a statement about how the
 *     gateway handles a request, not about a model (the docs' own framing).
 *   - `THINKING_KWARGS`, the ONE per-family request-shaping table, keyed by
 *     `metadata.huggingface_id` rather than by model id because the `nw-*`
 *     rows are tracking aliases that move between models
 *     (/guides/tracking-aliases): a table keyed by id would keep applying one
 *     family's kwarg to whatever the alias points at next.
 *
 * Not here on purpose: `supportsReasoningEffort` is per model
 * (`metadata.capabilities.reasoning_effort`, read in merge.mjs), and
 * `thinkingTokenBudgetField` stays unset — see the README's open items.
 */

/**
 * The provider-wide compat, from the documentation:
 *
 *   `supportsDeveloperRole: false` — roles are `system, user, assistant,
 *   tool`; "`developer` is not in this list. It is forwarded verbatim rather
 *   than mapped, so use `system`"
 *   (/api-reference/inference/create-a-chat-completion). Also required by the
 *   vendor's pi page (/integrations/pi).
 *
 *   `requiresReasoningContentOnAssistantMessages: false` — the flag's whole
 *   effect is an appended empty `reasoning_content`, which
 *   /api/chat-completions#preserving-reasoning-across-turns forbids
 *   ("Avoid appending an empty companion field just to satisfy a client
 *   compatibility toggle").
 *
 *   `maxTokensField: "max_completion_tokens"` — "OpenAI's newer name for
 *   `max_tokens`; wins when both are sent" (/api/chat-completions).
 *
 * `supportsUsageInStreaming` needs no entry: pi's default is true and
 * /guides/streaming documents `stream_options.include_usage`. `store`,
 * `strict` and mid-conversation system messages stay unset: the provider
 * documents none of them, and a flag enabled on absence-of-evidence changes
 * what pi SENDS (docs/d100).
 * @type {Readonly<Record<string, unknown>>}
 */
export const CHAT_COMPAT = Object.freeze({
	supportsDeveloperRole: false,
	requiresReasoningContentOnAssistantMessages: false,
	maxTokensField: "max_completion_tokens",
});

/**
 * Reasoning history survives a turn boundary only if the client echoes prior
 * assistant reasoning AND the model's template keeps it; which kwarg opts into
 * that is per family (/api/chat-completions#per-model-behavior):
 *
 *   - Qwen3.6-35B is suffix-only by default → `preserve_thinking: true`.
 *   - DeepSeek V4.1-Flash is suffix-only without tools → `drop_thinking:
 *     false` makes full history unconditional (tools already override it, so
 *     the value is harmless when tools are present).
 *   - GLM-5.3 and Qwen3.8-27B already keep full history by default, so they
 *     need no row: absent means "no kwarg", never "unknown family, guess".
 *
 * The route is `samplingParams` (fields merged into every request body), not
 * `compat.chatTemplateKwargs`: that one is sent only when `thinkingFormat` is
 * `chat-template`, and that format sends the effort through the template
 * instead of `reasoning_effort` — which the page above requires to keep
 * working alongside the kwarg
 * (https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md).
 * @type {Readonly<Record<string, Readonly<Record<string, boolean>>>>}
 */
export const THINKING_KWARGS = Object.freeze({
	"Qwen/Qwen3.6-35B-A3B-FP8": Object.freeze({ preserve_thinking: true }),
	"deepseek-ai/DeepSeek-V4.1-Flash-1017": Object.freeze({
		drop_thinking: false,
	}),
});

/**
 * The chat_template_kwargs body for one family, or undefined when the family
 * needs no opt-in. A row without a `huggingface_id` (the field is nullable)
 * gets no kwarg rather than a guess.
 * @param {string|null|undefined} huggingfaceId
 * @returns {Record<string, boolean>|undefined}
 */
export function thinkingKwargsFor(huggingfaceId) {
	if (typeof huggingfaceId !== "string") {
		return;
	}
	const kwargs = THINKING_KWARGS[huggingfaceId];
	return kwargs ? { ...kwargs } : undefined;
}
