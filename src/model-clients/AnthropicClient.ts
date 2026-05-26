/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Anthropic API Client
 *
 * Implements ModelClient interface for Anthropic models
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelMessage } from "ai";
import { streamText } from "ai";

import { safeSdkCustomHeaders } from "../custom-headers";
import type { StepLogger } from "../StepLogger";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../types";
import { isThinkingEnabled } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient } from "./ModelClient";

/** Maximum number of web searches per request */
const WEB_SEARCH_MAX_USES = 5;

export class AnthropicClient implements ModelClient {
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
			conversationId?: string;
		};
		stepLoggers?: StepLogger[];
		webSearchEnabled?: boolean;
	}): Promise<AsyncIterable<LMStreamPart>> {
		const headers = safeSdkCustomHeaders(this.customHeaders);
		const provider = createAnthropic({
			apiKey: this.apiKey,
			...(this.baseURL && { baseURL: this.baseURL }),
			...(headers && { headers }),
		});
		const model = provider(params.model);

		// Create abort controller with cleanup to prevent EventEmitter memory leaks
		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		// Build tools - add web search if explicitly enabled per-request
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let tools: Record<string, any> | undefined = params.tools;
		if (params.webSearchEnabled) {
			const webSearchTool = provider.tools.webSearch_20250305({
				maxUses: WEB_SEARCH_MAX_USES,
			});
			tools = { ...tools, web_search: webSearchTool };
		}

		const providerOptions = isThinkingEnabled(params.thinkingEffort)
			? { anthropic: { thinking: { type: "adaptive" as const }, effort: params.thinkingEffort } }
			: undefined;

		// Stream the response
		const result = streamText({
			model,
			messages: params.messages,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens, // Respect caller's value
			tools,
			toolChoice: tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			providerOptions,
			// Capture raw JSON on each step finish
			onStepFinish: createStepLogger(params.stepLoggers || [], "anthropic", params.model),
		});

		// Convert to platform-agnostic format with cleanup on completion
		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}
}
