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

/**
 * How the credential's token authenticates with Snowflake Cortex:
 * - `"bearer"`: an API/PAT token sent as `Authorization: Bearer` (or `x-api-key`).
 * - `"session"`: a session token (external-browser SSO) sent as
 *   `Authorization: Snowflake Token="..."`.
 */
export type SnowflakeAuthScheme = "bearer" | "session";

type FetchFn = (url: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>;

/**
 * Wrap a fetch so every request authenticates with a Snowflake **session token**
 * (`Authorization: Snowflake Token="..."`), replacing any Bearer/x-api-key
 * header the SDK set.
 */
function createSnowflakeSessionFetch(sessionToken: string, delegate: FetchFn): FetchFn {
	return async (url, init) => {
		const headers = new Headers(init?.headers);
		headers.delete("x-api-key");
		headers.set("Authorization", `Snowflake Token="${sessionToken}"`);
		return delegate(url, { ...init, headers });
	};
}

export class SnowflakeClient implements ModelClient {
	private readonly token: string;
	private readonly baseUrl: string;
	private readonly authScheme: SnowflakeAuthScheme;
	private readonly customHeaders?: Record<string, string>;

	constructor(
		token: string,
		baseUrl: string,
		authScheme: SnowflakeAuthScheme,
		customHeaders?: Record<string, string>,
	) {
		this.token = token;
		this.baseUrl = baseUrl;
		this.authScheme = authScheme;
		this.customHeaders = customHeaders;
	}

	/** True when the token is a session token needing the `Snowflake Token=` scheme. */
	private get isSessionAuth(): boolean {
		return this.authScheme === "session";
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
		const provider = this.isSessionAuth
			? createAnthropic({
					// Auth is applied by the session fetch wrapper; this placeholder key
					// just satisfies the SDK (its x-api-key header is stripped there).
					apiKey: "session-auth",
					baseURL: baseUrl,
					fetch: createSnowflakeSessionFetch(this.token, globalThis.fetch),
					...(headers && { headers }),
				})
			: createAnthropic({
					authToken: this.token,
					baseURL: baseUrl,
					...(headers && { headers }),
				});
		const model = provider(params.model);

		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		const useThinking = isThinkingEnabled(params.thinkingEffort);
		// Haiku 4.5 rejects the `eager_input_streaming` field that @ai-sdk/anthropic
		// adds to tool specs by default while streaming, returning HTTP 400
		// (tools.0.custom.eager_input_streaming: Extra inputs are not permitted).
		// Scope the opt-out to Haiku 4.5, matching the Bedrock fix (posit-dev/ai-provider-bridge#14).
		const disableEagerToolStreaming = params.model.includes("claude-haiku-4-5");
		const providerOptions =
			useThinking || disableEagerToolStreaming
				? {
						anthropic: {
							...(disableEagerToolStreaming ? { toolStreaming: false } : {}),
							...(useThinking
								? {
										// `display: "summarized"` is required to receive thinking summary text.
										// Opus 4.7+/Fable 5 default to `"omitted"`, which streams thinking blocks
										// with only a signature and no text — so the UI shows no <thinking>.
										thinking: { type: "adaptive", display: "summarized" },
										effort: params.thinkingEffort,
									}
								: {}),
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
		// The compat fetch applies OpenAI-spec fix-ups. For session auth we keep a
		// non-empty apiKey so it does NOT strip the Authorization header, and wrap
		// it so the outer fetch installs the `Snowflake Token=` header last.
		const compatFetch = this.isSessionAuth
			? createOpenAICompatibleFetch("Snowflake", "session-auth", this.customHeaders)
			: createOpenAICompatibleFetch("Snowflake", this.token, this.customHeaders);
		const provider = createOpenAI({
			apiKey: this.token || "sk-placeholder",
			baseURL: baseUrl,
			fetch: this.isSessionAuth
				? createSnowflakeSessionFetch(this.token, compatFetch)
				: compatFetch,
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
