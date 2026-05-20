/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ModelInfo } from "../types";

// ---------------------------------------------------------------------------
// Gemma model capability inference
// ---------------------------------------------------------------------------

/** Capability rule: regex match against the bare `gemma-*` portion of a model ID. */
interface CapabilityRule {
	match: RegExp;
	family: string;
	thinkingEffortLevels?: string[];
}

/**
 * Ordered list of rules. First match wins.
 *
 * Gemma 4 thinking models support binary on/off thinking via vllm's
 * `chat_template_kwargs: { enable_thinking: true }`.
 */
const CAPABILITY_RULES: CapabilityRule[] = [
	{
		match: /^gemma-4-/,
		family: "gemma-4",
		thinkingEffortLevels: ["off", "on"],
	},
];

/**
 * Strip the `google/` prefix to get the bare `gemma-*` model ID.
 *
 * @returns The bare `gemma-*` portion, or `undefined` for non-Gemma IDs.
 */
function normalizeGemmaModelId(modelId: string): string | undefined {
	const m = modelId.match(/^google\/(gemma-.+)$/);
	return m?.[1];
}

/**
 * Infer Gemma model capabilities from a model ID.
 *
 * @returns A partial `ModelInfo` with family, thinking effort levels, and
 *          `requiresChatTemplateKwargs` for vLLM thinking support,
 *          or `undefined` for non-Gemma models.
 */
export function getGemmaModelCapabilities(modelId: string): Partial<ModelInfo> | undefined {
	const normalized = normalizeGemmaModelId(modelId);
	if (!normalized) {
		return undefined;
	}

	const rule = CAPABILITY_RULES.find((r) => r.match.test(normalized));

	return {
		family: rule?.family ?? "gemma",
		thinkingEffortLevels: rule?.thinkingEffortLevels,
		// Gemma 4 models served by vLLM require chat_template_kwargs to enable thinking
		requiresChatTemplateKwargs: rule?.thinkingEffortLevels !== undefined,
	};
}
