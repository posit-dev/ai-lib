/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenAI API Client
 *
 * Implements ModelClient interface for OpenAI models
 */

import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

import { safeSdkCustomHeaders } from "../custom-headers";
import {
	hasImagesInToolResults,
	transformToolResultImagesForCompletions,
} from "../tool-result-images";
import type { LMStreamPart } from "../types";
import { normalizeProtocol } from "../types";
import { isThinkingEnabled } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
	suppressAiSdkDefaultErrorLogging,
} from "./ai-sdk-helpers";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";
import { prepareExplicitOpenAIRequest } from "./openai-prompt-caching";
import { withRawHttpLogging } from "./raw-http-logging";

export type OpenAIApiMode = "completions" | "responses";

const EXPLICIT_PROMPT_CACHE_OPTIONS: { mode: "explicit"; ttl: "30m" } = {
	mode: "explicit",
	ttl: "30m",
};

export interface OpenAIClientConfig {
	apiMode: OpenAIApiMode;
	apiKey?: string;
	baseUrl?: string;
	customFetch?: typeof globalThis.fetch;
	customHeaders?: Record<string, string>;
}

export class OpenAIClient implements ModelClient {
	private readonly apiKey?: string;
	private readonly baseURL?: string;
	private readonly apiMode: OpenAIApiMode;
	private readonly customFetch?: typeof globalThis.fetch;
	private readonly customHeaders?: Record<string, string>;

	constructor(config: OpenAIClientConfig) {
		this.apiKey = config.apiKey;
		this.baseURL = config.baseUrl;
		this.apiMode = config.apiMode;
		this.customFetch = config.customFetch;
		this.customHeaders = config.customHeaders;
	}

	async chat(params: ModelClientChatParams): Promise<AsyncIterable<LMStreamPart>> {
		const normalizedProtocol = normalizeProtocol(params.protocol);

		// Determine API mode: explicit protocol → override; absent → constructor default
		let effectiveApiMode: OpenAIApiMode;
		if (normalizedProtocol) {
			if (normalizedProtocol === "openai-chat") {
				effectiveApiMode = "completions";
			} else if (
				normalizedProtocol === "openai-responses" ||
				// Databricks' unified MLflow Responses API speaks the same wire
				// shape; only the base URL differs (see `databricksBaseUrl`).
				normalizedProtocol === "mlflow-responses"
			) {
				effectiveApiMode = "responses";
			} else {
				throw new Error(`Unsupported protocol for OpenAI: ${normalizedProtocol}`);
			}
		} else {
			effectiveApiMode = this.apiMode;
		}

		// Per-request routing override wins over the constructor value. The URL is
		// trusted as given — bare-host correction happens at the config seam
		// (see base-url.ts), not here.
		const effectiveBaseUrl = params.baseUrl ?? this.baseURL;

		// Create OpenAI provider.
		// When apiKey === "" (openai-compatible unauthenticated endpoints), pass a
		// placeholder to prevent the SDK falling back to OPENAI_API_KEY env var, and
		// inject a custom fetch that strips the Authorization header.
		// When a customFetch is provided (e.g., OpenAI-compatible response transforms),
		// use it directly — it handles auth stripping internally if needed.
		const isEmptyKey = this.apiKey === "";
		const fetchFn =
			this.customFetch ??
			(isEmptyKey
				? async (url: string | URL | globalThis.Request, init?: RequestInit) => {
						const headers = new Headers(init?.headers);
						headers.delete("Authorization");
						return globalThis.fetch(url, { ...init, headers });
					}
				: undefined);
		const headers = safeSdkCustomHeaders(this.customHeaders);
		const loggedFetch = withRawHttpLogging(fetchFn, { provider: "openai", model: params.model });
		const provider = createOpenAI({
			apiKey: isEmptyKey ? "sk-placeholder" : this.apiKey,
			...(effectiveBaseUrl && { baseURL: effectiveBaseUrl }),
			...((loggedFetch ?? fetchFn) && { fetch: loggedFetch ?? fetchFn }),
			...(headers && { headers }),
		});
		const model =
			effectiveApiMode === "responses"
				? provider.responses(params.model)
				: provider.chat(params.model);

		// Create abort controller with cleanup to prevent EventEmitter memory leaks
		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		// Transform tool result images for completions API (doesn't support images in tool results)
		let messagesToSend = params.messages;
		if (effectiveApiMode === "completions" && hasImagesInToolResults(params.messages)) {
			messagesToSend = transformToolResultImagesForCompletions(
				params.messages,
				params.supportsImages ?? false,
			);
		}

		const usesExplicitPromptCaching = params.usesExplicitPromptCaching === true;
		const prepared = prepareExplicitOpenAIRequest(messagesToSend, {
			enabled: usesExplicitPromptCaching,
			apiMode: effectiveApiMode,
			sessionId: params.metadata?.sessionId,
		});
		messagesToSend = prepared.messages;
		const promptCacheKey = prepared.promptCacheKey;

		const useThinking = isThinkingEnabled(params.thinkingEffort);
		const providerOptions =
			usesExplicitPromptCaching || useThinking
				? {
						openai: {
							...(usesExplicitPromptCaching
								? {
										promptCacheOptions: EXPLICIT_PROMPT_CACHE_OPTIONS,
										...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
									}
								: {}),
							...(useThinking
								? {
										// store: false requests encrypted reasoning content so it can be
										// sent back on subsequent stateless turns.
										store: false,
										reasoningEffort: params.thinkingEffort,
										reasoningSummary: "detailed",
									}
								: {}),
						},
					}
				: undefined;

		// Stream the response
		const result = streamText({
			allowSystemInMessages: params.allowSystemInMessages,
			model,
			messages: messagesToSend,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens, // Respect caller's value!
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			providerOptions,
			onError: suppressAiSdkDefaultErrorLogging,
			// Capture raw JSON on each step finish
			onStepFinish: createStepLogger(params.stepLoggers || [], "openai", params.model),
		});

		// Convert to platform-agnostic format with cleanup on completion
		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}
}
