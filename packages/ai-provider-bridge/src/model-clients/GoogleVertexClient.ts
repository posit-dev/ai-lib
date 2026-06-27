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
import { OAuth2Client } from "google-auth-library";

import type { LMStreamPart, Protocol } from "../types";
import { normalizeProtocol } from "../types";
import { isThinkingEnabled } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";

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
	/**
	 * Pre-fetched OAuth access token from a credential broker (e.g. Positron auth ext).
	 * When set, the Vertex SDK uses this token directly instead of resolving ADC.
	 */
	accessToken?: string;
}

export class GoogleVertexClient implements ModelClient {
	private readonly config: GoogleVertexClientConfig;

	constructor(config: GoogleVertexClientConfig) {
		this.config = config;
	}

	private googleAuthOptions(): { authClient: OAuth2Client } | undefined {
		if (!this.config.accessToken) return undefined;
		const authClient = new OAuth2Client();
		authClient.setCredentials({ access_token: this.config.accessToken });
		return { authClient };
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

		const model = this.createModel(params.model, normalizedProtocol);

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

		const providerOptions =
			isThinkingEnabled(params.thinkingEffort) && isAnthropic
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
		const result = streamText({
			model,
			messages: params.messages,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens || 4096,
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			providerOptions,
			// Capture raw JSON on each step finish
			onStepFinish: createStepLogger(params.stepLoggers || [], "google-vertex", params.model),
		});

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
	private createModel(modelId: string, protocol?: Protocol): LanguageModelV3 {
		const googleAuthOptions = this.googleAuthOptions();

		const useAnthropicApi = protocol
			? protocol === "anthropic-messages"
			: isVertexAnthropicModel(modelId);

		// Location: explicit Anthropic protocol → global (same as recognized
		// partner models), otherwise fall through to the model-ID heuristic.
		const location =
			useAnthropicApi && protocol === "anthropic-messages"
				? "global"
				: getEffectiveLocation(modelId, this.config.location);

		if (useAnthropicApi) {
			return createVertexAnthropic({
				project: this.config.project,
				location,
				googleAuthOptions,
			})(modelId);
		}

		return createVertex({
			project: this.config.project,
			location,
			googleAuthOptions,
		})(modelId);
	}
}
