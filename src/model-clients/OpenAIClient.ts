/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenAI API Client
 *
 * Implements ModelClient interface for OpenAI models
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { streamText } from "ai";

import { safeSdkCustomHeaders } from "../custom-headers";
import type { StepLogger } from "../StepLogger";
import {
	hasImagesInToolResults,
	transformToolResultImagesForCompletions,
} from "../tool-result-images";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../types";
import { isThinkingEnabled } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient } from "./ModelClient";

type ApiMode = "completions" | "responses";

export class OpenAIClient implements ModelClient {
	private readonly apiKey?: string;
	private readonly baseURL?: string;
	private readonly apiMode: ApiMode;
	private readonly customFetch?: typeof globalThis.fetch;
	private readonly customHeaders?: Record<string, string>;

	constructor(
		apiKey?: string,
		baseURL?: string,
		apiMode: ApiMode = "completions",
		customFetch?: typeof globalThis.fetch,
		customHeaders?: Record<string, string>,
	) {
		this.apiKey = apiKey;
		this.baseURL = baseURL;
		this.apiMode = apiMode;
		this.customFetch = customFetch;
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
		supportsImages?: boolean;
		metadata?: {
			sessionId?: string;
		};
		stepLoggers?: StepLogger[];
	}): Promise<AsyncIterable<LMStreamPart>> {
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
		const provider = createOpenAI({
			apiKey: isEmptyKey ? "sk-placeholder" : this.apiKey,
			...(this.baseURL && { baseURL: this.baseURL }),
			...(fetchFn && { fetch: fetchFn }),
			...(headers && { headers }),
		});
		const model =
			this.apiMode === "responses" ? provider.responses(params.model) : provider.chat(params.model);

		// Create abort controller with cleanup to prevent EventEmitter memory leaks
		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		// Transform tool result images for completions API (doesn't support images in tool results)
		let messagesToSend = params.messages;
		if (this.apiMode === "completions" && hasImagesInToolResults(params.messages)) {
			messagesToSend = transformToolResultImagesForCompletions(
				params.messages,
				params.supportsImages ?? false,
			);
		}

		// Stream the response
		const result = streamText({
			model,
			messages: messagesToSend,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens, // Respect caller's value!
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			...(isThinkingEnabled(params.thinkingEffort) && {
				providerOptions: {
					openai: {
						// store: false so the AI SDK requests reasoning.encrypted_content,
						// which is required to send reasoning items back on subsequent turns.
						store: false,
						reasoningEffort: params.thinkingEffort,
						// OpenAI reasoning tokens are hidden; without requesting a
						// summary, no thinking content is visible to the user.
						reasoningSummary: "detailed",
					},
				},
			}),
			// Capture raw JSON on each step finish
			onStepFinish: createStepLogger(params.stepLoggers || [], "openai", params.model),
		});

		// Convert to platform-agnostic format with cleanup on completion
		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}
}
