/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Variant classification for the Gemini **generateContent** API.
 *
 * This is the single source of truth shared by two consumers that must not
 * disagree: the discovery-time classifier (which decides whether a model may be
 * stamped `google-generative` and which effort levels to advertise) and the
 * `GeminiGenerateContentClient` (which maps a chosen effort level onto wire
 * parameters). If they derived the variant separately, a model could be
 * advertised with an effort level the wire mapping cannot express.
 *
 * Thinking controls on generateContent are **per variant**, not per family
 * (https://ai.google.dev/gemini-api/docs/thinking):
 *
 * - Gemini 2.5 uses a numeric `thinkingBudget`, with ranges and off-ability
 *   that differ per tier: Pro accepts 128–32768 and *cannot* disable thinking;
 *   Flash accepts 0–24576 and can; Flash-Lite accepts 512–24576 plus 0, and
 *   ships with thinking off by default.
 * - Gemini 3.x uses a categorical `thinkingLevel`, and the valid level set
 *   differs per variant — not per tier: `gemini-3-pro-preview` accepts only
 *   `low`/`high`, 3.1 Pro adds `medium`, the Flash and Flash-Lite variants
 *   accept all four, and `gemini-3.1-flash-lite-image` accepts only
 *   `minimal`/`high`. Each documented 3.x variant therefore gets its own
 *   exact rule; an undocumented 3.x name is not recognized at all (see below).
 *   No 3.x variant can disable thinking, so "off" is never advertised there.
 *
 * A variant that cannot be positively recognized returns `undefined`. That is
 * the safety mechanism the Databricks native-routing design leans on: without a
 * recognized variant we cannot build correct wire parameters, so the caller must
 * not route natively at all.
 */

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type GeminiGenerateContentThinking =
	| {
			control: "budget"; // Gemini 2.5: numeric thinkingBudget
			canDisable: boolean; // budget 0 allowed? (Flash/Flash-Lite yes, Pro no)
			budgets: { low: number; medium: number; high: number }; // wire values per effort level
	  }
	| {
			control: "level"; // Gemini 3.x: thinkingLevel
			levels: readonly string[]; // valid thinkingLevel values for this variant
	  };

export interface GeminiGenerateContentProfile {
	variant: string; // e.g. "2.5-pro", "2.5-flash", "2.5-flash-lite", "3-pro", "3-flash"
	thinking: GeminiGenerateContentThinking;
	/** Effort levels to advertise to users; includes "off" only when representable on this variant. */
	thinkingEffortLevels: readonly string[];
}

// ---------------------------------------------------------------------------
// Variant rules
// ---------------------------------------------------------------------------

/**
 * Effort levels a budget-controlled (2.5) variant advertises, before "off" is
 * added for the variants that can disable thinking.
 */
const BUDGET_EFFORT_LEVELS = ["low", "medium", "high"] as const;

/**
 * Budget wire values per effort level. Chosen inside each variant's documented
 * range, biased low so a request is never rejected for exceeding the cap:
 *
 * - `medium` is Google's documented 2.5 Pro default (8192), reused across tiers
 *   so switching tiers keeps comparable behavior.
 * - `high` is the variant's documented maximum.
 * - `low` (2048) is above every variant's documented minimum (Pro 128,
 *   Flash-Lite 512) and well below `medium`.
 */
const PRO_BUDGETS = { low: 2048, medium: 8192, high: 32_768 } as const;
const FLASH_BUDGETS = { low: 2048, medium: 8192, high: 24_576 } as const;

/** Level sets for the documented 3.x variants. */
const LEVELS_WITH_MINIMAL = ["minimal", "low", "medium", "high"] as const;
const LEVELS_LOW_MEDIUM_HIGH = ["low", "medium", "high"] as const;
/** `gemini-3-pro-preview` documents only these two levels. */
const LEVELS_LOW_HIGH = ["low", "high"] as const;
/** `gemini-3.1-flash-lite-image` documents only these two levels. */
const LEVELS_MINIMAL_HIGH = ["minimal", "high"] as const;

interface VariantRule {
	match: RegExp;
	thinking: GeminiGenerateContentThinking;
}

/**
 * Ordered rules; first match wins, so narrower patterns precede broader ones
 * (`flash-lite-image` before `flash-lite` before `flash`).
 *
 * The 2.5 rules are prefix-based per tier, which is safe because budget ranges
 * and off-ability are uniform within a 2.5 tier. The 3.x rules are **exact per
 * documented variant**: level sets differ variant-by-variant (3 Pro has no
 * `medium`; `3.1-flash-lite-image` has no `low`/`medium`), so there is no
 * generic set a future variant could safely inherit. An undocumented 3.x name
 * therefore matches nothing and yields `undefined` — no native route. Adding a
 * new variant requires adding its explicit rule here.
 */
const VARIANT_RULES: readonly VariantRule[] = [
	// --- Gemini 2.5: numeric thinkingBudget ---
	{
		match: /^gemini-2\.5-flash-lite/,
		// Thinking is off by default on Flash-Lite; budget 0 keeps it off.
		thinking: { control: "budget", canDisable: true, budgets: FLASH_BUDGETS },
	},
	{
		match: /^gemini-2\.5-flash/,
		thinking: { control: "budget", canDisable: true, budgets: FLASH_BUDGETS },
	},
	{
		match: /^gemini-2\.5-pro/,
		// Pro's documented minimum budget is 128 — thinking cannot be disabled.
		thinking: { control: "budget", canDisable: false, budgets: PRO_BUDGETS },
	},

	// --- Gemini 3.x: categorical thinkingLevel (no variant can disable) ---
	{
		match: /^gemini-3-pro(?:$|[-.])/,
		thinking: { control: "level", levels: LEVELS_LOW_HIGH },
	},
	{
		match: /^gemini-3\.1-pro(?:$|[-.])/,
		thinking: { control: "level", levels: LEVELS_LOW_MEDIUM_HIGH },
	},
	{
		// Image generation accepts only `minimal`/`high`. Must precede the
		// plain Flash-Lite rule.
		match: /^gemini-3\.1-flash-lite-image(?:$|[-.])/,
		thinking: { control: "level", levels: LEVELS_MINIMAL_HIGH },
	},
	{
		match: /^gemini-3\.1-flash-lite(?:$|[-.])/,
		thinking: { control: "level", levels: LEVELS_WITH_MINIMAL },
	},
	{
		match: /^gemini-3\.5-flash-lite(?:$|[-.])/,
		thinking: { control: "level", levels: LEVELS_WITH_MINIMAL },
	},
	{
		match: /^gemini-3-flash(?:$|[-.])/,
		thinking: { control: "level", levels: LEVELS_WITH_MINIMAL },
	},
	{
		match: /^gemini-3\.5-flash(?:$|[-.])/,
		thinking: { control: "level", levels: LEVELS_WITH_MINIMAL },
	},
	{
		match: /^gemini-3\.6-flash(?:$|[-.])/,
		thinking: { control: "level", levels: LEVELS_WITH_MINIMAL },
	},
];

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Reduce a model id or Databricks serving-endpoint name to the bare, dotted
 * `gemini-<version>-<tier>` form the rules match.
 *
 * Handles:
 *  - Bare ids: `gemini-2.5-pro`, `gemini-3-pro-preview`
 *  - OpenRouter-style prefixes: `google/gemini-2.5-pro`
 *  - Databricks pay-per-token endpoint names: `databricks-gemini-2-5-pro`
 *  - Unity Catalog system models: `system.ai.gemini-2-5-flash`
 *
 * Databricks endpoint names cannot contain `.`, so the version is dash-joined
 * (`gemini-2-5-pro`); the version segment is re-dotted here so one rule table
 * serves both naming styles.
 *
 * @returns The normalized `gemini-*` id, or `undefined` for non-Gemini ids.
 */
function normalizeGeminiGenerateContentId(modelId: string): string | undefined {
	const stripped = modelId
		.trim()
		.toLowerCase()
		.replace(/^system\.ai\./, "")
		.replace(/^databricks-/, "")
		.replace(/^.*\//, "");
	if (!stripped.startsWith("gemini-")) {
		return undefined;
	}
	// `gemini-2-5-pro` -> `gemini-2.5-pro` (dash-joined version segment only).
	return stripped.replace(/^gemini-(\d+)-(\d+)(?=$|-)/, "gemini-$1.$2");
}

/** The `variant` label reported back to callers (`gemini-3-pro-preview` -> `3-pro`). */
function variantLabel(normalizedId: string): string {
	return normalizedId.replace(/^gemini-/, "").replace(/-(?:preview|latest|exp)(?:-.*)?$/, "");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Variant profile for the Gemini generateContent API, derived from a model id
 * or Databricks endpoint name. Returns undefined when the variant is not
 * positively reconstructable — callers must then NOT route natively.
 */
export function getGeminiGenerateContentProfile(
	modelId: string,
): GeminiGenerateContentProfile | undefined {
	const normalized = normalizeGeminiGenerateContentId(modelId);
	if (!normalized) {
		return undefined;
	}
	const rule = VARIANT_RULES.find((candidate) => candidate.match.test(normalized));
	if (!rule) {
		// Recognized as Gemini but not as a variant with known thinking controls
		// (e.g. `gemini-2.0-flash`, or a future naming scheme). Deliberately
		// undefined: no wire mapping exists, so no native route.
		return undefined;
	}
	return {
		variant: variantLabel(normalized),
		thinking: rule.thinking,
		thinkingEffortLevels:
			rule.thinking.control === "budget"
				? rule.thinking.canDisable
					? ["off", ...BUDGET_EFFORT_LEVELS]
					: [...BUDGET_EFFORT_LEVELS]
				: // No 3.x variant can disable thinking, so "off" is not representable.
					rule.thinking.levels,
	};
}
