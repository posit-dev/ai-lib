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
import { streamText } from "ai";

import { safeSdkCustomHeaders } from "../custom-headers";
import type { LMStreamPart } from "../types";
import { normalizeProtocol } from "../types";
import { isClaudeModel, isThinkingEnabled } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";
import { createOpenAICompatibleFetch } from "./openai-compat-fetch";

export class SnowflakeClient implements ModelClient {
	private readonly bearerToken: string;
	private readonly baseUrl: string;
	private readonly customHeaders?: Record<string, string>;

	constructor(bearerToken: string, baseUrl: string, customHeaders?: Record<string, string>) {
		this.bearerToken = bearerToken;
		this.baseUrl = baseUrl;
		this.customHeaders = customHeaders;
	}

	async chat(params: ModelClientChatParams): Promise<AsyncIterable<LMStreamPart>> {
		const effectiveBaseUrl = params.baseUrl ?? this.baseUrl;

		// When an explicit protocol is provided, normalize and route on it.
		if (params.protocol) {
			const normalizedProtocol = normalizeProtocol(params.protocol);
			switch (normalizedProtocol) {
				case "anthropic-messages":
					return this.chatAnthropic(params, effectiveBaseUrl);
				case "openai-chat":
					return this.chatOpenAI(params, effectiveBaseUrl);
				default:
					throw new Error(`Unsupported protocol for Snowflake: ${normalizedProtocol}`);
			}
		}

		// Fallback: infer protocol from model ID. Claude models use Anthropic
		// Messages API, all others use OpenAI Chat Completions API.
		if (isClaudeModel(params.model)) {
			return this.chatAnthropic(params, effectiveBaseUrl);
		}
		return this.chatOpenAI(params, effectiveBaseUrl);
	}

	/**
	 * Anthropic Messages API path for Claude models.
	 * Uses `authToken` to send `Authorization: Bearer` (not `x-api-key`).
	 */
	private async chatAnthropic(
		params: ModelClientChatParams,
		baseUrl: string,
	): Promise<AsyncIterable<LMStreamPart>> {
		const headers = safeSdkCustomHeaders(this.customHeaders);
		const provider = createAnthropic({
			authToken: this.bearerToken,
			baseURL: baseUrl,
			...(headers && { headers }),
		});
		const model = provider(params.model);

		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		const providerOptions = isThinkingEnabled(params.thinkingEffort)
			? {
					anthropic: {
						// `display: "summarized"` is required to receive thinking summary text.
						// Opus 4.7+/Fable 5 default to `"omitted"`, which streams thinking blocks
						// with only a signature and no text — so the UI shows no <thinking>.
						thinking: { type: "adaptive", display: "summarized" },
						effort: params.thinkingEffort,
					},
				}
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
	private async chatOpenAI(
		params: ModelClientChatParams,
		baseUrl: string,
	): Promise<AsyncIterable<LMStreamPart>> {
		const provider = createOpenAI({
			apiKey: this.bearerToken || "sk-placeholder",
			baseURL: baseUrl,
			fetch: createOpenAICompatibleFetch("Snowflake", this.bearerToken, this.customHeaders),
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
