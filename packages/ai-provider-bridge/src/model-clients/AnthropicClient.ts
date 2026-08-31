/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Anthropic API Client
 *
 * Implements ModelClient interface for Anthropic models
 */

import { createAnthropic } from "@ai-sdk/anthropic";

import { safeSdkCustomHeaders } from "../custom-headers";
import { streamTextAnthropicWire } from "../tool-call-ids";
import type { LMStreamPart, Logger } from "../types";
import { isThinkingEnabled } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
	suppressAiSdkDefaultErrorLogging,
} from "./ai-sdk-helpers";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";
import { withRawHttpLogging } from "./raw-http-logging";

/** Maximum number of web searches per request */
const WEB_SEARCH_MAX_USES = 5;

/**
 * How this client authenticates to the Anthropic Messages API.
 *
 * The two schemes are mutually exclusive on the wire: `apiKey` sends
 * `x-api-key`, `authToken` sends `Authorization: Bearer` (used by gateways
 * that front the Messages API, e.g. Databricks' native passthrough). The SDK
 * owns both header schemes and rejects being given both at once, so the
 * discriminated union keeps that impossible by construction.
 */
export type AnthropicClientAuth = { apiKey: string } | { authToken: string };

/** Spread the auth config into exactly one `createAnthropic` credential option. */
function anthropicAuthSettings(
	auth: AnthropicClientAuth,
): { apiKey: string } | { authToken: string } {
	return "apiKey" in auth ? { apiKey: auth.apiKey } : { authToken: auth.authToken };
}

export class AnthropicClient implements ModelClient {
	private readonly auth: AnthropicClientAuth;
	private readonly baseURL?: string;
	private readonly customHeaders?: Record<string, string>;
	private readonly logger?: Logger;

	constructor(
		auth: AnthropicClientAuth,
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
		// Per-request routing override wins over the constructor value. The URL is
		// trusted as given — bare-host correction happens at the config seam
		// (see base-url.ts), not here.
		const effectiveBaseUrl = params.baseUrl ?? this.baseURL;
		const headers = safeSdkCustomHeaders(this.customHeaders);
		const loggedFetch = withRawHttpLogging(undefined, {
			provider: "anthropic",
			model: params.model,
		});
		const provider = createAnthropic({
			...anthropicAuthSettings(this.auth),
			...(effectiveBaseUrl && { baseURL: effectiveBaseUrl }),
			...(loggedFetch && { fetch: loggedFetch }),
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

		// Stream the response
		const result = streamTextAnthropicWire(
			{
				allowSystemInMessages: params.allowSystemInMessages,
				model,
				messages: params.messages,
				system: params.systemPrompt,
				maxOutputTokens: params.maxOutputTokens, // Respect caller's value
				tools,
				toolChoice: tools ? "auto" : undefined,
				abortSignal: abortController.signal,
				providerOptions,
				onError: suppressAiSdkDefaultErrorLogging,
				// Capture raw JSON on each step finish
				onStepFinish: createStepLogger(params.stepLoggers || [], "anthropic", params.model),
			},
			this.logger,
		);

		// Convert to platform-agnostic format with cleanup on completion
		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}
}
