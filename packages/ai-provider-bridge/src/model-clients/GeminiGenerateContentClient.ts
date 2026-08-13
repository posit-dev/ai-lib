/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Google Gemini API Client — plain `generateContent` (stateless)
 *
 * A separate client from {@link GeminiClient}, which speaks the stateful
 * Interactions API (`POST /v1beta/interactions`) and is built around
 * interaction-ID chaining, delta history, and expired-ID retry. This client
 * speaks the plain `generateContent` surface
 * (`POST {baseURL}/models/{model}:generateContent`, and its streaming
 * sibling) via the SDK's default chat model, which is what Gemini-compatible
 * gateways such as Databricks' native passthrough expose.
 *
 * Consequences of that surface, all deliberate:
 * - **Full local history on every request.** There is no server-side
 *   conversation state, so nothing is chained and nothing can expire — no
 *   interaction-ID extraction and no retry path.
 * - **Thought signatures, not Interactions signatures.** The generateContent
 *   message converter reads `providerOptions.google.thoughtSignature`, so the
 *   outbound sanitizer keys on that (see
 *   {@link sanitizeGenerateContentHistory}).
 * - **Thinking is wired as `thinkingConfig`.** 2.5-era variants take a
 *   numeric `thinkingBudget`; 3.x variants take a `thinkingLevel`. Which one
 *   applies (and whether "off" is even representable) comes from ai-config's
 *   per-variant profile — the same helper the discovery classifier uses, so
 *   the stamp and the wire choice cannot disagree.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import type { ModelMessage } from "ai";
import { streamText } from "ai";
import { getGeminiGenerateContentProfile } from "ai-config";
import type { GeminiGenerateContentProfile } from "ai-config";

import { safeSdkCustomHeaders } from "../custom-headers";
import type { LMStreamPart, Logger } from "../types";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";

/**
 * How this client authenticates to the `generateContent` surface.
 *
 * `apiKey` is the SDK's native scheme (`x-goog-api-key`). `authToken` is for
 * gateways that authenticate with `Authorization: Bearer` instead;
 * `GoogleGenerativeAIProviderSettings` has no `authToken` option, so that
 * scheme is implemented by a fetch middleware this client owns (see
 * {@link createBearerAuthFetch}).
 */
export type GeminiGenerateContentAuth = { apiKey: string } | { authToken: string };

/**
 * Non-secret filler for the SDK's required `apiKey` setting in Bearer mode.
 *
 * `createGoogleGenerativeAI` resolves `apiKey` eagerly (throwing when neither
 * the option nor `GOOGLE_GENERATIVE_AI_API_KEY` is set) and emits it as
 * `x-goog-api-key`. In Bearer mode the middleware deletes that header before
 * the request leaves, so this value never reaches a server — but it must be a
 * harmless placeholder rather than a real credential regardless.
 */
const PLACEHOLDER_API_KEY = "unused";

/** Effort value that turns thinking off, where the variant allows it. */
const EFFORT_OFF = "off";

/** Effort we clamp unrecognized values to, mirroring the Interactions client. */
const FALLBACK_EFFORT = "medium";

// ---------------------------------------------------------------------------
// Bearer auth middleware
// ---------------------------------------------------------------------------

/**
 * Wrap `fetch` so every request carries `Authorization: Bearer <token>` and
 * no `x-goog-api-key`.
 *
 * The SDK merges provider `settings.headers` (and the `apiKey`-derived
 * `x-goog-api-key`) into the request headers *before* calling this fetch, so
 * this middleware sees them and rewrites only the two auth-bearing names:
 * additive non-auth custom headers pass through untouched. `Authorization`
 * cannot arrive from `customHeaders` — {@link safeSdkCustomHeaders} strips
 * SDK-managed names — so this client is the sole owner of that header.
 *
 * PHASE0-VERIFY: whether Databricks' Gemini passthrough *tolerates* the
 * stripped `x-goog-api-key` (rather than requiring some non-secret value
 * alongside Bearer) is unverified — no workspace credentials were available.
 * If it turns out to be required, send an explicit placeholder here instead
 * of deleting the header.
 */
export function createBearerAuthFetch(authToken: string): FetchFunction {
	return (input, init) => {
		const headers = new Headers(init?.headers);
		headers.delete("x-goog-api-key");
		headers.set("Authorization", `Bearer ${authToken}`);
		// Read `globalThis.fetch` per call so test doubles installed after
		// construction are honored.
		return globalThis.fetch(input, { ...init, headers });
	};
}

// ---------------------------------------------------------------------------
// Outbound history sanitizer
// ---------------------------------------------------------------------------

/** Read a part's `providerOptions.google` bag, if any. */
function googlePartOptions(part: unknown): Record<string, unknown> | undefined {
	if (part === null || typeof part !== "object" || !("providerOptions" in part)) return undefined;
	const providerOptions = (part as { providerOptions?: Record<string, unknown> }).providerOptions;
	const google = providerOptions?.google;
	return google !== null && typeof google === "object"
		? (google as Record<string, unknown>)
		: undefined;
}

/**
 * Drop reasoning parts that carry no `google.thoughtSignature`.
 *
 * The generateContent converter turns assistant reasoning into a
 * `{ text, thought: true, thoughtSignature }` part, reading the signature
 * from `providerOptions.google.thoughtSignature`. Unsigned thoughts (from
 * another provider, a legacy format, or the Interactions client's
 * `google.signature` representation) are not valid here, so they are removed.
 *
 * Tool-call parts are preserved verbatim, signature metadata included:
 * Gemini 3 validates `thoughtSignature` on replayed `functionCall` parts, and
 * dropping it makes the SDK fall back to the
 * `skip_thought_signature_validator` sentinel — or the request fail outright.
 *
 * This is deliberately *not* the Interactions client's
 * `filterUnsignedReasoning`, which keys on `google.signature`: applied here
 * it would discard every valid generateContent thought.
 */
export function sanitizeGenerateContentHistory(messages: readonly ModelMessage[]): ModelMessage[] {
	return messages
		.map((msg) => {
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;

			const kept = msg.content.filter((part) => {
				if (part.type !== "reasoning") return true;
				const signature = googlePartOptions(part)?.thoughtSignature;
				return typeof signature === "string" && signature !== "";
			});

			if (kept.length === msg.content.length) return msg;
			if (kept.length === 0) return null;
			return { ...msg, content: kept };
		})
		.filter((msg): msg is ModelMessage => msg !== null);
}

// ---------------------------------------------------------------------------
// Thinking wire mapping
// ---------------------------------------------------------------------------

/**
 * The subset of `thinkingConfig` this client emits.
 *
 * Declared as a type alias (not an interface) so it keeps the implicit index
 * signature the AI SDK's `providerOptions` (`JSONObject`) requires.
 */
type ThinkingConfig = {
	thinkingBudget?: number;
	thinkingLevel?: string;
	includeThoughts?: boolean;
};

/** `providerOptions.google` as this client builds it. */
type GenerateContentGoogleOptions = {
	thinkingConfig?: ThinkingConfig;
};

function isBudgetEffort(effort: string): effort is "low" | "medium" | "high" {
	return effort === "low" || effort === "medium" || effort === "high";
}

/** Pick a wire level from the variant's supported set, clamping the rest. */
function clampLevel(effort: string, levels: readonly string[]): string | undefined {
	if (levels.includes(effort)) return effort;
	if (levels.includes(FALLBACK_EFFORT)) return FALLBACK_EFFORT;
	return levels[0];
}

/**
 * Build `providerOptions.google` for a `generateContent` request.
 *
 * Mapping, driven entirely by the variant profile:
 * - `control: "budget"` — `low`/`medium`/`high` map to the profile's budget
 *   for that effort; `"off"` maps to `thinkingBudget: 0` when the variant can
 *   disable thinking (2.5 Flash / Flash-Lite) and omits `thinkingConfig`
 *   entirely when it cannot (2.5 Pro); unrecognized values clamp to `medium`.
 * - `control: "level"` — the effort is sent as `thinkingLevel` when the
 *   variant supports it, otherwise clamped; `"off"` is not representable, so
 *   `thinkingConfig` is omitted.
 * - An absent effort leaves the budget/level to the model default.
 *
 * `includeThoughts: true` rides along whenever thinking is on, so the
 * response carries thought summaries.
 */
export function buildGenerateContentOptions(params: {
	thinkingEffort: string | undefined;
	profile: GeminiGenerateContentProfile;
}): { google: GenerateContentGoogleOptions } {
	const { thinkingEffort, profile } = params;
	const thinking = profile.thinking;

	if (thinkingEffort === EFFORT_OFF) {
		// Representable only as a zero budget, and only where the variant
		// allows thinking to be disabled at all.
		return thinking.control === "budget" && thinking.canDisable
			? { google: { thinkingConfig: { thinkingBudget: 0 } } }
			: { google: {} };
	}

	const config: ThinkingConfig = { includeThoughts: true };

	if (thinking.control === "budget") {
		if (thinkingEffort !== undefined) {
			const effort = isBudgetEffort(thinkingEffort) ? thinkingEffort : FALLBACK_EFFORT;
			config.thinkingBudget = thinking.budgets[effort];
		}
	} else if (thinkingEffort !== undefined) {
		const level = clampLevel(thinkingEffort, thinking.levels);
		if (level !== undefined) config.thinkingLevel = level;
	}

	return { google: { thinkingConfig: config } };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GeminiGenerateContentClient implements ModelClient {
	private readonly auth: GeminiGenerateContentAuth;
	private readonly baseURL?: string;
	private readonly customHeaders?: Record<string, string>;
	private readonly logger?: Logger;

	constructor(
		auth: GeminiGenerateContentAuth,
		baseURL?: string,
		customHeaders?: Record<string, string>,
		logger?: Logger,
	) {
		this.auth = auth;
		this.baseURL = baseURL;
		this.customHeaders = customHeaders;
		this.logger = logger;
	}

	async chat(params: ModelClientChatParams): Promise<AsyncIterable<LMStreamPart>> {
		// The variant profile is what makes the thinking mapping possible, and
		// discovery only stamps this route for models whose profile resolves —
		// so a miss here means routing sent us a model we cannot wire.
		const profile = getGeminiGenerateContentProfile(params.model);
		if (!profile) {
			throw new Error(
				`Gemini generateContent routing requires a known model variant; ` +
					`no generateContent profile for model "${params.model}"`,
			);
		}

		// Per-request routing override wins over the constructor value. The URL
		// is trusted as given — bare-host correction happens at the config seam
		// (see base-url.ts), not here.
		const effectiveBaseUrl = params.baseUrl ?? this.baseURL;
		const headers = safeSdkCustomHeaders(this.customHeaders);
		// Bearer mode: the SDK has no `authToken` setting, so a fetch middleware
		// owns `Authorization` and the required `apiKey` becomes a placeholder
		// the middleware strips. API-key mode: the SDK's native scheme, no
		// middleware.
		const authSettings: { apiKey: string; fetch?: FetchFunction } =
			"authToken" in this.auth
				? { apiKey: PLACEHOLDER_API_KEY, fetch: createBearerAuthFetch(this.auth.authToken) }
				: { apiKey: this.auth.apiKey };
		const provider = createGoogleGenerativeAI({
			...authSettings,
			...(effectiveBaseUrl && { baseURL: effectiveBaseUrl }),
			// Custom headers ride on `settings.headers` in both auth modes; the
			// SDK merges them into the request before the middleware sees it.
			...(headers && { headers }),
		});

		// Default (chat) model — `{baseURL}/models/{model}:generateContent`.
		const model = provider(params.model);

		const messages = sanitizeGenerateContentHistory(params.messages);
		const providerOptions = buildGenerateContentOptions({
			thinkingEffort: params.thinkingEffort,
			profile,
		});

		this.logger?.debug(
			"[GeminiGenerateContentClient] generateContent request",
			JSON.stringify({
				model: params.model,
				variant: profile.variant,
				thinkingControl: profile.thinking.control,
				totalMessages: params.messages.length,
				requestMessageCount: messages.length,
			}),
		);

		// Create abort controller with cleanup to prevent EventEmitter memory leaks
		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		try {
			const result = streamText({
				allowSystemInMessages: params.allowSystemInMessages,
				model,
				messages,
				system: params.systemPrompt,
				maxOutputTokens: params.maxOutputTokens,
				tools: params.tools,
				toolChoice: params.tools ? ("auto" as const) : undefined,
				abortSignal: abortController.signal,
				providerOptions,
				onStepFinish: createStepLogger(params.stepLoggers || [], "gemini", params.model),
			});
			return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
		} catch (error) {
			cleanup();
			throw error;
		}
	}
}
