/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Google Vertex AI Client
 *
 * Implements ModelClient interface for Google Vertex AI models.
 * Supports both Google Gemini models and Anthropic Claude partner models
 * through a single provider, routing to the appropriate AI SDK based on model ID.
 */

import { createVertex } from "@ai-sdk/google-vertex";
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { streamText } from "ai";

import { safeSdkCustomHeaders } from "../custom-headers";
import {
	type GoogleVertexCredentialSource,
	googleVertexAuthOptions,
} from "../google-vertex-credentials";
import { sanitizeToolCallIdsForAnthropic } from "../tool-call-ids";
import type { LMStreamPart, Logger, Protocol } from "../types";
import { normalizeProtocol } from "../types";
import { anthropicRequestOptions } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
	experimentalStructuredOutput,
	rejectUnenforceableResponseFormat,
} from "./ai-sdk-helpers";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";
import { withRawHttpLogging } from "./raw-http-logging";

/**
 * Check if a Vertex model ID refers to an Anthropic partner model.
 * Matches IDs like "claude-*", "anthropic/*", "publishers/anthropic/*".
 */
export function isVertexAnthropicModel(modelId: string): boolean {
	return /(?:^|[/.])(?:anthropic|claude)/.test(modelId);
}

/**
 * Determine the effective location for a model request.
 * Anthropic models and preview models are routed to the global endpoint
 * for broader availability. All other models use the configured location.
 */
export function getEffectiveLocation(modelId: string, configuredLocation: string): string {
	if (isVertexAnthropicModel(modelId)) return "global";
	if (/-preview(-\d+)?$/.test(modelId)) return "global";
	return configuredLocation;
}

export interface GoogleVertexClientConfig {
	project: string;
	location: string;
	/** The credential requests authenticate with, from `resolveGoogleVertexCredentialSource`. */
	credentialSource: GoogleVertexCredentialSource;
	/** Additive request headers (the product User-Agent); the SDK appends its own tokens. */
	customHeaders?: Record<string, string>;
}

export class GoogleVertexClient implements ModelClient {
	private readonly config: GoogleVertexClientConfig;
	private readonly logger?: Logger;

	constructor(config: GoogleVertexClientConfig, logger?: Logger) {
		this.config = config;
		this.logger = logger;
	}

	async chat(params: ModelClientChatParams): Promise<AsyncIterable<LMStreamPart>> {
		const normalizedProtocol = normalizeProtocol(params.protocol);
		if (
			normalizedProtocol &&
			normalizedProtocol !== "anthropic-messages" &&
			normalizedProtocol !== "google-generative"
		) {
			throw new Error(`Unsupported protocol for Google Vertex: ${normalizedProtocol}`);
		}

		const model = this.createModel(params.model, normalizedProtocol, params.metadata?.sessionId);

		// Create abort controller with cleanup to prevent EventEmitter memory leaks
		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		// For Anthropic models on Vertex, pass thinking config via providerOptions.
		// The createVertexAnthropic provider uses AnthropicMessagesLanguageModel internally,
		// so it accepts the same `anthropic` provider options as the direct Anthropic provider.
		// Note: Gemini thinking on Vertex requires `providerOptions.vertex` (not `google`),
		// but the Vertex provider does not yet expose thinkingEffortLevels for Gemini models,
		// so that path is not wired up here.
		const isAnthropic = normalizedProtocol
			? normalizedProtocol === "anthropic-messages"
			: isVertexAnthropicModel(params.model);

		const { providerOptions, headers: requestHeaders } = isAnthropic
			? anthropicRequestOptions({
					effort: params.thinkingEffort,
					transport: "vertex",
					blockBinding: params.thinkingBlockBinding,
					clientOptions: {},
				})
			: { providerOptions: undefined, headers: undefined };

		// The Anthropic Messages wire validates tool_use.id against
		// `^[a-zA-Z0-9_-]+$`; sanitize outbound IDs on that route only.
		const messagesToSend = isAnthropic
			? sanitizeToolCallIdsForAnthropic(params.messages, this.logger)
			: params.messages;

		// Stream the response
		const result = streamText({
			allowSystemInMessages: params.allowSystemInMessages,
			model,
			messages: messagesToSend,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens || 4096,
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			providerOptions,
			headers: requestHeaders,
			experimental_output: experimentalStructuredOutput(params.responseSchema),
			// Capture raw JSON on each step finish
			onStepFinish: createStepLogger(params.stepLoggers || [], "google-vertex", params.model),
		});
		await rejectUnenforceableResponseFormat(result, params.responseSchema, cleanup);

		// Convert to platform-agnostic format with cleanup on completion
		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}

	/**
	 * Route to appropriate AI SDK provider by model family.
	 * - Anthropic models -> createVertexAnthropic (native Anthropic API through Vertex)
	 * - Gemini models -> createVertex (Google Generative AI through Vertex)
	 *
	 * When an explicit `protocol` is provided, it takes precedence over both
	 * the model-ID heuristic for SDK selection AND the location heuristic:
	 * `"anthropic-messages"` routes to global (matching recognized Anthropic
	 * partner models), even if the model ID doesn't match the
	 * `isVertexAnthropicModel()` pattern.
	 */
	private createModel(
		modelId: string,
		protocol: Protocol | undefined,
		session: string | undefined,
	): LanguageModelV3 {
		const googleAuthOptions = googleVertexAuthOptions(this.config.credentialSource);

		const useAnthropicApi = protocol
			? protocol === "anthropic-messages"
			: isVertexAnthropicModel(modelId);

		// Location: explicit Anthropic protocol → global (same as recognized
		// partner models), otherwise fall through to the model-ID heuristic.
		const location =
			useAnthropicApi && protocol === "anthropic-messages"
				? "global"
				: getEffectiveLocation(modelId, this.config.location);

		const headers = safeSdkCustomHeaders(this.config.customHeaders);
		const loggedFetch = withRawHttpLogging(undefined, {
			provider: "google-vertex",
			model: modelId,
			session,
		});

		if (useAnthropicApi) {
			return createVertexAnthropic({
				project: this.config.project,
				location,
				googleAuthOptions,
				headers,
				...(loggedFetch && { fetch: loggedFetch }),
			})(modelId);
		}

		return createVertex({
			project: this.config.project,
			location,
			googleAuthOptions,
			headers,
			...(loggedFetch && { fetch: loggedFetch }),
		})(modelId);
	}
}
