/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gemini Interactions API routing: discovery gate + thinking profiles.
 *
 * This is bridge routing logic — it decides which SDK surface GeminiClient
 * speaks — so it stays here when the dependency-free capability tables move
 * to ai-config (ai-lib#9).
 *
 * Two gates with different postures:
 *
 * - **Discovery is fail-open** ({@link isGeminiApiChatModel}): any
 *   chat-shaped model the endpoint lists may appear in the picker, so new
 *   models work immediately at their default thinking state.
 * - **Thinking is fail-closed** ({@link INTERACTIONS_PROFILES}): only
 *   profiled models advertise thinking levels or get `thinkingLevel`/
 *   `thinkingSummaries` on the wire, because valid levels vary per model in
 *   ways that cannot be inferred (gemini-3.7-flash rejects `minimal` while
 *   3.6-flash accepts it; hosted Gemma takes only `minimal`/`high`).
 */

/**
 * Thinking profile for a model on the Gemini Interactions API. Having a
 * profile is NOT a discovery gate — see {@link isGeminiApiChatModel}.
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
 * Explicit enumerated thinking profiles for models reachable via
 * `POST /v1beta/interactions`. **Fail-closed for thinking only**: unlisted
 * IDs are still discoverable (see {@link isGeminiApiChatModel}) but get no
 * advertised thinking levels and no `thinkingLevel`/`thinkingSummaries` on
 * the wire — they run at the model's default thinking state.
 *
 * To profile a model: verify its accepted `thinkingLevel` values on the
 * Interactions API, add its exact ID here, then update the corresponding
 * capability rules in ai-config and tests.
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
	// Verified on the live Interactions API (2026-08-17): 3.6-flash accepts
	// minimal/low/medium/high; 3.7-flash rejects minimal ("Allowed values
	// are: high, low, medium").
	["gemini-3.6-flash", { effortToWireLevel: identityLevels("minimal", "low", "medium", "high") }],
	["gemini-3.7-flash", { effortToWireLevel: identityLevels("low", "medium", "high") }],

	// --- Gemma 4 (hosted on the Gemini API) ---
	// Binary thinking, verified against the live API (2026-08-17): wire
	// thinkingLevel accepts only "minimal" (off) and "high" (on), and the
	// default when omitted is ON — so product "off" maps to an explicit
	// wire "minimal".
	["gemma-4-31b-it", { effortToWireLevel: { off: "minimal", high: "high" } }],
	["gemma-4-26b-a4b-it", { effortToWireLevel: { off: "minimal", high: "high" } }],
]);

/**
 * Return the Interactions API thinking profile for a model, or `undefined`
 * if the model has no profile. Unprofiled models are still discoverable and
 * chat-able — they just run at their default thinking state.
 */
export function getGeminiInteractionsProfile(
	modelId: string,
): GeminiInteractionsProfile | undefined {
	return INTERACTIONS_PROFILES.get(modelId);
}

/**
 * Whether a model ID has an Interactions thinking profile. Gates thinking
 * levels/summaries only — NOT discovery (see {@link isGeminiApiChatModel}).
 */
export function hasGeminiInteractionsProfile(modelId: string): boolean {
	return INTERACTIONS_PROFILES.has(modelId);
}

// ---------------------------------------------------------------------------
// Discovery gate (fail-open)
// ---------------------------------------------------------------------------

/**
 * Versioned chat-family IDs: `gemini-2.5-*`, `gemma-4-*`, … The digit
 * requirement excludes `gemini-embedding-*`, `gemini-robotics-*`,
 * `gemini-omni-*`, `deep-research-*`, and the `-latest` aliases (which would
 * duplicate versioned models in the picker).
 */
const CHAT_MODEL_ID = /^(?:gemini|gemma)-\d/;

/**
 * Known non-chat model families whose IDs pass {@link CHAT_MODEL_ID} and
 * that still report `generateContent`: image generation, TTS, and
 * computer-use preview models.
 */
const NON_CHAT_SUFFIX = /-(?:image|tts|computer-use)(?:-|$)/;

/**
 * Whether a model listed by the Gemini API `/models` endpoint should appear
 * in the model picker. **Fail-open** for chat-shaped models: an unprofiled
 * model chats at its default thinking state, and the worst case for a bad
 * inclusion is a visible, retryable error on the first turn.
 *
 * Three checks, validated against the live `/models` list (2026-08-17):
 *
 * 1. The ID must be a versioned Gemini/Gemma chat ID ({@link CHAT_MODEL_ID}).
 * 2. Known non-chat suffixes are excluded ({@link NON_CHAT_SUFFIX}).
 * 3. When the endpoint reports `supportedGenerationMethods`, it must include
 *    `generateContent` — this API-provided signal excludes audio/live/
 *    streaming models (`bidiGenerateContent`-only) and embedding models
 *    (`embedContent`-only). A missing field is not disqualifying.
 */
export function isGeminiApiChatModel(
	modelId: string,
	supportedGenerationMethods?: readonly string[],
): boolean {
	if (!CHAT_MODEL_ID.test(modelId) || NON_CHAT_SUFFIX.test(modelId)) {
		return false;
	}
	if (
		supportedGenerationMethods !== undefined &&
		!supportedGenerationMethods.includes("generateContent")
	) {
		return false;
	}
	return true;
}
