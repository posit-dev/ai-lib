/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gemini Interactions API eligibility (allowlist + thinking profiles).
 *
 * This is bridge routing logic — it decides which SDK surface GeminiClient
 * speaks — so it stays here when the dependency-free capability tables move
 * to ai-config (ai-lib#9).
 */

/**
 * Profile for a model eligible for the Gemini Interactions API.
 */
export interface GeminiInteractionsProfile {
	/**
	 * Product-level thinking effort → Interactions API wire `thinkingLevel`.
	 *
	 * Product efforts and wire values are separate vocabularies: core/UI own
	 * the product levels (e.g. `off`, `high`); this mapping owns the
	 * translation. For most Gemini models the mapping is identity
	 * (`low→low`, …). For hosted Gemma, thinking is binary and `off` must be
	 * sent explicitly as wire `minimal` — when `thinkingLevel` is omitted,
	 * Gemma defaults to thinking ON.
	 *
	 * A product effort with no entry is unrecognized for the model; the
	 * request builder omits `thinkingLevel` in that case.
	 */
	effortToWireLevel: Readonly<Record<string, string>>;
}

/** Identity mapping for models whose product levels are already wire values. */
function identityLevels(...levels: string[]): Readonly<Record<string, string>> {
	return Object.fromEntries(levels.map((level) => [level, level]));
}

/**
 * Explicit enumerated allowlist of model IDs reachable via
 * `POST /v1beta/interactions`. **Fail-closed**: unlisted IDs are excluded.
 *
 * To add a model: add its exact ID here with a profile, then update the
 * corresponding capability rules in ai-config and tests.
 *
 * effortToWireLevel must match the Interactions API docs for each model.
 */
const INTERACTIONS_PROFILES: ReadonlyMap<string, GeminiInteractionsProfile> = new Map([
	// --- Gemini 2.5 (thinkingLevel: low/medium/high) ---
	["gemini-2.5-pro", { effortToWireLevel: identityLevels("low", "medium", "high") }],
	["gemini-2.5-flash", { effortToWireLevel: identityLevels("low", "medium", "high") }],
	["gemini-2.5-flash-lite", { effortToWireLevel: identityLevels("low", "medium", "high") }],

	// --- Gemini 3.x ---
	[
		"gemini-3-flash-preview",
		{ effortToWireLevel: identityLevels("minimal", "low", "medium", "high") },
	],
	["gemini-3.1-pro-preview", { effortToWireLevel: identityLevels("low", "medium", "high") }],
	[
		"gemini-3.1-flash-lite-preview",
		{ effortToWireLevel: identityLevels("minimal", "low", "medium", "high") },
	],
	// gemini-3.5-flash is in the SDK's GoogleInteractionsModelId union.
	// The plan originally excluded it citing v1beta2 routing, but the SDK
	// targets /v1beta and includes it, so we allowlist it here.
	["gemini-3.5-flash", { effortToWireLevel: identityLevels("minimal", "low", "medium", "high") }],

	// --- Gemma 4 (hosted on the Gemini API) ---
	// Binary thinking, verified against the live API (2026-08-17): wire
	// thinkingLevel accepts only "minimal" (off) and "high" (on), and the
	// default when omitted is ON — so product "off" maps to an explicit
	// wire "minimal".
	["gemma-4-31b-it", { effortToWireLevel: { off: "minimal", high: "high" } }],
	["gemma-4-26b-a4b-it", { effortToWireLevel: { off: "minimal", high: "high" } }],
]);

/**
 * Return the Interactions API profile for a Gemini model, or `undefined` if
 * the model is not eligible.
 *
 * **Fail-closed**: unlisted model IDs return `undefined`.
 */
export function getGeminiInteractionsProfile(
	modelId: string,
): GeminiInteractionsProfile | undefined {
	return INTERACTIONS_PROFILES.get(modelId);
}

/**
 * Whether a model ID is eligible for the Interactions API.
 */
export function isInteractionsEligible(modelId: string): boolean {
	return INTERACTIONS_PROFILES.has(modelId);
}
