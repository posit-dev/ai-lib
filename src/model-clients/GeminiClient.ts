/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Google Gemini API Client — Interactions API (stateful)
 *
 * All Gemini chat traffic routes through the Interactions API
 * (`POST /v1beta/interactions`). Stateful mode (`store: true`) lets the
 * server retain context; after the first turn we send only the delta
 * (system + messages after the linked assistant response) plus
 * `previousInteractionId`.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { APICallError } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { streamText } from "ai";

import { safeSdkCustomHeaders } from "../custom-headers";
import { getGeminiInteractionsProfile } from "../model-capabilities/gemini-helpers";
import type { StepLogger } from "../StepLogger";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../types";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient } from "./ModelClient";

// ---------------------------------------------------------------------------
// Interaction ID extraction (compaction-aware)
// ---------------------------------------------------------------------------

/** Marker set by Core on compaction-summary messages. */
const COMPACTION_BOUNDARY_KEY = "isCompactionSummary";

/**
 * Result of extracting the previous interaction ID from message history.
 *
 * - `previousInteractionId` is the most recent `interactionId` on the active
 *   path, or `null` if none exists (first turn, post-compaction, or
 *   cross-provider switch).
 * - `deltaStartIndex` is the index of the first message to include when
 *   sending the delta (the message after the linked assistant response), or
 *   `0` when sending full history.
 */
interface ExtractionResult {
	previousInteractionId: string | null;
	deltaStartIndex: number;
}

/**
 * Extract the most recent `interactionId` from the message history.
 *
 * Walks backwards through the messages looking for assistant messages with
 * `google.interactionId` in either:
 * 1. Message-level `providerOptions.providerMetadata.google.interactionId`
 * 2. Part-level `part.providerOptions.google.interactionId` (reasoning/tool-call parts)
 *
 * A compaction-summary message (marked with `positai.isCompactionSummary`)
 * acts as a hard boundary — the helper returns "no prior id" there, so the
 * first post-compaction request starts a fresh interaction.
 */
export function extractPreviousInteractionId(messages: readonly ModelMessage[]): ExtractionResult {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;

		// Check for compaction boundary — stop here, return no prior id
		const positai = (msg.providerOptions?.providerMetadata as Record<string, unknown> | undefined)
			?.positai as Record<string, unknown> | undefined;
		if (positai?.[COMPACTION_BOUNDARY_KEY] === true) {
			return { previousInteractionId: null, deltaStartIndex: 0 };
		}

		// Check message-level interactionId
		const google = (msg.providerOptions?.providerMetadata as Record<string, unknown> | undefined)
			?.google as Record<string, unknown> | undefined;
		if (google?.interactionId && typeof google.interactionId === "string") {
			return { previousInteractionId: google.interactionId, deltaStartIndex: i + 1 };
		}

		// Check part-level interactionId (reasoning/tool-call parts)
		if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if ("providerOptions" in part && part.providerOptions) {
					const partGoogle = (part.providerOptions as Record<string, unknown>)?.google as
						| Record<string, unknown>
						| undefined;
					if (partGoogle?.interactionId && typeof partGoogle.interactionId === "string") {
						return {
							previousInteractionId: partGoogle.interactionId,
							deltaStartIndex: i + 1,
						};
					}
				}
			}
		}
	}

	return { previousInteractionId: null, deltaStartIndex: 0 };
}

// ---------------------------------------------------------------------------
// Outbound signature filter
// ---------------------------------------------------------------------------

/**
 * Drop reasoning parts that lack `google.signature` from a message array.
 *
 * Google rejects unsigned thought steps in the Interactions API. When
 * sending initial-interaction history (no `previousInteractionId`), the
 * history may contain reasoning from other providers or legacy formats
 * that lack Google signatures.
 *
 * Tool-call parts are retained as-is — Google does not sign function calls.
 */
export function filterUnsignedReasoning(messages: readonly ModelMessage[]): ModelMessage[] {
	return messages
		.map((msg) => {
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
				return msg;
			}

			const filtered = msg.content.filter((part) => {
				if (part.type !== "reasoning") return true;
				// Reasoning parts have providerOptions with provider-specific metadata
				const pOpts = (part as { providerOptions?: Record<string, unknown> }).providerOptions;
				const google = pOpts?.google as Record<string, unknown> | undefined;
				return google?.signature !== undefined;
			});

			// If all parts were retained, return the original message
			if (filtered.length === msg.content.length) return msg;

			// If all parts were removed, drop the message entirely
			if (filtered.length === 0) return null;

			return { ...msg, content: filtered };
		})
		.filter((msg): msg is ModelMessage => msg !== null);
}

// ---------------------------------------------------------------------------
// Interactions options builder
// ---------------------------------------------------------------------------

/**
 * Build `providerOptions.google` for a Gemini Interactions API request.
 *
 * - `store: true` always (stateful mode)
 * - `previousInteractionId` when chaining
 * - `thinkingLevel` validated against the per-model profile
 * - `thinkingSummaries: "auto"` when supported
 *
 * If `thinkingEffort` is `"off"` or `undefined`, `thinkingLevel` is omitted
 * entirely (the model uses its default). Note: on default-on models like
 * 2.5 Flash this means thinking stays active — the product-level levels
 * should not offer "off" for those models.
 */
export function buildInteractionsOptions(params: {
	thinkingEffort: string | undefined;
	modelId: string;
	previousInteractionId: string | null;
}): { google: Record<string, string | number | boolean | null> } {
	const { thinkingEffort, modelId, previousInteractionId } = params;
	const profile = getGeminiInteractionsProfile(modelId);

	const google: Record<string, string | number | boolean | null> = {
		store: true,
	};

	if (previousInteractionId) {
		google.previousInteractionId = previousInteractionId;
	}

	// Resolve thinkingLevel: validate against the per-model profile's valid
	// levels and clamp to "medium" for unrecognised values. "off" and
	// undefined both result in no thinkingLevel being set.
	if (thinkingEffort !== undefined && thinkingEffort !== "off" && profile) {
		const validLevels = profile.thinkingLevels;
		google.thinkingLevel = validLevels.includes(thinkingEffort) ? thinkingEffort : "medium";

		if (profile.supportsSummaries) {
			google.thinkingSummaries = "auto";
		}
	}

	return { google };
}

// ---------------------------------------------------------------------------
// Expired-interaction error classification
// ---------------------------------------------------------------------------

/**
 * Determine whether an error is an expired/invalid interaction ID error.
 *
 * Uses `APICallError`'s structured `statusCode` and `data` fields — NOT
 * the broad `isRetryable` flag (which covers 429/5xx). Requires the error
 * message to specifically mention "interaction" to avoid retrying unrelated
 * bad-request errors (malformed tool schemas, invalid model IDs, etc.).
 */
function isExpiredInteractionError(error: unknown): boolean {
	if (!APICallError.isInstance(error)) return false;
	if (error.statusCode !== 400 && error.statusCode !== 404) return false;

	// Try structured data first (pre-parsed error body from Google API)
	const data = error.data as
		| { error?: { message?: string; status?: string; details?: unknown[] } }
		| undefined;
	const errMessage = data?.error?.message ?? "";
	if (/\binteraction\b/i.test(errMessage)) return true;

	// Fall back to raw response body — require "interaction" to appear
	const body = error.responseBody ?? "";
	return /\binteraction\b/i.test(body);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GeminiClient implements ModelClient {
	private readonly apiKey: string;
	private readonly baseURL?: string;
	private readonly customHeaders?: Record<string, string>;

	constructor(apiKey: string, baseURL?: string, customHeaders?: Record<string, string>) {
		this.apiKey = apiKey;
		this.baseURL = baseURL;
		this.customHeaders = customHeaders;
	}

	async chat(params: {
		model: string;
		messages: ModelMessage[];
		systemPrompt?: string;
		maxOutputTokens?: number;
		tools?: Record<string, AiToolWithJsonSchema>;
		cancellationToken: CancellationToken;
		thinkingEffort?: string;
		metadata?: {
			sessionId?: string;
		};
		stepLoggers?: StepLogger[];
	}): Promise<AsyncIterable<LMStreamPart>> {
		// Create Google Generative AI provider
		const headers = safeSdkCustomHeaders(this.customHeaders);
		const provider = createGoogleGenerativeAI({
			apiKey: this.apiKey,
			...(this.baseURL && { baseURL: this.baseURL }),
			...(headers && { headers }),
		});

		// Always use the Interactions API
		const model = provider.interactions(params.model);

		// Extract previous interaction ID from message history
		const { previousInteractionId, deltaStartIndex } = extractPreviousInteractionId(
			params.messages,
		);

		// Build message payload: delta (if chaining) or full filtered history
		let requestMessages: ModelMessage[];
		if (previousInteractionId) {
			// Chaining: send only messages after the linked assistant response
			requestMessages = params.messages.slice(deltaStartIndex);
		} else {
			// Fresh interaction: send full history with unsigned reasoning filtered out
			requestMessages = filterUnsignedReasoning(params.messages);
		}

		// Build provider options
		const providerOptions = buildInteractionsOptions({
			thinkingEffort: params.thinkingEffort,
			modelId: params.model,
			previousInteractionId,
		});

		// Create abort controller with cleanup to prevent EventEmitter memory leaks
		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		const streamArgs = {
			model,
			messages: requestMessages,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens,
			tools: params.tools,
			toolChoice: params.tools ? ("auto" as const) : undefined,
			abortSignal: abortController.signal,
			providerOptions,
			onStepFinish: createStepLogger(params.stepLoggers || [], "gemini", params.model),
		};

		// Attempt to stream. If we get an expired-interaction error on the
		// first chunk, retry once with a fresh interaction (no chaining).
		try {
			const result = streamText(streamArgs);
			return convertAiSdkStreamToPlatform(
				this.withExpiredIdRetry(result.fullStream, {
					...streamArgs,
					messages: params.messages,
					cleanup,
				}),
				cleanup,
			);
		} catch (error) {
			cleanup();
			throw error;
		}
	}

	/**
	 * Wrap a stream to retry exactly once on expired-interaction errors.
	 *
	 * The invalid-interaction error surfaces at stream start (before content),
	 * so there's no partial first-attempt output to worry about.
	 *
	 * On retry:
	 * - Resend the full signature-filtered local history
	 * - No `previousInteractionId` (fresh interaction)
	 * - The replacement `interactionId` persists via the normal finish-metadata path
	 */
	private async *withExpiredIdRetry(
		stream: AsyncIterable<LMStreamPart>,
		retryContext: {
			model: ReturnType<ReturnType<typeof createGoogleGenerativeAI>["interactions"]>;
			messages: ModelMessage[];
			system?: string;
			maxOutputTokens?: number;
			tools?: Record<string, AiToolWithJsonSchema>;
			toolChoice?: "auto";
			abortSignal: AbortSignal;
			providerOptions: { google: Record<string, string | number | boolean | null> };
			onStepFinish: ReturnType<typeof createStepLogger>;
			cleanup: () => void;
		},
	): AsyncIterable<LMStreamPart> {
		try {
			for await (const chunk of stream) {
				yield chunk;
			}
		} catch (error) {
			// Only retry expired-interaction errors with an active previousInteractionId
			if (
				!isExpiredInteractionError(error) ||
				!retryContext.providerOptions.google.previousInteractionId
			) {
				throw error;
			}

			// Retry with fresh interaction: full filtered history, no chaining
			const { previousInteractionId: _, ...rest } = retryContext.providerOptions.google;
			const freshOptions = {
				google: rest,
			};
			const freshMessages = filterUnsignedReasoning(retryContext.messages);

			const retryResult = streamText({
				model: retryContext.model,
				messages: freshMessages,
				system: retryContext.system,
				maxOutputTokens: retryContext.maxOutputTokens,
				tools: retryContext.tools,
				toolChoice: retryContext.toolChoice,
				abortSignal: retryContext.abortSignal,
				providerOptions: freshOptions,
				onStepFinish: retryContext.onStepFinish,
			});

			for await (const chunk of retryResult.fullStream) {
				yield chunk;
			}
		}
	}
}
