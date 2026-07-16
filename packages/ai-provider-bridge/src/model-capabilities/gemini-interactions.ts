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
	/** Valid wire-level thinkingLevel values for this model. */
	thinkingLevels: readonly string[];
}

/**
 * Explicit enumerated allowlist of model IDs reachable via
 * `POST /v1beta/interactions`. **Fail-closed**: unlisted IDs are excluded.
 *
 * To add a model: add its exact ID here with a profile, then update the
 * corresponding CAPABILITY_RULES entry and tests.
 *
 * thinkingLevels must match the Interactions API docs for each model.
 * The builder validates against these — levels not listed here are
 * clamped to "medium".
 */
const INTERACTIONS_PROFILES: ReadonlyMap<string, GeminiInteractionsProfile> = new Map([
	// --- Gemini 2.5 (thinkingLevel: low/medium/high) ---
	["gemini-2.5-pro", { thinkingLevels: ["low", "medium", "high"] }],
	["gemini-2.5-flash", { thinkingLevels: ["low", "medium", "high"] }],
	["gemini-2.5-flash-lite", { thinkingLevels: ["low", "medium", "high"] }],

	// --- Gemini 3.x ---
	["gemini-3-flash-preview", { thinkingLevels: ["minimal", "low", "medium", "high"] }],
	["gemini-3.1-pro-preview", { thinkingLevels: ["low", "medium", "high"] }],
	["gemini-3.1-flash-lite-preview", { thinkingLevels: ["minimal", "low", "medium", "high"] }],
	// gemini-3.5-flash is in the SDK's GoogleInteractionsModelId union.
	// The plan originally excluded it citing v1beta2 routing, but the SDK
	// targets /v1beta and includes it, so we allowlist it here.
	["gemini-3.5-flash", { thinkingLevels: ["minimal", "low", "medium", "high"] }],
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
