/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Snowflake Cortex API Client
 *
 * Implements ModelClient interface for Snowflake Cortex models.
 * Routes internally based on model ID:
 * - Claude models → Anthropic Messages API
 * - All others → OpenAI Chat Completions API
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { streamText } from "ai";

import type { StepLogger } from "../StepLogger";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../types";
import { isClaudeModel, isThinkingEnabled } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient } from "./ModelClient";
import { createOpenAICompatibleFetch } from "./openai-compat-fetch";

export class SnowflakeClient implements ModelClient {
	private readonly bearerToken: string;
	private readonly baseUrl: string;

	constructor(bearerToken: string, baseUrl: string) {
		this.bearerToken = bearerToken;
		this.baseUrl = baseUrl;
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
	}): Promise<AsyncIterable<LMStreamPart>> {
		// Infer protocol from model ID: Claude models use Anthropic Messages API,
		// all others use OpenAI Chat Completions API.
		if (isClaudeModel(params.model)) {
			return this.chatAnthropic(params);
		}
		return this.chatOpenAI(params);
	}

	/**
	 * Anthropic Messages API path for Claude models.
	 * Uses `authToken` to send `Authorization: Bearer` (not `x-api-key`).
	 */
	private async chatAnthropic(params: {
		model: string;
		messages: ModelMessage[];
		systemPrompt?: string;
		maxOutputTokens?: number;
		tools?: Record<string, AiToolWithJsonSchema>;
		cancellationToken: CancellationToken;
		thinkingEffort?: string;
		stepLoggers?: StepLogger[];
	}): Promise<AsyncIterable<LMStreamPart>> {
		const provider = createAnthropic({
			authToken: this.bearerToken,
			baseURL: this.baseUrl,
		});
		const model = provider(params.model);

		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		const providerOptions = isThinkingEnabled(params.thinkingEffort)
			? { anthropic: { thinking: { type: "adaptive" as const }, effort: params.thinkingEffort } }
			: undefined;

		const result = streamText({
			model,
			messages: params.messages,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens,
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			providerOptions,
			onStepFinish: createStepLogger(params.stepLoggers || [], "snowflake-cortex", params.model),
		});

		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}

	/**
	 * OpenAI Chat Completions API path for non-Claude models.
	 * Uses the shared compat fetch wrapper for streaming response fixes.
	 */
	private async chatOpenAI(params: {
		model: string;
		messages: ModelMessage[];
		systemPrompt?: string;
		maxOutputTokens?: number;
		tools?: Record<string, AiToolWithJsonSchema>;
		cancellationToken: CancellationToken;
		thinkingEffort?: string;
		stepLoggers?: StepLogger[];
	}): Promise<AsyncIterable<LMStreamPart>> {
		const provider = createOpenAI({
			apiKey: this.bearerToken || "sk-placeholder",
			baseURL: this.baseUrl,
			fetch: createOpenAICompatibleFetch("Snowflake", this.bearerToken),
		});
		const model = provider.chat(params.model);

		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		const result = streamText({
			model,
			messages: params.messages,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens,
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			...(isThinkingEnabled(params.thinkingEffort) && {
				providerOptions: {
					openai: {
						store: false,
						reasoningEffort: params.thinkingEffort,
						reasoningSummary: "detailed",
					},
				},
			}),
			onStepFinish: createStepLogger(params.stepLoggers || [], "snowflake-cortex", params.model),
		});

		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}
}
