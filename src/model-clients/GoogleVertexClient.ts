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
import type { ModelMessage } from "ai";
import { streamText } from "ai";
import { OAuth2Client } from "google-auth-library";

import type { StepLogger } from "../StepLogger";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../types";
import { isThinkingEnabled } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient } from "./ModelClient";

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
		const model = this.createModel(params.model);

		// Create abort controller with cleanup to prevent EventEmitter memory leaks
		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		// For Anthropic models on Vertex, pass thinking config via providerOptions.
		// The createVertexAnthropic provider uses AnthropicMessagesLanguageModel internally,
		// so it accepts the same `anthropic` provider options as the direct Anthropic provider.
		// Note: Gemini thinking on Vertex requires `providerOptions.vertex` (not `google`),
		// but the Vertex provider does not yet expose thinkingEffortLevels for Gemini models,
		// so that path is not wired up here.
		const providerOptions =
			isThinkingEnabled(params.thinkingEffort) && isVertexAnthropicModel(params.model)
				? { anthropic: { thinking: { type: "adaptive" as const }, effort: params.thinkingEffort } }
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
	 */
	private createModel(modelId: string): LanguageModelV3 {
		const location = getEffectiveLocation(modelId, this.config.location);
		const googleAuthOptions = this.googleAuthOptions();

		if (isVertexAnthropicModel(modelId)) {
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
