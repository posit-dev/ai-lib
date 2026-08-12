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
 *   differs per variant (e.g. `gemini-3-pro-preview` supports only
 *   `low`/`high`, while the Flash-class variants add `minimal` and `medium`).
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

interface VariantRule {
	match: RegExp;
	thinking: GeminiGenerateContentThinking;
}

/**
 * Ordered rules; first match wins, so tier-specific patterns precede broader
 * ones (`flash-lite` before `flash`, a pinned `3-pro` before generic 3.x Pro).
 *
 * The generic 3.x rules exist so a future variant of a documented tier is still
 * routable, and they carry the *intersection* of the levels documented for that
 * tier today — never a superset, so an unseen variant cannot be advertised a
 * level it rejects.
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
		match: /^gemini-3[\d.]*-pro(?:$|[-.])/,
		// 3.1 Pro documents low/medium/high; 3 Pro documents only low/high. A
		// future Pro variant gets the conservative intersection.
		// PHASE0-VERIFY: re-check per-variant Pro level sets as 3.x evolves.
		thinking: { control: "level", levels: LEVELS_LOW_HIGH },
	},
	{
		match: /^gemini-3[\d.]*-flash(?:$|[-.])/,
		// Every documented 3.x Flash / Flash-Lite variant supports all four
		// levels including `minimal`.
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
