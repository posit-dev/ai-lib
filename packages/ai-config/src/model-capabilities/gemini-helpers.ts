/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { InferredModelCapabilities as ModelInfo } from "../types.js";

// ---------------------------------------------------------------------------
// Gemini model capability inference
// ---------------------------------------------------------------------------

/**
 * Effort levels for models that support `minimal` thinkingLevel (3.x Flash-class).
 * Note: "minimal" is NOT supported for 2.5 models on the Interactions API.
 */
const LEVELS_WITH_MINIMAL = ["minimal", "low", "medium", "high"];

/**
 * Effort levels for models without `minimal` (all 2.5 models, 3.x Pro).
 * The Interactions API has no wire-level mechanism to disable thinking on
 * default-on models, so "off" is not offered.
 */
const LEVELS_WITHOUT_MINIMAL = ["low", "medium", "high"];

/** Capability rule: regex match against normalized Gemini model ID. */
interface CapabilityRule {
	match: RegExp;
	family: string;
	maxInputTokens: number;
	maxContextLength: number;
	maxOutputTokens: number;
	thinkingEffortLevels?: string[];
}

/**
 * Ordered list of rules. First match wins.
 * More-specific patterns must come before less-specific ones
 * (e.g. "gemini-2.5-flash-lite" before "gemini-2.5-flash" before "gemini-2.5").
 *
 * Thinking effort levels and budget/level ranges are based on:
 * https://ai.google.dev/gemini-api/docs/thinking#levels-budgets
 */
const CAPABILITY_RULES: CapabilityRule[] = [
	// --- Gemini 3 family ---
	// 3.x Pro models: low/medium/high only
	{
		match: /^gemini-3[\d.]*-pro/,
		family: "gemini-3",
		maxInputTokens: 1_000_000,
		maxContextLength: 1_000_000,
		maxOutputTokens: 65_536,
		thinkingEffortLevels: LEVELS_WITHOUT_MINIMAL,
	},
	// 3.x Flash/Flash-Lite: support minimal thinkingLevel
	{
		match: /^gemini-3/,
		family: "gemini-3",
		maxInputTokens: 1_000_000,
		maxContextLength: 1_000_000,
		maxOutputTokens: 65_536,
		thinkingEffortLevels: LEVELS_WITH_MINIMAL,
	},

	// --- Gemini 2.5 family ---
	// All 2.5 models: low/medium/high only (no minimal on Interactions API)
	{
		match: /^gemini-2\.5-flash-lite/,
		family: "gemini-2.5",
		maxInputTokens: 1_000_000,
		maxContextLength: 1_000_000,
		maxOutputTokens: 65_536,
		thinkingEffortLevels: LEVELS_WITHOUT_MINIMAL,
	},
	{
		match: /^gemini-2\.5-flash/,
		family: "gemini-2.5",
		maxInputTokens: 1_000_000,
		maxContextLength: 1_000_000,
		maxOutputTokens: 65_536,
		thinkingEffortLevels: LEVELS_WITHOUT_MINIMAL,
	},
	{
		match: /^gemini-2\.5/,
		family: "gemini-2.5",
		maxInputTokens: 1_000_000,
		maxContextLength: 1_000_000,
		maxOutputTokens: 65_536,
		thinkingEffortLevels: LEVELS_WITHOUT_MINIMAL,
	},

	// --- Older families (no thinking support) ---
	{
		match: /^gemini-2\.0/,
		family: "gemini-2.0",
		maxInputTokens: 1_000_000,
		maxContextLength: 1_000_000,
		maxOutputTokens: 8_192,
	},
	{
		match: /^gemini-1\.5/,
		family: "gemini-1.5",
		maxInputTokens: 1_000_000,
		maxContextLength: 1_000_000,
		maxOutputTokens: 8_192,
	},
	{
		match: /^gemini-1\.0/,
		family: "gemini-1.0",
		maxInputTokens: 32_000,
		maxContextLength: 32_000,
		maxOutputTokens: 2_048,
	},
];

/** Fallback limits for unrecognized Gemini models. */
const DEFAULT_GEMINI_MAX_INPUT = 1_000_000;
const DEFAULT_GEMINI_MAX_OUTPUT = 65_536;

/**
 * Strip provider-specific prefixes to get the bare `gemini-*` model ID.
 *
 * Handles:
 *  - Bare: `gemini-2.5-pro`
 *  - OpenRouter: `google/gemini-2.5-pro`
 *
 * @returns The bare `gemini-*` portion, or `undefined` for non-Gemini IDs.
 */
function normalizeGeminiModelId(modelId: string): string | undefined {
	if (modelId.startsWith("gemini-")) {
		return modelId;
	}

	const m = modelId.match(/^google\/(gemini-.+)$/);
	return m?.[1];
}

/**
 * Infer Gemini model capabilities from any provider-specific model ID.
 *
 * @returns A partial `ModelInfo` with token limits, family, and capability
 *          flags, or `undefined` for non-Gemini models.
 */
export function getGeminiModelCapabilities(modelId: string): Partial<ModelInfo> | undefined {
	const normalized = normalizeGeminiModelId(modelId);
	if (!normalized) {
		return undefined;
	}

	const rule = CAPABILITY_RULES.find((r) => r.match.test(normalized));

	return {
		maxInputTokens: rule?.maxInputTokens ?? DEFAULT_GEMINI_MAX_INPUT,
		maxContextLength: rule?.maxContextLength ?? DEFAULT_GEMINI_MAX_INPUT,
		maxOutputTokens: rule?.maxOutputTokens ?? DEFAULT_GEMINI_MAX_OUTPUT,
		supportsToolResultImages: false,
		supportedInputMediaTypes: [
			"image/png",
			"image/jpeg",
			"image/gif",
			"image/webp",
			"application/pdf",
		],
		family: rule?.family,
		thinkingEffortLevels: rule?.thinkingEffortLevels,
	};
}
