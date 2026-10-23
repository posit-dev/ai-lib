/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { InferredModelCapabilities as ModelInfo } from "../types.js";
import { findGeminiVariantDonor } from "./gemini-variant.js";

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

/** Limits and thinking levels a capability entry assigns to a Gemini model. */
interface GeminiCapabilities {
	family: string;
	maxInputTokens: number;
	maxContextLength: number;
	maxOutputTokens: number;
	thinkingEffortLevels?: string[];
}

/** Limits shared by every Gemini 2.5 and 3.x model. */
const LIMITS_1M = {
	maxInputTokens: 1_000_000,
	maxContextLength: 1_000_000,
	maxOutputTokens: 65_536,
};

/**
 * Gemini models keyed by a representative id of their variant (`pro`,
 * `flash`, `flash-lite`) and version. A requested id takes the entry of its
 * variant with the greatest version at or below its own (see
 * {@link findGeminiVariantDonor}), so each entry covers the versions up to
 * the next one, and the newest entry of a variant is the fallback for later
 * versions (`gemini-3.9-flash` → the 3.7 Flash entry, `gemini-4-pro` → 3 Pro).
 * Order does not matter.
 *
 * Thinking effort levels and budget/level ranges are based on:
 * https://ai.google.dev/gemini-api/docs/thinking#levels-budgets
 *
 * Note: on the hosted Gemini API endpoint, advertised thinking levels come
 * from the bridge's Interactions profiles (the single source of truth
 * there); this table's levels serve Vertex, provider-agnostic inference,
 * and the config-migration seam.
 */
const VARIANT_ENTRIES: ReadonlyMap<string, GeminiCapabilities> = new Map([
	// --- Pro ---
	// 2.5 and 3.x Pro: low/medium/high only (no minimal on the Interactions API)
	[
		"gemini-2.5-pro",
		{ family: "gemini-2.5", ...LIMITS_1M, thinkingEffortLevels: LEVELS_WITHOUT_MINIMAL },
	],
	[
		"gemini-3-pro",
		{ family: "gemini-3", ...LIMITS_1M, thinkingEffortLevels: LEVELS_WITHOUT_MINIMAL },
	],

	// --- Flash ---
	[
		"gemini-2.5-flash",
		{ family: "gemini-2.5", ...LIMITS_1M, thinkingEffortLevels: LEVELS_WITHOUT_MINIMAL },
	],
	// 3.0–3.6 Flash: support minimal thinkingLevel
	[
		"gemini-3-flash",
		{ family: "gemini-3", ...LIMITS_1M, thinkingEffortLevels: LEVELS_WITH_MINIMAL },
	],
	// 3.7 Flash and later: low/medium/high only — 3.7 and 3.8 reject `minimal`
	// on the Interactions API (3.7-flash: "Allowed values are: high, low,
	// medium", verified 2026-08-17; 3.8-flash:
	// https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).
	[
		"gemini-3.7-flash",
		{ family: "gemini-3", ...LIMITS_1M, thinkingEffortLevels: LEVELS_WITHOUT_MINIMAL },
	],

	// --- Flash-Lite ---
	[
		"gemini-2.5-flash-lite",
		{ family: "gemini-2.5", ...LIMITS_1M, thinkingEffortLevels: LEVELS_WITHOUT_MINIMAL },
	],
	// Keyed at 3.0 so every 3.x Flash-Lite id supports minimal, as before.
	[
		"gemini-3-flash-lite",
		{ family: "gemini-3", ...LIMITS_1M, thinkingEffortLevels: LEVELS_WITH_MINIMAL },
	],
]);

/**
 * Version-family rules for ids with no recognized variant
 * (`gemini-3.5-live-translate-preview`) or no variant entry at or below their
 * version (`gemini-2.0-flash`). First match wins.
 */
const VERSION_FAMILY_RULES: (GeminiCapabilities & { match: RegExp })[] = [
	// 3.7 and 3.8: low/medium/high only (see the 3.7 Flash entry above).
	// Must precede the generic 3.x rule.
	{
		match: /^gemini-3\.[78]/,
		family: "gemini-3",
		...LIMITS_1M,
		thinkingEffortLevels: LEVELS_WITHOUT_MINIMAL,
	},
	{
		match: /^gemini-3/,
		family: "gemini-3",
		...LIMITS_1M,
		thinkingEffortLevels: LEVELS_WITH_MINIMAL,
	},
	{
		match: /^gemini-2\.5/,
		family: "gemini-2.5",
		...LIMITS_1M,
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

	const donor = findGeminiVariantDonor(normalized, VARIANT_ENTRIES.keys());
	const rule: GeminiCapabilities | undefined =
		(donor && VARIANT_ENTRIES.get(donor.id)) ??
		VERSION_FAMILY_RULES.find((r) => r.match.test(normalized));

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
